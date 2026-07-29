# Implementation Spec: Context Shards - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Phase 1 builds the substrate every other phase reads: the portable shard record, a durable store that survives cache invalidation, and the backfill mine that turns transcripts into candidate records.

The architecture keeps a hard line between **deterministic** and **judgment** work. Everything in this phase is deterministic — narrowing, collapsing, clustering by repo container, fingerprinting, scope derivation. No LLM call enters `sessions`; the mine's job is to hand an agent a small, well-shaped candidate batch and get out of the way. That batch is emitted as stable JSON on stdout, which is the input contract Phase 2's `/shards` skill consumes.

The store is a **separate SQLite database from `index.db`**. This is not a stylistic choice. `index.db` is treated as disposable throughout this codebase: `--clear-cache` unlinks it (`index.ts:17-21`), `sessions cleanup` unlinks it (`index.ts:28-34`), and `getDb`'s corruption self-heal calls `removeDbFiles()` on a `user_version` mismatch (`src/cache.ts:216-222`). Approve/reject/snooze are human judgments no re-mine can reconstruct, so storing them in a database the tool deletes on schema bumps would silently destroy the feature. Shards live at `~/.local/share/sessions/shards.db`, resolved through a `SESSIONS_DATA_DIR` env override that mirrors the existing `SESSIONS_CACHE_DIR` pattern so tests stay hermetic.

Clustering keys on **repo container, not cwd**. Three sibling worktrees of one repo are three distinct `cwd` values; keying on `cwd` would spread a repo-local fact across three "unrelated" locations and mislabel it as workflow-scoped. Container resolution shells out to `git`, so it must fall back to the raw `cwd` when `git` is unavailable or the path is not a repo (`resolveRepo` returns `null`).

**Correction, made during implementation:** `resolveRepo(cwd).container` (`src/repo.ts:32-37`) is _not_ the container this phase needs. It only rises above the current worktree for the bare-sibling layout; for a normal repo it returns the **current worktree's toplevel**, so three sibling worktrees of one repo still look like three unrelated containers and the criterion this decision exists to satisfy fails. The container is instead derived from `git rev-parse --git-common-dir` — the one value identical from every worktree in both layouts (`<main>/.git`, `<proj>/.bare`) — and is the parent of that directory, guarded so exotic git dirs (`--separate-git-dir`, `.git/modules/<name>`) fall back to `resolveRepo().container`. This lives in `createContainerResolver()` (`src/shards/mine.ts`) and is tested for both layouts in `scope.test.ts`.

**This binds later phases.** `container` now means something narrower here than `RepoInfo.container` does elsewhere in the codebase, so Phase 3 injection must resolve `cwd → container` through `createContainerResolver()` from `src/shards/mine.ts`, **not** `resolveRepo(cwd)?.container ?? cwd`. Reading a stored `scope_key` with the looser definition would miss every shard mined from a sibling worktree. The same correction is why `--repo` scoping cannot be a path prefix: linked worktrees are siblings, not descendants, so the mine unions the repo's worktree paths (`RepoInfo.branches`) into the SQL predicate and then checks each row's resolved container for equality (`repoScope()` in `mine.ts`).

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Mine corrective-shaped user turns as the shard source** — rejected: deterministic command-frequency mining as the first tier. Measured against the live index: raw grouping found 1 repeated command out of 1,172 distinct in the target repo; naive normalization surfaced grep/ls/sed; runner-filtered normalization produced clean signal but 21 of 22 hits were package.json script names already visible to any agent.
- **Collapse byte-identical repeats, then cluster paraphrases at triage; only distinct phrasings count toward volume** — rejected: raw volume counting as borrowed from the source design. An eval fixture prompt appeared 14 times byte-identical in the real corpus and would have been promoted as a top candidate. Author diversity is what makes repetition evidential, and solo there is none — so exact repeats are clipboard noise while paraphrases are genuine repetition.
- **Backfill first** — rejected: stream-first incremental mining with a periodic digest. 4,498 unmined sessions of backlog versus an estimated 4-5 new facts per month.
- **Shard records live in a durable store outside the index cache directory** — rejected: a new table inside `index.db`. `index.db` is disposable; `--clear-cache`, `sessions cleanup`, and corruption self-heal all unlink it, and triage decisions cannot be reconstructed.
- **Cluster and derive scope by repo container via `resolveRepo`** — rejected: grouping candidates by the session's `cwd` string. `resolveRepo` spans worktrees including the `.bare` layout, so sibling worktrees are distinct cwds; a cwd-based test would pass while mislabeling every repo-local fact.
- **Candidate records carry evidence as counts, session paths, and a date range** — rejected: a fatter record embedding the verbatim source quote for each phrasing. Verbatim quotes are raw prompt text; any future export would carry actual conversations off the machine.
- **The generalizability rubric runs agent-side in a skill; sessions narrows and verifies** — rejected: LLM-based extraction inside sessions. `sessions` is a deterministic indexer compiling to a standalone two-dependency binary.
- **Shards stay out-of-band and are injected at runtime** — rejected: promoting shards into a repo's `AGENTS.md` via pull request. Committing exposes tool usage and puts churn in repos the user may not control.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/`

