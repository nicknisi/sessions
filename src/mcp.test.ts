import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ZodType } from 'zod';
import { version as pkgVersion } from '../package.json';
import { buildRecord } from './memory/record';
import { closeMemoryDb, setState, upsertCandidates } from './memory/store';
import {
  GetActivityDigestOutput,
  GetContextPrimerOutput,
  GetMemoryOutput,
  GetSessionDigestOutput,
  GetSessionMessagesOutput,
  GetSessionMetricsOutput,
  GrepSessionsOutput,
  SearchSessionsOutput,
} from './mcp-schemas';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run. So we (re)assert our env and reset the cached DB
// connection before each test — keeping this file hermetic regardless of which other
// cache-importing file (cache.search.test.ts, context.test.ts) ran first or interleaves.
let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');

/**
 * This repo, and therefore a real git repo `resolveRepo` will resolve. Sessions D and E
 * below are indexed under it so `get_context_primer` has something to return — a temp
 * mkdtemp dir is not a repo, and calling the primer against one only ever exercises the
 * not-a-repo sentinel.
 *
 * realpathSync because git reports `--show-toplevel` resolved (macOS /var -> /private/var),
 * and `getContextPrimer` matches the indexed `cwd` against that resolved container exactly.
 */
const REPO_ROOT = realpathSync(join(import.meta.dir, '..'));

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  // Required now that tools/call reaches get_memory from this file: without it the memory
  // store would open (and create) the developer's real ~/.local/share/sessions/memory.db.
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data');
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

  // Sessions D and E: cwd is THIS repo, so get_context_primer resolves it and returns a
  // populated primer instead of a sentinel. Two of them, and E is trivia (2 messages, no
  // edits, no artifact) while D is substantive — so with `limit: 1` D fills the detail
  // tier and E is demoted into headlines, putting BOTH primer arrays under real data.
  //
  // D also carries 5 messages on purpose: getActivityDigest only builds sessionDetails
  // for rows with message_count > 3 (src/cache.ts:1081-1083), and the fattest of A/B/C
  // has 3 — so without D the digestSessionDetail schema is never exercised with an element.
  //
  // Nothing here may collide with the A/B/C assertions above: no 'kubectl', no 'flaky',
  // no 'mangowurzel', no 'src/billing.ts', and no errored tool results.
  writeFileSync(
    join(dir, 'd.jsonl'),
    [
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-04T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'bound the unbounded payload arrays' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${REPO_ROOT}/src/cap-audit.ts` } }],
        },
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:02:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${REPO_ROOT}/src/primer-cap.ts` } }],
        },
      }),
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-04T10:03:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'now measure the serialized size' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:04:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the capped payload is a fifth of the size' }] },
      }),
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'e.jsonl'),
    [
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-05T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'you around?' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-05T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'yes' }] },
      }),
    ].join('\n'),
  );

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();

  // One approved memory scoped to /repoA. Without it get_memory's conformance call hits
  // the empty-store sentinel, and its populated projection (text / kind / scope) is never
  // validated through tools/call — the empty payload has the same shape either way.
  // Repo-scoped, not workflow-scoped, so it cannot leak into the empty-index block below
  // (which uses its own SESSIONS_DATA_DIR and a cwd of /nowhere).
  const memory = buildRecord({
    text: 'Always run bun run typecheck before opening a pull request',
    scope: { type: 'repo', key: '/repoA' },
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
  upsertCandidates([memory]);
  setState(memory.id, 'approved');
  closeMemoryDb();

  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
  closeMemoryDb();
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  closeMemoryDb();
  rmSync(tmp, { recursive: true, force: true });
});

test('search_sessions handler returns metadata + resumeCommand', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' });
  // { results, count } envelope: structuredContent must be a JSON object, not an array.
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.count).toBe(parsed.results.length);
  expect(parsed.results[0].commands).toContain('kubectl apply');
  expect(parsed.results[0].resumeCommand).toContain('claude --resume');
});

test('search_sessions handler honors the errored filter', async () => {
  const res = await mcp.runSearchSessions({ errored: true });
  expect(res.content[0]!.text).toContain('No sessions found'); // session A did not error
});

// ——— message-granularity (schema v7) tests — additive ———

