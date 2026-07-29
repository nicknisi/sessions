# Implementation Spec: Context Shards - Phase 5

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 5 adds the two features that make shards scale past a handful: topic-conditional retrieval and a third scope tier for project groups.

**This phase is knowingly early, and the design should reflect that.** The contract's own argument against the source design is that a toggle-and-why-enabled UI exists to apologize for weak keyword retrieval, and that building the matcher before you have shard volume is backwards. The user chose the Stretch tier with that stated. The correct response is not to build a sophisticated ranker — it is to build the **smallest swappable matcher** that does the job, behind a seam that can be replaced once real shard volume shows what matching should key on. A bespoke scoring function tuned against fifteen shards would be fitted to noise.

So: matching is token overlap between the topic string and the shard text, using the same porter-stemmed tokenization the index already applies (`tokenize = 'porter unicode61'`, `src/cache.ts:167`). One exported function, one obvious replacement point. No embeddings, no new dependency — the dependency ceiling is a success criterion.

The **always-on flag** is the safety valve that makes conditional retrieval survivable. A shard marked always-on bypasses topic matching entirely. Without it, a poorly-worded topic string could suppress a critical standing constraint, and the failure would be silent — the agent simply never sees the rule. Always-on is how the source design handles "canary is the mainline branch": a company fact that must not depend on whether the task description happens to mention branching.

**Project groups** add `scope.type: 'group'`, resolved from configured path globs over repo containers. This is the middle tier between repo and workflow — `~/Developer/authkit-*` are four repos that share conventions but are not universal workflow rules. Unlike repo and workflow scope, group membership cannot be derived from the index; it needs configuration, which is why it waited until now.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Two shard scopes, repo and workflow, derived from how far a paraphrase cluster spreads** — rejected: explicit project groups as a third tier at contract time. Derivation is free once clustering exists, whereas groups need a grouping the index does not have — config, path globs, or a git-remote heuristic. This phase adds them under the Stretch tier.
- **Topic-conditional retrieval deferred to Stretch** — the contract's reasoning: it is a scaling feature that matters at 200 shards, not at 15, and building the matcher before there is volume to tune against is the same critique the plan levels at the source design. Implement it small and swappable.
- **Toggle UI and a why-enabled provenance column remain out of scope** — in the source design these exist to apologize for weak keyword retrieval; building the apology before the matcher is backwards.
- **Retrieval via an MCP `get_shards` tool** — rejected: the SessionStart hook, precisely because a hook fires before the user's first prompt and can therefore never do topic matching. This phase is what cashes in that decision.
- **`sessions` gains zero new runtime dependencies** — the two-dependency ceiling is an asserted success criterion, so no embedding or NLP library.
- **Cluster and derive scope by repo container via `resolveRepo`** — rejected: raw `cwd`, which mislabels sibling worktrees.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/topic.test.ts`

**Playground**: The exported `matchTopic` and `activeShardsFor` seams, driven from tests with a seeded store — no MCP client needed.

**Why this approach**: Matching is a pure scoring function over strings; a scoped test runner gives sub-second iteration on the exact behavior that is hardest to get right.

## File Changes

### New Files

| File Path                  | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `src/shards/topic.ts`      | `matchTopic` — the swappable scoring seam              |
| `src/shards/groups.ts`     | Group config loading and container-to-group resolution |
| `src/shards/topic.test.ts` | Ranking, always-on bypass, empty-topic behavior        |
| `src/shards/group.test.ts` | Group scope resolution and membership filtering        |

### Modified Files

| File Path                | Changes                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `src/shards/types.ts`    | Add `'group'` to `ShardScope['type']`; add `alwaysOn: boolean` to `ShardRecord` |
| `src/shards/store.ts`    | Add `always_on` column via migration (add, never drop); widen `scope_type`      |
| `src/shards/retrieve.ts` | `activeShardsFor(cwd, topic?)` — group membership and topic ranking             |
| `src/mcp.ts`             | Add the optional `topic` argument to `get_shards`; extend its description       |
| `src/shards/cli.ts`      | Add `--always-on` to the approve subcommand                                     |

## Implementation Details

### Topic matching

**Overview**: The smallest thing that ranks relevant shards above irrelevant ones, behind a seam built to be replaced.

```typescript
/**
 * Relevance of `shardText` to `topic`, in [0, 1].
 *
 * SWAPPABLE SEAM. This is deliberately the simplest defensible matcher —
 * stemmed token overlap — because it was written before there was enough
 * shard volume to tune anything more sophisticated against. Replace the body,
 * not the signature, once real usage shows what matching should key on.
 */
export function matchTopic(shardText: string, topic: string): number;

