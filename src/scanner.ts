import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { type Tool, type SessionResult } from './types';
import {
  getCwdFromSession,
  firstPrompt,
  lastTimestamp,
  contentMatches,
  findMatchContext,
  customTitle,
  firstTimestamp,
  messageCount,
} from './parser';
import { cwdUnder } from './repo';

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
  // Boundary-aware: a sibling sharing a prefix (e.g. `dotfiles-v2`) is not under `repoRoot`.
  if (!searchAll && !cwdUnder(cwd, repoRoot)) return null;
  if (cwd.includes('.claude/worktrees') || cwd.includes('/.bare')) return null;

  const sessionId = basename(filePath).replace('.jsonl', '');

  const date = lastTimestamp(raw);
  const createdAt = firstTimestamp(lines);
  const title = customTitle(lines);
  const msgCount = messageCount(lines);

  if (searchQuery) {
    if (!contentMatches(lines, searchQuery)) return null;
    const displayText = findMatchContext(lines, searchQuery);
    return {
      date,
      createdAt,
      cwd,
      tool,
      sessionId,
      displayText,
      customTitle: title,
      messageCount: msgCount,
      filePath,
      exists: existsSync(cwd),
    };
  }

  const displayText = title || firstPrompt(lines, tool);
  return {
    date,
    createdAt,
    cwd,
    tool,
    sessionId,
    displayText,
    customTitle: title,
    messageCount: msgCount,
    filePath,
    exists: existsSync(cwd),
  };
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
      // Cheap loose pre-filter on the encoded slug — intentionally permissive so it
      // never skips a real descendant/worktree dir (the slug separator is ambiguous
      // here). The precise, boundary-aware cwd check in processSession (`cwdUnder`)
      // is what actually excludes siblings like `dotfiles-v2`; this is only an
      // optimization to avoid opening clearly-unrelated project dirs.
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
