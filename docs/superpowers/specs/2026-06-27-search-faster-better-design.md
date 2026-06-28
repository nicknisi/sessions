# Search — Faster & Better (richer index, CLI/MCP parity)

**Created**: 2026-06-27
**Status**: Draft (design) — pending review
**Builds on**: the FTS5 index in `src/cache.ts`, the `src/extract-files.ts` extractor pattern, and the per-tool JSONL shapes in `src/parser.ts`

## Problem Statement

`sessions` has two search engines, and they have drifted:

- **The MCP / context path uses the FTS5 index** (`searchSessions` → BM25 ranking,
  porter stemming, indexes user + assistant + subagent text).
- **The interactive CLI does not.** `sessions <query>` re-scans every JSONL on
  disk and does case-insensitive `String.includes` on _user text only_
  (`scanner.ts` → `parser.ts:contentMatches` / `findMatchContext`). So the most-used
  entry point is both **slower** (full-corpus re-read per query) and **weaker**
  (no ranking, no stemming, no assistant/subagent content) than the MCP. Nothing
  forces the two surfaces to stay even, so they diverged silently.

Beyond the engine split, the index covers a thin slice of the data:

- `session_fts` indexes only `user_content` (+ subagent user text) and
  `assistant_content`. The most search-worthy JSONL signal is discarded at parse
  time: the **commands** you ran, the **files** you touched/read, the **errors**
  you hit, and the model's **reasoning**.
- `files_touched` is already extracted and stored on the `sessions` table but is
  **not in the FTS table**, so "which session touched `cache.ts`" cannot match.
- Ranking is `ORDER BY bm25(session_fts)` with **no column weighting** — no way to
  favor a title/command hit or down-weight verbose content.

And two hardening gaps:

- `getDb()` sets WAL + `synchronous=NORMAL` but **no `busy_timeout`**
  (`cache.ts:75-76`), so a CLI search and a running MCP server both calling
  `refreshIndex()` (a writer) can collide with `SQLITE_BUSY`.
- A corrupt index throws rather than self-healing.

## Goals

1. **One engine.** The CLI and MCP both query the same FTS index through one
   shared module — capability parity by construction, so they cannot drift again.
2. **Index the search-worthy signal:** commands, file paths (edited + read), error
   text, and thinking — each in its own FTS column.
3. **Relevance control** via per-column BM25 weights (favor headline / commands /
   paths; down-weight thinking).
4. **New query power on both surfaces:** an `errored` filter; per-result structured
   metadata (`files`, `commands`, `errored`) returned by the MCP and shown in the
   CLI; a `resumeCommand` returned by the MCP for parity with the CLI's clipboard.
5. **Rock-solid:** concurrent-safe index access, corrupt-DB self-heal, correct
   Codex command de-duplication.
6. **Hold the architecture line:** local-only, no network, no LLM, single Bun
   binary; extraction stays pure and unit-tested.

## Approach

Keep the **precompute-at-index** model. Add new pure extractors that mirror
`extract-files.ts` (per-tool branches, dedup + cap), populate new structured and
FTS columns during the existing `indexFile` pass, and serve everything from
SQLite. Route the CLI through `searchSessions` so both surfaces share the engine.

**Rejected — single-pass `analyzeSession()` rewrite.** Parsing each line once and
emitting one rich struct would speed the first index build, but it means rewriting
working extractors (`getSessionMessages`, `extractFiles`, …) and the index is
incremental — per-query cost is unaffected either way. Not worth the risk in this
pass; revisit only if first-build time becomes a problem.

**Rejected — a vector / secondary semantic store.** This is a lexical-coverage +
weighting problem, not a similarity problem; for re-finding a session by its
concrete cues (file paths, error strings, commands, identifiers) BM25 is the right
tool. Semantic search is deferred (see the separate vector-DB analysis).

## Design

### 1. Extraction layer (new pure functions, mirror `extract-files.ts`)

| Function (file)                                   | Returns                                          | Claude                                              | Codex                                                                  | Pi                                              |
| ------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `extractCommands` (`extract-commands.ts`)         | `string[]` (cap 100, dedup, order-preserving)    | `assistant` `tool_use` name `Bash` → `input.command` | `exec_command_end.command` / `function_call` exec — **dedup the dual recording** (`response_item` + `event_msg` both carry it) | `bashExecution.command` (+ `toolCall` name `bash`) |
| `extractErrors` (`extract-errors.ts`)             | `{ errored, count, messages[] }`                 | user `tool_result.is_error` + `isApiErrorMessage`   | `exec_command_end.exit_code !== 0` + `error` events                    | `toolResult.isError` + assistant `errorMessage` |
| `extractThinking` (`extract-thinking.ts`)         | `string` (length-capped)                         | `thinking` block text                               | encrypted → **empty** (only plaintext `summary` if present; documented) | `thinking` block text                           |
| `extractFilesRead` (extend `extract-files.ts`)    | `string[]` (cap)                                 | `Read`/`Grep`/`Glob` `tool_use` targets             | read/search `parsed_cmd` targets                                       | `read`/`grep`/`find` `toolCall` targets         |

