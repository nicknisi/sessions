# Context Map: context-shards

**Phase**: 5 (extends the Phase 1 + Phase 2 + Phase 4 map — all prior sections retained below)
**Gates**: 5/5 ready
**Verdict**: GO

> **Repo state at Phase 5 scouting.** Phase 4 is now COMMITTED (`2efb062`, "export, import, merge, and quorum" — `src/shards/portable.ts`, `quorum.ts`, `export.test.ts`, `quorum.test.ts`, plus `src/shards/cli.ts`, `src/cli.ts`, `README.md`). Phases 1 and 3 are committed (`dd3700f`, `56a8633`). **Phase 2 is still uncommitted** — `git status` shows staged-but-uncommitted `A plugin/skills/shards/SKILL.md`, `A src/shards/triage.ts`, `A src/shards/snooze.test.ts`, `A src/shards/fixtures/golden-set.json`, `M src/setup.ts`, `M src/plugin-files.ts`. Phase 5 edits `plugin/skills/shards/SKILL.md` and regenerates `src/plugin-files.ts` on top of that staged work — **never `git stash`, never `git checkout --`, never `git restore`**, or Phase 2 is lost. Baseline is green: `bun test src/shards/` → **160 pass, 0 fail, 13 files, 2.42s**. Nothing named by Phase 5 exists yet (`rg alwaysOn|always_on|matchTopic|groups.json src/shards/` returns nothing but the Phase 3 forward-reference comment at `retrieve.ts:7-9`).

## Gates

### Phase 5 (current)

