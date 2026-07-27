# Implementation Spec: Memory Hygiene & Measured Retrieval - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

`sessions` crossed a line when `memory.db` landed: until then every byte it held was a rebuildable projection of the transcripts, which is what made `--clear-cache`, `cleanup`, and a `SCHEMA_VERSION` bump safe destructive operations. `src/paths.ts` already encodes that distinction in its doc comments — `getDataDir()` is "durable state… nothing under here is [rebuildable]" while `getCacheDir()` is the "disposable search index". This phase supplies the operational discipline that distinction implies but never got.

Three independent pieces, all small, all in service of one property: **the durable store cannot be damaged by accident.**

1. **Hermeticity by default.** Today it depends on every test remembering `SESSIONS_MEMORY_DB` / `SESSIONS_CACHE_DIR` — 11 of 41 test files do so across 42 occurrences, and the discipline has already failed once by accident. Because `src/paths.ts` resolves every location lazily from env on each call (never frozen at import), a `bunfig.toml` `[test] preload` that points the env at a per-run temp dir makes hermeticity the default for all 41 files with **zero shipped production code**. A preload cannot reach a child process spawned via `Bun.spawn`, so a narrow runtime refusal covers that case and only that case.
2. **Refresh backoff.** `refreshIndex` (src/cache.ts:521) sets `_lastRefreshAt` only inside the `try`, so a persistently failing refresh re-runs the full `discoverFiles` + stat pass on every subsequent call.
3. **Durable backup.** A snapshot on every lesson write. `VACUUM INTO` rather than a file copy, because a copy of a live SQLite database is not a valid backup; a cross-process lock with a generation check rather than a bare atomic rename, because rename is atomic but not ordered — a slow older snapshot can land after a newer one.

The cross-process refresh marker rides along here because it lives on the same refresh path as (2), even though it is a throughput fix on the *re-derivable* index rather than a durability one.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Test hermeticity comes from a `bunfig.toml [test] preload`, with a runtime refusal only for spawned children** — rejected: a test-awareness branch inside `src/memory.ts` and `src/cache.ts`. `paths.ts` already resolves lazily from env on every call, so a preload makes hermeticity the default for all 41 test files with zero shipped production code; the runtime guard is kept only where a preload cannot reach.
- **Back up by auto-exporting plaintext and snapshotting the store on write** — rejected: a rotating `memory.db` snapshot on a launchd timer, and an import/restore command. A timer adds an unattended job to a tool that has none. Three critics flagged that an "export restores a deleted store" criterion had no importer behind it and would have required reconstructing `content_hash` uniqueness and supersedes chains — snapshotting the DB makes restore a file replacement, and the plaintext export stays the human-readable artifact.
- **Snapshot takes a cross-process lock with a generation check** — rejected: bare `VACUUM INTO` + atomic rename. Rename is atomic but not ordered: two processes can each produce a consistent snapshot and the older one can still land last, silently losing the newer rows.
- **No network, daemon, or HTTP surface of any kind** — rejected: a localhost daemon to amortize process startup. Measured 65ms warm end-to-end makes a subprocess fine, SQLite already handles concurrent readers, and a daemon reintroduces the orphan-process failure this repo already fixed once.

## Feedback Strategy

**Inner-loop command**: `bun test src/hermetic.test.ts src/cache.refresh.test.ts src/memory.export.test.ts`

**Playground**: Test suite. All three components are data/logic layers with no UI and no network.

**Why this approach**: Every change here is a behavioral guarantee about files on disk — exactly what a scoped test runner checks fastest, and the repo's suite already runs in under a second.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `bunfig.toml` | `[test] preload` that redirects every `SESSIONS_*` path at a per-run temp dir |
| `src/test-preload.ts` | The preload itself: creates the temp dir, sets the env, registers cleanup |
| `src/hermetic.test.ts` | Asserts the guard refuses real paths, including from a spawned child |
| `src/cache.refresh.test.ts` | Backoff after repeated failure; one tree walk across two processes |
| `src/memory.export.test.ts` | Snapshot consistency, restore fidelity, concurrent-writer freshness, failure isolation |
| `src/__fixtures__/concurrent-refresh.ts` | Spawnable child that triggers a refresh — mirrors `concurrent-remember.ts` |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/paths.ts` | Add `assertNotRealStore()` — throws if a real path is resolved while `SESSIONS_TEST=1`. Called from the two DB openers only. |
| `src/cache.ts` | Set `_lastRefreshAt` on failure too, with a backoff interval; persist a refresh marker row so a second process sees a recent walk; call the guard in `openDb` |
| `src/memory.ts` | Snapshot-on-write via `VACUUM INTO` under a lock with a generation check; call the guard in the memory DB opener |

## Implementation Details

### 1. Hermeticity by default

**Pattern to follow**: `src/paths.ts` — every getter already reads env on each call.

**Overview**: A Bun test preload sets `SESSIONS_HOME`, `SESSIONS_DATA_DIR`, `SESSIONS_CACHE_DIR`, `SESSIONS_MEMORY_DB`, and `SESSIONS_HANDOFF_DIR` at a fresh temp dir before any test module loads, plus `SESSIONS_TEST=1`. Because `Bun.spawn` inherits the environment, children get the same redirection for free — but a child invoked with a scrubbed env would not, so the runtime guard is the backstop.

```typescript
// src/paths.ts
/** Refuses a real durable path while under test. The preload redirects every
 *  SESSIONS_* var, so reaching a real path here means the redirection was lost
 *  — a scrubbed child env, or a test that resets process.env itself. */
