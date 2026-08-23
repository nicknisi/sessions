import type { Tool } from './types';
import {
  tryParse,
  opencodeAssistantBlocks,
  asJsonObject,
  asJsonString,
  asJsonNumber,
  type JsonValue,
} from './extract-util';

export const MAX_ERROR_MESSAGES = 20;
export const MAX_ERROR_LEN = 300;

export interface SessionErrors {
  errored: boolean;
  count: number;
  messages: string[];
}

function textOf(content: JsonValue | undefined): string {
  const text = asJsonString(content);
  if (text !== undefined) return text;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = asJsonObject(c);
        return block ? (asJsonString(block.text) ?? '') : '';
      })
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
      push(textOf(asJsonObject(d.message)?.content) || 'api error');
      continue;
    }
    if (d.type !== 'user') continue;
    const content = asJsonObject(d.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asJsonObject(block);
      if (!b) continue;
      if (b.type === 'tool_result' && b.is_error === true) push(textOf(b.content) || 'tool error');
    }
  }
}

function extractCodex(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const p = asJsonObject(d.payload);
    if (!p) continue;
    const exitCode = asJsonNumber(p.exit_code);
    if (p.type === 'exec_command_end' && exitCode !== undefined && exitCode !== 0) {
      push(textOf(p.stderr) || textOf(p.formatted_output) || `exit ${exitCode}`);
    } else if (p.type === 'error') {
      push(textOf(p.message) || 'error');
    }
  }
}

function extractPi(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = asJsonObject(d.message);
    if (!msg) continue;
    if (msg.role === 'toolResult' && msg.isError === true) push(textOf(msg.content) || 'tool error');
    else if (msg.role === 'assistant') {
      const errorMessage = asJsonString(msg.errorMessage);
      if (errorMessage) push(errorMessage);
    } else if (msg.role === 'bashExecution') {
      const exitCode = asJsonNumber(msg.exitCode);
      if (exitCode !== undefined && exitCode !== 0) push(textOf(msg.output) || `exit ${exitCode}`);
    }
  }
}

// OpenCode: a tool block whose `state.status` is 'error' — the message is `state.error`.
function extractOpencode(lines: string[], push: (m: string) => void): void {
  for (const block of opencodeAssistantBlocks(lines)) {
    if (block.type !== 'tool') continue;
    const state = asJsonObject(block.state);
    if (!state || state.status !== 'error') continue;
    const msg = asJsonString(state.error) ?? '';
    push(msg || `${asJsonString(block.tool) ?? 'tool'} error`);
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
  else if (tool === 'opencode') extractOpencode(lines, push);
  return { errored: count > 0, count, messages };
}
