import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { cwdUnder, globPrefix, branchLabel, resolveRepo } from './repo';

describe('cwdUnder', () => {
  test('a sibling with a shared prefix is NOT under root (dotfiles vs dotfiles-v2)', () => {
    expect(cwdUnder('/x/dotfiles-v2/a', '/x/dotfiles')).toBe(false);
  });

  test('the root itself is under root', () => {
    expect(cwdUnder('/x/dotfiles', '/x/dotfiles')).toBe(true);
  });

  test('a descendant is under root', () => {
    expect(cwdUnder('/x/dotfiles/wt/main', '/x/dotfiles')).toBe(true);
  });

  test('an unrelated path is not under root', () => {
    expect(cwdUnder('/y/other', '/x/dotfiles')).toBe(false);
  });
});

describe('globPrefix', () => {
  test('appends /* to a plain path', () => {
    expect(globPrefix('/x/dotfiles')).toBe('/x/dotfiles/*');
  });

  test('escapes GLOB metacharacters in the root', () => {
    expect(globPrefix('/x/foo[1]')).toBe('/x/foo[[]1]/*');
  });
});

describe('branchLabel', () => {
  test('returns the mapped branch when present', () => {
    const map = new Map([['/x/dotfiles/wt/main', 'main']]);
    expect(branchLabel('/x/dotfiles/wt/main', map)).toBe('main');
  });

  test('falls back to the cwd basename when absent', () => {
    expect(branchLabel('/x/dotfiles/wt/feature', new Map())).toBe('feature');
  });
});

// Isolate from the user's global git config (signing hooks, templates, etc.).
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

describe('resolveRepo', () => {
  let dir: string;

  beforeAll(() => {
    // realpathSync resolves /var → /private/var on macOS so git's toplevel matches.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-repo-')));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when cwd is not in a git repo', () => {
    expect(resolveRepo(dir)).toBeNull();
  });

  test('resolves a normal repo with worktrees and a branch map', () => {
    const repo = join(dir, 'myrepo');
    Bun.spawnSync(['mkdir', '-p', repo]);
    sh(repo, ['init', '-q', '-b', 'main']);
    Bun.spawnSync(['sh', '-c', `echo hi > ${join(repo, 'a.txt')}`]);
    sh(repo, ['add', 'a.txt']);
    sh(repo, ['commit', '-q', '-m', 'init']);

    const wtPath = join(dir, 'myrepo-feature');
    sh(repo, ['worktree', 'add', '-q', '-b', 'feature', wtPath]);

    const info = resolveRepo(repo);
    expect(info).not.toBeNull();
    expect(info!.container).toBe(repo);
    expect(info!.currentWorktree).toBe(repo);
    // Branch map covers both the main worktree and the linked one.
    expect(info!.branches.get(repo)).toBe('main');
    expect(info!.branches.get(wtPath)).toBe('feature');

    // Resolving from the linked worktree still finds the same common dir + container.
    const fromWt = resolveRepo(wtPath);
    expect(fromWt).not.toBeNull();
    expect(fromWt!.gitCommonDir).toBe(info!.gitCommonDir);
    expect(fromWt!.currentWorktree).toBe(wtPath);
  });
});
