# Context Shards Contract

**Created**: 2026-07-28
**Readiness**: All 5 gates ready
**Status**: Approved
**Approval**: Express — single consolidated confirmation, no per-artifact review
**Supersedes**: None

## Problem Statement

Durable workflow facts get re-typed to coding agents session after session. "API keys always go in the keychain when available", "skills can invoke inline scripts", "this repo branches off canary" - each is stated once, acted on once, and then lost when the session closes. The next session starts blind, and so does the next tool.

The cost compounds across tools. A fact established in Claude Code is invisible to Codex, Pi, and OpenCode, because each tool's memory is its own file in its own format. The user runs all four; the index holds 4,045 Claude sessions, 296 Codex, 155 Pi, and 2 OpenCode, and nothing carries knowledge between them.

The existing manual remedy - hand-written CLAUDE.md and memory files - captures only what the user remembers to write down, at the moment they remember to write it. Seven months of transcripts hold facts that were never captured because capturing them was a separate act of discipline nobody performs mid-task.

sessions is uniquely positioned to fix this: it already indexes all four tools' transcripts into one full-text-searchable corpus. Measurement during the interview confirmed the raw material is there and is tractable - 488 corrective-shaped user turns in the 25-240 character band, containing an estimated 25-35 genuinely durable facts.

## Goals

1. An agent in any MCP-connected tool can retrieve the approved shards relevant to its repo at task start, with no file ever written into the user's repository.
2. At least 50% of shards proposed to the user at triage are approved, measured against the 40-turn golden set hand-labeled from the real index.
3. Backfill mining of one repo's full history completes in under 5 seconds of mine time against an already-refreshed index; the ensureIndexFresh source scan is excluded from the budget and measured separately.
4. Mining, dedupe, fingerprinting, and scope derivation are fully deterministic: two runs over the same corpus produce byte-identical candidate records, not merely equal ids.
5. Approved, rejected, and snoozed states survive every cache-invalidation path sessions already has - --clear-cache, sessions cleanup, and corruption self-heal.
6. sessions gains zero LLM dependencies and zero new runtime dependencies; package.json keeps exactly two entries under dependencies.

## Success Criteria

