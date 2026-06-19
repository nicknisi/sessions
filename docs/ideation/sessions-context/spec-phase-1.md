# Implementation Spec: sessions context — Phase 1 (Extraction Core)

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Phase 1 builds the deterministic extraction layer that both surfaces (Phase 2) consume. Nothing here is user-facing — the deliverable is a tested `getContextPrimer(repoRoot, opts)` function plus the index changes and repo-resolution fixes it depends on.

Three things land here, in dependency order:

1. **A robust git repo resolver + boundary-aware cwd matching.** The current `getRepoRoot` (`src/cli.ts:79`) uses a brittle `../.git` + `.bare` string match, and cwd scoping uses bare `startsWith` (`src/scanner.ts:43`) / `cwd LIKE project || '%'` (`src/cache.ts:285,313`) with no path-boundary check, so `dotfiles-v2` is captured under `dotfiles`. We replace the resolver with one based on `git rev-parse --git-common-dir` and `git worktree list --porcelain`, and switch cwd matching to boundary-aware GLOB. This is a behavior change to the _existing_ search/scan path, so existing tests must stay green.

2. **A `SCHEMA_VERSION` 2→3 bump that precomputes the per-session data the primer needs.** `indexFile` (`src/cache.ts:159`) currently stores no edited-file paths and no closing text. We add `files_touched`, `closing_user`, and `closing_assistant` columns and populate them at index time via a new `extractFiles` module and the existing `getSessionMessages`. The bump triggers the codebase's existing destructive reindex (drop + rebuild on `PRAGMA user_version` mismatch, `cache.ts:55-60`) — a one-time ~5s rebuild.

3. **`getContextPrimer` — a pure-SQL two-tier query.** Recent N sessions in full detail + older sessions as dated headlines, scoped to the repo across all its worktrees, each session labeled by branch. Because the closing text and files are now indexed columns, this reads zero session source files.

The genuine risk is `extractFiles` for Codex and Pi: their edited-file shapes appear nowhere in the codebase or fixtures and must be reverse-engineered from real logs. **Prerequisite: capture representative Codex (`~/.codex/sessions`) and Pi (`~/.pi/agent/sessions`) session logs that contain file edits before authoring those branches.** Claude's shape (`tool_use` blocks with `input.file_path`) is well understood.

## Feedback Strategy

**Inner-loop command**: `bun test src/extract-files.test.ts src/context.test.ts`

**Playground**: Bun test suite. Both new modules are pure data transforms over JSONL, so a scoped test run is the tightest loop.

**Why this approach**: Every component here is a logic/data layer — file-path extraction, message extraction, and a SQL query — all of which validate fastest against inline/temp-dir fixtures, mirroring the existing `parser.test.ts` and `report/index.test.ts` patterns. No server or UI is involved until Phase 2.

## File Changes

### New Files

| File Path                   | Purpose                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `src/extract-files.ts`      | `extractFiles(lines, tool)` — parse tool-call blocks for edited source-file paths, per tool. |
| `src/extract-files.test.ts` | Per-tool unit tests (Claude/Codex/Pi) for `extractFiles`.                                    |
| `src/repo.ts`               | `resolveRepo(cwd)` — git-common-dir based repo container + `git worktree list` branch map.   |
| `src/repo.test.ts`          | Resolver + boundary-matching unit tests (incl. `dotfiles` vs `dotfiles-v2`).                 |
| `src/context.test.ts`       | Fixture-based tests for `getContextPrimer` (two-tier, worktree aggregation, empty-state).    |

### Modified Files

