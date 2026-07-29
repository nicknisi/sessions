# Implementation Spec: Context Shards - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 2 adds the judgment half of the pipeline. Phase 1 hands over a batch of candidate records where each candidate is one distinct text; Phase 2's `/shards` skill clusters paraphrases, applies a generalizability rubric, and walks the user through approve / reject / snooze. The write-back CLI persists those decisions to the durable store.

The division is deliberate and load-bearing: **`sessions` narrows and persists, the agent judges.** The rubric lives in a skill prompt, not in TypeScript, because "is this fact durable beyond the session it appeared in?" is an LLM judgment and `sessions` compiles to a two-dependency binary with no LLM in it. This is also why the precision goal is verified by hand rather than asserted in CI — you cannot unit-test a prompt without calling a model.

Paraphrase clustering happens here rather than in Phase 1 for the same reason. "use canary as the base branch" and "we branch off canary" are one shard in two phrasings; recognizing that is semantic work. The skill merges such candidates and recomputes `distinctPhrasings` across the merged set — which is exactly the signal the contract treats as evidence, since byte-identical repeats were already collapsed to 1 upstream.

Snooze is a 30-day suppression with a resurface condition: a snoozed candidate reappears on a later re-mine **only if new distinct phrasings have appeared since the snooze**. Continued repetition is treated as evidence the dismissal was wrong. Because the stream tier is Phase 6, the trigger in this phase is a manual re-mine, not a scheduler.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Collapse byte-identical repeats, then cluster paraphrases at triage; only distinct phrasings count toward volume** — rejected: raw volume counting. An eval fixture prompt appeared 14 times byte-identical in the real corpus and would have been promoted as a top candidate. Author diversity is what makes repetition evidential, and solo there is none.
- **The generalizability rubric runs agent-side in a skill; sessions narrows and verifies** — rejected: LLM-based extraction inside sessions. `sessions` is a deterministic indexer compiling to a standalone two-dependency binary; the agent invoking it is already an LLM.
- **Precision is verified by hand against the golden set; everything mechanical is unit-tested** — rejected: a scripted LLM eval harness asserting precision in CI. Asserting a skill prompt requires an LLM call, reintroducing the API-key and nondeterminism dependency `sessions` deliberately does not have.
- **Snooze suppresses until its date and resurfaces on the next manual re-mine when new phrasings have appeared** — rejected: scheduled resurface driven by continuous stream monitoring. Snooze-resurface is in this phase while the stream tier is Phase 6, so the trigger must be a re-mine.
- **Candidate records carry evidence as counts, session paths, and a date range** — rejected: a fatter record embedding the verbatim source quote. Verbatim quotes are raw prompt text; any future export would carry actual conversations off the machine.
- **Shard records live in a durable store outside the index cache directory** — rejected: a table inside `index.db`, which `--clear-cache`, `cleanup`, and corruption self-heal all unlink.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/snooze.test.ts`

**Playground**: The test suite for the write-back and snooze logic; the CLI itself for the skill's contract (`bun run index.ts shards mine --repo "$PWD" | jq` produces exactly what the skill will read).

**Why this approach**: The state machine is pure logic over SQLite rows, so tests are the tightest loop. The skill itself has no automated loop — its correctness is the precision judgment call, exercised manually against the golden set.

## File Changes

### New Files

| File Path                             | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `plugin/skills/shards/SKILL.md`       | The `/shards` triage skill: cluster, judge, walk approve/reject/snooze |
| `src/shards/triage.ts`                | State transitions, snooze date math, resurface predicate               |
| `src/shards/snooze.test.ts`           | Suppression until date; resurface only on new phrasings                |
| `src/shards/fixtures/golden-set.json` | 40 hand-labeled turns, paraphrased and redacted                        |

### Modified Files

| File Path             | Changes                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/shards/cli.ts`   | Add `approve`, `reject`, `snooze` subcommands dispatching to `triage.ts`                  |
| `src/shards/mine.ts`  | Apply the resurface predicate — suppress snoozed candidates unless new phrasings appeared |
| `src/setup.ts`        | Add `/shards` to the printed skill list (`src/setup.ts:237-243`)                          |
| `src/plugin-files.ts` | Regenerated by `bun run generate-plugin-embed` — never hand-edited                        |

## Implementation Details

### Triage state machine

**Pattern to follow**: `src/shards/store.ts` from Phase 1 for the `setState` seam.

**Overview**: Pure transitions plus a date-math predicate; no I/O beyond the store.

