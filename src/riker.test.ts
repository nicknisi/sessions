// Riker worker sessions: Pi-format transcripts under <rikerHome>/jobs/<n>/session/.
// Same hermetic harness as src/cache.test.ts — every source root, the cache, the vault,
// and the Riker home point into one temp dir, so neither the real ~/.riker, ~/.pi nor
// ~/.riker/jobs.db is ever read. Transcripts are a header and two short turns.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { closeMemoryDb } from './memory/store';

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
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data'); // the primer reads the memory store
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

let fixtureCount = 0;

/** A fresh checkout with one commit, plus a Riker-style linked worktree for `job` on `branch`. */
function repoWithJobWorktree(job: number, branch: string) {
  const base = join(tmp, `fx${++fixtureCount}`);
  const repo = join(base, 'repo');
  const worktree = join(base, 'worktrees', String(job));
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['worktree', 'add', '-q', '-b', branch, worktree]);
  return { repo, worktree };
}

interface JobRow {
  id: number;
  repo: string;
  branch: string | null;
  pr_url: string | null;
}

/** A fixture jobs.db with Riker's column names (plus a NOT NULL goal we must never need). */
function writeJobsDb(rows: JobRow[]): string {
  const path = join(rikerHome(), 'jobs.db');
  mkdirSync(rikerHome(), { recursive: true });
  rmSync(path, { force: true });
  const db = new Database(path);
  db.run(
    'CREATE TABLE jobs (id INTEGER PRIMARY KEY, goal TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT, pr_url TEXT)',
  );
  for (const r of rows) {
    db.run('INSERT INTO jobs (id, goal, repo, branch, pr_url) VALUES (?, ?, ?, ?, ?)', [
      r.id,
      'secret goal',
      r.repo,
      r.branch,
      r.pr_url,
    ]);
  }
  db.close();
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
  closeMemoryDb(); // the primer opened it here; the next file must not inherit this handle
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

test('provenance from git metadata while the worktree exists: job, worktree, repo, branch', async () => {
  const { repo, worktree } = repoWithJobWorktree(124, 'riker/124-zebra');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');

  const [r] = await cache.searchSessions('zebrafinch');
  expect(r!.tool).toBe('pi');
  expect(r!.riker).toEqual({ job: 124, worktree, repo, branch: 'riker/124-zebra', prUrl: '' });
});

test('provenance from jobs.db once the worktree is gone, and the PR URL whenever Riker records one', async () => {
  const { repo, worktree } = repoWithJobWorktree(124, 'riker/124-zebra');
  git(repo, ['worktree', 'remove', '--force', worktree]);
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  writeJobsDb([{ id: 124, repo, branch: 'riker/124-zebra', pr_url: null }]);

  const [before] = await cache.searchSessions('zebrafinch');
  expect(before!.riker).toEqual({ job: 124, worktree, repo, branch: 'riker/124-zebra', prUrl: '' });
  expect(before!.exists).toBe(false);

  // The PR lands after the transcript stops changing; the next refresh still picks it up.
  const db = new Database(join(rikerHome(), 'jobs.db'));
  db.run("UPDATE jobs SET pr_url = 'https://github.com/acme/repo/pull/7' WHERE id = 124");
  db.close();
  const [after] = await cache.searchSessions('zebrafinch');
  expect(after!.riker?.prUrl).toBe('https://github.com/acme/repo/pull/7');
});

test('git metadata wins over jobs.db for repo and branch; a bare-layout jobs.db path traces to its container', async () => {
  const { repo, worktree } = repoWithJobWorktree(124, 'riker/124-zebra');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  writeJobsDb([{ id: 124, repo: '/somewhere/else', branch: 'stale', pr_url: 'https://x/pull/1' }]);
  const [r] = await cache.searchSessions('zebrafinch');
  expect(r!.riker).toEqual({ job: 124, worktree, repo, branch: 'riker/124-zebra', prUrl: 'https://x/pull/1' });

  // Bare layout: <container>/.bare with worktrees as siblings; Riker records the
  // checkout it ran from (<container>/main), the index stores the container.
  const container = join(tmp, `fx${++fixtureCount}`, 'cli');
  mkdirSync(container, { recursive: true });
  git(repo, ['clone', '-q', '--bare', repo, join(container, '.bare')]);
  writeFileSync(join(container, '.git'), 'gitdir: ./.bare\n');
  git(container, ['worktree', 'add', '-q', join(container, 'main'), 'main']);
  writeJobSession(125, 'r2', join(tmp, 'gone', '125'), 'quokka');
  writeJobsDb([{ id: 125, repo: join(container, 'main'), branch: 'riker/125-q', pr_url: null }]);
  const [b] = await cache.searchSessions('quokka');
  expect(b!.riker?.repo).toBe(container);
});

test('jobs.db is opened read-only: a write through the same handle fails', async () => {
  const path = writeJobsDb([{ id: 1, repo: '/r', branch: null, pr_url: null }]);
  const { openRikerJobsDb } = await import('./riker');
  const db = openRikerJobsDb(path);
  try {
    expect(() => db.run("UPDATE jobs SET branch = 'x'")).toThrow(/readonly/i);
  } finally {
    db.close();
  }
});

test('a missing jobs.db and a deleted worktree still index, with what is known', async () => {
  const worktree = join(tmp, 'never-existed', '124');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  const [r] = await cache.searchSessions('zebrafinch');
  expect(r!.riker).toEqual({ job: 124, worktree, repo: '', branch: '', prUrl: '' });
});

test('a locked jobs.db does not break the refresh; provenance fills in once it frees up', async () => {
  const worktree = join(tmp, 'never-existed', '124');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  const path = writeJobsDb([{ id: 124, repo: '/r/repo', branch: 'riker/124-z', pr_url: null }]);
  const holder = new Database(path);
  holder.run('BEGIN EXCLUSIVE'); // rollback-journal mode: readers are locked out until COMMIT
  try {
    const [r] = await cache.searchSessions('zebrafinch');
    expect(r!.riker).toEqual({ job: 124, worktree, repo: '', branch: '', prUrl: '' });
  } finally {
    holder.run('COMMIT');
    holder.close();
  }
  const [r] = await cache.searchSessions('zebrafinch');
  expect(r!.riker?.repo).toBe('/r/repo');
  expect(r!.riker?.branch).toBe('riker/124-z');
});

test('non-Riker sessions carry no provenance', async () => {
  const dir = join(tmp, 'pi', 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p1.jsonl'), piTranscript('p1', '/repoPi', 'zebrafinch plain'));
  const [r] = await cache.searchSessions('zebrafinch');
  expect(r!.riker).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

// ——— repo scoping: a job's sessions belong to the checkout the job came from ———

test('repo-scoped search, primer, and why find Riker sessions from the checkout, live or after the worktree is gone', async () => {
  const { repo, worktree } = repoWithJobWorktree(124, 'riker/124-zebra');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  // Job 125 ran and was cleaned up before sessions ever saw it: only jobs.db knows its repo.
  const gone = join(tmp, 'gone-worktrees', '125');
  writeJobSession(125, 'r2', gone, 'zebrafinch followup');
  writeJobsDb([{ id: 125, repo, branch: 'riker/125-follow', pr_url: 'https://github.com/acme/repo/pull/9' }]);
  // A commit landing inside both sessions' window, for `why`.
  writeFileSync(join(repo, 'zebra.ts'), 'export {};\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'zebra'], {
    GIT_AUTHOR_DATE: '2026-10-09T17:30:00Z',
    GIT_COMMITTER_DATE: '2026-10-09T17:30:00Z',
  });
  const sha = git(repo, ['rev-parse', 'HEAD']);

  const { resolveRepo } = await import('./repo');
  const { why } = await import('./why/correlate');
  const expectBoth = async () => {
    const searched = await cache.searchSessions('zebrafinch', { project: repo });
    expect(searched.map((r) => r.sessionId).sort()).toEqual(['r1', 'r2']);
    const grepped = await cache.grepSessions('zebrafinch', { project: repo });
    expect(grepped.totalSessions).toBe(2);
    const primer = await cache.getContextPrimer(resolveRepo(repo)!, {});
    expect([...primer.recent, ...primer.headlines].map((s) => s.branch).sort()).toEqual([
      'riker/124-zebra',
      'riker/125-follow',
    ]);
    const outcome = await why(sha, repo);
    expect(outcome.kind).toBe('evidence');
    if (outcome.kind === 'evidence')
      expect(outcome.evidence.sessions.map((s) => s.sessionId).sort()).toEqual(['r1', 'r2']);
  };

  await expectBoth(); // job 124's worktree is live (and listed by git worktree list)
  git(repo, ['worktree', 'remove', '--force', worktree]);
  await expectBoth(); // gone: matched by the recorded repo alone
});

test('a sibling repo sharing the prefix keeps its Riker sessions to itself', async () => {
  const { repo } = repoWithJobWorktree(124, 'riker/124-zebra');
  const sibling = repo + '-v2';
  mkdirSync(sibling);
  git(sibling, ['init', '-q', '-b', 'main']);
  writeFileSync(join(sibling, 'README.md'), 'v2\n');
  git(sibling, ['add', '-A']);
  git(sibling, ['commit', '-qm', 'init']);
  writeJobSession(126, 'r3', join(tmp, 'gone-worktrees', '126'), 'zebrafinch sibling');
  writeJobsDb([{ id: 126, repo: sibling, branch: 'riker/126-v2', pr_url: null }]);

  const { resolveRepo } = await import('./repo');
  expect(await cache.searchSessions('zebrafinch', { project: repo })).toEqual([]);
  expect((await cache.getContextPrimer(resolveRepo(repo)!, {})).isEmpty).toBe(true);
  expect((await cache.searchSessions('zebrafinch', { project: sibling })).map((r) => r.sessionId)).toEqual(['r3']);
});

// ——— what a hit shows ———

test('display: the CLI list names the job, repo, and (clipped) branch instead of the worktree path', async () => {
  const { formatLine } = await import('./display');
  const base = {
    date: '2026-10-09',
    createdAt: '2026-10-09',
    cwd: '/home/u/.riker/worktrees/124',
    tool: 'pi' as const,
    sessionId: 'r1',
    displayText: 'zebrafinch',
    customTitle: '',
    messageCount: 2,
    filePath: '/home/u/.riker/jobs/124/session/r1.jsonl',
    exists: false,
    files: [],
    commands: [],
    errored: false,
    branches: 0,
    forkedFrom: '',
  };
  const riker = { job: 124, worktree: base.cwd, repo: '/src/riker-live', branch: 'riker/124-zebra', prUrl: '' };
  const display = (r: typeof base & { riker?: typeof riker }) => formatLine(r, 120).split('\t').at(-1)!;

  expect(display({ ...base, riker })).toContain('Riker job 124 · riker-live (riker/124-zebra)');
  expect(display({ ...base, riker: { ...riker, branch: 'riker/124-a-very-long-goal-slug' } })).toContain(
    'Riker job 124 · riker-live (riker/124-a-ver…)',
  );
  expect(display({ ...base, riker: { ...riker, repo: '', branch: '' } })).toContain('Riker job 124 ');
  expect(display({ ...base, riker })).not.toContain('worktrees');
  // The resume path (TSV field 2) is still the worktree: that is where the session ran.
  expect(formatLine({ ...base, riker }, 120).split('\t')[1]).toBe(base.cwd);
});

test('MCP: search, grep, and why carry "Riker job N" and the job repo, and validate against their schemas', async () => {
  const { repo, worktree } = repoWithJobWorktree(124, 'riker/124-zebra');
  writeJobSession(124, 'r1', worktree, 'zebrafinch migration');
  writeJobsDb([{ id: 124, repo, branch: 'riker/124-zebra', pr_url: 'https://github.com/acme/repo/pull/7' }]);
  const label = `Riker job 124 · repo (riker/124-zebra)`;
  const riker = {
    job: 124,
    label,
    worktree,
    repo,
    branch: 'riker/124-zebra',
    prUrl: 'https://github.com/acme/repo/pull/7',
  };

  const { runSearchSessions, runGrepSessions, runWhy } = await import('./mcp');
  const { SearchSessionsOutput, GrepSessionsOutput, WhyDidThisChangeOutput } = await import('./mcp-schemas');

  const search = SearchSessionsOutput.parse((await runSearchSessions({ query: 'zebrafinch' })).structuredContent);
  expect(search.results[0]!.riker).toEqual(riker);
  expect(search.results[0]!.project).toBe(repo);
  expect(search.results[0]!.tool).toBe('pi');

  const grep = GrepSessionsOutput.parse((await runGrepSessions({ pattern: 'zebrafinch' })).structuredContent);
  expect(grep.hits[0]!.riker).toEqual(riker);
  expect(grep.hits[0]!.project).toBe(repo);

  const why = WhyDidThisChangeOutput.parse((await runWhy({ target: 'zebrafinch', cwd: repo })).structuredContent);
  expect(why.sessions[0]!.riker?.label).toBe(label);
});
