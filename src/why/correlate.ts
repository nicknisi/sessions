import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { resolveRepo, logForFile, blameLine, showCommit, isCommitRef, type RepoInfo, type CommitInfo } from '../repo';
import { candidateSessionsForRepoWindow, sessionExcerpts, searchSessions, type CandidateSessionRow } from '../cache';
import { buildResumeCommand } from '../search-format';
import type { Tool } from '../types';

/** A commit lands after the session that produced it; this bounds how long after. */
export const SLACK_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Default and hard cap on sessions returned per commit. */
export const MAX_SESSIONS = 5;

export type WhyTarget =
  | { kind: 'file'; path: string; line?: number; exists: boolean }
  | { kind: 'commit'; ref: string }
  | { kind: 'query'; text: string };

export interface WhySessionEvidence {
  filePath: string;
  tool: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  headline: string;
  overlappingFiles: string[];
  confidence: 'files+time' | 'time-only';
  excerpts: Array<{ msgIndex: number; role: string; text: string }>;
  resume: string;
}

export interface WhyEvidence {
  commit: CommitInfo | null;
  sessions: WhySessionEvidence[];
}

export type WhyOutcome = { kind: 'evidence'; evidence: WhyEvidence } | { kind: 'error'; message: string };

/** Whether a raw argument reads as a path rather than free text: a slash or a file extension. */
function looksLikePath(raw: string): boolean {
  return raw.includes('/') || /\.[A-Za-z0-9]+$/.test(raw);
}

interface PathLine {
  path: string;
  line?: number;
}

/** Split a `path:line` target into its path and 1-based line, or `{ path }` when unsuffixed. */
function splitLine(raw: string): PathLine {
  const m = /^(.*):(\d+)$/.exec(raw);
  if (m && m[1]) return { path: m[1], line: Number(m[2]) };
  return { path: raw };
}

/**
 * Classify the target, in the spec's order: a commit-ish that `git cat-file` confirms, then
 * an existing path (optionally `path:line`), then free text. Needs the repo to confirm a
 * commit ref; a null repo can still parse file/query forms.
 */
export function parseTarget(raw: string, cwd: string, repo: RepoInfo | null): WhyTarget {
  const { path, line } = splitLine(raw);
  // Commit-ish: any non-path token git confirms as a commit — bare SHAs plus HEAD,
  // HEAD~n, tags, and branch names. Gating on a hex pattern would silently route the
  // documented `sessions why HEAD~2` to a literal text search. `git cat-file` is the
  // authority; a `path:line` token (line !== undefined) is never a commit-ish.
  if (repo && line === undefined && !looksLikePath(raw) && isCommitRef(repo, raw)) {
    return { kind: 'commit', ref: raw };
  }
  const abs = resolve(cwd, path);
  const exists = existsSync(abs);
  if (exists || looksLikePath(path)) {
    return line !== undefined ? { kind: 'file', path, line, exists } : { kind: 'file', path, exists };
  }
  return { kind: 'query', text: raw };
}

/** Repo-relative form of `p`, stripping the longest matching root prefix; absolute paths
 *  outside every root are returned unchanged (they degrade the match to time-only). */
function toRepoRelative(p: string, roots: string[]): string {
  if (!p.startsWith('/')) return p; // already relative (Codex apply_patch)
  for (const root of roots) {
    if (p === root) return '';
    if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  }
  return p;
}

const filesTouchedSchema = z.array(z.string());

