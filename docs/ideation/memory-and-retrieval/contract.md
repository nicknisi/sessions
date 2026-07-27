# Memory Hygiene & Measured Retrieval Contract

**Created**: 2026-07-25
**Readiness**: All 5 gates ready
**Status**: Approved
**Approval**: Express — single consolidated confirmation, no per-artifact review
**Supersedes**: None

## Problem Statement

sessions recently stopped being 100% re-derivable. Until now every byte it held could be rebuilt from transcripts, which is what let --clear-cache, cleanup, and a SCHEMA_VERSION bump all be safe destructive operations. The new lesson store at ~/.local/share/sessions/memory.db breaks that invariant, and the operational discipline a durable store requires never followed it in.

Nothing prevents a test from opening the real memory.db or index. Hermeticity depends on every test remembering SESSIONS_MEMORY_DB and SESSIONS_CACHE_DIR — 11 of 41 test files hand-roll those overrides across 42 occurrences, there is no bunfig.toml preload to make it the default, and the discipline was already broken once by accident during a latency measurement in the session that built the store. Several tests also spawn index.ts as a child, where in-process detection would not apply.

The one non-re-derivable artifact has no backup beyond a manual export. Separately, refresh state is module-level, so each of the 7 concurrent MCP servers observed on this machine walks the transcript tree independently, while a persistent failure re-runs the full scan on every call because _lastRefreshAt is set only on success (src/cache.ts:528).

The memory store holds exactly one lesson, written by hand to test it. The write path only fires when an agent chooses to call remember_lesson mid-session; nothing seeds it from the thousands of sessions already indexed, so the realistic failure is an empty table rather than a junk drawer.

The retrieval eval cannot do its job. At 21 documents it is insensitive to two of the four ranking changes it was built to protect — reverting short-message damping or USER_HIT_BOOST passes clean, with only unit tests catching them. That makes further scorer work unmeasurable, including the known flaw where finalRank sums raw BM25 across two FTS tables with different corpus statistics (src/cache.ts:779).

## Goals

1. Running the full test suite leaves the real lesson store and search index untouched, whether or not individual tests set the environment overrides.
2. A persistent refresh failure stops re-running the full discoverFiles and stat pass on every subsequent call.
3. N concurrent sessions processes perform one transcript-tree walk between them rather than N independent walks.
4. Every write to the lesson store also produces a copy that restores the store without sessions installed.
5. sessions distill turns indexed history into lesson proposals that appear in sessions lessons review, bounded by an explicit selection, never writing an active row.
6. The eval corpus becomes sensitive enough that each of four named ranking mutants — bm25 column weights, USER_HIT_BOOST, short-message damping, the finalRank sum — is killed by it.
7. Distilled titles and finalRank normalization each land only with a measured per-class recall delta recorded in the committed baseline, or do not land.
8. sessions search and sessions context become consumable by a shell script or a statusline without speaking MCP or opening the SQLite file.

## Success Criteria

