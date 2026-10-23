// The calling agent's own live session, so search can leave it out: it is already in the
// caller's context, and otherwise it tops every recency-ordered list and matches every
// query the agent copies out of its own conversation. Ported from atuin's caller.rs.
import type { Tool } from './types';

/** A session as search filters it: tool + id is unique across the index's tools. */
export interface SessionKey {
  tool: Tool;
  sessionId: string;
}

/** What the MCP server knows about whoever called it. */
export interface Caller {
  /** clientInfo.name from the MCP initialize handshake, when the client sent one. */
  client?: string;
  env: Record<string, string | undefined>;
  /** Epoch ms the server process started. */
  serverStart: number;
  cwd: string;
}

/** An indexed session as the fallback needs it. */
export interface OwnCandidate {
  tool: string;
  session_id: string;
  cwd: string;
  started_at: string;
  ended_at: string;
}

/** A harness writes its session within a second or two of spawning MCP servers. Kept tight:
 *  wider catches the previous run in the same directory, which makes the match ambiguous. */
export const START_SLACK_MS = 10_000;

const CLIENT_TOOL = new Map<string, Tool>([
  ['claude-code', 'claude'],
  ['codex-mcp-client', 'codex'],
  ['opencode', 'opencode'],
]);

/**
 * Identify the caller's session, or null.
 *
 * 1. Claude Code exports CLAUDE_CODE_SESSION_ID to its MCP servers. Trusted unless the client
 *    names itself as something else: opencode passes its whole environment through, so an
 *    opencode launched from inside Claude Code inherits that id.
 * 2. Otherwise the one session of the caller's tool, in the server's directory, that started
 *    around or after the server did and has been active since. Ambiguous means null: showing
 *    the caller its own session wastes a call, hiding someone else's loses it.
 */
export function identifyOwnSession(caller: Caller, candidates: () => OwnCandidate[]): SessionKey | null {
  const envId = caller.env.CLAUDE_CODE_SESSION_ID;
  if (envId && (!caller.client || caller.client === 'claude-code')) return { tool: 'claude', sessionId: envId };

  const tool = caller.client ? CLIENT_TOOL.get(caller.client) : undefined;
  if (!tool) return null;
  const earliest = caller.serverStart - START_SLACK_MS;
  const matches = candidates().filter((c) => {
    const started = Date.parse(c.started_at);
    const ended = Date.parse(c.ended_at);
    return c.tool === tool && c.cwd === caller.cwd && started >= earliest && ended >= caller.serverStart;
  });
  return matches.length === 1 ? { tool, sessionId: matches[0]!.session_id } : null;
}
