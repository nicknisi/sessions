import { basename } from 'node:path';
import { C, toolColor } from './colors';
import { type SessionResult } from './types';

function relativeDate(isoDate: string): string {
  try {
    const d = new Date(isoDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const delta = Math.floor((today.getTime() - d.getTime()) / 86400000);
    if (delta <= 0) return 'today';
    if (delta === 1) return 'yesterday';
    if (delta < 7) return `${delta}d`;
    if (delta < 30) return `${Math.floor(delta / 7)}w`;
    return isoDate;
  } catch {
    return isoDate;
  }
}

export function formatLine(r: SessionResult, cols: number): string {
  const dirName = basename(r.cwd) || '(root)';
  const prompt = r.displayText || '(no prompt)';

  const dotColor = r.exists ? C.green : C.red;
  const dot = r.exists ? `${dotColor}●${C.reset}` : `${dotColor}○${C.reset}`;
  const tc = toolColor[r.tool] ?? '';
  const toolBadge = `${tc}${r.tool}${C.reset}`;
  const rel = relativeDate(r.date);

  const maxPrompt = Math.max(20, cols - 40);
  const truncated = prompt.length > maxPrompt ? prompt.slice(0, maxPrompt - 1) + '…' : prompt;

  const display = `${dot} ${C.bold}${dirName}${C.reset}  ${toolBadge}  ${C.dim}${rel}${C.reset}  ${truncated}`;

  // tab-separated: cwd, tool, sessionId, exists, prompt, display
  return `${r.cwd}\t${r.tool}\t${r.sessionId}\t${r.exists ? 'exists' : 'deleted'}\t${prompt}\t${display}`;
}