test('alignment: messageHits[0].index feeds get_session_messages(offset) to the matched text', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel' });
  const parsed = JSON.parse(res.content[0]!.text);
  const hit = parsed.results[0].messageHits[0];
  expect(hit.index).toBe(2);
  expect(hit.role).toBe('assistant');

  const page = await mcp.runGetSessionMessages({ filePath: parsed.results[0].filePath, offset: hit.index, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.returned).toBe(1);
  expect(paged.messages[0].text).toContain('mangowurzel');
});

test('search_sessions: a metadata-only match carries empty messageHits', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' }); // lives only in commands
  const parsed = JSON.parse(res.content[0]!.text);
  const a = parsed.results.find((r: { sessionId: string }) => r.sessionId === 'a');
  expect(a.messageHits).toEqual([]);
});

// ——— files filter (phase 3) tests — additive ———

test('search_sessions: files param reaches SearchOptions; result shape unchanged', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/billing.ts'] });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.results.map((r: { sessionId: string }) => r.sessionId)).toEqual(['c']); // a and b excluded
  expect(parsed.results[0].files).toContain('/repoC/src/billing.ts');
  expect(parsed.results[0].resumeCommand).toContain('claude --resume'); // shape unchanged
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

// ——— grep_sessions — additive ———

test('grep_sessions: exhaustive hit carries msgIndex that feeds get_session_messages', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'flaky' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.totalHits).toBe(1);
  expect(parsed.totalSessions).toBe(1);
  const hit = parsed.hits[0];
  expect(hit.sessionId).toBe('b');
  expect(hit.role).toBe('user');
  expect(hit.resumeCommand).toContain('claude --resume');

  const page = await mcp.runGetSessionMessages({ filePath: hit.filePath, offset: hit.msgIndex, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.messages[0].text).toContain('flaky');
});

test('grep_sessions: regex mode matches an assistant turn', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'mango\\w+', regex: true });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.hits[0].role).toBe('assistant');
  expect(parsed.hits[0].msgIndex).toBe(2);
});

test('grep_sessions: no match returns a friendly message', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'nonexistent-term-xyz' });
  expect(res.content[0]!.text).toContain('No matching messages found');
});

test('grep_sessions: an invalid regex surfaces isError', async () => {
  const res = await mcp.runGrepSessions({ pattern: '(unclosed', regex: true });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Invalid regex');
});

// ——— get_session_messages include_tools — additive ———

test('get_session_messages include_tools renders the turn tool calls', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1, includeTools: true });
  const parsed = JSON.parse(res.content[0]!.text);
  // Session C's Edit is a pure-tool-use turn folded onto the user turn (index 0).
  expect(parsed.messages[0].tools).toContain('Edit(/repoC/src/billing.ts)');
});

test('get_session_messages omits tools by default (back-compat shape)', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1 });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.messages[0].tools).toBeUndefined();
});

// ——— pi fork surfaces (pi first-class phase 2) — additive ———

function writePiFixture(id: string, records: Record<string, unknown>[]): string {
  const dir = join(tmp, 'pi', 'proj');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => j(r)).join('\n'));
  return file;
}