`extractFilesRead` is **kept separate** from the existing `extractFiles` (edited
files), because `significance.ts` consumes `files_touched` and its meaning must not
change.

### 2. Index schema (`cache.ts`) — `SCHEMA_VERSION` 5 → 6

Destructive reindex on `user_version` mismatch (same pattern as 4 → 5). First run
after upgrade re-parses all logs.

New columns on the `sessions` table (mirroring `files_touched`):

```
commands     TEXT    NOT NULL DEFAULT '[]'
files_read   TEXT    NOT NULL DEFAULT '[]'
errored      INTEGER NOT NULL DEFAULT 0
error_count  INTEGER NOT NULL DEFAULT 0
```

New `session_fts` columns (order matters for `bm25()`), alongside existing
`user_content` / `assistant_content`:

```
headline       -- first_prompt + '\n' + custom_title
commands       -- command strings, joined
paths          -- files_touched + files_read, joined (so "cache.ts" matches)
context_text   -- error messages, joined
thinking       -- reasoning text
```

`indexFile` extends its existing INSERTs to populate the new columns. The
incremental gate `(mtime, size)` is unchanged.

### 3. Search & ranking (`searchSessions`)

- Replace `ORDER BY bm25(session_fts)` with weighted
  `bm25(session_fts, <weights…>)`: favor `headline`, `commands`, `paths`; normal
  `user_content` / `assistant_content`; **down-weight `thinking`** (≈0.2) so it
  adds recall without dominating. **Exact weights are tuned by tests, not guessed
  here.**
- Refactor the signature to a filter-options object —
  `searchSessions(query, { tool, project, errored, limit })` — so new filters and
  CLI/MCP parity don't churn the signature.
- `errored` filter → `AND s.errored = 1`.
- Extend `SessionResult` (`types.ts`) with `files: string[]`, `commands: string[]`,
  `errored: boolean`, populated from the joined `sessions` columns.
- Keep `snippet(session_fts, -1, …)` (best-matching column) so a command / path /
  error hit shows the right context.

### 4. CLI unification (`index.ts` / `scanner.ts`)

- Route `sessions <query>` **and** the no-arg browse through `searchSessions`, not
  the live `scanner`. `--here` → `project`; `--tool` → `tool`; new **`--errored`**
  flag → `errored`.
- The fzf line / post-selection view surfaces the new metadata (files touched,
  commands, ⚠ errored) — parity with the MCP result fields.
