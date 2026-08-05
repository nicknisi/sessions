import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { C, toolColor } from './colors';
import { type Tool } from './types';
import { getSessionMessages } from './parser';
import { readSessionLines } from './session-io';
import { isOpencodePath } from './opencode';
import { getPiSessionsDir } from './paths';

/**
 * Infer the tool from a session file path. The selector TSV now carries filePath,
 * so the preview subcommand gets a path with no tool tag and must recover it from
 * which session root the path lives under — same roots the scanner indexes.
 */
function toolFromPath(filePath: string): Tool | null {
  if (isOpencodePath(filePath)) return 'opencode';
  const home = homedir();
  const claudeDir = process.env.SESSIONS_CLAUDE_DIR || join(home, '.claude/projects');
  const codexDir = process.env.SESSIONS_CODEX_DIR || join(home, '.codex/sessions');
  const piDir = getPiSessionsDir();
  const dir = dirname(filePath);
  if (dir.startsWith(claudeDir)) return 'claude';
  if (dir.startsWith(codexDir)) return 'codex';
  if (dir.startsWith(piDir)) return 'pi';
  return null;
}

/** Wrap text to a width, preserving words. Blank lines kept as empty strings. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const PREVIEW_LIMIT = 40; // cap messages so giant transcripts don't flood the pane
const PREVIEW_WIDTH = 78; // fzf wraps the pane anyway; this keeps role labels aligned

/** Render a session transcript as a compact, read-only conversation preview. */
export function renderPreview(filePath: string): string {
  const tool = toolFromPath(filePath);
  if (!tool) return `${C.dim}(unrecognized session path)${C.reset}`;
  const lines = readSessionLines(filePath, tool);
  if (lines.length === 0) return `${C.dim}(empty or unreadable session)${C.reset}`;

  const messages = getSessionMessages(lines);
  if (messages.length === 0) return `${C.dim}(no messages parsed)${C.reset}`;

  const start = Math.max(0, messages.length - PREVIEW_LIMIT);
  const page = messages.slice(start);

  const out: string[] = [];
  const tc = toolColor[tool] ?? '';
  out.push(
    `${C.bold}${tc}${tool}${C.reset} ${C.dim}· ${messages.length} message${messages.length === 1 ? '' : 's'}${C.reset}${start > 0 ? ` ${C.dim}(showing last ${page.length})${C.reset}` : ''}`,
  );
  out.push(`${C.dim}${filePath}${C.reset}`);
  out.push('');

  // Indent leaves room for a 2-char branch marker + "you "/"ai  " label.
  const bodyWidth = PREVIEW_WIDTH - 6;

  for (const m of page) {
    const isUser = m.role === 'user';
    const label = isUser ? `${C.bold}you ${C.reset}` : `${C.cyan}ai  ${C.reset}`;
    const prefix = m.branch === 'abandoned' ? `${C.dim}⑂${C.reset} ` : ' ';
    const trimmed = m.text.length > 600 ? m.text.slice(0, 599) + '…' : m.text;
    const rows = wrap(trimmed, bodyWidth);
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      out.push(`${prefix}${label}${rows[i]}`);
    }
    if (rows.length > 12) out.push(`${prefix}${C.dim}…${C.reset}`);
  }

  return out.join('\n');
}