| Gate                 | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | All 4 new files are named with concrete contents, and all 5 modified files were read in full: `src/shards/types.ts:1-89`, `src/shards/store.ts:1-238`, `src/shards/retrieve.ts:1-64`, `src/mcp.ts:1-346`, `src/shards/cli.ts:1-401`. Six unscoped-but-required edits identified and located: `src/shards/store.ts` write seams (`setState` cannot set `always_on` or `scope`), `src/shards/record.ts:98-111` (`buildRecord` must default `alwaysOn`), `src/shards/cli.ts:29-66` (`help()`), `src/cli.ts:45-56`, `README.md:104-122` + `:201`, and `plugin/skills/shards/SKILL.md:26,28-33,41` + `src/plugin-files.ts` regen.                   |
| Pattern familiarity  | ready  | Read every pattern the spec cites plus the ones it misses: the tokenizer (`src/cache.ts:152-153,162,175` — the spec's `:167` is stale by 5 lines), the existing stopword list (`src/wrapped/content.ts:53-74`), the JSON-config-load precedent (`src/hooks.ts:53-62`), `globPrefix`/`cwdUnder` (`src/repo.ts:72-81`), the already-in-repo `Bun.Glob` precedent (`src/scanner.ts:92,112`, `src/cache.ts:246,262,270` — no new dependency needed), the zod `.describe()` shape (`src/mcp.ts:70-72,320-328`), the additive-migration seam (`src/shards/store.ts:32-60`), and the hermetic store harness (`src/shards/mcp-shards.test.ts:71-125`). |
| Dependency awareness | ready  | `activeShardsFor` has exactly two consumers: `src/mcp.ts:10,57` and `src/shards/mcp-shards.test.ts:5` — signature widening is additive. `ShardScope['type']` has a **non-obvious** consumer that typecheck will not flag: `portable.ts:124`'s zod `z.enum(['repo','workflow'])`. `ShardRecord` gaining a required field ripples to `record.ts:100-110`, `store.ts:103-123,132-164,187-193`, `portable.ts:324-334`. `src/mcp.test.ts` contains **no** shard references, so it is not in the blast radius. Full lists below.                                                                                                                     |
| Edge case coverage   | ready  | Concrete list below including **four traps verified by experiment**: the spec's own stemming rule provably fails its own required test case; `Bun.Glob`'s `*` does not cross `/`, so the spec's subdirectory experiment fails a naive `groupsFor`; placing the `ALTER` inside the existing `if (current < SHARD_SCHEMA_VERSION)` gate silently skips every already-migrated store; and `durability.test.ts:106-116` re-runs `migrate()` against a live table, so the `PRAGMA table_info` guard is load-bearing for an EXISTING test.                                                                                                           |
| Test strategy        | ready  | `bun test src/shards/topic.test.ts` and `bun test src/shards/group.test.ts` (inner loops), `bun test src/shards/` as regression over the 13 existing files (**160 tests currently green**, `mcp-shards.test.ts` being the must-pass-unchanged Phase 3 gate), then `bun run lint && bun run format:check && bun run typecheck && bun test && bun run build`. Harness is `src/shards/fixtures.ts:16-38`; store-touching shape is `mcp-shards.test.ts:71-125`. CI (`.github/workflows/ci.yml:24,34,47,57`) runs lint/format:check/typecheck/build only — `bun test` is local-only.                                                                |

### Phase 4 (retained)

| Gate                 | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | All 4 new files and both modified files exist-or-are-named with concrete changes, and both were read in full: `src/shards/cli.ts:1-239` and `src/shards/types.ts:1-51`. `shards list` does **not** exist, so the spec's conditional quorum-in-`list` step resolves to "library-only". Three unscoped-but-required edits identified: `src/cli.ts:45-51`, `README.md:104-107` + `:117-118`, and `cli.ts`'s own `help()`. |
| Pattern familiarity  | ready  | Read every relevant pattern: the `--out` convention (`src/context.ts:36,44,100-103,183-188`), the zod precedent (`src/mcp.ts:3`), the pure-function/date-injection convention (`triage.ts:1-38`), the projection precedent that strips `scope.key` (`src/mcp.ts:63`), record construction (`record.ts:98-111`), the store seam (`store.ts:132-164`), and the CLI test harness (`cli.test.ts:33-55`).                   |
| Dependency awareness | ready  | `src/shards/types.ts` is imported by `record.ts:14`, `mine.ts:17`, `triage.ts:12`, `store.ts:15-22`, `retrieve.ts:14`, `cli.ts:12`, `mcp-shards.test.ts:8` — additions are purely additive. `runShards` has two consumers (`index.ts:93-96`, `cli.test.ts:49`).                                                                                                                                                        |
| Edge case coverage   | ready  | Four verified structural traps: `scope.key` is an absolute local path exported while claiming "no local paths"; `upsertCandidates` overwrites `evidence` wholesale; `ShardRecord` has no `authors` column; `toPortable(records)` as specified must read the clock.                                                                                                                                                     |
| Test strategy        | ready  | `bun test src/shards/export.test.ts` and `bun test src/shards/quorum.test.ts`, plus `bun test src/shards/` as regression.                                                                                                                                                                                                                                                                                              |

### Phase 2 (retained)

| Gate                 | Status | Evidence                                                                                                                                                                                                                                                                          |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | Phase 1 shipped (`dd3700f`), so every Phase 2 target exists and was read: 4 new files, `src/shards/cli.ts`, the resurface filter, `src/setup.ts:257-263`, `src/plugin-files.ts` regen; two unscoped-but-required edits identified.                                                |
| Pattern familiarity  | ready  | Read `plugin/skills/recall/SKILL.md:1-52`, `context/SKILL.md:1-27`, `src/shards/store.ts:212-238`, `src/significance.ts:1-4,29`, `src/wrapped/compute.ts:352-353`, `src/shards/cli.ts:18-151`, `cli.test.ts:34-55`, `fixtures.ts:1-96`, `scripts/generate-plugin-embed.ts:20-35`. |
| Dependency awareness | ready  | `mine()` has six consumers; `runShards` has one; `src/plugin-files.ts` has one; the setup skill list is mirrored twice in `README.md`.                                                                                                                                            |
| Edge case coverage   | ready  | Two verified structural traps: `upsertCandidates` clobbers the phrasings baseline, and `distinctPhrasings` is hardcoded to 1.                                                                                                                                                     |
| Test strategy        | ready  | `bun test src/shards/snooze.test.ts`, `bun test src/shards/`, plus the two shell criteria.                                                                                                                                                                                        |

### Phase 1 (retained)

| Gate                 | Status | Evidence                                                                                                                                                                                  |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | ready  | All 12 new `src/shards/*` files are named with concrete contents; two files the spec omits are identified (`src/setup.ts:276`, `src/cli.ts:31-49`).                                       |
| Pattern familiarity  | ready  | Read `src/cache.ts:36-45/94-105/112-125/405-423/820-925`, `src/wrapped/content.ts:25-27`, `src/repo.ts:32-70`, `index.ts:54-67`, `src/context.ts:27-49`, `src/cache.search.test.ts:9-37`. |
| Dependency awareness | ready  | `index.ts` consumers are the build script, `.github/workflows/release.yml:51`, and `src/mcp.test.ts:271`; `getDb` is private.                                                             |
| Edge case coverage   | ready  | Three verified-by-experiment traps (FTS5 alias MATCH, porter tokenization of `dont`/`wrong`, normal-vs-bare worktree divergence).                                                         |
| Test strategy        | ready  | `bun test src/shards/` plus per-file commands; hermetic harness from `src/cache.search.test.ts:9-37,173-186`.                                                                             |

## Key Patterns

### Phase 5

- `src/cache.ts:152-153, 162, 175` — the tokenizer the spec's matcher is supposed to mirror: `tokenize = 'porter unicode61'`, with the comment "adds stemming on top of the default unicode tokenizer so e.g. 'refactoring' matches an indexed 'refactor'". **The spec cites `src/cache.ts:167`, which is stale** — 167 is a comment about `msg_index`. The two real declarations are `session_fts` (`:162`) and `message_fts` (`:175`).
- `src/wrapped/content.ts:53-74` — an existing, large `STOPWORDS` set built from a space-joined string, with the comment "Common English + generic dev terms". This is the house shape for a stopword list. **Do not import it into `src/shards/`**: `wrapped/content.ts` transitively pulls the index open, and `topic.ts` must stay a pure module a test can import with no store harness (same constraint `quorum.ts` was built under, Phase 4 Edge Cases). Copy a short list into `topic.ts` and say why in a comment. Note it already contains `add`, `use`, `check`, `start`, `file`, `code`, `test` — words that appear in plausible topic strings, so the list's aggressiveness directly moves the score denominator.
- `src/shards/mine.ts:19-47` — the shape a tunable-constant module header takes: an exported `SCREAMING_SNAKE` band with a long comment explaining what tuning it does, plus `CORRECTIVE_TERMS` documenting the two tokenizer facts it had to work around. `TOPIC_THRESHOLD` should be commented at this density.
- `src/shards/triage.ts:1-38` — the module template for `topic.ts` and `groups.ts`: a header stating what the module is and is not, an exported tunable, then pure functions with injected dates. `:20-38` is the throw-with-a-named-value style.
- `src/hooks.ts:53-62` (`loadSettings`) — **the JSON-config-load precedent for `loadGroupConfig`**: `if (!existsSync(path)) return {}` for the missing case, `try { JSON.parse(readFileSync(path,'utf-8')) } catch { …; return null }` for the unparseable case, with a stderr line. `loadGroupConfig` must diverge on one point — the spec requires "never throws" and degradation to `{groups:{}}`, and it runs inside `get_shards`, so it must **not** write to stderr (stdout/stderr are the MCP stdio transport; `src/mcp.ts:338-346` connects `StdioServerTransport`). Silence on failure is the correct call here and the comment should say why.
- `src/paths.ts:19-26` — the lazy, env-overridable data-dir resolver (`process.env.SESSIONS_DATA_DIR || …`), read per call and never frozen at import. `groups.json` must resolve through `getDataDir()` for the same reason `getShardsDbPath()` does: the hermetic tests rewrite the env after the module is already imported.
- `src/setup.ts:18-30` (`ownedInstallPaths`) — uninstall removes exactly `plugin/` and `.claude-plugin/` inside the data dir, **not the directory itself**, precisely so `shards.db` survives `sessions cleanup`. `groups.json` inherits that protection for free; do not add it to the owned list.
- `src/repo.ts:72-81` — `cwdUnder(cwd, root)` (`cwd === root || cwd.startsWith(root + '/')`) and `globPrefix(root)` (escapes `*?[`, appends `/*`). **`globPrefix` produces a SQLite GLOB pattern, not a JS matcher** — the spec's "use `globPrefix`-style matching" means "escape-and-prefix semantics", not a literal reuse. `groupsFor` runs in TypeScript.
- `src/scanner.ts:92,112` and `src/cache.ts:246,262,270` — `new Bun.Glob(pattern)` is already the house globbing tool and adds no dependency (the two-dependency ceiling is contract criterion `contract.md:39`). Verified semantics: `new Bun.Glob('/tmp/x/authkit-*').match('/tmp/x/authkit-nextjs') === true`, but `.match('/tmp/x/authkit-session/packages/core') === false` — `*` does not cross `/`. See Risk 2.
- `src/shards/store.ts:32-60` (`migrate`) — the migration seam, with the comment already reserving the spot: "Future bumps add their ALTER TABLE steps here, guarded on `current`." Read the gate carefully: the `if` is `current < SHARD_SCHEMA_VERSION`, and an existing user's store is already at `user_version = 1`. See Risk 3.
- `src/shards/store.ts:132-164` (`upsertCandidates`) — `ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence, updated_at = excluded.updated_at`, with the comment explaining that `state` and `snoozed_until` are excluded on purpose. `always_on` belongs in exactly the same exclusion list, for exactly the same reason.
- `src/shards/store.ts:229-238` (`setState`) — the only write seam for a triage decision, a bare `UPDATE … WHERE id = ?`. It takes `(id, state, snoozedUntil)` and cannot express `always_on` or a scope change; Phase 5 needs one or two sibling functions here.
- `src/shards/retrieve.ts:34-64` (`activeShardsFor`) — the function Phase 5 rewrites. Its current shape: `listShards({state:'approved'})` → early `return []` → one memoized `createContainerResolver()(cwd)` → a two-bucket partition (`workflow`, `repo`) → `return [...workflow, ...repo]`. Three invariants in its comments are load-bearing: the empty-`scope.key` skip (`:51-54`), the both-directions `cwdUnder` test (`:55-59`), and "Synchronous on purpose" (`:22-23`) — `loadGroupConfig` must therefore be sync (`readFileSync`, not `node:fs/promises`).
- `src/mcp.ts:56-74` — the `runGetShards` seam and its tool registration. Note the exact projection at `:63`: `{ text, kind, scope: s.scope.type }`. `mcp-shards.test.ts:229` asserts `Object.keys(entry).sort() === ['kind','scope','text']`, so the projection may **not** gain a `score` or `alwaysOn` field without breaking a Phase 3 test the spec requires to pass unchanged.
- `src/mcp.ts:320-328` — the `get_context_primer` argument block: the closest formatting precedent for adding an optional `topic` (`z.string().optional().describe(…)`), including a multi-line `.describe()` built by string concatenation (`:83-85`, `:92-94`).
- `src/shards/mcp-shards.test.ts:1-125` — **the template for `group.test.ts`**, and the file Phase 5 must not break. It builds a real git repo + linked worktree in a tmpdir (`:71-93`), re-asserts `setShardEnv` + `closeDatabases()` + `DELETE FROM shards` + reseed in `beforeEach` (`:95-120`), and `closeDatabases()` before `rmSync` in `afterAll`. Its header comment (`:14-16`) explains why shard assertions live here and not in `src/mcp.test.ts`: that file's `setEnv()` deliberately omits `SESSIONS_DATA_DIR`, so a `get_shards` call from there would open the developer's real `~/.local/share/sessions/shards.db`. **The same rule binds `topic.test.ts` and `group.test.ts`.**
- `src/shards/mcp-shards.test.ts:11-26` — the adversarial-fixture convention: module constants with a comment naming the trap each one guards (`REPO_META` with a GLOB metacharacter, `EMPTY_KEY`). Copy this for a group glob containing a metacharacter and for a non-member sibling (`/tmp/x/authkit` vs `/tmp/x/authkit-nextjs`).
- `src/shards/record.ts:98-111` (`buildRecord`) — the single record constructor, with the "stable field order" comment. Every test file in `src/shards/` builds records through it, so `alwaysOn` must be added here with a `?? false` default or nine test files stop compiling.
- `src/shards/portable.ts:76-99, 119-131` — the export projection and its zod schema. `:89` blanks `scope.key`; `:124` is `z.enum(['repo','workflow'])`. Both are direct blast radius for adding `'group'`. See Risk 4.
- `plugin/skills/shards/SKILL.md:26` (the triage question), `:28-33` (the persist commands), `:41` ("Scope is shown, not edited. Overriding a derived scope is inspection-surface work and does not exist yet.") — line 41 is a statement Phase 5 makes false, and steps 4-5 are where `--always-on` and `--scope group:<name>` have to surface.
- `tsconfig.json` — `verbatimModuleSyntax` (type-only imports must say `import type`), `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `strict`, `resolveJsonModule`. `.oxfmtrc.json`: single quotes, 120 cols, trailing commas, 2-space tabs, semicolons.

### Phase 4 (retained)

- `src/shards/cli.ts:29-66` (`help()`) — one shared help for every subcommand, printed to **stderr**, exit **0**. A `Usage:` block padded to a 33-char column, an `Options:` block padded to a 17-char column, then trailing prose paragraphs.
- `src/shards/cli.ts:82-112` / `:129-139` / `:155-176` / `:186-195` — four parsers now: `parseMineArgs` (while/switch over flags, throws on any positional), `parseTriageArgs` (for-loop, rejects anything starting with `-`, one positional), `parseExportArgs` (while/switch, `--out` with a value check), `parseImportArgs` (one positional, "expected exactly one bundle path"). All pure, all return `{…, help: boolean}`, none exit.
- `src/shards/cli.ts:375-401` (`runShards`) — `sub = argv[0]`; bare/`-h`/`--help` → `help()`; a `try`/`switch` where every case `return`s, `default` throws `UsageError`, and the single `catch` converts **only** `UsageError` to `die()`.
- `src/shards/cli.ts:68-72` (`todayIso`) — "The only clock read in the shard pipeline — every function under src/shards/ takes the date as an argument so tests stay hermetic."
- `src/shards/cli.ts:246, 321` — `await writeStdoutFully(…)` for every machine payload; `src/stdout.ts:14-18` documents the 64KB truncation a bare write would cause.
- `src/context.ts:36,44,100-103,183-188` — the `--out` convention: a `Usage:` example, an `Options:` line, a `case '--out'` with a value check, and `writeFile` + a `wrote <path>` line on **stderr**.
- `src/shards/portable.ts:1-334` — the Phase 4 module: `toPortable` (three documented filters), `fromPortable` (zod `strictObject` + recomputed id), `merge`/`mergeGroup`/`widenScope`/`unionDates`/`distinctAuthors`, and `toRecord` (which takes the local row so import is not an evidence wipe).
- `src/shards/record.ts:25-38` — `normalizeText` (whitespace collapse + trim, casing preserved) and `fingerprint` (`sha256:` over the lowercased normalized text).
- `src/shards/snooze.test.ts:1-60` / `src/shards/cli.test.ts:41-63` — the store-touching test template and the stdout/stderr `capture` helper (sinks that honor the callback argument, which `writeStdoutFully` requires).

### Phase 2 (retained)

- `plugin/skills/recall/SKILL.md:1-14` — frontmatter shape: `name`, `description: >-` folded block leading with the capability then literal trigger phrases in quotes, then optional `argument-hint`. Body: one sentence of purpose, `## Steps` numbered with **bold lead-ins**, then `## Guidelines`.
- `plugin/skills/context/SKILL.md:18-23` — every other skill drives MCP tools; `/shards` is the only one that shells out to the `sessions` binary.
- `src/shards/store.ts:212-227` (`getPersistedStates`) — returns `{state, snoozedUntil}` only, no evidence.
- `src/significance.ts:1-4,29` and `src/wrapped/compute.ts:352-353` — the injection precedent and the UTC date idiom.
- `src/setup.ts:257-263` — the printed skill list, mirrored in `README.md:77-81` and `:197-208`.
- `scripts/generate-plugin-embed.ts:20-35` — walks `plugin/`, emits a sorted `Record<string,string>`, then runs `bunx oxfmt` so regeneration cannot break `format:check`. `src/setup.ts:83-95` is the sole consumer.

### Phase 1 (retained)

- `src/cache.ts:36-45` — lazy env-overridable path resolution, never frozen at import.
- `src/cache.ts:112-125` — `openDb` PRAGMA order (`busy_timeout`, `journal_mode=WAL`, `synchronous=NORMAL`) then the `user_version` check.
- `src/cache.ts:94-105` — `closeDb()`: swallow, null the singleton, idempotent, never throws.
- `src/cache.ts:194-224` — `removeDbFiles()` + the corruption self-heal the shard store must NOT have.
- `src/repo.ts:32-37` (`deriveContainer`) + `:40-70` (`resolveRepo`).
- `index.ts:26, :54-67, :93-96` — positional-word dispatch; the `shards` branch.
- `src/cache.search.test.ts:9-37,173-186` — the original hermetic index harness, generalized into `src/shards/fixtures.ts`.
- `src/repo.test.ts:47-64` — `GIT_ENV` isolation (`GIT_CONFIG_GLOBAL: '/dev/null'`); `:69-72` `realpathSync(mkdtempSync(...))` for macOS `/var` → `/private/var`.

## Dependencies

### Phase 5

- `src/shards/retrieve.ts:34` (`activeShardsFor`) — consumed by → `src/mcp.ts:10,57` and `src/shards/mcp-shards.test.ts:5` (**16 assertions across 11 tests**, `:131-245`). Adding an optional second parameter is additive and breaks neither. `src/mcp.test.ts` has **no** shard reference (verified by `rg get_shards src/mcp.test.ts` → empty), so it is not in the blast radius.
- `src/mcp.ts:56` (`runGetShards`) — consumed by → the `get_shards` registration (`:73`) and `mcp-shards.test.ts:216,221,233-234,241`. Widening its argument object to `{cwd?, topic?}` is additive; four existing call sites pass `{cwd}` or `{}`.
- `src/shards/types.ts` — consumed by → `record.ts:7-14`, `mine.ts:17`, `store.ts:15-22`, `triage.ts:12`, `retrieve.ts:14`, `portable.ts:25-32`, `cli.ts:15`, plus `store.test.ts:6`, `durability.test.ts:10`, `mcp-shards.test.ts:8`, `export.test.ts`. **`ShardScope['type']` has one consumer typecheck will NOT flag**: `portable.ts:124`'s `z.enum(['repo','workflow'])`. Widening the TS union does not widen the runtime schema, and assigning the narrower zod-inferred type to `PortableShard[]` (`portable.ts:158,167`) still compiles. See Risk 4.
- `ShardRecord` gaining a required `alwaysOn: boolean` — ripples to `record.ts:98-111` (`buildRecord`, the single constructor every test uses), `store.ts:103-123` (`rowToRecord`), `store.ts:136-157` (`upsertCandidates` INSERT column list + params), `store.ts:187-193` (`listShards` SELECT list), and `portable.ts:324-334` (`toRecord`, which builds through `buildRecord`). Typecheck catches all of these except the SELECT list, which fails at runtime with `undefined`.
- `src/shards/store.ts` — read by `cli.ts:13`, `triage.ts:11`, `retrieve.ts:13`, `portable.ts` (indirectly via `types`), and six test files (`store.test.ts`, `durability.test.ts:8`, `no-repo-writes.test.ts:6`, `cli.test.ts:14`, `snooze.test.ts`, `mcp-shards.test.ts:6`, `export.test.ts`). `contract.md:183` says store.ts is "written only by Phase 1" — Phase 5's spec overrides that (see Risk 8).
- `src/shards/triage.ts:74-76` (`approve`) — consumed by → `cli.ts:14,275` and `snooze.test.ts`. Threading `--always-on` means either `approve(id, alwaysOn)` (one call site, one test file) or a separate `setAlwaysOn` write.
- `src/shards/cli.ts:129-139` (`parseTriageArgs`) — consumed by → `cli.ts:266` and `cli.test.ts:9,157-180`. `cli.test.ts:167-169` asserts `parseTriageArgs(['--all'])` throws `unknown option: --all`; adding `--always-on` and `--scope` as recognized flags keeps that assertion true, but the "flags are rejected — unlike mine, these subcommands take none" test **name and comment become false** and should be updated with the code.
- `src/cli.ts:45-56` (top-level `Commands:` block) — mirrored by → `README.md:104-109` (sample commands), `README.md:119-122` (the command table), and `README.md:201` (the `get_shards` MCP-tool row, which now needs the topic clause). All four drift together; Phases 1, 2, and 4 each updated them.
- `plugin/skills/shards/SKILL.md` — consumed by → `scripts/generate-plugin-embed.ts:20-35` → `src/plugin-files.ts` → `src/setup.ts:5,86`. `contract.md:40` is a shell success criterion: `test -f plugin/skills/shards/SKILL.md && bun run generate-plugin-embed && git diff --exit-code src/plugin-files.ts`. Editing the skill without regenerating fails it; `src/plugin-files.ts` is already `M` in the working tree from Phase 2.
- New `src/shards/topic.ts` and `src/shards/groups.ts` — no consumers until `retrieve.ts` imports them. **`topic.ts` must import nothing that transitively opens a database** (not `store.ts`, `triage.ts`, `retrieve.ts`, `mine.ts`, or `wrapped/content.ts`), so `topic.test.ts` needs no store harness — the same constraint `quorum.ts` shipped under.
- `groups.json` — read only by `groups.ts`; lives under `getDataDir()` (`src/paths.ts:19-21`), which `src/setup.ts:18-30` deliberately does not delete on uninstall.

### Phase 4 (retained)

- `src/shards/types.ts` — additions are purely additive; do not change `ShardRecord` or `SHARD_SCHEMA_VERSION` (`durability.test.ts:106-116` asserts the version round-trips through `PRAGMA user_version`).
- `src/shards/cli.ts:375` (`runShards`) — consumed by → `index.ts:93-96` and `cli.test.ts:57`. `index.ts` has no try/catch and no `unhandledRejection` handler.
- `src/shards/retrieve.ts:34` — the downstream blast radius of `import`: imported records land as `candidate`, and `activeShardsFor` filters to `approved` (`retrieve.ts:37`).
- `zod@4.4.3` — used by `src/mcp.ts:3` and `src/shards/portable.ts:22`.

### Phase 2 (retained)

- `src/shards/mine.ts` (`mine`) — six consumers, one of which (`mine.perf.test.ts:62`) asserts an exact record count of 960.
- `src/shards/cli.ts` (`applyPersistedStates`, `parseMineArgs`) — consumed by `cli.test.ts` only.
- `src/setup.ts:257-263` (skill list) — mirrored by `README.md:77-81` and `:197-208`.
- `src/plugin-files.ts` — consumed by `src/setup.ts:5,86` only.
- `src/paths.ts` — consumed by `src/setup.ts:7`, `src/shards/store.ts:14`, `src/shards/durability.test.ts:7`.

### Phase 1 (retained)

- `index.ts` — consumed by `package.json:15`, `.github/workflows/release.yml:51`, `src/mcp.test.ts:271`, `src/wrapped/extras.ts`.
- `src/repo.ts` — consumed by `src/cache.ts:26`, `src/cli.ts:4`, `src/context.ts:2`, `src/shards/mine.ts:15`, `src/shards/retrieve.ts:11`, `src/repo.test.ts:6`.
- `src/setup.ts` (`runSetup`, `runUninstall`, `removeInstalledFiles`) — consumed by `index.ts:28-52` and `durability.test.ts:5`.

## Conventions

Phase 1's, Phase 2's, and Phase 4's conventions all held through the Phase 4 commit. Additions confirmed against the shipped code:

- **Naming**: kebab-case filenames, camelCase functions, `SCREAMING_SNAKE` exported tunables (`SNOOZE_DAYS`, `MIN_TEXT_LENGTH`, `CORRECTIVE_TERMS` → `TOPIC_THRESHOLD` fits). Test files are `*.test.ts` beside the source; shared non-test helpers get a plain name (`fixtures.ts`) so `bun test` does not collect them.
- **Imports**: extensionless relative specifiers (`'./store'`, `'../repo'`). `verbatimModuleSyntax` is on — type-only imports **must** use `import type`, mixed form is `import { X, type Y }` (`store.ts:15-22`).
- **Error handling**: `UsageError` thrown from pure parsers and runners, converted to `die()` at the single dispatch boundary (`cli.ts:397-400`); `PortableFormatError` for a bad wire payload (`portable.ts:51`); `RangeError` naming the offending value for programmer errors (`triage.ts:35`, `portable.ts:80`); best-effort work swallows to a value (`record.ts:46-55`, `store.ts:104-111`, `hooks.ts:57-61`). Human output goes to `process.stderr.write`, never `console.log`. **Inside the MCP server path, neither stream is available** — `loadGroupConfig` must fail silently to `{groups:{}}`.
- **Types**: `interface` for object shapes, `type` for unions; local row `interface`s immediately above their query. `noUncheckedIndexedAccess` is on, hence the `!` idiom in tests.
- **Purity + clock discipline**: every function under `src/shards/` takes its date as an argument; `cli.ts:70` holds the only `new Date()` in the pipeline (`store.ts:135,235` excepted, for `updated_at`). `matchTopic`, `groupsFor`, and `merge` must all be pure; `loadGroupConfig` is the one I/O function and should be the only impure thing in `groups.ts`.
- **Comments**: long _why_ comments above every non-obvious function, frequently citing a `file:line` elsewhere in the repo and often naming the rejected alternative. This is the strongest local convention in `src/shards/*`; the spec explicitly requires it for `matchTopic` ("SWAPPABLE SEAM").
- **Migrations**: additive only. `store.ts:26-31` states it outright — "Unlike src/cache.ts:118-125 this never drops a table: a user's rejections are unrecoverable."
- **Testing**: `bun:test` `describe/test/expect`; env re-asserted in `beforeEach`; `closeDatabases()` before any `rmSync`; test names read as claims, not "should…". Adversarial fixtures are module constants with a comment naming the trap.
- **Formatting**: `oxfmt` (single quotes, 120 cols, trailing commas, 2-space tabs, semicolons) over `.`, including JSON under `src/`. `oxlint` runs with an empty rules object.

## Risks

### Phase 5

1. **The spec's stemming rule provably fails the spec's own required test case — verified by experiment.** The spec says "a light suffix-stripping stem (`-ing`, `-ed`, `-s`) so 'serialization' matches 'serialize'", and Testing Requirements lists "Stemmed match: topic 'serialization' hits shard text 'serialize'". Running exactly that rule: `serialization → serialization` (ends in `n`, no suffix applies), `serialize → serialize`, `serialized → serializ`, `stored → stor` vs `store → store`. **None of the pairs match.** The three-suffix stripper only handles the `refactoring/refactor` shape. Real Porter handles this through the `-ization → -ize → -ize→∅` chain, which is a rules table, not three suffixes. **Decide explicitly and write the test to whatever you pick**: add an `-ation`/`-ization`/`-ize`/`-ise` group to the stripper, or fall back to a prefix-overlap rule (`a.startsWith(b) || b.startsWith(a)` over a minimum length), or change the test case to one the stated stemmer actually satisfies and say so in the Open Items. Do not ship a stemmer whose headline example is red.
2. **`Bun.Glob`'s `*` does not cross `/`, so the spec's group experiment fails a literal implementation — verified.** `new Bun.Glob('/tmp/x/authkit-*')` matches `/tmp/x/authkit-nextjs` (`true`) but not `/tmp/x/authkit-session/packages` or `/tmp/x/authkit-session/packages/core` (both `false`). The spec's experiment explicitly requires `/tmp/x/authkit-session/packages/core` to be returned. And `activeShardsFor` passes the _container_ from `createContainerResolver()` — which for a non-git tmpdir path (exactly what the fixtures use, cf. `mcp-shards.test.ts:18-25` using bare `/repos/app` strings) is the **raw cwd**, subdirectory and all. **Mitigation**: `groupsFor` must test the glob against the container _and every ancestor prefix of it_ (walk `dirname` up to `/`), which is the JS analogue of the `cwdUnder` semantics `retrieve.ts:59` already uses; or append `/**` as a second pattern. Also: `~` is not expanded by `Bun.Glob` (`new Bun.Glob('~/Developer/authkit-*').match('/Users/nicknisi/Developer/authkit-x') === false`), so `homedir()` expansion must happen before construction, as the spec says.
3. **Putting the `ALTER` inside the existing `if (current < SHARD_SCHEMA_VERSION)` gate silently skips every already-migrated store.** `store.ts:52-59` reads `user_version`, and every existing user's store is already at `1`. If `SHARD_SCHEMA_VERSION` stays `1` (which the spec neither requires nor forbids) and the ALTER sits inside that `if`, the column is added on fresh databases only — and every `listShards` against an existing store then fails with `SQLITE_ERROR: no such column: always_on`. The `PRAGMA table_info(shards)` guard the spec calls for must run **outside** the version gate, unconditionally, on every open. **Corollary**: `durability.test.ts:106-116` sets `PRAGMA user_version = 0` and reopens against a table that already has the column — so the `table_info` guard is load-bearing for an existing test, not just for repeat runs. Without it that test fails with `duplicate column name: always_on`. And if you _do_ bump `SHARD_SCHEMA_VERSION` to 2, note it is stamped into every record (`record.ts:101`) and is a `z.literal` in the wire schema (`portable.ts:120,134`) — every v1 bundle from Phase 4 instantly becomes unimportable. Recommend **not** bumping.
4. **Widening `ShardScope['type']` to `'group'` breaks the export/import round trip silently — typecheck will not catch it.** `portable.ts:124` validates `scope: z.strictObject({ type: z.enum(['repo','workflow']), key: z.string() })`. Widening the TypeScript union does not widen the runtime enum, and `fromPortable` assigning the narrower inferred type into `PortableShard[]` still compiles. Consequence: exporting an approved group-scoped shard produces a bundle **your own `fromPortable` rejects** with `shards.0.scope.type: invalid`. Worse, `toPortable:89` blanks `scope.key` — correct for a repo container path, **destructive for a group name**, which is the one scope key that is not a local path and carries the entire meaning. **Decide and document**: (a) add `'group'` to the enum and preserve `key` when `type === 'group'`, (b) project group shards down to `workflow` on export, or (c) exclude them from export. Whatever you pick, add a round-trip test — `export.test.ts:120` is the existing one to extend.
5. **`setState` cannot express either new write, and the spec's Modified Files does not mention the gap.** `store.ts:230-238` is `UPDATE shards SET state=?, snoozed_until=?, updated_at=? WHERE id=?` — no `always_on`, no scope. `triage.ts:74-76` (`approve`) calls it with two arguments. Both `--always-on` and `--scope group:<name>` need a store write that does not exist. Also: `always_on` must be **excluded from `upsertCandidates`'s ON CONFLICT** (`store.ts:139`) for exactly the reason `state` is — `buildRecord` will default `alwaysOn` to `false`, so including it would clear a user's always-on flag on the next `shards mine`. Same for `scope_type`/`scope_key` if a triage-assigned group scope is to survive a re-mine: `deriveScope` will keep producing `repo`/`workflow`, and the ON CONFLICT currently does not touch scope columns — good, but assert it.
6. **The spec's own failure-mode table misdiagnoses the threshold.** "Threshold hides everything / Trigger: Threshold set too high for short shard texts" — but the score is `|topic ∩ shard| / |topicTokens|`, so **shard length does not enter the denominator at all**; topic length does. At `TOPIC_THRESHOLD = 0.15`, a topic with 1–6 content tokens passes on a single hit, while a 7-token topic needs 2. The real failure is a _long_ topic string, not a short shard. Also: a topic consisting entirely of stopwords ("the and it") yields zero tokens → `0/0` → `NaN`, and `NaN >= 0.15` is `false`, so every conditional shard would be silently dropped — the exact silent-suppression failure the always-on flag exists to prevent. **Guard the empty-token-set case explicitly and return 1**, treating it the same as an empty topic; the spec only names the empty-string case.
7. **Adding `'group'` and `alwaysOn` cannot change the no-topic output of `activeShardsFor`, and three existing tests pin it.** `mcp-shards.test.ts:133,139,145,150,168-169` use exact `toEqual([...])` on the returned texts, `:200` pins `['workflow','workflow','repo','repo']`, and `:223-229` pins the projection to exactly `{text, kind, scope}` with `Object.keys(...).sort() === ['kind','scope','text']`. So: the empty-topic path must short-circuit before any scoring; group shards must slot somewhere that does not disturb workflow-then-repo when no group shards exist; and the projection must **not** gain a `score` or `alwaysOn` key. That last point has a design consequence worth a comment — the agent learns "this is a standing constraint" only from ordering, never from a field.
8. **`contract.md:183` says `src/shards/store.ts` is "written only by Phase 1", and Phase 5 writes it.** This is a live contradiction between the contract's coordination note and this spec's Modified Files table. It is a **stale premise rather than a real conflict**: the note exists because Phases 2/3/4 were meant to run in parallel, and all four are now landed (`dd3700f`, `56a8633`, `2efb062`, plus Phase 2 staged). Phase 5 is the only phase in flight, so the coordination hazard is gone. Flagged so a future reader does not treat the contract line as a prohibition that was quietly ignored. Related: `contract.md:97` logs "Two shard scopes, repo and workflow" as the _chosen_ decision with "explicit project groups as a third tier" as the _rejected_ alternative — Phase 5 implements the rejected alternative. The spec acknowledges this ("This phase adds them under the Stretch tier"), and the contract's own Scope Boundaries list groups as in-scope Stretch (`contract.md:67`), so the decision log entry is stale rather than violated. **Update the decision log or note the reversal in the code comment**, or a reader will find the contract forbidding what the code does.
9. **Same omission class as every prior phase: user-facing surfaces are unscoped.** `src/cli.ts:49-51` documents `shards approve|reject|snooze` and needs the two new flags; `README.md:105` and `README.md:120` mirror it; `README.md:201` describes `get_shards` with no mention of `topic`; `plugin/skills/shards/SKILL.md:26,28-33` walk triage without always-on or group scope, and `:41` explicitly says "Scope is shown, not edited … does not exist yet", which Phase 5 makes false. Phases 1, 2, and 4 all updated their equivalents. **Unlike Phase 4, this phase DOES require `bun run generate-plugin-embed`** (`contract.md:40` is a shell criterion asserting `git diff --exit-code src/plugin-files.ts` after regeneration). Note `src/plugin-files.ts` is already `M` from Phase 2, so regeneration will produce a combined diff.
10. **`groups.json` has no writer, no schema documentation outside this spec, and no discoverability.** `loadGroupConfig` reads a file nothing creates and nothing tells the user about. A group-scoped shard with no matching config is inert and silent — the same class of silent failure `retrieve.ts:51-54` was written to prevent for empty repo keys. **Minimum**: document the path and format in `README.md`, and consider whether `groupsFor` returning `[]` for a shard whose group name appears in no config should be logged anywhere. Also decide the malformed-shape case: the spec says a `try/catch` returning `{groups:{}}`, but valid JSON of the wrong shape (`{"groups": "authkit"}`, or `{"groups":{"a":"str"}}`) throws nothing — it needs a structural check, not just a parse guard, or `groupsFor` will iterate a string.
11. **`loadGroupConfig` runs on the `get_shards` hot path.** `activeShardsFor` is called once per tool invocation and is documented as synchronous with "one git resolution per call" as an explicit perf note (`retrieve.ts:40-42`). A `readFileSync` + `JSON.parse` + N `new Bun.Glob(...)` constructions per call is small but not free, and `Bun.Glob` compilation is the expensive part. Decide whether to memoize (and accept that editing `groups.json` then needs a server restart) or re-read every call (and accept the syscall). Say which in a comment — the spec's own manual test is "Deleting `groups.json` does not break retrieval", which a naive process-lifetime memo would pass for the wrong reason.
12. **CI does not run tests.** `.github/workflows/ci.yml` runs `bun run lint`, `format:check`, `typecheck`, `build` (`:24,34,47,57`) and nothing else. `topic.test.ts` and `group.test.ts` are local-only gates; green CI is not evidence Phase 5 works.
13. **The working tree still carries uncommitted Phase 2 work.** `plugin/skills/shards/SKILL.md`, `src/shards/triage.ts`, `src/shards/snooze.test.ts`, `src/shards/fixtures/golden-set.json` are staged-added; `src/setup.ts` and `src/plugin-files.ts` are modified. Phase 5 edits the SKILL.md and regenerates `src/plugin-files.ts` on top of those. Any `git stash`, `git checkout --`, or `git restore` destroys unrecoverable work.

**Decision-log check (Phase 5)**: Two contradictions found and logged. (a) Risk 8 — `contract.md:97` records "two shard scopes, repo and workflow" as the standing decision with project groups as the _rejected_ alternative, while `contract.md:67` lists groups as in-scope Stretch and this spec implements them; the rejection's stated reason ("groups need a grouping the index does not have") is not refuted, it is simply satisfied by adding config, so the entry is stale rather than wrong. (b) `contract.md:183`'s "store.ts is written only by Phase 1" is contradicted by this spec's Modified Files; the premise (parallel phase execution) no longer holds, since Phases 1–4 are landed. Two entries are _confirmed consistent_ by the code: `contract.md:93` ("Retrieval via an MCP get_shards tool" chosen over the SessionStart hook, because a hook fires before the first prompt and can never do topic matching) is exactly what Phase 5 cashes in — `src/mcp.ts:67-74` is the tool, and there is no shard hook anywhere in `src/hooks.ts`; and `contract.md:39` (two-dependency ceiling) survives, since `Bun.Glob` is built in and already used at `src/scanner.ts:92` and `src/cache.ts:246`, so no NLP or glob library is needed. The "toggle UI and why-enabled column out of scope" entry (`contract.md:78`) is consistent — nothing in Phase 5 adds a provenance column, and `mcp-shards.test.ts:229` actively prevents one.

### Phase 4 (retained, with resolution status)

1. **`scope.key` exported while claiming no local paths** — **resolved**: `portable.ts:89` blanks the key, documented at `:64-70` and `types.ts:62-63`.
2. **Import destroys local evidence** — **resolved**: `runImport` reads the local rows first (`cli.ts:367`) and `toRecord` merges (`portable.ts:324-334`).
3. **No place to store multiple authors** — **resolved by documentation**: `portable.ts:318-322` states that local persistence is single-author and quorum is a function of a bundle set.
4. **`toPortable` must read the clock** — **resolved**: `toPortable(records, exportedAt)` with `RangeError` validation (`portable.ts:76-81`).
5. **`fromPortable` must validate the id** — **resolved**: identity is recomputed (`portable.ts:161-166`) and the text band is enforced (`:122`).
6. **zod's default `z.object` strips unknown keys** — **resolved**: `z.strictObject` throughout, documented at `portable.ts:108-118`.
7. **A raw `ZodError` escapes as a stack trace** — **resolved**: `PortableFormatError` + `firstIssue` (`portable.ts:139-145`), wrapped into `UsageError` at `cli.ts:357-361`.
8. **Neither existing parser fits the new subcommands** — **resolved**: `parseExportArgs` and `parseImportArgs` shipped (`cli.ts:155-195`).
9. **`totalPhrasings` duplicates `quorum` under the shipped mine** — still true; `mine.ts:234-237` hardcodes `distinctPhrasings = 1`, documented at `triage.ts:58-63` and `portable.ts:178`.
10. **`shards list` does not exist** — still true; `cli.ts:379-396` handles `mine|approve|reject|snooze|export|import` only. Still in scope per `contract.md:64`, still unassigned to a phase.
11. **User-facing surfaces unscoped** — Phase 4 updated `src/cli.ts:52-56` and `README.md`. Phase 5 repeats the omission (Risk 9).
12. **Dirty working tree** — still true (Risk 13).
13. **CI does not run tests** — still true (Risk 12).

### Phase 2 (retained)

1. ~~Step 4 breaks a Phase 1 test~~ — **resolved**: the filter shipped in `runMine` via `dropSuppressed` (`triage.ts:129-141`).
2. **`upsertCandidates` clobbers the resurface baseline** — mitigated: `runMine` snapshots `suppressedShards()` before upserting (`cli.ts:232-236`).
3. **The resurface condition cannot fire through the real pipeline** — still true, documented at `triage.ts:58-63`.
4. ~~`getPersistedStates` cannot feed the resurface predicate~~ — **resolved**: `suppressedShards()` reads through `listShards`.
5. **The checked-in plugin embed is stale** — still true; Phase 5 must regenerate (Risk 9).
6. **`/shards` is the first skill that shells out to the binary** — shipped; `SKILL.md` step 1 fails loudly.
7. ~~`setState` no-ops on an unknown id~~ — **resolved**: `isKnownShard` guards the CLI (`cli.ts:270`).
8. ~~Two stale spec references~~ — handled.
9. ~~User-facing surfaces unscoped~~ — recurring; see Risk 9.
10. **The precision criterion is unautomatable and gates are local-only** — still true.
11. **Golden-set fixture is a publication risk** — shipped at `src/shards/fixtures/golden-set.json`.

### Phase 1 (retained, with resolution status)

1. ~~The store path is deleted by `sessions cleanup`~~ — **resolved**: `src/setup.ts:18-30` + `durability.test.ts:67-85`.
2. ~~Calling `runUninstall()` from a test is destructive~~ — **resolved**: `removeInstalledFiles()`.
3. ~~`resolveRepo().container` does not span worktrees~~ — **resolved**: `mine.ts:71-102`.
4. ~~`mine(opts)` cannot be synchronous~~ — **resolved**.
5. **FTS5 MATCH syntax is narrower than an alias suggests** — still true.
6. **The porter tokenizer defeats two MATCH terms** — partly resolved; `wrong` still does not stem to "wrongly". Directly relevant to Phase 5's Risk 1.
7. ~~The JSON batch must go through `writeStdoutFully`~~ — **resolved**.
8. **`mine.perf.test.ts` is a wall-clock gate** — mitigated but live.
9. **Shared-module test pollution** — still true and codified in `fixtures.ts:20-38`; every new store-touching test file must `setShardEnv` + `closeDatabases` in `beforeEach` or hit `SQLITE_IOERR_VNODE`.
10. ~~Omissions from Modified Files~~ — recurring per phase.
11. ~~`author` fallback path~~ — **resolved**: `record.ts:46-55`.

## Edge Cases for the Builder

### Phase 5

**Topic matching (`topic.ts`)**

- `matchTopic(text, '')` → `1`. `matchTopic(text, '   ')` → `1`. `matchTopic(text, 'the and it')` (all stopwords → zero tokens) → must also be `1`, not `NaN` — see Risk 6.
- `matchTopic('', topic)` (empty shard text — unreachable through `mine()`'s `MIN_TEXT_LENGTH` band but reachable from a hand-seeded row) → `0`, not `NaN`.
- Score is `|topic ∩ shard| / |topicTokens|`, so it is bounded in `[0,1]` by construction; assert both ends.
- Punctuation and casing: `"don't"` splits on non-alphanumerics into `don` + `t` (the same split `unicode61` performs — `mine.ts:39-42` documents it), which is worth a comment so a reader does not think it is a bug.
- Duplicate tokens in the topic must not inflate the denominator — dedupe both sides into `Set`s before intersecting.
- The stemmer must be applied to **both** sides symmetrically; `stored → stor` vs `store → store` (verified) shows an asymmetric strip creates false negatives on a pair a user would call identical.
- A minimum stem length guard: stripping `-s` from `is`/`as`/`us` produces one-character tokens that match everything.
- `topic.ts` must import only `./types` (or nothing) — importing `store.ts`, `mine.ts`, `triage.ts`, or `wrapped/content.ts` transitively opens a database and forces `topic.test.ts` into the tmpdir harness.
- Determinism: two calls with the same inputs return the same number, and `activeShardsFor(cwd, topic)` called twice returns byte-identical JSON (a stated test case). Ties in score must break by the Phase 3 order, so use a stable comparator, never bare `.sort()`.

**Always-on**

- Always-on shards return at score 0 and sort **first** — before workflow shards, not just before conditional ones.
- An always-on shard that is `rejected`, `snoozed`, or `candidate` must still not be returned; the flag bypasses topic matching only, never the state filter (`retrieve.ts:37`).
- An always-on **repo-scoped** shard with a non-matching container must still not be returned — the flag bypasses topic, not scope. State this explicitly or a reader will assume "always" means "always".
- Set at approval: `sessions shards approve <id> --always-on`. `--always-on` on `reject`/`snooze` should be a usage error, since `parseTriageArgs` is shared across all three (`cli.ts:266`).
- `--always-on` must not be clearable-by-omission on a second approve unless you decide it is; `approve <id>` after `approve <id> --always-on` is an unstated case. Pick one and test it.
- `always_on` must be excluded from `upsertCandidates`'s ON CONFLICT or the next `shards mine` clears it (Risk 5).
- The wire format: `PortableShard` currently has no `alwaysOn`. It is your own attention decision — the same category as `state`, which `types.ts:53-64` documents as deliberately absent. Leaving it out is consistent; say so in the comment.

**Project groups (`groups.ts`)**

- Missing `groups.json` → `{groups:{}}`, no throw, no stderr (Risk 11 / MCP stdio).
- Present but empty file, `null`, `[]`, `{}` (no `groups` key), `{"groups": "x"}`, `{"groups":{"a":"str"}}` (globs not an array) — each needs a defined degradation, and a `try/catch` around `JSON.parse` catches none of the last four.
- `~` expansion via `homedir()`; also `~user` (do NOT try to expand), a bare `~`, and an already-absolute path.
- A glob matching a **subdirectory** of a member (`/tmp/x/authkit-session/packages/core`) must return the group — see Risk 2; `Bun.Glob`'s `*` does not cross `/`.
- A sibling that shares a prefix but is not a member: glob `/tmp/x/authkit-*` must not match `/tmp/x/authkitten` if that is the intent — it will, since `*` is greedy within the segment. Decide whether that is acceptable and test the boundary case the way `mcp-shards.test.ts:142-147` tests `/repos/app` vs `/repos/app-v2`.
- A group name containing a GLOB metacharacter, and a _path_ containing one (`/repos/re[p]o`, the fixture `mcp-shards.test.ts:23` already uses) — the pattern comes from user config here, so the metacharacter is in the pattern position and is legitimately meaningful; document that this is the inverse of the `globPrefix` situation in `retrieve.ts:24-32`.
- One container matching **two** groups → both names returned, sorted deterministically.
- A group-scoped shard whose `scope.key` matches **no** configured group is inert and silent; an empty `scope.key` on a group shard must be skipped the same way `retrieve.ts:54` skips an empty repo key (`''` would otherwise match every group name lookup).
- `groupsFor` must be pure (config injected), so `group.test.ts` can drive it without a fixture file; `loadGroupConfig` is the only I/O and gets the tmpdir + `SESSIONS_DATA_DIR` treatment.

**Retrieval (`retrieve.ts`)**

- No topic → byte-identical output to Phase 3. `mcp-shards.test.ts:133,139,145,150,168-169,200,223-229` are the exact assertions this must not move.
- Ordering with everything present: always-on, then (workflow, group, repo) by the Phase 3 rule, then conditional shards by score descending with the Phase 3 order as the tiebreak. Write the comparator once and comment the precedence, because four keys is where a `.sort()` becomes unreadable.
- An empty store still returns `[]` before any glob or config work (`retrieve.ts:38` already short-circuits — keep it, so `loadGroupConfig` never runs on an empty store).
- `runGetShards` with a topic and zero survivors must return the plain sentence, not `[]` — but "No shards for this repo." is now misleading when shards exist and the topic filtered them out. Consider a second sentence, and check it against `mcp-shards.test.ts:214-218`, which pins the empty-store wording.

**Store migration**

- The `PRAGMA table_info(shards)` guard runs **outside** the `user_version` gate (Risk 3).
- `durability.test.ts:106-116` sets `user_version = 0` and reopens — the guard must make that path a no-op rather than a `duplicate column name` error.
- `rowToRecord` (`store.ts:103-123`) reads `row.always_on` as an INTEGER; convert with `=== 1` or `!!`, never a bare truthy cast that leaves a number in a `boolean` field (it would serialize as `0`/`1` and break the JSON-equality determinism tests in `record.test.ts:59` and `cli.test.ts:120`).
- `listShards`'s SELECT list (`store.ts:189`) is explicit, not `SELECT *` — forgetting `always_on` there fails at runtime, not at typecheck.
- `CREATE INDEX IF NOT EXISTS idx_shards_always_on` is idempotent by construction; it belongs beside the two existing index statements (`store.ts:49-50`).

**Test harness**

- `topic.test.ts` needs **no** store harness if `topic.ts` stays pure — that is the point of keeping its imports empty.
- `group.test.ts` needs `makeTmp` + `setShardEnv` + `closeDatabases` in `beforeAll`, re-assert + `DELETE FROM shards` + reseed in `beforeEach`, `closeDatabases()` before `rmSync` in `afterAll` (`mcp-shards.test.ts:71-125` is the template), plus a `groups.json` written into `join(tmp,'data')` and deleted mid-test for the degradation case.
- Neither new test file may live in `src/mcp.test.ts` — its `setEnv()` deliberately omits `SESSIONS_DATA_DIR` and a `get_shards` call from there opens the developer's real store (`mcp-shards.test.ts:14-16`).

### Phase 4 (retained)

- Empty store → `toPortable([])` emits `{v, exportedAt, shards: []}`.
- The privacy filter is `state === 'approved'` exactly, never `!== 'rejected'`.
- Assert key absence recursively (`JSON.stringify(bundle)` must not contain `"sessions"` or `"state"`).
- Byte-identical determinism: sort by `id` with the explicit comparator (`portable.ts:41-43`), never `.sort()` on objects.
- Import: nonexistent path, unreadable path, empty file, non-JSON bytes, array-not-envelope, `v` mismatch, duplicate ids, id/text mismatch — each needs a non-stack-trace failure.
- An id already `rejected` locally stays `rejected`; an id already present must not lose its `evidence.sessions`.
- Merge: purity under a fixed permutation; case-folded author dedupe; scope widening to `{type:'workflow', key:''}`; string min/max over `'YYYY-MM-DD'` with a `''` guard.

### Phase 2 (retained)

- `snoozeUntil`: UTC-safe date arithmetic; boundaries `2026-01-01→2026-01-31`, `2026-01-31→2026-03-02`, `2026-12-15→2027-01-14`, `2028-02-01→2028-03-02`; malformed input throws a named `RangeError`.
- `today >= snoozedUntil` compares lexicographically; equality counts as expired.
- `approve` on a `rejected` id succeeds; an unknown id must not report success.
- `runShards`'s switch has `noFallthroughCasesInSwitch`; every case returns.
- Golden set: top-level array, exactly 40 entries, no verbatim text.
- `AskUserQuestion` allows at most 4 options per question.

### Phase 1 (retained)

- `msg_index = -1` sentinel rows must never produce a record.
- `resolveRepo` returns `null` for non-git cwds → fall back to the raw cwd; `git` may be absent.
- Memoize `cwd → container` per run; macOS `/var` → `/private/var` needs `realpathSync` in fixtures.
- `globPrefix` escapes `*?[`; the data dir needs `mkdirSync(..., {recursive:true})`; `closeShardsDb()` before any test `rmSync`.

## Verification Commands

```bash
bun test src/shards/topic.test.ts                   # inner loop (matcher + always-on)
bun test src/shards/group.test.ts                   # inner loop (group resolution)
bun test src/shards/mcp-shards.test.ts              # the Phase 3 no-regression gate
bun test src/shards/                                # 15 shard test files (160 tests green pre-Phase-5)
bun run lint && bun run format:check && bun run typecheck
bun test && bun run build
bun run generate-plugin-embed && git diff --stat src/plugin-files.ts   # required: SKILL.md changes
node -p 'Object.keys(require("./package.json").dependencies).length'   # must stay 2
bun run index.ts shards --help                      # the extended help text
```
