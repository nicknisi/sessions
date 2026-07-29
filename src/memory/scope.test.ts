import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContainerResolver, deriveScope, mine } from './mine';
import { closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

// Isolate from the user's global git config (signing hooks, templates, etc.),
// matching src/repo.test.ts:47-64.
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

function initRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  sh(path, ['init', '-q', '-b', 'main']);
  writeFileSync(join(path, 'a.txt'), 'hi\n');
  sh(path, ['add', 'a.txt']);
  sh(path, ['commit', '-q', '-m', 'init']);
  return path;
}

const WORKTREE_FACT = 'Always run the migration script from the repo root, never from a worktree';
const WORKFLOW_FACT = 'Always ask me before force pushing to any shared branch anywhere';
const NESTED_FACT = 'Always regenerate the vendored client, never hand-edit it in place';

let tmp: string;
let mainRepo: string;
let wtA: string;
let wtB: string;
let nested: string;
let bareContainer: string;
let bareWorktrees: string[];
let unrelated: string[];

beforeAll(() => {
  tmp = makeTmp('memory-scope');
  setMemoryEnv(tmp);
  const repos = join(tmp, 'repos');
  mkdirSync(repos, { recursive: true });

  // (b) One repo, three sibling worktrees — three distinct cwds that must cluster
  // as ONE container. This is the standard (non-bare) layout, where
  // resolveRepo().container returns each worktree's own toplevel.
  mainRepo = initRepo(join(repos, 'app'));
  wtA = join(repos, 'app-featureA');
  wtB = join(repos, 'app-featureB');
  sh(mainRepo, ['worktree', 'add', '-q', '-b', 'featureA', wtA]);
  sh(mainRepo, ['worktree', 'add', '-q', '-b', 'featureB', wtB]);

  // The bare-sibling layout: `<proj>/.bare` with worktrees checked out as siblings.
  const seed = initRepo(join(repos, 'seed'));
  bareContainer = join(repos, 'dotfiles');
  mkdirSync(bareContainer, { recursive: true });
  const bare = Bun.spawnSync(['git', 'clone', '-q', '--bare', seed, join(bareContainer, '.bare')], { env: GIT_ENV });
  if (bare.exitCode !== 0) throw new Error(`git clone --bare failed: ${new TextDecoder().decode(bare.stderr)}`);
  writeFileSync(join(bareContainer, '.git'), 'gitdir: ./.bare\n');
  bareWorktrees = [join(bareContainer, 'main'), join(bareContainer, 'topic')];
  sh(bareContainer, ['worktree', 'add', '-q', bareWorktrees[0]!, 'main']);
  sh(bareContainer, ['worktree', 'add', '-q', '-b', 'topic', bareWorktrees[1]!]);

  // A separate repo nested INSIDE the main worktree. Its cwd is under the container's
  // path prefix but it is a different repo, so `--repo <container>` must not mine it.
  nested = initRepo(join(mainRepo, 'vendor', 'lib'));

  // (c) Three unrelated repos.
  unrelated = ['one', 'two', 'three'].map((n) => initRepo(join(repos, n)));

  // One session per worktree/repo, each carrying the same corrective turn.
  writeSession(tmp, 'wt-main', mainRepo, [userTurn(WORKTREE_FACT, '2026-06-01T10:00:00Z')]);
  writeSession(tmp, 'wt-a', wtA, [userTurn(WORKTREE_FACT, '2026-06-02T10:00:00Z')]);
  writeSession(tmp, 'wt-b', wtB, [userTurn(WORKTREE_FACT, '2026-06-03T10:00:00Z')]);
  writeSession(tmp, 'nested', nested, [userTurn(NESTED_FACT, '2026-06-09T10:00:00Z')]);
  unrelated.forEach((repo, i) => {
    writeSession(tmp, `unrelated-${i}`, repo, [userTurn(WORKFLOW_FACT, `2026-06-0${i + 4}T10:00:00Z`)]);
  });

  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('deriveScope', () => {
  test('one container is repo-scoped', () => {
    expect(deriveScope(new Map([['/repos/app', 3]]))).toEqual({ type: 'repo', key: '/repos/app' });
  });

  test('three or more containers is workflow-scoped with an empty key', () => {
    const counts = new Map([
      ['/a', 1],
      ['/b', 1],
      ['/c', 1],
    ]);
    expect(deriveScope(counts)).toEqual({ type: 'workflow', key: '' });
  });

  test('two containers resolve to repo, keyed to the one with more sessions', () => {
    expect(
      deriveScope(
        new Map([
          ['/a', 1],
          ['/b', 5],
        ]),
      ),
    ).toEqual({ type: 'repo', key: '/b' });
  });

  test('a two-container tie breaks lexicographically, for determinism', () => {
    // Ties must not depend on Map insertion order — that is SQLite row order, which
    // is an implementation detail and would make the batch differ run to run.
    expect(
      deriveScope(
        new Map([
          ['/b', 2],
          ['/a', 2],
        ]),
      ),
    ).toEqual({ type: 'repo', key: '/a' });
  });
});

describe('createContainerResolver', () => {
  test('three sibling worktrees of one repo resolve to a single container', () => {
    const containerOf = createContainerResolver();
    expect(containerOf(mainRepo)).toBe(mainRepo);
    expect(containerOf(wtA)).toBe(mainRepo);
    expect(containerOf(wtB)).toBe(mainRepo);
  });

  test('bare-layout worktrees resolve to the parent of .bare', () => {
    const containerOf = createContainerResolver();
    for (const wt of bareWorktrees) expect(containerOf(wt)).toBe(bareContainer);
  });

  test('a non-git directory falls back to the raw cwd without throwing', () => {
    const containerOf = createContainerResolver();
    const plain = join(tmp, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    expect(containerOf(plain)).toBe(plain);
  });

  test('memoizes: one resolution per distinct cwd', () => {
    // resolveRepo spawns git three times per call and the live corpus has ~859
    // distinct cwds — without memoization a mine is thousands of subprocesses.
    let calls = 0;
    const containerOf = createContainerResolver((cwd) => {
      calls++;
      return { gitCommonDir: join(cwd, '.git'), container: cwd, currentWorktree: cwd, branches: new Map() };
    });
    for (let i = 0; i < 50; i++) {
      containerOf('/x');
      containerOf('/y');
    }
    expect(calls).toBe(2);
  });
});

describe('scope derivation through the mine', () => {
  test('one corrective turn in three sibling worktrees of one repo is repo-scoped', async () => {
    const records = await mine({});
    const r = records.find((x) => x.text === WORKTREE_FACT);
    expect(r).toBeDefined();
    expect(r!.scope.type).toBe('repo');
    expect(r!.scope.key).toBe(mainRepo);
    expect(r!.evidence.sessions).toHaveLength(3);
  });

  test('one corrective turn in three unrelated repos is workflow-scoped', async () => {
    const records = await mine({});
    const r = records.find((x) => x.text === WORKFLOW_FACT);
    expect(r).toBeDefined();
    expect(r!.scope).toEqual({ type: 'workflow', key: '' });
  });
});

describe('--repo scoping selects by container, not path prefix', () => {
  test('scoping to the main worktree returns every sibling worktree session', async () => {
    // The linked worktrees are SIBLINGS of the main worktree, so a `<container>/*`
    // prefix matches neither of them. Scoping that drops two thirds of a repo's
    // sessions would defeat the whole point of clustering by container.
    const records = await mine({ repo: mainRepo });
    const r = records.find((x) => x.text === WORKTREE_FACT);
    expect(r).toBeDefined();
    expect(r!.evidence.sessions).toHaveLength(3);
    expect(r!.scope).toEqual({ type: 'repo', key: mainRepo });
    expect(records.map((x) => x.text)).not.toContain(WORKFLOW_FACT);
  });

  test('scoping to a linked worktree mines the whole repo, not just that worktree', async () => {
    const records = await mine({ repo: wtA });
    const r = records.find((x) => x.text === WORKTREE_FACT);
    expect(r).toBeDefined();
    expect(r!.evidence.sessions).toHaveLength(3);
    expect(r!.scope.key).toBe(mainRepo);
  });

  test('a nested repo under the container is excluded despite matching the prefix', async () => {
    const records = await mine({ repo: mainRepo });
    expect(records.map((x) => x.text)).not.toContain(NESTED_FACT);
    // ...and it is minable on its own container.
    const own = await mine({ repo: nested });
    expect(own.map((x) => x.text)).toEqual([NESTED_FACT]);
  });

  test('scoping to one unrelated repo returns only its own sessions', async () => {
    const records = await mine({ repo: unrelated[0]! });
    expect(records.map((x) => x.text)).toEqual([WORKFLOW_FACT]);
    expect(records[0]!.evidence.sessions).toHaveLength(1);
    expect(records[0]!.scope).toEqual({ type: 'repo', key: unrelated[0]! });
  });
});
