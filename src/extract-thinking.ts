import type { Tool } from './types';
import { tryParse, asJsonObject, asJsonString } from './extract-util';

export const MAX_THINKING_LEN = 20_000;

function collect(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || (d.type !== 'assistant' && d.type !== 'message')) continue;
    const msg = asJsonObject(d.message);
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asJsonObject(block);
      if (!b) continue;
      if (b.type === 'thinking') {
        const thinking = asJsonString(b.thinking);
        if (thinking !== undefined) parts.push(thinking);
      }
    }
  }
  return parts.join('\n').slice(0, MAX_THINKING_LEN);
}

/**
 * Plaintext reasoning text for the (low-weighted) `thinking` FTS column. Claude and
 * Pi store `thinking` blocks in assistant content, and OpenCode's synthesized lines
 * carry them too (its `reasoning` parts — see src/opencode.ts); Codex reasoning is
 * encrypted in the logs, so Codex returns empty.
 */
export function extractThinking(lines: string[], tool: Tool): string {
  if (tool === 'codex') return '';
  return collect(lines);
}