export function assertNotRealStore(resolved: string, kind: 'memory' | 'index'): void {
  if (!process.env.SESSIONS_TEST) return;
  const real = kind === 'memory'
    ? join(homedir(), '.local', 'share', 'sessions', 'memory.db')
    : join(homedir(), '.cache', 'sessions', 'index.db');
  if (resolved === real) {
    throw new Error(`refusing to open the real ${kind} store under test: ${resolved}`);
  }
}
```

**Key decisions**:
- The guard compares against `homedir()` directly, not `getHome()` — `getHome()` is already redirected under test, so comparing to it would never match.
- It fires only when `SESSIONS_TEST` is set, so production paths are untouched.
- Called from the two DB openers (`openDb` in cache.ts, the memory opener at memory.ts:154) rather than from the path getters, because the getters are used for display and cleanup where resolving a real path is legitimate.

**Implementation steps**:
1. Write `src/test-preload.ts`: `mkdtemp`, set the five env vars plus `SESSIONS_TEST=1`.
2. Add `bunfig.toml` with `[test] preload = ["./src/test-preload.ts"]`.
3. Add `assertNotRealStore` to `src/paths.ts`.
4. Call it in `openDb` (cache.ts) and the memory opener (memory.ts).
5. Delete now-redundant per-test env setup **only where it is pure duplication** — leave any test that deliberately uses a *specific* path.

**Feedback loop**:
- **Playground**: `src/hermetic.test.ts` with one smoke test asserting `getMemoryDbPath()` is under the temp dir.
- **Experiment**: (a) in-process open of the real path with env restored → throws; (b) `Bun.spawn` a child with `env: {}` that tries to open the real store → child exits non-zero; (c) a normal test run touches neither real file.
- **Check command**: `bun test src/hermetic.test.ts`

### 2. Refresh backoff and a cross-process marker

**Pattern to follow**: `src/cache.ts:521-534` (the existing coalescing block).

**Overview**: Two changes on one path. Record the attempt time on failure as well as success so a broken refresh backs off; persist the last successful walk in a `meta` row so a second process can skip a walk another just did.

```typescript
// src/cache.ts
const FAILURE_BACKOFF_MS = 30_000;

export async function refreshIndex(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;
  const promise = runRefreshIndex();
  _refreshPromise = promise;
  try {
    const result = await promise;
    _lastRefreshAt = Date.now();
    _lastRefreshResult = result;
    writeRefreshMarker(Date.now());   // visible to other processes
    return result;
  } catch (err) {
    // A persistent failure must not re-walk the tree on every call.
    _lastRefreshAt = Date.now() - refreshIntervalMs() + FAILURE_BACKOFF_MS;
    throw err;
  } finally {
    if (_refreshPromise === promise) _refreshPromise = null;
  }
}
```

**Key decisions**:
- On failure, `_lastRefreshAt` is set *back-dated* so the next attempt happens after `FAILURE_BACKOFF_MS` rather than after the full interval — a transient failure should not lock out refresh for the whole window.
- The marker is a row in the existing index DB, not a separate file: it is disposable with the index, which is correct, and it inherits the DB's `busy_timeout`.
- The marker is advisory. A process still walks if the marker is older than the interval. It removes redundant walks; it does not coordinate them.

**Implementation steps**:
1. Add a `meta(key TEXT PRIMARY KEY, value TEXT)` table to the schema; bump `SCHEMA_VERSION`.
2. `writeRefreshMarker(ts)` / `readRefreshMarker(): number`.
3. In `ensureIndexFresh` (cache.ts:543), consult the marker as well as `_lastRefreshAt`.
4. Add the failure branch above.

**Feedback loop**:
- **Playground**: `src/cache.refresh.test.ts` over a temp cache dir with two fixture transcripts.
- **Experiment**: (a) stub `discoverFiles` to throw, call `ensureIndexFresh` 5× in a row, assert the walk was attempted once not five times; (b) spawn `concurrent-refresh.ts` twice against one cache dir and assert exactly one walk is recorded.
- **Check command**: `bun test src/cache.refresh.test.ts`

### 3. Snapshot-on-write

**Pattern to follow**: `exportLessons()` (src/memory.ts:942) for the plaintext half; `src/__fixtures__/concurrent-remember.ts` for the concurrency test shape.

**Overview**: After a successful lesson write, produce two artifacts beside the store: `lessons.jsonl` (human-readable, what `exportLessons()` already computes) and `memory.db.snapshot` (a `VACUUM INTO` output). The snapshot rename happens under a lock with a generation check so the newest snapshot always wins.

```typescript
// src/memory.ts
/** Snapshot after a committed write. Never throws into the caller: a failed
 *  backup must not fail the lesson that triggered it. */
