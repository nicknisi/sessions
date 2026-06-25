// Sessions-owned (forked from tokenmaxing's parser). Dedupes usage by (message.id, requestId)
// so the same API response — copied across resumed/forked session files — is counted once, matching ccusage.
import type { UsageEvent } from './types.ts';
import { walkJsonl, readJsonlLines } from './util.ts';

interface ClaudeAssistantLine {
  type: 'assistant';
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

function isAssistantLine(v: unknown): v is ClaudeAssistantLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'assistant';
}

export async function parseClaudeCode(root: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  // The same API response is rewritten into every resumed/forked session file; dedupe by the
  // Anthropic message id + requestId (globally across files) so each response is counted once.
  const seen = new Set<string>();
  for await (const path of walkJsonl(root)) {
    for await (const line of readJsonlLines(path)) {
      if (!isAssistantLine(line)) continue;
      const u = line.message?.usage;
      const model = line.message?.model;
      const ts = line.timestamp;
      const sid = line.sessionId;
      if (!u || !model || !ts || !sid) continue;
      const id = line.message?.id;
      if (id) {
        const key = `${id}|${line.requestId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
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
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
      });
    }
  }
  return events;
}