- [ ] The test-context guard refuses the real memory.db and index, including from a spawned child process — check: `bun test src/hermetic.test.ts` → exits 0
- [ ] The entire suite passes AND leaves the real artifacts byte-identical — lesson store, search index, and the index's WAL sidecars, which is where a write lands without the main file changing — check: `h() { for f in "$HOME/.local/share/sessions/memory.db" "$HOME/.cache/sessions/index.db"*; do [ -e "$f" ] && shasum -a 256 "$f"; done | shasum -a 256; }; before=$(h); bun test >/dev/null 2>&1; rc=$?; after=$(h); test $rc -eq 0 && test "$before" = "$after"` → exits 0 — hashes not mtimes, and the glob covers index.db-wal and index.db-shm because cache.ts:115 opens the index in WAL mode
- [ ] A repeatedly failing refresh backs off instead of re-scanning the tree on every call, and two concurrent processes sharing a cache dir perform one tree walk between them — check: `bun test src/cache.refresh.test.ts` → exits 0
- [ ] Every lesson write produces a plaintext export and a SQLite-consistent snapshot; deleting memory.db and restoring the snapshot recovers every row including supersedes chains and review groups; a snapshot failure does not fail the write that triggered it; and when two processes write concurrently the surviving snapshot contains the LATEST committed rows, not merely a valid database — an older snapshot must not be able to rename over a newer one — check: `bun test src/memory.export.test.ts` → exits 0
- [ ] distill emits at least one proposal, every proposal is visible to sessions lessons review, zero rows land active, and a no-argument run selects no more than the documented default limit — check: `bun test src/distill.test.ts` → exits 0
- [ ] distill's production argv is side-effect-free: claude is invoked with tool use disabled, codex with --sandbox read-only, and any CLI without a verified restriction flag is not offered at all. Asserted against the argv distill actually builds, not a mock — check: `bun test src/distill.sandbox.test.ts` → exits 0
- [ ] distill with no agent CLI on PATH fails open — exits 0, creates no store, and says on stderr which CLIs it looked for — check: `d=$(mktemp -d); SESSIONS_MEMORY_DB="$d/m.db" PATH=/usr/bin:/bin "$(command -v bun)" run index.ts distill --limit 1 2>"$d/err"; rc=$?; test $rc -eq 0 && test ! -e "$d/m.db" && grep -qi 'not found on PATH' "$d/err"` → exits 0 — non-zero exit, a created store, or a silent skip all fail
- [ ] The eval corpus kills all four named ranking mutants — bm25 column weights, USER_HIT_BOOST, short-message damping, and the finalRank sum — and the harness fails if it applied fewer than four — check: `bun test src/eval/mutation.test.ts` → exits 0, reporting 4/4 mutants applied and killed
- [ ] The committed eval baseline is reproducible from a clean run, so a recall change cannot land without showing up in the diff — check: `bun run eval > /tmp/eval-now.md && diff -q /tmp/eval-now.md docs/eval-baseline.md` → exits 0
- [ ] No query class regresses — the RECALL_FLOOR ratchet holds after every retrieval change — check: `bun test src/eval/eval.test.ts` → exits 0
- [ ] Neither retrieval feature ships neutral: if distilled titles or finalRank normalization is present in the tree, docs/retrieval-evidence.md records its measured before/after and at least one RECALL_FLOOR entry was raised. A change that improves nothing does not land — check: `if grep -rqE 'distilledTitle|normalizeFinalRank' src/cache.ts src/record.ts; then test -f docs/retrieval-evidence.md && git diff --quiet main -- src/eval/eval.test.ts && exit 1 || exit 0; else exit 0; fi` → exits 0 — present-but-unmeasured fails; absent passes; measured-and-ratcheted passes
- [ ] sessions search --json emits envelope version 1 with a non-empty results array over the fixture corpus, and the search process itself exits 0 — check: `set -o pipefail; SESSIONS_CACHE_DIR=$(mktemp -d) SESSIONS_CLAUDE_DIR=src/eval/__fixtures__/claude bun run index.ts search --json stripe | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.exit(j.generator==="sessions" && j.version===1 && Array.isArray(j.results) && j.results.length>0 ? 0 : 1)'` → exits 0 — pipefail means a non-zero exit from search fails the check too
- [ ] search --json uses grep-style exit codes — matches exit 0, no matches exit 1, a bad flag exits 2 — so a script can branch on the difference — check: `d=$(mktemp -d); f=src/eval/__fixtures__/claude; env SESSIONS_CACHE_DIR="$d" SESSIONS_CLAUDE_DIR="$f" bun run index.ts search --json stripe >/dev/null; a=$?; env SESSIONS_CACHE_DIR="$d" SESSIONS_CLAUDE_DIR="$f" bun run index.ts search --json zzq-no-such-term >/dev/null; b=$?; env SESSIONS_CACHE_DIR="$d" SESSIONS_CLAUDE_DIR="$f" bun run index.ts search --json --bogus-flag x >/dev/null 2>&1; e=$?; test $a -eq 0 && test $b -eq 1 && test $e -eq 2` → exits 0 — assignments passed to env directly so it works under zsh, which does not word-split unquoted parameters
- [ ] sessions context --json emits envelope version 1, and --no-refresh demonstrably skips the scan — against an empty cache dir it builds no index at all — check: `set -o pipefail; d=$(mktemp -d); SESSIONS_CACHE_DIR="$d" bun run index.ts context --json --no-refresh | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.exit(j.generator==="sessions" && j.version===1 ? 0 : 1)' && test ! -e "$d/index.db"` → exits 0 — an index.db appearing proves the scan ran despite --no-refresh
- [ ] The first real distill batch produces lessons worth keeping — judgment call: Nick reviews one real sessions distill run over at least 8 proposals and accepts at least half. Fewer than 8 proposals is not a passing batch — it is an inconclusive one, and the run must be widened before judging. Below half, the selection or the prompt is wrong and Memory usefulness is not done. This is a blocking gate in the phase track, not an advisory note: mechanical verification passing means the plumbing works, not that the project is finished

