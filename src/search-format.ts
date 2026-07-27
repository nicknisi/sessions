// src/search-format.ts
import type { MessageHit, SessionResult, Tool } from './types';

/** The exact resume affordance both the CLI (clipboard) and the MCP (returned field) use. */
export function buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string {
  if (tool === 'claude') return `cd "${cwd}" && claude --resume ${sessionId}`;
  if (tool === 'opencode') return `cd "${cwd}" && opencode --session ${sessionId}`;
  return `cd "${cwd}"`; // pi, codex: no direct session resume
}

// Read-path bounds. A search result is a scanning aid, not a transcript: at the MCP's
// default limit of 20, verbatim files+commands serialized ~200k chars (~50k tokens).
// 200 chars matches digest.ts's USER_MAX — the existing display-facing snippet bound.
export const RESULT_COMMAND_MAX = 200;
export const MAX_RESULT_COMMANDS = 8;
export const MAX_RESULT_FILES = 20;

// First line only, then a hard char clip: a heredoc's opening line identifies the
// command and the body is transcript (15% of indexed commands are multi-line). The
// ellipsis covers both losses so a clipped command never reads as the whole thing.
function clipCommand(c: string): string {
  const clipped = c.split('\n', 1)[0]!.trimEnd().slice(0, RESULT_COMMAND_MAX);
  return clipped.length < c.length ? clipped + '…' : clipped;
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
  /** Capped at MAX_RESULT_FILES / MAX_RESULT_COMMANDS; the counts beside them say how
   *  much the page dropped, so truncation is visible rather than silent.
   *  `*Indexed`, not `*Total`: the index itself holds at most extract-files' MAX_FILES
   *  (50) and extract-commands' MAX_COMMANDS (100) per session, so these are a floor on
   *  the real number, not the real number. Recovering the true total means storing the
   *  pre-cap count at index time — a new column, a schema bump, and a full reindex to
   *  buy a figure nothing reads; the name is what was wrong, so the name changed. */
  files: string[];
  filesIndexed: number;
  commands: string[];
  commandsIndexed: number;
  errored: boolean;
  exists: boolean;
  filePath: string;
  resumeCommand: string;
  /** Message-level matches (≤3, best first); each index feeds get_session_messages(offset).
   *  Present whenever the source result carries hits (indexed search always does — it may
   *  be empty for metadata-only matches); absent for the no-index scanner fallback. */
  messageHits?: MessageHit[];
}

/** Bumped only when a payload's shape breaks — never for the tool's own version. */
export const JSON_ENVELOPE_VERSION = 1;

/** The two fields every machine-readable CLI payload leads with. Mirrors the
 *  `UsageReport` convention in report/schema.ts. */
export interface JsonEnvelope {
  generator: 'sessions';
  version: number;
}

/**
 * Wrap a payload for a `--json` surface.
 *
 * A consumer pins `version` and fails loudly on a shape change instead of silently
 * misreading one. Deliberately *not* folded into formatResult: src/eval/run.ts measures
 * `JSON.stringify(results.map(formatResult)).length` as the payload metric behind
 * PAYLOAD_CEILING, so wrapping at the serializer would move every ceiling in the eval
 * ratchet for a reason that has nothing to do with ranking.
 */
export function envelope<T extends object>(payload: T): JsonEnvelope & T {
  return { generator: 'sessions', version: JSON_ENVELOPE_VERSION, ...payload };
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
    files: r.files.slice(0, MAX_RESULT_FILES),
    filesIndexed: r.files.length,
    commands: r.commands.slice(0, MAX_RESULT_COMMANDS).map(clipCommand),
    commandsIndexed: r.commands.length,
    errored: r.errored,
    exists: r.exists,
    filePath: r.filePath,
    resumeCommand: buildResumeCommand(r.tool, r.cwd, r.sessionId),
  };
  if (r.messageHits) out.messageHits = r.messageHits;
  return out;
}
