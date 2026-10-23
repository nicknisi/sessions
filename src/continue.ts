// `sessions continue`: pick a past session back up, in any agent, against the code as it is
// now. Resuming replays a transcript as if the repo froze when it ended; this hands the next
// agent a bounded brief instead: the session's arc, whether its work landed, what changed
// in the files it touched since, and the repo's standing memory.
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { C, disableColors } from './colors';
import { buildSessionDigest, clip, type SessionDigest } from './digest';
import { readSessionLines } from './session-io';
import {
  primerMemory,
  resolveSessionFile,
  sessionByFile,
  sessionsByLastActivity,
  type ContinueCandidateRow,
  type HandoffSessionRow,
  type PrimerMemoryTier,
} from './cache';
import { dirtyPaths, logSince, resolveRepo, type CommitInfo, type RepoInfo } from './repo';
import { parseFilesTouched, SLACK_AFTER_MS, toRepoRelative } from './why/correlate';
import { isTrivia } from './significance';
import type { Tool } from './types';

/** Caps that keep the brief bounded (~3k tokens with a full digest). Every capped list
 *  carries its true total, so the brief can say how much it left out. */
export const MAX_EDITED = 15;
export const MAX_READ_CHANGED = 10;
export const MAX_COMMITS_PER_FILE = 3;
export const MAX_LANDED = 5;
/** History walked for drift; past this the brief says "N+" and hedges its file-level claims. */
export const DRIFT_LOG_LIMIT = 500;

export interface CommitRef {
  sha: string;
  subject: string;
  authoredAt: string;
  committedAt: string;
}

export interface FileDrift {
  /** Repo-relative. */
  path: string;
  /** Commits that touched it after the session, newest first, capped at MAX_COMMITS_PER_FILE. */
  commitsSince: CommitRef[];
  commitsSinceTotal: number;
  /** Uncommitted changes in the checkout right now. */
  dirty: boolean;
  deleted: boolean;
}

export interface Drift {
  /** Commits on HEAD committed after the session ended, not counting its own landed work. */
  commitsSince: number;
  /** True when the walk hit DRIFT_LOG_LIMIT: counts are floors, and "unchanged" is unproven. */
  capped: boolean;
  /** Files the session edited, moved ones first, capped at MAX_EDITED. */
  edited: FileDrift[];
  editedTotal: number;
  /** Files it only read that have moved since, capped at MAX_READ_CHANGED. */
  readChanged: string[];
  readChangedTotal: number;
  /** Commits touching its edited files authored during the session or within SLACK_AFTER_MS
   *  of it, capped at MAX_LANDED. */
  landed: CommitRef[];
  landedTotal: number;
}

export interface HandoffBrief {
  tool: Tool;
  sessionId: string;
  filePath: string;
  /** Where the session ran. */
  cwd: string;
  /** Where to continue it: its cwd when that still exists, else the caller's. */
  launchDir: string;
  startedAt: string;
  endedAt: string;
  /** null outside a git repository, or for a session with no usable timestamps. */
  drift: Drift | null;
  markdown: string;
}

const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode' } satisfies Record<
  Tool,
  string
>;

/** The session's [start, end] in epoch ms, falling back to its day when timestamps are missing. */
function sessionWindow(row: HandoffSessionRow) {
  const start = Date.parse(row.started_at) || Date.parse(row.date + 'T00:00:00.000Z');
  const end = Date.parse(row.ended_at) || Date.parse(row.started_at) || Date.parse(row.date + 'T23:59:59.999Z');
  return { start, end };
}

const ref = (c: CommitInfo): CommitRef => ({
  sha: c.sha.slice(0, 7),
  subject: c.subject,
  authoredAt: c.authoredAt,
  committedAt: c.committedAt,
});

/** A deleted worktree's root: the ancestor of the session's cwd under which the most of its
 *  paths exist in this checkout, so a session that ran in a subdirectory still maps. The cwd
 *  itself when none do. */
function lostRoot(cwd: string, paths: string[], worktree: string): string {
  let best = cwd;
  let bestHits = 0;
  for (let root = cwd; root !== dirname(root); root = dirname(root)) {
    const prefix = root + '/';
    const hits = paths.filter((p) => p.startsWith(prefix) && existsSync(join(worktree, p.slice(prefix.length)))).length;
    if (hits > bestHits) {
      best = root;
      bestHits = hits;
    }
  }
  return best;
}

/** Read-only on git: one log walk, two diffs, one ls-files. null when the session carries no
 *  usable timestamps, since every drift judgment is relative to when it ran. */
