# Implementation Spec: Context Shards - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 4 builds the transport seam — export, import, and a pure merge — without building a transport. The distinction is the whole point. `sessions` never gains a server, a sync service, or a network dependency; it gains a documented record format and two commands that move that format across the process boundary. Whatever a team already has — a hidden git ref, a private repo, a shared drive, `scp` — becomes a viable transport because the payload is a plain file.

The seam is built **complete**, with its reader, rather than as export alone. A serializer with no reader proves nothing about round-trip fidelity: you cannot know the format survives the boundary until something reads it back. The original plan had export in MVP as "the anticipation"; critic review corrected that — the anticipation that is genuinely expensive to skip is the _record's shape_ (content-addressed id, author stamp), which Phase 1 already ships. A projection over stored rows can be added any time without loss.

`merge(records[])` is a **pure function over a set of records**, used even when the set contains only your own. That is what makes a future transport a concat-then-call rather than a rewrite. Building the merge now and running it on a one-element set costs almost nothing and locks the shape.

The quorum metric lands here too, because it is meaningless without multi-author input. It counts **distinct authors, not occurrences** — the correction that makes volume evidential. Five records from one author score 1; one record each from five authors scores 5. A verbose individual cannot manufacture a quorum, which is exactly the failure that made raw volume counting unusable in the first place.