function parseFilesTouched(json: string): string[] {
  try {
    const parsed = filesTouchedSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** `YYYY-MM-DD` shifted by `n` days (UTC). */
function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** The FTS OR-term query for a commit's excerpts: file basenames + subject words. Same
 *  term-building shape as searchSessions (strip quotes, quote each term, OR-join). */
function excerptQuery(commit: CommitInfo): string {
  const raw = [...commit.files.map((f) => basename(f)), ...commit.subject.split(/\s+/)];
  const terms = new Set<string>();
  for (const t of raw) {
    const cleaned = t.replace(/['"]/g, '').trim();
    if (cleaned.length > 1) terms.add(`"${cleaned}"`);
  }
  return [...terms].join(' OR ');
}

/**
 * Correlate one commit against the index: repo-scoped sessions whose time window contains
 * the commit, scored by file overlap. Deterministic — no LLM, no network.
 */
function correlateCommit(repo: RepoInfo, commit: CommitInfo, rows: CandidateSessionRow[], limit: number): WhyEvidence {
  const authoredMs = ms(commit.authoredAt);
  const ftsQuery = excerptQuery(commit);

  const scored = rows
    .map((row) => {
      const roots = [...new Set([row.cwd, repo.currentWorktree, repo.container].filter(Boolean))].sort(
        (a, b) => b.length - a.length,
      );
      const startMs = row.started_at ? ms(row.started_at) : ms(row.date + 'T00:00:00.000Z');
      const endBaseMs = row.ended_at ? ms(row.ended_at) : ms(row.date + 'T23:59:59.999Z');
      const inWindow = startMs <= authoredMs && authoredMs <= endBaseMs + SLACK_AFTER_MS;
      if (!Number.isFinite(startMs) || !Number.isFinite(endBaseMs) || !inWindow) return null;

      const sessionRel = new Set(parseFilesTouched(row.files_touched).map((p) => toRepoRelative(p, roots)));
      const overlap = commit.files.filter((f) => sessionRel.has(f));
      const confidence: WhySessionEvidence['confidence'] = overlap.length >= 1 ? 'files+time' : 'time-only';
      const score = overlap.length * 10 - Math.abs(authoredMs - endBaseMs) / 3_600_000;

      const excerpts = sessionExcerpts(row.file_path, ftsQuery, 3).map((e) => ({
        msgIndex: e.msg_index,
        role: e.role,
        text: e.snippet,
      }));

      const evidence: WhySessionEvidence = {
        filePath: row.file_path,
        tool: row.tool,
        sessionId: row.session_id,
        startedAt: row.started_at,
        endedAt: row.ended_at || null,
        headline: row.custom_title || row.first_prompt,
        overlappingFiles: overlap,
        confidence,
        excerpts,
        // SAFETY: the tool column is written by the index from Tool values only.
        resume: buildResumeCommand(row.tool as Tool, row.cwd, row.session_id),
      };
      return { evidence, score, startedAt: row.started_at };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  scored.sort((a, b) => b.score - a.score || b.startedAt.localeCompare(a.startedAt));
  return { commit, sessions: scored.slice(0, limit).map((x) => x.evidence) };
}

/** The commit a file target resolves to: the blamed commit for `file:line`, else the most
 *  recent commit that touched the file. */
function commitForFile(repo: RepoInfo, target: Extract<WhyTarget, { kind: 'file' }>): CommitInfo | null {
  if (target.line !== undefined) {
    const sha = blameLine(repo, target.path, target.line);
    if (sha) {
      const c = showCommit(repo, sha);
      if (c) return c;
    }
    // blame failed (uncommitted line, new file): fall back to the file's history.
  }
  return logForFile(repo, target.path, 20)[0] ?? null;
}

/** Query form: no git at all — reuse searchSessions scoped to the repo, present in the
 *  same evidence shape with a null commit. */
async function correlateQuery(repo: RepoInfo | null, cwd: string, text: string, limit: number): Promise<WhyEvidence> {
  const project = repo ? repo.container : cwd;
  const results = await searchSessions(text, { project, limit });
  const sessions: WhySessionEvidence[] = results.slice(0, limit).map((r) => ({
    filePath: r.filePath,
    tool: r.tool,
    sessionId: r.sessionId,
    startedAt: r.createdAt,
    endedAt: null,
    headline: r.customTitle || r.displayText,
    overlappingFiles: [],
    confidence: 'time-only',
    excerpts: (r.messageHits ?? []).map((h) => ({ msgIndex: h.index, role: h.role, text: h.snippet })),
    resume: buildResumeCommand(r.tool, r.cwd, r.sessionId),
  }));
  return { commit: null, sessions };
}

/**
 * Answer "why does this code exist" for `raw` — read-only on both git and the index. Returns
 * either structured evidence or a clean error message (non-repo, unknown ref, unknown path).
 */
export async function why(raw: string, cwd: string, limit = MAX_SESSIONS): Promise<WhyOutcome> {
  const cap = Math.max(1, Math.min(limit, MAX_SESSIONS));
  const repo = resolveRepo(cwd);
  const target = parseTarget(raw, cwd, repo);

  if (target.kind === 'query') {
    return { kind: 'evidence', evidence: await correlateQuery(repo, cwd, target.text, cap) };
  }

  if (!repo) return { kind: 'error', message: 'Not inside a git repository.' };

  let commit: CommitInfo | null;
  if (target.kind === 'commit') {
    commit = showCommit(repo, target.ref);
    if (!commit) return { kind: 'error', message: `Unknown commit: ${target.ref}` };
  } else {
    commit = commitForFile(repo, target);
    if (!commit) return { kind: 'error', message: `No commits found for path: ${target.path}` };
  }

  const day = commit.authoredAt.slice(0, 10);
  const rows = await candidateSessionsForRepoWindow(repo, addDays(day, -2), addDays(day, 1));
  return { kind: 'evidence', evidence: correlateCommit(repo, commit, rows, cap) };
}
