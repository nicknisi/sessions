import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, subagentsDir } from './archive';

let tmp: string;
let cache: typeof import('../cache');
const saved = { ...process.env };

const turn = (text: string) =>
  JSON.stringify({
    type: 'user',
    cwd: '/repoSub',
    timestamp: '2026-08-04T10:00:00Z',
    promptSource: 'typed',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

function writeSession(id: string, subagentText: string): string {
  const proj = join(tmp, 'claude', 'proj');
  const subs = join(proj, id, 'subagents');
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, 'agent-1.jsonl'), turn(subagentText));
  writeFileSync(join(subs, 'agent-1.meta.json'), '{"agentType":"Explore"}');
  const path = join(proj, `${id}.jsonl`);
  writeFileSync(path, turn(`parent of ${id}`));
  return path;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-subagents-'));
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  delete process.env.SESSIONS_PI_EXTRA_DIRS;
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1';
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  delete process.env.SESSIONS_ARCHIVE;
  cache = await import('../cache');
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const ids = async (q: string) => (await cache.searchSessions(q, {})).map((r) => r.sessionId);

test('subagent transcripts are archived and stay searchable after the source is deleted', async () => {
  const path = writeSession('withsubs', 'quuxinator subagent finding');
  await cache.refreshIndex();

  const entry = loadManifest(join(tmp, 'archive'))[path]!;
  const vaultSubs = subagentsDir(entry.vaultPath);
  expect(readFileSync(join(vaultSubs, 'agent-1.jsonl'), 'utf-8')).toContain('quuxinator');
  expect(existsSync(join(vaultSubs, 'agent-1.meta.json'))).toBe(true);

  rmSync(path);
  rmSync(join(tmp, 'claude', 'proj', 'withsubs'), { recursive: true });
  await cache.refreshIndex();
  expect(await ids('quuxinator')).toContain('withsubs');
});

test('sessions archived before subagent support get their subagents backfilled', async () => {
  const path = writeSession('legacy', 'flimbergast subagent finding');
  await cache.refreshIndex();
  const vaultSubs = subagentsDir(loadManifest(join(tmp, 'archive'))[path]!.vaultPath);
  rmSync(vaultSubs, { recursive: true });

  await cache.refreshIndex();
  expect(existsSync(join(vaultSubs, 'agent-1.jsonl'))).toBe(true);
});
