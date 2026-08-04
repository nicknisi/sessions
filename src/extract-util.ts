/**
 * The minimal message-line shape the shared user-turn helpers below read. Kept
 * structural (rather than parser.ts's JsonLine) so both parser.ts and pi-tree.ts
 * can use them without an import cycle between those two modules.
 */
export type MessageLine = {
  type?: string;
  isCompactSummary?: boolean;
  promptSource?: string | null;
  message?: Record<string, unknown> | string;
};

/** Parse one JSONL line to a record, or null — never throws, never yields a bare primitive. */
export function tryParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stripInjected(text: string): string {
  const patterns = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
    /<command-name>[\s\S]*?<\/command-name>/g,
    /<command-message>[\s\S]*?<\/command-message>/g,
    /<command-args>[\s\S]*?<\/command-args>/g,
    // Agent/harness injections that ride in on a user-role line but are not the
    // human talking: task-completion pings, `!`-mode shell echoes, teammate relays.
    // `\b[^>]*` tolerates attributes on the opening tag (e.g. <teammate-message
    // teammate_id="..." color="...">), which these tags carry in multi-agent logs.
    /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/g,
    /<bash-input\b[^>]*>[\s\S]*?<\/bash-input>/g,
    /<bash-stdout\b[^>]*>[\s\S]*?<\/bash-stdout>/g,
    /<bash-stderr\b[^>]*>[\s\S]*?<\/bash-stderr>/g,
    /<teammate-message\b[^>]*>[\s\S]*?<\/teammate-message>/g,
  ];
  for (const p of patterns) {
    text = text.replace(p, '');
  }
  return text;
}

/** The joined, injection-stripped text of a user-role line's message content. */
export function extractUserText(d: MessageLine): string {
  const msg = d.message;
  if (!msg || typeof msg !== 'object') return '';
  const content = (msg as Record<string, unknown>).content;
  const texts: string[] = [];

  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        typeof c === 'object' &&
        c !== null &&
        ((c as Record<string, unknown>).type === 'text' || (c as Record<string, unknown>).type === 'input_text')
      ) {
        texts.push((c as Record<string, string>).text ?? '');
      }
    }
  } else if (typeof content === 'string') {
    texts.push(content);
  }
  return stripInjected(texts.join(' '));
}

/** Whether a line carries a user-role message (Claude `user` shape or pi/codex `message` envelope). */
export function isUserMessage(d: MessageLine): boolean {
  if (d.type === 'user') return true;
  if (d.type === 'message') {
    const msg = d.message;
    return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).role === 'user';
  }
  return false;
}

/** Claude prepends this exact line to every skill body it injects as a user turn. */
const SKILL_INJECTION_PREAMBLE = /^Base directory for this skill:/;

/**
 * Whether a user-role line is a genuine human turn — not a tool result, a
 * system-injected turn, a compaction summary, or a skill body injected as a
 * user message. The disqualifiers below fire regardless of `promptSource`
 * because agent/harness injections (compaction carryover, task-completion
 * pings echoed as `!`-mode shell lines) can arrive with any source.
 * Claude lines then carry `promptSource`: when the field is present, only
 * `typed` and `queued` count (a present-but-null value, as tool results and
 * skill loads have, is rejected). Older logs and pi/codex have no
 * `promptSource`, so fall back to a heuristic: non-empty text that isn't a
 * skill-injection preamble. (Tag-wrapped injections — <task-notification>,
 * <bash-input>, <bash-stdout>, <teammate-message> — are already emptied by
 * stripInjected upstream, so they never reach here with text.)
 */
export function isGenuineUserTurn(d: MessageLine, strippedText: string): boolean {
  if (d.isCompactSummary === true) return false;
  if (!strippedText) return false;
  if (SKILL_INJECTION_PREAMBLE.test(strippedText)) return false;
  if ('promptSource' in d) {
    return d.promptSource === 'typed' || d.promptSource === 'queued';
  }
  return true;
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
