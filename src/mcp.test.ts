import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run. So we (re)assert our env and reset the cached DB
// connection before each test — keeping this file hermetic regardless of which other
// cache-importing file (cache.search.test.ts, context.test.ts) ran first or interleaves.
let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-'));
  setEnv();
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: typed "deploy", then ran "kubectl apply". No error.
  writeFileSync(
    join(dir, 'a.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'deploy' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl apply' } }],
        },
      }),
    ].join('\n'),
  );

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();
  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
});

test('search_sessions handler returns metadata + resumeCommand', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed[0].commands).toContain('kubectl apply');
  expect(parsed[0].resumeCommand).toContain('claude --resume');
});

test('search_sessions handler honors the errored filter', async () => {
  const res = await mcp.runSearchSessions({ errored: true });
  expect(res.content[0]!.text).toContain('No sessions found'); // session A did not error
});
