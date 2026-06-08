// VENDORED VERBATIM from tokenmaxing/src/parsers/pi.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
import type { UsageEvent } from './types.ts';
import { walkJsonl, readJsonlLines } from './util.ts';

interface PiSessionLine {
  type: 'session';
  id: string;
  cwd?: string;
}
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
interface PiMessageLine {
  type: 'message';
  timestamp: string;
  // Current Pi nests provider/model/usage inside `message`; older logs put them at the top level.
  message?: { role?: string; provider?: string; model?: string; usage?: PiUsage };
  provider?: string;
  model?: string;
  usage?: PiUsage;
}

function isSession(v: unknown): v is PiSessionLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'session';
}
function isMessage(v: unknown): v is PiMessageLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'message';
}

export async function parsePi(root: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root)) {
    let session: PiSessionLine | null = null;
    for await (const line of readJsonlLines(path)) {
      if (isSession(line)) {
        session = line;
        continue;
      }
      if (!isMessage(line)) continue;
      if (line.message?.role !== 'assistant') continue;
      // Pi moved provider/model/usage from the top level into `message`.
      // Prefer the nested location; fall back to legacy top-level fields.
      const provider = line.message?.provider ?? line.provider;
      const model = line.message?.model ?? line.model;
      const usage = line.message?.usage ?? line.usage;
      if (!usage || !provider || !model || !session) continue;
      events.push({
        tool: 'pi',
        provider,
        model,
        timestamp: line.timestamp,
        sessionId: session.id,
        projectPath: session.cwd,
        tokens: {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
        },
        costUSD: usage.cost?.total,
      });
    }
  }
  return events;
}
