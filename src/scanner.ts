import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { type Tool, type SessionResult } from './types';
import { getCwdFromSession, firstPrompt, lastTimestamp, contentMatches, findMatchContext } from './parser';

const home = homedir();
const CLAUDE_DIR = join(home, '.claude/projects');
const PI_DIR = join(home, '.pi/agent/sessions');
const CODEX_DIR = join(home, '.codex/sessions');

async function readLines(filePath: string): Promise<{ lines: string[]; raw: string }> {
  try {
    const raw = await Bun.file(filePath).text();
    return { lines: raw.trimEnd().split('\n'), raw };
  } catch {
    return { lines: [], raw: '' };
  }
}

async function processSession(
  filePath: string,
  tool: Tool,
  repoRoot: string,
  searchAll: boolean,
  searchQuery: string,
): Promise<SessionResult | null> {
  const { lines, raw } = await readLines(filePath);
  if (lines.length === 0) return null;

  const cwd = getCwdFromSession(lines, tool);
  if (!cwd) return null;
  if (!searchAll && !cwd.startsWith(repoRoot)) return null;
  if (cwd.includes('.claude/worktrees') || cwd.includes('/.bare')) return null;

  const sessionId = basename(filePath).replace('.jsonl', '');

  if (searchQuery) {
    if (!contentMatches(lines, searchQuery)) return null;
    const displayText = findMatchContext(lines, searchQuery);
    const date = lastTimestamp(raw);
    return { date, cwd, tool, sessionId, displayText, filePath, exists: existsSync(cwd) };
  }

  const displayText = firstPrompt(lines, tool);
  const date = lastTimestamp(raw);
  return { date, cwd, tool, sessionId, displayText, filePath, exists: existsSync(cwd) };
}

async function scanDir(
  sessionDir: string,
  prefix: string,
  tool: Tool,
  repoRoot: string,
  searchAll: boolean,
  searchQuery: string,
): Promise<SessionResult[]> {
  if (!existsSync(sessionDir)) return [];
  const results: SessionResult[] = [];

  if (tool === 'codex') {
    const glob = new Bun.Glob('**/*.jsonl');
    for await (const path of glob.scan(sessionDir)) {
      const r = await processSession(join(sessionDir, path), tool, repoRoot, searchAll, searchQuery);
      if (r) results.push(r);
    }
  } else {
    let dirs: string[];
    try {
      dirs = await readdir(sessionDir);
    } catch {
      return [];
    }
    for (const dirname of dirs) {
      if (!searchAll && !dirname.startsWith(prefix)) continue;
      const dirpath = join(sessionDir, dirname);
      const glob = new Bun.Glob('*.jsonl');
      for await (const path of glob.scan(dirpath)) {
        const r = await processSession(join(dirpath, path), tool, repoRoot, searchAll, searchQuery);
        if (r) results.push(r);
      }
    }
  }

  return results;
}

export async function scanSessions(
  repoRoot: string,
  toolFilter: Tool | '',
  searchQuery: string,
): Promise<SessionResult[]> {
  const searchAll = repoRoot === '';
  const claudePrefix = repoRoot ? repoRoot.replaceAll('/', '-') : '';
  const normalizedQuery = searchQuery.toLowerCase();

  const scans: Promise<SessionResult[]>[] = [];

  if (toolFilter === '' || toolFilter === 'claude') {
    scans.push(scanDir(CLAUDE_DIR, claudePrefix, 'claude', repoRoot, searchAll, normalizedQuery));
  }
  if (toolFilter === '' || toolFilter === 'pi') {
    const piPrefix = repoRoot ? `-${claudePrefix}-` : '--';
    scans.push(scanDir(PI_DIR, piPrefix, 'pi', repoRoot, searchAll, normalizedQuery));
  }
  if (toolFilter === '' || toolFilter === 'codex') {
    scans.push(scanDir(CODEX_DIR, '', 'codex', repoRoot, searchAll, normalizedQuery));
  }

  const all = (await Promise.all(scans)).flat();
  all.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return all;
}
