import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  type Tool,
  type SessionResult,
  type ActivityDigest,
  type DigestProjectGroup,
  type DigestDay,
  type DigestSessionDetail,
  type ContextPrimer,
  type ContextSession,
  type ContextHeadline,
  type MessageHit,
} from './types';
import { extractSessionMetadata, summarizeMessages, harnessNoiseSql, isHarnessNoise } from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import { discoverOpencodeSessions, collectOpencodeSubagentText, closeOpencodeDb } from './opencode';
import { readSessionLines, statSession } from './session-io';
import { sessionIdFor } from './session-id';
import { getSessionMessages, parseSession, toMessages } from './record';
import { type RepoInfo, globPrefix, branchLabel } from './repo';
import { isTrivia, blendedScore, type ScorableSession } from './significance';
import { isJunkScope, notJunkCwdSql } from './wrapped/exclude';
import { readLessonsForRepo, LESSON_LIMIT } from './memory';

// Source/cache locations live in src/paths.ts — every one honors a SESSIONS_* env
// override so tests can point the index at hermetic temp fixtures. Re-exported
// because the pricing cache and the test harness reference them by these names.
import {
  assertNotRealStore,
  getCacheDir,
  getDbPath,
  getEventCachePath,
  getClaudeDir,
  getPiDir,
  getCodexDir,
} from './paths';
export { getCacheDir, getDbPath };

// Bump 6 -> 7: search becomes message-granular. A new message_fts table holds one
// row per message (genuine user turns + assistant turns) carrying the parser's
// message index, and session_fts slims to its genuinely session-level columns
// (user_content/assistant_content move out — message text is stored exactly once).
// The virtual-table shapes change, so getDb drops + rebuilds on a user_version mismatch.
// v8: message_fts no longer stores compaction summaries or tag-wrapped agent/
// harness injections (task-notifications, `!`-mode shell echoes, teammate relays)
// as genuine user turns — see isGenuineUserTurn/stripInjected in parser.ts.
// v9: extractCommands clips each command to MAX_COMMAND_LEN on the way in, so the
// stored `commands` column (and its FTS copy) needs a rebuild to shed the 9KB
// one-liners v8 indexed verbatim.
// v10: bumped when harness bookkeeping rows were dropped at insert time. That filter
// has since moved to the search read path (grep_sessions must stay exhaustive), so v10
// changes nothing about what is written — but v9's command clipping still does, so an
// index built before 10 has to rebuild and the number stays where it is.
// v11: transport banners no longer reach session_fts.context_text. That one IS a write
// change — a v10 index holds sessions whose only searchable text is `API Error: …` —
// and unlike message_fts there is no read-path filter to fall back on, so it rebuilds.
// v12: messages come from the record (src/record.ts) instead of extractMessages, so Codex
// finally has any at all — 292 of 292 indexed Codex sessions held 0 message_fts rows, a
// blank first_prompt and message_count 0. Nothing re-parses on its own: indexFile skips on
// unchanged mtime/size and Codex rollouts are append-then-frozen, so without a forced
// rebuild those rows would stay blank forever. session_id also changes for codex and pi
// (see src/session-id.ts).
// v13: the thinking column and Pi's files_touched come from the record too — Codex
// reasoning was hardcoded to '' and Pi's edited-file branch was a no-op, so both were
// empty for every session that had them.
// v14: a `meta` table carries the cross-process refresh marker. It is listed in the drop
// block below on purpose — that list is hardcoded rather than schema-driven, and a marker
// that survived a version bump would read "just walked" over an index that was just
// emptied, so ensureIndexFresh would serve nothing for the length of the interval.
const SCHEMA_VERSION = 14;
let _db: Database | null = null;
let _refreshPromise: Promise<RefreshResult> | null = null;
let _lastRefreshAt = 0;
// Separate from _lastRefreshAt rather than back-dating it: a back-date of
// `now - interval + backoff` lands in the *future* whenever the backoff exceeds the
// interval (it does, with the defaults), which is indistinguishable from the clock-skew
// case the marker deliberately treats as expired.
let _lastFailureAt = 0;
let _lastRefreshResult: RefreshResult = { total: 0, updated: 0 };
let _refreshAttempts = 0;

interface RefreshResult {
  total: number;
  updated: number;
}

export function clearCache(): void {
  const dbPath = getDbPath();
  // The parsed-event cache is a rebuildable projection of the same transcripts, so it goes
  // with the index rather than surviving a --clear-cache that was meant to reset everything.
  const eventPath = getEventCachePath();
  const files = [dbPath, dbPath + '-wal', dbPath + '-shm', eventPath, eventPath + '-wal', eventPath + '-shm'];
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
  // Drop the in-flight refresh too: it targets the handle we just closed, so a
  // later ensureIndexFresh must start a new scan rather than join a doomed one.
  _refreshPromise = null;
  _lastRefreshAt = 0;
  _lastFailureAt = 0;
  _lastRefreshResult = { total: 0, updated: 0 };
  closeOpencodeDb();
}

