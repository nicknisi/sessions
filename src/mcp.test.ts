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
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
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

  // Session B: multi-message session for hit→offset alignment — the unique term
  // sits in the third message (index 2), so a correct offset is load-bearing.
  writeFileSync(
    join(dir, 'b.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'investigate the flaky retry test' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking into it now' }] },
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:02:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'applied the mangowurzel fix to the retry logic' }],
        },
      }),
    ].join('\n'),
  );

  // Session C: files-filter fixture (phase 3) — edits a file no other session touches.
  writeFileSync(
    join(dir, 'c.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'wire up billing' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repoC/src/billing.ts' } }],
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

// ——— message-granularity (schema v7) tests — additive ———

test('alignment: messageHits[0].index feeds get_session_messages(offset) to the matched text', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel' });
  const parsed = JSON.parse(res.content[0]!.text);
  const hit = parsed[0].messageHits[0];
  expect(hit.index).toBe(2);
  expect(hit.role).toBe('assistant');

  const page = await mcp.runGetSessionMessages({ filePath: parsed[0].filePath, offset: hit.index, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.returned).toBe(1);
  expect(paged.messages[0].text).toContain('mangowurzel');
});

test('search_sessions: a metadata-only match carries empty messageHits', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' }); // lives only in commands
  const parsed = JSON.parse(res.content[0]!.text);
  const a = parsed.find((r: { sessionId: string }) => r.sessionId === 'a');
  expect(a.messageHits).toEqual([]);
});

// ——— files filter (phase 3) tests — additive ———

test('search_sessions: files param reaches SearchOptions; result shape unchanged', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/billing.ts'] });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.map((r: { sessionId: string }) => r.sessionId)).toEqual(['c']); // a and b excluded
  expect(parsed[0].files).toContain('/repoC/src/billing.ts');
  expect(parsed[0].resumeCommand).toContain('claude --resume'); // shape unchanged
});

test('search_sessions: a non-matching files filter returns no sessions', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/does-not-exist.ts'] });
  expect(res.content[0]!.text).toContain('No sessions found');
});

// ——— get_session_digest (phase 2) tests — additive ———

test('get_session_digest returns exchange shape within budget', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'claude', 'proj', 'b.jsonl') });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.messageCount).toBe(3);
  expect(digest.exchangeCount).toBe(1);
  expect(digest.elided).toBe(0);
  expect(digest.exchanges).toHaveLength(1);
  expect(digest.exchanges[0].index).toBe(0);
  expect(digest.exchanges[0].user).toContain('investigate the flaky retry test');
  expect(digest.exchanges[0].assistant).toContain('mangowurzel'); // last assistant wins
  expect(JSON.stringify(digest).length).toBeLessThanOrEqual(8000);
});

test('get_session_digest flags unreadable files with isError', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'nope', 'missing.jsonl') });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Could not read session');
});

test('get_session_digest returns empty exchanges for sessions with no genuine turns', async () => {
  // Standalone fixture outside the scanned dirs — the digest reads files directly.
  const file = join(tmp, 'hook-only.jsonl');
  writeFileSync(
    file,
    [
      j({
        type: 'user',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'injected hook context' }] },
        promptSource: null,
      }),
    ].join('\n'),
  );
  const res = await mcp.runGetSessionDigest({ filePath: file });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.exchanges).toEqual([]);
  expect(digest.messageCount).toBe(1);
});
