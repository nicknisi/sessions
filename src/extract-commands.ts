import type { Tool } from './types';
import { tryParse, opencodeAssistantBlocks, toolInput, asJsonObject, asJsonString, jsonStrings } from './extract-util';

/** Upper bound on stored distinct commands per session (bounds the indexed column). */
export const MAX_COMMANDS = 100;

// Claude: assistant `message.content[]` tool_use named `Bash` → `input.command`.
function extractClaude(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'assistant') continue;
    const msg = asJsonObject(d.message);
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asJsonObject(block);
      if (!b) continue;
      if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
      const cmd = asJsonString(asJsonObject(b.input)?.command);
      if (cmd?.trim()) push(cmd.trim());
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
    const p = asJsonObject(d.payload);
    if (!p || p.type !== 'exec_command_end') continue;
    const cmd = p.command;
    const cmdString = asJsonString(cmd);
    if (cmdString?.trim()) {
      push(cmdString.trim());
    } else if (Array.isArray(cmd)) {
      const joined = jsonStrings(cmd).join(' ').trim();
      if (joined) push(joined);
    }
  }
}

// Pi: the dedicated `bashExecution` channel, plus a `bash` toolCall block.
function extractPi(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = asJsonObject(d.message);
    if (!msg) continue;
    if (msg.role === 'bashExecution') {
      const cmd = asJsonString(msg.command);
      if (cmd?.trim()) push(cmd.trim());
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asJsonObject(block);
      if (!b) continue;
      if (b.type !== 'toolCall' || b.name !== 'bash') continue;
      const cmd = asJsonString(asJsonObject(b.arguments)?.command);
      if (cmd?.trim()) push(cmd.trim());
    }
  }
}

// OpenCode: the `bash` tool block's `state.input.command`.
function extractOpencode(lines: string[], push: (c: string) => void): void {
  for (const block of opencodeAssistantBlocks(lines)) {
    if (block.type !== 'tool' || block.tool !== 'bash') continue;
    const cmd = asJsonString(toolInput(block).command);
    if (cmd?.trim()) push(cmd.trim());
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
  else if (tool === 'opencode') extractOpencode(lines, push);
  return out;
}