/**
 * How many source walks this process has started. A refresh that is skipped — coalesced,
 * inside the interval, backed off after a failure, or covered by another process's marker
 * — does not count.
 *
 * Exists as an observability seam: discoverFiles and ensureIndexFresh are both private and
 * there is no module mocking in this repo, so "was the tree actually walked" is otherwise
 * unobservable from a test or a second process. Monotonic — closeDb() does not reset it.
 */
export function refreshAttempts(): number {
  return _refreshAttempts;
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
    db.run('DROP TABLE IF EXISTS message_fts');
    db.run('DROP TABLE IF EXISTS ignored_files');
    db.run('DROP TABLE IF EXISTS meta');
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // Small key/value shelf for facts about the index itself. Currently one key,
  // 'last_refresh_ms': the wall-clock time a process finished a source walk, so a second
  // process can skip a walk that one just did. Disposable with the index, which is
  // correct — it describes the index — and it inherits the busy_timeout above.
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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
  // Session-level searchable text only — message text lives in message_fts (one row
  // per message) so a hit localizes to an exchange instead of a whole session.
  // `porter unicode61` adds stemming on top of the default unicode tokenizer so
  // e.g. "refactoring" matches an indexed "refactor".
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      headline,
      commands,
      paths,
      context_text,
      thinking,
      tokenize = 'porter unicode61'
    )
  `);
  // One row per indexed message. msg_index mirrors the numbering getSessionMessages
  // assigns (parseSession is the single authority), so a search hit's index feeds
  // get_session_messages(offset) directly. Manual sync, same as session_fts: indexFile
  // deletes by file_path then re-inserts; refreshIndex prunes removed files.
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      file_path UNINDEXED,
      msg_index UNINDEXED,
      role UNINDEXED,
      text,
      tokenize = 'porter unicode61'
    )
  `);
  // Negative inventory cache: malformed/empty transcripts and explicitly
  // excluded worktree logs otherwise look "new" on every refresh and get parsed
  // forever. The mtime+size signal makes them candidates again if they change.
  db.run(`
    CREATE TABLE IF NOT EXISTS ignored_files (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL
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
  // Ahead of the mkdirSync, so a refused open cannot create ~/.cache/sessions on its way
  // to being refused. See assertNotRealStore in src/paths.ts.
  assertNotRealStore(getDbPath(), 'index');
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

  // OpenCode has no per-session files — sessions live in one SQLite DB, so each
  // discovered "file" is a synthetic dbPath/sessionId handle (see src/opencode.ts).
  // Returns [] when the DB is absent.
  entries.push(...discoverOpencodeSessions());

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
        const msgs = getSessionMessages(lines, 'claude');
        for (const m of msgs) {
          if (m.role === 'user') parts.push(m.text);
        }
      } catch {}
    }
  } catch {}
  return parts.join('\n');
}

/** Searchable subagent text folded into the parent session: Claude keeps sibling
 *  transcript files, OpenCode keeps child sessions in its DB; other tools have none. */
function collectSubagentText(filePath: string, tool: Tool): string {
  if (tool === 'claude') return collectSubagentContent(filePath);
  if (tool === 'opencode') return collectOpencodeSubagentText(filePath);
  return '';
}

function indexFile(db: Database, filePath: string, tool: Tool): boolean {
  // Deliberately re-stat rather than trusting refreshIndex's pre-lock snapshot: a
  // candidate may have waited behind another MCP process at BEGIN IMMEDIATE, and
  // this is where we observe that process's completed write (or a transcript
  // append) and skip the parse. A file that vanished during the wait stats as
  // null and is left entirely alone — pruning, not ignoring, is its owner.
  const stat = statSession(filePath, tool);
  if (!stat) return false;

  const existing = db
    .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM sessions WHERE file_path = ?')
    .get(filePath);

  if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
    return false;
  }
  const ignored = db
    .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM ignored_files WHERE file_path = ?')
    .get(filePath);
  if (ignored && ignored.mtime === stat.mtimeMs && ignored.size === stat.size) {
    return false;
  }

  const ignore = (): false => {
    if (existing) {
      db.run('DELETE FROM sessions WHERE file_path = ?', [filePath]);
      db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
      db.run('DELETE FROM message_fts WHERE file_path = ?', [filePath]);
    }
    db.run('INSERT OR REPLACE INTO ignored_files (file_path, mtime, size) VALUES (?, ?, ?)', [
      filePath,
      stat.mtimeMs,
      stat.size,
    ]);
    return false;
  };

  const lines = readSessionLines(filePath, tool);
  if (lines.length === 0) return ignore();

  const metadata = extractSessionMetadata(lines, tool);
  if (!metadata.cwd) return ignore();
  if (metadata.cwd.includes('.claude/worktrees') || metadata.cwd.includes('/.bare')) return ignore();

  const sessionId = sessionIdFor(filePath, tool, metadata.sessionId);
  const records = parseSession(lines, tool);
  const messages = toMessages(records);
  const summary = summarizeMessages(messages);
  const subagentContent = collectSubagentText(filePath, tool);

  const filesTouchedArr = extractFiles(lines, tool, records);
  const filesTouched = JSON.stringify(filesTouchedArr);
  const filesReadArr = extractFilesRead(lines, tool, records);
  const filesRead = JSON.stringify(filesReadArr);
  const commandsArr = extractCommands(lines, tool);
  const commands = JSON.stringify(commandsArr);
  const errors = extractErrors(lines, tool);
  const thinking = extractThinking(records);
  const headline = `${summary.firstPrompt}\n${metadata.customTitle}`;
  const pathsText = [...filesTouchedArr, ...filesReadArr].join('\n');
  const commandsText = commandsArr.join('\n');
  // Error messages minus the transport banners: `API Error: Rate limit reached` is
  // harness bookkeeping, not prose about the work, and context_text ranks at bm25 2.0 —
  // enough to place a banner-only session in the top 20 for "rate limit reached" with no
  // message hit behind it. The banner still counts as an error above (errored,
  // error_count, and so wrapped's census); only its text stops being searchable, and
  // grep_sessions still reaches the row in message_fts.
  const contextText = errors.messages.filter((m) => !isHarnessNoise(m)).join('\n');
  if (existing) {
    db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
    db.run('DELETE FROM message_fts WHERE file_path = ?', [filePath]);
  }
  db.run('DELETE FROM ignored_files WHERE file_path = ?', [filePath]);
  db.run(
    `INSERT OR REPLACE INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count, files_touched, files_read, commands, errored, error_count, closing_user, closing_assistant, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      filePath,
      stat.mtimeMs,
      stat.size,
      metadata.cwd,
      tool,
      sessionId,
      metadata.date,
      metadata.createdAt,
      summary.firstPrompt,
      metadata.customTitle,
      metadata.messageCount,
      filesTouched,
      filesRead,
      commands,
      errors.errored ? 1 : 0,
      errors.count,
      summary.closingUser,
      summary.closingAssistant,
      metadata.branch,
    ],
  );
  db.run(
    'INSERT INTO session_fts (file_path, headline, commands, paths, context_text, thinking) VALUES (?, ?, ?, ?, ?, ?)',
    [filePath, headline, commandsText, pathsText, contextText, thinking],
  );
  // Message rows: assistant turns always; user turns only when genuine — injected
  // skill bodies and tool results match everything and are exactly the noise the
  // trust fixes eliminated elsewhere. Harness bookkeeping (interrupt markers, transport
  // banners, tool-load acks) is NOT dropped here: it is indexed and filtered on read,
  // so grep_sessions stays exhaustive — see harnessNoiseSql in parser.ts.
  // db.query() caches the prepared statement, which matters at ~74 rows/session; the
  // calls run inside refreshIndex's per-batch transaction, never autocommit.
  const insertMessage = db.query('INSERT INTO message_fts (file_path, msg_index, role, text) VALUES (?, ?, ?, ?)');
  for (const m of messages) {
    if (m.role === 'user' && !m.genuine) continue;
    insertMessage.run(filePath, m.index, m.role, m.text);
  }
  // Subagent transcripts have no place in the parent's message numbering, so their
  // user text rides in a single sentinel row (msg_index -1): it keeps the session
  // findable by subagent-only terms but is excluded from messageHits.
  if (subagentContent) insertMessage.run(filePath, -1, 'user', subagentContent);
  return true;
}

