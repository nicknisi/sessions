import { type Tool } from './types';

interface JsonLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  promptSource?: string | null;
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

export function getCwdFromSession(lines: string[], tool: Tool): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (tool === 'claude') {
      if (d.cwd) return d.cwd;
    } else if (tool === 'pi') {
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
 * carries no git metadata, so it returns ''.
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
  return ''; // pi: no git metadata in logs
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function stripInjected(text: string): string {
  const patterns = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
    /<command-name>[\s\S]*?<\/command-name>/g,
    /<command-message>[\s\S]*?<\/command-message>/g,
    /<command-args>[\s\S]*?<\/command-args>/g,
  ];
  for (const p of patterns) {
    text = text.replace(p, '');
  }
  return text;
}

function extractUserText(d: JsonLine): string {
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

function isUserMessage(d: JsonLine): boolean {
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
 * system-injected turn, or a skill body injected as a user message.
 * Claude lines carry `promptSource`: when the field is present, only `typed`
 * and `queued` count (a present-but-null value, as tool results and skill loads
 * have, is rejected). Older logs and pi/codex have no `promptSource`, so fall
 * back to a heuristic: non-empty text that isn't a skill-injection preamble.
 */
function isGenuineUserTurn(d: JsonLine, strippedText: string): boolean {
  if ('promptSource' in d) {
    return d.promptSource === 'typed' || d.promptSource === 'queued';
  }
  if (!strippedText) return false;
  if (SKILL_INJECTION_PREAMBLE.test(strippedText)) return false;
  return true;
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

export function lastTimestamp(content: string): string {
  const lines = content.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
    const d = tryParseJson(lines[i]!);
    if (!d) continue;
    const ts = d.timestamp as string | undefined;
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  for (const line of lines) {
    const d = tryParseJson(line);
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

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  index: number;
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

export function getSessionMessages(lines: string[]): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let idx = 0;
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (isUserMessage(d)) {
      const text = extractUserText(d);
      if (text.trim()) messages.push({ role: 'user', text, index: idx++ });
    } else {
      const text = extractAssistantText(d);
      if (text.trim()) messages.push({ role: 'assistant', text, index: idx++ });
    }
  }
  return messages;
}

/** Max length of each stored closing message (bounds the indexed columns). */
export const CLOSING_MAX = 500;

/**
 * Last user message and last assistant message from a session, stripped of
 * injected tags and truncated to CLOSING_MAX. Both roles are returned so the
 * synthesis layer (Phase 2) can decide what the open thread is — the last
 * assistant turn alone is often a question or tool call, not an outcome.
 */
export function closingMessages(lines: string[], tool: Tool): { user: string; assistant: string } {
  const genuineUsers = genuineUserTexts(lines, tool);
  const user = genuineUsers.length ? genuineUsers[genuineUsers.length - 1]! : '';

  const messages = getSessionMessages(lines);
  let assistant = '';
  for (let i = messages.length - 1; i >= 0 && !assistant; i--) {
    if (messages[i]!.role === 'assistant') assistant = messages[i]!.text;
  }

  const finish = (t: string): string => {
    const stripped = stripInjected(t).trim();
    return stripped.length > CLOSING_MAX ? stripped.slice(0, CLOSING_MAX) : stripped;
  };
  return { user: finish(user), assistant: finish(assistant) };
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
