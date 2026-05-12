import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { type Tool, type SessionResult } from './types';
import { getCwdFromSession, firstPrompt, lastTimestamp, getSessionMessages } from './parser';

const CACHE_DIR = join(homedir(), '.cache', 'sessions');
const DB_PATH = join(CACHE_DIR, 'index.db');

const home = homedir();
const CLAUDE_DIR = join(home, '.claude/projects');
const PI_DIR = join(home, '.pi/agent/sessions');
const CODEX_DIR = join(home, '.codex/sessions');

let _db: Database | null = null;

export function clearCache(): void {
  const files = [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm'];
  let cleared = false;
  for (const f of files) {
    try { require('node:fs').unlinkSync(f); cleared = true; } catch {}
  }
  process.stderr.write(cleared ? 'Cache cleared. It will rebuild on next use.\n' : 'No cache to clear.\n');
}

function getDb(): Database {
  if (_db) return _db;
  mkdirSync(CACHE_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      first_prompt TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      user_content
    )
  `);
  _db = db;
  return db;
}

interface FileEntry {
  path: string;
  tool: Tool;
}

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  if (existsSync(CLAUDE_DIR)) {
    let dirs: string[];
    try { dirs = await readdir(CLAUDE_DIR); } catch { dirs = []; }
    for (const dirname of dirs) {
      const dirpath = join(CLAUDE_DIR, dirname);
      const glob = new Bun.Glob('*.jsonl');
      for await (const p of glob.scan(dirpath)) {
        entries.push({ path: join(dirpath, p), tool: 'claude' });
      }
    }
  }

  if (existsSync(PI_DIR)) {
    let dirs: string[];
    try { dirs = await readdir(PI_DIR); } catch { dirs = []; }
    for (const dirname of dirs) {
      const dirpath = join(PI_DIR, dirname);
      const glob = new Bun.Glob('*.jsonl');
      for await (const p of glob.scan(dirpath)) {
        entries.push({ path: join(dirpath, p), tool: 'pi' });
      }
    }
  }

  if (existsSync(CODEX_DIR)) {
    const glob = new Bun.Glob('**/*.jsonl');
    for await (const p of glob.scan(CODEX_DIR)) {
      entries.push({ path: join(CODEX_DIR, p), tool: 'codex' });
    }
  }

  return entries;
}

function indexFile(db: Database, filePath: string, tool: Tool): boolean {
  let stat;
  try { stat = statSync(filePath); } catch { return false; }

  const existing = db.query<{ mtime: number; size: number }, [string]>(
    'SELECT mtime, size FROM sessions WHERE file_path = ?'
  ).get(filePath);

  if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
    return false;
  }

  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return false; }
  const lines = raw.trimEnd().split('\n');
  if (lines.length === 0) return false;

  const cwd = getCwdFromSession(lines, tool);
  if (!cwd) return false;
  if (cwd.includes('.claude/worktrees') || cwd.includes('/.bare')) return false;

  const sessionId = basename(filePath).replace('.jsonl', '');
  const prompt = firstPrompt(lines, tool);
  const date = lastTimestamp(raw);

  const messages = getSessionMessages(lines);
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('\n');

  if (existing) {
    db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
  }
  db.run(
    `INSERT OR REPLACE INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, first_prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [filePath, stat.mtimeMs, stat.size, cwd, tool, sessionId, date, prompt]
  );
  db.run(
    'INSERT INTO session_fts (file_path, user_content) VALUES (?, ?)',
    [filePath, userContent]
  );
  return true;
}

export async function refreshIndex(): Promise<{ total: number; updated: number }> {
  const db = getDb();
  const files = await discoverFiles();
  const filePaths = new Set(files.map((f) => f.path));

  const dbPaths = db.query<{ file_path: string }, []>('SELECT file_path FROM sessions').all();
  const removedPaths = dbPaths.filter((r) => !filePaths.has(r.file_path));
  if (removedPaths.length > 0) {
    for (const r of removedPaths) {
      db.run('DELETE FROM sessions WHERE file_path = ?', [r.file_path]);
      db.run('DELETE FROM session_fts WHERE file_path = ?', [r.file_path]);
    }
    if (removedPaths.length > 100) {
      db.exec('VACUUM');
    }
  }

  let updated = 0;
  const BATCH = 200;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    db.exec('BEGIN');
    for (const f of batch) {
      if (indexFile(db, f.path, f.tool)) updated++;
    }
    db.exec('COMMIT');
  }

  return { total: files.length, updated };
}

export async function searchSessions(
  query: string,
  toolFilter: Tool | '',
  project: string,
  limit: number,
): Promise<SessionResult[]> {
  const db = getDb();
  await refreshIndex();

  let rows: Array<{
    file_path: string;
    cwd: string;
    tool: string;
    session_id: string;
    date: string;
    first_prompt: string;
    snippet: string | null;
  }>;

  if (query) {
    const ftsQuery = query.replace(/['"]/g, '').split(/\s+/).map((w) => `"${w}"`).join(' ');
    const conditions: string[] = [];
    const params: (string | number)[] = [ftsQuery];

    if (toolFilter) {
      conditions.push('s.tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      conditions.push('s.cwd LIKE ?');
      params.push(project + '%');
    }
    params.push(limit);

    const extra = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    rows = db.query<any, any[]>(`
      SELECT s.file_path, s.cwd, s.tool, s.session_id, s.date, s.first_prompt,
             snippet(session_fts, 1, '', '', '…', 32) as snippet
      FROM session_fts f
      JOIN sessions s ON s.file_path = f.file_path
      WHERE f.session_fts MATCH ?
      ${extra}
      ORDER BY s.date DESC
      LIMIT ?
    `).all(...params);
  } else {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (toolFilter) {
      conditions.push('tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      conditions.push('cwd LIKE ?');
      params.push(project + '%');
    }
    params.push(limit);

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    rows = db.query<any, any[]>(`
      SELECT file_path, cwd, tool, session_id, date, first_prompt, NULL as snippet
      FROM sessions ${where}
      ORDER BY date DESC LIMIT ?
    `).all(...params);
  }

  return rows.map((r) => ({
    date: r.date,
    cwd: r.cwd,
    tool: r.tool as Tool,
    sessionId: r.session_id,
    displayText: r.snippet ?? r.first_prompt,
    filePath: r.file_path,
    exists: existsSync(r.cwd),
  }));
}
