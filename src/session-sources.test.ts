// Extra Pi session folders (SESSIONS_PI_EXTRA_DIRS), worktree sessions scoped to their
// main checkout, and Pi session names as titles. Same hermetic harness as
// src/cache.test.ts: every source root, the cache, and the vault live in one temp dir.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeMemoryDb } from './memory/store';

let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  delete process.env.SESSIONS_PI_EXTRA_DIRS;
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1'; // dead port: keep the semantic lane off a local Ollama
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data'); // the primer reads the memory store
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

/** A tiny Pi transcript: header, one user turn, one assistant turn with usage (for the report). */
function piTranscript(id: string, cwd: string, text: string, name?: string): string {
  return [
    { type: 'session', id, timestamp: '2026-10-09T17:00:00.000Z', cwd },
    ...(name ? [{ type: 'session_info', id: 'n1', parentId: null, timestamp: '2026-10-09T17:00:01.000Z', name }] : []),
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

function writeSession(path: string, id: string, cwd: string, text: string, name?: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, piTranscript(id, cwd, text, name));
  return path;
}

// Isolate from the user's global git config (signing hooks, templates), as src/repo.test.ts does.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'commit.gpgsign=false', ...args], { env: { ...GIT_ENV, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A one-commit checkout at `path`. */
function initRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  writeFileSync(join(path, 'README.md'), 'hi\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-qm', 'init']);
  return path;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-sources-')));
  setEnv();
  cache = await import('./cache');
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
  for (const d of ['cache', 'archive', 'pi', 'extra', 'git']) rmSync(join(tmp, d), { recursive: true, force: true });
});

afterAll(() => {
  cache.closeDb();
  closeMemoryDb(); // the primer opened it here; the next file must not inherit this handle
  rmSync(tmp, { recursive: true, force: true });
});

// ——— extra Pi session folders ———

test('extra folders, flat or one project down, are indexed; nothing else in or around them is', async () => {
  const jobs = join(tmp, 'extra', 'jobs');
  const flat = writeSession(join(jobs, '124', 'session', 'r1.jsonl'), 'r1', '/w/124', 'zebrafinch flat');
  const nested = writeSession(join(tmp, 'extra', 'nested', 'proj', 'n1.jsonl'), 'n1', '/w/n', 'zebrafinch nested');
  writeSession(join(jobs, '124', 'log.jsonl'), 'log', '/x', 'zebrafinch log'); // beside the folder, not in it
  writeSession(join(tmp, 'extra', 'nested', 'proj', 'deep', 'd.jsonl'), 'd', '/x', 'zebrafinch deep');
  writeFileSync(join(jobs, '124', 'session', 'notes.txt'), 'zebrafinch');

  expect(await cache.searchSessions('zebrafinch')).toEqual([]); // default: none

  process.env.SESSIONS_PI_EXTRA_DIRS = `${join(jobs, '*', 'session')}:${join(tmp, 'extra', 'nested')}:${join(tmp, 'missing')}`;
  const results = await cache.searchSessions('zebrafinch');
  expect(results.map((r) => r.filePath).sort()).toEqual([nested, flat].sort());
  expect(results.every((r) => r.tool === 'pi')).toBe(true);
});

test('the no-index scanner and the usage report read the same extra folders', async () => {
  const flat = writeSession(join(tmp, 'extra', 'jobs', '1', 'session', 'r1.jsonl'), 'r1', '/w/1', 'zebrafinch');
  process.env.SESSIONS_PI_EXTRA_DIRS = join(tmp, 'extra', 'jobs', '*', 'session');

  const { scanSessions } = await import('./scanner');
  expect((await scanSessions('', 'pi', 'zebrafinch')).map((r) => r.filePath)).toEqual([flat]);

  const { defaultRoots, gatherEvents } = await import('./report/extract');
  expect(defaultRoots().pi).toEqual([join(tmp, 'pi'), join(tmp, 'extra', 'jobs', '1', 'session')]);
  const events = await gatherEvents(defaultRoots(), new Set(['pi']), { noCache: true });
  expect(events.map((e) => e.sessionId)).toEqual(['r1']);
});

// ——— worktree sessions belong to their main checkout ———

