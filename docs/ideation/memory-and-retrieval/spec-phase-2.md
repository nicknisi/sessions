# Implementation Spec: Memory Hygiene & Measured Retrieval - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: L
**Prerequisite**: Phase 1 (Durability hygiene) — distill's tests must not be able to reach the real store.

## Technical Approach

The lesson store holds exactly one row, written by hand to prove the plumbing. `remember_lesson` only fires when an agent chooses to call it mid-session; nothing seeds it from the thousands of sessions already indexed. The realistic failure of this feature is an empty table, and `sessions distill` is the answer: mine indexed history for lessons and put them in front of a human.

Two hard constraints shape the whole design.

**The run writes nothing.** Candidates are printed and offered once, in the same sitting; only what the human says yes to is saved, through the ordinary `rememberLesson` path so an overlap still lands in the conflict quarantine. This supersedes the original design, which persisted every candidate as a `proposed` row for a later `sessions lessons review` pass — see the amendment below.

**Amendment (superseding the `proposed` status).** The persistence existed so an interrupted review would not waste the mining run. But mining is one prompt, ≤96 KB, ten sessions, a single CLI call. The row-based design bought a new status in the state vocabulary, five propose/accept/reject functions, primer counting so proposals did not inflate the conflict nag, FTS deletion on reject to avoid phantom conflicts, and **three branches inside `saveLesson`** — `shortlist`'s `includeProposed`, the supersedes-a-proposal refusal, and the `displaced` exact-hash path — all to protect a one-minute job from being re-run. The contract had already bounded distill away from the 4,400-session run that would have justified it. `distill` was also the only command in the tool that was a job rather than a question, and it needed a scheduler the contract explicitly refused to add. Print-only *strengthens* the safety property the `proposed` status was built for: nothing unreviewed can pollute the primer because nothing is written at all.

**The subprocess must be side-effect-free.** `src/wrapped/roast.ts:25` runs `claude -p`, `codex exec`, and `pi -p` through `Bun.spawn` with no sandbox, no cwd restriction, and the user's own auth. That seam is safe today only because `roastDigest` (roast.ts:45) feeds it *stats only* — its comment says so explicitly: "the model gets numbers to riff on, never transcript prose." Distill inverts that premise. Transcripts contain arbitrary text an agent once read from the web, from files, from tool output. Feeding that to an unsandboxed agent with write access is a prompt-injection path onto the user's machine. Distill therefore builds its **own** restricted argv and does not reuse the roast tool table as-is.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **`sessions distill` prints candidates and writes nothing; each is offered once in the same run** — rejected: persisting them as `proposed` rows for a later review pass. The persistence protected a one-minute job from being re-run, at the cost of a status, five functions, and three branches in `saveLesson`. Nothing unreviewed can pollute the primer if nothing is written.
- **`sessions distill` never writes an active row unasked** — rejected: auto-saving like `remember_lesson` does. A bad model pass costs one read-through instead of silently polluting the primer.
- **`sessions lessons review` stays conflict arbitration only** — rejected: giving it a second verb set for proposals. A conflict is arbitrated (new/old/both); with no machine-authored rows in the store, `needs_review` means exactly one thing again.
- **distill reads a bounded ranked selection (`--query`/`--limit`/`--days`), defaulting small** — rejected: all history, or a watermark. 4,400 indexed sessions × one agent-CLI call each is hours and a lot of tokens; a watermark's first run is still unbounded and invites a cron that quietly burns tokens.
- **Distill success is measured mechanically; quality is a judgment criterion with an explicit bar** — rejected: asserting it finds known lessons in the eval fixtures. Those fixtures are synthetic, so the test would measure whether it can mine fake sessions.
- **A side-effect-free invocation contract, verified against the production argv** — rejected: reusing the roast tool table unchanged. That seam is only safe because roast feeds it numbers; distill feeds prose.

## Feedback Strategy

**Inner-loop command**: `bun test src/distill.test.ts src/distill.sandbox.test.ts`

**Playground**: Test suite with an injected runner. Both test files run with **no agent CLI installed** — the runner is a function, so nothing spawns.

