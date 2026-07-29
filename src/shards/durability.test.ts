import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clearCache, getDbPath, searchSessions } from '../cache';
import { removeInstalledFiles } from '../setup';
import { buildRecord } from './record';
import { getShardsDbPath } from '../paths';
import { getShardsDb, listShards, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setShardEnv } from './fixtures';
import { SHARD_SCHEMA_VERSION } from './types';

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

function seedApprovedShard(): void {
  upsertCandidates([APPROVED]);
  setState(APPROVED.id, 'approved');
}

beforeAll(() => {
  tmp = makeTmp('shards-durability');
  setShardEnv(tmp);
  // Empty source roots so the index has nothing to scan but still builds.
  for (const d of ['claude', 'pi', 'codex']) mkdirSync(join(tmp, d), { recursive: true });
  closeDatabases();
});

beforeEach(() => {
  setShardEnv(tmp);
  closeDatabases();
  seedApprovedShard();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('shard state survives index invalidation', () => {
  test('the store lives outside the cache directory', () => {
    // Structural, not incidental: every invalidation path below unlinks paths under
    // the cache dir, so the store being elsewhere is what makes them survivable.
    expect(getShardsDbPath().startsWith(join(tmp, 'cache'))).toBe(false);
    expect(getShardsDbPath()).toBe(join(tmp, 'data', 'shards.db'));
  });

  test('survives --clear-cache', () => {
    clearCache();
    closeDatabases();
    const shards = listShards();
    expect(shards).toHaveLength(1);
    expect(shards[0]!.state).toBe('approved');
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
    expect(existsSync(getShardsDbPath())).toBe(true);
    expect(listShards()[0]!.state).toBe('approved');
  });

  test('survives a forced index.db deletion', () => {
    rmSync(getDbPath(), { force: true });
    closeDatabases();
    expect(listShards()[0]!.state).toBe('approved');
  });

  test('survives the index corruption self-heal', async () => {
    // getDb() deletes and rebuilds a corrupt index (src/cache.ts:216-222). That is
    // correct for a re-derivable cache and would be catastrophic here.
    mkdirSync(dirname(getDbPath()), { recursive: true });
    writeFileSync(getDbPath(), 'this is definitely not a database');
    closeDatabases();
    await searchSessions('anything', {});
    closeDatabases();
    expect(listShards()[0]!.state).toBe('approved');
  });
});

describe('store schema handling', () => {
  test('a user_version mismatch migrates instead of dropping', () => {
    const db = getShardsDb();
    db.run('PRAGMA user_version = 0');
    closeDatabases();

    const reopened = getShardsDb();
    expect(listShards()[0]!.state).toBe('approved');
    expect(reopened.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(
      SHARD_SCHEMA_VERSION,
    );
  });

  test('a pre-always_on store gains the column without losing a row', () => {
    // The real upgrade path. A Phase 1 store already reports user_version = 1, so a
    // migration gated on the version number would skip it entirely and every
    // listShards() would then fail with `no such column: always_on`. The column is
    // dropped here to reconstruct that store exactly, which no other test does.
    const db = getShardsDb();
    // The index has to go first — SQLite refuses to drop a column one references, which
    // is itself the reason the CREATE INDEX sits after the ALTER in migrate().
    db.run('DROP INDEX IF EXISTS idx_shards_always_on');
    db.run('ALTER TABLE shards DROP COLUMN always_on');
    expect(db.query<{ name: string }, []>('PRAGMA table_info(shards)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'always_on' }),
    );
    closeDatabases();

    const reopened = getShardsDb();
    expect(reopened.query<{ name: string }, []>('PRAGMA table_info(shards)').all()).toContainEqual(
      expect.objectContaining({ name: 'always_on' }),
    );
    const row = listShards()[0]!;
    expect(row.state).toBe('approved');
    expect(row.alwaysOn).toBe(false);
  });

  test('opening an already-migrated store repeatedly is a no-op, not a duplicate column', () => {
    for (let i = 0; i < 3; i++) {
      closeDatabases();
      getShardsDb();
    }
    expect(listShards()[0]!.state).toBe('approved');
  });
});

describe('upsertCandidates', () => {
  test('re-mining a rejected shard refreshes evidence but never resurrects it', () => {
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

    const stored = listShards()[0]!;
    expect(stored.state).toBe('rejected');
    expect(stored.evidence.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
    expect(stored.evidence.lastSeen).toBe('2026-07-01');
  });

  test('an empty batch is a no-op', () => {
    upsertCandidates([]);
    expect(listShards()).toHaveLength(1);
  });
});
