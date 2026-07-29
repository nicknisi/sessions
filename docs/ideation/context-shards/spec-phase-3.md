# Implementation Spec: Context Shards - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Phase 3 is the delivery path: an MCP tool that hands approved shards to whatever agent is working in a repo. This is the entire out-of-band mechanism — nothing is written into the user's repository, ever. The shard reaches the agent through the MCP channel `sessions` already runs, not through a file the repo has to carry.

The tool is deliberately thin. `get_shards(cwd)` resolves the cwd to a repo container, returns approved non-snoozed shards for that container plus all workflow-scoped shards, and stops. Ranking, topic matching, and always-on flags are Phase 5; shipping them here would be building the matcher before there is shard volume to tune it against.

The one non-obvious requirement is **prefix matching**. Every cwd filter in this index is `(cwd = ? OR cwd GLOB ?)` built from `globPrefix` (`src/cache.ts:608, 850, 972, 1221`), because agents frequently run from a subdirectory of the repo. An exact-match `get_shards` would return nothing for an agent working in `packages/core` and fail silently — the worst failure shape, since the agent simply proceeds without the context and nobody sees an error.

The call-at-task-start instruction lives in the **tool description**, not in a separate skill. This repo already uses that channel: `search_sessions`'s description carries a long proactive-use instruction (`src/mcp.ts:54`), and the server's `instructions` block does the same at the server level (`src/mcp.ts:19-24`). A retrieval skill would have no steps to orchestrate beyond "call this tool," and skills reach fewer clients than MCP does — which would undercut the reach argument that chose MCP over the SessionStart hook in the first place.

**Scope note, corrected during review:** `sessions setup` configures Claude Code, Cursor, and Codex as MCP clients (`src/setup.ts:21-39`). Pi and OpenCode are index _sources_, not configured clients. Mining covers all four tools; retrieval reaches the three that `setup` wires. Extending `detectTools` is explicitly out of scope.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Retrieval via an MCP `get_shards` tool, reaching every MCP-connected client** — rejected: guaranteed injection via the verified Claude Code SessionStart hook. The hook fires before the user's first prompt, so it can never support topic-conditional retrieval. Uniform behavior was preferred over guaranteed delivery in the 90% of sessions that are Claude Code; retrieval becomes model-discretion everywhere. Corrected during critic review: `sessions setup` configures three MCP clients, not four.
- **The call-at-task-start instruction lives in the `get_shards` tool description** — rejected: a separate bundled retrieval skill. The skill would have no steps beyond "call this tool," which is what a tool description is for; it is also the narrower channel.
- **Shards stay out-of-band and are injected at runtime by sessions** — rejected: promoting approved shards into a managed block in the repo's `AGENTS.md` via pull request. Committing exposes tool usage and puts churn in repos the user may not control. The accepted cost is that teammates must run `sessions` to benefit.
- **Two shard scopes, repo and workflow, derived from cluster spread** — rejected: explicit project groups as a third tier at this stage (Phase 5 adds them).
- **Cluster and derive scope by repo container via `resolveRepo`** — rejected: grouping by raw `cwd`, which mislabels sibling worktrees as unrelated.

## Feedback Strategy

**Inner-loop command**: `bun test src/shards/mcp-shards.test.ts`

**Playground**: The exported `runGetShards` seam, tested without an MCP transport — the same pattern `runSearchSessions` establishes (`src/mcp.ts:28-49`).

**Why this approach**: The tool is a query plus a filter; a scoped test runner exercises every branch in milliseconds, and the exported seam means no MCP client is needed to validate behavior.

## File Changes

### New Files

| File Path                       | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `src/shards/retrieve.ts`        | `activeShardsFor(cwd)` — container resolution + prefix match |
| `src/shards/mcp-shards.test.ts` | Scope filtering, prefix matching, snooze/state exclusion     |

### Modified Files