| File Path        | Changes                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`   | Add `ContextPrimer`, `ContextSession`, `ContextHeadline` interfaces.                                                                                                                                  |
| `src/cache.ts`   | `SCHEMA_VERSION` 2→3; add `files_touched`/`closing_user`/`closing_assistant` columns + populate in `indexFile`; add boundary-aware helper; add `getContextPrimer`; fix `cwd LIKE` matches at 285/313. |
| `src/parser.ts`  | Add `closingMessages(lines, tool)` returning last user + last assistant text (reuses `getSessionMessages`, `stripInjected`).                                                                          |
| `src/scanner.ts` | Replace bare `cwd.startsWith(repoRoot)` (line 43) and the dir-name prefix (line 110) with the boundary-aware helper.                                                                                  |
| `src/cli.ts`     | Replace `getRepoRoot` body to delegate to `src/repo.ts` (keep the same exported signature so `index.ts:58` is unaffected).                                                                            |

### Deleted Files

None.

## Implementation Details

### Component 1 — Repo resolver + boundary matching (`src/repo.ts`)

**Pattern to follow**: `src/cli.ts:79-101` (existing `Bun.spawnSync(['git', ...])` usage — git is already an assumed external dependency, so no new dep).

**Overview**: Resolve the repo "container" (the directory tree that holds all worktrees) and a cwd→branch map, using git plumbing instead of string matching.

```typescript
export interface RepoInfo {
  /** Canonical repo key (absolute path to the common git dir). */
  gitCommonDir: string;
  /** Directory tree under which this repo's sessions live (bare: parent of .bare; normal: main worktree toplevel). */
  container: string;
  /** Current worktree toplevel (for --worktree narrowing). */
  currentWorktree: string;
  /** Live worktree path → branch label, from `git worktree list --porcelain`. */
  branches: Map<string, string>;
}

export function resolveRepo(cwd: string): RepoInfo | null; // null when not in a git repo