// Pi fixture shapes mirror src/parser.test.ts: id/parentId on every line, the header
// is the root, the header-adjacent model_change has parentId: null.
const piHeader = (extra: Record<string, unknown> = {}) => ({
  type: 'session',
  id: 's1',
  timestamp: '2026-08-04T17:00:00.000Z',
  cwd: '/repoPi',
  ...extra,
});
const piModelChange = { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-08-04T17:00:01.000Z' };
const piUser = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:01:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const piAssistant = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:02:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

// The canonical one-fork shape: /tree hops back to u1 (abandoning u2/a2), then back
// to a1 to resume the live conversation. 6 extracted messages, 1 fork marker.
function branchedPiRecords(): Record<string, unknown>[] {
  return [
    piHeader(),
    piModelChange,
    piUser('u1', 'm1', 'first question'),
    piAssistant('a1', 'u1', 'first answer'),
    piUser('u2', 'u1', 'hello world'),
    piAssistant('a2', 'u2', 'abandoned answer'),
    piUser('u3', 'a1', 'the real follow-up'),
    piAssistant('a3', 'u3', 'the live answer'),
  ];
}

const PI_PARENT = '/Users/dev/.pi/agent/sessions/--repoPi--/parent-file.jsonl';

test('search_sessions: pi results carry branches and a basename-only forkedFrom', async () => {
  writePiFixture('pibranch', branchedPiRecords());
  writePiFixture('pifork', [piHeader({ parentSession: PI_PARENT }), piModelChange, piUser('u1', 'm1', 'continued')]);
  await cache.refreshIndex();
  const res = await mcp.runSearchSessions({ tool: 'pi' });
  const parsed = JSON.parse(res.content[0]!.text);
  const byId = new Map<string, Record<string, unknown>>(parsed.results.map((r: Record<string, unknown>) => [r.sessionId as string, r]));
  expect(byId.get('pibranch')).toMatchObject({ branches: 1, forkedFrom: '' });
  // Basename only — agents don't need (and shouldn't act on) the absolute parent path.
  expect(byId.get('pifork')).toMatchObject({ branches: 0, forkedFrom: 'parent-file.jsonl' });
});

test('get_session_messages: the fork marker is a field on the branch\'s first message; total unchanged', async () => {
  const file = writePiFixture('pimarkers', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 20 });
  const parsed = JSON.parse(res.content[0]!.text);
  // The core invariant: a marker is a FIELD, never a synthetic message row — `total`
  // must equal the unbranched message count, or every search-hit offset drifts.
  expect(parsed.total).toBe(6);
  const msgs = parsed.messages;
  expect(msgs.map((m: Record<string, unknown>) => m.branch ?? '')).toEqual([
    '',
    '',
    'abandoned',
    'abandoned',
    '',
    '',
  ]);
  expect(msgs.filter((m: Record<string, unknown>) => m.fork)).toHaveLength(1);
  // The marker hangs on the branch's first message (index 2) and names the active
  // message it forked from (index 0, from u1).
  expect(msgs[2].fork).toMatchObject({ fromIndex: 0, abandonedCount: 2, firstUserText: 'hello world' });
  expect(msgs[2].fork.marker).toBe('⑂ forked from msg #0 — abandoned branch, 2 messages: "hello world"');
  // Active messages carry no branch/fork keys at all (zero token cost).
  expect('branch' in msgs[0]).toBe(false);
  expect('fork' in msgs[0]).toBe(false);
});

test('get_session_messages: markers and branch fields appear with includeTools on too', async () => {
  const file = writePiFixture('pimarkers2', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 20, includeTools: true });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.total).toBe(6);
  expect(parsed.messages[2].branch).toBe('abandoned');
  expect(parsed.messages[2].fork.marker).toContain('⑂ forked from msg #0');
});

test('get_session_messages: an offset landing exactly on a fork marker returns the marked message first', async () => {
  const file = writePiFixture('pimarkers3', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 2, limit: 1 });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.returned).toBe(1);
  expect(parsed.messages[0].text).toBe('hello world');
  expect(parsed.messages[0].fork.marker).toContain('abandoned branch');
});

test('schema conformance: fork fields survive tools/call output validation (not zod-stripped)', async () => {
  const file = writePiFixture('pimarkers4', branchedPiRecords());
  writePiFixture('pifork2', [piHeader({ parentSession: PI_PARENT }), piModelChange, piUser('u1', 'm1', 'continued')]);
  await cache.refreshIndex();
  const client = await connect();

  const msgRes = await client.callTool({ name: 'get_session_messages', arguments: { filePath: file } });
  expect(msgRes.isError).toBeFalsy();
  expect(conforms('get_session_messages', GetSessionMessagesOutput, msgRes.structuredContent)).toBe('ok');
  const msgs = GetSessionMessagesOutput.parse(msgRes.structuredContent);
  expect(msgs.messages[2]!.branch).toBe('abandoned');
  expect(msgs.messages[2]!.fork?.marker).toContain('abandoned branch');

  const searchRes = await client.callTool({ name: 'search_sessions', arguments: { tool: 'pi' } });
  expect(searchRes.isError).toBeFalsy();
  expect(conforms('search_sessions', SearchSessionsOutput, searchRes.structuredContent)).toBe('ok');
  const search = SearchSessionsOutput.parse(searchRes.structuredContent);
  const forked = search.results.find((r) => r.sessionId === 'pifork2');
  expect(forked?.forkedFrom).toBe('parent-file.jsonl');
  expect(search.results.find((r) => r.sessionId === 'pimarkers4')?.branches).toBe(1);
  await client.close();
});

// ——— stdio lifecycle ———

