import { type Tool } from './types';
import { extractUserText, isGenuineUserTurn, isUserMessage, stripInjected } from './extract-util';
import { buildPiTree, type PiEntry } from './pi-tree';

interface JsonLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  customTitle?: string;
  promptSource?: string | null;
  /** Claude marks auto-generated context-carryover turns (the "continued from a
   *  previous conversation" summary written on compaction) with this flag. */
  isCompactSummary?: boolean;
  /** True on every line of a subagent (Task) transcript — which carries the
   *  PARENT sessionId, so its injected "user" prompt would otherwise pass for
   *  the human speaking mid-session. */
  isSidechain?: boolean;
  /** Pi /fork and /clone copies record the absolute path of the session they
   *  were copied from in their line-1 session header. */
  parentSession?: string;
  message?: Record<string, unknown> | string;
  payload?: Record<string, unknown>;
}

function tryParseJson(line: string): JsonLine | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export interface SessionMetadata {
  cwd: string;
  customTitle: string;
  date: string;
  createdAt: string;
  /**
   * The first timestamp in full, not truncated to a day like `createdAt`.
   *
   * The index needs the time of day for the active-hours histogram. Without this
   * column get_session_metrics made a second pass over every matched row, reopening
   * each transcript from disk purely to read line 1's clock.
   */
  startedAt: string;
  messageCount: number;
  branch: string;
}

/**
 * Extract the session-level fields needed by the index in one JSON parse pass.
 * These used to be collected by six independent helpers, which made indexing an
 * actively growing (and often multi-megabyte) transcript parse the same JSONL
 * records over and over.
 */
export function extractSessionMetadata(lines: string[], tool: Tool): SessionMetadata {
  let cwd = '';
  let title = '';
  let firstDate = '?';
  let firstTs = '';
  let lastDate = '?';
  let count = 0;
  let branch = '';

  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (!cwd) {
      if (tool === 'claude' && d.cwd) {
        cwd = d.cwd;
      } else if ((tool === 'pi' || tool === 'opencode') && d.type === 'session' && d.cwd) {
        cwd = d.cwd;
      } else if (tool === 'codex' && d.type === 'session_meta') {
        const value = (d.payload as Record<string, unknown> | undefined)?.cwd;
        if (typeof value === 'string' && value) cwd = value;
      }
    }

    if (d.type === 'custom-title') title = d.customTitle ?? '';

    if (d.timestamp?.[0] === '2') {
      const date = d.timestamp.slice(0, 10);
      if (firstDate === '?') {
        firstDate = date;
        firstTs = d.timestamp;
      }
      lastDate = date;
    }

    if (isUserMessage(d) || d.type === 'assistant') {
      count++;
    } else if (d.type === 'message') {
      const msg = d.message;
      if (typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).role === 'assistant') count++;
    } else if (d.type === 'response_item') {
      // The same envelope gap extractMessages had, in the counting loop. Left unfixed,
      // every Codex row indexed with message_count 0 even once its messages parsed —
      // `developer` is excluded here for the same reason it is there: injected framing.
      const p = d.payload;
      const role = p?.['type'] === 'message' ? p['role'] : undefined;
      if (role === 'user' || role === 'assistant') count++;
    }

    if (tool === 'claude') {
      if (typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch;
    } else if (tool === 'codex' && !branch && d.type === 'session_meta') {
      const git = (d.payload as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
      if (typeof git?.branch === 'string' && git.branch) branch = git.branch;
    }
  }

  return {
    cwd,
    customTitle: title,
    date: lastDate,
    createdAt: firstDate,
    startedAt: firstTs,
    messageCount: count,
    branch,
  };
}

/**
 * The parentSession path from a pi session header ('' for other tools and for pi
 * sessions that are not /fork or /clone copies). Stored raw — the parent file may
 * not exist on disk, and nothing resolves the path back to a session row; display
 * surfaces derive a basename at render time.
 */