**Playground**: The test suite, plus the CLI itself. Create `src/shards/mine.test.ts` with a describe block and one smoke test before writing `mine.ts`; once the command dispatches, `bun run index.ts shards mine --repo <path> | jq '.[0]'` exercises it against the real index.

**Why this approach**: Every component here is a pure data transform over SQLite rows, so a scoped test runner is the tightest loop; the CLI is the acceptance check that the pieces compose.

## File Changes

### New Files

| File Path                           | Purpose                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shards/types.ts`               | The v1 `ShardRecord` interface, `ShardKind`, `ShardScope`, `ShardState`, `SCHEMA_VERSION`                                                                                            |
| `src/paths.ts`                      | `getDataDir` / `getShardsDbPath`, in a neutral module so the installer does not import a feature module (and does not pull `bun:sqlite` into the setup path)                         |
| `src/shards/store.ts`               | Durable SQLite store: schema, open/close, read/write helpers                                                                                                                         |
| `src/shards/record.ts`              | Normalization + content-addressed fingerprinting + deterministic record construction                                                                                                 |
| `src/shards/mine.ts`                | Backfill mine: FTS narrowing, byte-exact collapse, container clustering, scope derivation                                                                                            |
| `src/shards/cli.ts`                 | Arg parsing and dispatch for the `shards` command group                                                                                                                              |
| `src/shards/fixtures.ts`            | Shared hermetic harness (synthesized JSONL + `SESSIONS_*` env) for the five shard test files. Deliberately named outside `bun test`'s collection globs so it is not itself collected |
| `src/shards/mine.test.ts`           | Mine emits schema-valid records; sentinel row excluded                                                                                                                               |
| `src/shards/dedupe.test.ts`         | Byte-identical collapse                                                                                                                                                              |
| `src/shards/record.test.ts`         | Byte-identical determinism across two runs                                                                                                                                           |
| `src/shards/store.test.ts`          | `listShards` state and scope filters; `getPersistedStates`                                                                                                                           |
| `src/shards/cli.test.ts`            | `parseMineArgs` (unknown option, missing `--repo` value, `--all`/`--repo` conflict); empty corpus exits 0; the stdout batch carries persisted state                                  |
| `src/shards/scope.test.ts`          | Repo-container versus workflow scope derivation; `--repo` scoping across sibling worktrees                                                                                           |
| `src/shards/durability.test.ts`     | Shard state survives `--clear-cache`, `cleanup`, and corruption self-heal                                                                                                            |
| `src/shards/no-repo-writes.test.ts` | No shard operation writes into the cwd tree                                                                                                                                          |
| `src/shards/mine.perf.test.ts`      | Mine time budget against a generated fixture DB                                                                                                                                      |

### Modified Files

| File Path      | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | Add a `shards` command branch dispatching to `src/shards/cli.ts` via dynamic import, following the existing `report` / `setup` pattern (`index.ts:41-60`)                                                                                                                                                                                                                                                                                                                                                                        |
| `src/cli.ts`   | Add a `shards mine` row to the `--help` command table                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/setup.ts` | **Not anticipated when this spec was written.** `runUninstall` deleted `~/.local/share/sessions` wholesale, so `sessions cleanup` would have destroyed `shards.db` and every triage decision in it — the exact failure the durable store exists to prevent. Uninstall is now scoped to the two subtrees the installer creates (`plugin/`, `.claude-plugin/`) via the exported `removeInstalledFiles()` seam, which `durability.test.ts` asserts. User-visible: `sessions uninstall` no longer removes the data directory itself. |
| `README.md`    | Add the `shards mine` command row; note that uninstall preserves triage decisions in the data dir                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/repo.ts`  | No change expected — `resolveRepo` and `globPrefix` are already exported                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Implementation Details

### The v1 shard record

**Overview**: A portable, self-contained document. Content-addressed identity and the author stamp are the two fields that cannot be repaired retroactively, which is why they exist in Phase 1 despite having no consumer until Phase 4.

```typescript
export const SHARD_SCHEMA_VERSION = 1;