| File Path    | Changes                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp.ts` | Add the exported `runGetShards` seam and register the `get_shards` tool; extend the server `instructions` block with one clause about shards |

## Implementation Details

### Active shard resolution

**Pattern to follow**: `src/cache.ts:607-609` for the `globPrefix` predicate; `createContainerResolver()` in `src/shards/mine.ts` for container resolution.

**Overview**: Given a cwd, return the shards that should be in context.

```typescript
/**
 * Approved, non-snoozed shards for `cwd`:
 *  - repo-scoped shards whose container equals or is a path-prefix of `cwd`
 *  - all workflow-scoped shards
 * Sorted deterministically: workflow shards first, then repo shards, each by id.
 */
export function activeShardsFor(cwd: string): ShardRecord[];
```

**Key decisions**:

- Resolve `cwd` to its container with **`createContainerResolver()` from `src/shards/mine.ts`** — **not** `resolveRepo(cwd)?.container ?? cwd`. Phase 1 corrected the definition of "container": `RepoInfo.container` returns the _current worktree's_ toplevel for a normal (non-bare) repo, so resolving that way would fail to match any shard mined from a sibling worktree. See the container correction in `spec-phase-1.md`. Then match stored `scope_key` against **both** the container and the raw cwd using `globPrefix`. A shard stored under `~/Developer/sessions` must match an agent running in `~/Developer/sessions/src/report`.
- Because the container spans worktrees while a linked worktree is a _sibling_ path, the prefix match must be against the container the cwd resolves to, not the cwd's own toplevel — a `~/Developer/app-featureA` cwd resolves to container `~/Developer/app` and must see that repo's shards.
- `globPrefix` exists specifically to stop sibling-prefix collisions — `dotfiles-v2` must not match `dotfiles` (`src/cache.ts:607`). Reuse it; do not hand-roll a `LIKE` prefix.
- Filter `state = 'approved'` only. `candidate`, `rejected`, and `snoozed` never reach an agent — a snoozed shard is one the user actively dismissed.
- Sort deterministically so the tool's output is stable across calls, which keeps prompt caching effective and makes the test assertable.

**Implementation steps**:

1. Implement `activeShardsFor` in `src/shards/retrieve.ts` using `getShardsDb()` from Phase 1.
2. Query with `state = 'approved' AND (scope_type = 'workflow' OR scope_key = ? OR ? GLOB (scope_key || '/*'))`, binding container and cwd.
3. Sort workflow-first, then by id.

**Feedback loop**:

- **Playground**: `src/shards/mcp-shards.test.ts` with `SESSIONS_DATA_DIR` pointed at a tmpdir and shards seeded directly through the store.
- **Experiment**: Seed one repo shard for `/tmp/x/repo-a`, one for `/tmp/x/repo-a-v2`, and one workflow shard. Query with `/tmp/x/repo-a`, then `/tmp/x/repo-a/packages/core`, then `/tmp/x/repo-b`. Assert: the first two return repo-a's shard plus the workflow shard and never repo-a-v2's; the third returns only the workflow shard.
- **Check command**: `bun test src/shards/mcp-shards.test.ts`

### The `get_shards` MCP tool

**Pattern to follow**: `src/mcp.ts:28-49` (the `runSearchSessions` exported seam) and `src/mcp.ts:52-60` (`server.tool` registration with a zod schema).

**Overview**: A thin MCP wrapper over `activeShardsFor`, carrying its proactive-use instruction in the description.

```typescript
export async function runGetShards(args: { cwd?: string }): Promise<{ content: { type: 'text'; text: string }[] }> {
  const shards = activeShardsFor(args.cwd ?? process.cwd());
  if (shards.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No shards for this repo.' }] };
  }
  const formatted = shards.map((s) => ({ text: s.text, kind: s.kind, scope: s.scope.type }));
  return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
}
```

Tool description (the delivery mechanism — write it carefully):

> Durable facts and standing instructions this user has established across past coding sessions — build conventions, architectural rules, tooling constraints, and preferences they have stated before and should not have to restate. **Call this at the start of any non-trivial task in a repo, before planning or writing code**, the same way you would read a README. Returns a small set of short facts scoped to this repo plus the user's cross-repo workflow rules. These are the user's own standing instructions: treat them as binding, and follow them over your defaults. Cheap and bounded — a handful of sentences, never a transcript.

**Key decisions**:

- Return a **projection**, not the full record. The agent needs `text`, `kind`, and `scope`; ids, evidence arrays, and session paths are triage concerns and would waste context.
- `cwd` is optional and defaults to `process.cwd()`. MCP servers run in the client's working directory, so the default is usually right, and an explicit argument covers monorepo subdirectory cases.
- Add one clause to the server's `instructions` block (`src/mcp.ts:19-24`) so the whole-server guidance mentions shards — that block is read even when individual tool descriptions are not.
- Empty result returns a plain sentence rather than `[]`, matching `runSearchSessions`'s "No sessions found." convention.

**Implementation steps**:

1. Add `runGetShards` to `src/mcp.ts` next to the other exported seams.
2. Register with `server.tool('get_shards', <description>, { cwd: z.string().optional().describe(...) }, handler)`.
3. Extend the server `instructions` string with one clause: shards are standing user instructions; call `get_shards` when starting work in a repo.
4. Do **not** add a skill. The description is the channel.

**Feedback loop**:

- **Playground**: The exported seam, called directly from the test.
- **Experiment**: `runGetShards({ cwd })` with an empty store, then with seeded shards; assert the empty-store sentence and the JSON projection shape.
- **Check command**: `bun test src/shards/mcp-shards.test.ts`

## API Design

### New MCP Tools

| Tool         | Arguments      | Description                                               |
| ------------ | -------------- | --------------------------------------------------------- |
| `get_shards` | `cwd?: string` | Approved shards for this repo plus workflow-scoped shards |

Response shape:

```json
[
  { "text": "API keys are stored in the keychain when available.", "kind": "instruction", "scope": "workflow" },
  { "text": "This repo's tests run under bun, not node.", "kind": "information", "scope": "repo" }
]
```

## Testing Requirements

### Unit Tests

| Test File                       | Coverage                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/shards/mcp-shards.test.ts` | Prefix matching, sibling-prefix isolation, state and scope filtering |