async function runRefreshIndex(): Promise<RefreshResult> {
  _refreshAttempts++;
  const db = getDb();
  // De-duplicate at the boundary. It also makes the set/map work below line up
  // exactly with the total reported to callers.
  const files = [...new Map((await discoverFiles()).map((file) => [file.path, file])).values()];
  const filePaths = new Set(files.map((f) => f.path));

  // Fetch the current inventory once. The old path issued SELECT mtime,size once
  // per discovered file (~4,500 statements on the author's corpus) even when no
  // transcript had changed.
  const dbRows = db
    .query<{ file_path: string; mtime: number; size: number }, []>('SELECT file_path, mtime, size FROM sessions')
    .all();
  const indexedByPath = new Map(dbRows.map((row) => [row.file_path, row]));
  const ignoredRows = db
    .query<{ file_path: string; mtime: number; size: number }, []>('SELECT file_path, mtime, size FROM ignored_files')
    .all();
  const ignoredByPath = new Map(ignoredRows.map((row) => [row.file_path, row]));
  const inventoryPaths = new Set([...indexedByPath.keys(), ...ignoredByPath.keys()]);
  const removedPaths = [...inventoryPaths].filter((path) => !filePaths.has(path));
  if (removedPaths.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const path of removedPaths) {
        db.run('DELETE FROM sessions WHERE file_path = ?', [path]);
        db.run('DELETE FROM session_fts WHERE file_path = ?', [path]);
        db.run('DELETE FROM message_fts WHERE file_path = ?', [path]);
        db.run('DELETE FROM ignored_files WHERE file_path = ?', [path]);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (removedPaths.length > 100) {
      db.exec('VACUUM');
    }
  }

  // Stat source files before opening a write transaction, then transact only
  // candidates whose invalidation signal differs. indexFile re-checks after
  // BEGIN IMMEDIATE so a second MCP process that refreshed first makes this one
  // skip the expensive parse instead of duplicating it or racing a write lock.
  const candidates: FileEntry[] = [];
  for (const file of files) {
    const stat = statSession(file.path, file.tool);
    if (!stat) continue;
    const existing = indexedByPath.get(file.path);
    const ignored = ignoredByPath.get(file.path);
    const indexedMatches = existing && existing.mtime === stat.mtimeMs && existing.size === stat.size;
    const ignoredMatches = ignored && ignored.mtime === stat.mtimeMs && ignored.size === stat.size;
    if (!indexedMatches && !ignoredMatches) {
      candidates.push(file);
    }
  }

  let updated = 0;
  const BATCH = 200;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of batch) {
        if (indexFile(db, file.path, file.tool)) updated++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { total: files.length, updated };
}

