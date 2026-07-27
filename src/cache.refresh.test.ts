import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Two guarantees about the one path every query goes through.
 *
 * A refresh that fails must not re-walk the whole source tree on the next call, and a
 * walk one process just finished must not be repeated by the next process to start. Both
 * are about work not done, so the assertions are on refreshAttempts() — the count of
 * walks actually started — rather than on any result.
 */

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-refresh-'));
const claudeDir = join(fixtureRoot, 'claude');
const piDir = join(fixtureRoot, 'pi');
const codexDir = join(fixtureRoot, 'codex');

// One indexable transcript, so a walk has something to find and the marker is written
// over a non-empty index.
mkdirSync(join(claudeDir, 'project'), { recursive: true });
writeFileSync(
  join(claudeDir, 'project', 'a.jsonl'),
  [
    JSON.stringify({
      type: 'user',
      cwd: '/repo/alpha',
      timestamp: '2026-07-01T10:00:00.000Z',
      message: { role: 'user', content: 'index the marker fixture' },
    }),
    JSON.stringify({
      type: 'assistant',
      cwd: '/repo/alpha',
      timestamp: '2026-07-01T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }),
  ].join('\n'),
);

function setEnv(cacheDir: string, sources: { claude: string } = { claude: claudeDir }): void {
  process.env.SESSIONS_CACHE_DIR = cacheDir;
  process.env.SESSIONS_CLAUDE_DIR = sources.claude;
  process.env.SESSIONS_PI_DIR = piDir;
  process.env.SESSIONS_CODEX_DIR = codexDir;
  process.env.SESSIONS_OPENCODE_DB = join(fixtureRoot, 'absent-opencode.db');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '60000';
  process.env.SESSIONS_REFRESH_BACKOFF_MS = '30000';
}

const cache = await import('./cache');

function freshCacheDir(name: string): string {
  const dir = join(fixtureRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  // closeDb() clears the in-process refresh state, including the failure backoff, so each
  // test starts from the same place. It deliberately does NOT clear refreshAttempts().
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
  delete process.env.SESSIONS_REFRESH_BACKOFF_MS;
});

describe('a failing refresh backs off instead of re-walking the tree on every call', () => {
  test('five consecutive calls attempt the walk once', async () => {
    // A source root whose child entry is a regular file: readdir lists it, and the glob
    // scan of it raises ENOTDIR out of discoverFiles. A real broken root — no stubbing,
    // which this repo has no mechanism for.
    const brokenClaude = join(fixtureRoot, 'broken-claude');
    mkdirSync(brokenClaude, { recursive: true });
    writeFileSync(join(brokenClaude, 'not-a-directory'), 'x');
    setEnv(freshCacheDir('cache-backoff'), { claude: brokenClaude });
    cache.closeDb();

    const before = cache.refreshAttempts();
    await expect(cache.searchSessions('anything', { limit: 1 })).rejects.toThrow();
    // The first caller sees the failure. Every later one is served the last known result
    // instead of paying for a walk that is still broken.
    for (let i = 0; i < 4; i++) {
      expect(await cache.searchSessions('anything', { limit: 1 })).toEqual([]);
    }

    expect(cache.refreshAttempts() - before).toBe(1);
  });

  test('the backoff expires and the walk is attempted again', async () => {
    const brokenClaude = join(fixtureRoot, 'broken-claude-2');
    mkdirSync(brokenClaude, { recursive: true });
    writeFileSync(join(brokenClaude, 'not-a-directory'), 'x');
    setEnv(freshCacheDir('cache-backoff-2'), { claude: brokenClaude });
    process.env.SESSIONS_REFRESH_BACKOFF_MS = '0';
    cache.closeDb();

    const before = cache.refreshAttempts();
    await expect(cache.searchSessions('anything', { limit: 1 })).rejects.toThrow();
    await expect(cache.searchSessions('anything', { limit: 1 })).rejects.toThrow();

    expect(cache.refreshAttempts() - before).toBe(2);
    process.env.SESSIONS_REFRESH_BACKOFF_MS = '30000';
  });
});

describe('a walk one process finished is not repeated by the next', () => {
  const CHILD = join(import.meta.dir, '__fixtures__', 'concurrent-refresh.ts');

  async function runChild(cacheDir: string): Promise<{ attempts: number; code: number; err: string }> {
    const proc = Bun.spawn([process.execPath, 'run', CHILD], {
      env: { ...process.env, SESSIONS_CACHE_DIR: cacheDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { attempts: code === 0 ? (JSON.parse(out) as { attempts: number }).attempts : -1, code, err };
  }

  test('two processes over one cache dir perform exactly one tree walk', async () => {
    const cacheDir = freshCacheDir('cache-marker');
    setEnv(cacheDir);

    const first = await runChild(cacheDir);
    expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: '' });
    expect(first.attempts).toBe(1);

    // Sequential, not simultaneous: the marker is written when a walk finishes, so the
    // claim being tested is that the *next* process to start reads it. Two processes
    // racing would both legitimately miss it.
    const second = await runChild(cacheDir);
    expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: '' });
    expect(second.attempts).toBe(0);
  });

  test('a marker inside the interval also skips the walk for a reopened index in-process', async () => {
    const cacheDir = freshCacheDir('cache-marker-inproc');
    setEnv(cacheDir);
    cache.closeDb();

    const before = cache.refreshAttempts();
    await cache.searchSessions('marker', { limit: 1 });
    expect(cache.refreshAttempts() - before).toBe(1);

    // closeDb() drops _lastRefreshAt with the handle, so the only thing left saying "this
    // index is current" is the marker on disk.
    cache.closeDb();
    await cache.searchSessions('marker', { limit: 1 });
    expect(cache.refreshAttempts() - before).toBe(1);
  });

  test('an expired marker still permits a walk, and a future-dated one counts as expired', async () => {
    const cacheDir = freshCacheDir('cache-marker-expiry');
    setEnv(cacheDir);
    cache.closeDb();

    const before = cache.refreshAttempts();
    await cache.searchSessions('marker', { limit: 1 });
    expect(cache.refreshAttempts() - before).toBe(1);

    // A clock moved backwards leaves a marker dated in the future. Trusting it would
    // suppress every walk until real time caught up.
    cache.closeDb();
    const db = new Database(join(cacheDir, 'index.db'));
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      'last_refresh_ms',
      String(Date.now() + 3_600_000),
    ]);
    db.close();

    await cache.searchSessions('marker', { limit: 1 });
    expect(cache.refreshAttempts() - before).toBe(2);
  });
});
