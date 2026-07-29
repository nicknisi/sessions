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
// Type-only, so nothing here reaches into the store at runtime and `mine()` stays the
// pure read its header promises.
import type { WatermarkEntry } from './watermark';

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
  /**
   * Incremental mode: emit only phrasings that appear in at least one of these session
   * files. Absent means the full backfill; an EMPTY array means nothing changed and
   * the mine is a no-op, which is why this is `files?: string[]` and not a falsy check.
   *
   * The restriction narrows WHICH phrasings are emitted, never the evidence behind
   * them — see the two-pass comment in `mine`.
   */
  files?: string[];
}

/**
 * How many changed file paths to bind per statement. SQLite caps host parameters at
 * 999 by default and the query already binds 3 plus 2 per worktree root, so this
 * leaves room for a repo with an implausible number of worktrees. Same shape as
 * src/shards/store.ts's getPersistedStates and src/cache.ts's id chunking.
 */
export const FILE_CHUNK = 400;

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

/** The cwd predicate for a repo scope, plus the container every row must resolve to. */
function scopeClause(repo: string | undefined): { container?: string; clause?: string; params: string[] } {
  if (!repo) return { params: [] };
  const scope = repoScope(repo);
  const params: string[] = [];
  for (const root of scope.roots) params.push(root, globPrefix(root));
  return {
    container: scope.container,
    clause: `(${scope.roots.map(() => 's.cwd = ? OR s.cwd GLOB ?').join(' OR ')})`,
    params,
  };
}

/**
 * The session inventory the watermark compares against, scoped exactly the way the
 * mine that follows will be.
 *
 * Scoping matters more than it looks: `shards mine` defaults to the current repo, so
 * handing `advanceWatermark` the whole index would mark every other repo's changed
 * sessions as mined without examining them. This returns only what the same
 * `--repo`/`--all` choice will actually look at, so a narrow mine advances a narrow
 * watermark. See src/shards/watermark.ts.
 */