test('server exits when the client closes stdin instead of lingering as an orphan', async () => {
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '..', 'index.ts'), '--mcp'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );
  await proc.stdin.flush();
  // Wait for the initialize response so the transport is fully wired before we hang up.
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  proc.stdin.end(); // simulate the parent client dying
  const result = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'orphaned' as const)]);
  if (result === 'orphaned') proc.kill();
  expect(result).toBe(0);
}, 15000);

// ——— protocol surface (phase 1) tests — additive ———
//
// Everything below goes through tools/list and tools/call over the SDK's in-memory
// transport, because that is the ONLY path that runs the SDK's output validation. The
// run* seams asserted above bypass it, so a tool whose structuredContent does not match
// its declared outputSchema would ship green without these.
//
// Mind what a failure looks like here: the SDK does not reject. McpServer catches its own
// McpError and returns an ordinary result with isError:true, so "the call did not throw"
// is a vacuous assertion that stays green even when every tool is broken. Asserting
// isError is falsy AND that the declared schema parses structuredContent is the real test.

async function connect(): Promise<Client> {
  const server = mcp.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sessions-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const TOOL_NAMES = [
  'get_activity_digest',
  'get_context_primer',
  'get_memory',
  'get_session_digest',
  'get_session_messages',
  'get_session_metrics',
  'grep_sessions',
  'search_sessions',
];

/** Fold the failure detail into the compared value: a bare `success` boolean tells you a
 *  tool drifted from its schema but not which field. */
function conforms(name: string, schema: ZodType, structuredContent: unknown): string {
  const parsed = schema.safeParse(structuredContent);
  return parsed.success ? 'ok' : `${name}: ${parsed.error.message}`;
}

test('version: the server reports the package.json version, not a hardcoded literal', async () => {
  const client = await connect();
  const info = client.getServerVersion();
  expect(info?.name).toBe('sessions');
  expect(info?.version).toBe(pkgVersion);
  expect(info?.version).not.toBe('1.2.0'); // the stale literal this replaced
  await client.close();
});

test('tool surface: 8 tools, each with a title, annotations, and an object outputSchema', async () => {
  const client = await connect();
  const { tools } = await client.listTools();

  // A name list, not a count: a count is also satisfied by leaving a tool un-annotated.
  expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);

  for (const t of tools) {
    expect(typeof t.title).toBe('string');
    expect(t.title!.length).toBeGreaterThan(0);
    expect(t.description!.length).toBeGreaterThan(80); // the tuned prose survived the migration
    expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // A top-level-array outputSchema is dropped from tools/list without a word of
    // warning, so presence here is the cheap tripwire for the envelope mistake.
    expect(t.outputSchema).toBeDefined();
    expect(t.outputSchema!.type).toBe('object');
  }
  await client.close();
});

test('tool surface: two createServer() instances in one process both connect', async () => {
  const a = await connect();
  const b = await connect();
  expect((await a.listTools()).tools).toHaveLength(8);
  expect((await b.listTools()).tools).toHaveLength(8);
  await a.close();
  await b.close();
});