**Why this approach**: The only genuinely non-deterministic part is the model's output, which is exactly what the injected runner replaces. Everything else — selection bounds, argv construction, status transitions, review surfacing — is deterministic and fast to check.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/distill.ts` | Selection, prompt construction, restricted argv, rendering candidates, the inline save walk, `--json` |
| `src/distill.test.ts` | Bounded selection, writes-nothing-by-default, `--save`, `--json`, fail-open |
| `src/distill.sandbox.test.ts` | Asserts the **production** argv restricts the subprocess |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/memory.ts` | **Amended**: no new status. The `'proposed'` status and its five functions were removed, along with `shortlist`'s `includeProposed`, the supersedes-a-proposal refusal, and the `displaced` branch in `saveLesson` |
| `src/lessons.ts` | **Amended**: `review` stays conflict arbitration only; `--proposals` and the proposal walk removed |
| `src/wrapped/roast.ts` | Export the `RoastTool` shape and `spawnRunner` so distill can reuse the mechanism with a different, restricted tool table |
| `src/cli.ts` | Parse `distill` args: `--query`, `--limit`, `--days`, `--with` |
| `index.ts` | Dispatch the `distill` command |
| `src/mcp.ts` | No new tool — distill is CLI-only this phase (noted in Open Items) |

## Implementation Details

### 1. The restricted invocation contract

**Pattern to follow**: `src/wrapped/roast.ts:104-116` (`spawnRunner`) for the spawn mechanics; **not** its tool table.

**Overview**: A distill-specific tool table whose argv disables tool use. Verified flags only — a CLI without one is not offered.

```typescript
// src/distill.ts
/** Distill feeds TRANSCRIPT PROSE to a model, unlike roast which feeds stats
 *  (roast.ts:45). Prose can carry anything an agent once read, so the child
 *  must not be able to act on it. Only CLIs with a verified restriction flag
 *  are listed here — pi has none, so pi is absent by design, not by oversight. */
const DISTILL_TOOLS: RoastTool[] = [
  {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    args: (p) => ['-p', '--permission-mode', 'plan', '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,WebFetch', p],
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    args: (p) => ['exec', '--sandbox', 'read-only', p],
  },
];
```

**Key decisions**:
- Belt and braces on Claude: `--permission-mode plan` *and* an explicit `--disallowed-tools` list. Either alone would do; both means a flag rename upstream degrades to the other rather than to unrestricted.
- Codex gets `--sandbox read-only`, which is a first-class value of its `-s` flag.
- **Pi is excluded.** No restriction flag was verifiable. Excluding a tool is cheap; shipping an unsandboxed one is not.
- The child is spawned with `cwd` set to a temp dir, so even a successful escape has nothing of the user's to touch.

**Implementation steps**:
1. Export `RoastTool` and `spawnRunner` from `roast.ts` (mechanism reuse, table not reused).
2. Define `DISTILL_TOOLS` as above.
3. `detectDistillTool(preferred?)` — same shape as `detectRoastTool`, over `DISTILL_TOOLS`.
4. Spawn with `cwd: mkdtempSync(...)`.

**Feedback loop**:
- **Playground**: `src/distill.sandbox.test.ts`.
- **Experiment**: build the argv for each tool in `DISTILL_TOOLS` and assert the restricting flag is present; assert `pi` is not in the table; assert the spawn options carry a `cwd` outside the repo.
- **Check command**: `bun test src/distill.sandbox.test.ts`

### 2. Bounded selection

**Pattern to follow**: `searchSessions` in `src/cache.ts` — the ranked, junk-filtered selection is the product's unique asset and the reason distill is better positioned than a raw normalizer.

**Overview**: `distill` selects through the existing search path, never by walking the tree.

```typescript
export interface DistillOptions {
  query?: string;
  limit?: number;   // default DEFAULT_DISTILL_LIMIT
  days?: number;
  with?: 'claude' | 'codex';
  runner?: RoastRunner;   // injected in tests
}

