import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from './parsers/types.ts';
import type { ToolId } from './types.ts';
import { parseClaudeCode } from './parsers/claude-code.ts';
import { parsePi } from './parsers/pi.ts';
import { parseCodex } from './parsers/codex.ts';

export interface ReportRoots {
  claudeCode: string;
  pi: string;
  codex: string;
}

export function defaultRoots(): ReportRoots {
  const home = homedir();
  return {
    claudeCode: join(home, '.claude', 'projects'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    codex: join(home, '.codex', 'sessions'),
  };
}

export async function gatherEvents(roots: ReportRoots = defaultRoots(), tools?: Set<ToolId>): Promise<UsageEvent[]> {
  const want = (t: ToolId): boolean => !tools || tools.has(t);
  const tasks: Promise<UsageEvent[]>[] = [];
  if (want('claude-code')) tasks.push(parseClaudeCode(roots.claudeCode));
  if (want('pi')) tasks.push(parsePi(roots.pi));
  if (want('codex')) tasks.push(parseCodex(roots.codex));
  const results = await Promise.all(tasks);
  return results.flat();
}
