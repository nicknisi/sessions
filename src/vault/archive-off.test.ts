import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SESSIONS_ARCHIVE=0 is the vault's off switch, set by the curl one-liner so a
// one-off `wrapped` leaves no durable copy of the user's transcripts behind. The
// index still builds; only the archive is skipped.

let tmp: string;
let cache: typeof import('../cache');
const saved = { ...process.env };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-archive-off-'));
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  delete process.env.SESSIONS_PI_EXTRA_DIRS;
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1';
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  process.env.SESSIONS_ARCHIVE = '0';
  mkdirSync(join(tmp, 'claude', 'proj'), { recursive: true });
  writeFileSync(
    join(tmp, 'claude', 'proj', 'offvault.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: '/repoOff',
      timestamp: '2026-08-04T10:00:00Z',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'zorblatt one-off run' }] },
    }),
  );
  cache = await import('../cache');
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

test('SESSIONS_ARCHIVE=0 indexes without writing the vault', async () => {
  await cache.refreshIndex();
  const results = await cache.searchSessions('zorblatt', {});
  expect(results.map((r) => r.sessionId)).toContain('offvault');
  const archive = join(tmp, 'archive');
  expect(existsSync(archive) ? readdirSync(archive) : []).toEqual([]);
});