export function sessionParentSession(lines: string[], tool: Tool): string {
  // Guard the tool FIRST: Claude transcripts open on a user message and Codex on
  // session_meta — neither has a type:'session' line 1, but only pi's header can
  // carry parentSession at all, so non-pi returns without a parse.
  if (tool !== 'pi' || lines.length === 0) return '';
  const d = tryParseJson(lines[0]!);
  const ps = d?.type === 'session' ? d.parentSession : undefined;
  return typeof ps === 'string' ? ps : '';
}

export function getCwdFromSession(lines: string[], tool: Tool): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (tool === 'claude') {
      if (d.cwd) return d.cwd;
    } else if (tool === 'pi' || tool === 'opencode') {
      // Pi's native shape; OpenCode synthesizes the same session line (see src/opencode.ts).
      if (d.type === 'session' && d.cwd) return d.cwd;
    } else if (tool === 'codex') {
      if (d.type === 'session_meta') {
        const cwd = (d.payload as Record<string, unknown>)?.cwd as string;
        if (cwd) return cwd;
      }
    }
  }
  return '';
}

/**
 * The git branch a session ran on, read from the logs (not the current worktree).
 * Claude writes `gitBranch` on every line, so the last non-empty one is "where
 * you left off". Codex records its starting branch once in `session_meta`. Pi
 * and OpenCode carry no git metadata, so they return ''.
 */
export function sessionBranch(lines: string[], tool: Tool): string {
  if (tool === 'codex') {
    for (const line of lines) {
      const d = tryParseJson(line);
      if (d?.type !== 'session_meta') continue;
      const git = (d.payload as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
      const b = git?.branch;
      if (typeof b === 'string' && b) return b;
    }
    return '';
  }
  if (tool === 'claude') {
    let branch = '';
    for (const line of lines) {
      const d = tryParseJson(line);
      const b = d?.gitBranch;
      if (typeof b === 'string' && b) branch = b; // keep the last non-empty
    }
    return branch;
  }
  return ''; // pi, opencode: no git metadata in logs
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export interface GenuineUserTurn {
  sessionId: string;
  timestamp: string;
  text: string;
}

/**
 * A genuine human turn with its place in time — the boundary marker wrapped's
 * loop metric splits autonomous runs on. Takes an already-parsed JSONL line
 * (the report walkers yield parsed objects, not strings). Beyond the
 * `isGenuineUserTurn` rules this also rejects sidechain lines: a subagent
 * transcript carries the parent sessionId, so its injected task prompt would
 * otherwise read as the human speaking mid-loop.
 */
export function genuineUserTurnFromLine(v: unknown): GenuineUserTurn | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as JsonLine;
  if (d.isSidechain === true || !isUserMessage(d)) return null;
  const { sessionId, timestamp } = d;
  if (!sessionId || !timestamp) return null;
  const text = extractUserText(d).trim();
  if (!text || !isGenuineUserTurn(d, text)) return null;
  return { sessionId, timestamp, text };
}

/** Genuine human user turns, in order, as stripped (not length-clamped) text. */
export function genuineUserTexts(lines: string[], _tool: Tool): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d).trim(); // extractUserText already stripInjected
    if (text && isGenuineUserTurn(d, text)) out.push(text);
  }
  return out;
}

export function firstPrompt(lines: string[], tool: Tool): string {
  const genuine = genuineUserTexts(lines, tool);
  return genuine.length ? clean(genuine[0]!) : '';
}

export function customTitle(lines: string[]): string {
  let title = '';
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (d.type === 'custom-title') {
      title = ((d as Record<string, unknown>).customTitle as string) ?? '';
    }
  }
  return title;
}

export function firstTimestamp(lines: string[]): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    const ts = d.timestamp as string | undefined;
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function messageCount(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (isUserMessage(d) || d.type === 'assistant') count++;
    else if (d.type === 'message') {
      const msg = d.message;
      if (typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).role === 'assistant') count++;
    }
  }
  return count;
}