```typescript
export const SNOOZE_DAYS = 30;

/** 'YYYY-MM-DD' `SNOOZE_DAYS` after `todayIso`. `todayIso` is injected so tests need no clock. */
export function snoozeUntil(todayIso: string): string;

/**
 * Should a snoozed shard reappear? True only when BOTH hold:
 *  - today >= snoozedUntil, and
 *  - the fresh mine found more distinct phrasings than the record had when snoozed.
 * The second condition is what makes continued repetition evidence the dismissal was wrong.
 */
export function shouldResurface(record: ShardRecord, freshPhrasings: number, todayIso: string): boolean;

export function approve(id: string): void;
export function reject(id: string): void;
export function snooze(id: string, todayIso: string): void;
```

**Key decisions**:

- `todayIso` is injected rather than read from a clock, following the `nowMs` injection precedent in `src/significance.ts:1-4`. Date-dependent tests must not be flaky.
- `rejected` is terminal for re-mining purposes — `upsertCandidates` already refuses to overwrite state — but `approve` on a rejected id is allowed, so a user can change their mind through the CLI.
- Resurface requires **both** conditions. A snooze that merely expires does not resurface; that would make snooze a 30-day delay rather than a dismissal.

**Implementation steps**:

1. Implement `snoozeUntil` with plain date arithmetic on `Date.parse` + 30 × 86_400_000, formatted back to `YYYY-MM-DD`.
2. Implement `shouldResurface` per the doc comment.
3. Implement `approve` / `reject` / `snooze` over `setState`.
4. In `mine.ts`, after building fresh candidates, look up existing records by id; drop any whose state is `rejected`, and drop `snoozed` ones unless `shouldResurface` returns true.

**Feedback loop**:

- **Playground**: `src/shards/snooze.test.ts` with an injected `todayIso`.
- **Experiment**: Snooze a record with `distinctPhrasings: 2` on `2026-01-01`. Re-mine on `2026-01-15` with 2 phrasings → suppressed. On `2026-02-15` with 2 phrasings → still suppressed (expired but no new evidence). On `2026-02-15` with 4 phrasings → resurfaces.
- **Check command**: `bun test src/shards/snooze.test.ts`

### The `/shards` triage skill

**Pattern to follow**: `plugin/skills/recall/SKILL.md` for frontmatter shape, step structure, and description phrasing.

**Overview**: A skill that reads the mine's JSON batch, clusters paraphrases, applies the rubric, and drives triage through `AskUserQuestion`.

Frontmatter:

```yaml
---
name: shards
description: >-
  Triage context-shard candidates mined from past AI coding sessions. Use when
  the user says "triage shards", "review shards", "mine shards", "/shards", or
  asks what durable facts their session history contains. Runs the mine, clusters
  paraphrased candidates, judges which facts generalize beyond the session they
  came from, and walks approve / reject / snooze.
argument-hint: repo path (optional, defaults to current repo)
---
```

Skill body, in order:

1. **Run the mine.** `sessions shards mine --repo <path> --json`. Empty array → say so and stop; do not invent candidates.
2. **Cluster paraphrases.** Group candidates whose texts assert the same fact in different words. `distinctPhrasings` for a cluster is the number of distinct member texts. Keep the clearest phrasing as the cluster's `text`; the rest are evidence, not separate shards.
3. **Apply the generalizability rubric.** For each cluster ask: _does this fact hold beyond the session it appeared in?_ Propose only those that pass.
   - **Passes**: standing constraints ("API keys go in the keychain when available"), repo or tooling facts ("this repo branches off canary", "skills can invoke inline scripts"), architectural rules.
   - **Fails**: one-off task instructions ("make it Ideation instead of docs/ideation", "let's do a single PR"), bug reports ("syntax highlighting isn't loading"), anything naming a specific transient artifact.
   - **Fails loudly**: text that looks like a copy-pasted prompt or eval fixture. Byte-identical repeats were already collapsed upstream, so a suspiciously boilerplate candidate is chaff, not signal.
   - Assign `kind`: `instruction` for "do this / don't do that", `information` for "this is how the world is".
4. **Walk triage.** One `AskUserQuestion` per cluster, batching up to 4 independent clusters per call. Show the text, the derived scope, `distinctPhrasings`, and the date range. Options: Approve / Reject / Snooze 30 days.
5. **Persist.** `sessions shards approve|reject|snooze <id>` per decision.
6. **Report.** Proposed count, approved count, and the ratio — the number the precision goal is measured on.

**Key decisions**:

- The skill proposes only what passes the rubric. Dumping all 488 narrowed candidates on the user is the failure mode that trains people to reject everything without reading.
- Scope is shown but not editable in this phase. Overriding derived scope is inspection-surface work (Full tier).