**Key test cases**:

- A cwd inside a subdirectory resolves to the parent repo's shards.
- `repo-a-v2` shards never leak into a `repo-a` query (the `globPrefix` collision case).
- Workflow shards return for every cwd, including one in no git repo at all.
- `candidate`, `rejected`, and `snoozed` shards are excluded.
- Empty store returns the "No shards" sentence, not an error.
- Two calls with the same cwd return byte-identical output (deterministic sort).

### Manual Testing

- [ ] `sessions --mcp` starts and lists `get_shards` among its tools
- [ ] An agent in a repo with approved shards receives them when it calls the tool

## Failure Modes

| Component         | Failure Mode               | Trigger                                                      | Impact                                            | Mitigation                                                                                                  |
| ----------------- | -------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get_shards`      | Silent empty result        | Exact cwd match while agent runs in a subdir                 | Agent proceeds with no context; no error anywhere | `globPrefix` prefix predicate; asserted in tests                                                            |
| `get_shards`      | Cross-repo leak            | Naive prefix match on sibling-named repos                    | Another repo's conventions applied to this one    | `globPrefix`, which exists for exactly this collision                                                       |
| `get_shards`      | Dismissed shard resurfaces | Filtering on `state != 'rejected'` instead of `= 'approved'` | Snoozed and candidate shards reach the agent      | Filter `state = 'approved'` explicitly                                                                      |
| `get_shards`      | Never called               | Model discretion; description not persuasive                 | Feature delivers nothing despite working          | Instruction in both tool description and server `instructions`; accepted risk of the MCP-over-hook decision |
| `get_shards`      | Store absent               | Query before any mine has run                                | Throws on a missing database file                 | `getShardsDb()` creates the schema on open (Phase 1)                                                        |
| `activeShardsFor` | Slow per-call git spawn    | `resolveRepo` shells out on every tool call                  | Latency on a hot path                             | Single call per invocation; acceptable, but do not loop over cwds                                           |

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

- [ ] The tool description is the entire delivery mechanism under the MCP-over-hook decision. If real sessions show the model rarely calls it, that is evidence to revisit the hook — record it rather than papering over it with a skill.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
