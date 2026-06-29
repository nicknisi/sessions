import type { Tool } from './types';
import { tryParse } from './extract-util';

/** Upper bound on stored distinct commands per session (bounds the indexed column). */
export const MAX_COMMANDS = 100;

// Claude: assistant `message.content[]` tool_use named `Bash` → `input.command`.
function extractClaude(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
      const input = b.input as Record<string, unknown> | undefined;
      const cmd = input?.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    }
  }
}

// Codex: read the canonical `exec_command_end.command` only. The same exec also
// appears as a `response_item` `function_call`; reading a single source is the
// de-duplication (the shared seen-set also collapses identical repeats).
function extractCodex(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const p = d.payload as Record<string, unknown> | undefined;
    if (!p || p.type !== 'exec_command_end') continue;
    const cmd = p.command;
    if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    else if (Array.isArray(cmd)) {
      const joined = cmd
        .filter((x) => typeof x === 'string')
        .join(' ')
        .trim();
      if (joined) push(joined);
    }
  }
}

// Pi: the dedicated `bashExecution` channel, plus a `bash` toolCall block.
function extractPi(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'bashExecution') {
      const cmd = msg.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'toolCall' || b.name !== 'bash') continue;
      const argsObj = b.arguments as Record<string, unknown> | undefined;
      const cmd = argsObj?.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    }
  }
}

/** De-duplicated, order-preserving, capped list of shell commands run in a session. */
export function extractCommands(lines: string[], tool: Tool): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (c: string): void => {
    if (seen.has(c) || out.length >= MAX_COMMANDS) return;
    seen.add(c);
    out.push(c);
  };
  if (tool === 'claude') extractClaude(lines, push);
  else if (tool === 'codex') extractCodex(lines, push);
  else if (tool === 'pi') extractPi(lines, push);
  return out;
}