- Retire `contentMatches` / `findMatchContext` from the hot path; keep the scanner
  **only** as a no-index fallback (e.g. read-only FS where the index can't build).

### 5. MCP enhancements (`mcp.ts`) — parity

- `search_sessions`: add `errored?: boolean`; return `files`, `commands`,
  `errored`, and a **`resumeCommand`** per result (the CLI's clipboard string,
  exposed so an agent can present it).
- Extract the resume-command builder into the shared module so CLI + MCP emit
  identical strings (no drift).

### 6. Rock-solid hardening (`cache.ts`)

- `getDb()`: add `PRAGMA busy_timeout=<ms>` so concurrent CLI + MCP writers wait
  rather than throw `SQLITE_BUSY`.
- Corrupt-DB guard: on `SQLITE_CORRUPT` / "malformed", drop the DB files (reuse
  `clearCache`) and rebuild instead of crashing.
- Codex command de-duplication (see §1) — protects the integrity of the new
  `commands` data.

### Parity principle (architectural)

CLI and MCP are **thin shells over one shared query/format core** (`searchSessions`
plus a small results/format + resume-command module). Every filter and every result
field exists on both. The CLI-not-using-the-index bug _is_ this drift; the fix is
structural, not a one-off.

## Data flow

```
discoverFiles → indexFile (extractors → structured cols + FTS cols)
              → searchSessions (weighted bm25 + filters) → SessionResult[]
              → { CLI: fzf list + metadata }  |  { MCP: JSON incl. resumeCommand }
```

## Error handling & edge cases

- Malformed JSONL lines are skipped (existing `tryParse`); unknown record `type`s
  are no-ops (forward-compat with the volatile Claude schema).
- Codex encrypted reasoning → empty thinking (documented, not an error).
- Pi file-_edits_ stay a no-op for `files_touched` (no fixtures), but Pi commands
  _are_ covered via `bashExecution`.
- Caps bound index growth: commands ≤ 100, thinking length-capped, errors stored as
  a count + short text.
- 5 → 6 reindex is destructive; first post-upgrade run re-parses all logs
  (established pattern; seconds).

## Success Criteria

- [ ] `extractCommands` pulls Bash/exec commands for Claude, Codex, Pi from inline fixtures; **Codex dual-recording yields each command once** — check: `bun test src/extract-commands.test.ts` exits 0
- [ ] `extractErrors` flags an errored session (Claude `is_error`, Codex non-zero `exit_code`, Pi `isError`) and a clean session as not errored — check: `bun test src/extract-errors.test.ts` exits 0
- [ ] `extractThinking` returns Claude/Pi thinking text and **empty for Codex** — check: `bun test src/extract-thinking.test.ts` exits 0
- [ ] `extractFilesRead` captures Read/Grep targets without disturbing `extractFiles` (edited) — check: `bun test src/extract-files.test.ts -t "read"` exits 0
- [ ] Reindex on `SCHEMA_VERSION` 5→6 populates `commands` / `files_read` / `errored` and the new FTS columns — check: `bun test src/cache.search.test.ts -t "indexes new content"` exits 0
- [ ] A query matching a command (`"docker compose"`) or a file path (`"cache.ts"`) returns the session that ran/touched it — check: `bun test src/cache.search.test.ts -t "commands and paths are findable"` exits 0
- [ ] Weighted ranking: a headline/command hit outranks a thinking-only hit on the same term — check: `bun test src/cache.search.test.ts -t "ranking"` exits 0
- [ ] `errored` filter returns only errored sessions; `SessionResult` carries `files`/`commands`/`errored` — check: `bun test src/cache.search.test.ts -t "errored filter and metadata"` exits 0
- [ ] The CLI query + browse paths delegate to `searchSessions` (the substring scanner is off the hot path), with `--here`/`--tool`/`--errored` mapped to filters — check: `bun test src/cache.search.test.ts -t "cli delegates to index"` exits 0
- [ ] The shared result formatter + resume-command builder yield `files`/`commands`/`errored`/`resumeCommand` from a `SessionResult` (consumed by both CLI and MCP, so neither can drift) — check: `bun test src/search-format.test.ts` exits 0
- [ ] Concurrent index access does not throw (`busy_timeout` set); a corrupt DB rebuilds rather than crashing — check: `bun test src/cache.search.test.ts -t "hardening"` exits 0
- [ ] No new runtime dep, no network, no LLM — check: `grep -rnE 'fetch\(|https?://|anthropic|openai' src/extract-commands.ts src/extract-errors.ts src/extract-thinking.ts` no matches
- [ ] Full gate: `bun test` exits 0; `bun run typecheck` / `lint` / `format:check` / `build` all exit 0

## Scope Boundaries

**In scope:** §1–6, the parity principle (shared engine + shared resume-command),
and the tests above.

**Out of scope (sequenced next / deferred):**

- **Read-without-resume** — fzf `--preview` pane + `sessions show <id>`. The
  immediate **next spec**. Deliberately decomposed: `sessions show` (render → string)
  is low-risk and testable; the live preview pane is the perf-sensitive,
  hard-to-test piece. Kept out so the data layer ships clean and de-risked; the
  CLI metadata display in §4 leaves a seam the preview extends.
- **Session lineage** — linking forked/resumed/compacted sessions (`forkedFrom`,
  compaction boundaries) into one arc. Separate spec.
- **`message_count` correctness** — it currently counts tool-result and
  skill-injection envelopes (inflated). Fixing it ripples into
  `get_activity_digest` / `get_session_metrics` / `significance` semantics and is
  **not** a search win, so it's deferred to the behavioral/turn-count work.
- **Vector / semantic search** — see the separate analysis; lexical coverage +
  weighting is the right lever now.
- **Workflow / waste detection** (the AIE-workshop "soft signals") — a separate
  command, not this tool's search path.

## Risks

- **BM25 weight tuning is empirical** — wrong weights could regress relevance.
  Mitigated by ranking assertions in `cache.search.test.ts` and the separate-column
  design (the knob is reversible).
- **Thinking text bloats the index / dilutes precision** — mitigated by a low
  weight + length cap; it can be dropped from FTS without touching the other
  columns if it proves noisy.
- **Codex dual-recording dedup** — getting it wrong double-counts commands; covered
  by a dedup test.
- **CLI behavior change** — index results/snippets differ from the old substring
  scan (better, but different). Mitigated by preserving browse semantics (recent
  list) and the project-exists dot.
- **5 → 6 reindex cost** — destructive; first run after upgrade re-parses all logs.
  Established pattern; acceptable.
