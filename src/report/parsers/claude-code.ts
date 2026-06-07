// VENDORED VERBATIM from tokenmaxing/src/parsers/claude-code.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
import type { UsageEvent } from './types.ts';
import { walkJsonl, readJsonlLines } from './util.ts';

interface ClaudeAssistantLine {
  type: 'assistant';
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function isAssistantLine(v: unknown): v is ClaudeAssistantLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'assistant';
}

export async function parseClaudeCode(root: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root)) {
    for await (const line of readJsonlLines(path)) {
      if (!isAssistantLine(line)) continue;
      const u = line.message?.usage;
      const model = line.message?.model;
      const ts = line.timestamp;
      const sid = line.sessionId;
      if (!u || !model || !ts || !sid) continue;
      events.push({
        tool: 'claude-code',
        provider: 'anthropic',
        model,
        timestamp: ts,
        sessionId: sid,
        projectPath: line.cwd,
        tokens: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
      });
    }
  }
  return events;
}
