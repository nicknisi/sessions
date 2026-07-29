import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRecord } from './record';
import { activeShardsFor } from './retrieve';
import { getShardsDb, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setShardEnv } from './fixtures';
import type { ShardRecord, ShardScope } from './types';

// Retrieval is where a scoping bug is invisible: an agent that receives nothing
// simply proceeds without the context, and no error is raised anywhere. So every
// case here is a "what must NOT come back" assertion as much as a positive one.
//
// All shard assertions live in this file rather than src/mcp.test.ts, whose setEnv()
// deliberately does not set SESSIONS_DATA_DIR — a get_shards call from there would
// open and create the developer's real ~/.local/share/sessions/shards.db.

const REPO_A: ShardScope = { type: 'repo', key: '/repos/app' };
const REPO_A_V2: ShardScope = { type: 'repo', key: '/repos/app-v2' };
// A repo path containing a GLOB metacharacter. The natural SQL predicate
// `? GLOB (scope_key || '/*')` reads `[p]` as a character class and silently
// matches nothing here; globPrefix cannot help because scope_key is a column.
const REPO_META: ShardScope = { type: 'repo', key: '/repos/re[p]o' };
const WORKFLOW: ShardScope = { type: 'workflow', key: '' };
const EMPTY_KEY: ShardScope = { type: 'repo', key: '' };

