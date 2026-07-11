/** Parse one JSONL line to an object, or null if it isn't valid JSON. */
export function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * OpenCode content blocks of every assistant turn, in order — the one place the
 * OpenCode extractors (files, commands, errors) share their traversal of the
 * synthesized `{type:'message', message:{role:'assistant', content:[…]}}` shape.
 */
export function opencodeAssistantBlocks(lines: string[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object') blocks.push(block as Record<string, unknown>);
    }
  }
  return blocks;
}

/** A tool block's `state.input` as a record (empty when absent). I.e. { command, filePath, pattern }. */
export function toolInput(block: Record<string, unknown>): Record<string, unknown> {
  const state = block.state as Record<string, unknown> | undefined;
  const input = state?.input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}