/** Below this, a non-always-on shard is dropped from the active set. */
export const TOPIC_THRESHOLD = 0.15;
```

**Key decisions**:

- Score is the fraction of topic tokens appearing in the shard text, after lowercasing, stripping punctuation, dropping stopwords, and applying a light suffix-stripping stem (`-ing`, `-ed`, `-s`) so "serialization" matches "serialize". This mirrors what `porter unicode61` does inside FTS without pulling in a library.
- Threshold is an exported constant, not a literal, so tuning is a one-line change.
- An **empty or absent topic disables filtering entirely** and returns the full active set. This is the Phase 3 behavior, preserved exactly — no caller is broken by this phase.
- Ranking is stable: sort by score descending, then by the Phase 3 deterministic order (workflow first, then by id). Two calls with the same inputs must produce byte-identical output.

**Implementation steps**:

1. Implement tokenization: lowercase, split on non-alphanumerics, drop a small stopword list, apply suffix stripping.
2. Implement `matchTopic` as `|topicTokens ∩ shardTokens| / |topicTokens|`, returning 1 for an empty topic.
3. Export `TOPIC_THRESHOLD`.

**Feedback loop**:

- **Playground**: `src/shards/topic.test.ts`.
- **Experiment**: Shard "API keys are stored in the keychain when available" against topics `"add keychain support"` (expect above threshold), `"refactor the CSS grid"` (expect below), and `""` (expect 1). Then a stemming case: shard "start from the serialized struct" against topic `"serialization"`.
- **Check command**: `bun test src/shards/topic.test.ts`

### Always-on flag

**Overview**: The bypass that keeps conditional retrieval from silently hiding critical rules.

**Key decisions**:

- Always-on shards are returned **regardless of topic**, and sort **first** — they are standing constraints, and an agent that truncates should truncate the conditional tail, not the invariants.
- Set at approval time: `sessions shards approve <id> --always-on`. Defaults to false; conditional is the norm and always-on is the deliberate exception.
- Store migration adds `always_on INTEGER NOT NULL DEFAULT 0`. **Add the column; never drop and rebuild** — Phase 1's store holds unrecoverable user judgments, unlike `index.db`.

**Implementation steps**:

1. Add `alwaysOn` to `ShardRecord` and the `always_on` column via an additive migration in `getShardsDb()`.
2. Thread `--always-on` through the approve subcommand.
3. In `activeShardsFor`, partition into always-on and conditional before scoring.

**Feedback loop**:

- **Playground**: `src/shards/topic.test.ts`.
- **Experiment**: Seed one always-on shard whose text shares no tokens with the topic and one conditional shard that matches. Query with that topic; assert both return and the always-on one sorts first. Query with a topic matching neither; assert only the always-on shard returns.
- **Check command**: `bun test src/shards/topic.test.ts`

### Project groups

**Pattern to follow**: `src/shards/store.ts` path resolution for the config location; `globPrefix` (`src/repo.ts`) for container matching.

**Overview**: A configured mapping from path globs to named groups, giving shards a scope between repo and workflow.

```typescript
export interface GroupConfig {
  /** Group name → path globs over repo containers. */
  groups: Record<string, string[]>;
}

/** Groups whose globs match `container`. Empty when none or when config is absent. */
export function groupsFor(container: string, config: GroupConfig): string[];

