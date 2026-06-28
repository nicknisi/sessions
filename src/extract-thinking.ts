import type { Tool } from './types';

export const MAX_THINKING_LEN = 20_000;

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collect(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || (d.type !== 'assistant' && d.type !== 'message')) continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    }
  }
  return parts.join('\n').slice(0, MAX_THINKING_LEN);
}

/**
 * Plaintext reasoning text for the (low-weighted) `thinking` FTS column. Claude and
 * Pi store `thinking` blocks in assistant content; Codex reasoning is encrypted in
 * the logs, so Codex returns empty.
 */
export function extractThinking(lines: string[], tool: Tool): string {
  if (tool === 'codex') return '';
  return collect(lines);
}
