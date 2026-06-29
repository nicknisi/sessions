import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import {
  type Tool,
  type SessionResult,
  type ActivityDigest,
  type DigestProjectGroup,
  type DigestDay,
  type DigestSessionDetail,
  type SessionMetrics,
  type ContextPrimer,
  type ContextSession,
  type ContextHeadline,
} from './types';
import {
  getCwdFromSession,
  firstPrompt,
  lastTimestamp,
  getSessionMessages,
  customTitle,
  firstTimestamp,
  messageCount,
  closingMessages,
  sessionBranch,
} from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import { type RepoInfo, globPrefix, branchLabel } from './repo';
import { isTrivia, blendedScore, type ScorableSession } from './significance';

// Source/cache locations default to the real home dirs but honor env overrides so
// tests can point the index at hermetic temp fixtures (SESSIONS_* env vars).
const home = homedir();

// Resolve the sessions cache directory, honoring SESSIONS_CACHE_DIR so tests (and
// the runtime pricing cache) stay hermetic under the same env override. Exported
// so the pricing cache lives alongside index.db without hardcoding ~/.cache/sessions.
export function getCacheDir(): string {
  return process.env.SESSIONS_CACHE_DIR || join(home, '.cache', 'sessions');
}

// The index.db path under the cache dir. Exported because the test harness (and
// Task 10) reference it directly. Resolved lazily — not frozen at import — so a
// test that mutates SESSIONS_* on the shared module instance is honored.
export function getDbPath(): string {
  return join(getCacheDir(), 'index.db');
}

// Source-session roots, resolved lazily for the same hermetic-test reason. Real
// runs have a stable env, so production behavior is unchanged by the laziness.
function getClaudeDir(): string {
  return process.env.SESSIONS_CLAUDE_DIR || join(home, '.claude/projects');
}
function getPiDir(): string {
  return process.env.SESSIONS_PI_DIR || join(home, '.pi/agent/sessions');
}
function getCodexDir(): string {
  return process.env.SESSIONS_CODEX_DIR || join(home, '.codex/sessions');
}

// Bump 5 -> 6: the FTS index gains headline/commands/paths/context_text/thinking
// columns and the sessions table gains files_read/commands/errored/error_count, so
// search can match (and weight) commands, file paths, errors, and reasoning. The
// virtual-table shape changes, so getDb drops + rebuilds on a user_version mismatch.
const SCHEMA_VERSION = 6;
let _db: Database | null = null;

export function clearCache(): void {
  const dbPath = getDbPath();
  const files = [dbPath, dbPath + '-wal', dbPath + '-shm'];
  let cleared = false;
  for (const f of files) {
    try {
      require('node:fs').unlinkSync(f);
      cleared = true;
    } catch {}
  }
  process.stderr.write(cleared ? 'Cache cleared. It will rebuild on next use.\n' : 'No cache to clear.\n');
}

// Close and drop the cached connection so the next getDb() reopens against the
// current getDbPath(). Lets hermetic tests reset shared-module state between files
// (and release the handle before deleting a temp dir). Idempotent and never throws.
export function closeDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
}

// Open (or create) the index DB and bring it to the v6 schema, resolving the path
// lazily so hermetic tests honoring SESSIONS_CACHE_DIR get their own file. busy_timeout
// makes a statement wait for a contended write lock (e.g. a concurrent refreshIndex)
// instead of erroring with SQLITE_BUSY immediately. This does NOT assign the `_db`
// singleton — getDb owns that, so it can retry openDb after discarding a corrupt file.
function openDb(): Database {
  const db = new Database(getDbPath());
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');

  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  if (!row || row.user_version !== SCHEMA_VERSION) {
    db.run('DROP TABLE IF EXISTS sessions');
    db.run('DROP TABLE IF EXISTS session_fts');
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '?',
      first_prompt TEXT NOT NULL,
      custom_title TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      files_touched TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      errored INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      closing_user TEXT NOT NULL DEFAULT '',
      closing_assistant TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT ''
    )
  `);
  // `user_content` and `assistant_content` are separate columns so search can rank
  // and snippet each independently (a match in the model's own diagnosis is just as
  // findable as one in the prompt). `porter unicode61` adds stemming on top of the
  // default unicode tokenizer so e.g. "refactoring" matches an indexed "refactor".
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      headline,
      user_content,
      assistant_content,
      commands,
      paths,
      context_text,
      thinking,
      tokenize = 'porter unicode61'
    )
  `);
  return db;
}

