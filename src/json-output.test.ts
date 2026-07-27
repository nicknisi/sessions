/**
 * The JSON surface: `sessions search --json`, `sessions context --json`, `--no-refresh`.
 *
 * Almost everything here goes through a real subprocess, because the contract this phase
 * ships is bytes on stdout and an exit code — neither is observable from an in-process
 * call. The two exceptions are the envelope helper (a pure function) and `--no-refresh`'s
 * "walked nothing" claim, which refreshAttempts() answers directly; a timing assertion
 * could not, since phase 1's marker already skips the walk inside the refresh interval.
 *
 * Every spawn passes an explicit `env`. A child started with no `env` option does not see
 * this process's runtime mutations — not the preload's SESSIONS_* redirection and not
 * SESSIONS_TEST — so it would index the developer's real ~/.claude/projects, and
 * assertNotRealStore could not fire for it. It would also pass.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelope, JSON_ENVELOPE_VERSION, type FormattedResult } from './search-format';
import { parseSearchArgs } from './cli';
import { applyTestEnv } from './test-preload';

const repoRoot = join(import.meta.dir, '..');
const corpus = join(import.meta.dir, 'eval', '__fixtures__');
const claudeDir = join(corpus, 'claude');
const piDir = join(corpus, 'pi');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-json-'));
const warmCache = join(fixtureRoot, 'warm-cache');

/** A query the corpus answers, and one it cannot. */
const HIT = 'stripe';
const MISS = 'zzq-no-such-term';

/** Hermetic env for a child: every SESSIONS_* root, not just the two the acceptance
 *  commands name. Leaving SESSIONS_PI_DIR/CODEX_DIR at their real values would let the
 *  operator's own transcripts satisfy `results.length > 0` while proving nothing. */
function childEnv(cacheDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    SESSIONS_CLAUDE_DIR: claudeDir,
    SESSIONS_PI_DIR: piDir,
    SESSIONS_CODEX_DIR: join(fixtureRoot, 'absent-codex'),
    SESSIONS_OPENCODE_DB: join(fixtureRoot, 'absent-opencode.db'),
    SESSIONS_CACHE_DIR: cacheDir,
    SESSIONS_HOME: join(fixtureRoot, 'home'),
    SESSIONS_DATA_DIR: join(fixtureRoot, 'data'),
    SESSIONS_MEMORY_DB: join(fixtureRoot, 'data', 'memory.db'),
    SESSIONS_HANDOFF_DIR: join(fixtureRoot, 'data', 'handoff'),
    SESSIONS_CLAUDE_CONFIG_DIR: join(fixtureRoot, 'home', '.claude'),
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Through the CLI, because the exit code is the contract a caller scripts against. */
async function run(argv: string[], cacheDir: string, cwd: string = repoRoot): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'index.ts'), ...argv], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(cacheDir),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** A cache dir nothing has written to yet — the marker lives inside index.db, so two
 *  cases sharing one dir would have the second skip the walk the first performed. */
