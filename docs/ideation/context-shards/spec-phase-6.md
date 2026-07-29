# Implementation Spec: Context Shards - Phase 6

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 6 turns the one-shot backfill into an ongoing trickle. A watermark records what has already been mined so a re-mine processes only new material, and new candidates surface through the existing `weekly-summary` skill rather than through a new digest surface.

The sizing is worth stating plainly, because it should shape how much machinery this phase earns: measurement during the interview put the backfill at roughly 25-35 durable facts across seven months of history, and steady state at about **4-5 new facts per month**. That is the reason backfill came first and this phase came last. It also means the incremental path must be cheap and quiet — a surface that interrupts you daily to report nothing would be worse than no surface at all. Riding `weekly-summary`, a ritual that already exists and already runs weekly, is the correct cadence for that volume.

The watermark's design is the one genuinely tricky part. The naive implementation stores a wall-clock timestamp and mines sessions newer than it. That is wrong here, because **transcripts are appended to after they are first indexed** — a session you worked in yesterday and resumed today has an old creation date and new content. `cache.ts` solves exactly this problem with an `mtime + size` pair per file (`src/cache.ts:324-333, 476-477`): a file is unchanged only when both match. The watermark must use the same signal, storing per-file `mtime`/`size` at last mine, rather than a single global timestamp.

This phase also gives snooze-resurface its second trigger. Phase 2 built resurface to fire on a manual re-mine; with incremental mining in place it fires whenever new phrasings arrive, which is what the mechanic was designed for.

