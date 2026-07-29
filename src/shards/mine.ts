// The backfill mine: narrow the corpus to corrective-shaped user turns, collapse
// repeats, cluster by repo container, derive scope, emit records.
//
// Everything here is deterministic. No LLM call enters `sessions` — the mine's job
// is to hand an agent a small, well-shaped candidate batch and get out of the way.
// Generalizability ("is this worth remembering?") is a judgment and lives in the
// Phase 2 triage skill.
//
// `mine()` is a pure read: it never writes to the store. Persistence is the CLI's
// job (src/shards/cli.ts) so a test can mine a fixture corpus without touching
// anything on disk.

import { basename, dirname } from 'node:path';
import { getIndexDb } from '../cache';
import { globPrefix, resolveRepo, type RepoInfo } from '../repo';
import { buildRecord, gitAuthorEmail, normalizeText } from './record';
import type { ShardRecord, ShardScope } from './types';

/**
 * Length band for a candidate turn. Below the floor is "yes", "go on", a filename;
 * above the ceiling is a pasted spec or stack trace, not a durable fact. Exported so
 * tuning against real output is a one-line change (see the spec's Open Item).
 *
 * The band is authoritative over the NORMALIZED text — the form that gets stored and
 * fingerprinted. The identical band in SQL is only a cheap prefilter over the raw
 * column; normalization can only shorten a string, so the raw floor lets through
 * whitespace-padded turns that fall under the floor once collapsed, and the loop
 * re-applies the band after `normalizeText`.
 */
export const MIN_TEXT_LENGTH = 25;
export const MAX_TEXT_LENGTH = 240;

/**
 * FTS5 terms that shape the corrective narrowing. Measured starting point, exported
 * for tuning.
 *
 * Two tokenizer facts drive the shape of this list. The index tokenizes with
 * `porter unicode61`, so `stop` already matches "stopped" — but the porter stemmer
 * does NOT relate `wrong` and "wrongly", and unicode61 splits "don't" into the two
 * tokens `don` + `t`, so the bare term `dont` matches only the apostrophe-less
 * spelling. `"don t"` is the phrase query that catches the far more common "don't";
 * both spellings are listed because neither subsumes the other.
 */
export const CORRECTIVE_TERMS = ['always', 'never', 'instead', 'remember', 'dont', '"don t"', 'stop', 'wrong'];

/** The MATCH expression built from CORRECTIVE_TERMS. */
export const CORRECTIVE_MATCH = CORRECTIVE_TERMS.join(' OR ');

export interface MineOptions {
  /** Repo container to scope to; omit to mine all repos. */
  repo?: string;
  /** Minimum distinct phrasings for a cluster to be emitted. Default 1 for backfill. */
  minPhrasings?: number;
}

/**
 * The directory tree spanning every worktree of a repo.
 *
 * `--git-common-dir` is the one value identical from every worktree in BOTH layouts:
 * `<main>/.git` for a normal repo (even when asked from a linked worktree) and
 * `<proj>/.bare` for the bare-sibling layout. Its parent is therefore the tree that
 * spans all of a repo's worktrees.
 *
 * `resolveRepo().container` is NOT that: for a normal repo it falls through to the
 * *current* worktree's toplevel (src/repo.ts:32-37), so three sibling worktrees of
 * one repo look like three unrelated containers and a repo-local fact gets mislabeled
 * `workflow` — the exact failure mode clustering-by-container was chosen to avoid.
 * The guard keeps us honest for exotic git dirs (`--separate-git-dir`, submodule
 * `.git/modules/<name>`), where the parent directory means nothing.
 */
function containerFor(repo: RepoInfo): string {
  const base = basename(repo.gitCommonDir);
  if (base === '.git' || base === '.bare') return dirname(repo.gitCommonDir);
  return repo.container;
}

/**
 * A memoized `cwd -> container` resolver. `resolveRepo` shells out to git three
 * times per call; the live corpus has ~859 distinct cwds, so an unmemoized resolver
 * is ~2,600 subprocess spawns and a multi-minute mine.
 *
 * The resolver is injectable so a test can count calls and prove the memoization
 * holds — a wall-clock assertion alone would not.
 */
export function createContainerResolver(
  resolve: (cwd: string) => RepoInfo | null = resolveRepo,
): (cwd: string) => string {
  const memo = new Map<string, string>();
  return (cwd: string): string => {
    const hit = memo.get(cwd);
    if (hit !== undefined) return hit;
    let container = cwd;
    try {
      const repo = resolve(cwd);
      // Not a git repo (or git is absent entirely): the raw cwd is the best key we
      // have. Never throw — a single unresolvable path must not fail the mine.
      if (repo) container = containerFor(repo);
    } catch {}
    memo.set(cwd, container);
    return container;
  };
}

/**
 * The cwd predicate for `--repo`, plus the container every matching row must
 * resolve to.
 *
 * A path prefix alone is wrong. In the standard git layout linked worktrees are
 * SIBLINGS of the main worktree (`/repos/app`, `/repos/app-featureA`), so
 * `cwd GLOB '/repos/app/*'` matches none of them: prefix scoping returns zero of a
 * linked worktree's sessions when run from that worktree, and silently drops the
 * other worktrees when run from the main one — exactly the failure clustering by
 * container exists to prevent. `git worktree list` supplies the sibling paths
 * (`RepoInfo.branches`), and the container equality check discards whatever the
 * prefixes over-match: a nested clone or submodule under the container resolves to
 * a different container and is not this repo.
 *
 * `repo` may be any path inside the repo; the returned `container` is the canonical
 * key, so `mine({ repo: <linked worktree> })` and `mine({ repo: <main worktree> })`
 * mine the same set.
 */
