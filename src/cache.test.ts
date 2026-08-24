// src/cache.test.ts
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { asJsonNumber, type JsonObject, type JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run (cache.search.test.ts, cache.metrics.test.ts,
// context.test.ts, mcp.test.ts). So we (re)assert our env and reset the cached DB
// connection before each test — keeping this file hermetic regardless of which other
// cache-importing file ran first or interleaves.
let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive'); // hermetic vault; keep off the real ~/.local/share
}

const piDir = () => join(process.env.SESSIONS_PI_DIR!, 'proj');
const piPath = (id: string) => join(piDir(), `${id}.jsonl`);

// Pi fixture shapes mirror real ~/.pi/agent/sessions files: every line carries
// id/parentId, the session header is the root, and the header-adjacent model_change
// has parentId: null. Same conventions as src/parser.test.ts's pi fixtures.
const piSession = (extra: JsonObject = {}) => ({
  type: 'session',
  id: 's1',
  timestamp: '2026-08-04T17:00:00.000Z',
  cwd: '/repoPi',
  ...extra,
});
const piModelChange = (id: string, parentId: string | null) => ({
  type: 'model_change',
  id,
  parentId,
  timestamp: '2026-08-04T17:00:01.000Z',
});
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

function writePi(id: string, records: JsonObject[]): void {
  mkdirSync(piDir(), { recursive: true });
  writeFileSync(piPath(id), records.map(j).join('\n'));
}

interface LineageRow {
  branches: number;
  fork_points: string;
  forked_from: string;
}

function lineageRow(filePath: string): LineageRow | null {
  // Independent read-only connection (WAL allows concurrent readers) to assert
  // row-level state that the search API alone can't prove.
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    return (
      db
        .query<LineageRow, [string]>('SELECT branches, fork_points, forked_from FROM sessions WHERE file_path = ?')
        .get(filePath) ?? null
    );
  } finally {
    db.close();
  }
}

function ignoredRow(filePath: string): { mtime: number; size: number } | null {
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    return (
      db
        .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM ignored_files WHERE file_path = ?')
        .get(filePath) ?? null
    );
  } finally {
    db.close();
  }
}

const PARENT_PATH = '/Users/dev/.pi/agent/sessions/--repoPi--/parent-file.jsonl';

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cache-lineage-'));
  setEnv();
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // 'branched': the canonical one-fork shape — a /tree hop back to u1 abandons the
  // u2/a2 exchange, then a hop back to a1 resumes the live conversation.
  writePi('branched', [
    piSession(),
    piModelChange('m1', null),
    piUser('u1', 'm1', 'first question'),
    piAssistant('a1', 'u1', 'first answer'),
    piUser('u2', 'u1', 'hello world'),
    piAssistant('a2', 'u2', 'abandoned answer'),
    piUser('u3', 'a1', 'the real follow-up'),
    piAssistant('a3', 'u3', 'the live answer'),
  ]);

  // 'forked': a /fork copy — the header carries parentSession; the chain is linear.
  writePi('forked', [
    piSession({ parentSession: PARENT_PATH }),
    piModelChange('m1', null),
    piUser('u1', 'm1', 'continuing from the parent'),
    piAssistant('a1', 'u1', 'carried context'),
  ]);

  // 'plain': unbranched, not a /fork copy — all defaults.
  writePi('plain', [piSession(), piModelChange('m1', null), piUser('u1', 'm1', 'standalone')]);

  // A Claude session for the non-pi defaults.
  mkdirSync(join(tmp, 'claude', 'proj'), { recursive: true });
  writeFileSync(
    join(tmp, 'claude', 'proj', 'claudeone.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoClaude',
        timestamp: '2026-08-04T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello claude' }] },
        promptSource: 'typed',
      }),
    ].join('\n'),
  );

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

test('lineage: a branched pi session stores the fork count and the PiFork[] JSON verbatim', () => {
  const row = lineageRow(piPath('branched'));
  expect(row).not.toBeNull();
  expect(row!.branches).toBe(1);
  // Round-trip: the stored JSON parses back to the buildPiTree shape, lineIndexes
  // included, so the stretch-tier family view can read it without re-parsing.
  // SAFETY: fork_points is written by the index (sessionLineage) from PiFork objects.
  const forks = JSON.parse(row!.fork_points) as JsonObject[];
  expect(forks).toHaveLength(1);
  expect(forks[0]).toMatchObject({
    fromEntryId: 'u1',
    abandonedCount: 2, // entries u2 + a2
    firstUserText: 'hello world',
    timestamp: '2026-08-04T17:01:00.000Z',
  });
  const lineIndexes = forks[0]!.lineIndexes;
  expect(Array.isArray(lineIndexes)).toBe(true);
  if (!Array.isArray(lineIndexes)) throw new Error('lineIndexes missing');
  expect(lineIndexes.every((n) => asJsonNumber(n) !== undefined)).toBe(true);
});

test('lineage: a /fork copy stores forked_from raw; a normal pi session stores empty', () => {
  expect(lineageRow(piPath('forked'))!.forked_from).toBe(PARENT_PATH);
  expect(lineageRow(piPath('forked'))!.branches).toBe(0);
  expect(lineageRow(piPath('plain'))!.forked_from).toBe('');
});

test('lineage: non-pi sessions store the zero/empty defaults', () => {
  const row = lineageRow(join(tmp, 'claude', 'proj', 'claudeone.jsonl'))!;
  expect(row.branches).toBe(0);
  expect(row.fork_points).toBe('[]');
  expect(row.forked_from).toBe('');
});

test('searchSessions maps branches and forkedFrom onto SessionResult', async () => {
  const r = await cache.searchSessions('', { tool: 'pi' });
  const byId = new Map(r.map((x) => [x.sessionId, x]));
  expect(byId.get('branched')).toMatchObject({ branches: 1, forkedFrom: '' });
  expect(byId.get('forked')).toMatchObject({ branches: 0, forkedFrom: PARENT_PATH });
  expect(byId.get('plain')).toMatchObject({ branches: 0, forkedFrom: '' });
});

test('schema bump: stale rows are recomputed by the drop+rebuild, and ignored_files is re-derived', async () => {
  const path = piPath('branched');
  expect(lineageRow(path)?.branches).toBe(1);

  // Seed the negative cache so the rebuild's treatment of ignored_files is observable.
  const ignoredPath = join(tmp, 'claude', 'proj', 'ignored.jsonl');
  writeFileSync(ignoredPath, JSON.stringify({ type: 'user', timestamp: '2026-08-04T12:00:00Z' }));
  await cache.refreshIndex();
  expect(ignoredRow(ignoredPath)).not.toBeNull();

  // Simulate a stale v9 row: a wrong stored value plus the old schema version.
  cache.closeDb();
  const db = new Database(cache.getDbPath());
  db.run('UPDATE sessions SET branches = 999 WHERE file_path = ?', [path]);
  db.run('PRAGMA user_version = 9');
  db.close();

  // Reopen through the cache: openDb sees the user_version mismatch, drops ALL FOUR
  // tables (ignored_files included — negative-cache entries do NOT survive a rebuild),
  // and the refresh re-parses from the transcripts on disk.
  await cache.refreshIndex();

  // Assert the row EXISTS with the recomputed value: asserting !== 999 alone would
  // pass vacuously on the empty post-drop table.
  expect(lineageRow(path)?.branches).toBe(1);
  // ignored_files was dropped with everything else and re-derived by the refresh.
  expect(ignoredRow(ignoredPath)).not.toBeNull();
});
