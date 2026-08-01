import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { type Tool, type SessionResult } from './types';
import { extractSessionMetadata, getCwdFromSession, firstPrompt, contentMatches, findMatchContext } from './parser';
import { cwdUnder } from './repo';
import { discoverOpencodeSessions } from './opencode';
import { readSessionLines } from './session-io';
import { getPiSessionsDir } from './paths';

const home = homedir();
const CLAUDE_DIR = join(home, '.claude/projects');
const CODEX_DIR = join(home, '.codex/sessions');

async function processSession(
  filePath: string,
  tool: Tool,
  repoRoot: string,
  searchAll: boolean,
  searchQuery: string,
): Promise<SessionResult | null> {
  const lines = readSessionLines(filePath, tool);
  if (lines.length === 0) return null;

  // Reject on cwd BEFORE the full metadata pass: getCwdFromSession returns as soon as
  // it sees the cwd (first line for Claude, session_meta for Codex), while
  // extractSessionMetadata always parses the whole transcript. That gap is load-bearing
  // for Codex, whose sessions live in one flat tree with no slug to pre-filter on — so
  // scanDir opens every Codex transcript on the machine and `cwdUnder` rejects nearly
  // all of them. Measured on a 297-session Codex corpus scoped to one repo (4 kept):
  // 371ms when the metadata pass ran first, 92ms with this gate ahead of it.
  const cwd = getCwdFromSession(lines, tool);
  if (!cwd) return null;
  // Boundary-aware: a sibling sharing a prefix (e.g. `dotfiles-v2`) is not under `repoRoot`.
  if (!searchAll && !cwdUnder(cwd, repoRoot)) return null;
  if (cwd.includes('.claude/worktrees') || cwd.includes('/.bare')) return null;

  const metadata = extractSessionMetadata(lines, tool);
  const sessionId = basename(filePath).replace('.jsonl', '');

  if (searchQuery) {
    if (!contentMatches(lines, searchQuery)) return null;
    const displayText = findMatchContext(lines, searchQuery);
    return {
      date: metadata.date,
      createdAt: metadata.createdAt,
      cwd,
      tool,
      sessionId,
      displayText,
      customTitle: metadata.customTitle,
      messageCount: metadata.messageCount,
      filePath,
      exists: existsSync(cwd),
      files: [],
      commands: [],
      errored: false,
    };
  }

  const displayText = metadata.customTitle || firstPrompt(lines, tool);
  return {
    date: metadata.date,
    createdAt: metadata.createdAt,
    cwd,
    tool,
    sessionId,
    displayText,
    customTitle: metadata.customTitle,
    messageCount: metadata.messageCount,
    filePath,
    exists: existsSync(cwd),
    files: [],
    commands: [],
    errored: false,
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
    // Resolved per call (not frozen at import) via the shared resolver so the
    // scanner honors the same SESSIONS_PI_DIR / PI_CODING_AGENT_* overrides as
    // the index and the report.
    scans.push(scanDir(getPiSessionsDir(), piPrefix, 'pi', repoRoot, searchAll, normalizedQuery));
  }
  if (toolFilter === '' || toolFilter === 'codex') {
    scans.push(scanDir(CODEX_DIR, '', 'codex', repoRoot, searchAll, normalizedQuery));
  }
  if (toolFilter === '' || toolFilter === 'opencode') {
    scans.push(scanOpencode(repoRoot, searchAll, normalizedQuery));
  }

  const all = (await Promise.all(scans)).flat();
  all.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return all;
}

/** No-index fallback for OpenCode: reconstruct each top-level session from the DB, then filter as usual. */
async function scanOpencode(repoRoot: string, searchAll: boolean, searchQuery: string): Promise<SessionResult[]> {
  const results: SessionResult[] = [];
  for (const s of discoverOpencodeSessions()) {
    const r = await processSession(s.path, 'opencode', repoRoot, searchAll, searchQuery);
    if (r) results.push(r);
  }
  return results;
}
