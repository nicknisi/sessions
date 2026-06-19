import { dirname, basename, resolve } from 'node:path';

export interface RepoInfo {
  /** Canonical repo key (absolute path to the common git dir). */
  gitCommonDir: string;
  /** Directory tree under which this repo's sessions live (bare: parent of .bare; normal: main worktree toplevel). */
  container: string;
  /** Current worktree toplevel (for --worktree narrowing). */
  currentWorktree: string;
  /** Live worktree path → branch label, from `git worktree list --porcelain`. */
  branches: Map<string, string>;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
    if (result.exitCode !== 0) return { ok: false, out: '' };
    return { ok: true, out: new TextDecoder().decode(result.stdout).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Derive the container directory that holds all of a repo's worktrees.
 *
 * For the bare-repo worktree layout (`~/Developer/dotfiles/.bare` with worktrees
 * checked out as siblings under `~/Developer/dotfiles`), `--git-common-dir`
 * resolves to `…/dotfiles/.bare`, so the container is its parent: `…/dotfiles`.
 * For a normal repo, the container is the main worktree toplevel.
 */
function deriveContainer(gitCommonDir: string, toplevel: string): string {
  if (basename(gitCommonDir) === '.bare') {
    return dirname(gitCommonDir);
  }
  return toplevel;
}

/** Resolve the repo container + cwd→branch map, or `null` when `cwd` is not in a git repo. */
export function resolveRepo(cwd: string): RepoInfo | null {
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir.ok || !commonDir.out) return null;

  const toplevel = git(cwd, ['rev-parse', '--show-toplevel']);
  const currentWorktree = toplevel.ok && toplevel.out ? toplevel.out : cwd;

  // git may print --git-common-dir as a path relative to cwd (e.g. ".git"); make it absolute.
  const gitCommonDir = commonDir.out.startsWith('/') ? commonDir.out : resolve(cwd, commonDir.out);

  const container = deriveContainer(gitCommonDir, currentWorktree);

  const branches = new Map<string, string>();
  const wt = git(cwd, ['worktree', 'list', '--porcelain']);
  if (wt.ok && wt.out) {
    let currentPath = '';
    for (const line of wt.out.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ') && currentPath) {
        const ref = line.slice('branch '.length).trim();
        const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        branches.set(currentPath, name);
      } else if (line.startsWith('detached') && currentPath) {
        branches.set(currentPath, 'detached');
      }
    }
  }

  return { gitCommonDir, container, currentWorktree, branches };
}

/** Boundary-aware containment: true iff `cwd` is `root` or a descendant of `root`. */
export function cwdUnder(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root + '/');
}

/** GLOB prefix matching every descendant of `root`, escaping the GLOB metacharacters `*?[`. */
export function globPrefix(root: string): string {
  const escaped = root.replace(/[*?[]/g, (ch) => '[' + ch + ']');
  return escaped + '/*';
}

/** Branch label for a session cwd: the worktree's branch, falling back to the cwd's last segment. */
export function branchLabel(cwd: string, branches: Map<string, string>): string {
  return branches.get(cwd) ?? basename(cwd);
}