export function computeDrift(repo: RepoInfo, row: HandoffSessionRow): Drift | null {
  const { start, end } = sessionWindow(row);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // A day of margin: the walk is bounded by committer time, landing is judged by author time.
  const commits = logSince(repo, new Date(start - 86_400_000).toISOString(), DRIFT_LOG_LIMIT);

  // Tool paths can be relative to the session's cwd, which need not be the repo root.
  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(row.cwd, p));
  const touchedRaw = parseFilesTouched(row.files_touched);
  const readRaw = parseFilesTouched(row.files_read);
  // A live cwd sits inside `repo`'s worktree. A deleted one's root has to be recovered.
  const roots = existsSync(row.cwd)
    ? [repo.currentWorktree]
    : [repo.currentWorktree, lostRoot(row.cwd, [...touchedRaw, ...readRaw].map(toAbs), repo.currentWorktree)];
  const relOf = (raw: string): string | null => {
    const p = toRepoRelative(toAbs(raw), roots);
    return p && !p.startsWith('/') ? p : null;
  };
  const editedPaths = [...new Set(touchedRaw.map(relOf).filter((p) => p !== null))];
  const edited = new Set(editedPaths);

  // Its own work: written during the session (author time survives rebases), in its files.
  const landed = commits.filter((c) => {
    const t = Date.parse(c.authoredAt);
    return t >= start && t <= end + SLACK_AFTER_MS && c.files.some((f) => edited.has(f));
  });
  const own = new Set(landed);
  // Everything else that entered the history after it ended, by committer time, so a later
  // cherry-pick or rebase of older work counts as a change too.
  const after = commits.filter((c) => Date.parse(c.committedAt) > end && !own.has(c));

  const dirty = dirtyPaths(repo);
  const touching = (p: string): CommitInfo[] => after.filter((c) => c.files.includes(p));

  const files: FileDrift[] = editedPaths.map((path) => {
    const since = touching(path);
    return {
      path,
      commitsSince: since.slice(0, MAX_COMMITS_PER_FILE).map(ref),
      commitsSinceTotal: since.length,
      dirty: dirty.has(path),
      deleted: !existsSync(join(repo.currentWorktree, path)),
    };
  });
  const moved = (f: FileDrift): boolean => f.commitsSinceTotal > 0 || f.dirty || f.deleted;
  files.sort((a, b) => Number(moved(b)) - Number(moved(a)));

  // Read files never landed anything, so any later commit counts, including one in the slack
  // window. files_read also holds Grep/Glob patterns, so only an absolute, wildcard-free target
  // (or any Pi read, which records nothing else) is a file whose absence means it was removed.
  const concrete = (raw: string): boolean => (row.tool === 'pi' || isAbsolute(raw)) && !/[*?[\]{}]/.test(raw);
  const readChanged: string[] = [];
  for (const raw of readRaw) {
    const p = relOf(raw);
    if (!p || edited.has(p) || readChanged.includes(p)) continue;
    const later = commits.some((c) => Date.parse(c.committedAt) > end && c.files.includes(p));
    const missing = concrete(raw) && !existsSync(join(repo.currentWorktree, p));
    if (dirty.has(p) || later || missing) readChanged.push(p);
  }

  return {
    commitsSince: after.length,
    capped: commits.length >= DRIFT_LOG_LIMIT,
    edited: files.slice(0, MAX_EDITED),
    editedTotal: files.length,
    readChanged: readChanged.slice(0, MAX_READ_CHANGED),
    readChangedTotal: readChanged.length,
    landed: landed.slice(0, MAX_LANDED).map(ref),
    landedTotal: landed.length,
  };
}

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return 'less than an hour ago';
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const commitLine = (c: CommitRef, now: number): string =>
  `${c.sha} "${clip(c.subject, 80)}" (${ago(c.committedAt, now)})`;

/** Commit lines, then how many more there were. */
const commitList = (shown: CommitRef[], total: number, now: number): string =>
  shown.map((c) => commitLine(c, now)).join(', ') + (total > shown.length ? ` and ${total - shown.length} more` : '');

export interface BriefInput {
  row: HandoffSessionRow;
  digest: SessionDigest;
  drift: Drift | null;
  /** Why drift is null: no git repository, or no usable timestamps. */
  driftNote?: string;
  memory: PrimerMemoryTier;
  now: number;
}

