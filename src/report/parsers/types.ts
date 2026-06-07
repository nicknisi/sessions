// VENDORED VERBATIM from tokenmaxing/src/parsers/types.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
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
    cacheWrite: number;
  };
  costUSD?: number; // only set when source pre-computes (Pi); otherwise computed downstream
}