// Best-effort removal of the index file and its WAL/SHM sidecars (lazily-resolved)
// so a corrupt index can be rebuilt from scratch. Each unlink is independent — a
// missing sidecar must not stop us deleting the others.
function removeDbFiles(): void {
  const dbPath = getDbPath();
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      require('node:fs').unlinkSync(f);
    } catch {}
  }
}

// A corrupt or non-database index file surfaces as a SQLiteError on the first
// PRAGMA/CREATE in openDb (e.g. "file is not a database" / "database disk image is
// malformed"). Match SQLite's wording case-insensitively so getDb can self-heal.
function isCorruption(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database');
}

function getDb(): Database {
  if (_db) return _db;
  mkdirSync(getCacheDir(), { recursive: true });
  try {
    _db = openDb();
  } catch (e) {
    if (!isCorruption(e)) throw e;
    // The index is a disposable, rebuildable cache of the session files — so a
    // corrupt one is safe to delete and recreate. refreshIndex repopulates on use.
    removeDbFiles();
    _db = openDb();
  }
  return _db;
}

interface FileEntry {
  path: string;
  tool: Tool;
}

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const claudeDir = getClaudeDir();
  const piDir = getPiDir();
  const codexDir = getCodexDir();

  if (existsSync(claudeDir)) {
    let dirs: string[];
    try {
      dirs = await readdir(claudeDir);
    } catch {
      dirs = [];
    }
    for (const dirname of dirs) {
      const dirpath = join(claudeDir, dirname);
      const glob = new Bun.Glob('*.jsonl');
      for await (const p of glob.scan(dirpath)) {
        entries.push({ path: join(dirpath, p), tool: 'claude' });
      }
    }
  }

  if (existsSync(piDir)) {
    let dirs: string[];
    try {
      dirs = await readdir(piDir);
    } catch {
      dirs = [];
    }
    for (const dirname of dirs) {
      const dirpath = join(piDir, dirname);
      const glob = new Bun.Glob('*.jsonl');
      for await (const p of glob.scan(dirpath)) {
        entries.push({ path: join(dirpath, p), tool: 'pi' });
      }
    }
  }

  if (existsSync(codexDir)) {
    const glob = new Bun.Glob('**/*.jsonl');
    for await (const p of glob.scan(codexDir)) {
      entries.push({ path: join(codexDir, p), tool: 'codex' });
    }
  }

  return entries;
}

function collectSubagentContent(filePath: string): string {
  const dir = join(filePath.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return '';

  const parts: string[] = [];
  try {
    const files = require('node:fs').readdirSync(dir) as string[];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const lines = raw.trimEnd().split('\n');
        const msgs = getSessionMessages(lines);
        for (const m of msgs) {
          if (m.role === 'user') parts.push(m.text);
        }
      } catch {}
    }
  } catch {}
  return parts.join('\n');
}