> **Amended during implementation — this paragraph did not survive contact.** The second trigger is NOT delivered, and cannot be by anything in this phase. See "Amendments recorded during implementation" below.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Backfill first: one command mines a repo's full history into a batch for one triage sitting** — rejected: stream-first incremental mining with a periodic digest. 4,498 unmined sessions of backlog versus an estimated 4-5 new facts per month; the digest would be empty most days while the backlog stayed unharvested. This phase adds the stream after the backlog is harvested.
- **Snooze suppresses until its date and resurfaces on the next manual re-mine when new phrasings have appeared** — rejected: scheduled resurface driven by continuous stream monitoring. The trigger stayed a re-mine because the stream tier was deferred to this phase.
- **Web dashboard, Slack digest, or email triage** — rejected: `sessions` is a CLI with a plugin surface; triage rides the skill machinery that already exists.
- **Collapse byte-identical repeats; only distinct phrasings count toward volume** — rejected: raw volume counting, which promoted a copy-pasted eval fixture.
- **`sessions` gains zero LLM dependencies** — the mine stays deterministic; judgment remains agent-side.
- **Shards stay out-of-band** — nothing in this phase writes into a repository.
- **Merge each fresh record against its stored row before deriving scope** (this spec's Incremental-mine step 3) — rejected during implementation: a second full-corpus pass that rebuilds the changed phrasings' clusters from scratch. The merge approach needs containers the store does not keep (`evidence` holds session PATHS, not cwds), a defined answer for session paths the index has since pruned, and a `Math.max` on `distinctPhrasings` that would make snooze-resurface structurally impossible — the merged count would equal the stored baseline by construction, so `shouldResurface`'s `fresh > stored` could never be true. One extra FTS scan buys exact evidence, exact dates, and exact scope with none of that. The binding Key Decision (union evidence, no scope demotion) and its Failure Modes row are satisfied either way; only the mechanism changed. Rationale also lives at the two-pass comment in `src/shards/mine.ts`.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/stream.test.ts`

**Playground**: The test suite over a hermetic index whose fixture files can be touched and appended to, exercising the mtime/size watermark directly; then the CLI for the end-to-end shape.

**Why this approach**: The watermark's correctness is entirely about file-change detection, which is fast and fully controllable from a test — and impossible to observe reliably by hand.

## File Changes

### New Files

| File Path                   | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `src/shards/watermark.ts`   | Per-file mtime/size marker: read, compare, advance             |
| `src/shards/stream.test.ts` | Incremental selection, append detection, duplicate suppression |

### Modified Files

| File Path                               | Changes                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `src/shards/mine.ts`                    | Accept `--since-last`; restrict the narrowing query to changed sessions |
| `src/shards/store.ts`                   | Add the `mine_watermark` table via additive migration                   |
| `src/shards/cli.ts`                     | Add `--since-last` to `mine`; add `sessions shards pending`             |
| `plugin/skills/weekly-summary/SKILL.md` | Add a final step surfacing pending shard candidates                     |
| `src/plugin-files.ts`                   | Regenerated by `bun run generate-plugin-embed` — never hand-edited      |

## Implementation Details

### Watermark

**Pattern to follow**: `src/cache.ts:324-333` (the `mtime === stat.mtimeMs && size === stat.size` unchanged check) and `src/cache.ts:434-442` (fetching the whole inventory in one query rather than per-file).

**Overview**: A per-file record of what the last mine saw, so the next mine can skip unchanged transcripts.

```typescript
export interface WatermarkEntry {
  filePath: string;
  mtime: number; // stat.mtimeMs at last mine
  size: number; // stat.size at last mine
}

/** Whole watermark inventory in one query, keyed by file path. */
export function readWatermark(): Map<string, WatermarkEntry>;

/**
 * Session file paths that are new or changed since the last mine.
 * A file is unchanged only when BOTH mtime and size match — transcripts are
 * appended to after indexing, so a date or timestamp comparison would miss
 * resumed sessions entirely.
 */
export function changedSessions(
  indexed: { filePath: string; mtime: number; size: number }[],
  watermark: Map<string, WatermarkEntry>,
): string[];

/** Advance the watermark. Call only after candidates are persisted. */
export function advanceWatermark(entries: WatermarkEntry[]): void;
```

**Key decisions**:

- **`mtime + size`, never a global timestamp.** This is the whole correctness argument: a resumed session keeps its old `created_at` and gains new content. `cache.ts` already treats the pair as the change signal, and reusing it means the two systems agree about what "changed" means.
- Read the watermark inventory in **one** query, following the optimization noted at `src/cache.ts:434-437` — the old per-file `SELECT` pattern was explicitly replaced there, and reintroducing it would repeat a known performance mistake.
- **Advance only after candidates are persisted.** If the mine crashes mid-write, an already-advanced watermark would skip that material forever. Ordering: mine → upsert → advance.
- Source `mtime`/`size` from the `sessions` table, which already stores both (`src/cache.ts:130-131`), rather than re-`stat`ing files.
- A missing watermark row means never mined — the file is changed by definition. This makes the first `--since-last` run equivalent to a full backfill.

**Implementation steps**:

1. Add the `mine_watermark` table via an additive, idempotent migration guarded by `PRAGMA table_info`.
2. Implement `readWatermark` as a single `SELECT`.
3. Implement `changedSessions` as a pure function over the two inputs so it is testable without I/O.
4. Implement `advanceWatermark` as a batched `INSERT OR REPLACE` inside a transaction.

**Feedback loop**:

- **Playground**: `src/shards/stream.test.ts` over a hermetic index built from synthesized JSONL (follow `src/cache.search.test.ts:24-37`).
- **Experiment**: Mine a fixture of three sessions; advance. Re-mine with no changes → zero changed files. Append a corrective turn to session 2 (changing both mtime and size) → exactly session 2 is changed. Touch session 3 to change mtime only, leaving size identical → still counted as changed, since either half differing means changed. Delete the watermark row for session 1 → session 1 is changed again.
- **Check command**: `bun test src/shards/stream.test.ts`

### Incremental mine

**Overview**: `mine --since-last` runs the Phase 1 pipeline over only the changed subset.

```
sessions shards mine [--repo <path>] [--since-last] [--json]

  --since-last   Mine only sessions changed since the last mine
```

**Key decisions**:

- The narrowing query gains `AND m.file_path IN (...)` bound to the changed set. Chunk the binding at ~500 paths per statement; SQLite has a variable limit and the changed set is unbounded in principle.
- An empty changed set exits 0 with an empty array. Nothing new is the common case at 4-5 facts per month, and it must not read as an error.
- Deduplication against already-seen phrasings is **already handled** by Phase 1's `upsertCandidates`, which updates evidence and never overwrites state. An incremental mine that rediscovers a rejected phrasing leaves it rejected; ~~one that finds a genuinely new phrasing for an existing shard bumps `distinctPhrasings`, which is exactly what feeds Phase 2's resurface predicate~~ — **wrong, see Amendment 1**: a new phrasing is a new content-addressed record, so nothing bumps and the resurface predicate stays dead.
- Scope derivation must run over the **union** of watermarked and fresh evidence, not the fresh subset alone. A fact seen in one repo today and two others last month is workflow-scoped; scoring only today's slice would mislabel it `repo`.

**Implementation steps**:

1. Add `--since-last` to the mine subcommand.
2. When set, compute `changedSessions` and restrict the query.
3. ~~Merge fresh evidence with each record's stored evidence before deriving scope.~~ Replaced by a second full-corpus pass that rebuilds the changed phrasings' clusters — same union-evidence guarantee, none of the merge's hazards. The rejection is logged under "Decisions Considered and Rejected" above.
4. Advance the watermark after `upsertCandidates` returns.
5. When the changed set covers the entire scoped inventory (the first run), pass no file restriction at all: the filter would admit every row anyway, and pass 1 costs one FTS scan per 400-path chunk. This is what makes "the first run is equivalent to a full backfill" true of cost as well as of output.

**Feedback loop**:

- **Playground**: The CLI against the real index.
- **Experiment**: `bun run index.ts shards mine --since-last --json | jq 'length'` twice in a row — the second must be `0`.
- **Check command**: `bun test src/shards/stream.test.ts`

### Pending-candidates surface

**Overview**: A count and a preview, cheap enough to call from a skill that runs weekly.

```
sessions shards pending [--json]    Candidates awaiting triage, with a count
```

**Key decisions**:

- `pending` reads only; it never mines. The skill calls `mine --since-last` first, then `pending`, so the two responsibilities stay separable and `pending` stays fast.
- Output is bounded: a count plus the first few candidate texts. The weekly digest is a nudge to run `/shards`, not a triage surface in itself.

**Implementation steps**:

1. Implement `pending` over `listShards({ state: 'candidate' })`.
2. Cap the preview at 5 entries and report the total.

### `weekly-summary` integration

**Pattern to follow**: the numbered-step structure in `plugin/skills/weekly-summary/SKILL.md`.

**Overview**: One additional step at the end of the existing skill.

Step to append:

(Amended: the shipped step runs `mine --all --since-last`, not `mine --since-last`. See Amendment 2.)

> **N. Surface new shard candidates.** Run `sessions shards mine --since-last --json` followed by `sessions shards pending --json`. If the pending count is zero, say nothing — do not add an empty section. Otherwise close the summary with a short block: the count, up to three candidate texts, and one line telling the user to run `/shards` to triage. Do not triage here; this is a nudge, not the workflow.

**Key decisions**:

- **Silent when empty.** At 4-5 facts per month most weeks have nothing, and a recurring empty section trains the user to skip the whole summary.
- The skill nudges toward `/shards`; it never approves anything. Triage is a deliberate act with its own surface.
- **Run `bun run generate-plugin-embed`** after editing the SKILL.md. `src/plugin-files.ts` is generated (`src/plugin-files.ts:1-2`) and is what `installPluginFromEmbed` writes (`src/setup.ts:63-75`); an edit that skips regeneration never reaches the compiled binary. Commit the regenerated file.

**Feedback loop**:

- **Playground**: The CLI commands the skill calls.
- **Experiment**: With a store holding zero candidates, confirm `pending --json` reports `0`; seed two candidates and confirm the count and preview.
- **Check command**: `bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts`

## Data Model

```sql
-- Additive and idempotent. Never drop: the shards table alongside it holds
-- unrecoverable user judgments.
CREATE TABLE IF NOT EXISTS mine_watermark (
  file_path TEXT PRIMARY KEY,
  mtime     REAL NOT NULL,
  size      INTEGER NOT NULL,
  mined_at  TEXT NOT NULL
);
```

## Testing Requirements

### Unit Tests

| Test File                   | Coverage                                                          |
| --------------------------- | ----------------------------------------------------------------- |
| `src/shards/stream.test.ts` | Change detection, append handling, empty runs, watermark ordering |

**Key test cases**:

- Second consecutive `--since-last` run yields zero candidates.
- Appending to a session (mtime **and** size change) marks exactly that session changed.
- Changing mtime alone still marks the session changed.
- A session missing from the watermark counts as changed.
- Empty changed set exits 0 with `[]`, not an error.
- A rediscovered phrasing on a `rejected` shard leaves it `rejected`.
- ~~A genuinely new phrasing bumps `distinctPhrasings` and can trigger resurface.~~ **Withdrawn — not reachable through the shipped pipeline (see Amendment 1).** Replaced by two regression tests that lock the actual behavior: a new wording becomes a NEW record rather than a bump, and a snoozed candidate stays hidden even with an expired date and a fresh paraphrase in the corpus.
- Scope derived over union evidence: a shard previously `repo`-scoped widens to `workflow` when a new repo contributes.
- Watermark is not advanced when the upsert throws.
- Migration is idempotent across repeated opens.

### Manual Testing

- [ ] `sessions shards mine --since-last` twice — second run reports nothing new
- [ ] `/weekly-summary` adds no shard section when there are no candidates
- [ ] Resume an old session, add a corrective turn, re-mine — the session is picked up

## Failure Modes

| Component | Failure Mode                        | Trigger                                            | Impact                                                           | Mitigation                                                          |
| --------- | ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Watermark | Resumed sessions never re-mined     | Comparing a wall-clock timestamp or `created_at`   | Every fact from a resumed session lost, permanently and silently | Compare `mtime` **and** `size`, matching `cache.ts`'s change signal |
| Watermark | Material skipped after a crash      | Advancing before candidates are persisted          | Facts in that window never mined again                           | Strict ordering: mine → upsert → advance                            |
| Watermark | Per-file query storm                | `SELECT` per file instead of one inventory query   | Slow mine; repeats a mistake `cache.ts` already fixed            | Single inventory `SELECT`                                           |
| Mine      | SQLite variable limit exceeded      | Binding an unbounded changed set in one `IN (...)` | Query throws on large changed sets                               | Chunk bindings at ~500 paths                                        |
| Mine      | Scope mislabeled on incremental run | Deriving scope from the fresh slice only           | Workflow facts demoted to repo scope and hidden elsewhere        | Derive over union of stored and fresh evidence                      |
| Digest    | Empty-section fatigue               | Weekly section rendered with zero candidates       | User skims past the whole summary                                | Silent when the pending count is zero                               |
| Skill     | Change never ships                  | `generate-plugin-embed` not re-run after the edit  | Weekly summary keeps its old text in the binary                  | Embed-freshness check in validation commands                        |

## Validation Commands

```bash
bun run lint
bun run format:check
bun run typecheck
bun test src/shards/
bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts
bun test
bun run build
```

## Amendments recorded during implementation

_Departures from the spec above, recorded here rather than only in source comments. Each one is deliberate._

**1. Snooze-resurface does not get its second trigger, and the mechanic remains dead in the shipped pipeline.**

The Technical Approach claimed incremental mining would make resurface "fire whenever new phrasings arrive", and Testing Requirements listed the matching test case. Neither is deliverable here. A shard record is content-addressed on its own normalized text (`src/shards/record.ts`), so a genuinely new wording of the same fact is a NEW record with a NEW id — never a bump on an existing one. `mine()` therefore emits `distinctPhrasings = 1` for every cluster, `shouldResurface`'s `freshPhrasings > record.evidence.distinctPhrasings` is `1 > 1`, and a snoozed candidate is hidden indefinitely rather than for 30 days.

The two mechanical ways to make the number grow were both refused: counting occurrences or contributing sessions is the "raw volume counting" the contract rejected (one eval fixture prompt appeared 14 times byte-identical and would have topped the batch), and it contradicts `types.ts`'s definition of the field. What the mechanic actually needs is a **clustering write-back** — a surface for the `/shards` skill to record "these three phrasings are one fact" — which no phase of this project specifies. Phase 6 is the last phase, so `src/shards/triage.ts`'s forward reference to it has been rewritten to stop promising a fix that is not coming.

What shipped instead:

- Two regression tests in `src/shards/stream.test.ts` lock the 1-per-cluster behavior and the non-resurface, so a future write-back has to change them deliberately.
- The user-facing copy that promised the mechanic is corrected in `README.md`, `src/cli.ts`, `src/shards/cli.ts`, and `plugin/skills/shards/SKILL.md`: a snooze is described as hiding a candidate indefinitely, with the missing bump named as the reason.
- The gap is carried below as an Open Item rather than left in a source comment.

**2. `weekly-summary` runs `mine --all --since-last`, not `mine --since-last`.**

The quoted "Step to append" specified the unscoped form. A weekly summary spans every project the user worked in, and a bare `--since-last` would mine only whichever repo the agent's cwd happened to be in. The cost is unchanged (the watermark makes the run proportional to what actually changed), but the blast radius is not: `--all` advances the watermark for every repo, so a later `sessions shards mine --since-last` inside a single repo correctly reports nothing changed until that repo's transcripts move again. Nothing is lost — the material was already mined into the same store — but the interaction is non-obvious, so it is noted in the SKILL.md step and in `src/shards/watermark.ts`'s header.

**3. The three plugin manifests are reformatted, and that is pre-existing drift, not phase churn.**

`plugin/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.cursor-plugin/plugin.json` had their `keywords` arrays collapsed to one line, and the change is carried into the regenerated `src/plugin-files.ts`. Verified with `oxfmt --check` against the committed versions: they FAIL the check at HEAD, so `bun run format:check` — one of this spec's Validation Commands — cannot pass without the collapse. The reformat is a fix for drift that predates this phase; the committer should say so in the commit message.

## Open Items

- [ ] At 4-5 facts per month, weekly may still be too frequent. If the shard block is empty most weeks, consider gating it on a minimum candidate count rather than on zero.
- [ ] **Snooze-resurface has no live trigger** (Amendment 1). It needs a clustering write-back: a way for the `/shards` skill to record that several phrasings are one fact, so a merged record can carry `distinctPhrasings > 1` and a later mine can exceed it. Until that exists, `snooze` is "hide forever without a verdict" and the copy says so. Decide deliberately whether to build the write-back or to retire the second condition of `shouldResurface` — do not let the mechanic sit half-alive.
- [ ] `shards pending` reports a RUNNING TOTAL of everything untriaged, not "new since last week" (see the KNOWN LIMIT on `pendingBatch`). Until the backlog is worked down, the weekly digest carries the same block every week — the skim-past failure the "silent when empty" rule exists to prevent, reached from the other side. A delta needs a per-row "first surfaced" timestamp the store does not keep.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
