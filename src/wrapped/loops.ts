// User-turn boundaries for wrapped's loop metric — the timestamps UsageEvents
// don't carry. UsageEvents carry every assistant API call but nothing about when
// the HUMAN spoke. The cached report parse extracts these alongside the events
// (parsers/claude-code.ts); collectClaudeUserTurns is the walk for when that
// cache is unavailable. Claude Code only, deliberately: it is the one log format
// that can distinguish a typed prompt from an injected one (promptSource), and
// a superlative built on boundaries that might be agents prompting agents would
// crown automation — the exact failure mode wrapped's junk rules exist to stop.

import { walkJsonl, readJsonlLines } from '../report/parsers/util.ts';
import { TURN_TEXT_CLAMP, type ClaudeUserTurn } from '../report/parsers/claude-code.ts';
import { genuineUserTurnFromLine } from '../parser.ts';

export interface UserTurn {
  /** ms since epoch. */
  at: number;
  /** Raw turn text, clamped — only a winning loop's trigger is ever shown. */
  text: string;
}

/**
 * Genuine human turns per `claude-code|sessionId` — the same session keying as
 * computeEventStats, so the two passes join cleanly. Duplicate timestamps
 * (resumed/forked session files copy history lines verbatim) collapse to one
 * boundary. Sorted ascending per session.
 */
export function groupUserTurns(turns: Iterable<ClaudeUserTurn>): Map<string, UserTurn[]> {
  const bySession = new Map<string, Map<number, string>>();
  for (const turn of turns) {
    const key = `claude-code|${turn.sessionId}`;
    let m = bySession.get(key);
    if (!m) {
      m = new Map();
      bySession.set(key, m);
    }
    if (!m.has(turn.at)) m.set(turn.at, turn.text);
  }
  const out = new Map<string, UserTurn[]>();
  for (const [key, m] of bySession) {
    out.set(
      key,
      [...m.entries()].map(([at, text]) => ({ at, text })).sort((a, b) => a.at - b.at),
    );
  }
  return out;
}

/** The uncached path: walk the Claude Code root for the same turns. */
export async function collectClaudeUserTurns(root: string): Promise<Map<string, UserTurn[]>> {
  const turns: ClaudeUserTurn[] = [];
  for await (const path of walkJsonl(root)) {
    for await (const line of readJsonlLines(path)) {
      const turn = genuineUserTurnFromLine(line);
      if (!turn) continue;
      const at = Date.parse(turn.timestamp);
      if (Number.isNaN(at)) continue;
      turns.push({ sessionId: turn.sessionId, at, text: turn.text.slice(0, TURN_TEXT_CLAMP) });
    }
  }
  return groupUserTurns(turns);
}