**Privacy is a hard constraint on export**, not a preference. Only `approved` records are exportable; raw candidates never cross the boundary. Records carry no verbatim prompt text by design (Phase 1's evidence is counts, session paths, and dates), and export additionally strips `evidence.sessions` — local filesystem paths reveal directory structure and project names that have no meaning to a recipient anyway.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Export ships with its reader, in the Full tier** — rejected: export alone in MVP as the transport seam. The anticipation that is expensive to skip is the record's shape — content-addressed id and author stamp, both in Phase 1 — not the serializer, which is a pure projection over stored rows. A writer with no reader also proves nothing about round-trip fidelity.
- **Collapse byte-identical repeats; only distinct phrasings count toward volume** — rejected: raw volume counting. An eval fixture prompt appeared 14 times byte-identical in the real corpus and would have been promoted. Author diversity is what makes repetition evidential.
- **Candidate records carry evidence as counts, session paths, and a date range** — rejected: a fatter record embedding verbatim source quotes. Any future export would carry actual conversations off the machine, cutting against the out-of-band requirement.
- **Shards stay out-of-band** — rejected: committing shards into a repo. Exposes tool usage and adds churn to repos the user may not control.
- **No transport or sync implementation** — deferred deliberately. Picking a transport before real records exist would fix the wrong shape.
- **Team-wide automatic mining via a supervisor agent** — rejected: requires reading other people's transcripts, meaning a server, a trust model, and access to private conversations.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/export.test.ts`

**Playground**: The test suite for round-trip and merge purity; the CLI for the human-facing shape — `bun run index.ts shards export | jq '.[0]'` shows exactly what would leave the machine.

**Why this approach**: Serialization correctness is a property test over pure functions, so the test runner is the tightest loop; the CLI check is how you confirm the privacy constraint by eye before trusting it.

## File Changes

### New Files

| File Path                   | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `src/shards/portable.ts`    | Export projection, import validation, and the pure `merge` function |
| `src/shards/quorum.ts`      | Distinct-author quorum metric over a merged record set              |
| `src/shards/export.test.ts` | Round-trip fidelity, merge purity, privacy stripping                |
| `src/shards/quorum.test.ts` | Author-distinct counting versus occurrence counting                 |

### Modified Files

| File Path             | Changes                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/shards/cli.ts`   | Add `export` and `import` subcommands                                               |
| `src/shards/types.ts` | Add `PortableShard` (the exported projection) and `ShardBundle` (the file envelope) |

## Implementation Details

### Portable format

**Overview**: The wire format. A versioned envelope around a list of projections, designed so a recipient can validate it without knowing anything about this machine.

```typescript
/** A shard as it crosses the process boundary — no local paths, no raw prompts. */
export interface PortableShard {
  v: number;
  id: string; // sha256:<hex> — content-addressed, so identity survives transport
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  author: string;
  /** Local session paths deliberately omitted. */
  evidence: {
    distinctPhrasings: number;
    firstSeen: string;
    lastSeen: string;
  };
}

export interface ShardBundle {
  v: number; // SHARD_SCHEMA_VERSION
  exportedAt: string; // 'YYYY-MM-DD'
  shards: PortableShard[]; // sorted by id
}

export function toPortable(records: ShardRecord[]): ShardBundle;
export function fromPortable(bundle: unknown): PortableShard[]; // validates; throws on mismatch
```

**Key decisions**:

- **`state` and `snoozedUntil` are not exported.** They are your triage decisions about your own attention; a recipient imports the fact, not your opinion of it. Imported records land as `candidate` so the recipient triages for themselves.
- **`evidence.sessions` is stripped.** Local paths leak directory structure and project names and are meaningless to a recipient.
- Only `state === 'approved'` records are exportable. Candidates are unreviewed model output and must never leave the machine.
- `fromPortable` validates with `zod`, already a dependency (`package.json`). It must reject on a `v` mismatch rather than best-effort parsing — pre-1.0 exports are explicitly disposable, and a loud failure is better than a silently mangled import.
- `shards` is sorted by `id` so two exports of the same set are byte-identical, which makes any diff-based transport (a git ref, for instance) produce clean history.

**Implementation steps**:

1. Add `PortableShard` and `ShardBundle` to `src/shards/types.ts`.
2. Implement `toPortable`: filter to approved, project, strip, sort by id, wrap in the envelope.
3. Define a zod schema for `ShardBundle` and implement `fromPortable` to parse-or-throw.

**Feedback loop**:

- **Playground**: `src/shards/export.test.ts`.
- **Experiment**: Seed a store with one approved, one candidate, one rejected, and one snoozed shard. Export; assert exactly one shard in the bundle, that it has no `sessions` field and no `state` field, and that a second export is byte-identical.
- **Check command**: `bun test src/shards/export.test.ts`

### The pure merge

**Overview**: The function that makes a future transport trivial. Takes record sets from any number of authors and returns clusters keyed by content-addressed identity.

```typescript
export interface MergedShard {
  id: string;
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  /** Every author who independently produced this shard. Sorted, deduplicated. */
  authors: string[];
  /** Summed across authors — retained for display, never used as the quorum signal. */
  totalPhrasings: number;
  firstSeen: string;
  lastSeen: string;
}

/** Pure: no I/O, no clock, no randomness. Input order must not affect output. */
export function merge(shards: PortableShard[]): MergedShard[];
```

**Key decisions**:

- **Purity is the contract**, and the test asserts it: shuffling the input array must produce an identical output array. That property is what lets a caller concatenate sets from any transport in any arrival order.
- Merge key is `id` — the content-addressed hash of normalized text. Two authors who phrase a fact identically merge automatically; two who paraphrase do not, and clustering paraphrases is the agent's job at triage (Phase 2), not a mechanical one here.
- `authors` is deduplicated and sorted. One author contributing five records appears once.
- On a scope conflict (one author scoped it `repo`, another `workflow`), widen to `workflow`. A fact two people hit in different repos is, by the Phase 1 derivation rule, a workflow fact.
- `firstSeen`/`lastSeen` widen to the union across contributors.

**Implementation steps**:

1. Group by `id` into a `Map`.
2. For each group: union authors (sort, dedupe), sum `distinctPhrasings`, widen scope and dates.
3. Return sorted by `id`.

**Feedback loop**:

- **Playground**: `src/shards/export.test.ts`.
- **Experiment**: Build a 6-record input spanning 3 authors with one shared id. Call `merge`, then call it again on a reversed copy; assert `JSON.stringify` equality. Assert the shared shard lists 3 authors and that a repo/workflow scope conflict widened to `workflow`.
- **Check command**: `bun test src/shards/export.test.ts`

### Quorum metric

**Overview**: The signal that makes volume evidential once more than one author exists.

```typescript
/** Distinct contributing authors. Deliberately NOT occurrence count. */
export function quorum(shard: MergedShard): number {
  return shard.authors.length;
}

/** Does this shard clear the bar for promotion consideration? */
export function meetsQuorum(shard: MergedShard, threshold: number): boolean;
```

**Key decisions**:

- The whole point is that `quorum` reads `authors.length` and never `totalPhrasings`. A comment must say so, because the "obvious" implementation is the wrong one and a future editor will be tempted.
- Under the current single-author scope this returns 1 for everything. That is expected and is why the metric ships with the merge rather than earlier — it is a constant until a second author's export is imported.
- `threshold` is a parameter, not a constant. There is no defensible default before real multi-author data exists.

**Implementation steps**:

1. Implement both functions in `src/shards/quorum.ts` with the "not occurrences" comment.
2. Expose quorum in `shards list` output (Full tier) if that command exists by the time this phase runs; otherwise leave it library-only.

**Feedback loop**:

- **Playground**: `src/shards/quorum.test.ts`.
- **Experiment**: Merged shard A has one author with `totalPhrasings: 5`; shard B has five authors with `totalPhrasings: 5`. Assert `quorum(A) === 1` and `quorum(B) === 5`.
- **Check command**: `bun test src/shards/quorum.test.ts`

### CLI subcommands

```
sessions shards export [--out <path>]     Write approved shards as a portable bundle (stdout by default)
sessions shards import <path>             Merge another author's bundle in as candidates
```

**Key decisions**:

- `export` writes to stdout by default so it pipes into any transport the user already has. `--out` mirrors the existing convention in `src/context.ts:44`.
- `import` lands records as `candidate`, never `approved`. Importing is not consent; the recipient triages with `/shards` like any other candidate.
- An imported record whose id already exists locally merges evidence and adds the author, but never overwrites local `state` — the same protection `upsertCandidates` provides in Phase 1.

**Implementation steps**:

1. Add `export` and `import` to the subcommand switch in `src/shards/cli.ts`.
2. Extend the `--help` text.

## Testing Requirements

### Unit Tests

| Test File                   | Coverage                                                      |
| --------------------------- | ------------------------------------------------------------- |
| `src/shards/export.test.ts` | Round-trip fidelity, privacy stripping, merge purity          |
| `src/shards/quorum.test.ts` | Author-distinct counting; occurrence count must not influence |

**Key test cases**:

- Round trip: `fromPortable(toPortable(records))` yields the same shard set.
- Only approved records export; candidate, rejected, and snoozed are absent.
- Exported JSON contains no `sessions` key and no `state` key anywhere.
- Two exports of an unchanged store are byte-identical.
- `merge` on a shuffled input equals `merge` on the original.
- Scope conflict across authors widens to `workflow`.
- `fromPortable` throws on a `v` mismatch and on a malformed bundle.
- Import of an id already `rejected` locally leaves it `rejected`.

### Manual Testing

- [ ] `sessions shards export | jq '.shards[0]'` shows no local paths and no state
- [ ] `sessions shards export > /tmp/b.json && sessions shards import /tmp/b.json` is a no-op on your own store

## Failure Modes

| Component | Failure Mode                       | Trigger                                                 | Impact                                               | Mitigation                                                                             |
| --------- | ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Export    | Unreviewed candidates leave        | Filtering on `!== 'rejected'` instead of `= 'approved'` | Raw model output shared as if the user endorsed it   | Explicit `state === 'approved'` filter; asserted in tests                              |
| Export    | Local paths leak                   | Projecting `evidence` wholesale                         | Directory structure and project names disclosed      | Strip `evidence.sessions`; test asserts key absence                                    |
| Import    | Silent format drift                | Best-effort parsing of a mismatched `v`                 | Mangled records with no error                        | zod parse-or-throw on version mismatch                                                 |
| Import    | Local decisions overwritten        | Import upserts state                                    | Recipient's rejections silently undone               | Import lands as `candidate`; never writes local state                                  |
| Merge     | Order-dependent output             | Iterating a Map without sorting                         | Purity assertion fails; diff-based transports churn  | Sort by id; shuffle test asserts equality                                              |
| Quorum    | Verbose author manufactures quorum | Counting occurrences instead of authors                 | The exact failure that made raw volume unusable      | `authors.length` only, with a comment explaining why                                   |
| Merge     | Paraphrases fragment the quorum    | Content-addressed ids differ across phrasings           | Five authors saying it five ways score 1 each, not 5 | Known and accepted: paraphrase clustering is agent-side (Phase 2); note it in `--help` |

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

- [ ] Cross-author paraphrase fragmentation is a real limit of content-addressed merging — five authors phrasing one fact five ways produce five ids. The fix is running Phase 2's clustering over the merged set, which needs an agent and therefore a skill step. Record the limitation now; solve it only if multi-author data ever arrives.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
