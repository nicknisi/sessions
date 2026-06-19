import type { Tool } from './types';

/** Upper bound on stored edited-file paths per session (bounds the indexed column). */
export const MAX_FILES = 50;

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Claude: assistant `message.content[]` tool_use blocks for the file-editing tools. */
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function extractClaude(lines: string[], push: (p: string) => void): void {
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
      if (b.type !== 'tool_use' || typeof b.name !== 'string' || !CLAUDE_EDIT_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;
      const path = b.name === 'NotebookEdit' ? inp.notebook_path : inp.file_path;
      if (typeof path === 'string' && path) push(path);
    }
  }
}

/**
 * Codex: file edits surface as `response_item` records whose `payload` is a
 * `custom_tool_call` named `apply_patch`, with `payload.input` holding the patch
 * text. Paths come from the `*** Add File:` / `*** Update File:` / `*** Delete File:`
 * headers. Shape confirmed against real `~/.codex/sessions` logs.
 */
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;

function extractCodex(lines: string[], push: (p: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const payload = d.payload;
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if (p.type !== 'custom_tool_call' || p.name !== 'apply_patch') continue;
    const input = p.input;
    if (typeof input !== 'string') continue;
    for (const patchLine of input.split('\n')) {
      const m = PATCH_HEADER.exec(patchLine.trim());
      if (m && m[1]) push(m[1].trim());
    }
  }
}

/**
 * Pi: edited-file shape needs real captured logs to reverse-engineer. No Pi
 * session with file edits exists in `~/.pi/agent/sessions` to confirm the
 * tool-call envelope, so this branch is a deliberate no-op per the spec's Open
 * Items (returns `[]` until fixtures land). TODO: implement against real logs.
 */
function extractPi(_lines: string[], _push: (p: string) => void): void {
  // Intentionally empty — see doc comment above.
}

/** De-duplicated, order-preserving, capped list of source-file paths edited during a session. */
export function extractFiles(lines: string[], tool: Tool): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (path: string): void => {
    if (seen.has(path) || out.length >= MAX_FILES) return;
    seen.add(path);
    out.push(path);
  };

  if (tool === 'claude') extractClaude(lines, push);
  else if (tool === 'codex') extractCodex(lines, push);
  else if (tool === 'pi') extractPi(lines, push);

  return out;
}
