// Sessions-owned (forked from tokenmaxing). Adds cacheWrite1h so the 1-hour cache-creation premium can be priced.
import type { ToolId, ProviderId } from '../types.ts';

// Unified intermediate emitted by every parser; aggregate.ts consumes these.
export interface UsageEvent {
  tool: ToolId;
  provider: ProviderId;
  model: string; // raw model id from log
  modelLabel?: string; // optional friendly label
  timestamp: string; // ISO UTC
  sessionId: string; // unique within the tool
  projectPath?: string; // raw cwd if known
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number; // total cache-creation tokens (5m + 1h)
    cacheWrite1h?: number; // subset of cacheWrite written to the 1h cache (billed at input×2)
  };
  costUSD?: number; // only set when source pre-computes (Pi); otherwise computed downstream
  /** Set when the event came from a dispatched subagent rather than the main loop.
   *  `id` is the dispatch id (one per Task/Agent invocation); `type` is the agent
   *  type ('Explore', 'general-purpose', a plugin agent, …) — Pi does not record
   *  the dispatched agent's name, so its runs all carry the 'subagent' type. */
  agent?: { id: string; type: string };
  /** git branch recorded on the message, when the tool logs one. Claude Code only. */
  branch?: string;
  /** Identifies one API response across the transcript files it was copied into
   *  (resume/fork rewrites the same response into each). Events sharing a key are
   *  the same response and are counted once. Absent when the source gives no id. */
  dedupKey?: string;
}