function indexFile(db: Database, filePath: string, tool: Tool): boolean {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }

  const existing = db
    .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM sessions WHERE file_path = ?')
    .get(filePath);

  if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
    return false;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split('\n');
  if (lines.length === 0) return false;

  const cwd = getCwdFromSession(lines, tool);
  if (!cwd) return false;
  if (cwd.includes('.claude/worktrees') || cwd.includes('/.bare')) return false;

  const sessionId = basename(filePath).replace('.jsonl', '');
  const prompt = firstPrompt(lines, tool);
  const title = customTitle(lines);
  const date = lastTimestamp(raw);
  const createdAt = firstTimestamp(lines);
  const msgCount = messageCount(lines);

  const messages = getSessionMessages(lines);
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('\n');
  const assistantContent = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('\n');

  const subagentContent = tool === 'claude' ? collectSubagentContent(filePath) : '';
  const fullContent = subagentContent ? userContent + '\n' + subagentContent : userContent;

  const filesTouchedArr = extractFiles(lines, tool);
  const filesTouched = JSON.stringify(filesTouchedArr);
  const filesReadArr = extractFilesRead(lines, tool);
  const filesRead = JSON.stringify(filesReadArr);
  const commandsArr = extractCommands(lines, tool);
  const commands = JSON.stringify(commandsArr);
  const errors = extractErrors(lines, tool);
  const thinking = extractThinking(lines, tool);
  const headline = `${prompt}\n${title}`;
  const pathsText = [...filesTouchedArr, ...filesReadArr].join('\n');
  const commandsText = commandsArr.join('\n');
  const contextText = errors.messages.join('\n');
  const closing = closingMessages(lines, tool);
  const branch = sessionBranch(lines, tool);

  if (existing) {
    db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
  }
  db.run(
    `INSERT OR REPLACE INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count, files_touched, files_read, commands, errored, error_count, closing_user, closing_assistant, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      filePath,
      stat.mtimeMs,
      stat.size,
      cwd,
      tool,
      sessionId,
      date,
      createdAt,
      prompt,
      title,
      msgCount,
      filesTouched,
      filesRead,
      commands,
      errors.errored ? 1 : 0,
      errors.count,
      closing.user,
      closing.assistant,
      branch,
    ],
  );
  db.run(
    'INSERT INTO session_fts (file_path, headline, user_content, assistant_content, commands, paths, context_text, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [filePath, headline, fullContent, assistantContent, commandsText, pathsText, contextText, thinking],
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

export interface SearchOptions {
  tool?: Tool | '';
  project?: string;
  errored?: boolean;
  limit?: number;
}

export async function searchSessions(query: string, opts: SearchOptions = {}): Promise<SessionResult[]> {
  const db = getDb();
  await refreshIndex();

  const toolFilter = opts.tool ?? '';
  const project = opts.project ?? '';
  const limit = opts.limit ?? 50;

  interface SessionRow {
    file_path: string;
    cwd: string;
    tool: string;
    session_id: string;
    date: string;
    created_at: string;
    first_prompt: string;
    custom_title: string;
    message_count: number;
    files_touched: string;
    files_read: string;
    commands: string;
    errored: number;
    snippet: string | null;
  }

  let rows: SessionRow[];

  // Split the free-text query into individual quoted terms joined with OR. OR recall
  // (any term may match) paired with bm25() ranking surfaces the sessions matching the
  // most — and rarest — terms first, instead of the old strict-AND that returned
  // nothing unless every word was present. This matters most for the LLM/MCP caller,
  // which issues long natural-language queries. Quoting each term keeps FTS5 operators
  // in user input literal. An all-whitespace/quotes query yields no terms → recent list.
  const ftsTerms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`);
  const ftsQuery = ftsTerms.join(' OR ');

  // bm25 weights map to session_fts columns in declaration order:
  // file_path, headline, user_content, assistant_content, commands, paths, context_text, thinking.
  // Favor headline/commands/paths; de-emphasize verbose thinking so it adds recall without dominating.
  const RANK = 'bm25(session_fts, 0.0, 10.0, 3.0, 2.0, 6.0, 5.0, 2.0, 0.5)';

  if (ftsQuery) {
    const conditions: string[] = [];
    const params: (string | number)[] = [ftsQuery];

    if (toolFilter) {
      conditions.push('s.tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      // Boundary-aware: the project root itself or a descendant, never a sibling
      // sharing a prefix (e.g. `dotfiles-v2` must not match `dotfiles`).
      conditions.push('(s.cwd = ? OR s.cwd GLOB ?)');
      params.push(project, globPrefix(project));
    }
    if (opts.errored) conditions.push('s.errored = 1');
    params.push(limit);

    const extra = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    rows = db
      .query<SessionRow, any[]>(`
      SELECT s.file_path, s.cwd, s.tool, s.session_id, s.date, s.created_at, s.first_prompt,
             s.custom_title, s.message_count, s.files_touched, s.files_read, s.commands, s.errored,
             snippet(session_fts, -1, '', '', '…', 32) as snippet
      FROM session_fts f
      JOIN sessions s ON s.file_path = f.file_path
      WHERE f.session_fts MATCH ?
      ${extra}
      ORDER BY ${RANK}
      LIMIT ?
    `)
      .all(...params);
  } else {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (toolFilter) {
      conditions.push('tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      conditions.push('(cwd = ? OR cwd GLOB ?)');
      params.push(project, globPrefix(project));
    }
    if (opts.errored) conditions.push('errored = 1');
    params.push(limit);

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    rows = db
      .query<SessionRow, any[]>(`
      SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
             custom_title, message_count, files_touched, files_read, commands, errored, NULL as snippet
      FROM sessions ${where}
      ORDER BY date DESC LIMIT ?
    `)
      .all(...params);
  }

  return rows.map((r) => ({
    date: r.date,
    createdAt: r.created_at,
    cwd: r.cwd,
    tool: r.tool as Tool,
    sessionId: r.session_id,
    displayText: r.snippet ?? (r.custom_title || r.first_prompt),
    customTitle: r.custom_title,
    messageCount: r.message_count,
    filePath: r.file_path,
    exists: existsSync(r.cwd),
    // `files` is the union of edited + read files so it answers "what files did this
    // session involve" (a Read-only target is still surfaced).
    files: [...new Set([...parseFiles(r.files_touched), ...parseFiles(r.files_read)])],
    commands: parseFiles(r.commands),
    errored: r.errored === 1,
  }));
}

interface DateRangeRow {
  file_path: string;
  cwd: string;
  tool: string;
  session_id: string;
  date: string;
  created_at: string;
  first_prompt: string;
  custom_title: string;
  message_count: number;
}

function queryDateRange(
  db: Database,
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
): DateRangeRow[] {
  const conditions: string[] = ['created_at >= ?', 'created_at <= ?'];
  const params: (string | number)[] = [startDate, endDate];

  if (toolFilter) {
    conditions.push('tool = ?');
    params.push(toolFilter);
  }
  if (project) {
    conditions.push('(cwd = ? OR cwd GLOB ?)');
    params.push(project, globPrefix(project));
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  return db
    .query<DateRangeRow, any[]>(
      `SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count
       FROM sessions ${where}
       ORDER BY created_at ASC, date ASC`,
    )
    .all(...params);
}

const MAX_TOPICS = 10;
const MAX_FILEPATHS = 5;
const MAX_SESSIONS_DETAIL = 10;
const MAX_USER_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 500;

interface PendingGroup {
  group: DigestProjectGroup;
  rows: DateRangeRow[];
}

function readUserMessages(filePath: string, mode: 'full' | 'highlights'): string[] {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.trimEnd().split('\n');
    const msgs = getSessionMessages(lines).filter((m) => m.role === 'user');
    if (msgs.length === 0) return [];

    const cap = (t: string, len: number) => (t.length > len ? t.slice(0, len) + '…' : t);

    if (mode === 'highlights') {
      const result = [cap(msgs[0]!.text, 300)];
      if (msgs.length > 1) result.push(cap(msgs[msgs.length - 1]!.text, 300));
      return result;
    }

    return msgs.slice(0, MAX_USER_MESSAGES).map((m) => cap(m.text, MAX_MESSAGE_LENGTH));
  } catch {
    return [];
  }
}

export type DigestDetail = 'compact' | 'highlights' | 'full';

export async function getActivityDigest(
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
  detail: DigestDetail = 'compact',
): Promise<ActivityDigest> {
  const db = getDb();
  await refreshIndex();

  const rows = queryDateRange(db, startDate, endDate, toolFilter, project);

  const toolCounts: Record<string, number> = {};
  const projectSet = new Set<string>();
  let totalMessages = 0;

  const dayProjectMap = new Map<string, Map<string, PendingGroup>>();

  for (const r of rows) {
    toolCounts[r.tool] = (toolCounts[r.tool] ?? 0) + 1;
    projectSet.add(r.cwd);
    totalMessages += r.message_count;

    const day = r.created_at;
    if (!dayProjectMap.has(day)) dayProjectMap.set(day, new Map());
    const projectMap = dayProjectMap.get(day)!;

    if (!projectMap.has(r.cwd)) {
      projectMap.set(r.cwd, {
        group: {
          project: r.cwd,
          sessions: 0,
          totalMessages: 0,
          tools: [],
          topics: [],
          filePaths: [],
        },
        rows: [],
      });
    }

    const pending = projectMap.get(r.cwd)!;
    const g = pending.group;
    g.sessions++;
    g.totalMessages += r.message_count;
    if (!g.tools.includes(r.tool)) g.tools.push(r.tool);
    const topic = r.custom_title || r.first_prompt;
    if (topic) g.topics.push(topic);
    g.filePaths.push(r.file_path);
    pending.rows.push(r);
  }

  const days: DigestDay[] = [];
  for (const [date, projectMap] of dayProjectMap) {
    const projects = [...projectMap.values()].map(({ group: g, rows: sessionRows }) => {
      const result: DigestProjectGroup = {
        ...g,
        topics: [...new Set(g.topics)].slice(0, MAX_TOPICS),
        filePaths: g.filePaths.slice(-MAX_FILEPATHS),
      };

      if (detail === 'full' || detail === 'highlights') {
        const sorted = [...sessionRows].sort((a, b) => b.message_count - a.message_count);
        const minMessages = detail === 'highlights' ? 3 : 0;
        const candidates = sorted.filter((r) => r.message_count > minMessages);
        result.sessionDetails = candidates.slice(0, MAX_SESSIONS_DETAIL).map(
          (r): DigestSessionDetail => ({
            sessionId: r.session_id,
            tool: r.tool,
            title: r.custom_title || r.first_prompt,
            messageCount: r.message_count,
            filePath: r.file_path,
            userMessages: readUserMessages(r.file_path, detail),
          }),
        );
      }

      return result;
    });
    const daySessions = projects.reduce((sum, p) => sum + p.sessions, 0);
    days.push({ date, sessions: daySessions, projects });
  }

  return {
    period: { start: startDate, end: endDate },
    totalSessions: rows.length,
    totalMessages,
    tools: toolCounts,
    projects: [...projectSet],
    days,
  };
}

export async function getSessionMetrics(
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
): Promise<SessionMetrics> {
  const db = getDb();
  await refreshIndex();

  const rows = queryDateRange(db, startDate, endDate, toolFilter, project);

  const toolBreakdown: Record<string, number> = {};
  const projectMap = new Map<string, { sessions: number; messages: number }>();
  const dailyMap = new Map<string, { sessions: number; messages: number }>();
  const activeHours: Record<string, number> = {};
  let totalMessages = 0;

  for (const r of rows) {
    toolBreakdown[r.tool] = (toolBreakdown[r.tool] ?? 0) + 1;
    totalMessages += r.message_count;

    const pm = projectMap.get(r.cwd) ?? { sessions: 0, messages: 0 };
    pm.sessions++;
    pm.messages += r.message_count;
    projectMap.set(r.cwd, pm);

    const day = r.created_at;
    const dm = dailyMap.get(day) ?? { sessions: 0, messages: 0 };
    dm.sessions++;
    dm.messages += r.message_count;
    dailyMap.set(day, dm);
  }

  for (const r of rows) {
    try {
      const raw = readFileSync(r.file_path, 'utf-8');
      const firstLine = raw.slice(0, raw.indexOf('\n'));
      const d = JSON.parse(firstLine);
      const ts = d.timestamp as string | undefined;
      if (ts && ts.includes('T')) {
        const hour = ts.slice(11, 13);
        activeHours[hour] = (activeHours[hour] ?? 0) + 1;
      }
    } catch {}
  }

  const projectBreakdown = [...projectMap.entries()]
    .map(([p, v]) => ({ project: p, sessions: v.sessions, messages: v.messages }))
    .sort((a, b) => b.sessions - a.sessions);

  const dailyActivity = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, sessions: v.sessions, messages: v.messages }))
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  return {
    period: { start: startDate, end: endDate },
    totalSessions: rows.length,
    totalMessages,
    toolBreakdown,
    projectBreakdown,
    dailyActivity,
    activeHours,
  };
}