describe('input bounds', () => {
  // Payload size is the whole point of this surface, and a DEFAULT does not bound anything:
  // the caller is a model reading a `describe()` string, and it can pass whatever number it
  // likes. `limit: -1` is the sharpest case — SQLite reads a negative LIMIT as no limit at
  // all, so the one value that looks like it must return nothing returned the entire index.
  // These go over the protocol on purpose: the run* seams take a plain number and never see
  // the input schema, so they cannot cover this.

  /**
   * The refusal an input-schema violation produces, as seen by the client.
   *
   * The SDK does NOT reject the request: it catches the zod error and returns a normal
   * result carrying `isError: true` and the -32602 text. Asserting on a rejection would
   * therefore pass for any tool that merely threw, and fail for the behavior we want.
   */
  async function refused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect({ tool: name, args, isError: res.isError }).toEqual({ tool: name, args, isError: true });
    // Structurally an input rejection, not a handler that happened to fail downstream.
    expect(text).toMatch(/-32602|Input validation error/);
    return text;
  }

  test('search_sessions refuses limit: -1 instead of returning the whole index', async () => {
    const client = await connect();
    // Not a wrong-shape complaint: this exact call used to succeed and return every row,
    // because SQLite reads `LIMIT -1` as no limit.
    expect(await refused(client, 'search_sessions', { limit: -1 })).toMatch(/Too small|>=1/);
    await client.close();
  });

  test('search_sessions refuses a limit above the ceiling, and accepts the ceiling itself', async () => {
    const client = await connect();
    expect(await refused(client, 'search_sessions', { limit: mcp.MAX_SEARCH_RESULTS + 1 })).toMatch(/Too big|<=/);

    const ok = await client.callTool({ name: 'search_sessions', arguments: { limit: mcp.MAX_SEARCH_RESULTS } });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  test('a fractional limit is refused rather than left to value coercion', async () => {
    const client = await connect();
    expect(await refused(client, 'search_sessions', { limit: 2.5 })).toMatch(/int/i);
    await client.close();
  });

  test('every paged tool bounds its size, not just search_sessions', async () => {
    const client = await connect();
    const sessionB = join(tmp, 'claude', 'proj', 'b.jsonl');
    const overs: { name: string; args: Record<string, unknown> }[] = [
      { name: 'grep_sessions', args: { pattern: 'retry', limit: mcp.MAX_GREP_HITS + 1 } },
      { name: 'grep_sessions', args: { pattern: 'retry', limit: -1 } },
      { name: 'get_session_messages', args: { filePath: sessionB, limit: mcp.MAX_MESSAGES_PER_PAGE + 1 } },
      // A negative offset reads from the END of the transcript through slice()'s
      // wraparound — a different page than the one the caller asked for, silently.
      { name: 'get_session_messages', args: { filePath: sessionB, offset: -5 } },
      { name: 'get_context_primer', args: { cwd: REPO_ROOT, limit: mcp.MAX_PRIMER_RECENT + 1 } },
      { name: 'get_context_primer', args: { cwd: REPO_ROOT, days: 0 } },
    ];
    for (const { name, args } of overs) await refused(client, name, args);
    await client.close();
  });

  test('the declared ceilings reach the client in tools/list, so a model can read them', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const limitOf = (name: string): Record<string, unknown> =>
      (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Record<string, unknown>>).limit!;

    expect(limitOf('search_sessions')).toMatchObject({ type: 'integer', minimum: 1, maximum: mcp.MAX_SEARCH_RESULTS });
    expect(limitOf('grep_sessions')).toMatchObject({ maximum: mcp.MAX_GREP_HITS });
    expect(limitOf('get_session_messages')).toMatchObject({ maximum: mcp.MAX_MESSAGES_PER_PAGE });
    expect(limitOf('get_context_primer')).toMatchObject({ maximum: mcp.MAX_PRIMER_RECENT });
    // The default has to survive the added bounds — it is what an omitted limit means.
    expect(limitOf('search_sessions')).toMatchObject({ default: 20 });
    await client.close();
  });

  test('the producer clamps too, for every caller that is not an input schema', async () => {
    // cache.searchSessions is a library function the CLI calls with 1,000 and is right to.
    // The floor is against nonsense, not against large: -1 must not mean "unlimited".
    const all = await cache.searchSessions('', {});
    expect(all.length).toBeGreaterThan(1); // the fixture really does hold more than one row
    expect(await cache.searchSessions('', { limit: -1 })).toHaveLength(1);
    expect(await cache.searchSessions('', { limit: Number.NaN })).toHaveLength(all.length);
    expect(await cache.searchSessions('retry', { limit: -1 })).toHaveLength(1); // the FTS branch too
  });
});