test('search, grep, primer, and why find a worktree session from the main checkout, before and after the worktree is removed', async () => {
  const repo = initRepo(join(tmp, 'git', 'app'));
  const wt = join(tmp, 'git', 'worktrees', '124');
  git(repo, ['worktree', 'add', '-q', '-b', 'fix-zebra', wt]);
  writeSession(join(tmp, 'pi', 'wt', 'w1.jsonl'), 'w1', wt, 'zebrafinch migration');
  // A commit inside the session's window, for `why`.
  writeFileSync(join(repo, 'zebra.ts'), 'export {};\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'zebra'], {
    GIT_AUTHOR_DATE: '2026-10-09T17:30:00Z',
    GIT_COMMITTER_DATE: '2026-10-09T17:30:00Z',
  });
  const sha = git(repo, ['rev-parse', 'HEAD']);

  const { resolveRepo } = await import('./repo');
  const { why } = await import('./why/correlate');
  const { runSearchSessions } = await import('./mcp');
  const { SearchSessionsOutput } = await import('./mcp-schemas');
  const expectFound = async () => {
    expect((await cache.searchSessions('zebrafinch', { project: repo })).map((r) => r.sessionId)).toEqual(['w1']);
    expect((await cache.grepSessions('zebrafinch', { project: repo })).totalSessions).toBe(1);
    const primer = await cache.getContextPrimer(resolveRepo(repo)!, {});
    expect(primer.recent.map((s) => s.sessionId)).toEqual(['w1']);
    // --worktree from the main checkout means sessions recorded there, not in other worktrees.
    expect((await cache.getContextPrimer(resolveRepo(repo)!, { worktreeOnly: true })).recent).toEqual([]);
    const outcome = await why(sha, repo);
    expect(outcome.kind === 'evidence' && outcome.evidence.sessions.map((s) => s.sessionId)).toEqual(['w1']);
    // MCP: project stays the cwd the session ran in; repo names the main checkout.
    const search = SearchSessionsOutput.parse((await runSearchSessions({ query: 'zebrafinch' })).structuredContent);
    expect(search.results[0]).toMatchObject({ project: wt, repo });
  };

  await expectFound(); // live: also listed by `git worktree list`
  git(repo, ['worktree', 'remove', '--force', wt]);
  await expectFound(); // gone: matched by the recorded main checkout alone
});

test('a sibling sharing the prefix keeps its worktree sessions; non-worktree sessions carry no repo', async () => {
  const repo = initRepo(join(tmp, 'git', 'app'));
  const sibling = initRepo(join(tmp, 'git', 'app-v2'));
  const wt = join(tmp, 'git', 'worktrees', 'v2');
  git(sibling, ['worktree', 'add', '-q', '-b', 'v2-fix', wt]);
  writeSession(join(tmp, 'pi', 'wt', 's1.jsonl'), 's1', wt, 'zebrafinch sibling');
  writeSession(join(tmp, 'pi', 'main', 'm1.jsonl'), 'm1', repo, 'zebrafinch main');

  const { resolveRepo } = await import('./repo');
  expect((await cache.searchSessions('zebrafinch', { project: repo })).map((r) => r.sessionId)).toEqual(['m1']);
  expect((await cache.getContextPrimer(resolveRepo(repo)!, {})).recent.map((s) => s.sessionId)).toEqual(['m1']);
  const [s1] = await cache.searchSessions('zebrafinch', { project: sibling });
  expect(s1).toMatchObject({ sessionId: 's1', repo: sibling });
  const [m1] = await cache.searchSessions('zebrafinch main');
  expect(m1!.repo).toBeUndefined();
});

// ——— Pi session names ———

test('a Pi session name is the title the CLI list and MCP results show', async () => {
  writeSession(join(tmp, 'pi', 'p', 'named.jsonl'), 'named', '/r', 'zebrafinch opener', 'Riker job 124: fix login');
  const [r] = await cache.searchSessions('');
  expect(r).toMatchObject({ customTitle: 'Riker job 124: fix login', displayText: 'Riker job 124: fix login' });

  const { formatLine } = await import('./display');
  expect(formatLine(r!, 120).split('\t').at(-1)).toContain('Riker job 124: fix login');
  const { runSearchSessions } = await import('./mcp');
  const { SearchSessionsOutput } = await import('./mcp-schemas');
  const search = SearchSessionsOutput.parse((await runSearchSessions({ query: 'zebrafinch' })).structuredContent);
  expect(search.results[0]!.title).toBe('Riker job 124: fix login');
});
