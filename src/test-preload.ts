/**
 * Hermeticity by default, applied before any test module loads.
 *
 * Every location in src/paths.ts resolves from `process.env` on each call and is never
 * frozen at import, so pointing the SESSIONS_* vars at a per-run temp dir here is enough
 * to redirect the whole tool — no test-awareness branch anywhere in the shipped code.
 * Until this existed, hermeticity depended on each test file remembering to set
 * SESSIONS_MEMORY_DB / SESSIONS_CACHE_DIR itself, and the discipline had already failed
 * by accident.
 *
 * Wired in via `[test] preload` in bunfig.toml, which applies to `bun test` only —
 * `bun run` (the eval harness, the CLI, the fixture children below) is untouched.
 *
 * A child started with `Bun.spawn` inherits this environment and so is redirected too.
 * A child started with a *scrubbed* env is not, which is what assertNotRealStore() in
 * src/paths.ts is the backstop for: SESSIONS_TEST marks the run, and the two DB openers
 * refuse a real store while it is set.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Re-entrant by design: this module is preloaded, and a test that needs to put the
// environment back (see applyTestEnv) imports it. The root is carried in the env so the
// second evaluation adopts the first one's directory instead of minting a rival.
const inherited = process.env.SESSIONS_TEST_ROOT;

/** The per-run temp root every SESSIONS_* path is redirected into. */
export const testRoot: string = inherited ?? mkdtempSync(join(tmpdir(), 'sessions-test-'));

const testHome = join(testRoot, 'home');
const testData = join(testRoot, 'data');

/**
 * Point every SESSIONS_* location at the run's temp root.
 *
 * Exported because a test that clears or replaces `process.env` has to put the
 * redirection back — deleting the vars in an `afterAll` leaves every later file in the
 * same process aimed at the real store.
 *
 * The three roots below bypass paths.ts and so cannot be reached by redirecting the home
 * dir alone: SESSIONS_OPENCODE_DB (src/opencode.ts) and SESSIONS_CLAUDE_CONFIG_DIR
 * (src/hooks.ts) resolve against a raw homedir(), and the second one is a *write* path
 * into ~/.claude/settings.json.
 */
export function applyTestEnv(): void {
  process.env.SESSIONS_TEST = '1';
  process.env.SESSIONS_TEST_ROOT = testRoot;
  process.env.SESSIONS_HOME = testHome;
  process.env.SESSIONS_DATA_DIR = testData;
  process.env.SESSIONS_MEMORY_DB = join(testData, 'memory.db');
  process.env.SESSIONS_HANDOFF_DIR = join(testData, 'handoff');
  process.env.SESSIONS_CACHE_DIR = join(testRoot, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(testHome, '.claude', 'projects');
  process.env.SESSIONS_PI_DIR = join(testHome, '.pi', 'agent', 'sessions');
  process.env.SESSIONS_CODEX_DIR = join(testHome, '.codex', 'sessions');
  process.env.SESSIONS_CLAUDE_CONFIG_DIR = join(testHome, '.claude');
  process.env.SESSIONS_OPENCODE_DB = join(testHome, 'opencode.db');
}

applyTestEnv();

if (inherited === undefined) {
  mkdirSync(testHome, { recursive: true });
  mkdirSync(testData, { recursive: true });
  // Best effort. A killed test process leaves the directory behind; that is disk litter
  // in $TMPDIR the OS reclaims, not a correctness problem.
  process.on('exit', () => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });
}
