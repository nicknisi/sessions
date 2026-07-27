# Implementation Spec: Memory Hygiene & Measured Retrieval - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

The eval built alongside the retrieval work cannot do its job. At 21 documents it is insensitive to two of the four ranking changes it was written to protect: removing short-message damping or setting `USER_HIT_BOOST` to 1.0 passes the eval clean, and only a unit test catches either. A ratchet that cannot detect a reverted constant is a ratchet in name only, and every future scorer change is unmeasurable until this is fixed.

Two pieces, in order.

**First, make the constants reachable.** All four tuned values are function-local inside `searchSessions`: `SESSION_RANK` (src/cache.ts:666), `USER_HIT_BOOST` (:707), `SUBSTANTIVE_CHARS` / `MIN_DAMPING` (:713-714), and the `finalRank` sum (:758). No mutation harness can revert them individually without hoisting them to module scope behind an override. This is why this phase claims `src/cache.ts` — the contract's earlier claim that it "touches only the eval tree" was false.

**Then, grow the corpus until it kills them.** Not to a document count — a count is a proxy, and 100 documents with weak distractors are less sensitive than 40 with sharp ones. The exit condition is mechanical: `src/eval/mutation.test.ts` applies each of four named mutations and asserts every one breaks a `RECALL_FLOOR` entry. It fails if it applied fewer than four, so a renamed constant turns the harness red rather than silently vacuous.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **The corpus is done when four named mutants are killed, enforced as `src/eval/mutation.test.ts`** — rejected: growing to a target document and query count; a standalone `scripts/eval-mutation.ts`. A count is a proxy. "Any tuned constant" was unbounded (at least ten exist), so the set is enumerated. A test rather than a script so CI enforces it.
- **Phase 3 hoists the tuned ranking constants to overridable module scope and claims `src/cache.ts`** — rejected: treating corpus growth as touching only the eval tree. All four constants are function-local inside `searchSessions`, so no mutation harness can revert them individually without hoisting.
- **Retrieval quality becomes a real track, with corpus growth as its prerequisite** — rejected: keeping distilled titles as a measure-first phase on the 21-document corpus. The current corpus cannot detect two of the four changes it already protects, so measure-first on it is ceremony. _(At the Full tier the retrieval track itself is deferred to Future; corpus growth still stands on its own, because the eval must be able to catch regressions from any change.)_
- **Acceptance commands run against temp stores and the fixture corpus, never the real ones** — rejected: the first draft's commands, which ran against the operator's live store and 4,400-session index.

## Feedback Strategy

**Inner-loop command**: `bun test src/eval/mutation.test.ts`

**Playground**: Test suite over the committed fixture corpus. The eval builds its own index in a temp dir, so runs are hermetic and fast.

**Why this approach**: The whole phase is a measurement instrument. The only question that matters at each step is "does the corpus kill the mutants yet?", which is exactly one command.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/eval/mutation.test.ts` | Applies four named mutations, asserts each breaks a floor, fails if fewer than four applied |
| `src/eval/__fixtures__/**` | Additional transcripts with sharp distractors (count determined by the exit condition, not fixed up front) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/cache.ts` | Hoist the four tuned constants into an exported, overridable `RANKING` record; `searchSessions` reads from it |
| `src/eval/queries.ts` | Additional queries targeting the classes the new distractors create |
| `src/eval/eval.test.ts` | Re-record `RECALL_FLOOR` and the payload ceilings against the grown corpus |
| `src/eval/run.ts` | Bump `CORPUS_SIZE`; no behavioral change |
| `docs/eval-baseline.md` | Regenerated |

## Implementation Details

### 1. Hoist the tuned constants

**Pattern to follow**: the existing constants at `src/cache.ts:666,707,713-714` — same values, new home.

**Overview**: One exported record, mutable for tests, read by `searchSessions`. No behavior change: the defaults are exactly today's values, verified by the eval baseline staying byte-identical across this step alone.

```typescript
// src/cache.ts
/** The tuned ranking constants, hoisted out of searchSessions so the eval can
 *  revert them one at a time. Mutating this in production is unsupported —
 *  it exists so `src/eval/mutation.test.ts` can prove the corpus is sensitive
 *  enough to notice when one of them changes. */
export const RANKING = {
  /** bm25 column weights for session_fts, in declaration order. */
  sessionRank: [0.0, 10.0, 6.0, 5.0, 2.0, 0.5] as number[],
  /** A user turn outranks an assistant turn saying the same thing. */
  userHitBoost: 1.5,
  /** Below this length a hit is damped toward minDamping. */
  substantiveChars: 240,
  /** Floor of the short-message damping curve — a demotion, not an exclusion. */
  minDamping: 0.25,
  /** Whether finalRank sums the two bm25 scores (today) or takes the better one. */
  finalRankMode: 'sum' as 'sum' | 'best',
};
```

**Key decisions**:
- `sessionRank` becomes an array so a mutant can flatten it to all-1.0 without string surgery on the SQL.
- `finalRankMode` is included because the `finalRank` sum is one of the four things the corpus must be able to notice, even though changing it is deferred to Future. The mutant flips it to `'best'`.
- Exported and mutable rather than injected through a parameter: `searchSessions` already has a wide options object and threading five more values through every call site would be worse than a documented test seam.

**Implementation steps**:
1. Add `RANKING` at module scope.
2. Replace the five literal sites with reads from it. `SESSION_RANK` becomes `` `bm25(session_fts, ${RANKING.sessionRank.join(', ')})` ``.
3. Run `bun run eval` — output must be **byte-identical** to the committed baseline. If it is not, the hoist changed behavior and is wrong.

**Feedback loop**:
- **Playground**: the existing eval.
- **Experiment**: hoist, then `bun run eval > /tmp/x && diff -q /tmp/x docs/eval-baseline.md`.
- **Check command**: `bun run eval > /tmp/x && diff -q /tmp/x docs/eval-baseline.md`

### 2. The mutation harness

**Pattern to follow**: `src/eval/eval.test.ts:81` (`test.each` over `RECALL_FLOOR`).

**Overview**: For each named mutant, apply it, re-run the eval in-process, assert at least one floor is now violated, restore.

```typescript
// src/eval/mutation.test.ts
const MUTANTS: { name: string; apply: () => void }[] = [
  { name: 'bm25 column weights', apply: () => { RANKING.sessionRank = RANKING.sessionRank.map(() => 1.0); } },
  { name: 'USER_HIT_BOOST',      apply: () => { RANKING.userHitBoost = 1.0; } },
  { name: 'short-message damping', apply: () => { RANKING.minDamping = 1.0; } },
  { name: 'finalRank sum',       apply: () => { RANKING.finalRankMode = 'best'; } },
];