- [ ] The backfill mine emits schema-valid v1 candidate records with every required field populated (id, text, kind, scope, author, evidence, state), narrowing over message_fts with msg_index >= 0 so the subagent sentinel row is never mined as user prose. — check: `bun test src/shards/mine.test.ts` → exits 0
- [ ] Byte-identical repeated turns collapse to a single occurrence: a fixture containing the same prompt 14 times yields distinctPhrasings of 1, not 14. — check: `bun test src/shards/dedupe.test.ts` → exits 0
- [ ] Mining the same fixture twice produces byte-identical records - JSON.stringify equality over the whole record set, covering evidence array ordering, date formatting, and cluster ordering, not just content-addressed id equality. — check: `bun test src/shards/record.test.ts` → exits 0
- [ ] Scope derives from repo-container spread via resolveRepo, not raw cwd: three sibling worktrees of one repo yield scope.type 'repo', while a cluster spanning three unrelated containers yields scope.type 'workflow'. — check: `bun test src/shards/scope.test.ts` → exits 0
- [ ] A snoozed candidate is suppressed until its snoozedUntil date, and resurfaces on a later re-mine only when new distinct phrasings have appeared since the snooze. — check: `bun test src/shards/snooze.test.ts` → exits 0
- [ ] The MCP get_shards tool returns only approved, non-snoozed shards whose repo container prefix-matches the requested cwd (the globPrefix predicate used everywhere else in the index), plus workflow-scoped shards, excluding other repos' shards - and a cwd inside a subdirectory still resolves. — check: `bun test src/shards/mcp-shards.test.ts` → exits 0
- [ ] Shard state survives cache invalidation: approved and snoozed records persist across --clear-cache, sessions cleanup, and a corruption self-heal of index.db. — check: `bun test src/shards/durability.test.ts` → exits 0
- [ ] No shard operation writes into the user's repository: mine, approve, reject, and snooze run with the store redirected to a tmpdir and leave the cwd tree byte-unchanged. — check: `bun test src/shards/no-repo-writes.test.ts` → exits 0
- [ ] Backfill mine time stays within budget: mining a generated fixture DB of representative size completes in under 5 seconds, measured against an already-refreshed index. — check: `bun test src/shards/mine.perf.test.ts` → exits 0
- [ ] The runtime dependency ceiling holds - package.json still declares exactly two dependencies. — check: `test "$(node -p 'Object.keys(require("./package.json").dependencies).length')" -eq 2` → exits 0
- [ ] The /shards triage skill ships in the compiled binary: the SKILL.md exists and the checked-in plugin embed is current. — check: `test -f plugin/skills/shards/SKILL.md && bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts` → exits 0
- [ ] The golden-set fixture holds exactly 40 labeled turns, so the only precision measurement in the plan cannot silently shrink. — check: `test "$(node -p 'require("./src/shards/fixtures/golden-set.json").length')" -eq 40` → exits 0
- [ ] The full CI chain stays green - lint, format, typecheck, tests, and the compile step that the dependency-footprint goal depends on. — check: `bun run lint && bun run format:check && bun run typecheck && bun test && bun run build` → exits 0
- [ ] Export emits portable v1 records that import restores without loss, and merge(records[]) is pure - the same input set in any order yields the same clusters. — check: `bun test src/shards/export.test.ts` → exits 0
- [ ] The quorum metric counts distinct authors, not occurrences: five records from one author score 1, while one record each from five authors scores 5. — check: `bun test src/shards/quorum.test.ts` → exits 0
- [ ] Topic-conditional retrieval narrows the active set: get_shards(cwd, topic) returns topic-matching shards ranked above non-matching ones, and always includes shards marked always-on regardless of topic. — check: `bun test src/shards/topic.test.ts` → exits 0
- [ ] Project-group scope resolves: a configured group glob matching several repo containers yields scope.type 'group', and get_shards returns group shards for any member repo but not for a non-member. — check: `bun test src/shards/group.test.ts` → exits 0
- [ ] Incremental mining is watermarked: a re-mine processes only sessions newer than the last run and produces no duplicate candidates for already-seen phrasings. — check: `bun test src/shards/stream.test.ts` → exits 0
- [ ] At least 50% of shards the triage skill proposes are approved by the user. — judgment call: User runs /shards against src/shards/fixtures/golden-set.json and confirms approvals divided by proposals is at least 0.50.

## Scope Boundaries

### In Scope