/**
 * Force a source scan, coalescing concurrent callers in this process onto one
 * pass. Every query/MCP entry point goes through ensureIndexFresh instead, so
 * today this is reached only by tests — it stays exported as the "scan now" seam
 * for an explicit rebuild command.
 *
 * Coalescing weakens "scan now" for a caller that arrives mid-flight: it joins a
 * pass whose file list was snapshotted before the caller's own write, so it may
 * not observe that write. Anything needing a guaranteed post-write scan must run
 * after the in-flight promise settles, not alongside it.
 */
export async function refreshIndex(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;

  const promise = runRefreshIndex();
  _refreshPromise = promise;
  try {
    const result = await promise;
    _lastRefreshAt = Date.now();
    _lastFailureAt = 0;
    _lastRefreshResult = result;
    writeRefreshMarker(_lastRefreshAt); // visible to other processes
    return result;
  } catch (err) {
    // A persistently failing refresh must not re-walk the whole tree on every call. The
    // caller still sees the error; it is only the *next* caller that is spared the walk.
    _lastFailureAt = Date.now();
    throw err;
  } finally {
    if (_refreshPromise === promise) _refreshPromise = null;
  }
}

function refreshIntervalMs(): number {
  const configured = Number(process.env.SESSIONS_REFRESH_INTERVAL_MS ?? 5_000);
  return Number.isFinite(configured) ? Math.max(0, configured) : 5_000;
}

/** How long a failed refresh suppresses the next walk. Shorter than the failure costs and
 *  far longer than the interval, so a broken source root is attempted twice a minute
 *  rather than on every single query. */
function refreshBackoffMs(): number {
  const configured = Number(process.env.SESSIONS_REFRESH_BACKOFF_MS ?? 30_000);
  return Number.isFinite(configured) ? Math.max(0, configured) : 30_000;
}

const REFRESH_MARKER_KEY = 'last_refresh_ms';

/** Advisory only, and best effort: losing the marker costs a redundant walk, nothing else. */
function writeRefreshMarker(ts: number): void {
  try {
    getDb().run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [REFRESH_MARKER_KEY, String(ts)]);
  } catch {}
}

