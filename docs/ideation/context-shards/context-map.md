# Context Map: context-shards

**Phase**: 6 (extends the Phase 1 + Phase 2 + Phase 4 + Phase 5 map — all prior sections retained below)
**Gates**: 5/5 ready
**Verdict**: GO

> **Repo state at Phase 6 scouting.** Everything before Phase 6 is now COMMITTED and the working tree is CLEAN (the Phase 5 map's Risk 13 "dirty tree" is resolved): `dd3700f` Phase 1, `56a8633` Phase 3, `2efb062` Phase 4, `42ec4c8` Phase 5, `34d381a` Phase 2 (landed last). `git status --porcelain` shows only two untracked, unrelated items (`context-shards.md`, `docs/ideation/mcp-surface-modernization/`). Baseline is green: `bun test src/shards/` → **231 pass, 0 fail, 15 files, 2.84s** (up from 160 at Phase 5 scouting). `node -p 'Object.keys(require("./package.json").dependencies).length'` → **2**, so the ceiling still holds. Nothing named by Phase 6 exists yet — no `watermark.ts`, no `stream.test.ts`, no `mine_watermark`, no `--since-last`, no `pending`. Two forward references to this phase already sit in the code and are load-bearing context: `src/shards/triage.ts:58-63` ("That is a Phase 6 dependency, not a bug here") and `src/shards/portable.ts:299-301`.

## Gates

### Phase 6 (current)

| Gate                 | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | Both new files are named with concrete signatures, and all 5 modified files were read in full: `src/shards/mine.ts:1-262`, `src/shards/store.ts:1-315`, `src/shards/cli.ts:1-481`, `plugin/skills/weekly-summary/SKILL.md:1-49`, `src/plugin-files.ts` (generated). Five unscoped-but-required edits located: `src/cli.ts:45-59`, `src/shards/cli.ts:29-80` (`help()`), `README.md:104-111` + `:121-124` + `:218`, `plugin/skills/shards/SKILL.md:17`, and the unnamed "read the index inventory" function the spec's `changedSessions(indexed, …)` signature presupposes.  |
| Pattern familiarity  | ready  | Read every pattern the spec cites and the ones it omits: the mtime+size change signal (`src/cache.ts:323-335`, `:466-481`), the one-query inventory optimization and its comment (`src/cache.ts:434-445`), the `sessions` columns (`src/cache.ts:128-131`), the additive-migration seam and its `PRAGMA table_info` guard (`src/shards/store.ts:51-86`), the chunking precedents (`store.ts:252-267` CHUNK=500, `cache.ts:691-694` CHUNK=400), the evidence-merge precedent (`portable.ts:252-259` `unionDates`, `:347-358` `toRecord`), and the weekly-summary step shape. |
| Dependency awareness | ready  | `mine()` has 6 consumers (`cli.ts:286`, `mine.test.ts`, `mine.perf.test.ts`, `dedupe.test.ts`, `scope.test.ts`, `no-repo-writes.test.ts`) — one asserts an exact record count of 960 (`mine.perf.test.ts:64`) and one deliberately skips `closeDatabases()` in `beforeEach` (`:47-51`). `upsertCandidates` behavior is PINNED by `durability.test.ts:152-169` (evidence is overwritten wholesale). `migrate()` is pinned by `durability.test.ts:106-148`. Full lists below.                                                                                                 |
| Edge case coverage   | ready  | Concrete list below including **two traps verified by experiment** (the index does not observe an append inside the 5s refresh window; an `utimesSync` mtime-only touch does propagate) and **four structural traps verified by reading**: a global watermark advance loses other repos' material; merging `distinctPhrasings` before `dropSuppressed` makes resurface structurally impossible; `upsertCandidates` overwrites evidence wholesale; the spec's headline resurface test case is unreachable through the shipped pipeline.                                      |
| Test strategy        | ready  | `bun test src/shards/stream.test.ts` (inner loop), `bun test src/shards/` as regression over the 15 existing files (**231 tests currently green**), then `bun run lint && bun run format:check && bun run typecheck && bun test && bun run build`, plus `bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts` (`contract.md:40`, a shell success criterion). Harness is `src/shards/fixtures.ts:16-38`; the store-touching shape is `durability.test.ts:32-49`. CI (`.github/workflows/ci.yml:24,34,47,57`) runs lint/format/typecheck/build only.    |

### Phase 5 (retained)

| Gate                 | Status | Evidence                                                                                                                                                                                                                                                        |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | All 4 new files named with concrete contents; all 5 modified files read in full; six unscoped-but-required edits identified (`store.ts` write seams, `record.ts:98-111`, `cli.ts:29-66`, `src/cli.ts:45-56`, `README.md`, `SKILL.md` + embed regen).            |
| Pattern familiarity  | ready  | Tokenizer (`cache.ts:152-153,162,175`), stopwords (`wrapped/content.ts:53-74`), JSON-config load (`hooks.ts:53-62`), `globPrefix`/`cwdUnder` (`repo.ts:72-81`), `Bun.Glob` precedent (`scanner.ts:92`), zod `.describe()` (`mcp.ts:320-328`), hermetic harness. |
| Dependency awareness | ready  | `activeShardsFor` had two consumers; `ShardScope['type']` had a non-obvious zod consumer at `portable.ts:124`; `ShardRecord` gaining a required field rippled to five sites.                                                                                    |
| Edge case coverage   | ready  | Four traps verified by experiment (stemmer fails its own test case; `Bun.Glob`'s `*` does not cross `/`; the `user_version` gate skips migrated stores; `durability.test.ts` re-runs `migrate()`).                                                              |
| Test strategy        | ready  | `topic.test.ts` + `group.test.ts` inner loops, `bun test src/shards/` regression, full chain.                                                                                                                                                                   |

### Phase 4 (retained)

| Gate                 | Status | Evidence                                                                                                                                                                           |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | 4 new files + 2 modified read in full; `shards list` confirmed absent; three unscoped edits identified.                                                                            |
| Pattern familiarity  | ready  | `--out` convention (`context.ts:36,44,100-103`), zod precedent, pure-function/date-injection, projection stripping `scope.key`, record construction, store seam, CLI test harness. |
| Dependency awareness | ready  | `types.ts` importers enumerated; `runShards` has two consumers.                                                                                                                    |
| Edge case coverage   | ready  | Four structural traps (exported `scope.key`; wholesale evidence overwrite; no `authors` column; `toPortable` must read the clock).                                                 |
| Test strategy        | ready  | `export.test.ts` + `quorum.test.ts`, plus `bun test src/shards/`.                                                                                                                  |

### Phase 2 (retained)

| Gate                 | Status | Evidence                                                                                                                                                          |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | Every Phase 2 target existed and was read; two unscoped-but-required edits identified.                                                                            |
| Pattern familiarity  | ready  | `recall/SKILL.md:1-52`, `context/SKILL.md:1-27`, `store.ts:212-238`, `significance.ts:1-4,29`, `wrapped/compute.ts:352-353`, `cli.ts:18-151`, `fixtures.ts:1-96`. |
| Dependency awareness | ready  | `mine()` six consumers; `runShards` one; `plugin-files.ts` one; the skill list mirrored twice in `README.md`.                                                     |
| Edge case coverage   | ready  | Two verified traps (`upsertCandidates` clobbers the phrasings baseline; `distinctPhrasings` hardcoded to 1).                                                      |
| Test strategy        | ready  | `snooze.test.ts`, `bun test src/shards/`, plus the two shell criteria.                                                                                            |

### Phase 1 (retained)

| Gate                 | Status | Evidence                                                                                                                                                 |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | All 12 new `src/shards/*` files named; two omitted files identified (`setup.ts:276`, `cli.ts:31-49`).                                                    |
| Pattern familiarity  | ready  | `cache.ts:36-45/94-105/112-125/405-423`, `wrapped/content.ts:25-27`, `repo.ts:32-70`, `index.ts:54-67`, `context.ts:27-49`, `cache.search.test.ts:9-37`. |
| Dependency awareness | ready  | `index.ts` consumers are the build script, `release.yml:51`, `mcp.test.ts:271`; `getDb` is private.                                                      |
| Edge case coverage   | ready  | Three verified traps (FTS5 alias MATCH, porter tokenization, normal-vs-bare worktree divergence).                                                        |
| Test strategy        | ready  | `bun test src/shards/` plus per-file commands; hermetic harness.                                                                                         |

## Key Patterns

### Phase 6

- `src/cache.ts:323-335` — the change signal the watermark must mirror: `existing.mtime === stat.mtimeMs && existing.size === stat.size` → `return false` (unchanged). Note it is used TWICE, once for `sessions` and once for `ignored_files`, and both are `&&` — either half differing means changed. `src/cache.ts:476-477` is the same test in its batched form (`indexedMatches`/`ignoredMatches`), and that is the exact predicate `changedSessions` is a re-implementation of.
- `src/cache.ts:434-445` — the one-query inventory the spec tells you to copy, with the comment naming the mistake it replaced: "The old path issued SELECT mtime,size once per discovered file (~4,500 statements on the author's corpus) even when no transcript had changed." `readWatermark()` is the same shape: one `SELECT`, then `new Map(rows.map((r) => [r.file_path, r]))`.
- `src/cache.ts:128-131` — the `sessions` table columns: `file_path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL`. `REAL` matters: the stored value is `stat.mtimeMs` with sub-millisecond precision (a probe read back `1785329334744.8967`), so the watermark column must be `REAL` too — an `INTEGER` column would silently truncate and make every file look changed forever.
- `src/cache.ts:533-545` — `ensureIndexFresh` + `getIndexDb`. The 5-second refresh throttle (`refreshIntervalMs()`, `SESSIONS_REFRESH_INTERVAL_MS`) is the single most important fact for `stream.test.ts`; see Risk 2. `src/cache.ts:94-104` (`closeDb`) resets `_lastRefreshAt = 0`, which is why the existing shard tests get a fresh scan for free from `closeDatabases()` in `beforeEach`.
- `src/cache.ts:539-541` — "Callers must treat the connection as read-only — all writes stay in this file." This rules out materializing the changed set as a `CREATE TEMP TABLE` on the index handle; chunked `IN (...)` is the only sanctioned shape.
- `src/shards/store.ts:32-86` (`migrate`) — the migration function. `CREATE TABLE IF NOT EXISTS shards` at `:33-49`, then the Phase 5 `PRAGMA table_info` column guard at `:68-71` with a long comment explaining why it sits OUTSIDE the version gate, then the three `CREATE INDEX IF NOT EXISTS` at `:73-75`, then the `user_version` gate at `:77-85`. `mine_watermark` belongs beside the first `CREATE TABLE`; see Risk 10 on the spec's own guard mismatch.
- `src/shards/store.ts:252-267` (`getPersistedStates`) — the chunked-`IN` template, verbatim reusable: `const CHUNK = 500`, slice loop, `chunk.map(() => '?').join(',')`, `.all(...chunk)`, with the comment "SQLite caps host parameters per statement (999 by default)". `src/cache.ts:691-694` is the second precedent at `CHUNK = 400`.
- `src/shards/store.ts:169-202` (`upsertCandidates`) — `BEGIN IMMEDIATE` / `stmt.run` loop / `COMMIT`, `catch` → `ROLLBACK` + rethrow. `advanceWatermark`'s batched `INSERT OR REPLACE` should be this shape exactly. Its ON CONFLICT is `evidence = excluded.evidence, updated_at = excluded.updated_at` — **evidence is overwritten wholesale**, which is Risk 6.
- `src/shards/mine.ts:180-262` (`mine`) — the function `--since-last` narrows. Its shape: `await getIndexDb()` → memoized container resolver → a `conditions[]`/`params[]` pair (`:185-201`) → ONE prepared query (`:203-207`) → `stmt.iterate(...params)` into a `Map<normalizedText, Cluster>` (`:214-228`) → `buildRecord` per cluster (`:246-256`) → sort by id (`:260`). The `conditions`/`params` array shape is exactly where `AND m.file_path IN (...)` slots in; the `iterate` loop is what has to become a per-chunk loop feeding ONE shared cluster map.
- `src/shards/mine.ts:9-11` — "`mine()` is a pure read: it never writes to the store. Persistence is the CLI's job (src/shards/cli.ts) so a test can mine a fixture corpus without touching anything on disk." Phase 6 pressures this invariant from both sides (watermark read, stored-evidence merge). Decide where the orchestration lives and update the comment if it moves; do not let the comment quietly become false.
- `src/shards/mine.ts:151-157` (`deriveScope`) — takes `Map<container, sessionCount>`, `>= 3` containers → `workflow`, else `repo` keyed to the top container with a lexicographic tiebreak. The "union evidence" requirement (spec, Incremental mine) means feeding this a map the fresh slice alone cannot produce; see Risk 5.
- `src/shards/portable.ts:347-358` (`toRecord`) — **the in-repo precedent for merging stored and fresh evidence**: `sessions: local?.evidence.sessions ?? []`, `dates: [local?.firstSeen, local?.lastSeen, shard.firstSeen, shard.lastSeen]`, `distinctPhrasings: Math.max(local ?? 0, shard.totalPhrasings)`, `alwaysOn: local?.alwaysOn ?? false`. Reuse the date/session logic; the `Math.max` on `distinctPhrasings` is exactly what Risk 3 says NOT to do before `dropSuppressed`.
- `src/shards/portable.ts:252-259` (`unionDates`) — `min`/`max` over `'YYYY-MM-DD'` strings with an explicit `''` skip. The right tool for widening `firstSeen`/`lastSeen` across a watermarked union.
- `src/shards/cli.ts:268-310` (`runMine`) — the orchestration Phase 6 extends, and the ordering is load-bearing: `parseMineArgs` → container resolution → `mine()` → `suppressedShards()` **before** `upsertCandidates` (`:287-291`, with the comment explaining why) → `applyPersistedStates(getPersistedStates(...))` → `dropSuppressed` → `writeStdoutFully` → a stderr count line. `advanceWatermark` goes after `upsertCandidates` (`:291`).
- `src/shards/cli.ts:88-126` (`parseMineArgs`) — the while/switch parser `--since-last` is added to: a `case` per flag, `--json` accepted-and-ignored with a comment, `default: throw new UsageError(...)`, and a post-loop mutual-exclusion check (`:124`). `cli.test.ts:66-98` pins six of its behaviors, including `parseMineArgs([])` → exactly `{ all: false, help: false }` — an added `sinceLast: false` default **breaks that `toEqual`**, so either default it to `false` and update the test, or make it optional-when-absent the way `TriageArgs.alwaysOn` is (`cli.ts:131-139`, "Absent rather than false so an untouched parse stays bare").
- `src/shards/cli.ts:455-481` (`runShards`) — the dispatch `pending` joins: `switch (sub)`, every case `return`s (`noFallthroughCasesInSwitch` is on), `default` throws `UsageError`, one `catch` converting only `UsageError` to `die()`.
- `src/shards/cli.ts:29-80` (`help()`) — one shared help for every subcommand, on **stderr**, exit **0**. A `Usage:` block padded to a 33-char column, an `Options:` block padded to a 17-char column, then trailing prose paragraphs (currently four).
- `src/shards/cli.ts:82-86` (`todayIso`) — "The only clock read in the shard pipeline." `mine_watermark.mined_at` is a second clock read; it belongs in the store layer beside the existing `new Date().toISOString()` exceptions (`store.ts:172,275,291,310`), or `advanceWatermark` takes the date as an argument.
- `plugin/skills/weekly-summary/SKILL.md:12-39` — the skill Phase 6 appends to. Steps are numbered with **bold lead-ins**, step 5 ("Write the summary") owns the whole output shape, and `## Guidelines` follows. The new step is number **6**, after the summary is written. Note steps 2/4 call MCP tools (`get_activity_digest`, `get_session_messages`); this step is the first shell-out in this skill (see Risk 9).
- `plugin/skills/shards/SKILL.md:17` — the precedent for a shell-out step that fails loudly: "If the command is not found, say so and stop — do not substitute a search." The weekly-summary step needs the inverse (fail silently), and should say why.
- `src/shards/fixtures.ts:16-38, 44-81` — the harness `stream.test.ts` uses: `makeTmp` (with `realpathSync` for macOS `/var`), `setShardEnv` (six env vars including `SESSIONS_DATA_DIR`), `closeDatabases()` (both handles), `userTurn`, `writeSession` (writes `<claudeDir>/proj/<id>.jsonl`, returns the path — which is what an append test needs).
- `src/shards/durability.test.ts:32-49, 105-148` — the store-migration test template: `beforeAll` makes empty source roots so the index builds with nothing to scan; `beforeEach` re-asserts env + `closeDatabases()` + reseeds; the schema `describe` block drops a column and reopens to prove the migration is real. Extend `:142-148` ("opening an already-migrated store repeatedly is a no-op") rather than writing a new idempotence test.
- `src/shards/mine.perf.test.ts:22-27, 45-51` — the one file that deliberately does NOT `closeDatabases()` in `beforeEach` and sets `SESSIONS_REFRESH_INTERVAL_MS = '600000'`, deleting it in `afterAll` (`:55`). If `stream.test.ts` sets that env var to `'0'`, it must delete it in `afterAll` the same way — the two files share one process and one module instance.

### Phase 5 (retained)

- `src/cache.ts:152-153, 162, 175` — the `porter unicode61` tokenizer the matcher mirrors (the spec's `:167` citation was stale).
- `src/wrapped/content.ts:53-74` — the house `STOPWORDS` shape; deliberately NOT imported into `src/shards/` because it transitively opens the index.
- `src/shards/mine.ts:19-47` — the tunable-constant module header shape (`SCREAMING_SNAKE` + a long why comment).
- `src/shards/triage.ts:1-38` — the module template: header, exported tunable, pure functions with injected dates.
- `src/hooks.ts:53-62` (`loadSettings`) — the JSON-config-load precedent; `loadGroupConfig` diverges by staying silent (MCP stdio).
- `src/paths.ts:19-26` — the lazy, env-overridable data-dir resolver.
- `src/setup.ts:18-30` — uninstall removes only `plugin/` and `.claude-plugin/` inside the data dir, so `shards.db` (and now `mine_watermark` inside it) survives `sessions cleanup`.
- `src/repo.ts:72-81` — `cwdUnder` and `globPrefix` (a SQLite GLOB pattern, not a JS matcher).
- `src/scanner.ts:92,112`, `src/cache.ts:246,262,270` — `new Bun.Glob(pattern)`, the house globbing tool, no new dependency.
- `src/shards/store.ts:229-238`/`:288-314` — `setState`, and the Phase 5 siblings `setAlwaysOn`/`setScope` with the comment on why they are siblings rather than parameters.
- `src/shards/retrieve.ts:34-64` (`activeShardsFor`) — synchronous on purpose; empty-store short circuit; both-directions `cwdUnder`.
- `src/mcp.ts:56-74` — `runGetShards` and the exact projection `{ text, kind, scope: s.scope.type }`, pinned by `mcp-shards.test.ts:229`.
- `src/shards/mcp-shards.test.ts:1-125` — the tmpdir + real-git-repo harness and the adversarial-fixture convention (module constants named for the trap they guard).
- `src/shards/record.ts:105-119` (`buildRecord`) — the single record constructor with the stable-field-order comment.
- `tsconfig.json` — `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `strict`. `.oxfmtrc.json`: single quotes, 120 cols, trailing commas, 2-space tabs, semicolons.

### Phase 4 (retained)

- `src/shards/cli.ts:29-80` (`help()`), `:96-250` (four pure parsers), `:455-481` (`runShards`), `:82-86` (`todayIso`), `:301,401` (`writeStdoutFully` for every machine payload; `src/stdout.ts:14-18` documents the 64KB truncation).
- `src/context.ts:36,44,100-103,183-188` — the `--out` convention.
- `src/shards/portable.ts:1-358` — `toPortable`, `fromPortable` (zod `strictObject` + recomputed id), `merge`/`mergeGroup`/`widenScope`/`unionDates`/`distinctAuthors`, `toRecord`.
- `src/shards/record.ts:25-38` — `normalizeText` and `fingerprint`.
- `src/shards/cli.test.ts:42-64` — the stdout/stderr `capture` helper whose sinks honor the callback argument, which `writeStdoutFully` requires.

### Phase 2 (retained)

- `plugin/skills/recall/SKILL.md:1-14` — frontmatter shape (`description: >-` folded block leading with the capability, then literal trigger phrases in quotes).
- `plugin/skills/context/SKILL.md:18-23` — every other skill drives MCP tools; `/shards` is the only one that shells out to the binary.
- `src/shards/store.ts:212-227` (`getPersistedStates`) — state projection only, no evidence.
- `src/setup.ts:257-263` — the printed skill list, mirrored in `README.md:77-83` and `:211-220`.
- `scripts/generate-plugin-embed.ts:20-35` — walks `plugin/`, emits a sorted `Record<string,string>`, then runs `bunx oxfmt` so regeneration cannot break `format:check`. `src/setup.ts:5,86` is the sole consumer.

### Phase 1 (retained)

- `src/cache.ts:36-45` (lazy env-overridable paths), `:112-125` (PRAGMA order then `user_version`), `:94-105` (`closeDb`), `:194-224` (`removeDbFiles` + the self-heal the shard store must NOT have).
- `src/repo.ts:32-37` (`deriveContainer`) + `:40-70` (`resolveRepo`).
- `index.ts:26, :54-67, :93-96` — positional-word dispatch; the `shards` branch.
- `src/cache.search.test.ts:9-37,173-186` — the original hermetic index harness, generalized into `src/shards/fixtures.ts`.
- `src/repo.test.ts:47-64` — `GIT_ENV` isolation; `:69-72` `realpathSync(mkdtempSync(...))`.

## Dependencies

### Phase 6

- `src/shards/mine.ts` (`mine`) — consumed by → `src/shards/cli.ts:11,286` and five test files: `mine.test.ts:4` (12 call sites), `scope.test.ts:4` (7 call sites, including `mine({repo})` worktree cases), `dedupe.test.ts:3`, `no-repo-writes.test.ts:4,61`, `mine.perf.test.ts:4,62`. Adding an optional `MineOptions` field is additive for all six. **Two are hazardous**: `mine.perf.test.ts:64` asserts an exact `records.length === 960` and `:47-51` deliberately skips `closeDatabases()` (a store handle newly opened from inside `mine()` would attach to whatever env the previous test file left); `no-repo-writes.test.ts:61` calls `mine({})` directly and is the contract's out-of-band criterion (`contract.md:37`).
- `src/shards/mine.ts` (`MineOptions`) — no external implementers; only `mine()` reads it (`mine.ts:49-54,180`). Purely additive.
- `src/shards/store.ts` (`migrate`) — private, called from `getShardsDb()` (`store.ts:96`). Its behavior is pinned by `durability.test.ts:106-116` (a `user_version = 0` reopen must migrate, not drop), `:118-140` (a dropped `always_on` column is re-added on reopen), and `:142-148` (three consecutive reopens are a no-op). A `CREATE TABLE IF NOT EXISTS mine_watermark` passes all three unchanged.
- `src/shards/store.ts` (`upsertCandidates`) — consumed by → `cli.ts:291,448`, `durability.test.ts:28,163,172`, `no-repo-writes.test.ts:63,65`, `snooze.test.ts:178`, `cli.test.ts`. `durability.test.ts:152-169` **asserts that evidence is replaced wholesale** (`stored.evidence.sessions` equals the re-mined pair, `lastSeen` moves to the new date). Any attempt to make the store merge evidence breaks that test; merge upstream instead.
- `src/shards/store.ts` (`listShards`) — consumed by → `retrieve.ts`, `triage.ts:11,131`, `cli.ts:13,390,447`, and six test files. `pending` adds a seventh caller with `{state:'candidate'}`; no signature change needed.
- `src/shards/triage.ts` (`dropSuppressed`, `shouldResurface`, `suppressedShards`) — consumed by → `cli.ts:14,290,299` and `snooze.test.ts:9,87-195`. `snooze.test.ts:158-190` already covers the whole resurface walkthrough at the unit level with hand-built records, which is why the spec's "new phrasing triggers resurface" case would be a duplicate rather than new coverage (Risk 4).
- `src/shards/cli.ts` (`runShards`) — consumed by → `index.ts:93-96` and `cli.test.ts:11,58`. `index.ts` has no try/catch and no `unhandledRejection` handler, so anything but a `UsageError` reaches the user as a raw stack trace.
- `src/shards/cli.ts` (`parseMineArgs`) — consumed by → `cli.ts:269` and `cli.test.ts:9,66-98`. **`cli.test.ts:68` asserts `parseMineArgs([])` `toEqual({ all: false, help: false })` exactly** — a new always-present field breaks it.
- `src/cache.ts` (`getIndexDb`) — consumed by → `mine.ts:14,181` and `wrapped/content.ts:9,268`. A new `src/shards/watermark.ts` that imports it becomes the third; note it is `async` and refreshes first, so any watermark function that reads the index inventory is async too, while `readWatermark()`/`advanceWatermark()` (shards.db) are sync.
- `plugin/skills/weekly-summary/SKILL.md` — consumed by → `scripts/generate-plugin-embed.ts:20-35` → `src/plugin-files.ts` → `src/setup.ts:5,86`; also listed in three manifests (`plugin/.claude-plugin/plugin.json:15`, `.codex-plugin`, `.cursor-plugin`) and described in `README.md:79` and `README.md:218`. `contract.md:40` makes the embed freshness a shell success criterion.
- `mine_watermark` (new table) — lives in **shards.db** (`getShardsDbPath()` → `~/.local/share/sessions/shards.db`), while `mtime`/`size` come from **index.db**'s `sessions` table. The two databases are deliberately separate (`store.ts:1-10`), so `changedSessions` is the only place they meet — which is exactly why the spec made it pure over two inputs. Nothing else will consume the table.

### Phase 5 (retained)

- `src/shards/retrieve.ts:34` (`activeShardsFor`) — consumed by `src/mcp.ts:10,57` and `mcp-shards.test.ts:5` (16 assertions across 11 tests).
- `src/mcp.ts:56` (`runGetShards`) — consumed by the `get_shards` registration and four test call sites.
- `src/shards/types.ts` — consumed by `record.ts`, `mine.ts`, `store.ts`, `triage.ts`, `retrieve.ts`, `portable.ts`, `cli.ts`, plus five test files. `ShardScope['type']` has a runtime consumer typecheck will not flag: `portable.ts:124`'s `z.enum`.
- `src/cli.ts:45-59` — mirrored by `README.md:104-111`, `:121-124`, and `:203`. All four drift together; every phase so far has had to update them.
- `groups.json` — read only by `groups.ts`; lives under `getDataDir()`, which uninstall does not delete.

### Phase 4 (retained)

- `src/shards/types.ts` additions are purely additive; `SHARD_SCHEMA_VERSION` round-trips through `PRAGMA user_version` (`durability.test.ts:106-116`).
- `src/shards/cli.ts:455` (`runShards`) — consumed by `index.ts:93-96` and `cli.test.ts`.
- `zod@4.4.3` — used by `src/mcp.ts:3` and `src/shards/portable.ts:22`.

### Phase 2 (retained)

- `src/shards/mine.ts` (`mine`) — six consumers, one asserting an exact record count of 960.
- `src/setup.ts:257-263` (skill list) — mirrored by `README.md:79-83` and `:211-220`.
- `src/plugin-files.ts` — consumed by `src/setup.ts:5,86` only.
- `src/paths.ts` — consumed by `src/setup.ts:7`, `src/shards/store.ts:14`, `src/shards/durability.test.ts:7`.

### Phase 1 (retained)

- `index.ts` — consumed by `package.json:15`, `.github/workflows/release.yml:51`, `src/mcp.test.ts:271`, `src/wrapped/extras.ts`.
- `src/repo.ts` — consumed by `src/cache.ts:26`, `src/cli.ts:4`, `src/context.ts:2`, `src/shards/mine.ts:15`, `src/shards/retrieve.ts:11`, `src/repo.test.ts:6`.
- `src/setup.ts` — consumed by `index.ts:28-52` and `durability.test.ts:5`.

## Conventions

Phases 1, 2, 4, and 5 conventions all held through the Phase 5 commit. Confirmed against the shipped code, with Phase 6 additions:

- **Naming**: kebab-case filenames, camelCase functions, `SCREAMING_SNAKE` exported tunables (`SNOOZE_DAYS`, `MIN_TEXT_LENGTH`, `TOPIC_THRESHOLD`; a `WATERMARK_CHUNK` fits). Test files are `*.test.ts` beside the source; shared non-test helpers get a plain name (`fixtures.ts`) so `bun test` does not collect them.
- **Imports**: extensionless relative specifiers. `verbatimModuleSyntax` is on — type-only imports **must** use `import type`; mixed form is `import { X, type Y }` (`store.ts:15-22`).
- **Error handling**: `UsageError` from pure parsers, converted to `die()` at the single dispatch boundary (`cli.ts:477-480`); `RangeError` naming the offending value for programmer errors; best-effort work swallows to a value (`record.ts:46-55`, `store.ts:130-138`). Store writes use `BEGIN IMMEDIATE` / `COMMIT` with `ROLLBACK` + rethrow. Human output goes to `process.stderr.write`, never `console.log`.
- **Types**: `interface` for object shapes, `type` for unions; local row `interface`s immediately above their query (`store.ts:114-126`, `mine.ts:159-164`). `noUncheckedIndexedAccess` is on, hence the `!` idiom in tests.
- **Purity + clock discipline**: every function under `src/shards/` takes its date as an argument; `cli.ts:84` holds the only `new Date()` in the pipeline, with `store.ts:172,275,291,310` excepted for `updated_at`. `changedSessions` must be pure over its two inputs (the spec says so, and it is the only way `stream.test.ts` gets a fast unit layer).
- **SQL**: explicit column lists, never `SELECT *` (`store.ts:227-230` says why); `CREATE TABLE/INDEX IF NOT EXISTS`; additive migrations only — `store.ts:26-31` states it outright ("Unlike src/cache.ts:118-125 this never drops a table: a user's rejections are unrecoverable"); host parameters chunked at 400-500.
- **Comments**: long _why_ comments above every non-obvious function, frequently citing a `file:line` elsewhere in the repo and often naming the rejected alternative. This is the strongest local convention in `src/shards/*`. The watermark's `mtime + size` rationale is exactly the kind of thing this repo writes down.
- **Testing**: `bun:test` `describe/test/expect`; env re-asserted in `beforeEach`; `closeDatabases()` before any `rmSync`; test names read as claims, not "should…". Adversarial fixtures are module constants with a comment naming the trap.
- **Formatting**: `oxfmt` (single quotes, 120 cols, trailing commas, 2-space tabs, semicolons) over `.`, including JSON under `src/`. `oxlint` runs with an empty rules object.

## Risks

### Phase 6

1. **A global watermark advance loses other repos' material permanently, and the spec's failure-mode table does not cover it.** `runMine` (`cli.ts:275-283`) defaults to the **current repo** — `mine --since-last` from repo A narrows the SQL to A's containers. If `advanceWatermark` is then called with the whole indexed inventory, every changed session in repos B..Z is marked as seen without ever being examined, and "a missing watermark row means never mined" can never rescue them. Advance **only** the in-scope changed entries — which means computing the in-scope inventory with the same `cwd = ? OR cwd GLOB ?` predicate `mine.ts:196-201` builds, not just the raw `SELECT file_path, mtime, size FROM sessions`. This is the same class as the spec's own "Advance only after candidates are persisted" rule, and strictly more dangerous because it is silent and unrecoverable. Consider making the watermark key `(file_path)` only if you commit to `--all`, or key it per scope.
2. **The index does not observe a transcript append inside the 5-second refresh window — VERIFIED BY EXPERIMENT.** A probe wrote a session, read the inventory, appended a turn, and re-read through `getIndexDb()`: the inventory was byte-identical (`mtime 1785329334744.8967, size 205` both times). After `closeDatabases()` it updated (`mtime …759.0085, size 418`). Cause: `ensureIndexFresh` (`cache.ts:533-537`) returns the cached result while `_db` is open and `Date.now() - _lastRefreshAt < refreshIntervalMs()` (default 5000 ms). Consequence: the spec's central experiment ("append a corrective turn to session 2 → exactly session 2 is changed") **fails for a reason unrelated to the watermark** unless `stream.test.ts` calls `closeDatabases()` between the append and the re-mine, or sets `SESSIONS_REFRESH_INTERVAL_MS = '0'` (and deletes it in `afterAll`, as `mine.perf.test.ts:55` does). Also verified in the same probe: an `utimesSync` mtime-only touch **does** propagate to `sessions.mtime` with `size` unchanged (`1785329394759`, size stayed 418), because `indexedMatches` (`cache.ts:476`) requires both — so the spec's "touch to change mtime only" case is genuinely testable.
3. **Merging `distinctPhrasings` before `dropSuppressed` makes snooze-resurface structurally impossible.** `runMine` order is `suppressedShards()` → `upsertCandidates` → `dropSuppressed(records, suppressed, today)` (`cli.ts:290-299`), and `dropSuppressed` compares the FRESH record's `evidence.distinctPhrasings` against the STORED baseline (`triage.ts:158,70`). If the "merge fresh with stored evidence" step uses `Math.max` the way `toRecord` does (`portable.ts:355`), the fresh count becomes the stored count and `fresh > stored` is false **by construction** — permanently, not just degenerately. Merge `sessions` and dates for scope and evidence, but leave `distinctPhrasings` out of the pre-`dropSuppressed` merge, or pass the pre-merge count. `snooze.test.ts:172-183` is the test that already documents this exact hazard for the upsert ordering.
4. **The spec's headline resurface test case is not reachable through the shipped pipeline.** Testing Requirements list "A genuinely new phrasing bumps `distinctPhrasings` and can trigger resurface", and the Incremental-mine key decision asserts it happens. But a record IS one phrasing — `id = fingerprint(normalizeText(text))` (`record.ts:105-110`) — and `mine.ts:234-237` hardcodes `distinctPhrasings = 1` with the comment that paraphrase clustering is agent-side. `triage.ts:58-63` names Phase 6 as the dependency that fixes this, but this spec provides no clustering write-back path, so nothing in it makes the count grow. **Pick one explicitly and say so in the code and Open Items**: (a) test resurface at the `dropSuppressed` level with hand-built records — but `snooze.test.ts:158-190` already does exactly that, so the new test adds nothing; (b) redefine `distinctPhrasings` as the count of contributing sessions — which contradicts `types.ts:37-43` ("Count of DISTINCT phrasings after byte-exact collapse — never raw occurrences") and the contract's rejected "raw volume counting" (`contract.md:90`), and would break `dedupe.test.ts:42-46`, the contract's second success criterion; (c) declare it out of reach for another phase. Do not ship a test asserting a bump the pipeline cannot produce.
5. **"Scope over the union" needs data neither the record nor the store holds.** `deriveScope` (`mine.ts:151-157`) takes `Map<container, sessionCount>`, but stored evidence holds session **file paths** (`types.ts:44-45`), not containers. Deriving over the union therefore requires a second index query (`SELECT file_path, cwd FROM sessions WHERE file_path IN (...)`, chunked) plus a defined answer for stored paths the index has since pruned (`cache.ts:446-464` deletes rows for vanished transcripts). **A cheaper alternative worth weighing**: two passes over the FTS query — pass 1 restricted to the changed file paths yields the set of normalized texts; pass 2 runs the existing unrestricted query and keeps only clusters whose text is in that set. Evidence, dates, and scope then come out exactly right with no store read and no container backfill, at the cost of one more FTS scan (the whole mine measured 0.35s against the live index, `contract.md:56`, and the perf budget is 5s). Whichever you pick, keep `mine()`'s "pure read: it never writes to the store" header (`mine.ts:9-11`) true or rewrite it deliberately.
6. **`upsertCandidates` overwrites `evidence` wholesale, so an unmerged incremental mine silently truncates a shard's history.** `store.ts:176` is `ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence`, and `durability.test.ts:152-169` pins that behavior on purpose. A record built from one changed session would replace a ten-session evidence list, reset `firstSeen` to today, and shrink what `toPortable` exports and what `quorum` counts. This is the most destructive available failure in this phase and it produces no error. Merge **before** the upsert (`portable.ts:347-358` + `unionDates` at `:252-259` are the precedent); do not relax the ON CONFLICT — `durability.test.ts:167` would fail and the state-preservation reasoning at `store.ts:158-167` depends on that clause staying narrow.
7. **`pending` will almost never be zero, so "silent when empty" will almost never fire — the fatigue failure inverted.** `listShards({state:'candidate'})` returns every untriaged candidate ever mined across every repo, and the backfill is measured at 488 corrective-shaped turns holding 25-35 durable facts (`contract.md:17`). Until the user triages the backlog the weekly summary carries the same non-zero block with the same texts every week, which trains exactly the skim-past behavior the spec's silence rule exists to prevent. The Open Item ("gate on a minimum candidate count") is really about this. Consider counting only candidates whose row was created or updated by this run, or reporting "N new since last week" rather than a running total.
8. **The weekly-summary step's mine call has no repo scope.** The spec's step is `sessions shards mine --since-last --json`, and `runMine` defaults to the current repo (`cli.ts:277`) — printing `not inside a git repository — mining every repo in the index` on stderr only when the cwd is not a repo. So a weekly cross-project summary would report whichever single repo the user happened to be sitting in, while (per Risk 1) possibly advancing a global watermark. `--all --since-last` is almost certainly what the step wants. Decide, and check `--all` + `--since-last` are not mutually exclusive in `parseMineArgs` (`cli.ts:124` only excludes `--all` with `--repo`).
9. **`weekly-summary` becomes the second skill to shell out to the binary, and it must fail differently from the first.** `plugin/skills/context/SKILL.md:18-23` establishes that every other skill drives MCP tools; `/shards` is the documented exception, and its step 1 fails LOUDLY ("If the command is not found, say so and stop"). The weekly-summary step is an optional coda to a summary that has already succeeded, so it must fail **silently** — a missing binary, an empty store, or a non-zero exit must not damage or delay the summary. Say that explicitly in the step, or an agent will copy `/shards`'s loud handling.
10. **The spec contradicts itself on the migration guard.** Implementation step 1 says the table is "guarded by `PRAGMA table_info`", but the Data Model is `CREATE TABLE IF NOT EXISTS mine_watermark`. `table_info` is the guard for adding a **column** to an existing table — that is why `store.ts:68-71` uses it, and the comment there explains exactly why the `user_version` gate could not serve. A whole new table needs no such guard. Put the `CREATE TABLE IF NOT EXISTS` beside the `shards` one (`store.ts:33-49`), before the index statements, and extend `durability.test.ts:142-148` for idempotence rather than adding a parallel test.
11. **A temp table on the index connection is not available, so chunking is mandatory rather than merely advisable.** `getIndexDb` is documented read-only for callers — "all writes stay in this file" (`cache.ts:539-541`) — which rules out `CREATE TEMP TABLE changed(...)` + JOIN, the obvious way to bind an unbounded set. Use the chunked `IN (...)` shape from `store.ts:256-263`. Budget the chunk size against the params the query already binds: `mine.ts:191-201` binds 3 plus 2 per worktree root, so a flat 500 is safe but 999-minus-nothing is not.
12. **CI does not run tests.** `.github/workflows/ci.yml` runs `bun run lint`, `format:check`, `typecheck`, `build` (`:24,34,47,57`) and nothing else. `stream.test.ts` is a local-only gate; green CI is not evidence Phase 6 works.
13. **User-facing surfaces are unscoped again — the same omission every prior phase had to fix.** The spec's Modified Files names none of: `src/cli.ts:45-48` (the `shards mine` entry needs `--since-last`, and there is no `shards pending` row at all), `src/shards/cli.ts:29-80` (`help()` — the `Usage:` block is padded to 33 columns and `Options:` to 17), `README.md:104-111` (sample commands), `README.md:121-124` (the command table), `README.md:218` (the `/weekly-summary` skill row, whose description "Fetches full digest for the past 7 days, writes structured report" becomes incomplete), and `plugin/skills/shards/SKILL.md:17` (which documents the mine invocation). Phases 1, 2, 4, and 5 each updated their equivalents.
14. **Nothing prunes `mine_watermark`, and `--clear-cache` deliberately does not invalidate it.** `runRefreshIndex` deletes `sessions` rows for vanished transcripts (`cache.ts:446-464`), but the watermark lives in a different database that this tool never deletes (`store.ts:1-10`). Orphan rows are harmless — a path absent from the index simply never appears in `changedSessions`'s input — but say so in a comment or the next reader will read it as a leak. The related, counter-intuitive fact deserves a test: after `--clear-cache` the index is rebuilt from the same files with the same `mtime`/`size`, so the watermark still matches and no spurious re-mine happens. That looks wrong at first glance and is right.
15. **"Watermark is not advanced when the upsert throws" has no seam to test through.** `runMine` calls `upsertCandidates(mined)` directly (`cli.ts:291`) with no injection point, and `upsertCandidates` only throws on a real SQLite error (`store.ts:198-201` rolls back and rethrows). Either extract the mine→upsert→advance ordering into a small injectable function `stream.test.ts` can drive with a throwing upsert, or force a real failure (e.g. close the store handle mid-flight) and assert `readWatermark()` is unchanged. Do not assert the ordering by reading the source.

**Decision-log check (Phase 6)**: One contradiction, one stale entry, three confirmed consistent.

- **CONTRADICTED**: `contract.md:90` records "Collapse byte-identical repeats, then cluster paraphrases at triage; only distinct phrasings count toward volume" as chosen, with "raw volume counting as borrowed from the source design" rejected — the reason being that one eval fixture prompt appeared 14 times byte-identical and would have been the top candidate. This spec's Incremental-mine key decision claims an incremental mine "bumps `distinctPhrasings`", but the only mechanical way to make that number grow for a content-addressed record is to count occurrences or contributing sessions, which is the rejected alternative. The rejection's stated reason still holds in full (nothing has refuted it), so this is a genuine conflict rather than a stale premise. See Risk 4; resolve it explicitly rather than by implementation accident.
- **STALE**: `contract.md:102` records "Snooze suppresses until its date and resurfaces on the next **manual** re-mine" as chosen, with "scheduled resurface driven by continuous stream monitoring" rejected — reason: "snooze-resurface is in MVP while the stream tier is deferred to Stretch, so the trigger must be a re-mine rather than a scheduler." This phase IS that stream tier (`contract.md:68` lists it in scope), and it puts `mine --since-last` inside a skill that runs weekly, which is a cadence-driven re-mine. The trigger is still a re-mine and still user-initiated at the skill level, so the entry is stale rather than violated — but a reader will otherwise find the contract forbidding what the code does. Note it in the code comment or update the log.
- **CONSISTENT (with a caveat)**: `contract.md:91` "Backfill first … rejected: stream-first incremental mining with a periodic digest" — this phase adds the stream after the backfill, exactly as the entry's reason permits. The caveat is that the entry's premise, "once the backlog is harvested", is not verifiable from the repo; nothing in this checkout has been triaged, and `pending` will expose that as a permanently non-empty count (Risk 7).
- **CONSISTENT**: `contract.md:26,76,101` (zero LLM dependencies, exactly two runtime dependencies) — verified, `node -p` reports 2 and nothing in Phase 6 needs a library.
- **CONSISTENT**: `contract.md:74,92` (shards stay out-of-band; nothing writes into a repository) — the `mine_watermark` write lands in shards.db under `getDataDir()`, so `no-repo-writes.test.ts` keeps covering it. That test calls `mine({})` directly (`:61`), so extend it to the `--since-last` path if the watermark write ends up inside `mine()`.
- **Coordination note now resolved**: `contract.md:183` warns that `src/plugin-files.ts` "is regenerated by both Phase 2 and Phase 6, so only one teammate should run `bun run generate-plugin-embed` at a time." Phase 2 is committed (`34d381a`) and the tree is clean, so a single regeneration now produces a one-file diff with no coordination hazard.
- **Still unassigned**: `contract.md:64` lists `sessions shards list / inspect` as in scope. `shards pending` is adjacent but is not it (it is candidate-only and capped at 5). After Phase 6 that scope item remains unimplemented and unassigned to any phase.

### Phase 5 (retained, with resolution status)

1. **The stemming rule failed its own test case** — resolved in `src/shards/topic.ts` (shipped `42ec4c8`); see that file's header for which option was taken.
2. **`Bun.Glob`'s `*` does not cross `/`** — resolved in `src/shards/groups.ts`.
3. **The `ALTER` must sit outside the `user_version` gate** — **resolved and now documented at length**: `store.ts:51-71`, with `durability.test.ts:118-140` reconstructing a pre-`always_on` store to prove it.
4. **Widening `ShardScope['type']` breaks the export round trip** — resolved; `types.ts:29-34` and `portable.ts` preserve `key` for `group`.
5. **`setState` cannot express the new writes** — resolved: `setAlwaysOn` (`store.ts:288-295`) and `setScope` (`:306-314`) shipped as siblings, and `always_on` plus both scope columns are excluded from the ON CONFLICT (`store.ts:158-167`).
6. **The failure-mode table misdiagnosed the threshold** — handled in `topic.ts`.
7. **Ordering and projection are pinned by existing tests** — held; `mcp-shards.test.ts` still passes.
8. **`contract.md:183` said store.ts is written only by Phase 1** — stale premise; Phase 5 wrote it, Phase 6 writes it again. All phases are now sequential, so the hazard is gone.
9. **User-facing surfaces unscoped** — recurring; see Risk 13.
10. **`groups.json` has no writer and no discoverability** — still true; documented in `README.md:244` and `cli.ts:65-69`.
11. **`loadGroupConfig` runs on the `get_shards` hot path** — resolved per `groups.ts`.
12. **CI does not run tests** — still true (Risk 12).
13. **Uncommitted Phase 2 work in the tree** — **resolved**: Phase 2 landed as `34d381a` and the tree is clean.

### Phase 4 (retained, with resolution status)

1. `scope.key` exported while claiming no local paths — resolved (`portable.ts:89`).
2. Import destroys local evidence — resolved (`cli.ts:447` reads local rows first; `toRecord` merges).
3. No place to store multiple authors — resolved by documentation.
4. `toPortable` must read the clock — resolved (injected `exportedAt`).
5. `fromPortable` must validate the id — resolved (identity recomputed).
6. zod's default `z.object` strips unknown keys — resolved (`z.strictObject`).
7. A raw `ZodError` escapes as a stack trace — resolved (`PortableFormatError` → `UsageError`).
8. Neither existing parser fits the new subcommands — resolved.
9. **`totalPhrasings` duplicates `quorum` under the shipped mine** — still true; directly relevant to Phase 6 Risk 4.
10. **`shards list` does not exist** — still true; `cli.ts:459-476` handles `mine|approve|reject|snooze|export|import` only.
11. User-facing surfaces unscoped — recurring.
12. Dirty working tree — **resolved**.
13. CI does not run tests — still true.

### Phase 2 (retained)

1. ~~Step 4 breaks a Phase 1 test~~ — resolved (`dropSuppressed`).
2. **`upsertCandidates` clobbers the resurface baseline** — mitigated by snapshotting before the upsert (`cli.ts:287-290`); Phase 6 Risk 3 is the sequel.
3. **The resurface condition cannot fire through the real pipeline** — still true, documented at `triage.ts:58-63`, and explicitly deferred to Phase 6 (Risk 4).
4. ~~`getPersistedStates` cannot feed the resurface predicate~~ — resolved (`suppressedShards`).
5. ~~The checked-in plugin embed is stale~~ — resolved; Phase 6 must regenerate again.
6. `/shards` is the first skill that shells out to the binary — shipped; weekly-summary becomes the second (Risk 9).
7. ~~`setState` no-ops on an unknown id~~ — resolved (`isKnownShard`).
8. ~~Two stale spec references~~ — handled.
9. User-facing surfaces unscoped — recurring.
10. **The precision criterion is unautomatable and gates are local-only** — still true.
11. Golden-set fixture is a publication risk — shipped at `src/shards/fixtures/golden-set.json`.

### Phase 1 (retained)

1-4, 7, 10-11 — resolved. 5. **FTS5 MATCH syntax is narrower than an alias suggests** — still true. 6. **The porter tokenizer defeats two MATCH terms** — partly resolved; `wrong` still does not stem to "wrongly". 8. **`mine.perf.test.ts` is a wall-clock gate** — mitigated but live, and Phase 6 adds work to the mine path. 9. **Shared-module test pollution** — still true and codified in `fixtures.ts:20-38`; every new store-touching test file must `setShardEnv` + `closeDatabases` in `beforeEach` or hit `SQLITE_IOERR_VNODE`.

## Edge Cases for the Builder

### Phase 6

**Watermark (`watermark.ts`)**

- A file absent from the watermark is changed by definition, so the first `--since-last` run equals a full backfill (spec) — assert it, because it is also what makes a fresh install behave sanely.
- A file present in the watermark but absent from the index inventory (transcript deleted, `cache.ts:446-464` pruned it) must simply not appear in the changed set — no throw, no orphan cleanup required.
- `mtime` differs, `size` identical → changed. `size` differs, `mtime` identical → changed (possible when a file is rewritten in place). Both identical → unchanged. Test all four cells, not just the diagonal.
- `mtime` is a float with sub-millisecond precision in the index (`1785329334744.8967` observed) — the watermark column must be `REAL` and the comparison `===`, matching `cache.ts:327`. An `INTEGER` column would truncate and make every file permanently changed.
- `changedSessions` must be pure and total: an empty `indexed`, an empty watermark, and both empty each return `[]` without touching a database.
- Determinism: the returned paths should be sorted, or the chunked `IN (...)` binding order varies run to run and the "mining twice yields byte-identical output" property (`mine.test.ts:130-134`) gets a new way to fail.
- `advanceWatermark([])` is a no-op, mirroring `upsertCandidates`'s empty guard (`store.ts:170`).
- `mined_at TEXT NOT NULL` in the spec's schema has no reader anywhere in the spec. Either give it one, drop it, or note in a comment that it is provenance for a human reading the table with `sqlite3`. Whichever — it is a clock read, so it belongs in the store layer beside `store.ts:172,275,291,310`, or it becomes an argument.

**Incremental mine**

- An empty changed set exits 0 and prints `[]` — the common case at 4-5 facts/month, and it must not read as an error. `cli.test.ts:131-134` is the existing empty-batch assertion to mirror.
- `--since-last` with `--repo` and `--since-last` with `--all` are both meaningful and interact with the watermark scope (Risk 1). `--since-last --repo X` must not advance anything outside X.
- `--since-last` on a store whose `mine_watermark` table was just created (existing user upgrading) → everything changed → a full backfill, which is correct but slow and re-emits the whole batch. Say so on stderr the first time, or the user will think it is broken.
- Chunk boundary: a changed set of exactly `CHUNK`, `CHUNK + 1`, and 0 paths. The `CHUNK + 1` case is the one that catches a loop that drops the remainder, and results from all chunks must land in ONE cluster map (`mine.ts:214`), not one map per chunk — otherwise a phrasing spanning two chunks becomes two records with the same id and the second silently wins at the upsert.
- The clustering re-runs over a narrowed row set, so `deriveScope` sees a narrowed container map (Risk 5) and `buildEvidence` a narrowed session list (Risk 6). Both need the union, and `buildRecord` is the only constructor (`record.ts:105`) — so the union has to be assembled into `BuildRecordInput`, not patched onto the record afterward.
- Ordering is mine → upsert → advance. `suppressedShards()` still has to be read BEFORE the upsert (`cli.ts:287-290`), so the full order is snapshot → mine → merge → upsert → advance → project → emit.
- A rediscovered phrasing on a `rejected` shard stays `rejected`: guaranteed by the ON CONFLICT exclusion (`store.ts:176`) and pinned by `durability.test.ts:152-169`. The new test should assert it end-to-end through `--since-last` rather than re-asserting the store.
- Two consecutive `--since-last` runs in the SAME test must be separated by a `closeDatabases()` or `SESSIONS_REFRESH_INTERVAL_MS = '0'` (Risk 2), or the second run reads a stale inventory and passes/fails for the wrong reason.
- `mine.perf.test.ts` deliberately skips `closeDatabases()` in `beforeEach` (`:47-51`) and asserts `records.length === 960`. If `mine()` starts opening the shard store, that file's store handle attaches to whatever `SESSIONS_DATA_DIR` the previous test file left — check the perf test still passes, and consider whether the watermark work belongs in `cli.ts` instead.

**`shards pending`**

- Zero candidates → `{"count":0,"preview":[]}` (or equivalent) on stdout with exit 0, never an error and never the human sentence — the skill parses it.
- More than 5 candidates → `count` is the true total, `preview` is capped at 5. Assert the count is NOT the preview length; that off-by-design is the whole point.
- Preview ordering must be deterministic — `listShards` already returns `ORDER BY id` (`store.ts:230`), so take the first 5 and say in a comment that id order is arbitrary-but-stable, not recency.
- `pending` never mines and never writes: no `getIndexDb()` call at all, so it stays fast enough for a weekly skill. That is a testable claim (it should work with `SESSIONS_CLAUDE_DIR` pointing at nothing).
- `pending --json` and bare `pending` — decide whether the human form goes to stderr like every other human output (`cli.ts:24-27,304-309`) or whether `--json` is accepted-and-ignored the way `mine --json` is (`cli.ts:115-118`). Match one of the two existing precedents rather than inventing a third.
- `pending -h` must print the shared `help()` and exit 0, like every other subcommand.

**Store migration**

- `CREATE TABLE IF NOT EXISTS` is idempotent by construction; three consecutive `closeDatabases()` + `getShardsDb()` cycles must be a no-op (`durability.test.ts:142-148` is the test to extend).
- A `PRAGMA user_version = 0` reopen (`durability.test.ts:106-116`) runs `migrate()` against a live table that already has `mine_watermark`. Verify no `table already exists`.
- The watermark table must NOT be dropped by any path: `--clear-cache`, `removeInstalledFiles()`, and the index corruption self-heal all leave the data dir's `shards.db` alone (`durability.test.ts:51-102`). Adding a case to that describe block is nearly free and makes the guarantee explicit.

**`weekly-summary` skill**

- Zero pending → no section at all, not an empty heading, not "no new shards". The spec is explicit; make the step say it twice, because an LLM will want to be helpful.
- The step must not fail the summary: missing binary, non-zero exit, unparseable stdout, or a store that does not exist yet all degrade to silence.
- Cap at three candidate texts in the digest even though `pending` returns five — the two numbers differ on purpose and a reader will assume it is a bug otherwise.
- Never triage from this skill; the only call to action is "run `/shards`".
- After editing the SKILL.md, `bun run generate-plugin-embed` is mandatory (`contract.md:40` is a shell criterion, and `src/plugin-files.ts:1-2` says "Do not edit manually"). The tree is clean, so the diff should touch exactly that one file.

**Test harness**

- `stream.test.ts` needs the full store harness: `makeTmp` + `setShardEnv` in `beforeAll`, re-assert + `closeDatabases()` in `beforeEach`, `closeDatabases()` before `rmSync` in `afterAll` (`durability.test.ts:32-49` is the template).
- `writeSession` returns the file path (`fixtures.ts:74-81`) — that is the handle an append test needs. Appending means `appendFileSync(path, '\n' + JSON.stringify({...userTurn(...), cwd}))`; the fixture writes lines joined by `\n` with no trailing newline, so the leading `\n` is required.
- For an mtime-only change use `utimesSync(path, atime, new Date(mtimeMs + 60_000))` with an explicit offset — verified to work and immune to filesystem timestamp granularity, unlike "write the same bytes again".
- If `stream.test.ts` sets `SESSIONS_REFRESH_INTERVAL_MS`, delete it in `afterAll` (`mine.perf.test.ts:55`); the whole `bun test` run shares one process and one module instance.
- Keep a pure `describe('changedSessions')` block that touches no database — it is the fastest feedback in the phase and the one layer that can exhaust the four-cell mtime/size matrix cheaply.

### Phase 5 (retained)

- `matchTopic(text, '')` → 1; an all-stopword topic must also be 1, never `NaN`; `matchTopic('', topic)` → 0.
- Stem symmetrically; guard a minimum stem length; dedupe both sides into `Set`s.
- Always-on shards return at score 0 and sort first, but never bypass state or scope.
- `always_on` excluded from `upsertCandidates`'s ON CONFLICT, or the next mine clears it.
- Missing/empty/malformed `groups.json` each need a defined degradation; a `try/catch` around `JSON.parse` catches none of the wrong-shape cases.
- `~` expansion via `homedir()`; a glob must match subdirectories of a member; sibling paths sharing a prefix are the boundary case.
- No-topic retrieval must be byte-identical to Phase 3; the projection may not gain a field.
- `rowToRecord` converts `always_on` with `=== 1`, never a truthy cast.

### Phase 4 (retained)

- Empty store → `toPortable([])` emits `{v, exportedAt, shards: []}`.
- The privacy filter is `state === 'approved'` exactly, never `!== 'rejected'`.
- Assert key absence recursively; byte-identical determinism via an explicit id comparator.
- Import: nonexistent path, unreadable path, empty file, non-JSON bytes, array-not-envelope, `v` mismatch, duplicate ids, id/text mismatch — each a non-stack-trace failure.
- An id already `rejected` locally stays `rejected`; an id already present must not lose its `evidence.sessions`.

### Phase 2 (retained)

- `snoozeUntil`: UTC-safe arithmetic; boundaries `2026-01-01→2026-01-31`, `2026-01-31→2026-03-02`, `2026-12-15→2027-01-14`; malformed input throws a named `RangeError`.
- `today >= snoozedUntil` compares lexicographically; equality counts as expired.
- `approve` on a `rejected` id succeeds; an unknown id must not report success.
- `runShards`'s switch has `noFallthroughCasesInSwitch`; every case returns.
- Golden set: top-level array, exactly 40 entries, no verbatim text.

### Phase 1 (retained)

- `msg_index = -1` sentinel rows must never produce a record.
- `resolveRepo` returns `null` for non-git cwds → fall back to the raw cwd; `git` may be absent.
- Memoize `cwd → container` per run; macOS `/var` → `/private/var` needs `realpathSync` in fixtures.
- `closeShardsDb()` before any test `rmSync`.

## Verification Commands

```bash
bun test src/shards/stream.test.ts                  # inner loop (watermark + incremental mine)
bun test src/shards/durability.test.ts              # the migration gate (extend, do not replace)
bun test src/shards/snooze.test.ts                  # resurface must not regress (Risk 3)
bun test src/shards/mine.perf.test.ts               # the 5s wall-clock gate the mine path now shares
bun test src/shards/                                # 16 shard test files (231 tests green pre-Phase-6)
bun run lint && bun run format:check && bun run typecheck
bun test && bun run build
bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts   # required: SKILL.md changes
node -p 'Object.keys(require("./package.json").dependencies).length'        # must stay 2
bun run index.ts shards --help                      # the extended help text
bun run index.ts shards mine --since-last --json | jq 'length'              # run twice; the second must be 0
bun run index.ts shards pending --json              # count + capped preview
```