export const DEFAULT_DISTILL_LIMIT = 10;
```

**Key decisions**:
- Default 10. Small enough that a first run is cheap, large enough to clear the gate's 8-proposal floor in one go.
- `--limit` is clamped to a hard maximum (50) — an unbounded run is the failure the contract's decision log exists to prevent.
- One agent-CLI call per **batch**, not per session: the prompt carries N digests. Cheaper, and it lets the model see repetition across sessions, which is where the transferable lessons are.

**Implementation steps**:
1. Resolve the selection via `searchSessions` with the supplied filters.
2. Build one prompt from the digests of the selected sessions (reuse `renderDigestMarkdown`).
3. Invoke the runner once, parse a JSON array of proposals.
4. Write each through `proposeLesson`.

**Feedback loop**:
- **Playground**: `src/distill.test.ts` over the eval fixture corpus with an injected runner.
- **Experiment**: no-arg run selects exactly `DEFAULT_DISTILL_LIMIT`; `--limit 999` clamps to 50; `--days 1` over a corpus with older sessions selects none.
- **Check command**: `bun test src/distill.test.ts`

### 3. Proposals as a first-class status

**Overview**: ~~A new `status = 'proposed'`, distinct from `needs_review`.~~ **Superseded by the amendment above** — distill writes nothing, so there is no machine-authored row to give a status to. Retained below for the reasoning trail only; none of it shipped.

```typescript
export function proposeLesson(input: ProposeInput): ProposeResult
```

**Key decisions**:
- New status rather than a synthetic `review_group`: the quarantine's vocabulary is `'new' | 'old' | 'both'` — arbitration between rival claims. A proposal needs accept/reject, which is a different verb set.
- The primer's `flagged` count (memory.ts:415) counts `needs_review` only. Proposals surface as a separate `proposedCount` so "2 conflicts withheld" never silently means "2 unreviewed proposals".
- Accepting a proposal routes it through the **existing** `rememberLesson` near-duplicate path, so an accepted proposal that overlaps an active lesson still lands in the conflict quarantine rather than skipping it.

**Implementation steps**:
1. Extend the `status` CHECK constraint; bump the memory DB `user_version` with a forward migration (never DROP — the store is not re-derivable).
2. `proposeLesson` — content-hash idempotent like `rememberLesson`; a proposal duplicating an active lesson is dropped, not proposed.
3. `listProposals()`, `acceptProposal(id)`, `rejectProposal(id)`.
4. `sessions lessons review` renders proposals as their own section.
5. Primer: separate `proposedCount`, excluded from `flagged`.

**Feedback loop**:
- **Playground**: `src/distill.test.ts`.
- **Experiment**: propose 3 → `listProposals()` returns 3, `active` is 0, primer `flagged` is 0 and `proposedCount` is 3; accept one that overlaps an active lesson → it lands `needs_review`, not `active`; reject one → it is retrievable via export but not served.
- **Check command**: `bun test src/distill.test.ts`

## Data Model

```sql
-- Forward migration on the lesson store. Never DROP: this data is not re-derivable.
-- status gains 'proposed'; existing rows are untouched.
ALTER TABLE lessons RENAME TO lessons_old;
CREATE TABLE lessons ( ... status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','needs_review','superseded','retired','proposed')) ... );
INSERT INTO lessons SELECT * FROM lessons_old;
DROP TABLE lessons_old;
PRAGMA user_version = 2;
```

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/distill.sandbox.test.ts` | Production argv restricts every offered tool; pi absent; cwd outside the repo |
| `src/distill.test.ts` | Bounded selection, clamping, proposal status, review visibility, primer counts, accept/reject, fail-open |

**Key test cases**:
- No-arg run selects exactly the default limit; `--limit 999` clamps.
- Every proposal lands `proposed`; zero land `active`.
- `sessions lessons review` lists proposals; the primer's `flagged` count excludes them.
- Accepting a proposal overlapping an active lesson lands `needs_review`.
- No agent CLI on PATH → exit 0, no store created, stderr names the CLIs it looked for.
- A runner returning garbage → zero proposals, exit 0, warning on stderr.
- The migration preserves every existing row and its supersedes chain.

### Manual Testing

- [ ] `sessions distill --limit 10` against real history; read the proposals.
- [ ] `sessions lessons review`; accept some, reject others.
- [ ] Confirm the primer shows accepted lessons and never showed the proposals.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Runner | Prompt injection from transcript prose | A session containing adversarial text | Model attempts a tool call | Restricted argv; temp cwd; proposals never auto-activate |
| Runner | Model returns prose, not JSON | Any run | Zero proposals | Fail open with a warning — same shape as `--roast` |
| Runner | Timeout on a large batch | Many long digests | No proposals | Hard timeout, inherited from `spawnRunner` |
| Selection | Junk sessions selected | Query matches eval-harness dirs | Wasted tokens, junk proposals | Selection goes through `searchSessions`, which excludes junk cwds by default |
| Proposals | Store fills with stale proposals | Repeated runs, no review | Review fatigue | Content-hash idempotence; a proposal duplicating an active lesson is dropped |
| Migration | Interrupted mid-migration | Crash during `ALTER` | Store in `lessons_old` state | Run inside a transaction; phase 1's snapshot is the backstop |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test
bun run format:check
```

## Open Items

- [ ] No MCP `distill` tool this phase — CLI only. An agent asking to mine history is a different trust question than an agent recording what it just learned, and it has no named consumer yet.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
