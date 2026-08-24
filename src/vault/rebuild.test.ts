import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { readSessionLines, statSession } from '../session-io';
import { getSessionMessages } from '../parser';
import type { JsonValue } from '../extract-util';

// The vault as a discovery source: a session whose source file is gone (vendor GC)
// must survive index prune, schema-bump rebuilds, and truncated-live-file re-parses,
// staying searchable and readable under its ORIGINAL file_path. Hermetic tmp dirs,
// SESSIONS_* overrides asserted before importing cache (cache.test.ts pattern).

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
let cache: typeof import('../cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode leaks in
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0'; // force a re-index between fixture mutations
}

const claudePath = () => join(tmp, 'claude', 'proj', 'gcme.jsonl');

function writeClaudeSession(): void {
  mkdirSync(join(tmp, 'claude', 'proj'), { recursive: true });
  writeFileSync(
    claudePath(),
    [
      j({
        type: 'user',
        cwd: '/repoGC',
        timestamp: '2026-08-04T10:00:00Z',
        promptSource: 'typed',
        message: { role: 'user', content: [{ type: 'text', text: 'archive me quafflenerd before the vendor GC' }] },
      }),
      j({
        type: 'assistant',
        cwd: '/repoGC',
        timestamp: '2026-08-04T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'archived and durable' }] },
      }),
    ].join('\n'),
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-vault-rebuild-'));
  setEnv();
  for (const d of ['claude', 'pi', 'codex']) mkdirSync(join(tmp, d), { recursive: true });
  writeClaudeSession();
  cache = await import('../cache');
  cache.closeDb();
  await cache.refreshIndex(); // archives the session into the vault
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test('deleting the source keeps the session searchable and readable from the vault', async () => {
  rmSync(claudePath());
  await cache.refreshIndex();

  const results = await cache.searchSessions('quafflenerd', {});
  const hit = results.find((r) => r.sessionId === 'gcme');
  expect(hit).toBeDefined();
  expect(hit!.filePath).toBe(claudePath()); // ORIGINAL identity preserved
  expect(hit!.cwd).toBe('/repoGC');

  // The read seam routes to the vault copy: session-io stats and reads it despite
  // the original path being gone.
  expect(statSession(claudePath(), 'claude')).not.toBeNull();
  const messages = getSessionMessages(readSessionLines(claudePath(), 'claude'));
  expect(messages.some((m) => m.text.includes('quafflenerd'))).toBe(true);
});

test('a full cache drop (index deleted) rebuilds vault-only sessions from the vault', async () => {
  // Source is still gone from the previous test. Drop the entire index.
  cache.clearCache();
  cache.closeDb();
  await cache.refreshIndex();

  const results = await cache.searchSessions('quafflenerd', {});
  expect(results.map((r) => r.sessionId)).toContain('gcme');
});

test('a SCHEMA_VERSION bump drops every table, yet the session returns from the vault', async () => {
  // Simulate a schema migration: bump user_version so openDb drops+rebuilds.
  cache.closeDb();
  const db = new Database(cache.getDbPath());
  db.run('PRAGMA user_version = 9');
  db.close();

  await cache.refreshIndex();
  const results = await cache.searchSessions('quafflenerd', {});
  expect(results.map((r) => r.sessionId)).toContain('gcme');
});

test('a truncated live file falls back to the vault copy instead of being ignored', async () => {
  // Restore a live file first, refresh so it is archived, then corrupt it in place.
  writeClaudeSession();
  await cache.refreshIndex();
  expect((await cache.searchSessions('quafflenerd', {})).map((r) => r.sessionId)).toContain('gcme');

  // Vendor rotated/truncated the live file: valid JSON but no cwd → unusable to parse.
  // A changed mtime+size makes it a candidate again.
  writeFileSync(claudePath(), j({ type: 'user', timestamp: '2026-08-04T10:00:00Z' }));
  const s = statSync(claudePath());
  expect(s.size).toBeGreaterThan(0);
  await cache.refreshIndex();

  // The ignore() path recovered from the vault: still searchable with real content.
  const results = await cache.searchSessions('quafflenerd', {});
  expect(results.map((r) => r.sessionId)).toContain('gcme');
});