- Portable candidate record (v1) with content-addressed id and author stamp — The one thing that is genuinely unrecoverable retroactively; a serializer over these rows can be written any time, but a record minted without an author or a stable id cannot be repaired.
- Durable shard store held outside the disposable index cache — index.db is deliberately destroyable - --clear-cache, sessions cleanup, and getDb's corruption self-heal all unlink it - and triage decisions are user judgments no re-mine can reconstruct.
- Backfill mine: FTS narrowing over message_fts for corrective-shaped user turns, byte-exact duplicate collapse, stable JSON batch on stdout — The deterministic half of the pipeline, validated at 0.35s against the live index; the stdout batch is the triage skill's input contract.
- Scope derivation from repo-container spread via resolveRepo (repo versus workflow) — Falls out of clustering at no extra cost and stops workflow facts being re-proposed in every repo; must key on the repo container so sibling worktrees do not read as unrelated cwds.
- /shards triage skill: clusters paraphrases, applies the generalizability rubric, walks approve/reject/snooze — Judgment lives in the agent, not in sessions; this is the only precision mechanism that survived measurement.
- sessions shards approve|reject|snooze write-back CLI — The skill needs a deterministic way to persist triage decisions.
- 30-day snooze with resurface on next re-mine when new phrasings appear — User pulled this into MVP; the resurface trigger is what distinguishes it from a plain dismissal and stops a wrongly-dismissed candidate being lost forever.
- MCP get_shards(cwd) tool, with the call-at-task-start instruction embedded in the tool description — The out-of-band injection path, reaching every MCP-connected tool with no hook and no repo footprint; the description is the same proactive-use channel search_sessions already uses.
- 40-turn golden-set fixture, paraphrased and redacted, hand-labeled from the real index — Turns the precision goal into something measurable and repeatable; must be sanitized because this repo is public and the record design deliberately keeps verbatim prompts off-disk.
- sessions shards export plus import and a pure merge(records[]) function — The transport seam, complete rather than half-built: a serializer with no reader proves nothing, and together they make a future transport a fetch-and-concat instead of a rewrite.
- sessions shards list / inspect CLI — Review the active shard set outside an agent session, and see why a shard is active.
- Author-distinct quorum metric — The signal that makes volume evidential once a second author exists; under the current scope it is a constant of 1, so it waits until records from another author actually arrive.
- Topic-conditional retrieval: get_shards(cwd, topic) matching against the current task — The screenshot's headline mechanic, but a scaling feature - it matters at 200 shards, not at 15.
- Project-group scope (for example ~/Developer/authkit-\*) — A real middle tier between repo and workflow, but it needs a grouping the index does not have.
- Incremental stream mining with candidates surfaced in the weekly-summary skill — Steady state is roughly 4-5 new facts per month; worth having once the backlog is harvested.

### Out of Scope

- Any transport or sync implementation (git refs, private repos, servers, shared drives) — Deferred deliberately. Export and import are the seam; picking a transport before real records exist would fix the wrong shape.
- Team-wide automatic mining via a supervisor agent — Requires reading other people's transcripts - a server, a trust model, and access to private conversations.
- Writing shards into any repository (AGENTS.md, CLAUDE.md, .sessions/, pull requests) — User requires out-of-band. Committing shards exposes tool usage and adds churn to repos the user may not control.
- Command-frequency mining as a shard source — Measured and rejected: of 22 clean mined commands across 10 repos, 21 were package.json script names an agent already reads, and only 1 was non-obvious.
- Any LLM call inside sessions, including an eval harness in CI — sessions is a deterministic indexer compiling to a two-dependency binary; the agent is already an LLM and can hold the judgment.
- Web dashboard, Slack digest, or email triage — sessions is a CLI with a plugin surface; triage rides the skill machinery that already exists.
- Toggle UI and a why-enabled provenance column — In the source design these exist to apologize for weak keyword retrieval; building the apology before the matcher is backwards.
- Extending sessions setup to configure Pi and OpenCode as MCP clients — detectTools configures Claude Code, Cursor, and Codex only; Pi and OpenCode are index sources, not configured clients. Adding them is separate work with its own discovery.

### Future Considerations

- Decentralized team aggregation: per-author exports merged by author-distinct quorum over whatever transport a team already has - a hidden git ref, a private repo, a shared drive - with sessions never running a server
- A shard inspection surface showing why each shard is active, once shard count is high enough that the question is worth asking
- Extending sessions setup to configure Pi and OpenCode as MCP clients so retrieval reaches every tool the index already mines

## Decisions Considered and Rejected