/**
 * The last dated line in a transcript. Scans backwards, so the common case (the
 * final line carries a timestamp) still returns on the first iteration.
 *
 * This is the differential oracle for `extractSessionMetadata().date` — the two
 * must agree exactly. An earlier version searched only the last 200 lines and,
 * finding nothing dated there, fell back to the *first* timestamp in the file;
 * that fallback reported a session's date as its start rather than its end, and
 * no real transcript ever reached it (Claude dates every line).
 */
export function lastTimestamp(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = tryParseJson(lines[i]!);
    if (!d) continue;
    const ts = d.timestamp as string | undefined;
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function contentMatches(lines: string[], query: string): boolean {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    if (text.toLowerCase().includes(query)) return true;
  }
  return false;
}

/** A tool invocation the assistant made, reduced to its name and one salient input. */
export interface ToolUse {
  name: string;
  /** One-line, human-readable summary of the salient input (command, path, url, …); '' if none. */
  summary: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  index: number;
  /** Tool calls belonging to this turn (empty for most user turns). See extractMessages. */
  tools: ToolUse[];
  /** Pi branch label, carried through from ExtractedMessage. See PiForkMarker. */
  branch?: 'active' | 'abandoned';
  /** Fork marker, present on the first message of an abandoned pi branch. */
  fork?: PiForkMarker;
}

/** Input fields, most-informative first, used to summarize a tool call for display. */
const TOOL_SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
  'old_string',
];

/** Reduce a tool_use input object to a single short, human-readable line. */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  let val: string | undefined;
  for (const k of TOOL_SUMMARY_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      val = v;
      break;
    }
  }
  if (val === undefined) {
    const firstStr = Object.values(o).find((v) => typeof v === 'string' && v.trim());
    if (typeof firstStr === 'string') val = firstStr;
  }
  if (!val) return '';
  const s = val.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * The tool_use blocks on a single assistant/message line, in order. Recognizes the
 * Claude/Anthropic content-array shape (`{type:'tool_use', name, input}`); returns []
 * for shapes it doesn't model (most pi/codex tool calls), which is a display-only gap.
 */
function extractToolUses(d: JsonLine): ToolUse[] {
  const msg = d.message;
  if (!msg || typeof msg !== 'object') return [];
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'tool_use') {
      const rec = c as Record<string, unknown>;
      out.push({ name: typeof rec.name === 'string' ? rec.name : '?', summary: summarizeToolInput(rec.input) });
    }
  }
  return out;
}

function extractAssistantText(d: JsonLine): string {
  if (d.type === 'assistant') {
    const msg = d.message;
    if (typeof msg === 'string') return msg;
    if (!msg || typeof msg !== 'object') return '';
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const c of content) {
        if (typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text') {
          texts.push((c as Record<string, string>).text ?? '');
        }
      }
      return texts.join(' ');
    }
  }
  if (d.type === 'message') {
    const msg = d.message;
    if (typeof msg !== 'object' || msg === null) return '';
    if ((msg as Record<string, unknown>).role !== 'assistant') return '';
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const c of content) {
        if (typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text') {
          texts.push((c as Record<string, string>).text ?? '');
        }
      }
      return texts.join(' ');
    }
  }
  return '';
}

/** Fork marker attached to the first message of an abandoned pi branch. */
export interface PiForkMarker {
  /**
   * msg_index of the active-path message nearest the fork point. The fork parent is
   * often a non-message entry (model_change, custom), so this maps to the closest
   * extracted message on the active path at or before the parent's line (the first
   * active message after it when none precedes).
   */
  fromIndex: number;
  /**
   * Extracted MESSAGES in the abandoned branch — not the branch's entry count
   * (PiFork.abandonedCount): toolResult/custom entries and pure-toolCall assistant
   * lines produce no message.
   */
  abandonedCount: number;
  /** First genuine user text in the branch, truncated; '' when the branch has none. */
  firstUserText: string;
  timestamp: string;
}