export function repoScope(
  repo: string,
  resolve: (cwd: string) => RepoInfo | null = resolveRepo,
): { container: string; roots: string[] } {
  let info: RepoInfo | null = null;
  try {
    info = resolve(repo);
  } catch {}
  // Not a git repo (or git is absent): the raw path is the best key we have, and it
  // is its own only root.
  const container = info ? containerFor(info) : repo;
  const roots = new Set<string>([container]);
  if (info) for (const worktree of info.branches.keys()) roots.add(worktree);
  return { container, roots: [...roots].sort() };
}

/**
 * Scope from the containers a phrasing came from.
 *
 * One container is repo-local. Three or more unrelated containers is a fact about
 * how the user works, not about a codebase. Two is genuinely ambiguous — the spec
 * resolves it toward `repo`, keyed to the container contributing more sessions, ties
 * broken lexicographically so the output is byte-stable across runs.
 *
 * The spec says "the container with more phrasings"; this counts contributing
 * SESSIONS instead. The two are identical in Phase 1, where a cluster is exactly one
 * phrasing — but they diverge the moment Phase 2 merges paraphrases into a cluster,
 * so Phase 2 must recompute this on phrasings-per-container.
 */
export function deriveScope(sessionsPerContainer: Map<string, number>): ShardScope {
  if (sessionsPerContainer.size >= 3) return { type: 'workflow', key: '' };
  const ranked = [...sessionsPerContainer.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return { type: 'repo', key: ranked[0]?.[0] ?? '' };
}

interface CandidateRow {
  filePath: string;
  text: string;
  cwd: string;
  date: string;
}

interface Cluster {
  text: string;
  /** file_path -> cwd, deduped: one session contributes one vote however often it repeats. */
  sessions: Map<string, string>;
  dates: Set<string>;
}

/**
 * Mine the index for candidate shards.
 *
 * Async because the only exported index handle is `getIndexDb()`, which refreshes
 * the index before handing it back. Opening an independent read handle would skip
 * that refresh and silently mine a stale or absent index on a cold cache.
 */
export async function mine(opts: MineOptions = {}): Promise<ShardRecord[]> {
  const db = await getIndexDb();

  const containerOf = createContainerResolver();

  const conditions: string[] = [
    "m.role = 'user'",
    'm.msg_index >= 0', // CRITICAL: -1 is the subagent sentinel (src/cache.ts:420-423)
    'length(m.text) BETWEEN ? AND ?', // prefilter only; the band is re-applied to the normalized text
    'm.text MATCH ?',
  ];
  const params: (string | number)[] = [MIN_TEXT_LENGTH, MAX_TEXT_LENGTH, CORRECTIVE_MATCH];

  // Every worktree of the target repo, then an exact container check per row: the
  // prefixes are the cheap narrowing, the container is the definition. See repoScope.
  let container: string | undefined;
  if (opts.repo) {
    const scope = repoScope(opts.repo);
    container = scope.container;
    conditions.push(`(${scope.roots.map(() => 's.cwd = ? OR s.cwd GLOB ?').join(' OR ')})`);
    for (const root of scope.roots) params.push(root, globPrefix(root));
  }

  const stmt = db.query<CandidateRow, any[]>(`
    SELECT m.file_path AS filePath, m.text AS text, s.cwd AS cwd, s.date AS date
    FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
    WHERE ${conditions.join(' AND ')}
  `);

  // Collapse before counting. Grouping on the normalized text is a strict superset
  // of the byte-exact collapse the design calls for — it additionally folds pure
  // whitespace variants, which must not become two clusters because they fingerprint
  // to the same id. One eval fixture prompt appeared 14 times byte-identical in the
  // real corpus; without this it would have been the top candidate.
  const clusters = new Map<string, Cluster>();
  for (const row of stmt.iterate(...params)) {
    if (container && containerOf(row.cwd) !== container) continue;
    const text = normalizeText(row.text);
    // The band that counts is the one over the text we store: a whitespace-padded
    // turn clears the raw floor in SQL and falls under it once collapsed.
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) continue;
    let cluster = clusters.get(text);
    if (!cluster) {
      cluster = { text, sessions: new Map(), dates: new Set() };
      clusters.set(text, cluster);
    }
    cluster.sessions.set(row.filePath, row.cwd);
    cluster.dates.add(row.date);
  }

  const author = gitAuthorEmail();
  const minPhrasings = opts.minPhrasings ?? 1;

  const records: ShardRecord[] = [];
  for (const cluster of clusters.values()) {
    // A Phase 1 cluster is exactly one distinct phrasing: grouping paraphrases is an
    // LLM judgment and belongs to Phase 2, which merges records and recomputes this.
    const distinctPhrasings = 1;
    if (distinctPhrasings < minPhrasings) continue;

    const sessionsPerContainer = new Map<string, number>();
    for (const cwd of cluster.sessions.values()) {
      const container = containerOf(cwd);
      sessionsPerContainer.set(container, (sessionsPerContainer.get(container) ?? 0) + 1);
    }

    records.push(
      buildRecord({
        text: cluster.text,
        scope: deriveScope(sessionsPerContainer),
        author,
        sessions: [...cluster.sessions.keys()],
        dates: [...cluster.dates],
        distinctPhrasings,
      }),
    );
  }

  // Sort by id, not by insertion order: SQLite row order is an implementation
  // detail, and the determinism criterion compares whole batches.
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return records;
}
