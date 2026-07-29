import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clearCache, getDbPath, searchSessions } from '../cache';
import { removeInstalledFiles } from '../setup';
import { buildRecord } from './record';
import { getMemoryDbPath } from '../paths';
import { getMemoryDb, listMemories, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import { advanceWatermark, readWatermark } from './watermark';
import { MEMORY_SCHEMA_VERSION } from './types';

// This file is the contract's fifth criterion in test form: a triage decision is a
// human judgment no re-mine can reconstruct, so it must survive every path that
// legitimately destroys index.db.

const APPROVED = buildRecord({
  text: 'Never run the deploy script from a laptop, always use the pipeline',
  scope: { type: 'repo', key: '/repos/app' },
  author: 'dev@example.com',
  sessions: ['/s/a.jsonl'],
  dates: ['2026-06-01'],
  distinctPhrasings: 1,
});

let tmp: string;

function seedApprovedMemory(): void {
  upsertCandidates([APPROVED]);
  setState(APPROVED.id, 'approved');
}

beforeAll(() => {
  tmp = makeTmp('memory-durability');
  setMemoryEnv(tmp);
  // Empty source roots so the index has nothing to scan but still builds.
  for (const d of ['claude', 'pi', 'codex']) mkdirSync(join(tmp, d), { recursive: true });
  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  seedApprovedMemory();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory state survives index invalidation', () => {
  test('the store lives outside the cache directory', () => {
    // Structural, not incidental: every invalidation path below unlinks paths under
    // the cache dir, so the store being elsewhere is what makes them survivable.
    expect(getMemoryDbPath().startsWith(join(tmp, 'cache'))).toBe(false);
    expect(getMemoryDbPath()).toBe(join(tmp, 'data', 'memory.db'));
  });

  test('survives --clear-cache', () => {
    clearCache();
    closeDatabases();
    const memory = listMemories();
    expect(memory).toHaveLength(1);
    expect(memory[0]!.state).toBe('approved');
  });

  test('survives the cleanup path removing the installer-owned files', () => {
    // `sessions cleanup` runs runUninstall() then clearCache() (index.ts:28-34).
    // runUninstall also rewrites ~/.claude/.mcp.json and shells out to
    // `claude plugins uninstall`, so a test must never call it — removeInstalledFiles
    // is the only part that touches the data dir, and this asserts its scope.
    const dataDir = join(tmp, 'data');
    mkdirSync(join(dataDir, 'plugin'), { recursive: true });
    mkdirSync(join(dataDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dataDir, 'plugin', 'x.json'), '{}');

    const removed = removeInstalledFiles();
    clearCache();
    closeDatabases();

    expect(removed).toContain(join(dataDir, 'plugin'));
    expect(existsSync(join(dataDir, 'plugin'))).toBe(false);
    expect(existsSync(getMemoryDbPath())).toBe(true);
    expect(listMemories()[0]!.state).toBe('approved');
  });

  test('survives a forced index.db deletion', () => {
    rmSync(getDbPath(), { force: true });
    closeDatabases();
    expect(listMemories()[0]!.state).toBe('approved');
  });

  test('survives the index corruption self-heal', async () => {
    // getDb() deletes and rebuilds a corrupt index (src/cache.ts:216-222). That is
    // correct for a re-derivable cache and would be catastrophic here.
    mkdirSync(dirname(getDbPath()), { recursive: true });
    writeFileSync(getDbPath(), 'this is definitely not a database');
    closeDatabases();
    await searchSessions('anything', {});
    closeDatabases();
    expect(listMemories()[0]!.state).toBe('approved');
  });
});

describe('store schema handling', () => {
  test('a user_version mismatch migrates instead of dropping', () => {
    const db = getMemoryDb();
    db.run('PRAGMA user_version = 0');
    closeDatabases();

    const reopened = getMemoryDb();
    expect(listMemories()[0]!.state).toBe('approved');
    expect(reopened.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      MEMORY_SCHEMA_VERSION,
    );
  });

  test('a pre-always_on store gains the column without losing a row', () => {
    // The real upgrade path. A Phase 1 store already reports user_version = 1, so a
    // migration gated on the version number would skip it entirely and every
    // listMemories() would then fail with `no such column: always_on`. The column is
    // dropped here to reconstruct that store exactly, which no other test does.
    const db = getMemoryDb();
    // The index has to go first — SQLite refuses to drop a column one references, which
    // is itself the reason the CREATE INDEX sits after the ALTER in migrate().
    db.run('DROP INDEX IF EXISTS idx_memory_always_on');
    db.run('ALTER TABLE memory DROP COLUMN always_on');
    expect(db.query<{ name: string }, []>('PRAGMA table_info(memory)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'always_on' }),
    );
    closeDatabases();

    const reopened = getMemoryDb();
    expect(reopened.query<{ name: string }, []>('PRAGMA table_info(memory)').all()).toContainEqual(
      expect.objectContaining({ name: 'always_on' }),
    );
    const row = listMemories()[0]!;
    expect(row.state).toBe('approved');
    expect(row.alwaysOn).toBe(false);
  });

  test('opening an already-migrated store repeatedly is a no-op, not a duplicate column', () => {
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 1785329334744.8967, size: 205 }]);
    for (let i = 0; i < 3; i++) {
      closeDatabases();
      getMemoryDb();
    }
    expect(listMemories()[0]!.state).toBe('approved');
    // The watermark table is created with IF NOT EXISTS beside `memory`, so repeat
    // opens must neither throw `table already exists` nor reset what it holds.
    expect(readWatermark().get('/s/a.jsonl')!.mtime).toBe(1785329334744.8967);
  });

  test('a user_version = 0 reopen re-runs migrate() against a live watermark table', () => {
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 1, size: 1 }]);
    getMemoryDb().run('PRAGMA user_version = 0');
    closeDatabases();
    expect(readWatermark().size).toBe(1);
  });
});

describe('the mine watermark survives index invalidation', () => {
  // Counter-intuitive and correct: --clear-cache rebuilds the index from the SAME
  // transcript files, which still report the same mtime and size, so the surviving
  // watermark still matches and no spurious re-mine happens. A watermark that lived in
  // index.db would instead re-emit the entire backfill on the next --since-last run.
  test('--clear-cache leaves it intact, so the next incremental mine stays incremental', () => {
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 1785329334744.8967, size: 205 }]);
    clearCache();
    closeDatabases();
    expect(readWatermark().get('/s/a.jsonl')).toEqual({
      filePath: '/s/a.jsonl',
      mtime: 1785329334744.8967,
      size: 205,
    });
  });
});

describe('upsertCandidates', () => {
  test('re-mining a rejected memory refreshes evidence but never resurrects it', () => {
    setState(APPROVED.id, 'rejected');
    const remined = buildRecord({
      text: APPROVED.text,
      scope: { type: 'repo', key: '/repos/app' },
      author: 'dev@example.com',
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-07-01'],
      distinctPhrasings: 1,
    });
    expect(remined.id).toBe(APPROVED.id); // content-addressed: same text, same id
    upsertCandidates([remined]);

    const stored = listMemories()[0]!;
    expect(stored.state).toBe('rejected');
    expect(stored.evidence.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
    expect(stored.evidence.lastSeen).toBe('2026-07-01');
  });

  test('an empty batch is a no-op', () => {
    upsertCandidates([]);
    expect(listMemories()).toHaveLength(1);
  });
});