test('the corpus is sensitive enough to kill every tuned constant', () => {
  // Vacuously-true guard: a renamed constant must turn this red, not silent.
  expect(MUTANTS.length).toBe(4);
  const survivors: string[] = [];
  for (const m of MUTANTS) {
    const saved = structuredClone(RANKING);
    m.apply();
    try {
      if (!anyFloorViolated(runEval())) survivors.push(m.name);
    } finally {
      Object.assign(RANKING, saved);
    }
  }
  expect(survivors).toEqual([]);
});
```

**Key decisions**:
- Mutating the exported record beats patching source text: a rename becomes a **type error**, not a silently no-op regex.
- Restore in a `finally` so one failing mutant does not poison the rest.
- `expect(MUTANTS.length).toBe(4)` is the inventory assertion — "reports every mutant killed" is vacuously true at zero mutants.

**Implementation steps**:
1. Extract the eval's report-building into a callable `runEval()` (it already exists as the body of `run.ts`'s main).
2. `anyFloorViolated(report)` — reuse the comparison from `eval.test.ts`.
3. Write the test above. Expect survivors on the first run: that is the work item.

**Feedback loop**:
- **Playground**: `bun test src/eval/mutation.test.ts` — prints which mutants survived.
- **Experiment**: run it; each surviving mutant names a blind spot to add distractors for.
- **Check command**: `bun test src/eval/mutation.test.ts`

### 3. Grow the corpus against the survivors

**Overview**: Iterative and evidence-driven. The harness names what the corpus cannot see; add fixtures that make it visible.

**Key decisions**:
- Add distractors, not volume. Each new transcript exists to make a *specific* mutant detectable.
- Likely shapes, from what each mutant means:
  - `USER_HIT_BOOST` → a session where the user asks about X and a *different* session's assistant discusses X at length. Without the boost the assistant-heavy one wins.
  - damping → a session whose only mention of the term is a one-line aside, competing with one that analyses it. Without damping the aside wins on length normalization.
  - bm25 weights → a session matching only in `commands`/`paths` against one matching in `headline`.
  - `finalRank` → a session matching weakly in both `session_fts` and `message_fts` against one matching strongly in only one. Sum favours the former, best-of the latter.
- Fixtures stay synthetic and authored, matching the existing corpus convention. They are a *ranking* oracle; the captured real transcripts in `src/__fixtures__/` are the *parsing* oracle, and mixing them makes a baseline diff ambiguous about which moved.

**Implementation steps**:
1. Run the harness; note survivors.
2. For each survivor, add the transcript and query that should distinguish it.
3. Re-run. Repeat until zero survivors.
4. Re-record `RECALL_FLOOR` and the payload ceilings in `eval.test.ts` to the measured values.
5. Regenerate `docs/eval-baseline.md`.

**Feedback loop**:
- **Playground**: `bun test src/eval/mutation.test.ts` after each fixture.
- **Experiment**: the survivor list is the experiment — it shrinks or it does not.
- **Check command**: `bun test src/eval/mutation.test.ts`

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `src/eval/mutation.test.ts` | All four mutants killed; inventory assertion; restore-on-failure |
| `src/eval/eval.test.ts` | Re-recorded floors and ceilings hold on the grown corpus |

**Key test cases**:
- Each of the four mutants individually breaks at least one floor.
- The harness fails if `MUTANTS` has fewer than four entries.
- A failing mutant restores `RANKING` so later mutants are unaffected.
- `bun run eval` reproduces `docs/eval-baseline.md` byte-for-byte.

### Manual Testing

- [ ] Confirm the hoist alone leaves the baseline byte-identical before any fixture is added.
- [ ] Read the new fixtures — each should be plausible as a real session, not obviously synthetic filler.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Hoist | Behavior drift | A weight transcribed wrong | Silent ranking change | Baseline must stay byte-identical after the hoist alone |
| Mutation harness | Vacuously green | `MUTANTS` emptied or a constant renamed | False confidence | Inventory assertion; mutating a typed record makes a rename a compile error |
| Mutation harness | Slow | Eval re-runs 4× in one test | Suite time grows | Corpus is small and hermetic; if it exceeds ~10s, scope to a subset of classes |
| Corpus | Overfitted to the mutants | Fixtures authored only to kill mutants | Eval detects reverts but not real regressions | Each fixture must read as a plausible session, not a probe |
| Corpus | Floors re-recorded too loose | Recording after a regression | Ratchet permanently weakened | Re-record only when mutation is green and the diff is reviewed |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test
bun run format:check
bun run eval > /tmp/eval-now.md && diff -q /tmp/eval-now.md docs/eval-baseline.md
```

## Rollout Considerations

- **Schema**: none. No index change — the constants move, their values do not.
- **Rollback**: revert `src/cache.ts` and the eval tree. Nothing persisted changes.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