export interface ExtractedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Sequential over ALL non-empty messages — identical to getSessionMessages numbering. */
  index: number;
  /** user turns: isGenuineUserTurn; assistant turns: always true. */
  genuine: boolean;
  /**
   * Tool calls belonging to this turn. A pure-tool-use assistant line carries no text
   * and so gets no index of its own; its calls fold into the current turn's head
   * message here. This keeps numbering dense (array[i].index === i) — the invariant
   * get_session_messages pagination and search-hit offsets both depend on.
   */
  tools: ToolUse[];
  /**
   * Pi branch label. Present only on pi transcripts with topology breaks, and only
   * ever 'abandoned' — active-path messages are unmarked, and unbranched pi files
   * get no field at all (the annotation pass returns early when there are no forks,
   * keeping unbranched output byte-identical).
   */
  branch?: 'active' | 'abandoned';
  /** Fork marker, present on the first message of each abandoned branch. */
  fork?: PiForkMarker;
}

export interface MessageSummary {
  firstPrompt: string;
  closingUser: string;
  closingAssistant: string;
}

// ——— Codex ———

/**
 * Text that arrives on a user-role line but is not the human speaking. Codex writes no
 * `promptSource`, so these prefixes are the shape of every injection observed across the
 * real corpus (305 rollouts, 1,022 user records, 417 of them injections).
 *
 * `Warning: ` is the harness scolding itself — "Warning: apply_patch was requested via
 * exec_command…" — and it is the one prefix that could plausibly open a human turn. It is
 * still tested before the event_msg join rather than after, because the sessions carrying
 * it are exactly the ones with no `user_message` events to join against.
 */
const CODEX_INJECTED =
  /^(<environment_context|<user_action|<turn_aborted|<recommended_plugins|<image\b|<skill\b|<user_shell_command|# AGENTS\.md instructions for |Warning: )/;

/** How far in to look for the Codex envelope. Every real rollout opens with `session_meta`
 *  on line 1; the slack absorbs a truncated or blank-padded head. */
const CODEX_SNIFF_LINES = 20;

/**
 * Whether these lines are a Codex rollout.
 *
 * Sniffed rather than passed in: getSessionMessages runs from mcp.ts and cache.ts with
 * nothing but a file's lines, so a `tool` parameter would have to be threaded through
 * every caller. The check reads the PARSED top-level `type` and never a substring of the
 * raw line — a transcript that merely discusses Codex has `response_item` in its prose.
 */
function isCodexTranscript(lines: string[]): boolean {
  const n = Math.min(lines.length, CODEX_SNIFF_LINES);
  for (let i = 0; i < n; i++) {
    const t = tryParseJson(lines[i] ?? '')?.type;
    if (t === 'session_meta' || t === 'response_item') return true;
  }
  return false;
}

/** The text of a Codex payload's content blocks of `kind`, joined. */
function codexText(payload: Record<string, unknown>, kind: 'input_text' | 'output_text'): string {
  const content = payload['content'];
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === kind) {
      texts.push((c as Record<string, string>)['text'] ?? '');
    }
  }
  return texts.join(' ');
}

/** A Codex tool call, whatever envelope it arrived in. */
function codexToolUse(p: Record<string, unknown>): ToolUse {
  const name = typeof p['name'] === 'string' ? p['name'] : String(p['type'] ?? '?');
  // Codex ships arguments three ways: a JSON string (`function_call.arguments`), the raw
  // payload itself (`custom_tool_call.input` — a patch or a script), and an object.
  const raw = p['arguments'] ?? p['input'] ?? p['action'];
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return { name, summary: summarizeToolInput(o) };
    } catch {
      // Not JSON — it is the patch or script text itself, so summarize it directly.
    }
    const s = raw.replace(/\s+/g, ' ').trim();
    return { name, summary: s.length > 120 ? s.slice(0, 120) + '…' : s };
  }
  return { name, summary: summarizeToolInput(raw) };
}