export type ShardKind = 'instruction' | 'information';
export type ShardState = 'candidate' | 'approved' | 'rejected' | 'snoozed';

export interface ShardScope {
  /** 'repo' — confined to one repo container; 'workflow' — spans unrelated containers. */
  type: 'repo' | 'workflow';
  /** Repo container path for 'repo'; empty string for 'workflow'. */
  key: string;
}

export interface ShardEvidence {
  /** Count of DISTINCT phrasings after byte-exact collapse — never raw occurrences. */
  distinctPhrasings: number;
  /** Session file paths the phrasings came from, sorted ascending for determinism. */
  sessions: string[];
  /** 'YYYY-MM-DD' bounds across the contributing sessions. */
  firstSeen: string;
  lastSeen: string;
}

export interface ShardRecord {
  v: number;
  /** `sha256:<hex>` over the normalized text — stable across runs and machines. */
  id: string;
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  /** git user.email, or 'unknown' when git is unavailable. */
  author: string;
  evidence: ShardEvidence;
  state: ShardState;
  /** 'YYYY-MM-DD' or null. */
  snoozedUntil: string | null;
}
```

**Key decisions**:

- `distinctPhrasings` is deliberately named to make the collapse semantics unmissable. A reviewer seeing `occurrences` would not know that 14 identical fixture prompts count as 1.
- `evidence.sessions` is sorted ascending. Unsorted arrays are the most likely source of run-to-run byte differences, and the determinism criterion asserts full-record equality, not just id equality.
- `author` defaults to `'unknown'` rather than throwing. A missing git identity must not block mining.

**Implementation steps**:

1. Write `src/shards/types.ts` with the interfaces above.
2. In `record.ts`, implement `normalizeText(raw: string): string` — collapse all whitespace runs to a single space, trim, lowercase for hashing only (the stored `text` keeps original casing).
3. Implement `fingerprint(normalized: string): string` returning `` `sha256:${hash}` ``. Use `Bun.CryptoHasher` — it is built in, so no dependency is added.
4. Implement `buildRecord(...)` that assembles a `ShardRecord` with sorted evidence and a stable field order.

**Feedback loop**:

- **Playground**: `src/shards/record.test.ts` with a describe block and one smoke test asserting a known string hashes to a stable id.
- **Experiment**: Build the same record twice from the same inputs supplied in different array orders; assert `JSON.stringify` equality. Then vary only whitespace in the source text and assert the id is unchanged.
- **Check command**: `bun test src/shards/record.test.ts`

### Durable store

**Pattern to follow**: `src/cache.ts:33-45` for env-overridable path resolution, and `src/cache.ts:112-122` for `openDb` PRAGMA setup.

**Overview**: A second SQLite database, deliberately outside the cache directory, holding shard records and their triage state.

```typescript
// src/paths.ts — neutral, so src/setup.ts can import the data dir without importing
// a feature module (and without dragging bun:sqlite into the setup/uninstall path).
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(homedir(), '.local', 'share', 'sessions');
}

export function getShardsDbPath(): string {
  return join(getDataDir(), 'shards.db');
}

// src/shards/store.ts
/** Idempotent; creates the data dir if absent. Never deletes on schema mismatch. */
export function getShardsDb(): Database;
export function closeShardsDb(): void;

