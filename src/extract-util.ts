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

// The hot-path schemas, built once: constructing `z.string()` per call and
// re-validating every nested value of a line JSON.parse just produced were
// most of the index build's time.
const stringSchema = z.string();
const numberSchema = z.number();
/** A JSON object whose values are already JSON — what JSON.parse guarantees —
 *  so only the top level needs checking. */
export const parsedObjectSchema = z.record(z.string(), z.custom<JsonValue>());

/** Narrow to a JSON object: primitives and arrays fall out. */
export function asJsonObject(v: JsonValue | undefined): JsonObject | undefined {
  if (v === null || v === undefined || Array.isArray(v)) return undefined;
  // v is already a JsonValue, so its members are too; only the top level needs checking.
  const parsed = parsedObjectSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Narrow to a string; anything else falls out. */
export function asJsonString(v: JsonValue | undefined): string | undefined {
  const parsed = stringSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Narrow to a number; anything else falls out. */
export function asJsonNumber(v: JsonValue | undefined): number | undefined {
  const parsed = numberSchema.safeParse(v);
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
  type?: JsonValue;
  isCompactSummary?: JsonValue;
  promptSource?: JsonValue;
  message?: JsonValue;
};

/** Parse one JSONL line to an object, or null — never throws, never yields a bare primitive. */
export function tryParse(line: string): JsonObject | null {
  try {
    const parsed = parsedObjectSchema.safeParse(JSON.parse(line));
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

/** A tool block's `state.input` as an object (empty when absent). I.e. { command, filePath/path, pattern }. */
export function toolInput(block: JsonObject): JsonObject {
  const state = asJsonObject(block.state);
  return asJsonObject(state?.input) ?? {};
}

/**
 * Streaming form of an extractor: feed the transcript's lines in file order, in any
 * number of chunks, and `result()` equals one call over the whole file. The state is
 * plain data, so an index can save it and resume from where a file last ended.
 */
export interface Collector<R, S = R> {
  add(lines: string[]): void;
  result(): R;
  state(): S;
}

/**
 * The de-duplicating, order-preserving, capped list every list extractor returns.
 * `seed` resumes from a previous `state()`: `seen` is exactly the set of `out`,
 * because an item is only remembered when it is kept.
 */
export function createDedupCollector(
  cap: number,
  feed: (lines: string[], push: (item: string) => void) => void,
  seed: string[] = [],
): Collector<string[]> {
  const out = seed.slice();
  const seen = new Set(out);
  const push = (item: string): void => {
    if (seen.has(item) || out.length >= cap) return;
    seen.add(item);
    out.push(item);
  };
  return {
    add: (lines) => feed(lines, push),
    result: () => out,
    state: () => out,
  };
}

export interface CappedTextState {
  text: string;
  /** Whether any part was seen. An empty part still adds a separator. */
  any: boolean;
}

/**
 * `parts.join('\n').slice(0, cap)` over the whole file, built chunk by chunk. Cutting
 * the running text to `cap` after each chunk keeps it bounded and keeps the same
 * prefix the whole-file join would have.
 */
export function createCappedTextCollector(
  cap: number,
  parts: (lines: string[]) => string[],
  seed: CappedTextState = { text: '', any: false },
): Collector<string, CappedTextState> {
  let { text, any } = seed;
  return {
    add(lines) {
      if (text.length >= cap) return;
      const chunk = parts(lines);
      if (chunk.length === 0) return;
      text = ((any ? `${text}\n` : '') + chunk.join('\n')).slice(0, cap);
      any = true;
    },
    result: () => text,
    state: () => ({ text, any }),
  };
}
