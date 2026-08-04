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
  const msgs = r.messageCount > 0 ? `${C.dim}${r.messageCount}msg${C.reset}` : '';

  const maxPrompt = Math.max(20, cols - 50);
  const truncated = prompt.length > maxPrompt ? prompt.slice(0, maxPrompt - 1) + '…' : prompt;

  const warn = r.errored ? `${C.red}⚠${C.reset} ` : '';

  // The prompt already is the top message-hit snippet when search localized one;
  // the badge names which message it came from (fzf shows one line per entry, so
  // the index rides inline rather than on an indented second line).
  const hit = r.messageHits?.[0];
  const hitBadge = hit ? `${C.dim}msg#${hit.index}${C.reset} ` : '';

  // Pi /tree fork count. Like the other badges it lives in the display field BEFORE
  // the prompt: the prompt is the only truncated element, so the badge survives
  // narrow terminals rather than being squeezed out by a long prompt.
  const forkBadge = r.branches > 0 ? `${C.dim}⑂${r.branches}${C.reset} ` : '';

  const display = `${dot} ${C.bold}${dirName}${C.reset}  ${toolBadge}  ${C.dim}${rel}${C.reset}  ${msgs ? msgs + '  ' : ''}${warn}${hitBadge}${forkBadge}${truncated}`;

  // tab-separated: cwd, tool, sessionId, exists, prompt, display
  return `${r.cwd}\t${r.tool}\t${r.sessionId}\t${r.exists ? 'exists' : 'deleted'}\t${prompt}\t${display}`;
}

/**
 * The session-detail lineage line: the /fork parent (BASENAME only — the stored path
 * is deliberately unresolved; the parent file may not exist on disk and no DB join
 * happens here) plus the in-file fork count. '' when the session has no lineage to
 * show, so the caller skips the line entirely.
 */
export function formatLineage(r: SessionResult): string {
  const parts: string[] = [];
  if (r.forkedFrom) parts.push(`Forked from ${basename(r.forkedFrom)}`);
  if (r.branches > 0) parts.push(`${r.branches} in-file fork${r.branches === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