/** Boundary-aware: true iff `cwd` is `root` or a descendant of `root`. */
export function cwdUnder(cwd: string, root: string): boolean; // cwd === root || cwd.startsWith(root + '/')
```

**Key decisions**:

- **`git rev-parse --git-common-dir`** identifies the repo canonically and works from any worktree (bare or linked). The `container` is derived as: if the common dir basename is `.bare` (or common dir ends in `/.bare`), `container = dirname(dirname(commonDir))`'s parent that holds the worktrees → in practice `path.dirname(commonDir)`'s parent for the `~/Developer/dotfiles/.bare` layout resolves to `~/Developer/dotfiles`; for a normal repo, `container = git rev-parse --show-toplevel`. Document the derivation inline.
- **Branch labels from `git worktree list --porcelain`** (one subprocess, parsed into the `branches` map) — avoids any per-session git call and keeps `getContextPrimer` free of session-file I/O. Sessions whose cwd isn't in the map (deleted/relocated worktree) fall back to the last path segment of their cwd.
- **GLOB for SQL boundary matching** (see Component 4) — `cwdUnder` is the JS mirror used in tests and the scanner.

**Implementation steps**:

1. Spawn `git -C <cwd> rev-parse --git-common-dir --show-toplevel`; bail to `null` on non-zero exit.
2. Derive `container` (handle the `.bare` layout vs normal repo).
3. Spawn `git -C <cwd> worktree list --porcelain`; parse `worktree <path>` / `branch refs/heads/<name>` records into `branches`.
4. Export `cwdUnder` and a `globPrefix(root)` helper (`root + '/*'`, GLOB-escaping `*?[`).

**Feedback loop**:

- **Playground**: `src/repo.test.ts` with a `describe('cwdUnder')` smoke test first.
- **Experiment**: `cwdUnder('/x/dotfiles-v2/a', '/x/dotfiles')` is `false`; `cwdUnder('/x/dotfiles', '/x/dotfiles')` and `cwdUnder('/x/dotfiles/wt/main', '/x/dotfiles')` are `true`. For `resolveRepo`, use a temp git repo created with `git init` + `git worktree add` (Bun `spawnSync`) and assert the branch map.
- **Check command**: `bun test src/repo.test.ts`

### Component 2 — `extractFiles(lines, tool)` (`src/extract-files.ts`)

**Pattern to follow**: `src/report/parsers/util.ts` (`readJsonlLines`) for walking; `src/parser.ts:202-235` for the per-tool content-block branching. **Do NOT edit the vendored `src/report/parsers/*` files.**

**Overview**: Given a session's JSONL lines and its tool, return the de-duplicated list of source-file paths edited during the session.

```typescript
export function extractFiles(lines: string[], tool: Tool): string[];
```

**Key decisions**:

- **Claude** (well-understood): walk assistant `message.content[]` blocks where `type === 'tool_use'` and `name ∈ {Edit, Write, MultiEdit, NotebookEdit}`; path = `input.file_path` (Edit/Write/MultiEdit) or `input.notebook_path` (NotebookEdit).
- **Codex** (reverse-engineered — **needs real fixtures**): file edits surface as function-call/`apply_patch` items, not Anthropic `tool_use`. Parse the `apply_patch` payload's `*** Add File: <p>` / `*** Update File: <p>` / `*** Delete File: <p>` headers. Exact envelope (`response_item` vs `event_msg`) to be confirmed against captured logs.
- **Pi** (reverse-engineered — **needs real fixtures**): inspect `message.content[]` tool-call blocks; shape TBD from logs.
- Return paths as-stored (do not resolve/normalize against cwd); dedupe preserving first-seen order; cap at a sane max (e.g. 50) to bound the column.

**Implementation steps**:

1. Implement + fully test the Claude branch first (no external fixtures needed — inline JSONL).
2. Capture real Codex/Pi logs with edits → add as inline fixtures in the test → implement those branches against them.
3. Dedupe + cap; return `[]` for sessions with no edits.

**Feedback loop**:

- **Playground**: `src/extract-files.test.ts`, `describe` per tool, inline `jsonl(...)` helper (copy from `parser.test.ts:14`).
- **Experiment**: Claude session with 0 edits → `[]`; with Edit+Write+MultiEdit to 3 distinct paths + 1 duplicate → 3 unique paths in order; NotebookEdit → notebook path. Codex `apply_patch` with Add+Update → both paths. Pi tool-call → its path.
- **Check command**: `bun test src/extract-files.test.ts`

### Component 3 — Closing messages + index-time population (`src/parser.ts`, `src/cache.ts`)

**Pattern to follow**: `src/parser.ts:238-253` (`getSessionMessages`), `src/cache.ts:159-214` (`indexFile`).

**Overview**: Add `closingMessages` to the parser; call it + `extractFiles` inside `indexFile` and store results in three new columns.

```typescript
// src/parser.ts
export function closingMessages(lines: string[], tool: Tool): { user: string; assistant: string };
// last role==='user' text and last role==='assistant' text from getSessionMessages,
// already stripInjected'd, each truncated to CLOSING_MAX (e.g. 500) chars.
```

**Key decisions**:

- **Capture both roles deliberately.** Last-assistant alone is often a question or a tool call, not an outcome — the skill (Phase 2) decides what the open thread is; the extractor just ships both signals.
- **New columns** on `sessions`: `files_touched TEXT NOT NULL DEFAULT '[]'` (JSON array), `closing_user TEXT NOT NULL DEFAULT ''`, `closing_assistant TEXT NOT NULL DEFAULT ''`. JSON-in-TEXT matches the codebase's no-extra-table style; `getContextPrimer` `JSON.parse`s on read.
- **Bump `SCHEMA_VERSION` 2→3** (`cache.ts:33`). The existing `getDb` path (`cache.ts:55-60`) drops + rebuilds tables on mismatch — no migration code needed, but it is destructive (full reindex on next run). Acknowledge in the column comment.
- **Memoize branch resolution is N/A here** (branch is query-time, not indexed) — index-time additions are pure JSONL parsing, so reindex stays fast.

**Implementation steps**:

1. Add the three columns to the `CREATE TABLE sessions` DDL (`cache.ts:62-76`) and bump `SCHEMA_VERSION`.
2. In `indexFile`, after computing messages, call `extractFiles(lines, tool)` and `closingMessages(lines, tool)`; add the three values to the `INSERT OR REPLACE` (`cache.ts:207-212`).
3. Update `DateRangeRow`-style row reads only where needed (the primer uses its own query — see Component 4).

**Feedback loop**:

- **Playground**: `src/context.test.ts` — write a temp `claude/proj/a.jsonl` with edits + closing turns into a `mkdtemp` dir, run `refreshIndex` against injected `roots`, read the row back.
- **Experiment**: assert `files_touched` parses to the expected paths and `closing_assistant` equals the (truncated) last assistant turn.
- **Check command**: `bun test src/context.test.ts -t "indexed-columns"`

### Component 4 — `getContextPrimer(repoRoot, opts)` (`src/cache.ts`)

**Pattern to follow**: `src/cache.ts:355-382` (`queryDateRange`) — same `Database`, same parameterized filtering style.

**Overview**: Two-tier, repo-scoped, worktree-aggregated primer assembled entirely from indexed columns + the `RepoInfo` branch map.

```typescript
export interface ContextOptions {
  limit?: number; // recent-tier size (default 10)
  days?: number; // optional window
  tool?: Tool | ''; // optional tool filter
  full?: boolean; // include more per-session detail
  worktreeOnly?: boolean; // restrict to current worktree (default false → aggregate)
  headlineCap?: number; // older-tier cap (default 40)
}
export async function getContextPrimer(repo: RepoInfo, opts: ContextOptions): Promise<ContextPrimer>;
```

**Key decisions**:

- **Scope via boundary GLOB**: `WHERE (cwd = ?1 OR cwd GLOB ?2)` with `?1 = container`, `?2 = container || '/*'` — captures every worktree under the container (incl. deleted ones, whose cwd still lives under it) while excluding `…-v2` siblings. `worktreeOnly` swaps `container` for `currentWorktree`.
- **Branch label per session** from `repo.branches` (cwd→branch), falling back to `basename(cwd)` when absent.
- **Two tiers from one ordered fetch** (`ORDER BY created_at DESC`): first `limit` rows → `ContextSession[]` (intent=`first_prompt`, files=`JSON.parse(files_touched)`, opening=`first_prompt`, closing={user,assistant}, meta={tool,branch,date,messageCount}); next up to `headlineCap` rows → `ContextHeadline[]` (date + intent + tool + branch).
- **Empty-state**: zero matched rows → `ContextPrimer` with `isEmpty: true` and empty tiers (the surfaces render the friendly message).
- **Zero session-file reads**: everything comes from `sessions` columns + the one `git worktree list` call in `resolveRepo`. Enforced by the fs-spy test.

**Implementation steps**:

1. Build the `WHERE` (container/worktree GLOB + optional `tool`/`created_at` window).
2. Fetch ordered rows once; slice into recent + headline tiers.
3. Map rows → typed objects, attaching branch labels.
4. Return `ContextPrimer { repo, generatedFrom: {toolFilter, window}, recent, headlines, isEmpty }`.

**Feedback loop**:

- **Playground**: `src/context.test.ts` temp-dir fixture with two worktrees + one sibling `…-v2` dir.
- **Experiment**: sessions across `wt/main` and `wt/feature` are both present and branch-labeled; a `…-v2` session is absent; with 12 sessions and `limit:10`, recent has 10 and headlines has 2; empty roots → `isEmpty:true`.
- **Check command**: `bun test src/context.test.ts -t "two-tier"` / `-t "worktree"` / `-t "empty-state"`

## Data Model

### Schema Changes

```sql
-- sessions table (cache.ts:62-76) gains three columns; SCHEMA_VERSION 2 -> 3 forces destructive rebuild
ALTER ...  -- expressed as new columns in the CREATE TABLE (no ALTER; tables are dropped+recreated)
files_touched     TEXT NOT NULL DEFAULT '[]',   -- JSON array of edited source paths
closing_user      TEXT NOT NULL DEFAULT '',     -- last user message, stripped + truncated
closing_assistant TEXT NOT NULL DEFAULT ''      -- last assistant message, stripped + truncated
```

No new indexes — the primer filters on `cwd` (already the scoping column) and orders by `created_at`; existing access patterns suffice at this scale.

### State Shape

```typescript
// src/types.ts
export interface ContextSession {
  sessionId: string;
  tool: Tool;
  branch: string;
  date: string;
  messageCount: number;
  intent: string; // first_prompt
  files: string[]; // parsed files_touched
  opening: string; // first_prompt (verbatim opener)
  closing: { user: string; assistant: string };
}
export interface ContextHeadline {
  date: string;
  tool: Tool;
  branch: string;
  intent: string;
}
export interface ContextPrimer {
  repoLabel: string; // basename(container)
  toolFilter: Tool | '';
  recent: ContextSession[];
  headlines: ContextHeadline[];
  isEmpty: boolean;
}
```

## Testing Requirements

### Unit Tests

| Test File                   | Coverage                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| `src/extract-files.test.ts` | Per-tool file extraction (Claude proven; Codex/Pi against real fixtures).  |
| `src/repo.test.ts`          | `cwdUnder` boundary cases; `resolveRepo` branch map on a temp git repo.    |
| `src/context.test.ts`       | `indexFile` column population; `getContextPrimer` tiers/aggregation/empty. |

**Key test cases**:

- `extractFiles`: 0 edits → `[]`; dup paths deduped; NotebookEdit path; Codex `apply_patch` Add+Update; Pi tool-call.
- `cwdUnder`: `dotfiles` vs `dotfiles-v2` (the regression that motivated this).
- `getContextPrimer`: cross-worktree aggregation with branch labels; recent/headline split at `limit`; `worktreeOnly` narrows; `isEmpty` path.
- Index population: `files_touched` round-trips through JSON; closing truncation at `CLOSING_MAX`.

### Manual Testing

- [ ] Run a one-off script that calls `getContextPrimer(resolveRepo(process.cwd()), {})` in this repo and eyeball that the recent tier reflects real recent sessions.
- [ ] Confirm a `bun run typecheck` clean after the `types.ts` additions.

## Error Handling

| Error Scenario                               | Handling Strategy                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `cwd` not inside a git repo                  | `resolveRepo` returns `null`; callers (Phase 2) emit the empty/usage message. |
| `git worktree list` fails or is empty        | Proceed with empty branch map; sessions fall back to `basename(cwd)` labels.  |
| Malformed JSONL line during extraction       | Reuse `readJsonlLines` skip-on-parse-error behavior (`util.ts:23-35`).        |
| `files_touched` contains legacy/invalid JSON | `JSON.parse` in a try/catch → treat as `[]`.                                  |

## Failure Modes

| Component          | Failure Mode                          | Trigger                                             | Impact                                           | Mitigation                                                              |
| ------------------ | ------------------------------------- | --------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `extractFiles`     | Codex/Pi shape guessed wrong          | Real logs differ from reverse-engineered assumption | Codex/Pi sessions show empty/incorrect file list | Gate the branch behind real captured fixtures; Claude unaffected.       |
| `resolveRepo`      | Worktree placed outside the container | `git worktree add /elsewhere`                       | That worktree's sessions not aggregated          | Union in `git worktree list` paths; document the edge as a known limit. |
| `resolveRepo`      | Deleted-worktree sessions lose branch | Worktree removed after sessions ran                 | Sessions labeled by cwd basename, not branch     | Acceptable; still included via container prefix.                        |
| `getContextPrimer` | Sibling capture regression returns    | Someone reverts to bare `startsWith`/`LIKE %`       | `dotfiles-v2` pollutes `dotfiles` primer         | Locked by the `cwdUnder` regression test.                               |
| schema bump        | Destructive reindex surprises a user  | First run after upgrade                             | ~5s rebuild + transient empty index              | Existing behavior of `getDb`; note in release notes.                    |

## Validation Commands

```bash
bun test src/extract-files.test.ts src/repo.test.ts src/context.test.ts
bun run typecheck
bun run lint
bun run format:check
```

## Open Items

- [ ] **Codex/Pi fixture capture** — must land before their `extractFiles` branches; until then those branches return `[]` and are marked TODO in tests.
- [ ] Confirm the `.bare`-container derivation against the user's actual `~/Developer/<repo>/.bare` worktree layout.
- [ ] Decide `CLOSING_MAX` and `files_touched` cap values (start 500 chars / 50 paths).

---

_This spec is ready for implementation. Build Component 1 → 2 → 3 → 4 in order; each has its own check command._