/** Reads $SESSIONS_DATA_DIR/groups.json. Missing or malformed → empty config, never throws. */
export function loadGroupConfig(): GroupConfig;
```

Config file (`~/.local/share/sessions/groups.json`):

```json
{
  "groups": {
    "authkit": ["~/Developer/authkit-*"],
    "workos-cli": ["~/Developer/cli/*"]
  }
}
```

**Key decisions**:

- **Config lives in the data dir, never in a repo.** Writing a `.sessions/` config into a project would violate the out-of-band requirement outright.
- Malformed or missing config yields an empty config rather than an error. A broken groups file must degrade retrieval to repo-plus-workflow, not break every agent's tool call.
- `~` expands to `homedir()`; globs match against the resolved repo container, not the raw cwd, consistent with every other scope decision.
- Group scope is **assigned at triage**, not derived. Phase 1's spread heuristic cannot distinguish "these four repos share a convention" from "this is universal"; a human picks.
- A group shard returns for any member container and for no non-member.

**Implementation steps**:

1. Implement `loadGroupConfig` with a try/catch returning `{ groups: {} }` on any failure.
2. Implement `groupsFor` using `globPrefix`-style matching after `~` expansion.
3. Widen `ShardScope['type']` to include `'group'`, with `key` holding the group name.
4. In `activeShardsFor`, include group-scoped shards whose group name is in `groupsFor(container, config)`.
5. Allow the triage skill's approve step to set group scope — extend the CLI with `--scope group:<name>`.

**Feedback loop**:

- **Playground**: `src/shards/group.test.ts` with `SESSIONS_DATA_DIR` at a tmpdir holding a fixture `groups.json`.
- **Experiment**: Config maps `authkit` to `/tmp/x/authkit-*`. Seed a group shard for `authkit`. Query from `/tmp/x/authkit-nextjs` (expect returned), `/tmp/x/authkit-session/packages/core` (expect returned — subdirectory), and `/tmp/x/sessions` (expect absent). Then delete the config and assert the query still succeeds, returning only repo and workflow shards.
- **Check command**: `bun test src/shards/group.test.ts`

### `get_shards` topic argument

**Pattern to follow**: `src/mcp.ts:52-60` for zod argument definitions with `.describe()`.

```typescript
{
  cwd: z.string().optional().describe('Working directory. Defaults to the server process cwd.'),
  topic: z.string().optional().describe(
    'What you are about to work on, in a few words — e.g. "add keychain support to the CLI". ' +
    'Narrows the returned facts to those relevant to this task. Omit to get everything for this repo.',
  ),
}
```

Extend the tool description with one clause: passing `topic` narrows the result, and standing constraints are always returned regardless.

**Implementation steps**:

1. Add the `topic` argument to the schema and thread it into `runGetShards`.
2. Extend the description.
3. Confirm the Phase 3 tests still pass unchanged — omitting `topic` must behave exactly as before.

## Data Model

```sql
-- Additive migration. Never drop this table: it holds unrecoverable user judgments.
ALTER TABLE shards ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0;
-- scope_type now admits 'repo' | 'group' | 'workflow'; no schema change needed (TEXT).
CREATE INDEX IF NOT EXISTS idx_shards_always_on ON shards(always_on);
```

Guard the `ALTER` with a `PRAGMA table_info(shards)` check so it is idempotent across runs.

## Testing Requirements

### Unit Tests

| Test File                  | Coverage                                                    |
| -------------------------- | ----------------------------------------------------------- |
| `src/shards/topic.test.ts` | Scoring, threshold, stemming, always-on bypass and ordering |
| `src/shards/group.test.ts` | Group resolution, membership, missing-config degradation    |

**Key test cases**:

- Empty topic returns the full Phase 3 active set, in the Phase 3 order.
- Matching shards rank above non-matching ones.
- Always-on returns and sorts first even at score 0.
- Stemmed match: topic "serialization" hits shard text "serialize".
- Group shard returns for a member subdirectory, not for a non-member.
- Missing `groups.json` degrades to repo-plus-workflow without throwing.
- Malformed `groups.json` does the same.
- Two identical calls produce byte-identical output.
- Migration is idempotent: opening an already-migrated store twice does not error.

### Manual Testing

- [ ] `get_shards` with a topic returns a visibly narrower set than without
- [ ] An always-on shard appears for an unrelated topic
- [ ] Deleting `groups.json` does not break retrieval

## Failure Modes

| Component   | Failure Mode                          | Trigger                                      | Impact                                                  | Mitigation                                                    |
| ----------- | ------------------------------------- | -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Topic match | Critical rule silently suppressed     | Topic string shares no tokens with the shard | Agent violates a standing constraint; no error anywhere | Always-on bypass; standing constraints marked at approval     |
| Topic match | Over-fitted ranker                    | Tuning a bespoke scorer against ~15 shards   | Matching fitted to noise; worse than no filter          | Smallest defensible matcher behind a documented swap seam     |
| Topic match | Threshold hides everything            | Threshold set too high for short shard texts | Empty results for valid topics                          | Exported constant; empty topic always returns everything      |
| Groups      | Retrieval breaks on bad config        | Malformed or missing `groups.json`           | Every agent tool call fails                             | Parse failures yield an empty config, never an exception      |
| Groups      | Config written into a repo            | Convenience placement in `.sessions/`        | Violates the out-of-band requirement                    | Config lives in the data dir only; no repo path is ever read  |
| Store       | User judgments destroyed by migration | Drop-and-rebuild on schema change            | Every approval and rejection lost                       | Additive `ALTER` guarded by `table_info`; never drop          |
| Retrieval   | Phase 3 behavior regressed            | Topic filtering applied when topic is absent | Existing callers silently get fewer shards              | Empty topic short-circuits; Phase 3 tests must pass unchanged |

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

- [ ] `TOPIC_THRESHOLD` is a guess made before real shard volume existed. After a few weeks of use, check whether shards are being wrongly suppressed and tune it — or replace `matchTopic`'s body outright, which is what the seam is for.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