## Scope Boundaries

### In Scope

- Test hermeticity by default — bunfig.toml [test] preload pointing the stores at a per-run temp dir, plus a runtime refusal for the spawned-child case — The store is no longer re-derivable, 11 of 41 test files hand-roll overrides across 42 occurrences, and the discipline already failed once by accident
- Refresh failure backoff — A persistent failure currently re-runs the full discoverFiles and stat pass on every call
- Auto-export plus a SQLite-consistent snapshot of the store on write — The one non-re-derivable artifact has no backup story. A plain file copy of a live SQLite DB is not a valid backup under concurrent writers, so the snapshot uses VACUUM INTO to a temp path then an atomic rename. Atomic rename alone still allows a slow older snapshot to land after a newer one, so the rename is taken under a cross-process lock with a generation check. A failed snapshot must be logged and swallowed, never failing the write that triggered it
- Cross-process refresh marker — 7 concurrent MCP servers were each observed walking the tree; a throughput fix on the re-derivable index, not a durability one, so it is not MVP
- sessions distill — bounded ranked selection surfaced in sessions lessons review — The lesson table holds one row; nothing seeds it from indexed history
- A side-effect-free invocation contract for the agent CLI distill spawns — roast.ts:25 runs `claude -p`, `codex exec`, `pi -p` unsandboxed with full tool access, and roast.ts:45 documents that the seam is only safe because it feeds STATS ONLY, never transcript prose. Distill inverts that premise — transcripts carry arbitrary text an agent once read — so it must restrict the subprocess or it is a prompt-injection path with write access
- Grow the eval corpus until it kills all four named mutants — At 21 documents it cannot detect two of the four changes it already protects
- sessions search --json and sessions context --json with a versioned envelope — Two named consumers: shell/jq scripting and a statusline segment

### Out of Scope

- Any network, daemon, HTTP, or socket surface — 65ms measured subprocess latency makes it unnecessary, and this repo already shipped a fix for an orphaned MCP server busy-looping at 100% CPU
- An LLM anywhere in the read path — reranker, query expansion, search-time distillation — The zero-config offline contract holds; distill is opt-in, batch, write-path only, and fails open without an agent CLI
- --json for digest — No named consumer; lessons already has a JSON path via sessions lessons export, so only digest genuinely lacks one
- Cross-machine lesson sync — The export file is the substrate for it, but syncing is a separate project and wants an existing file-sync mechanism, not new code

### Future Considerations

- Deterministic distilled title and entity columns — deferred with the Full tier; only worth shipping if the grown corpus shows it moves recall
- finalRank normalization across the two FTS tables — the known flaw at src/cache.ts:779, now safe to attempt whenever wanted because this project makes the eval able to judge it
- Pinned lessons — a no-op until a scope holds more than LESSON_HOOK_LIMIT=3 active lessons; revisit once distill has filled the store
- Cross-machine lesson sync built on the export, using git or an existing file-sync tool rather than a server
- --json for digest once a consumer asks
- A library entry point, if sessions is ever published to npm — the named record makes it nearly free

## Decisions Considered and Rejected

