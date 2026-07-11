// src/search-format.ts
import type { MessageHit, SessionResult, Tool } from './types';

/** The exact resume affordance both the CLI (clipboard) and the MCP (returned field) use. */
export function buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string {
  if (tool === 'claude') return `cd "${cwd}" && claude --resume ${sessionId}`;
  if (tool === 'opencode') return `cd "${cwd}" && opencode --session ${sessionId}`;
  return `cd "${cwd}"`; // pi, codex: no direct session resume
}

export interface FormattedResult {
  sessionId: string;
  tool: Tool;
  date: string;
  createdAt: string;
  project: string;
  title: string | null;
  snippet: string;
  messageCount: number;
  files: string[];
  commands: string[];
  errored: boolean;
  exists: boolean;
  filePath: string;
  resumeCommand: string;
  /** Message-level matches (≤3, best first); each index feeds get_session_messages(offset).
   *  Present whenever the source result carries hits (indexed search always does — it may
   *  be empty for metadata-only matches); absent for the no-index scanner fallback. */
  messageHits?: MessageHit[];
}

/** Single source of truth for the search-result payload shared across surfaces. */
export function formatResult(r: SessionResult): FormattedResult {
  const out: FormattedResult = {
    sessionId: r.sessionId,
    tool: r.tool,
    date: r.date,
    createdAt: r.createdAt,
    project: r.cwd,
    title: r.customTitle || null,
    snippet: r.displayText,
    messageCount: r.messageCount,
    files: r.files,
    commands: r.commands,
    errored: r.errored,
    exists: r.exists,
    filePath: r.filePath,
    resumeCommand: buildResumeCommand(r.tool, r.cwd, r.sessionId),
  };
  if (r.messageHits) out.messageHits = r.messageHits;
  return out;
}
