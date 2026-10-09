// src/search-format.ts
import { basename } from 'node:path';
import type { MessageHit, RikerProvenance, SessionResult, Tool } from './types';

/** The exact resume affordance both the CLI (clipboard) and the MCP (returned field) use. */
export function buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string {
  if (tool === 'claude') return `cd "${cwd}" && claude --resume ${sessionId}`;
  if (tool === 'opencode') return `cd "${cwd}" && opencode --session ${sessionId}`;
  return `cd "${cwd}"`; // pi, codex: no direct session resume
}

/**
 * How a Riker worker session is named in place of its worktree path:
 * "Riker job 124 · riker-live (riker/124-fix-login)". The repo (the checkout's dir
 * name, as the primer labels repos) and the branch drop out when unknown, down to
 * a bare "Riker job 124".
 */
export function rikerLabel(p: RikerProvenance): string {
  const repo = p.repo ? ` · ${basename(p.repo)}` : '';
  const branch = p.branch ? ` (${p.branch})` : '';
  return `Riker job ${p.job}${repo}${branch}`;
}

/** Riker provenance as the MCP surfaces carry it: the stored fields plus the label. */
export interface RikerTag extends RikerProvenance {
  label: string;
}

export function rikerTag(p: RikerProvenance): RikerTag {
  return { ...p, label: rikerLabel(p) };
}

/**
 * Payload caps for the search projection. Bounding at the producer is this file's own
 * convention — messageHits is already capped at 3 upstream (src/cache.ts).
 *
 * These two arrays were the whole payload problem: on a default search_sessions(limit:20)
 * the serialized result was ~243,000 characters, 84% of it `commands`. `filePath` is
 * returned on every result, so anything that needs the full list can read the session.
 */
export const MAX_COMMANDS = 5;
export const MAX_FILES = 10;

export interface FormattedResult {
  sessionId: string;
  tool: Tool;
  date: string;
  createdAt: string;
  /** The session's cwd — or, for a Riker session, the checkout its job came from (when
   *  known), since the cwd is a job worktree that Riker removes after a merge. */
  project: string;
  title: string | null;
  snippet: string;
  messageCount: number;
  /** At most MAX_FILES entries; fileCount carries the true total. */
  files: string[];
  /** Total files touched, before truncation — so a capped list never reads as complete. */
  fileCount: number;
  /** At most MAX_COMMANDS entries; commandCount carries the true total. */
  commands: string[];
  /** Total commands run, before truncation. */
  commandCount: number;
  errored: boolean;
  exists: boolean;
  filePath: string;
  resumeCommand: string;
  /** Pi /tree in-file fork count; 0 for other tools and unbranched sessions. */
  branches: number;
  /** BASENAME of the /fork parent session file ('' when none) — agents don't need
   *  the absolute path, and the stored path is deliberately unresolved. */
  forkedFrom: string;
  /** Message-level matches (≤3, best first); each index feeds get_session_messages(offset).
   *  Present whenever the source result carries hits (indexed search always does — it may
   *  be empty for metadata-only matches); absent for the no-index scanner fallback. */
  messageHits?: MessageHit[];
  /** Present only on sessions a Riker worker wrote. */
  riker?: RikerTag;
}

/** Single source of truth for the search-result payload shared across surfaces. */
export function formatResult(r: SessionResult): FormattedResult {
  const out: FormattedResult = {
    sessionId: r.sessionId,
    tool: r.tool,
    date: r.date,
    createdAt: r.createdAt,
    project: r.riker?.repo || r.cwd,
    title: r.customTitle || null,
    snippet: r.displayText,
    messageCount: r.messageCount,
    files: r.files.slice(0, MAX_FILES),
    fileCount: r.files.length,
    commands: r.commands.slice(0, MAX_COMMANDS),
    commandCount: r.commands.length,
    errored: r.errored,
    exists: r.exists,
    filePath: r.filePath,
    resumeCommand: buildResumeCommand(r.tool, r.cwd, r.sessionId),
    branches: r.branches,
    forkedFrom: r.forkedFrom ? basename(r.forkedFrom) : '',
  };
  if (r.messageHits) out.messageHits = r.messageHits;
  if (r.riker) out.riker = rikerTag(r.riker);
  return out;
}