- **sessions distill always proposes and never writes an active row** — rejected: Auto-saving like remember_lesson does, subject to the same near-dup quarantine. A bad model pass costs one review pass instead of silently polluting the primer, and it makes the phase testable — assert zero rows land active
- **Proposals get an explicit surfacing mechanism rather than reusing bare needs_review** — rejected: Writing proposals as plain needs_review rows. Critic blocker: reviewGroups() only returns rows with a non-NULL review_group (memory.ts:823), so group-less proposals would be invisible to sessions lessons review while still inflating the primer's flagged count (memory.ts:415) — reviewable in name only
- **distill reads a bounded ranked selection (--query/--limit/--days), defaulting small** — rejected: All history, or a watermark that distills everything newer than the last run. 4,400 indexed sessions times one agent-CLI call each is hours and a lot of tokens; the first watermark run is still unbounded and invites a cron that quietly burns tokens
- **Distill success is measured mechanically; quality is a judgment criterion with an explicit bar** — rejected: Asserting it finds known lessons in the committed eval fixtures. Those fixtures are synthetic transcripts, so the test would measure whether it can mine fake sessions
- **Test hermeticity comes from a bunfig.toml [test] preload, with a runtime refusal only for spawned children** — rejected: A test-awareness branch inside src/memory.ts and src/cache.ts. Critic finding: paths.ts already resolves lazily from env on every call, so a preload makes hermeticity the default for all 41 test files with zero shipped production code; the runtime guard is kept only where a preload cannot reach
- **Back up by auto-exporting plaintext and copying the store file on write** — rejected: A rotating memory.db snapshot on a launchd timer, and an import/restore command. A timer adds an unattended job to a tool that has none. Three critics flagged that the original 'export restores a deleted store' criterion had no importer behind it and would have required reconstructing content_hash uniqueness and supersedes chains — copying the DB file makes restore a cp, and the plaintext export stays the human-readable artifact
- **The corpus is done when four named mutants are killed, enforced as src/eval/mutation.test.ts** — rejected: Growing to a target document and query count; a standalone scripts/eval-mutation.ts. A count is a proxy — 100 documents with weak distractors are less sensitive than 40 with sharp ones. 'Any tuned constant' was unbounded (at least ten exist), so the set is enumerated. A test rather than a script so CI enforces it
- **Phase 3 hoists the tuned ranking constants to overridable module scope and claims src/cache.ts** — rejected: Treating corpus growth as touching only the eval tree. Critic blocker: all four constants are function-local inside searchSessions (cache.ts:666, :707, :713-714), so no mutation harness can revert them individually without hoisting — and that collides with phase 4's edits to the same file
- **Pinned lessons moved to future** — rejected: Shipping pinning in this project. Critic finding: LESSON_HOOK_LIMIT=3 against a store holding one active row makes pinning a no-op — and distill writes only proposals, so it adds no active rows either. It cannot change observable behavior until the store is full
- **Retrieval quality becomes a real track, with corpus growth as its prerequisite** — rejected: Keeping distilled titles as a measure-first phase on the existing 21-document corpus. The current corpus cannot detect two of the four changes it already protects, so measure-first on it is ceremony — and normalizing finalRank against an insensitive eval is a coin flip
- **--json covers search and context only, behind a versioned envelope** — rejected: Adding --json to all four read commands at once. Only search and context have named consumers; lessons already emits JSON via lessons export, leaving digest as the sole genuine gap and no one asking for it
- **Acceptance commands run against temp stores and the fixture corpus, never the real ones** — rejected: The first draft's commands, which ran distill and search against the operator's live store and 4,400-session index. Critic blocker: the fails-open check would have exited 127 forever (bun is not in /usr/bin or /bin) and, worse, would have run against the real memory.db — an acceptance check that can pollute the very artifact this project exists to protect
- **The distill acceptance judgment is a blocking gate phase, not just a criterion** — rejected: Leaving it as criterion 13 alone. Review finding: the verifier's completion line reports judgment counts without their outcome, so a batch Nick rejects outright could still produce a green 'contract finished'. Making it a gate in the phase track means the project cannot read as done on mechanical checks alone
- **Phase 5 declares a prereq on phase 1, and the strategy is described as sequential** — rejected: Placing the JSON surface in wave 1 as independent work. Review finding: phase 5 decides whether to keep --no-refresh based on phase 1's measured outcome — a real dependency that file-collision serialization neither expresses nor guarantees. Separately, four of five phases claim src/cache.ts, so the earlier 'three in parallel' framing was false
- **Backup takes a SQLite-consistent snapshot via VACUUM INTO plus atomic rename, and must not fail the write that triggered it** — rejected: A plain copyFileSync of memory.db beside the export. Review finding: a file copy of a live SQLite database is not a valid backup under concurrent writers, and the original criterion only demonstrated a single-process happy path. The test now covers a snapshot taken mid-write by a second process, and a snapshot failure not breaking the lesson write
- **No network, daemon, or HTTP surface of any kind** — rejected: A localhost daemon or socket to amortize process startup. Measured 65ms warm end-to-end makes a subprocess fine for every local consumer, SQLite already handles concurrent readers, and a daemon reintroduces the orphan-process failure this repo already fixed once

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Durability hygiene
  ├── Memory usefulness  (blocked by Durability hygiene)
        └── Gate — accept the first distill batch  (blocked by Memory usefulness)
  └── JSON surface  (blocked by Durability hygiene)
