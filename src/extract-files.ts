import type { Tool } from './types';
import { tryParse, opencodeAssistantBlocks, toolInput, asJsonObject, asJsonString, jsonStrings } from './extract-util';

/** Upper bound on stored edited-file paths per session (bounds the indexed column). */
export const MAX_FILES = 50;

/** Claude: assistant `message.content[]` tool_use blocks for the file-editing tools. */
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function extractClaude(lines: string[], push: (p: string) => void): void {
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
      const name = asJsonString(b.name);
      if (b.type !== 'tool_use' || name === undefined || !CLAUDE_EDIT_TOOLS.has(name)) continue;
      const inp = asJsonObject(b.input);
      if (!inp) continue;
      const path = asJsonString(name === 'NotebookEdit' ? inp.notebook_path : inp.file_path);
      if (path) push(path);
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
    const p = asJsonObject(d.payload);
    if (!p || p.type !== 'custom_tool_call' || p.name !== 'apply_patch') continue;
    const input = asJsonString(p.input);
    if (input === undefined) continue;
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

/**
 * OpenCode: edited files surface three ways in a synthesized assistant message —
 * `patch` blocks (an authoritative `files[]` list), `edit`/`write` tool blocks
 * (`state.input.filePath`), and `apply_patch` tool blocks whose `state.input.patchText`
 * carries the same `*** … File:` headers as Codex. Shape confirmed against opencode.db.
 */
function extractOpencode(lines: string[], push: (p: string) => void): void {
  for (const block of opencodeAssistantBlocks(lines)) {
    if (block.type === 'patch' && Array.isArray(block.files)) {
      for (const f of jsonStrings(block.files)) if (f) push(f);
      continue;
    }
    if (block.type !== 'tool') continue;
    const input = toolInput(block);
    const filePath = asJsonString(input.filePath);
    if ((block.tool === 'edit' || block.tool === 'write') && filePath) {
      push(filePath);
    } else if (block.tool === 'apply_patch') {
      const patchText = asJsonString(input.patchText);
      if (patchText === undefined) continue;
      for (const patchLine of patchText.split('\n')) {
        const m = PATCH_HEADER.exec(patchLine.trim());
        if (m && m[1]) push(m[1].trim());
      }
    }
  }
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
  else if (tool === 'opencode') extractOpencode(lines, push);

  return out;
}

/** Claude: read-only tool_use targets (Read/Grep/Glob), kept separate from edits. */
const CLAUDE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function extractClaudeRead(lines: string[], push: (p: string) => void): void {
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
      const name = asJsonString(b.name);
      if (b.type !== 'tool_use' || name === undefined || !CLAUDE_READ_TOOLS.has(name)) continue;
      const input = asJsonObject(b.input);
      const path = asJsonString(input?.file_path ?? input?.path ?? input?.pattern);
      if (path) push(path);
    }
  }
}

/**
 * Read/searched (not edited) file targets, for the searchable `paths` column.
 * Codex/Pi read-target shapes need fixtures to confirm — deliberate no-op until
 * then, mirroring the edited-files Pi no-op.
 */
export function extractFilesRead(lines: string[], tool: Tool): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (path: string): void => {
    if (seen.has(path) || out.length >= MAX_FILES) return;
    seen.add(path);
    out.push(path);
  };
  if (tool === 'claude') extractClaudeRead(lines, push);
  else if (tool === 'opencode') extractOpencodeRead(lines, push);
  return out;
}

/** OpenCode: read/searched targets — `read` tool `filePath`, `grep`/`glob` `path`/`pattern`. */
function extractOpencodeRead(lines: string[], push: (p: string) => void): void {
  for (const block of opencodeAssistantBlocks(lines)) {
    if (block.type !== 'tool') continue;
    const input = toolInput(block);
    const path =
      block.tool === 'read'
        ? input.filePath
        : block.tool === 'grep' || block.tool === 'glob' || block.tool === 'list'
          ? (input.path ?? input.pattern)
          : undefined;
    const target = asJsonString(path);
    if (target) push(target);
  }
}
