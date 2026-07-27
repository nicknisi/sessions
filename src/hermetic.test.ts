import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyTestEnv, testRoot } from './test-preload';
import { closeDb, getIndexDb } from './cache';
import { closeMemoryDb, getMemoryDb } from './memory';
import { getDbPath, getMemoryDbPath } from './paths';

/**
 * The preload (src/test-preload.ts) is what makes every other test file hermetic. This
 * file is the proof that it is on, plus the backstop for the one case a preload cannot
 * reach: a child process started without it.
 *
 * The real stores are named here only to assert they are NOT what gets resolved. Nothing
 * in this file opens them — that is the whole point.
 */
const REAL_MEMORY_DB = join(homedir(), '.local', 'share', 'sessions', 'memory.db');
const REAL_INDEX_DB = join(homedir(), '.cache', 'sessions', 'index.db');

// Other files legitimately point the env at their own fixtures at module scope, and the
// module registry is shared across the run. The claim under test is what the preload
// establishes, so re-establish it first rather than asserting nobody moved it.
beforeEach(() => {
  applyTestEnv();
  closeMemoryDb();
  closeDb();
});

afterEach(() => {
  applyTestEnv();
  closeMemoryDb();
  closeDb();
});

describe('the test preload redirects every durable path away from the real home', () => {
  test('the resolved stores are inside the run temp dir, not the real ones', () => {
    expect(process.env.SESSIONS_TEST).toBe('1');
    expect(getMemoryDbPath().startsWith(testRoot)).toBe(true);
    expect(getDbPath().startsWith(testRoot)).toBe(true);
    expect(getMemoryDbPath()).not.toBe(REAL_MEMORY_DB);
    expect(getDbPath()).not.toBe(REAL_INDEX_DB);
  });

  test('it also covers the roots that bypass paths.ts and resolve against a raw homedir()', async () => {
    // src/opencode.ts and src/hooks.ts read homedir() directly, and the hooks one is a
    // write path into ~/.claude/settings.json.
    const { getOpencodeDbPath } = await import('./opencode');
    expect(getOpencodeDbPath().startsWith(testRoot)).toBe(true);
    expect(process.env.SESSIONS_CLAUDE_CONFIG_DIR!.startsWith(testRoot)).toBe(true);
  });
});

describe('a lost redirection is refused rather than written', () => {
  test('a test that clears the env mid-run still cannot open the real lesson store', () => {
    closeMemoryDb();
    delete process.env.SESSIONS_MEMORY_DB;
    delete process.env.SESSIONS_DATA_DIR;
    delete process.env.SESSIONS_HOME;

    expect(getMemoryDbPath()).toBe(REAL_MEMORY_DB);
    expect(() => getMemoryDb({ create: true })).toThrow('refusing to open the real memory store under test');
  });

  test('the same for the index, and the refusal happens before the directory is created', async () => {
    closeDb();
    delete process.env.SESSIONS_CACHE_DIR;
    delete process.env.SESSIONS_HOME;

    expect(getDbPath()).toBe(REAL_INDEX_DB);
    // getIndexDb() is the shallowest exported route to getDb().
    await expect(getIndexDb()).rejects.toThrow('refusing to open the real index store under test');
  });

  test('a spawned child that kept the test marker but lost the redirection is refused too', async () => {
    // Bun.spawn inherits the environment, so the preload covers a normal child for free.
    // This is the case it cannot cover: an env rebuilt from scratch. SESSIONS_TEST is kept
    // because that is the signal "this is a test run" — a child with a genuinely empty
    // environment is indistinguishable from production and must NOT be refused.
    const child = Bun.spawn(
      [process.execPath, 'run', join(import.meta.dir, '__fixtures__', 'concurrent-remember.ts'), 'A lesson.'],
      {
        env: { SESSIONS_TEST: '1', HOME: homedir(), PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(code).not.toBe(0);
    expect(err).toContain('refusing to open the real memory store under test');
  });
});

describe('a normal run leaves the real stores alone', () => {
  test('nothing under this test process has created either of them', () => {
    // Not "they are unchanged" — a developer machine legitimately has both. The claim is
    // narrower and checkable: whatever this run resolved, it was not these.
    const beforeMemory = existsSync(REAL_MEMORY_DB);
    const beforeIndex = existsSync(REAL_INDEX_DB);

    getMemoryDb({ create: true });
    closeMemoryDb();

    expect(existsSync(REAL_MEMORY_DB)).toBe(beforeMemory);
    expect(existsSync(REAL_INDEX_DB)).toBe(beforeIndex);
    expect(existsSync(getMemoryDbPath())).toBe(true);
  });
});