export function upsertCandidates(records: ShardRecord[]): void;
export function listShards(filter?: { state?: ShardState; scope?: ShardScope }): ShardRecord[];
/** Stored state for a batch of ids — the store, not a fresh mine, is the authority. */
export function getPersistedStates(ids: string[]): Map<string, { state: ShardState; snoozedUntil: string | null }>;
export function setState(id: string, state: ShardState, snoozedUntil?: string | null): void;
```

**Key decisions**:

- **Migrate, never drop.** `cache.ts` legitimately rebuilds on `user_version` mismatch because it can re-derive everything from transcripts. This store cannot — a user's rejections are unrecoverable. On a future schema bump, add columns; never `removeDbFiles`.
- `upsertCandidates` preserves existing `state` and `snoozedUntil` for a record whose `id` already exists, updating only `evidence`. A re-mine must not resurrect a rejected shard by overwriting its state.
- The data dir is created with `mkdirSync(..., { recursive: true })` on first open.

**Implementation steps**:

1. Implement `getDataDir` / `getShardsDbPath` in `src/paths.ts` with the env override, resolved lazily (not frozen at import) so hermetic tests can mutate the env — this is the same laziness rationale as `src/cache.ts:41-45`.
2. Implement `getShardsDb()`: create the dir, open, set `busy_timeout=5000`, `journal_mode=WAL`, then `CREATE TABLE IF NOT EXISTS shards (...)` with `id TEXT PRIMARY KEY`.
3. Implement `closeShardsDb()` clearing the module singleton, mirroring `closeDb()` (`src/cache.ts:94-105`).
4. Implement `upsertCandidates` with `ON CONFLICT(id) DO UPDATE SET evidence=excluded.evidence` — state columns deliberately excluded from the update.
5. Implement `listShards` and `setState`.

**Feedback loop**:

- **Playground**: `src/shards/durability.test.ts` pointing `SESSIONS_DATA_DIR` and `SESSIONS_CACHE_DIR` at separate tmpdirs.
- **Experiment**: Write an approved shard; call `clearCache()`; assert the shard is still readable. Repeat for `runUninstall()`-then-`clearCache()` (the `cleanup` path) and for a forced `index.db` deletion.
- **Check command**: `bun test src/shards/durability.test.ts`

### Backfill mine

**Pattern to follow**: `src/cache.ts:596-620` for building a cwd-filtered query with `globPrefix`; `src/wrapped/content.ts:25-27` for the `msg_index >= 0` sentinel exclusion.

**Overview**: Narrow the corpus to corrective-shaped user turns, collapse byte-identical repeats, group by repo container, derive scope, and emit records.

```typescript
export interface MineOptions {
  /** Repo container to scope to; omit to mine all repos. */
  repo?: string;
  /** Minimum distinct phrasings for a cluster to be emitted. Default 1 for backfill. */
  minPhrasings?: number;
}

/**
 * Async, not the synchronous signature originally drafted here: the only exported
 * index handle is `getIndexDb()`, which refreshes the index before returning it.
 * Opening an independent read handle would skip that refresh and silently mine a
 * stale or absent index on a cold cache. Phase 2 codes against this signature.
 */
export function mine(opts: MineOptions): Promise<ShardRecord[]>;
```

The narrowing predicate:

```sql
SELECT m.file_path, m.text, s.cwd, s.date
FROM message_fts m
JOIN sessions s ON s.file_path = m.file_path
WHERE m.role = 'user'
  AND m.msg_index >= 0            -- CRITICAL: -1 is the subagent sentinel row
  AND length(m.text) BETWEEN 25 AND 240
  AND m.text MATCH 'always OR never OR instead OR remember OR dont OR stop OR wrong'