Grow the eval corpus
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs independent phases in parallel, and gates on failure:

```bash
/ideation:autopilot docs/ideation/memory-and-retrieval/contract.md
```

**Or run it unattended** — a `/goal` is a durability wrapper around the same autopilot run: Claude re-checks the condition before it is allowed to stop, so failures get repaired and re-run. Generated by `contract-gen --print-goal`; this is the only copy of that string:

```
/goal Drive the Memory Hygiene & Measured Retrieval contract (memory-and-retrieval) to completion with /ideation:autopilot.

1. Run `/ideation:autopilot docs/ideation/memory-and-retrieval/contract.md`. All commits belong on branch ideation/memory-and-retrieval — switch to it before any run.
2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.
3. Then run the ideation plugin's `scripts/verify.mjs` against `docs/ideation/memory-and-retrieval/contract-data.json` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` is a placeholder, not a shell variable, and bash will not expand it. That line is the only evidence this goal is judged on.
4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.

Done when the most recent VERIFY line reads fail=0 and commits=4/4 — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.
```

**Or run phases manually** in dependency order:

**Strategy**: Four build phases plus one human gate, at the Full tier — Retrieval quality was Stretch and is deferred to Future, so nothing in this run rewrites the scorer. Nearly sequential: three of the four build phases claim src/cache.ts (hygiene edits the refresh path, corpus growth hoists the ranking constants out of searchSessions, the JSON surface adds the refresh bypass), so file-overlap serialization collapses any wave holding two of them. Real dependencies: Durability hygiene gates both Memory usefulness and JSON surface. The only genuine concurrency is Memory usefulness — the one phase that does not touch src/cache.ts — running alongside whichever cache-claiming phase holds the lock. Expect roughly serial execution with one overlap.

1. **Phase 1** — Durability hygiene _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/memory-and-retrieval/spec-phase-1.md
   ```

2. **Phase 2** — Memory usefulness _(blocked by Durability hygiene)_

   ```bash
   /ideation:execute-spec docs/ideation/memory-and-retrieval/spec-phase-2.md
   ```

3. **Phase 3** — Grow the eval corpus

   ```bash
   /ideation:execute-spec docs/ideation/memory-and-retrieval/spec-phase-3.md
   ```

4. **Phase 4** — JSON surface _(blocked by Durability hygiene)_

   ```bash
   /ideation:execute-spec docs/ideation/memory-and-retrieval/spec-phase-4.md
   ```

5. **Phase 5** — Gate — accept the first distill batch _(blocking)_

   ```bash
   # Review: Gate — accept the first distill batch
   ```

### Agent Team Prompt

```
Two phases genuinely parallelize once Durability hygiene lands: Memory usefulness (phase 2) and Grow the eval corpus (phase 3). Phase 2 is the only build phase that does not claim src/cache.ts, which is what makes the overlap possible at all.

Coordinate on shared files — only one teammate may hold a shared file at a time:
  · src/cache.ts — claimed by Durability hygiene, Grow the eval corpus, AND JSON surface. Three-way collision; these three never run together.
  · src/memory.ts — Durability hygiene and Memory usefulness.
  · src/cli.ts, index.ts, src/context.ts — Memory usefulness and JSON surface.

Order that respects both the graph and the collisions: Durability hygiene alone → Memory usefulness ‖ Grow the eval corpus → JSON surface alone → the human gate. Do not attempt a wider fan-out; the file claims make any other pairing serialize anyway, and a wave label saying otherwise is reporting an upper bound, not a promise.
```

---

_This contract was generated from brain dump input. Review and approve before proceeding to specification._