/** Pure: the markdown handed to the next agent as its first prompt. */
export function renderBrief({ row, digest, drift, driftNote, memory, now }: BriefInput): string {
  // SAFETY: the tool column is written by the index from Tool values only.
  const tool = TOOL_NAME[row.tool as Tool] ?? row.tool;
  const ended = row.ended_at || row.started_at || row.date;
  const out: string[] = [];

  out.push('# Continuing an earlier session', '');
  out.push(
    `This picks up a ${tool} session in \`${row.cwd}\` that was last active ${ago(ended, now)} (${ended}).`,
    `Transcript: \`${row.file_path}\`. To expand any exchange below, call the sessions MCP tool get_session_messages with this filePath and the exchange's [index] as offset, or read the file.`,
    '',
  );

  out.push('## What happened', '');
  const title = row.custom_title || row.first_prompt;
  if (title) out.push(`Opened with: ${clip(title, 200)}`, '');
  const elided = digest.elided > 0 ? `, ${digest.elided} in the middle elided` : '';
  out.push(`_${digest.messageCount} messages, ${digest.exchangeCount} exchanges${elided}._`, '');
  const head = Math.ceil(digest.exchanges.length / 2);
  digest.exchanges.forEach((ex, i) => {
    if (digest.elided > 0 && i === head) out.push(`- _… ${digest.elided} exchanges elided …_`);
    out.push(`- **[${ex.index}] user:** ${ex.user}`);
    if (ex.assistant) out.push(`  **assistant:** ${ex.assistant}`);
  });
  if (digest.exchanges.length === 0) out.push('No genuine user turns in this session.');
  out.push('');

  out.push('## What changed since', '');
  if (!drift) {
    out.push(
      `${driftNote ?? 'Not a git repository here'}, so what changed since could not be checked. Re-read files before editing.`,
      '',
    );
  } else {
    const n = `${drift.commitsSince}${drift.capped ? '+' : ''}`;
    out.push(`${n} commit${drift.commitsSince === 1 ? '' : 's'} on this branch since the session ended.`, '');
    // A capped walk never saw the oldest post-session history, so absence there proves nothing.
    const unchecked = drift.capped ? ` in the last ${DRIFT_LOG_LIMIT} commits (older history not checked)` : '';
    if (drift.landed.length) {
      out.push(`Its work landed in: ${commitList(drift.landed, drift.landedTotal, now)}.`, '');
    } else if (drift.editedTotal > 0) {
      out.push(
        `No commit touching its files was authored during the session or soon after${unchecked}: its edits may be uncommitted, abandoned, or landed under another history.`,
        '',
      );
    }
    if (drift.editedTotal > 0) {
      out.push('Files it edited:');
      for (const f of drift.edited) {
        const notes: string[] = [];
        if (f.deleted) notes.push('deleted');
        if (f.commitsSinceTotal) notes.push(`changed by ${commitList(f.commitsSince, f.commitsSinceTotal, now)}`);
        if (f.dirty) notes.push('uncommitted changes now');
        out.push(
          `- \`${f.path}\`: ${notes.length ? notes.join('; ') : drift.capped ? `no change${unchecked}` : 'unchanged since'}`,
        );
      }
      const more = drift.editedTotal - drift.edited.length;
      if (more > 0) out.push(`- …and ${more} more`);
      out.push('');
    }
    if (drift.readChanged.length) {
      const more = drift.readChangedTotal - drift.readChanged.length;
      const list = drift.readChanged.map((p) => `\`${p}\``).join(', ') + (more > 0 ? ` and ${more} more` : '');
      out.push(`Files it read that have changed since: ${list}.`, '');
    }
    out.push('File contents quoted in that session may be stale. Re-read a file before editing it.', '');
  }

  if (memory.memory.length) {
    out.push('## Standing memory for this repo', '');
    for (const m of memory.memory) out.push(`- ${m.text}`);
    const more = memory.memoryTotal - memory.memory.length;
    if (more > 0) out.push(`- …and ${more} more (call get_memory)`);
    out.push('');
  }

  out.push('## Before you start', '');
  out.push(
    'Re-read the files flagged above, then give a short status: what the session was doing, where it stopped, and what has moved since. Ask what to do next before changing anything.',
  );
  return out.join('\n') + '\n';
}

/** Build the brief for one transcript path; null when it isn't indexed or readable. */
export async function buildHandoff(filePath: string, fallbackDir = process.cwd()): Promise<HandoffBrief | null> {
  // The index lookup gates the read: only a transcript the index already knows is ever opened.
  const row = await sessionByFile(filePath);
  if (!row) return null;
  const lines = readSessionLines(row.file_path);
  if (lines.length === 0) return null;

  const launchDir = existsSync(row.cwd) ? row.cwd : fallbackDir;
  const repo = resolveRepo(launchDir);
  const drift = repo ? computeDrift(repo, row) : null;
  const markdown = renderBrief({
    row,
    digest: buildSessionDigest(lines),
    drift,
    driftNote: repo ? 'The session has no usable timestamps' : 'Not a git repository here',
    memory: primerMemory(repo?.container ?? launchDir),
    now: Date.now(),
  });
  return {
    // SAFETY: the tool column is written by the index from Tool values only.
    tool: row.tool as Tool,
    sessionId: row.session_id,
    filePath: row.file_path,
    cwd: row.cwd,
    launchDir,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    drift,
    markdown,
  };
}

// ——— CLI: `sessions continue` ———