/** 0 when absent or unreadable — a missing marker must read as "nobody has walked", never as "fresh". */
function readRefreshMarker(): number {
  try {
    const row = getDb()
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(REFRESH_MARKER_KEY);
    const ts = Number(row?.value ?? 0);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

/**
 * Another process finished a walk recently enough that this one can skip its own.
 *
 * A future-dated marker counts as expired: that is a clock moved backwards, and trusting
 * it would suppress walks until real time caught up — search silently missing every new
 * transcript in the meantime.
 */
function markerIsFresh(): boolean {
  const marker = readRefreshMarker();
  if (marker <= 0) return false;
  const age = Date.now() - marker;
  return age >= 0 && age < refreshIntervalMs();
}

/** Rows already in the index, so a skipped walk reports what is there instead of the
 *  module-initial "0 sessions indexed". */
function indexedCount(): number {
  try {
    return getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0;
  } catch {
    return 0;
  }
}

async function ensureIndexFresh(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;
  if (_lastFailureAt > 0 && Date.now() - _lastFailureAt < refreshBackoffMs()) return _lastRefreshResult;
  if (_db && Date.now() - _lastRefreshAt < refreshIntervalMs()) return _lastRefreshResult;
  if (markerIsFresh()) {
    // Someone else's walk counts as ours. Recorded locally too, so the rest of this
    // process's queries take the cheap in-memory branch above instead of re-reading it.
    _lastRefreshAt = Date.now();
    _lastRefreshResult = { total: indexedCount(), updated: 0 };
    return _lastRefreshResult;
  }
  return refreshIndex();
}

// Read-only index access for stats consumers (`sessions wrapped`). Refreshes
// first so queries see current transcripts, then hands back the shared handle.
// Callers must treat the connection as read-only — all writes stay in this file.
export async function getIndexDb(): Promise<Database> {
  await ensureIndexFresh();
  return getDb();
}

export interface SearchOptions {
  tool?: Tool | '';
  project?: string;
  errored?: boolean;
  /** Substring match against files_touched OR files_read; multiple values AND-compose.
   *  Empty array = absent. With no query, filtered results order newest-first (created_at). */
  files?: string[];
  limit?: number;
  /** Keep automated sessions in the candidate set — eval-harness temp dirs, /tmp
   *  throwaways, menu-bar probes. Off by default: they are ~43% of a real index and
   *  are never what a search is looking for. See src/wrapped/exclude.ts. */
  includeAutomated?: boolean;
}

/**
 * Build the FTS5 MATCH expression for a free-text query. Terms are OR-joined: OR
 * recall (any term may match) paired with bm25() ranking surfaces the sessions
 * matching the most — and rarest — terms first, instead of the old strict-AND that
 * returned nothing unless every word was present. This matters most for the LLM/MCP
 * caller, which issues long natural-language queries.
 *
 * A balanced "…" span survives as one FTS5 phrase, so pasting a quoted error string
 * means that exact sequence rather than an OR of its words. Everything else is split
 * on whitespace, and every emitted term is re-quoted — that quoting is what keeps
 * FTS5 operators (NEAR, AND, `*`, `^`, `-`) in unquoted user input literal, so it
 * must survive any change here. A dangling quote has no closing partner, matches no
 * span, and falls through to the word split instead of swallowing the query.
 * Exported for the query-construction tests.
 */
export function buildFtsQuery(query: string): string {
  const terms: string[] = [];
  const rest = query.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const words = phrase.split(/\s+/).filter((w) => w.length > 0);
    if (words.length > 0) terms.push(`"${words.join(' ')}"`);
    return ' '; // the span is consumed; leave a separator behind
  });
  for (const word of rest.replace(/['"]/g, '').split(/\s+/)) {
    if (word.length > 0) terms.push(`"${word}"`);
  }
  return terms.join(' OR ');
}

export async function searchSessions(query: string, opts: SearchOptions = {}): Promise<SessionResult[]> {
  const db = getDb();
  await ensureIndexFresh();

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
  const hitsByPath = new Map<string, MessageHit[]>();

  const ftsQuery = buildFtsQuery(query);

  // Both branches filter the sessions table directly with the same conditions.
  const conditions: string[] = [];
  const condParams: (string | number)[] = [];
  if (toolFilter) {
    conditions.push('tool = ?');
    condParams.push(toolFilter);
  }
  if (project) {
    // Boundary-aware: the project root itself or a descendant, never a sibling
    // sharing a prefix (e.g. `dotfiles-v2` must not match `dotfiles`).
    conditions.push('(cwd = ? OR cwd GLOB ?)');
    condParams.push(project, globPrefix(project));
  }
  // Automated sessions are removed from the candidate set, not down-weighted — a
  // throwaway repro under /tmp can match a query better than the real session did.
  // The exception is a caller who scoped at or inside a junk root: excluding what they
  // explicitly asked for would return nothing at all.
  if (!opts.includeAutomated && !isJunkScope(project)) conditions.push(notJunkCwdSql('cwd'));
  if (opts.errored) conditions.push('errored = 1');
  // Files filter: substring match over the JSON-array text columns — callers pass a
  // path suffix or full path. Deliberately imprecise (a short fragment can match an
  // unrelated longer path); precision comes from passing longer suffixes. LIKE
  // metacharacters are escaped so paths with `_` (common) match literally.
  const files = (opts.files ?? []).filter((f) => f.length > 0); // blank entries = absent, like an empty array
  for (const f of files) {
    conditions.push("(files_touched LIKE '%' || ? || '%' ESCAPE '\\' OR files_read LIKE '%' || ? || '%' ESCAPE '\\')");
    const escaped = f.replace(/[\\%_]/g, (c) => `\\${c}`);
    condParams.push(escaped, escaped);
  }

  if (ftsQuery) {
    // Session-level results merge two hit sources: the slimmed session_fts (metadata
    // match) and message_fts aggregated by file_path (content match). Fetch both,
    // join in JS on file_path, combine ranks, sort, slice to limit.

    // bm25 weights map to session_fts columns in declaration order:
    // file_path, headline, commands, paths, context_text, thinking.
    // Favor headline/commands/paths; de-emphasize verbose thinking so it adds
    // recall without dominating. Message text ranks via message_fts below.
    const SESSION_RANK = 'bm25(session_fts, 0.0, 10.0, 6.0, 5.0, 2.0, 0.5)';
    interface SessionHitRow {
      file_path: string;
      srank: number;
      ssnippet: string | null;
    }
    const sessionHits = db
      .query<SessionHitRow, [string]>(`
      SELECT file_path, ${SESSION_RANK} AS srank, snippet(session_fts, -1, '', '', '…', 32) AS ssnippet
      FROM session_fts WHERE session_fts MATCH ?
    `)
      .all(ftsQuery);

    interface MessageHitRow {
      file_path: string;
      msg_index: number;
      role: string;
      mrank: number;
      msnippet: string;
      mlen: number;
    }
    // Harness bookkeeping rows are dropped here rather than at the message_fts insert:
    // the index stays complete for grep_sessions (exhaustive by contract) and a search
    // never has to rank an `API Error: Rate limit reached`. Same read-path treatment as
    // junk cwds above, and for the same reason. Filtered in SQL, not in the loop below,
    // because that loop only ever sees a snippet and a length — pulling whole message
    // text back to run the JS predicate costs ~37MB on the author's index for a query
    // as ordinary as "the".
    const messageRows = db
      .query<MessageHitRow, [string]>(`
      SELECT file_path, msg_index, role,
             bm25(message_fts, 0.0, 0.0, 0.0, 1.0) AS mrank,
             snippet(message_fts, 3, '', '', '…', 32) AS msnippet,
             length(text) AS mlen
      FROM message_fts WHERE message_fts MATCH ? AND NOT ${harnessNoiseSql('text')}
    `)
      .all(ftsQuery);

    // Role weighting replaces the old user_content 3.0 / assistant_content 2.0
    // column weights: bm25 can't weight by row, so boost user-turn ranks 1.5× in JS
    // (bm25 is more-negative-is-better; multiplying a negative rank improves it).
    const USER_HIT_BOOST = 1.5;
    // FTS5's length normalization (b=0.75) is generous enough that a one-line aside
    // sharing a term outranks the long analysis that actually answers the question.
    // Scale a hit's rank down toward MIN_DAMPING as its message gets shorter than
    // SUBSTANTIVE_CHARS — a demotion, not an exclusion, because a short message can
    // still be the answer ("use the raw body, not the parsed one").
    const SUBSTANTIVE_CHARS = 240;
    const MIN_DAMPING = 0.25;
    interface MessageAgg {
      best: number; // best (most negative) weighted rank across the session's hits
      hits: { hit: MessageHit; rank: number }[];
    }
    const msgAgg = new Map<string, MessageAgg>();
    for (const m of messageRows) {
      const damping = Math.max(MIN_DAMPING, Math.min(1, m.mlen / SUBSTANTIVE_CHARS));
      const rank = (m.role === 'user' ? m.mrank * USER_HIT_BOOST : m.mrank) * damping;
      let agg = msgAgg.get(m.file_path);
      if (!agg) {
        agg = { best: 0, hits: [] };
        msgAgg.set(m.file_path, agg);
      }
      agg.best = Math.min(agg.best, rank);
      // Sentinel rows (msg_index -1: subagent text) rank the session but are not
      // addressable messages, so they never become visible hits.
      if (m.msg_index >= 0) {
        agg.hits.push({ hit: { index: m.msg_index, role: m.role as 'user' | 'assistant', snippet: m.msnippet }, rank });
      }
    }

    const sessionHitByPath = new Map(sessionHits.map((s) => [s.file_path, s]));
    const candidatePaths = [...new Set([...sessionHitByPath.keys(), ...msgAgg.keys()])];

    // Fetch metadata (applying the filters) for every candidate, chunked to stay
    // well under SQLite's bound-parameter limit however many sessions match.
    const metaByPath = new Map<string, SessionRow>();
    const CHUNK = 400;
    const extra = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    for (let i = 0; i < candidatePaths.length; i += CHUNK) {
      const chunk = candidatePaths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const metaRows = db
        .query<SessionRow, any[]>(`
        SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
               custom_title, message_count, files_touched, files_read, commands, errored,
               NULL as snippet
        FROM sessions WHERE file_path IN (${placeholders}) ${extra}
      `)
        .all(...chunk, ...condParams);
      for (const r of metaRows) metaByPath.set(r.file_path, r);
    }

    // finalRank = sessionRank + bestMessageRank: a missing side contributes 0, and
    // matching both sources compounds (both are negative). The display snippet
    // prefers the best message hit (localized — strictly better than a whole-session
    // snippet) and falls back to the session-side snippet for metadata-only matches.
    //
    // FOLLOW-UP: the two addends are raw bm25 scores from tables with different
    // corpus statistics (one row per session vs one row per message, so different N,
    // avgdl and idf) — adding them is not meaningful, only empirically tuned. Fixing
    // it means normalizing each side before the sum, which reorders every result, so
    // it wants its own change measured against docs/eval-baseline.md.
    const merged = [...metaByPath.values()].map((meta) => {
      const s = sessionHitByPath.get(meta.file_path);
      const agg = msgAgg.get(meta.file_path);
      const hits = (agg?.hits ?? [])
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 3)
        .map((h) => h.hit);
      return {
        meta,
        hits,
        snippet: hits[0]?.snippet ?? s?.ssnippet ?? null,
        finalRank: (s?.srank ?? 0) + (agg?.best ?? 0),
      };
    });
    merged.sort((a, b) => a.finalRank - b.finalRank || b.meta.date.localeCompare(a.meta.date));

    const top = merged.slice(0, limit);
    rows = top.map((m) => ({ ...m.meta, snippet: m.snippet }));
    for (const m of top) hitsByPath.set(m.meta.file_path, m.hits);
  } else {
    const params: (string | number)[] = [...condParams, limit];
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    // A files filter without a query is the "what happened to this file lately"
    // shape: newest-first by creation time, not last-activity date.
    const orderBy = files.length > 0 ? 'created_at DESC' : 'date DESC';
    rows = db
      .query<SessionRow, any[]>(`
      SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
             custom_title, message_count, files_touched, files_read, commands, errored, NULL as snippet
      FROM sessions ${where}
      ORDER BY ${orderBy} LIMIT ?
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
    messageHits: hitsByPath.get(r.file_path) ?? [],
  }));
}

export interface GrepOptions {
  /** Treat the pattern as a JS regular expression. Default false = literal substring. */
  regex?: boolean;
  /** Case-insensitive match (default true). */
  ignoreCase?: boolean;
  /** Restrict to one message role. */
  role?: 'user' | 'assistant';
  tool?: Tool | '';
  project?: string;
  /** Session date (YYYY-MM-DD) lower/upper bounds, inclusive. */
  after?: string;
  before?: string;
  /** Max hit snippets to return (default 50). totalHits still counts every match. */
  limit?: number;
  /** Snippet radius in chars around the match (default 60). */
  contextChars?: number;
}

export interface GrepHit {
  tool: Tool;
  project: string;
  sessionId: string;
  filePath: string;
  date: string;
  role: 'user' | 'assistant';
  /** Feeds get_session_messages(offset) directly — same numbering as message_fts. */
  msgIndex: number;
  snippet: string;
}

export interface GrepResult {
  /** Messages containing at least one match (across the whole corpus, uncapped). */
  totalHits: number;
  /** Distinct sessions with a match. */
  totalSessions: number;
  returnedHits: number;
  /** True when totalHits exceeds the returned snippets (some hits not shown). */
  truncated: boolean;
  hits: GrepHit[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exhaustive literal-or-regex match over every indexed message (genuine user turns +
 * assistant text), unlike searchSessions which is ranked and top-k. Each hit carries
 * filePath + msgIndex so it feeds get_session_messages(offset) with no extra lookup.
 * Streams message rows so memory stays O(limit) however large the corpus. Matches the
 * same text corpus as search (message_fts): assistant tool-call inputs are not indexed,
 * so a command string won't be found here — grep prose, navigate to the turn, then read
 * it with include_tools.
 */
export async function grepSessions(pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  if (!pattern) throw new Error('Empty pattern: pass a non-empty string to search for.');

  const db = getDb();
  await ensureIndexFresh();

  const ignoreCase = opts.ignoreCase ?? true;
  // Guard against fractional/negative limits so `hits.length < limit` behaves as a
  // whole-number "max snippets" cap; 0 is allowed (count-only, snippets suppressed).
  const limit = Math.max(0, Math.floor(opts.limit ?? 50));
  const radius = Math.max(0, Math.floor(opts.contextChars ?? 60));

  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? pattern : escapeRegExp(pattern), ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  const conditions: string[] = ['m.msg_index >= 0']; // exclude the subagent sentinel (-1)
  const params: (string | number)[] = [];
  if (opts.role) {
    conditions.push('m.role = ?');
    params.push(opts.role);
  }
  if (opts.tool) {
    conditions.push('s.tool = ?');
    params.push(opts.tool);
  }
  if (opts.project) {
    conditions.push('(s.cwd = ? OR s.cwd GLOB ?)');
    params.push(opts.project, globPrefix(opts.project));
  }
  if (opts.after) {
    conditions.push('s.date >= ?');
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push('s.date <= ?');
    params.push(opts.before);
  }
  // Literal mode: a LIKE filter cuts rows before the JS regex confirms each match — a huge
  // win for rare terms. But SQLite LIKE folds case for ASCII only, while the JS `/i` regex
  // folds Unicode too, so for a case-insensitive pattern containing a non-ASCII letter the
  // LIKE is NOT a superset (`%café%` would drop a stored "CAFÉ" the regex would match).
  // Apply the prefilter only when it's provably a superset: case-sensitive, or ASCII-only
  // pattern. Otherwise stream the full candidate set and let the regex alone decide (as
  // regex mode already does). Regex mode is never prefiltered.
  const asciiOnly = ![...pattern].some((ch) => ch.codePointAt(0)! > 0x7f);
  if (!opts.regex && (!ignoreCase || asciiOnly)) {
    conditions.push("m.text LIKE '%' || ? || '%' ESCAPE '\\'");
    params.push(pattern.replace(/[\\%_]/g, (c) => `\\${c}`));
  }

  interface Row {
    filePath: string;
    msgIndex: number;
    role: string;
    text: string;
    tool: string;
    cwd: string;
    date: string;
    sessionId: string;
  }
  const stmt = db.query<Row, any[]>(`
    SELECT m.file_path AS filePath, m.msg_index AS msgIndex, m.role AS role, m.text AS text,
           s.tool AS tool, s.cwd AS cwd, s.date AS date, s.session_id AS sessionId
    FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
    WHERE ${conditions.join(' AND ')}
  `);

  let totalHits = 0;
  const sessions = new Set<string>();
  const hits: GrepHit[] = [];
  for (const row of stmt.iterate(...params)) {
    const m = re.exec(row.text); // non-global regex → always scans from position 0
    if (!m) continue;
    totalHits++;
    sessions.add(row.filePath);
    if (hits.length < limit) {
      const pos = m.index;
      const start = Math.max(0, pos - radius);
      const end = Math.min(row.text.length, pos + m[0].length + radius);
      let snippet = row.text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < row.text.length) snippet = snippet + '…';
      hits.push({
        tool: row.tool as Tool,
        project: row.cwd,
        sessionId: row.sessionId,
        filePath: row.filePath,
        date: row.date,
        role: row.role as 'user' | 'assistant',
        msgIndex: row.msgIndex,
        snippet,
      });
    }
  }

  return {
    totalHits,
    totalSessions: sessions.size,
    returnedHits: hits.length,
    truncated: totalHits > hits.length,
    hits,
  };
}

/**
 * Resolve a session id to its indexed JSONL file path. Refreshes the index
 * first (same as searchSessions) so recently created sessions resolve too.
 * Collisions — the same id indexed from multiple files — pick the newest by
 * mtime. Returns null when the id is unknown.
 */
export async function resolveSessionFile(sessionId: string): Promise<string | null> {
  const db = getDb();
  await ensureIndexFresh();
  const row = db
    .query<{ file_path: string }, [string]>(
      'SELECT file_path FROM sessions WHERE session_id = ? ORDER BY mtime DESC LIMIT 1',
    )
    .get(sessionId);
  return row?.file_path ?? null;
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

function readUserMessages(filePath: string, tool: Tool, mode: 'full' | 'highlights'): string[] {
  const lines = readSessionLines(filePath, tool);
  const msgs = getSessionMessages(lines, tool).filter((m) => m.role === 'user');
  if (msgs.length === 0) return [];

  const cap = (t: string, len: number) => (t.length > len ? t.slice(0, len) + '…' : t);

  if (mode === 'highlights') {
    const result = [cap(msgs[0]!.text, 300)];
    if (msgs.length > 1) result.push(cap(msgs[msgs.length - 1]!.text, 300));
    return result;
  }

  return msgs.slice(0, MAX_USER_MESSAGES).map((m) => cap(m.text, MAX_MESSAGE_LENGTH));
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
  await ensureIndexFresh();

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
            userMessages: readUserMessages(r.file_path, r.tool as Tool, detail),
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

export interface ContextOptions {
  limit?: number; // recent-tier size (default 10)
  days?: number; // optional window (last N days)
  tool?: Tool | ''; // optional tool filter
  worktreeOnly?: boolean; // restrict to current worktree (default false → aggregate)
  headlineCap?: number; // older-tier cap (default 40)
  lessonLimit?: number; // saved-lesson cap (default LESSON_LIMIT)
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
  await ensureIndexFresh();

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

  // Lessons ride the primer rather than a tool of their own: this is the call an
  // agent already makes first, and the hook path injects it mechanically. They come
  // from memory.db, which is never joined to this one — a wrong session costs a
  // wasted read, a wrong lesson costs a wrong belief.
  const lessons = readLessonsForRepo(repo.container, repo.remote, opts.lessonLimit ?? LESSON_LIMIT);

  if (rows.length === 0) {
    return {
      repoLabel,
      toolFilter,
      recent: [],
      headlines: [],
      lessons: lessons.lessons,
      lessonsFlagged: lessons.flagged,
      lessonsTotal: lessons.total,
      lessonsQuarantined: lessons.quarantined,
      // A repo with lessons but no indexed sessions still has something to say — and so
      // does a store that was moved aside, which is the one empty that must be loud.
      isEmpty: lessons.lessons.length === 0 && lessons.flagged === 0 && lessons.quarantined.length === 0,
    };
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

  return {
    repoLabel,
    toolFilter,
    recent,
    headlines,
    lessons: lessons.lessons,
    lessonsFlagged: lessons.flagged,
    lessonsTotal: lessons.total,
    lessonsQuarantined: lessons.quarantined,
    isEmpty: false,
  };
}