- **Mine corrective-shaped user turns as the shard source** — rejected: Deterministic command-frequency mining as the first tier. Measured against the live index: raw grouping found 1 repeated command out of 1,172 distinct in the target repo; naive normalization surfaced grep/ls/sed; runner-filtered normalization produced clean signal but 21 of 22 hits were package.json script names already visible to any agent.
- **Collapse byte-identical repeats, then cluster paraphrases at triage; only distinct phrasings count toward volume** — rejected: Raw volume counting as borrowed from the source design. An eval fixture prompt appeared 14 times byte-identical in the real corpus and would have been promoted as a top candidate. Author diversity is what makes repetition evidential, and solo there is none - so exact repeats are clipboard noise while paraphrases are genuine repetition.
- **Backfill first: one command mines a repo's full history into a batch for one triage sitting** — rejected: Stream-first incremental mining with a periodic digest. 4,498 unmined sessions of backlog versus an estimated 4-5 new facts per month; the digest would be empty most days while the backlog stayed unharvested.
- **Shards stay out-of-band and are injected at runtime by sessions** — rejected: Promoting approved shards into a managed block in the repo's AGENTS.md via pull request. User requires out-of-band: committing exposes tool usage and puts churn in repos they may not control. The accepted cost is that teammates must run sessions to benefit, which forfeits the zero-adoption property.
- **Retrieval via an MCP get_shards tool, reaching every MCP-connected client** — rejected: Guaranteed injection via the verified Claude Code SessionStart hook. The hook fires before the user's first prompt, so it can never support topic-conditional retrieval. Uniform behavior was preferred over guaranteed delivery in the 90% of sessions that are Claude Code; retrieval becomes model-discretion everywhere. Corrected during critic review: sessions setup configures three MCP clients (Claude Code, Cursor, Codex), not four - Pi and OpenCode are index sources only.
- **The call-at-task-start instruction lives in the get_shards tool description** — rejected: A separate bundled retrieval skill. The skill would have no steps to orchestrate beyond 'call this tool', which is what a tool description is for - the precedent is the proactive-use instruction already embedded in search_sessions. It is also the narrower channel: skills reach fewer clients than MCP, which cuts against the uniformity argument that chose MCP in the first place.
- **Shard records live in a durable store outside the index cache directory** — rejected: A new table inside index.db alongside the session index. Critic finding: index.db is treated as disposable throughout the codebase - --clear-cache unlinks it, sessions cleanup unlinks it, and getDb's corruption self-heal removes it on a schema or integrity mismatch. Approve, reject, and snooze are user judgments no re-mine can reconstruct, so storing them there would silently destroy the feature's entire value.
- **Cluster and derive scope by repo container via resolveRepo, not by raw cwd** — rejected: Grouping candidates by the session's cwd string. Critic finding: resolveRepo spans worktrees including the .bare layout, so three sibling worktrees of one repo are three distinct cwds. Keying on cwd would mislabel repo-local facts as workflow-scoped, and a cwd-based test would pass anyway. Corrected during Phase 1 implementation: `resolveRepo().container` is itself not worktree-spanning - for a normal (non-bare) repo it returns the current worktree's toplevel, so the container is derived from `git rev-parse --git-common-dir` instead and lives in `createContainerResolver()` (`src/shards/mine.ts`). Every later phase resolves cwd to a container through that function, not through `resolveRepo().container`.
- **Two shard scopes, repo and workflow, derived from how far a paraphrase cluster spreads** — rejected: Explicit project groups as a third tier. Derivation is free once clustering exists, whereas project groups need a grouping the index does not have - config, path globs, or a git-remote heuristic.
- **Candidate records carry evidence as counts, session paths, and a date range** — rejected: A fatter record embedding the verbatim source quote for each phrasing. Verbatim quotes are raw prompt text; any future export would carry actual conversations off the machine, which cuts directly against the out-of-band requirement.
- **Export ships with its reader, in the Full tier** — rejected: Export alone in MVP as the transport seam. Critic finding, folded in: the anticipation that is expensive to skip is the record's shape - content-addressed id and author stamp, both in MVP - not the serializer, which is a pure projection over stored rows and can be added any time without loss. A writer with no reader also proves nothing about round-trip fidelity.
- **Precision is verified by hand against the golden set; everything mechanical is unit-tested** — rejected: A scripted LLM eval harness asserting precision in CI. The rubric lives in a skill prompt, so asserting it requires an LLM call - reintroducing the API-key and nondeterminism dependency that sessions deliberately does not have.
- **The generalizability rubric runs agent-side in a skill; sessions narrows and verifies** — rejected: LLM-based extraction inside sessions. sessions is a deterministic indexer that compiles to a standalone two-dependency binary; the agent invoking it is already an LLM.
- **Snooze suppresses until its date and resurfaces on the next manual re-mine when new phrasings have appeared** — rejected: Scheduled resurface driven by continuous stream monitoring. Resolved a contradiction surfaced during the interview: snooze-resurface is in MVP while the stream tier is deferred to Stretch, so the trigger must be a re-mine rather than a scheduler.

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Record, durable store, and backfill mine
  ├── Triage skill, write-back, and snooze  (blocked by Record, durable store, and backfill mine)
  ├── MCP retrieval  (blocked by Record, durable store, and backfill mine)
  ├── Export, import, merge, and quorum  (blocked by Record, durable store, and backfill mine)
  ├── Topic-conditional retrieval and project groups  (blocked by Record, durable store, and backfill mine, MCP retrieval)
  └── Incremental stream mining and digest  (blocked by Record, durable store, and backfill mine, Triage skill, write-back, and snooze)
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs independent phases in parallel, and gates on failure:

```bash
/ideation:autopilot docs/ideation/context-shards/contract.md
```

**Or run it unattended** — a `/goal` is a durability wrapper around the same autopilot run: Claude re-checks the condition before it is allowed to stop, so failures get repaired and re-run. Generated by `contract-gen --print-goal`; this is the only copy of that string:

```
/goal Drive the Context Shards contract (context-shards) to completion with /ideation:autopilot.

1. Run `/ideation:autopilot docs/ideation/context-shards/contract.md`. All commits belong on branch ideation/context-shards — switch to it before any run.
2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.
3. Then run the ideation plugin's `scripts/verify.mjs` against `docs/ideation/context-shards/contract-data.json` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` is a placeholder, not a shell variable, and bash will not expand it. That line is the only evidence this goal is judged on.
4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.

Done when the most recent VERIFY line reads fail=0 and commits=6/6 — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.
```

**Or run phases manually** in dependency order:

**Strategy**: Hybrid

1. **Phase 1** — Record, durable store, and backfill mine _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-1.md
   ```

2. **Phase 2** — Triage skill, write-back, and snooze _(blocked by Record, durable store, and backfill mine)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-2.md
   ```

3. **Phase 3** — MCP retrieval _(blocked by Record, durable store, and backfill mine)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-3.md
   ```

4. **Phase 4** — Export, import, merge, and quorum _(blocked by Record, durable store, and backfill mine)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-4.md
   ```

5. **Phase 5** — Topic-conditional retrieval and project groups _(blocked by Record, durable store, and backfill mine, MCP retrieval)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-5.md
   ```

6. **Phase 6** — Incremental stream mining and digest _(blocked by Record, durable store, and backfill mine, Triage skill, write-back, and snooze)_

   ```bash
   /ideation:execute-spec docs/ideation/context-shards/spec-phase-6.md
   ```

### Agent Team Prompt

```
Three phases unblock together once Phase 1 lands: Phase 2 (triage skill, write-back, snooze), Phase 3 (MCP retrieval), and Phase 4 (export, import, merge, quorum). Assign one teammate each and run them in parallel. Phase 5 depends on Phase 3; Phase 6 depends on Phase 2. Coordinate on shared files - src/shards/store.ts is read by every phase and written only by Phase 1; src/mcp.ts is modified by Phase 3 and again by Phase 5; src/plugin-files.ts is regenerated by both Phase 2 and Phase 6, so only one teammate should run `bun run generate-plugin-embed` at a time and must re-run it after the other's SKILL.md lands. Every phase's tests import cache.ts, so each new test file must follow the hermetic pattern in src/cache.search.test.ts.
```

---

_This contract was generated from brain dump input. Review and approve before proceeding to specification._