```

**Key decisions**:

- **`msg_index >= 0` is not optional.** `msg_index = -1` is a sentinel row holding concatenated _subagent_ user text (`src/cache.ts:420-423`). Without this filter the mine ingests agent-authored prose as things the user typed, which directly damages the 50%-approval goal.
- The mine **inherits** `parser.ts`'s genuine-user-turn filtering rather than reimplementing it — `message_fts` user rows are already filtered to genuine turns (`src/cache.ts:409-419`), so compaction summaries and harness injections never appear.
- The 25-240 character band and the MATCH term list are the measured starting point (488 candidates across the live index). They are tunable constants exported from `mine.ts`, not inlined literals. The band in SQL is only a **prefilter over the raw column**; it is re-applied to the normalized text after collapse, because normalization can only shorten a string and a whitespace-padded turn would otherwise be stored below the floor.
- Byte-exact collapse happens **before** counting: group by the exact `text` string, keep one representative per distinct string, then count distinct strings within a cluster.
- Scope derivation: resolve each contributing session's `cwd` to a container via `createContainerResolver()` (see the container correction in Technical Approach — **not** `resolveRepo(cwd)?.container ?? cwd`, which returns the current worktree toplevel for a normal repo). One distinct container → `{type:'repo', key:container}`. Three or more distinct containers → `{type:'workflow', key:''}`. Two containers is ambiguous — treat as `repo` keyed to the container with more phrasings, ties broken by lexicographic order for determinism. **Implemented on sessions-per-container**, which is identical in Phase 1 (a cluster is exactly one phrasing) but diverges once Phase 2 merges paraphrases; Phase 2 recomputes it on phrasings.
- `resolveRepo` shells out to `git` per cwd. Memoize by cwd within a single mine run; 859 distinct cwds otherwise means 859 subprocess spawns.

**Implementation steps**:

1. Write the narrowing query with the predicate above. When `opts.repo` is set, a single `globPrefix` prefix is **not** sufficient: linked worktrees are siblings of the main worktree, not descendants of it. Resolve the target to its container, union that container with every path in `RepoInfo.branches` (`git worktree list`) as `(s.cwd = ? OR s.cwd GLOB ?)` alternatives, and then keep only rows whose resolved container equals the target — the prefixes narrow, the container decides (a nested clone under the container is a different repo).
2. Group rows by exact `text`; build a map of distinct text → contributing session paths and dates.
3. Memoize `cwd → container` resolution; group distinct texts into clusters. **In this phase a cluster is one distinct text** — paraphrase clustering is an LLM judgment and belongs to Phase 2. The record's `distinctPhrasings` is therefore 1 for every Phase 1 candidate; Phase 2 merges records and recomputes it.
4. Derive scope per cluster, build records via `buildRecord`, sort the output array by `id` for determinism.
5. Persist with `upsertCandidates` and print the batch as JSON to stdout.

**Feedback loop**:

- **Playground**: `src/shards/mine.test.ts` building a hermetic index from synthesized JSONL (follow `src/cache.search.test.ts:24-37`).
- **Experiment**: A fixture with (a) the same prompt 14 times in one session, (b) one corrective turn in three sibling worktrees of one repo, (c) one corrective turn in three unrelated repos, (d) a `msg_index = -1` sentinel row containing corrective language. Assert: (a) yields `distinctPhrasings: 1`; (b) yields `scope.type: 'repo'`; (c) yields `scope.type: 'workflow'`; (d) produces no record at all.
- **Check command**: `bun test src/shards/mine.test.ts`

### CLI dispatch

**Pattern to follow**: `index.ts:53-60` (the `report` branch) for dynamic-import dispatch on `Bun.argv[2]`.

**Overview**: A `shards` command group. Phase 1 ships only `mine`; Phase 2 adds `approve`/`reject`/`snooze`, Phase 4 adds `export`/`import`.

```
sessions shards mine [--repo <path>] [--json]

  --repo <path>   Scope to one repo container (default: the current repo)
  --all           Mine every repo in the index
  --json          Emit the candidate batch as JSON on stdout (default when piped)