test('schema conformance: every tool validates against its declared outputSchema', async () => {
  const client = await connect();
  const sessionB = join(tmp, 'claude', 'proj', 'b.jsonl');
  const calls: { name: string; args: Record<string, unknown>; schema: ZodType }[] = [
    { name: 'get_memory', args: { cwd: '/repoA' }, schema: GetMemoryOutput },
    // 'retry' rather than 'kubectl': it matches message text, so messageHits comes back
    // with elements. 'kubectl' lives only in a command, and an all-empty messageHits
    // leaves the nested messageHit shape unvalidated.
    { name: 'search_sessions', args: { query: 'retry' }, schema: SearchSessionsOutput },
    { name: 'grep_sessions', args: { pattern: 'flaky' }, schema: GrepSessionsOutput },
    { name: 'get_session_messages', args: { filePath: sessionB }, schema: GetSessionMessagesOutput },
    { name: 'get_session_digest', args: { filePath: sessionB }, schema: GetSessionDigestOutput },
    {
      name: 'get_activity_digest',
      args: { startDate: '2026-06-01', endDate: '2026-06-30', detail: 'highlights' },
      schema: GetActivityDigestOutput,
    },
    {
      name: 'get_session_metrics',
      args: { startDate: '2026-06-01', endDate: '2026-06-30' },
      schema: GetSessionMetricsOutput,
    },
    // REPO_ROOT, not `tmp`: a bare mkdtemp dir is not a git repo, so resolveRepo returns
    // null there and this "populated" call would silently re-test the not-a-repo sentinel.
    // limit:1 splits sessions D and E across the two tiers so recent[] AND headlines[]
    // both carry elements.
    { name: 'get_context_primer', args: { cwd: REPO_ROOT, limit: 1 }, schema: GetContextPrimerOutput },
  ];
  expect(calls.map((c) => c.name).sort()).toEqual(TOOL_NAMES); // no tool quietly skipped

  const got = new Map<string, unknown>();
  for (const { name, args, schema } of calls) {
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(conforms(name, schema, res.structuredContent)).toBe('ok');
    // The text block is the same payload, for clients that ignore structured output.
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    if (text.startsWith('{')) expect(JSON.parse(text)).toEqual(res.structuredContent);
    got.set(name, res.structuredContent);
  }

  // Non-vacuity. Every array in mcp-schemas.ts admits `[]` — it has to, or the sentinel
  // paths would throw — so 'ok' above is also what a call that quietly returned its empty
  // payload reports. Without these assertions the nested shapes (messageHit,
  // digestSessionDetail, the primer's recent/headlines) are never validated against real
  // data, which is exactly the schema-drift risk this file exists to catch.
  const search = SearchSessionsOutput.parse(got.get('search_sessions'));
  expect(search.results.length).toBeGreaterThan(0);
  expect(search.results.flatMap((r) => r.messageHits ?? []).length).toBeGreaterThan(0);

  expect(GetMemoryOutput.parse(got.get('get_memory')).results.length).toBeGreaterThan(0);
  expect(GrepSessionsOutput.parse(got.get('grep_sessions')).hits.length).toBeGreaterThan(0);
  expect(GetSessionMessagesOutput.parse(got.get('get_session_messages')).messages.length).toBeGreaterThan(0);
  expect(GetSessionDigestOutput.parse(got.get('get_session_digest')).exchanges.length).toBeGreaterThan(0);

  const digest = GetActivityDigestOutput.parse(got.get('get_activity_digest'));
  const details = digest.days.flatMap((d) => d.projects.flatMap((p) => p.sessionDetails ?? []));
  expect(details.length).toBeGreaterThan(0); // detail:'highlights' needs a >3-message row

  const metrics = GetSessionMetricsOutput.parse(got.get('get_session_metrics'));
  expect(metrics.projectBreakdown.length).toBeGreaterThan(0);
  expect(metrics.dailyActivity.length).toBeGreaterThan(0);

  const primer = GetContextPrimerOutput.parse(got.get('get_context_primer'));
  expect(primer.isEmpty).toBe(false);
  expect(primer.recent).toHaveLength(1);
  expect(primer.headlines).toHaveLength(1); // session E, demoted out of the detail tier
  // fileCount is the field ContextSession gained in this phase — the one most likely to
  // drift out of the hand-mirrored schema unnoticed.
  expect(primer.recent[0]!.fileCount).toBe(2);
  expect(primer.recent[0]!.files).toHaveLength(2);

  await client.close();
});