/** How each agent starts an interactive session with a first prompt. */
export const LAUNCH = {
  claude: (p) => ['claude', p],
  codex: (p) => ['codex', p],
  pi: (p) => ['pi', '--', p], // `--`: the prompt is a message, never an option or @file
  opencode: (p) => ['opencode', '--prompt', p],
} satisfies Record<Tool, (prompt: string) => string[]>;

const VALID_TOOLS = new Set<string>(Object.keys(LAUNCH));

export interface ContinueArgs {
  target: string;
  into: Tool | '';
  print: boolean;
}

function die(msg: string): never {
  process.stderr.write(`${C.red}error:${C.reset} ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`${C.bold}sessions continue${C.reset} — pick a past session back up, in any agent

Starts a new agent session whose first prompt is a bounded brief: the old
session's arc, whether its work landed, what changed since in the files it
touched (commits, uncommitted edits, deletions), and the repo's memory.
Unlike a resume, it knows the code moved on, and it works across agents.

${C.bold}Usage:${C.reset}
  sessions continue                The newest session in the current repo
  sessions continue <session>      A session file path or indexed session id

${C.bold}Options:${C.reset}
  --in <tool>      Continue in claude, codex, pi, or opencode (default: the
                   session's own agent)
  --print          Print the brief instead of launching (also the default
                   when stdin or stdout is not a terminal)
  --no-color       Disable ANSI color
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseContinueArgs(argv: string[]): ContinueArgs {
  const args: ContinueArgs = { target: '', into: '', print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') help();
    else if (a === '--print') args.print = true;
    else if (a === '--no-color') disableColors();
    else if (a === '--in') {
      const t = argv[++i];
      if (!t || !VALID_TOOLS.has(t)) die('--in requires one of: claude, codex, pi, opencode');
      // SAFETY: VALID_TOOLS.has() above proves t is a Tool.
      args.into = t as Tool;
    } else if (a.startsWith('-')) die(`unknown option: ${a}`);
    else if (args.target) die('expected at most one <session> argument');
    else args.target = a;
  }
  return args;
}

/** An indexed transcript path (as given, or resolved from a relative one), a session id, or
 *  else the most recently active session in the current repo that is worth continuing. */
export async function resolveTarget(target: string): Promise<string | null> {
  if (target) {
    // Exact key first: OpenCode's synthetic paths exist only in the index, never on disk. Then
    // against the shell's logical cwd ($PWD), which keeps symlinked dirs like a dotfiles-managed
    // ~/.pi as the index recorded them, and last against the physical cwd.
    const logical = resolve(process.env.PWD ?? process.cwd(), target);
    for (const path of new Set([target, logical, resolve(target)])) {
      const row = await sessionByFile(path);
      if (row) return row.file_path;
    }
    return resolveSessionFile(target);
  }
  // Run from inside an agent, the newest session is that agent's own.
  const own = (r: ContinueCandidateRow): boolean =>
    r.file_path === process.env.PI_SESSION_FILE || r.session_id === process.env.CLAUDE_CODE_SESSION_ID;
  // No prompt means no genuine user turn, so nothing to continue.
  const worthIt = (r: ContinueCandidateRow): boolean =>
    r.first_prompt !== '' &&
    !isTrivia({
      messageCount: r.message_count,
      filesTouchedCount: r.files_count,
      closingText: `${r.closing_user} ${r.closing_assistant}`,
      createdAt: r.created_at,
    });
  for (const r of await sessionsByLastActivity(resolveRepo(process.cwd()), process.cwd())) {
    if (!own(r) && worthIt(r)) return r.file_path;
  }
  return null;
}

export async function runContinue(args: ContinueArgs): Promise<void> {
  const filePath = await resolveTarget(args.target);
  if (!filePath) {
    die(args.target ? `no session matching ${args.target}` : 'no sessions found for this repo — pass a session');
  }
  const brief = await buildHandoff(filePath);
  if (!brief) die(`${filePath} is not indexed or could not be read`);

  if (args.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(brief.markdown);
    return;
  }

  const into = args.into || brief.tool;
  const argv = LAUNCH[into](brief.markdown);
  if (!Bun.which(argv[0]!)) die(`${argv[0]} is not on your PATH — install it, or use --print`);

  const d = brief.drift;
  const moved = d ? d.edited.filter((f) => f.commitsSince.length || f.dirty || f.deleted).length : 0;
  const summary = d ? `${moved} edited file${moved === 1 ? '' : 's'} moved, ${d.commitsSince} commits since` : 'no git';
  process.stderr.write(
    `${C.dim}continuing ${brief.tool} session in ${into} · ${brief.launchDir} · ${summary} · ~${Math.round(brief.markdown.length / 4)} tokens${C.reset}\n`,
  );
  const proc = Bun.spawn(argv, { cwd: brief.launchDir, stdio: ['inherit', 'inherit', 'inherit'] });
  process.exit(await proc.exited);
}
