import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTestEnv } from './test-preload';

/**
 * The one failure that loses data nothing can regenerate: a path that assumes the
 * store is a disposable mirror. Four such paths exist — `sessions uninstall`'s
 * directory removal, `sessions cleanup` (uninstall + clearCache), the index
 * SCHEMA_VERSION drop-and-rebuild, and the index corruption self-heal. Each one runs
 * here for real, against a seeded store, and the lesson has to still be there after.
 */

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-survival-'));
const home = join(fixtureRoot, 'home'); // no .claude/.cursor/.codex → no real tool is touched
const dataDir = join(fixtureRoot, 'data');
const cacheDir = join(fixtureRoot, 'cache');
const memoryDb = join(dataDir, 'memory.db');

function setEnv(): void {
  process.env.SESSIONS_HOME = home;
  process.env.SESSIONS_DATA_DIR = dataDir;
  process.env.SESSIONS_MEMORY_DB = memoryDb;
  process.env.SESSIONS_CACHE_DIR = cacheDir;
  process.env.SESSIONS_CLAUDE_DIR = join(fixtureRoot, 'claude');
  process.env.SESSIONS_PI_DIR = join(fixtureRoot, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(fixtureRoot, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(fixtureRoot, 'opencode.db');
}
setEnv();
mkdirSync(home, { recursive: true });

const mem = await import('./memory');
const setup = await import('./setup');
const cache = await import('./cache');

const LESSON = 'The lesson store lives outside the cache, so a wipe cannot take it.';
const DETAIL = 'src/paths.ts: memory.db hangs off the data dir, never the cache dir.';

interface Snapshot {
  bytes: string;
  mtimeMs: number;
}

function seed(): Snapshot {
  const res = mem.rememberLesson({
    lesson: LESSON,
    detail: DETAIL,
    container: '/repo/alpha',
    remote: 'github.com/nicknisi/alpha',
    source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    now: '2026-07-25T13:00:00.000Z',
  });
  expect(res.outcome).toBe('saved');
  mem.closeMemoryDb(); // flush, so the bytes on disk are the whole story
  return { bytes: readFileSync(memoryDb, 'base64'), mtimeMs: statSync(memoryDb).mtimeMs };
}

function readBack(): void {
  const read = mem.readLessonsForRepo('/repo/alpha', 'github.com/nicknisi/alpha', 5);
  expect(read.lessons.length).toBe(1);
  expect(read.lessons[0]!.lesson).toBe(LESSON);
  expect(read.lessons[0]!.detail).toBe(DETAIL);
}

/** An index.db that a getDb() will have to drop and rebuild, exactly as a SCHEMA_VERSION bump does. */
function seedStaleIndex(): void {
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(cacheDir, 'index.db'));
  db.run('CREATE TABLE IF NOT EXISTS sessions (file_path TEXT PRIMARY KEY)');
  db.run('PRAGMA user_version = 1'); // any value the current build does not recognize
  db.close();
}

beforeEach(() => {
  setEnv();
  mem.closeMemoryDb();
  cache.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

afterAll(() => {
  mem.closeMemoryDb();
  cache.closeDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
  // Restored, not deleted. Deleting these left every later file in the same `bun test`
  // process resolving the developer's real memory.db and index.db — the exact hole the
  // preload closes, reopened by a teardown.
  applyTestEnv();
});

describe('lessons survive every wipe the tool performs', () => {
  test('sessions uninstall removes the plugin and keeps the lessons', () => {
    const before = seed();
    // What setup installs, so uninstall has something of its own to remove.
    mkdirSync(join(dataDir, 'plugin', 'skills'), { recursive: true });
    writeFileSync(join(dataDir, 'plugin', 'skills', 'recall.md'), 'x');
    mkdirSync(join(dataDir, '.claude-plugin'), { recursive: true });

    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    setup.runUninstall();
    err.mockRestore();

    expect(existsSync(join(dataDir, 'plugin'))).toBe(false);
    expect(existsSync(join(dataDir, '.claude-plugin'))).toBe(false);
    expect(existsSync(memoryDb)).toBe(true);
    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
    readBack();
  });

  test('uninstall says where the lessons are instead of deleting them quietly', () => {
    seed();
    const lines: string[] = [];
    const err = spyOn(process.stderr, 'write').mockImplementation((s) => {
      lines.push(String(s));
      return true;
    });
    setup.runUninstall();
    err.mockRestore();

    const out = lines.join('');
    expect(out).toContain('Kept 1 lesson');
    expect(out).toContain(memoryDb);
    expect(out).toContain('not re-derivable');
    expect(out).toContain('sessions lessons export');
  });

  test('sessions cleanup — uninstall plus clearCache — keeps the lessons', () => {
    const before = seed();
    seedStaleIndex();

    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    setup.runUninstall();
    cache.clearCache();
    err.mockRestore();

    expect(existsSync(join(cacheDir, 'index.db'))).toBe(false);
    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
    readBack();
  });

  test('--clear-cache alone does not touch the store', () => {
    const before = seed();
    seedStaleIndex();

    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    cache.clearCache();
    err.mockRestore();

    expect(existsSync(join(cacheDir, 'index.db'))).toBe(false);
    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
    expect(statSync(memoryDb).mtimeMs).toBe(before.mtimeMs);
    readBack();
  });

  test('an index rebuild on a SCHEMA_VERSION mismatch leaves memory.db byte-identical', async () => {
    const before = seed();
    seedStaleIndex();

    // Forces getDb() → openDb(), which sees the version mismatch and drops every
    // index table. index.db is rebuildable; memory.db must not be in its blast radius.
    await cache.searchSessions('anything', { tool: '', project: '', limit: 5 });

    const indexVersion = new Database(join(cacheDir, 'index.db'), { readonly: true });
    expect(indexVersion.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBeGreaterThan(
      1,
    );
    indexVersion.close();

    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
    expect(statSync(memoryDb).mtimeMs).toBe(before.mtimeMs);
    readBack();
  });

  test('the index corruption self-heal deletes the index, never the store', async () => {
    const before = seed();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'index.db'), 'not a sqlite database at all');

    await cache.searchSessions('anything', { tool: '', project: '', limit: 5 });

    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
    readBack();
  });

  test('--purge-lessons without --yes refuses and keeps everything', () => {
    const before = seed();
    const lines: string[] = [];
    const err = spyOn(process.stderr, 'write').mockImplementation((s) => {
      lines.push(String(s));
      return true;
    });
    setup.runUninstall({ purgeLessons: true });
    err.mockRestore();

    expect(lines.join('')).toContain('--yes');
    expect(existsSync(memoryDb)).toBe(true);
    expect(readFileSync(memoryDb, 'base64')).toBe(before.bytes);
  });

  test('--purge-lessons --yes is the only path that deletes them', () => {
    seed();
    // The backup written on every save is a complete second copy. A purge that left it
    // behind would make the warning the user just accepted untrue.
    expect(existsSync(`${memoryDb}.snapshot`)).toBe(true);
    expect(existsSync(join(dataDir, 'lessons.jsonl'))).toBe(true);

    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    setup.runUninstall({ purgeLessons: true, yes: true });
    err.mockRestore();

    expect(existsSync(memoryDb)).toBe(false);
    expect(existsSync(`${memoryDb}.snapshot`)).toBe(false);
    expect(existsSync(`${memoryDb}.snapshot.gen`)).toBe(false);
    expect(existsSync(join(dataDir, 'lessons.jsonl'))).toBe(false);
    expect(mem.readLessonsForRepo('/repo/alpha', 'github.com/nicknisi/alpha', 5).lessons).toEqual([]);
  });
});