describe('empty results', () => {
  // A second, deliberately empty fixture. The outer beforeEach re-points the shared cache
  // module at the POPULATED index before every test, so this block has to take it back in
  // its own beforeEach — otherwise these assertions silently run against real data.
  let emptyTmp: string;
  let loneSession: string;

  function setEmptyEnv(): void {
    process.env.SESSIONS_CACHE_DIR = join(emptyTmp, 'cache');
    process.env.SESSIONS_CLAUDE_DIR = join(emptyTmp, 'claude');
    process.env.SESSIONS_PI_DIR = join(emptyTmp, 'pi');
    process.env.SESSIONS_CODEX_DIR = join(emptyTmp, 'codex');
    process.env.SESSIONS_OPENCODE_DB = join(emptyTmp, 'opencode.db');
    process.env.SESSIONS_DATA_DIR = join(emptyTmp, 'data');
  }

  beforeAll(async () => {
    emptyTmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-empty-'));
    for (const d of ['claude', 'pi', 'codex', 'cache', 'data']) {
      mkdirSync(join(emptyTmp, d), { recursive: true });
    }
    // get_session_messages and get_session_digest read a path directly rather than the
    // index, so their empty case needs a file that exists but yields nothing: one
    // injected (non-genuine) turn produces zero exchanges, and an out-of-range offset
    // produces zero messages.
    loneSession = join(emptyTmp, 'injected-only.jsonl');
    writeFileSync(
      loneSession,
      j({
        type: 'user',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'injected hook context' }] },
        promptSource: null,
      }),
    );
    setEmptyEnv();
    cache.closeDb();
    closeMemoryDb();
    await cache.refreshIndex();
  });

  beforeEach(() => {
    setEmptyEnv();
    cache.closeDb();
    closeMemoryDb();
  });

  afterAll(() => {
    cache.closeDb();
    closeMemoryDb();
    rmSync(emptyTmp, { recursive: true, force: true });
  });

  test('empty results: all 8 tools return a conforming payload alongside their sentinel', async () => {
    const client = await connect();
    const repoRoot = join(import.meta.dir, '..'); // a real git repo with no indexed sessions
    const calls: { name: string; args: Record<string, unknown>; schema: ZodType; text?: string }[] = [
      { name: 'get_memory', args: { cwd: '/nowhere' }, schema: GetMemoryOutput, text: 'No memories for this repo.' },
      // These args deliberately MATCH the populated fixture: 'flaky' and the June range
      // both return data there, so if this block ever loses the empty index to the outer
      // beforeEach these assertions go red instead of passing for the wrong reason.
      { name: 'search_sessions', args: {}, schema: SearchSessionsOutput, text: 'No sessions found.' },
      {
        name: 'grep_sessions',
        args: { pattern: 'flaky' },
        schema: GrepSessionsOutput,
        text: 'No matching messages found.',
      },
      { name: 'get_session_messages', args: { filePath: loneSession, offset: 99 }, schema: GetSessionMessagesOutput },
      { name: 'get_session_digest', args: { filePath: loneSession }, schema: GetSessionDigestOutput },
      {
        name: 'get_activity_digest',
        args: { startDate: '2026-06-01', endDate: '2026-06-30' },
        schema: GetActivityDigestOutput,
        text: 'No sessions found in that date range.',
      },
      {
        name: 'get_session_metrics',
        args: { startDate: '2026-06-01', endDate: '2026-06-30' },
        schema: GetSessionMetricsOutput,
        text: 'No sessions found in that date range.',
      },
      {
        name: 'get_context_primer',
        args: { cwd: repoRoot },
        schema: GetContextPrimerOutput,
        text: 'No past sessions found for this repo.',
      },
    ];
    expect(calls.map((c) => c.name).sort()).toEqual(TOOL_NAMES);

    for (const { name, args, schema, text } of calls) {
      const res = await client.callTool({ name, arguments: args });
      // isError on an empty result would be a validation bypass, not a design.
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toBeDefined();
      expect(conforms(name, schema, res.structuredContent)).toBe('ok');
      // The sentinel prose survives: it tells a model something the payload does not.
      if (text) expect((res.content as { text: string }[])[0]!.text).toBe(text);
    }
    await client.close();
  });

  test('empty results: get_context_primer outside a git repo keeps its own sentinel', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'get_context_primer', arguments: { cwd: emptyTmp } });
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0]!.text).toBe('Not inside a git repository.');
    expect(conforms('get_context_primer', GetContextPrimerOutput, res.structuredContent)).toBe('ok');
    expect(res.structuredContent).toEqual({
      repoLabel: '',
      toolFilter: '',
      recent: [],
      headlines: [],
      memory: [],
      memoryTotal: 0,
      isEmpty: true,
    });
    await client.close();
  });

  test('empty results: a topic miss keeps its own sentence, distinct from the empty store', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: 'get_memory',
      arguments: { cwd: '/nowhere', topic: 'kubernetes helm chart rollout' },
    });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('No memory matched this topic');
    expect(text).not.toBe('No memories for this repo.');
    expect(conforms('get_memory', GetMemoryOutput, res.structuredContent)).toBe('ok');
    await client.close();
  });
});