export interface ContextOptions {
  limit?: number; // recent-tier size (default 10)
  days?: number; // optional window (last N days)
  tool?: Tool | ''; // optional tool filter
  worktreeOnly?: boolean; // restrict to current worktree (default false → aggregate)
  headlineCap?: number; // older-tier cap (default 40)
}

interface ContextRow {
  cwd: string;
  tool: string;
  session_id: string;
  date: string;
  created_at: string;
  first_prompt: string;
  custom_title: string;
  message_count: number;
  files_touched: string;
  closing_user: string;
  closing_assistant: string;
  branch: string;
}

function parseFiles(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Repo-scoped, two-tier, worktree-aggregated context primer assembled entirely
 * from indexed columns + the RepoInfo branch map. Reads zero session source
 * files (everything comes from the `sessions` table and the one `git worktree
 * list` call already made in resolveRepo).
 */
export async function getContextPrimer(repo: RepoInfo, opts: ContextOptions): Promise<ContextPrimer> {
  const db = getDb();
  await refreshIndex();

  const limit = opts.limit ?? 10;
  const headlineCap = opts.headlineCap ?? 40;
  const toolFilter = opts.tool ?? '';
  const root = opts.worktreeOnly ? repo.currentWorktree : repo.container;

  // Boundary-aware scope: the container (or current worktree) itself or any
  // descendant — captures every worktree under it while excluding `…-v2` siblings.
  const conditions: string[] = ['(cwd = ? OR cwd GLOB ?)'];
  const params: (string | number)[] = [root, globPrefix(root)];

  if (toolFilter) {
    conditions.push('tool = ?');
    params.push(toolFilter);
  }
  if (opts.days && opts.days > 0) {
    const cutoff = new Date(Date.now() - opts.days * 86_400_000).toISOString().slice(0, 10);
    conditions.push('created_at >= ?');
    params.push(cutoff);
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const rows = db
    .query<ContextRow, any[]>(
      `SELECT cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count,
              files_touched, closing_user, closing_assistant, branch
       FROM sessions ${where}
       ORDER BY created_at DESC, date DESC`,
    )
    .all(...params);

  const repoLabel = basename(repo.container);

  if (rows.length === 0) {
    return { repoLabel, toolFilter, recent: [], headlines: [], isEmpty: true };
  }

  // Rank the detail tier by recency-weighted significance instead of raw recency,
  // keeping trivial sessions out of it. All inputs are already-selected columns.
  const now = Date.now();
  const scored = rows.map((r) => {
    const s: ScorableSession = {
      messageCount: r.message_count,
      filesTouchedCount: parseFiles(r.files_touched).length,
      closingText: `${r.closing_user} ${r.closing_assistant}`,
      createdAt: r.created_at !== '?' ? r.created_at : r.date,
    };
    return { row: r, trivia: isTrivia(s), score: blendedScore(s, now) };
  });

  const byScore = (a: { score: number }, b: { score: number }): number => b.score - a.score;
  const substantive = scored.filter((x) => !x.trivia).sort(byScore);
  // Fallback: an all-trivial repo still shows something rather than an empty
  // detail tier — trivia only loses its slot when real work competes for it.
  const pool = substantive.length > 0 ? substantive : [...scored].sort(byScore);
  const recentRows = pool.slice(0, limit).map((x) => x.row);

  // Headlines = every row not promoted to the detail tier, kept in the SQL
  // recency order (created_at DESC), capped. Demoted trivia lands here.
  const detailSet = new Set(recentRows);
  const headlineRows = rows.filter((r) => !detailSet.has(r)).slice(0, headlineCap);

  const recent: ContextSession[] = recentRows.map((r) => ({
    sessionId: r.session_id,
    tool: r.tool as Tool,
    branch: r.branch || branchLabel(r.cwd, repo.branches),
    date: r.date,
    messageCount: r.message_count,
    intent: r.custom_title || r.first_prompt,
    files: parseFiles(r.files_touched),
    opening: r.first_prompt,
    closing: { user: r.closing_user, assistant: r.closing_assistant },
  }));

  const headlines: ContextHeadline[] = headlineRows.map((r) => ({
    date: r.date,
    tool: r.tool as Tool,
    branch: r.branch || branchLabel(r.cwd, repo.branches),
    intent: r.custom_title || r.first_prompt,
  }));

  return { repoLabel, toolFilter, recent, headlines, isEmpty: false };
}