```

**Key decisions**:

- Dispatch on the positional word only, matching the deliberate fix noted at `index.ts:23-25` — matching anywhere in argv let a flag value fire a command.
- JSON goes to stdout; human-readable progress goes to stderr. This is what makes the batch pipeable into Phase 2's skill.

**Implementation steps**:

1. Add `if (command === 'shards') { const { runShards } = await import('./src/shards/cli'); await runShards(Bun.argv.slice(3)); process.exit(0); }` to `index.ts`.
2. Implement `runShards` with a subcommand switch and a `--help` text matching the house style in `src/context.ts:29-48`.

**Feedback loop**:

- **Playground**: The tool itself.
- **Experiment**: `bun run index.ts shards mine --repo "$PWD" | jq 'length'` then `| jq '.[0].scope'`.
- **Check command**: `bun run index.ts shards mine --repo "$PWD" --json | jq -e 'type == "array"'`

## Data Model

```sql
CREATE TABLE IF NOT EXISTS shards (
  id            TEXT PRIMARY KEY,     -- sha256:<hex> over normalized text
  v             INTEGER NOT NULL,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- 'instruction' | 'information'
  scope_type    TEXT NOT NULL,        -- 'repo' | 'workflow'
  scope_key     TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL,
  evidence      TEXT NOT NULL,        -- JSON: ShardEvidence
  state         TEXT NOT NULL,        -- 'candidate' | 'approved' | 'rejected' | 'snoozed'
  snoozed_until TEXT,                 -- 'YYYY-MM-DD' or NULL
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shards_state ON shards(state);
CREATE INDEX IF NOT EXISTS idx_shards_scope ON shards(scope_type, scope_key);
```

`PRAGMA user_version` is set to `SHARD_SCHEMA_VERSION`, but **a mismatch triggers migration, not deletion** — the opposite of `src/cache.ts:118-122`.

## Testing Requirements

### Unit Tests

| Test File                           | Coverage                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/shards/record.test.ts`         | Fingerprint stability, byte-identical records across two runs                                      |
| `src/shards/dedupe.test.ts`         | 14 identical prompts collapse to `distinctPhrasings: 1`                                            |
| `src/shards/mine.test.ts`           | Schema-valid records; `msg_index = -1` sentinel never mined                                        |
| `src/shards/store.test.ts`          | `listShards` filtering by each state and by repo/workflow scope                                    |
| `src/shards/cli.test.ts`            | `parseMineArgs`; empty corpus exits 0; persisted state on stdout                                   |
| `src/shards/scope.test.ts`          | Sibling worktrees → `repo`; unrelated containers → `workflow`; `mine({repo})` spans every worktree |
| `src/shards/durability.test.ts`     | State survives `--clear-cache`, `cleanup`, corruption self-heal                                    |
| `src/shards/no-repo-writes.test.ts` | cwd tree byte-unchanged after mine                                                                 |
| `src/shards/mine.perf.test.ts`      | Mine completes under 5s on a representative fixture DB                                             |

**Key test cases**:

- Same fixture mined twice → `JSON.stringify(run1) === JSON.stringify(run2)`, covering evidence array order, date formatting, and cluster order — not just id equality.
- A corrective turn appearing only in a `msg_index = -1` row produces zero records.
- Whitespace-only differences in source text produce the same `id`.
- `upsertCandidates` over an already-`rejected` id leaves `state` as `rejected`, **and the batch printed to stdout reports it as `rejected`** — the pipe is the Phase 2 interface, so it must agree with the table.
- `mine({ repo: <main worktree> })` returns the sessions of every sibling worktree, and `mine({ repo: <linked worktree> })` returns the same set.
- A whitespace-padded turn that clears the raw length floor but falls under it once collapsed produces no record.
- `resolveRepo` returning `null` (non-git directory) falls back to raw cwd without throwing.
- Empty corpus → empty array, exit 0, not an error.

### Manual Testing

- [ ] `bun run index.ts shards mine --repo "$PWD"` returns candidates from the real index in under 5 seconds
- [ ] `ls ~/.local/share/sessions/shards.db` exists after the first mine
- [ ] `sessions --clear-cache` then re-read the store — shards still present

## Failure Modes

| Component | Failure Mode                        | Trigger                                          | Impact                                              | Mitigation                                                                  |
| --------- | ----------------------------------- | ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Store     | Triage decisions destroyed          | `--clear-cache` / `cleanup` / schema bump        | Every approval and rejection lost, silently         | Separate DB outside the cache dir; migrate-never-drop; `durability.test.ts` |
| Mine      | Subagent prose mined as user speech | `msg_index = -1` sentinel row included           | Precision goal damaged by agent-authored text       | `msg_index >= 0` in the predicate; asserted in `mine.test.ts`               |
| Mine      | Repo facts mislabeled as workflow   | Clustering by `cwd` across sibling worktrees     | Shards leak into unrelated repos                    | Cluster by `resolveRepo().container`; asserted in `scope.test.ts`           |
| Mine      | Fixture prompts promoted            | Byte-identical repeats counted as volume         | Top candidate is a copy-pasted eval prompt          | Byte-exact collapse before counting; asserted in `dedupe.test.ts`           |
| Mine      | 859 subprocess spawns               | `resolveRepo` called per row without memoization | Multi-minute mine, blowing the 5s budget            | Memoize `cwd → container` per run                                           |
| Mine      | Cold-index stall                    | First mine after `--clear-cache` or schema bump  | `ensureIndexFresh` reindexes 4,498 sessions first   | Budget measures mine time against a refreshed index; documented in the goal |
| Record    | Non-deterministic output            | Unsorted evidence arrays or locale date strings  | Determinism criterion fails intermittently          | Sort `evidence.sessions`; use `YYYY-MM-DD` strings only                     |
| Store     | Rejected shard resurrected          | Re-mine upserts and overwrites `state`           | User re-triages the same rejected candidate forever | `ON CONFLICT` updates `evidence` only                                       |

## Validation Commands

```bash
bun run lint
bun run format:check
bun run typecheck
bun test src/shards/
bun test
bun run build
```

## Open Items

- [ ] The MATCH term list and 25-240 character band are the measured starting point; tune against real output before Phase 2 consumes it, and keep them exported constants so tuning is a one-line change.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
