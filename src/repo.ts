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

interface GitResult {
  ok: boolean;
  out: string;
}

function git(cwd: string, args: string[]): GitResult {
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

// ——— read-only git readers for `sessions why` ———
//
// Every reader here goes through the private git() above (exit-code checked, {ok:false}
// on any failure or throw) and returns a null/[] safe value rather than throwing. None of
// them ever write to a repository — no hooks, no trailers, no branches.

/** A commit reduced to what correlation needs: identity, time, subject, files, trailers. */
export interface CommitInfo {
  sha: string;
  subject: string;
  /** ISO author time (%aI). */
  authoredAt: string;
  /** Repo-relative paths from --name-only. */
  files: string[];
  /** Co-Authored-By and other trailers, verbatim — annotation only, never a confidence tier. */
  trailers: string[];
}

// RS between commits, US between header fields (and between joined trailers). Both are
// control characters git will never emit inside a subject or a path, so the parse is
// unambiguous without escaping.
const RS = '\x1e';
const US = '\x1f';
const COMMIT_FORMAT = `${RS}%H${US}%aI${US}%s${US}%(trailers:only,unfold,separator=${US})`;

/** Parse the RS/US-delimited `--name-only` output of log/show into commits. */
function parseCommits(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const headerLine = nl >= 0 ? chunk.slice(0, nl) : chunk;
    const rest = nl >= 0 ? chunk.slice(nl + 1) : '';
    const fields = headerLine.split(US);
    const sha = fields[0] ?? '';
    if (!sha) continue;
    const authoredAt = fields[1] ?? '';
    const subject = fields[2] ?? '';
    const trailers = fields.slice(3).filter((t) => t.trim());
    const files = rest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    commits.push({ sha, subject, authoredAt, files, trailers });
  }
  return commits;
}

/** Commits that touched `relPath` (most recent first), following renames, capped at `limit`. */
export function logForFile(repo: RepoInfo, relPath: string, limit = 20): CommitInfo[] {
  const res = git(repo.currentWorktree, [
    'log',
    '--follow',
    `--format=${COMMIT_FORMAT}`,
    '--name-only',
    '-n',
    String(limit),
    '--',
    relPath,
  ]);
  if (!res.ok || !res.out) return [];
  return parseCommits(res.out);
}

/** The commit sha that last touched `line` of `relPath`, or null (uncommitted / new file). */
export function blameLine(repo: RepoInfo, relPath: string, line: number): string | null {
  const res = git(repo.currentWorktree, ['blame', '-L', `${line},${line}`, '--porcelain', '--', relPath]);
  if (!res.ok || !res.out) return null;
  const sha = res.out.split(/\s/, 1)[0];
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/** One commit's full info by ref (sha, tag, HEAD~2, …), or null when the ref is unknown. */
export function showCommit(repo: RepoInfo, ref: string): CommitInfo | null {
  const res = git(repo.currentWorktree, ['show', '--name-only', `--format=${COMMIT_FORMAT}`, ref]);
  if (!res.ok || !res.out) return null;
  return parseCommits(res.out)[0] ?? null;
}

/** Whether `ref` names a commit object in this repo (used to disambiguate a target). */
export function isCommitRef(repo: RepoInfo, ref: string): boolean {
  const res = git(repo.currentWorktree, ['cat-file', '-t', ref]);
  return res.ok && res.out.trim() === 'commit';
}