export async function indexedSessions(opts: MineOptions = {}): Promise<WatermarkEntry[]> {
  const db = await getIndexDb();
  const scope = scopeClause(opts.repo);
  const rows = db
    .query<{ filePath: string; mtime: number; size: number; cwd: string }, any[]>(
      `SELECT file_path AS filePath, mtime, size, cwd FROM sessions s${scope.clause ? ` WHERE ${scope.clause}` : ''}`,
    )
    .all(...scope.params);
  if (!scope.container) return rows.map(({ filePath, mtime, size }) => ({ filePath, mtime, size }));
  const containerOf = createContainerResolver();
  return rows
    .filter((row) => containerOf(row.cwd) === scope.container)
    .map(({ filePath, mtime, size }) => ({ filePath, mtime, size }));
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
  const scope = scopeClause(opts.repo);
  const container = scope.container;
  if (scope.clause) {
    conditions.push(scope.clause);
    params.push(...scope.params);
  }

  const scan = (extra: string[], extraParams: (string | number)[], onRow: (row: CandidateRow) => void): void => {
    const stmt = db.query<CandidateRow, any[]>(`
      SELECT m.file_path AS filePath, m.text AS text, s.cwd AS cwd, s.date AS date
      FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
      WHERE ${[...conditions, ...extra].join(' AND ')}
    `);
    for (const row of stmt.iterate(...params, ...extraParams)) onRow(row);
  };

  /** The normalized text a row contributes, or null when the row is out of scope. */
  const acceptedText = (row: CandidateRow): string | null => {
    if (container && containerOf(row.cwd) !== container) return null;
    const text = normalizeText(row.text);
    // The band that counts is the one over the text we store: a whitespace-padded
    // turn clears the raw floor in SQL and falls under it once collapsed.
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) return null;
    return text;
  };

  // Incremental mode is TWO passes, not one narrowed pass, and the difference is the
  // whole correctness argument.
  //
  // Pass 1 asks the cheap question: which phrasings appear in a session that changed
  // since the last mine? Pass 2 then rebuilds those phrasings' clusters over the FULL
  // corpus. Restricting the single pass instead would build each record from its
  // changed slice alone — and `upsertCandidates` overwrites `evidence` wholesale
  // (src/shards/store.ts's ON CONFLICT), so one new session would replace a
  // ten-session evidence list, reset firstSeen to today, and shrink what `quorum`
  // counts and `shards export` carries. Scope is the same failure one level louder:
  // `deriveScope` reads how many containers contributed, so a workflow-scoped fact
  // would be demoted to `repo` the moment only one repo's session changed.
  //
  // The rejected alternative was merging each fresh record against its stored row.
  // That needs containers the store does not keep (evidence holds session PATHS), a
  // defined answer for paths the index has since pruned, and a `Math.max` on
  // distinctPhrasings that would make snooze-resurface structurally impossible — the
  // fresh count would equal the stored baseline by construction, so
  // `shouldResurface`'s `fresh > stored` could never be true. One extra FTS scan buys
  // exact evidence, exact dates, and exact scope with none of that.
  //
  // Pass 1 is `ceil(files.length / FILE_CHUNK)` scans, so a caller that would restrict
  // to the ENTIRE inventory should pass `files: undefined` instead — the filter admits
  // everything either way, and the restriction is then pure cost. `runMine` does that
  // in src/shards/cli.ts's `mineRestriction`, which is what keeps a first
  // `--since-last` run as cheap as the full backfill it is equivalent to.
  let changedTexts: Set<string> | undefined;
  if (opts.files) {
    if (opts.files.length === 0) return [];
    changedTexts = new Set<string>();
    for (let i = 0; i < opts.files.length; i += FILE_CHUNK) {
      const chunk = opts.files.slice(i, i + FILE_CHUNK);
      scan([`m.file_path IN (${chunk.map(() => '?').join(',')})`], chunk, (row) => {
        const text = acceptedText(row);
        if (text !== null) changedTexts!.add(text);
      });
    }
    if (changedTexts.size === 0) return [];
  }

  // Collapse before counting. Grouping on the normalized text is a strict superset
  // of the byte-exact collapse the design calls for — it additionally folds pure
  // whitespace variants, which must not become two clusters because they fingerprint
  // to the same id. One eval fixture prompt appeared 14 times byte-identical in the
  // real corpus; without this it would have been the top candidate.
  const clusters = new Map<string, Cluster>();
  scan([], [], (row) => {
    const text = acceptedText(row);
    if (text === null) return;
    if (changedTexts && !changedTexts.has(text)) return;
    let cluster = clusters.get(text);
    if (!cluster) {
      cluster = { text, sessions: new Map(), dates: new Set() };
      clusters.set(text, cluster);
    }
    cluster.sessions.set(row.filePath, row.cwd);
    cluster.dates.add(row.date);
  });

  const author = gitAuthorEmail();
  const minPhrasings = opts.minPhrasings ?? 1;

  const records: ShardRecord[] = [];
  for (const cluster of clusters.values()) {
    // A cluster is exactly one distinct phrasing: grouping paraphrases is an LLM
    // judgment and belongs to the /shards triage skill, which merges records and
    // recomputes this.
    //
    // Phase 6 deliberately does NOT change that, and that is a RECORDED SPEC AMENDMENT
    // rather than an omission: see "Amendments recorded during implementation" and the
    // matching Open Item in docs/ideation/context-shards/spec-phase-6.md. An incremental
    // mine cannot make this number grow: a record is content-addressed on its own text
    // (src/shards/record.ts:105-110), so a genuinely new wording is a NEW record with a
    // new id, not a bump on an existing one. Counting occurrences or contributing
    // sessions instead is the "raw volume counting" the contract rejected — one eval
    // fixture prompt appeared 14 times byte-identical and would have topped the batch.
    //
    // The consequence is user-visible and documented as such: the resurface predicate's
    // second condition (src/shards/triage.ts) cannot fire through the shipped pipeline,
    // so a snooze currently hides a candidate indefinitely. Closing the gap needs a
    // clustering write-back — a surface for the /shards skill to record "these three
    // phrasings are one fact" — which no phase specifies. `src/shards/stream.test.ts`
    // locks this behavior so a future write-back has to change the test on purpose.
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