function record(text: string, scope: ShardScope): ShardRecord {
  return buildRecord({
    text,
    scope,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

const A_APPROVED = record('Always run the migrations before starting the dev server', REPO_A);
const A_REJECTED = record('Never rewrite the lockfile by hand, run the installer', REPO_A);
const A_SNOOZED = record('Always ask before force pushing to a shared branch', REPO_A);
const A_CANDIDATE = record('Never leave a failing test behind at the end of a task', REPO_A);
const V2_APPROVED = record('Always build the v2 bundle with the legacy target flag', REPO_A_V2);
const META_APPROVED = record('Always regenerate the vendored client, never hand-edit it', REPO_META);
const WORKFLOW_APPROVED = record('Never commit directly to main on any repo', WORKFLOW);
const EMPTY_KEY_APPROVED = record('Always prefer the fast path when both are correct', EMPTY_KEY);

let tmp: string;
let mcp: typeof import('../mcp');
let mainRepo: string;
let linkedWorktree: string;

// Isolate from the user's global git config, matching src/shards/scope.test.ts:9-25.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function sh(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'commit.gpgsign=false', ...args], { env: GIT_ENV });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
}

beforeAll(async () => {
  tmp = makeTmp('shards-mcp');
  setShardEnv(tmp);
  closeDatabases();

  // A real repo plus a linked worktree. In the standard git layout the linked
  // worktree is a SIBLING path, so no prefix rule over the raw cwd can connect
  // `app-featureA` to a shard stored under `app` — only container resolution can.
  // Nothing else in the suite covers that branch of activeShardsFor.
  const repos = join(tmp, 'repos');
  mkdirSync(repos, { recursive: true });
  mainRepo = join(repos, 'live');
  mkdirSync(mainRepo, { recursive: true });
  sh(mainRepo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(mainRepo, 'a.txt'), 'hi\n');
  sh(mainRepo, ['add', 'a.txt']);
  sh(mainRepo, ['commit', '-q', '-m', 'init']);
  linkedWorktree = join(repos, 'live-featureA');
  sh(mainRepo, ['worktree', 'add', '-q', '-b', 'featureA', linkedWorktree]);
  mkdirSync(join(linkedWorktree, 'src'), { recursive: true });

  mcp = await import('../mcp');
});

beforeEach(() => {
  // store.ts is one shared module instance across a `bun test` run: without
  // re-asserting the env and dropping the handle, another file's SESSIONS_DATA_DIR
  // leaks in and the reopen fails with SQLITE_IOERR_VNODE.
  setShardEnv(tmp);
  closeDatabases();
  getShardsDb().run('DELETE FROM shards');
  upsertCandidates([
    A_APPROVED,
    A_REJECTED,
    A_SNOOZED,
    A_CANDIDATE,
    V2_APPROVED,
    META_APPROVED,
    WORKFLOW_APPROVED,
    EMPTY_KEY_APPROVED,
  ]);
  setState(A_APPROVED.id, 'approved');
  setState(A_REJECTED.id, 'rejected');
  setState(A_SNOOZED.id, 'snoozed', '2026-09-01');
  setState(V2_APPROVED.id, 'approved');
  setState(META_APPROVED.id, 'approved');
  setState(WORKFLOW_APPROVED.id, 'approved');
  setState(EMPTY_KEY_APPROVED.id, 'approved');
  // A_CANDIDATE keeps the default 'candidate' state.
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

function texts(records: ShardRecord[]): string[] {
  return records.map((r) => r.text);
}

describe('activeShardsFor', () => {
  test('an exact repo cwd returns that repo plus workflow shards', () => {
    expect(texts(activeShardsFor('/repos/app'))).toEqual([WORKFLOW_APPROVED.text, A_APPROVED.text]);
  });

  test('a cwd inside a subdirectory resolves to the parent repo shards', () => {
    // The headline silent failure: an agent working in packages/core under an
    // exact-match rule receives nothing and proceeds with no context.
    expect(texts(activeShardsFor('/repos/app/packages/core'))).toEqual([WORKFLOW_APPROVED.text, A_APPROVED.text]);
  });

  test('a sibling-named repo never leaks across the boundary', () => {
    // `/repos/app-v2` starts with `/repos/app`. A naive startsWith would apply one
    // repo's conventions to the other, in both directions.
    expect(texts(activeShardsFor('/repos/app-v2'))).toEqual([WORKFLOW_APPROVED.text, V2_APPROVED.text]);
    expect(texts(activeShardsFor('/repos/app'))).not.toContain(V2_APPROVED.text);
  });

  test('a scope_key containing GLOB metacharacters still matches its subdirectories', () => {
    expect(texts(activeShardsFor('/repos/re[p]o/src'))).toEqual([WORKFLOW_APPROVED.text, META_APPROVED.text]);
  });

  test('a linked worktree receives the main worktree repo shards', () => {
    const shard = record('Always run the integration suite before tagging a release', {
      type: 'repo',
      key: mainRepo,
    });
    upsertCandidates([shard]);
    setState(shard.id, 'approved');

    // The worktree is a sibling path, not a descendant: only container resolution
    // connects it to a shard mined from the main worktree.
    expect(texts(activeShardsFor(linkedWorktree))).toContain(shard.text);
    expect(texts(activeShardsFor(join(linkedWorktree, 'src')))).toContain(shard.text);
  });

  test('workflow shards come back for a cwd in no git repo at all', () => {
    expect(texts(activeShardsFor('/repos/unrelated'))).toEqual([WORKFLOW_APPROVED.text]);
    expect(texts(activeShardsFor(join(tmp, 'not-a-repo')))).toEqual([WORKFLOW_APPROVED.text]);
  });

  test('candidate, rejected, and snoozed shards never reach an agent', () => {
    const out = texts(activeShardsFor('/repos/app'));
    expect(out).not.toContain(A_REJECTED.text);
    expect(out).not.toContain(A_SNOOZED.text);
    expect(out).not.toContain(A_CANDIDATE.text);
  });

  test('an approved repo shard with an empty scope key matches nothing', () => {
    // '' is a prefix of every path. Unreachable from mine() today, reachable from
    // an imported or hand-seeded row — and it would leak into every repo.
    for (const cwd of ['/repos/app', '/repos/app-v2', '/repos/unrelated', linkedWorktree]) {
      expect(texts(activeShardsFor(cwd))).not.toContain(EMPTY_KEY_APPROVED.text);
    }
  });

  test('a trailing slash on the cwd still matches', () => {
    expect(texts(activeShardsFor('/repos/app/'))).toContain(A_APPROVED.text);
  });

  test('workflow shards sort before repo shards, each group by id', () => {
    const second = record('Always write the test before the fix', WORKFLOW);
    const alsoRepoA = record('Never skip the pre-commit hook in this repo', REPO_A);
    upsertCandidates([second, alsoRepoA]);
    setState(second.id, 'approved');
    setState(alsoRepoA.id, 'approved');

    const out = activeShardsFor('/repos/app');
    const kinds = out.map((r) => r.scope.type);
    expect(kinds).toEqual(['workflow', 'workflow', 'repo', 'repo']);
    const workflowIds = out.filter((r) => r.scope.type === 'workflow').map((r) => r.id);
    const repoIds = out.filter((r) => r.scope.type === 'repo').map((r) => r.id);
    expect(workflowIds).toEqual([...workflowIds].sort());
    expect(repoIds).toEqual([...repoIds].sort());
  });

  test('an empty store returns an empty array rather than throwing', () => {
    getShardsDb().run('DELETE FROM shards');
    expect(activeShardsFor('/repos/app')).toEqual([]);
  });
});

describe('runGetShards', () => {
  test('an empty store returns the plain sentence, not an error or []', async () => {
    getShardsDb().run('DELETE FROM shards');
    const res = await mcp.runGetShards({ cwd: '/repos/app' });
    expect(res.content[0]!.text).toBe('No shards for this repo.');
  });

  test('returns a text/kind/scope projection and nothing else', async () => {
    const res = await mcp.runGetShards({ cwd: '/repos/app' });
    const parsed = JSON.parse(res.content[0]!.text) as { text: string; kind: string; scope: string }[];
    expect(parsed).toEqual([
      { text: WORKFLOW_APPROVED.text, kind: 'instruction', scope: 'workflow' },
      { text: A_APPROVED.text, kind: 'instruction', scope: 'repo' },
    ]);
    // ids, evidence, and session paths are triage concerns — they must not be
    // spending the agent's context.
    for (const entry of parsed) expect(Object.keys(entry).sort()).toEqual(['kind', 'scope', 'text']);
  });

  test('two calls with the same cwd return byte-identical output', async () => {
    const first = await mcp.runGetShards({ cwd: '/repos/app' });
    const second = await mcp.runGetShards({ cwd: '/repos/app' });
    expect(first.content[0]!.text).toBe(second.content[0]!.text);
  });

  test('a topic narrows the projection without changing its shape', async () => {
    const res = await mcp.runGetShards({ cwd: '/repos/app', topic: 'run the migrations' });
    const parsed = JSON.parse(res.content[0]!.text) as { text: string; kind: string; scope: string }[];
    expect(parsed.map((p) => p.text)).toEqual([A_APPROVED.text]);
    // No `score` and no `alwaysOn`: a relevance number invites the agent to
    // second-guess the filter, and standing-constraint status is carried by ordering.
    for (const entry of parsed) expect(Object.keys(entry).sort()).toEqual(['kind', 'scope', 'text']);
  });

  test('an omitted topic returns exactly what Phase 3 returned', async () => {
    const bare = await mcp.runGetShards({ cwd: '/repos/app' });
    const blank = await mcp.runGetShards({ cwd: '/repos/app', topic: '' });
    expect(blank.content[0]!.text).toBe(bare.content[0]!.text);
  });

  test('a topic that matches nothing says so, rather than reusing the empty-store sentence', async () => {
    const res = await mcp.runGetShards({ cwd: '/repos/app', topic: 'kubernetes helm chart rollout' });
    expect(res.content[0]!.text).toContain('No shards matched this topic');
    expect(res.content[0]!.text).not.toBe('No shards for this repo.');
  });

  test('an omitted cwd falls back to process.cwd()', async () => {
    // The MCP server runs in the client's working directory, so the default is
    // usually right; the explicit argument is the monorepo escape hatch.
    const res = await mcp.runGetShards({});
    const parsed = JSON.parse(res.content[0]!.text) as { text: string }[];
    expect(parsed.map((p) => p.text)).toEqual([WORKFLOW_APPROVED.text]);
  });
});
