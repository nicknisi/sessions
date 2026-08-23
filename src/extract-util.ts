import { z } from 'zod';

/** A parsed JSON value; the raw material every extractor narrows from. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

// The canonical JSON boundary: recursive, so a parsed line's contents are all
// JsonValue without any per-site casts.
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), jsonObjectSchema]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** Narrow to a JSON object: primitives and arrays fall out. */
export function asJsonObject(v: JsonValue | undefined): JsonObject | undefined {
  if (v === null || v === undefined || Array.isArray(v)) return undefined;
  const parsed = jsonObjectSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Narrow to a string; anything else falls out. */
export function asJsonString(v: JsonValue | undefined): string | undefined {
  const parsed = z.string().safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Narrow to a number; anything else falls out. */
export function asJsonNumber(v: JsonValue | undefined): number | undefined {
  const parsed = z.number().safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** The string members of a JSON array; non-arrays and non-strings fall out. */
export function jsonStrings(v: JsonValue | undefined): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const s = asJsonString(x);
    return s === undefined ? [] : [s];
  });
}

/**
 * The minimal message-line shape the shared user-turn helpers below read. Kept
 * structural (rather than parser.ts's JsonLine) so both parser.ts and pi-tree.ts
 * can use them without an import cycle between those two modules.
 */
export type MessageLine = {
  type?: string;
  isCompactSummary?: boolean;
  promptSource?: string | null;
  message?: JsonObject | string;
};

/** Parse one JSONL line to an object, or null — never throws, never yields a bare primitive. */
export function tryParse(line: string): JsonObject | null {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
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
  const msg = asJsonObject(d.message);
  if (!msg) return '';
  const content = msg.content;
  const texts: string[] = [];

  if (Array.isArray(content)) {
    for (const c of content) {
      const block = asJsonObject(c);
      if (block && (block.type === 'text' || block.type === 'input_text')) {
        // No type gate on text: the old casts pushed the value raw and join
        // stringified it; String() keeps that exact behavior.
        texts.push(block.text === null || block.text === undefined ? '' : String(block.text));
      }
    }
  } else {
    const text = asJsonString(content);
    if (text !== undefined) texts.push(text);
  }
  return stripInjected(texts.join(' '));
}

/** Whether a line carries a user-role message (Claude `user` shape or pi/codex `message` envelope). */
export function isUserMessage(d: MessageLine): boolean {
  if (d.type === 'user') return true;
  if (d.type === 'message') {
    return asJsonObject(d.message)?.role === 'user';
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
export function opencodeAssistantBlocks(lines: string[]): JsonObject[] {
  const blocks: JsonObject[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = asJsonObject(d.message);
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const parsed = asJsonObject(block);
      if (parsed) blocks.push(parsed);
    }
  }
  return blocks;
}

/** A tool block's `state.input` as an object (empty when absent). I.e. { command, filePath, pattern }. */
export function toolInput(block: JsonObject): JsonObject {
  const state = asJsonObject(block.state);
  return asJsonObject(state?.input) ?? {};
}