**Implementation steps**:

1. Write `plugin/skills/shards/SKILL.md`.
2. Add `/shards` to the skill list printed by `runSetup` (`src/setup.ts:237-243`).
3. **Run `bun run generate-plugin-embed`.** `src/plugin-files.ts` is generated and is what `installPluginFromEmbed` writes (`src/setup.ts:63-75`); a skill added under `plugin/` without regenerating never reaches the compiled binary. Commit the regenerated file.

**Feedback loop**:

- **Playground**: The CLI — `bun run index.ts shards mine --repo "$PWD" --json | jq '.[0:3]'` is exactly the skill's input.
- **Experiment**: Invoke `/shards` against the golden-set fixture; count proposals versus approvals.
- **Check command**: `test -f plugin/skills/shards/SKILL.md && bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts`

### Golden-set fixture

**Overview**: 40 labeled turns that make the precision goal measurable and repeatable.

```typescript
interface GoldenTurn {
  text: string; // paraphrased, never verbatim
  label: 'shard' | 'chaff';
  reason: string; // why it was labeled that way
  expectedKind?: ShardKind; // present only when label === 'shard'
}
```

**Key decisions**:

- **Paraphrased and redacted, always.** This repo is public (MIT, `github.com/nicknisi/sessions`), and the record design deliberately keeps verbatim prompts off disk. Every entry is a rewritten stand-in preserving the _shape_ of the original — its length, its corrective grammar, its ambiguity — without reproducing anyone's actual conversation. Strip repo names, hostnames, package names, and identifiers.
- Exactly 40 entries. A criterion asserts the count so the only precision measurement in the plan cannot silently shrink.
- The measured base rate was roughly 5-8% shard, so aim for a similar ratio — about 3 `shard` and 37 `chaff`. A fixture that is half shards would flatter the rubric and measure nothing.

**Implementation steps**:

1. Create `src/shards/fixtures/golden-set.json` with 40 entries at the measured ratio.
2. Include the hard cases: a plausible-but-transient instruction, a bug report using corrective grammar, and a boilerplate prompt that looks repeated.

## Testing Requirements

### Unit Tests

| Test File                   | Coverage                                                   |
| --------------------------- | ---------------------------------------------------------- |
| `src/shards/snooze.test.ts` | Snooze dates, suppression, resurface-only-on-new-phrasings |

**Key test cases**:

- `snoozeUntil('2026-01-01')` → `'2026-01-31'`; month and year boundaries handled.
- Expired snooze with unchanged phrasings does **not** resurface.
- Expired snooze with more phrasings **does** resurface.
- Unexpired snooze with more phrasings does **not** resurface.
- `approve` on a `rejected` id succeeds (user changed their mind).
- Re-mine drops `rejected` candidates entirely.

### Manual Testing

- [ ] `/shards` proposes clusters, not raw candidates
- [ ] Approve/reject/snooze persist across a `sessions --clear-cache`
- [ ] Proposals-versus-approvals ratio against the golden set is at least 0.50

## Failure Modes

| Component  | Failure Mode           | Trigger                                       | Impact                                               | Mitigation                                                 |
| ---------- | ---------------------- | --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Skill      | Triage fatigue         | Skill proposes all narrowed candidates        | User rejects everything without reading; goal missed | Rubric filters before proposing; report the ratio each run |
| Skill      | Never ships            | `generate-plugin-embed` not re-run            | Skill absent from the compiled binary, silently      | Embed-freshness check is a success criterion               |
| Snooze     | Becomes a 30-day delay | Resurface on expiry alone                     | Dismissed candidates all return; snooze is worthless | Resurface requires expiry **and** new phrasings            |
| Snooze     | Flaky tests            | Reading a real clock                          | CI fails on date boundaries                          | Inject `todayIso`, per `src/significance.ts` precedent     |
| Fixture    | Conversation leak      | Verbatim turns committed to a public repo     | Real prompts published irreversibly                  | Paraphrase and redact every entry; no verbatim text        |
| Fixture    | Precision flattered    | Shard/chaff ratio far above the measured rate | 50% goal met by an easy fixture                      | Hold near the measured 5-8% base rate                      |
| Write-back | Rejection resurrected  | Re-mine overwrites state                      | Same rejected candidate re-triaged forever           | `upsertCandidates` updates evidence only (Phase 1)         |

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

## Open Items

- [ ] The rubric's pass/fail examples come from 40 hand-labeled turns. Revisit the wording after the first real triage run — the examples are the highest-leverage part of the skill.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
