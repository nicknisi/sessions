// Sessions-owned (forked from tokenmaxing's parser). Codex's input_tokens are cache-inclusive and
// output_tokens already include reasoning; correct both so totals reflect actual billing (and match ccusage).
import type { UsageEvent } from './types.ts';
import { walkJsonl, readJsonlLines } from './util.ts';

interface CodexEnvelope {
  timestamp: string;
  type: string;
  payload?: unknown;
}

interface SessionMetaPayload {
  id: string;
  cwd?: string;
}
interface TokenCountInfo {
  last_token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    cached_input_tokens?: number;
  };
}
interface TokenCountPayload {
  type: 'token_count';
  info: TokenCountInfo | null;
}

function isEnvelope(v: unknown): v is CodexEnvelope {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { type?: unknown }).type === 'string' &&
    typeof (v as { timestamp?: unknown }).timestamp === 'string'
  );
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export async function parseCodex(root: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root)) {
    let meta: SessionMetaPayload | null = null;
    let model: string | null = null;
    for await (const line of readJsonlLines(path)) {
      if (!isEnvelope(line)) continue;
      const payload = line.payload;
      if (line.type === 'session_meta') {
        if (isObject(payload) && typeof payload['id'] === 'string') {
          meta = { id: payload['id'], cwd: typeof payload['cwd'] === 'string' ? payload['cwd'] : undefined };
        }
        continue;
      }
      if (line.type === 'turn_context') {
        if (isObject(payload) && typeof payload['model'] === 'string') {
          model = payload['model'];
        }
        continue;
      }
      if (line.type !== 'event_msg') continue;
      if (!isObject(payload) || payload['type'] !== 'token_count') continue;
      const tcp = payload as unknown as TokenCountPayload;
      const info = tcp.info;
      if (!info || !info.last_token_usage) continue;
      if (!meta || !model) continue;
      const u = info.last_token_usage;
      events.push({
        tool: 'codex',
        provider: 'openai',
        model,
        timestamp: line.timestamp,
        sessionId: meta.id,
        projectPath: meta.cwd,
        tokens: {
          // input_tokens is inclusive of cached_input_tokens; subtract so cache reads aren't double-counted.
          input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
          // output_tokens already includes reasoning_output_tokens; don't add it again.
          output: u.output_tokens ?? 0,
          cacheRead: u.cached_input_tokens ?? 0,
          cacheWrite: 0,
        },
      });
    }
  }
  return events;
}
