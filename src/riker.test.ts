// Riker worker sessions: Pi-format transcripts under <rikerHome>/jobs/<n>/session/.
// Same hermetic harness as src/cache.test.ts — every source root, the cache, the vault,
// and the Riker home point into one temp dir, so neither the real ~/.riker, ~/.pi nor
// ~/.riker/jobs.db is ever read. Transcripts are a header and two short turns.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp: string;
let cache: typeof import('./cache');

const rikerHome = () => join(tmp, 'riker');
const jobSessionPath = (job: number, id: string) => join(rikerHome(), 'jobs', String(job), 'session', `${id}.jsonl`);

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_RIKER_DIR = rikerHome();
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1'; // dead port: keep the semantic lane off a local Ollama
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  delete process.env.SESSIONS_RIKER;
}

/** A minimal Pi transcript: header (cwd = the job worktree), one user turn, one assistant turn with usage. */
function piTranscript(id: string, cwd: string, text: string): string {
  return [
    { type: 'session', id, timestamp: '2026-10-09T17:00:00.000Z', cwd },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-10-09T17:01:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-10-09T17:02:00.000Z',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 10, output: 5 },
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
}

function writeJobSession(job: number, id: string, cwd: string, text: string): string {
  const path = jobSessionPath(job, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, piTranscript(id, cwd, text));
  return path;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-riker-')));
  setEnv();
  cache = await import('./cache');
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
  rmSync(join(tmp, 'cache'), { recursive: true, force: true });
  rmSync(join(tmp, 'archive'), { recursive: true, force: true });
  rmSync(rikerHome(), { recursive: true, force: true });
});

afterAll(() => {
  cache.closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test('index picks up Riker job sessions and ignores log.jsonl, proof/, and other non-session files', async () => {
  const path = writeJobSession(124, 'r1', join(tmp, 'worktrees', '124'), 'zebrafinch migration');
  const jobDir = join(rikerHome(), 'jobs', '124');
  // Riker's own records, shaped like a transcript so only the location keeps them out.
  writeFileSync(join(jobDir, 'log.jsonl'), piTranscript('log', '/x', 'zebrafinch log'));
  mkdirSync(join(jobDir, 'proof'), { recursive: true });
  writeFileSync(join(jobDir, 'proof', 'p.jsonl'), piTranscript('proof', '/x', 'zebrafinch proof'));
  writeFileSync(join(jobDir, 'session', 'notes.txt'), 'zebrafinch');

  const results = await cache.searchSessions('zebrafinch');
  expect(results.map((r) => r.filePath)).toEqual([path]);
  expect(results[0]!.tool).toBe('pi');
});

test('SESSIONS_RIKER=0 takes Riker sessions out of the index, vault copies included', async () => {
  writeJobSession(124, 'r1', join(tmp, 'worktrees', '124'), 'zebrafinch migration');
  expect(await cache.searchSessions('zebrafinch')).toHaveLength(1); // indexed and archived
  process.env.SESSIONS_RIKER = '0';
  expect(await cache.searchSessions('zebrafinch')).toEqual([]);
});

test('a removed job dir with no vault copy drops its rows on the next refresh', async () => {
  writeJobSession(124, 'r1', join(tmp, 'worktrees', '124'), 'zebrafinch migration');
  expect(await cache.searchSessions('zebrafinch')).toHaveLength(1);
  rmSync(join(rikerHome(), 'jobs', '124'), { recursive: true, force: true });
  rmSync(join(tmp, 'archive'), { recursive: true, force: true });
  await cache.refreshIndex();
  expect(await cache.searchSessions('zebrafinch')).toEqual([]);
});

test('the no-index scanner and the usage report see the same Riker roots as the index', async () => {
  const path = writeJobSession(124, 'r1', join(tmp, 'worktrees', '124'), 'zebrafinch migration');
  writeFileSync(join(rikerHome(), 'jobs', '124', 'log.jsonl'), piTranscript('log', '/x', 'zebrafinch log'));

  const { scanSessions } = await import('./scanner');
  const scanned = await scanSessions('', 'pi', 'zebrafinch');
  expect(scanned.map((r) => r.filePath)).toEqual([path]);

  const { defaultRoots, gatherEvents } = await import('./report/extract');
  const { getPiSessionRoots } = await import('./paths');
  expect(defaultRoots().pi).toEqual(getPiSessionRoots().map((r) => r.dir));
  const events = await gatherEvents(defaultRoots(), new Set(['pi']), { noCache: true });
  expect(events.map((e) => e.sessionId)).toEqual(['r1']);
});
