import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts now resolves SESSIONS_* env lazily, but the module instance is shared
// across test files in one `bun test` run. So we (re)assert our env and reset the
// cached DB connection before each test — keeping this file hermetic regardless of
// which other cache-importing file (e.g. context.test.ts) ran first or interleaves.
let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
}

function writeClaude(claudeDir: string, id: string, cwd: string, records: unknown[]): void {
  const dir = join(claudeDir, 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => j({ ...(r as object), cwd })).join('\n');
  writeFileSync(join(dir, `${id}.jsonl`), lines);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cache-'));
  setEnv();
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: ran "docker compose up", Read cache.ts, errored, thinking mentions "memoization".
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'a', '/repoA', [
    {
      type: 'user',
      timestamp: '2026-06-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'set up containers' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'docker compose up' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:02:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repoA/src/cache.ts' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:03:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'use memoization' }] },
    },
    {
      type: 'user',
      timestamp: '2026-06-01T10:04:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] },
    },
  ]);

  // Session B: clean (no error), its only "docker" mention is in thinking.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'b', '/repoB', [
    {
      type: 'user',
      timestamp: '2026-06-02T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'thoughts' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-02T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'maybe docker later' }] },
    },
  ]);

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
});

test('indexes new content: a command query finds the session that ran it', async () => {
  const r = await cache.searchSessions('docker', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});

test('commands and paths are findable: a file-path query matches a Read target', async () => {
  const r = await cache.searchSessions('cache.ts', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});

test('ranking: a command hit outranks a thinking-only hit for the same term', async () => {
  const r = await cache.searchSessions('docker', {});
  const aIdx = r.findIndex((x) => x.sessionId === 'a');
  const bIdx = r.findIndex((x) => x.sessionId === 'b');
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThanOrEqual(0);
  expect(aIdx).toBeLessThan(bIdx); // A (command) ranked above B (thinking)
});

test('errored filter and metadata: only errored sessions, with files/commands/errored populated', async () => {
  const r = await cache.searchSessions('', { errored: true });
  expect(r.map((x) => x.sessionId)).toContain('a');
  expect(r.map((x) => x.sessionId)).not.toContain('b');
  const a = r.find((x) => x.sessionId === 'a')!;
  expect(a.errored).toBe(true);
  expect(a.commands).toContain('docker compose up');
  expect(a.files).toContain('/repoA/src/cache.ts'); // read target surfaced in metadata
});