function snapshotAfterWrite(db: Database): void {
  try {
    const gen = db.query<{ n: number }, []>('PRAGMA data_version').get()?.n ?? 0;
    const tmp = `${getMemoryDbPath()}.snap.${process.pid}`;
    db.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    withSnapshotLock(() => {
      // Ordering guard: rename is atomic but not ordered. Without this a slow
      // older snapshot can land after a newer one and silently lose rows.
      if (gen >= readSnapshotGeneration()) {
        renameSync(tmp, `${getMemoryDbPath()}.snapshot`);
        writeSnapshotGeneration(gen);
      } else {
        rmSync(tmp, { force: true });
      }
    });
    writeFileSync(`${dirname(getMemoryDbPath())}/lessons.jsonl`,
      exportLessons().map(l => JSON.stringify(l)).join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`warning: lesson snapshot failed (the lesson was saved): ${err}\n`);
  }
}
```

**Key decisions**:
- `VACUUM INTO` rather than `copyFileSync`: it takes a read transaction, so the output is a consistent database even with a concurrent writer. A raw copy is not.
- `PRAGMA data_version` as the generation counter — it already increments on every committed change from any connection, so no new bookkeeping.
- The lock is an atomic `mkdir` (the repo's existing idiom), reaping only a confirmed-dead PID.
- Failures are swallowed with a warning. A backup that can fail a write is worse than no backup.

**Implementation steps**:
1. `withSnapshotLock`, `readSnapshotGeneration`, `writeSnapshotGeneration` (generation stored in a sidecar file next to the snapshot).
2. `snapshotAfterWrite`, called at the end of `rememberLesson` (memory.ts:542) after the transaction commits.
3. Wire the same call into any other committed mutation (`resolveReview`, `retire`).

**Feedback loop**:
- **Playground**: `src/memory.export.test.ts` over a temp `SESSIONS_MEMORY_DB`.
- **Experiment**: (a) write 3 lessons, delete `memory.db`, restore the snapshot, assert all 3 rows plus supersedes chains and review groups survive; (b) two processes writing concurrently → the surviving snapshot contains the **latest** committed rows, not merely a valid DB; (c) make `VACUUM INTO` fail (unwritable dir) → `rememberLesson` still returns success.
- **Check command**: `bun test src/memory.export.test.ts`

## Data Model

```sql
-- New, in the index DB (disposable with it)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- key = 'last_refresh_ms'
```

No change to the `lessons` schema. The snapshot is a byte-level copy; the export is derived.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/hermetic.test.ts` | Guard fires in-process and in a spawned child; a normal run touches no real file |
| `src/cache.refresh.test.ts` | Failure backoff; cross-process marker; marker expiry still permits a walk |
| `src/memory.export.test.ts` | Snapshot consistency, restore fidelity, concurrent freshness, failure isolation |

**Key test cases**:
- A test that resets `process.env` mid-run still cannot open the real store.
- Five consecutive failing refreshes attempt the walk once.
- Two concurrent writers: the surviving snapshot holds the later write.
- A snapshot failure leaves `rememberLesson`'s return value unchanged.
- Restoring a snapshot preserves `supersedes_id`, `superseded_by`, and `review_group`.

### Manual Testing

- [ ] `bun test` leaves `~/.local/share/sessions/memory.db` and `~/.cache/sessions/index.db*` byte-identical.
- [ ] Save a lesson for real; confirm `lessons.jsonl` and `memory.db.snapshot` appear beside the store.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Preload | Redirection lost in a child | `Bun.spawn` with a scrubbed `env` | Child writes the real store | `assertNotRealStore` in the DB openers |
| Preload | Temp dir not cleaned | Test process killed | Disk litter in `$TMPDIR` | Accepted — OS reclaims it |
| Backoff | Legitimate refresh delayed | Transient failure then recovery | Index up to 30s stale | Backoff is 30s, far below the failure cost |
| Marker | Stale marker suppresses a needed walk | Clock moved backwards | Search misses a new transcript | Treat a future-dated marker as expired |
| Snapshot | Disk full mid-`VACUUM INTO` | Large store, full volume | No new snapshot | Swallowed with a warning; prior snapshot intact |
| Snapshot | Lock held by a dead PID | Process killed mid-rename | Snapshots stop updating | Reap only a confirmed-dead PID |
| Snapshot | Generation counter wraps | Practically unreachable | Newer snapshot rejected | Accepted; documented |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test
bun run format:check
bun run eval > /tmp/eval-now.md && diff -q /tmp/eval-now.md docs/eval-baseline.md
```

## Rollout Considerations

- **Feature flag**: none.
- **Schema**: `SCHEMA_VERSION` bump for the `meta` table — the index rebuilds once (~22s measured) on first use.
- **Rollback**: delete `memory.db.snapshot`, `lessons.jsonl`, and `bunfig.toml`; revert the three source files. No data migration to undo.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