/**
 * Codex, both streams reconciled.
 *
 * Codex writes two parallel logs. `response_item` is the model-facing history and
 * `event_msg` is the UI event log, and they overlap: every assistant text is duplicated
 * by an `event_msg` `agent_message`. Messages therefore come from `response_item` only —
 * reading both would double every Codex turn in message_fts.
 *
 * What `event_msg` alone has is `user_message`: the harness echo of what the human
 * actually typed, and nothing it injected. That makes genuineness a JOIN rather than a
 * heuristic. Measured over the 305-rollout corpus, 604 of 1,022 user records have a
 * text-identical twin in that stream, and every one of the 417 that do not is matched by
 * CODEX_INJECTED — the two signals agree completely, with nothing left unexplained.
 */
function extractCodexMessages(lines: string[]): ExtractedMessage[] {
  const parsed = lines.map(tryParseJson);

  // Pass 1: the genuineness oracle. The `user_message` event usually lands AFTER its
  // `response_item` twin, so this cannot fold into the emit pass below.
  const typed = new Set<string>();
  const userTexts: string[] = [];
  for (const d of parsed) {
    if (!d?.payload) continue;
    if (d.type === 'event_msg' && d.payload['type'] === 'user_message') {
      const m = d.payload['message'];
      if (typeof m === 'string' && m.trim()) typed.add(m.trim());
    } else if (d.type === 'response_item' && d.payload['type'] === 'message' && d.payload['role'] === 'user') {
      const t = stripInjected(codexText(d.payload, 'input_text')).trim();
      if (t) userTexts.push(t);
    }
  }
  // Trust the join only where it demonstrably joins. If Codex ever normalized whitespace
  // differently between the two streams, every turn would silently flip to genuine:false
  // and first_prompt would go blank again — indistinguishable from the bug this fixes. A
  // session whose streams do not meet falls back to the injection prefixes alone.
  const joins = typed.size > 0 && userTexts.some((t) => typed.has(t));

  const messages: ExtractedMessage[] = [];
  let idx = 0;
  // The turn's head message — where a following pure-tool-call line's calls attach.
  let current: ExtractedMessage | null = null;
  let pending: ToolUse[] = [];

  for (const d of parsed) {
    if (!d || d.type !== 'response_item' || !d.payload) continue;
    const p = d.payload;
    switch (p['type']) {
      case 'message': {
        if (p['role'] === 'user') {
          const text = stripInjected(codexText(p, 'input_text'));
          const trimmed = text.trim();
          if (!trimmed) break;
          const genuine = !CODEX_INJECTED.test(trimmed) && (!joins || typed.has(trimmed));
          current = { role: 'user', text, index: idx++, genuine, tools: pending };
          pending = [];
          messages.push(current);
        } else if (p['role'] === 'assistant') {
          const text = codexText(p, 'output_text');
          if (!text.trim()) break;
          current = { role: 'assistant', text, index: idx++, genuine: true, tools: pending };
          pending = [];
          messages.push(current);
        }
        // Any other role (`developer`, `system`) is injected framing, not a turn.
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'web_search_call':
      case 'tool_search_call': {
        // A pure tool-call line carries no text and so gets no index of its own; its
        // call folds into the head of the current turn, exactly as the Claude path does.
        const call = codexToolUse(p);
        if (current) current.tools.push(call);
        else pending.push(call);
        break;
      }
    }
  }
  return messages;
}

/**
 * The single numbering authority for message extraction. Every non-empty
 * user/assistant message in order, with a sequential index and a `genuine` flag
 * for user turns (injected skill bodies and tool results still consume an index —
 * they are counted, just flagged — so genuineness is metadata, never numbering).
 * Search-hit indices (message_fts) and get_session_messages pagination must agree
 * exactly, so both derive from this function.
 */
export function extractMessages(lines: string[]): ExtractedMessage[] {
  // Codex nests its messages under a `response_item` envelope the dispatch below does
  // not model, which is why every Codex transcript extracted to zero messages.
  if (isCodexTranscript(lines)) return extractCodexMessages(lines);

  const messages: ExtractedMessage[] = [];
  // Source line of each emitted message — the pi annotation pass maps messages back
  // to tree entries through these.
  const messageLines: number[] = [];
  let idx = 0;
  // The turn's head message — where a following pure-tool-use line's calls attach.
  let current: ExtractedMessage | null = null;
  // Tool calls seen before any message was emitted (rare: a session opening on a tool
  // call). Buffered here and flushed onto the first emitted message.
  let pending: ToolUse[] = [];
  for (let li = 0; li < lines.length; li++) {
    const d = tryParseJson(lines[li]!);
    if (!d) continue;
    if (isUserMessage(d)) {
      const text = extractUserText(d);
      if (text.trim()) {
        current = { role: 'user', text, index: idx++, genuine: isGenuineUserTurn(d, text.trim()), tools: pending };
        pending = [];
        messages.push(current);
        messageLines.push(li);
      }
      // A user line with no text is a tool_result/empty turn — it carries no tool_use
      // and must not reset `current` (assistant calls after it still belong to the turn).
    } else {
      const text = extractAssistantText(d);
      const tools = extractToolUses(d);
      if (text.trim()) {
        current = { role: 'assistant', text, index: idx++, genuine: true, tools: pending.concat(tools) };
        pending = [];
        messages.push(current);
        messageLines.push(li);
      } else if (tools.length) {
        // Pure tool-use turn: no text row (so no index), fold its calls into the head.
        if (current) current.tools.push(...tools);
        else pending.push(...tools);
      }
    }
  }
  annotatePiBranches(messages, messageLines, lines);
  return messages;
}

/**
 * Pi branch annotation. Pi session files are trees: /tree navigation leaves abandoned
 * branches in the same append-only JSONL, and the linear pass above renders those dead
 * exchanges inline as if they happened in the live conversation. The fix is
 * chronological ANNOTATION, not path filtering or reordering — pi appends entries in
 * the order things happened, so raw file order is already truthful, and reordering
 * would falsify the timeline and break the msg_index ↔ get_session_messages(offset)
 * contract. Every message keeps its natural position and gains a label:
 * abandoned-branch messages get branch:'abandoned', and the first message of each
 * abandoned branch carries a fork marker. Numbering is untouched — abandoned messages
 * keep their indices in the single numbering space.
 *
 * No-op purity: buildPiTree returns null on non-pi transcripts, and unbranched pi
 * sessions (~98% of the corpus) return before any field is set, keeping their output
 * byte-identical.
 */
function annotatePiBranches(messages: ExtractedMessage[], messageLines: number[], lines: string[]): void {
  const tree = buildPiTree(lines);
  if (!tree || tree.forks.length === 0) return;
  const entryByLine = new Map<number, PiEntry>();
  const entryById = new Map<string, PiEntry>();
  for (const e of tree.entries) {
    entryByLine.set(e.lineIndex, e);
    if (!entryById.has(e.id)) entryById.set(e.id, e);
  }
  const entryOf = messageLines.map((li) => entryByLine.get(li));
  let any = false;
  for (let i = 0; i < messages.length; i++) {
    const e = entryOf[i];
    // A message line with no tree entry can't happen on real pi files (every line
    // carries an id); treat it as active rather than mislabeling it.
    if (e && !tree.activeIds.has(e.id)) {
      messages[i]!.branch = 'abandoned';
      any = true;
    }
  }
  if (!any) return; // forked, but the abandoned branches hold no messages
  for (const fork of tree.forks) {
    const inFork: number[] = [];
    const lineSet = new Set(fork.lineIndexes);
    for (let i = 0; i < messages.length; i++) {
      if (lineSet.has(messageLines[i]!)) inFork.push(i);
    }
    // A fork whose branch produces no messages (e.g. a custom-only subtree) gets no
    // marker — there is no message to hang it on.
    if (!inFork.length) continue;
    const fromLine = entryById.get(fork.fromEntryId)?.lineIndex ?? 0;
    let before = -1;
    let after = -1;
    for (let i = 0; i < messages.length; i++) {
      const e = entryOf[i];
      if (!e || !tree.activeIds.has(e.id)) continue;
      if (messageLines[i]! <= fromLine) before = i;
      else {
        after = i;
        break;
      }
    }
    messages[inFork[0]!]!.fork = {
      // No active messages at all can't occur on the real corpus (the fork parent is
      // itself an active entry); the marker's own index is the defensive fallback.
      fromIndex: before >= 0 ? before : after >= 0 ? after : inFork[0]!,
      abandonedCount: inFork.length,
      firstUserText: fork.firstUserText,
      timestamp: fork.timestamp,
    };
  }
}

/** Thin projection of extractMessages — same messages, same numbering, no genuine flag. */
export function getSessionMessages(lines: string[]): SessionMessage[] {
  return extractMessages(lines).map(({ role, text, index, tools, branch, fork }) => ({
    role,
    text,
    index,
    tools,
    // Conditional spreads keep unbranched output free of the keys entirely (the same
    // no-op purity annotatePiBranches guarantees on ExtractedMessage).
    ...(branch ? { branch } : {}),
    ...(fork ? { fork } : {}),
  }));
}

/** Max length of each stored closing message (bounds the indexed columns). */
export const CLOSING_MAX = 500;

/**
 * Remove output-style "★ Insight" marker lines and their `──` fence lines while
 * keeping the body text, then collapse the blank runs they leave behind. This is
 * markup cleanup, not outcome detection — the body (often the useful part) stays.
 */
export function stripInsightFences(text: string): string {
  // Match only the literal output-style markup: a `★ Insight` marker line and
  // box-drawing `─` fence lines. Requiring the star and the `─` char (not ASCII
  // `-`) avoids eating a genuine markdown `-----` rule or a bare "Insight" line.
  const kept = text.split('\n').filter((l) => !/^\s*★\s*Insight\s*─*\s*$/.test(l) && !/^\s*─{5,}\s*$/.test(l));
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the prompt/closing columns from an extraction the index already needs
 * for message_fts. Keeping this as a projection avoids three additional full
 * transcript passes in the hot indexing path.
 */
export function summarizeMessages(messages: ExtractedMessage[]): MessageSummary {
  let first = '';
  let lastUser = '';
  let lastAssistant = '';

  for (const message of messages) {
    if (message.role === 'user' && message.genuine) {
      if (!first) first = message.text;
      lastUser = message.text;
    } else if (message.role === 'assistant') {
      lastAssistant = message.text;
    }
  }

  const finish = (text: string): string => {
    const stripped = stripInjected(text).trim();
    return stripped.length > CLOSING_MAX ? stripped.slice(0, CLOSING_MAX) : stripped;
  };

  return {
    firstPrompt: first ? clean(first) : '',
    closingUser: finish(lastUser),
    closingAssistant: finish(stripInsightFences(lastAssistant)),
  };
}

/**
 * Last user message and last assistant message from a session, stripped of
 * injected tags and truncated to CLOSING_MAX. Both roles are returned so the
 * synthesis layer (Phase 2) can decide what the open thread is — the last
 * assistant turn alone is often a question or tool call, not an outcome.
 */
export function closingMessages(lines: string[]): { user: string; assistant: string } {
  const summary = summarizeMessages(extractMessages(lines));
  return { user: summary.closingUser, assistant: summary.closingAssistant };
}

export function findMatchContext(lines: string[], query: string): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    const pos = text.toLowerCase().indexOf(query);
    if (pos >= 0) {
      const start = Math.max(0, pos - 30);
      const end = Math.min(text.length, pos + query.length + 70);
      let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < text.length) snippet = snippet + '…';
      return snippet;
    }
  }
  return '';
}
