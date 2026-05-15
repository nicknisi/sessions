import { type Tool } from './types';

interface JsonLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
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

export function firstPrompt(lines: string[], tool: Tool): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (tool === 'claude' && d.type === 'user') {
      const msg = d.message;
      if (!msg || typeof msg !== 'object') continue;
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const x of content) {
          if (typeof x === 'object' && x !== null && (x as Record<string, string>).type === 'text') {
            return clean(stripInjected((x as Record<string, string>).text ?? ''));
          }
        }
      } else if (typeof content === 'string') {
        return clean(stripInjected(content));
      }
    } else if ((tool === 'pi' || tool === 'codex') && d.type === 'message') {
      const msg = d.message;
      if (typeof msg !== 'object' || msg === null) continue;
      if ((msg as Record<string, unknown>).role !== 'user') continue;
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const x of content) {
          if (
            typeof x === 'object' &&
            x !== null &&
            ((x as Record<string, string>).type === 'text' || (x as Record<string, string>).type === 'input_text')
          ) {
            return clean(stripInjected((x as Record<string, string>).text ?? ''));
          }
        }
      } else if (typeof content === 'string') {
        return clean(stripInjected(content));
      }
    }
  }
  return '';
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