function coldCache(name: string): string {
  const dir = join(fixtureRoot, `cold-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function notARepo(name: string): string {
  const dir = join(fixtureRoot, `no-repo-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let cache: typeof import('./cache');

beforeAll(async () => {
  process.env.SESSIONS_CLAUDE_DIR = claudeDir;
  process.env.SESSIONS_PI_DIR = piDir;
  process.env.SESSIONS_CODEX_DIR = join(fixtureRoot, 'absent-codex');
  process.env.SESSIONS_OPENCODE_DB = join(fixtureRoot, 'absent-opencode.db');
  process.env.SESSIONS_CACHE_DIR = warmCache;
  // 0 opts out of both freshness short-circuits, so any walk this file skips was skipped
  // because --no-refresh said so and not because the interval had not elapsed.
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  cache = await import('./cache');
  cache.closeDb();
  await cache.refreshIndex(); // warmCache now holds a real index
});

afterAll(() => {
  // Put the preload's redirection back. Deleting these instead would leave every later
  // file in this process aimed at the operator's real store.
  cache?.closeDb();
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
  applyTestEnv();
});

describe('the envelope is the shape a consumer pins', () => {
  test('generator and version lead, and the payload follows', () => {
    expect(envelope({ query: 'stripe', results: [] })).toEqual({
      generator: 'sessions',
      version: 1,
      query: 'stripe',
      results: [],
    });
  });

  test('the version is the envelope schema, serialized first so it is readable at a glance', () => {
    expect(JSON_ENVELOPE_VERSION).toBe(1);
    expect(JSON.stringify(envelope({ query: 'x' }))).toStartWith('{"generator":"sessions","version":1,');
  });
});

describe('sessions search parses its own flags', () => {
  test('--json and --no-refresh exist here and nowhere else', () => {
    const args = parseSearchArgs(['--json', '--no-refresh', '--here', HIT]);
    expect(args.json).toBe(true);
    expect(args.noRefresh).toBe(true);
    expect(args.scopeHere).toBe(true);
    expect(args.searchQuery).toBe(HIT);
  });

  test('the flags default off, so a plain search is the search it always was', () => {
    const args = parseSearchArgs([HIT]);
    expect(args.json).toBe(false);
    expect(args.noRefresh).toBe(false);
  });
});

describe('search --json is a machine surface', () => {
  test('a query with matches exits 0 and prints one versioned envelope', async () => {
    const res = await run(['search', '--json', HIT], warmCache);

    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      generator: string;
      version: number;
      query: string;
      results: FormattedResult[];
    };
    expect(payload.generator).toBe('sessions');
    expect(payload.version).toBe(JSON_ENVELOPE_VERSION);
    expect(payload.query).toBe(HIT);
    expect(payload.results.length).toBeGreaterThan(0);
    // The full FormattedResult, not a reduced CLI projection.
    expect(payload.results[0]!.resumeCommand).toContain('claude --resume');
    expect(payload.results[0]!.sessionId).toBeTruthy();
  }, 20000);

  test('nothing reaches stderr, so a caller merging both streams still gets JSON', async () => {
    const res = await run(['search', '--json', HIT], warmCache);
    expect(res.stderr).toBe('');
    expect(() => JSON.parse(res.stdout + res.stderr)).not.toThrow();
  }, 20000);

  test('no matches exits 1 and still prints a parseable envelope with an empty array', async () => {
    const res = await run(['search', '--json', MISS], warmCache);

    expect(res.code).toBe(1);
    expect(res.stderr).toBe('');
    const payload = JSON.parse(res.stdout) as { results: unknown[]; query: string };
    expect(payload.results).toEqual([]);
    expect(payload.query).toBe(MISS);
  }, 20000);

  test('an unknown flag exits 2, so "bad flag" is distinguishable from "no matches"', async () => {
    const res = await run(['search', '--json', '--bogus-flag'], warmCache);

    expect(res.code).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unknown option: --bogus-flag');
  }, 20000);

  test('a second bare argument exits 2 rather than silently searching for the last one', async () => {
    const res = await run(['search', '--json', 'stripe', 'webhook'], warmCache);

    expect(res.code).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unexpected argument: webhook');
  }, 20000);

  test('the word "search" stays searchable by writing it twice', async () => {
    const res = await run(['search', '--json', 'search'], warmCache);

    expect([0, 1]).toContain(res.code); // whatever the corpus says; the point is it ran
    expect((JSON.parse(res.stdout) as { query: string }).query).toBe('search');
  }, 20000);

  test('-v inside a search no longer pre-empts the command and prints the version', async () => {
    // Measured before this phase: exit 0, stdout `sessions <version>`, no JSON at all —
    // a query term could replace a script's payload with something that still looked fine.
    const res = await run(['search', '--json', '-v'], warmCache);

    expect(res.code).toBe(2);
    expect(res.stdout).not.toContain('sessions ');
    expect(res.stderr).toContain('unknown option: -v');
  }, 20000);

  test('--clear-cache inside a search does not wipe the index', async () => {
    const res = await run(['search', '--json', '--clear-cache'], warmCache);

    expect(res.code).toBe(2);
    expect(existsSync(join(warmCache, 'index.db'))).toBe(true);
  }, 20000);
});

describe('the bare-query path is untouched', () => {
  test('--json is a search-subcommand flag and the root parser still rejects it', async () => {
    const res = await run(['--json', HIT], warmCache);

    expect(res.code).toBe(1); // the root parser's long-standing die(), not the new 2
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unknown option: --json');
  }, 20000);

  test('a bare query that matches nothing still exits 0, where the subcommand exits 1', async () => {
    const bare = await run([MISS], warmCache);
    const sub = await run(['search', MISS], warmCache);

    expect(bare.code).toBe(0);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toContain('No sessions found.');
    expect(sub.code).toBe(1);
  }, 20000);
});

describe('--no-refresh trades freshness for a guarantee', () => {
  test('the walk is skipped even with the refresh interval pinned to zero', async () => {
    process.env.SESSIONS_CACHE_DIR = warmCache;
    cache.closeDb();

    const before = cache.refreshAttempts();
    const stale = await cache.searchSessions(HIT, { noRefresh: true, limit: 5 });
    expect(cache.refreshAttempts()).toBe(before);
    expect(stale.length).toBeGreaterThan(0); // a stale-but-present index still answers

    // Control: without the flag the same call does walk, so the assertion above is
    // measuring the flag and not an interval that happened to suppress both.
    await cache.searchSessions(HIT, { limit: 5 });
    expect(cache.refreshAttempts()).toBe(before + 1);
  });

  test('context --json --no-refresh against an empty cache dir builds no index at all', async () => {
    const dir = coldCache('context-norefresh');
    const res = await run(['context', '--json', '--no-refresh'], dir);

    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as { generator: string; lessons: unknown[]; isEmpty: boolean };
    expect(payload.generator).toBe('sessions');
    expect(payload.lessons).toEqual([]);
    // Not just "no index.db": getDb() mkdirSyncs the cache dir and creates the file plus a
    // -wal and a -shm before ensureIndexFresh is ever reached, so the flag has to gate the
    // open. A flag that were merely parsed and ignored would leave all three behind.
    expect(readdirSync(dir)).toEqual([]);
  }, 20000);

  test('without the flag the same command does build one', async () => {
    const dir = coldCache('context-refresh');
    const res = await run(['context', '--json'], dir);

    expect(res.code).toBe(0);
    expect(existsSync(join(dir, 'index.db'))).toBe(true);
  }, 20000);

  test('search --json --no-refresh on a cold cache answers empty rather than indexing', async () => {
    const dir = coldCache('search-norefresh');
    const res = await run(['search', '--json', '--no-refresh', HIT], dir);

    expect(res.code).toBe(1);
    expect((JSON.parse(res.stdout) as { results: unknown[] }).results).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  }, 20000);
});

describe('context --json', () => {
  test('emits the primer under the envelope, with the primer fields at the top level', async () => {
    const res = await run(['context', '--json'], coldCache('context-shape'));

    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.generator).toBe('sessions');
    expect(payload.version).toBe(JSON_ENVELOPE_VERSION);
    // `jq '.lessons | length'` is the documented consumer, so these are top-level.
    for (const key of ['repoLabel', 'recent', 'headlines', 'lessons', 'lessonsFlagged', 'isEmpty']) {
      expect(payload).toHaveProperty(key);
    }
  }, 20000);

  test('outside a git repo it prints an empty envelope, never empty stdout', async () => {
    // JSON.parse('') throws, which is what a statusline would have hit.
    const res = await run(['context', '--json'], coldCache('context-norepo'), notARepo('a'));

    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as { isEmpty: boolean; repoLabel: string; lessons: unknown[] };
    expect(payload.isEmpty).toBe(true);
    expect(payload.repoLabel).toBe('');
    expect(payload.lessons).toEqual([]);
  }, 20000);

  test('--json with --hook is refused rather than emitting prose after JSON', async () => {
    const res = await run(['context', '--json', '--hook'], coldCache('context-hook'));

    expect(res.code).toBe(1); // context.ts owns this die(); grep codes are search-only
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json cannot be combined with --hook');
  }, 20000);
});

describe('the CLI and the MCP tool cannot drift', () => {
  test("the CLI envelope's first result deep-equals the MCP handler's", async () => {
    const cliRun = await run(['search', '--json', HIT], warmCache);
    expect(cliRun.code).toBe(0);
    const fromCli = (JSON.parse(cliRun.stdout) as { results: FormattedResult[] }).results[0]!;

    process.env.SESSIONS_CACHE_DIR = warmCache;
    cache.closeDb();
    const { runSearchSessions } = await import('./mcp');
    const mcp = await runSearchSessions({ query: HIT });
    const fromMcp = (JSON.parse(mcp.content[0]!.text) as FormattedResult[])[0]!;

    // Both sides go through formatResult, which is the whole point of reusing it: the
    // MCP's limit of 20 and the CLI's 1000 rank the same corpus the same way.
    expect(fromCli).toEqual(fromMcp);
  }, 20000);
});
