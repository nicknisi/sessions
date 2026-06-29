import type { Tool } from './types';
import { tryParse } from './extract-util';

export const MAX_ERROR_MESSAGES = 20;
export const MAX_ERROR_LEN = 300;

export interface SessionErrors {
  errored: boolean;
  count: number;
  messages: string[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string'
          ? (c as Record<string, string>).text
          : '',
      )
      .join(' ')
      .trim();
  }
  return '';
}

function extractClaude(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    if (d.isApiErrorMessage) {
      push(textOf((d.message as Record<string, unknown> | undefined)?.content) || 'api error');
      continue;
    }
    if (d.type !== 'user') continue;
    const content = (d.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && b.is_error === true) push(textOf(b.content) || 'tool error');
    }
  }
}

function extractCodex(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const p = d.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    if (p.type === 'exec_command_end' && typeof p.exit_code === 'number' && p.exit_code !== 0) {
      push(textOf(p.stderr) || textOf(p.formatted_output) || `exit ${p.exit_code}`);
    } else if (p.type === 'error') {
      push(textOf(p.message) || 'error');
    }
  }
}

function extractPi(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (msg.role === 'toolResult' && msg.isError === true) push(textOf(msg.content) || 'tool error');
    else if (msg.role === 'assistant' && typeof msg.errorMessage === 'string' && msg.errorMessage)
      push(msg.errorMessage);
    else if (msg.role === 'bashExecution' && typeof msg.exitCode === 'number' && msg.exitCode !== 0)
      push(textOf(msg.output) || `exit ${msg.exitCode}`);
  }
}

/** Whether (and how) a session hit errors — drives the `errored` filter + `context_text` FTS column. */
export function extractErrors(lines: string[], tool: Tool): SessionErrors {
  const messages: string[] = [];
  let count = 0;
  const push = (m: string): void => {
    count++;
    if (messages.length < MAX_ERROR_MESSAGES) messages.push(m.slice(0, MAX_ERROR_LEN));
  };
  if (tool === 'claude') extractClaude(lines, push);
  else if (tool === 'codex') extractCodex(lines, push);
  else if (tool === 'pi') extractPi(lines, push);
  return { errored: count > 0, count, messages };
}
