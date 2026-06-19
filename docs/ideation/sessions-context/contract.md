# sessions context Contract

**Created**: 2026-06-19
**Readiness**: All 5 gates ready
**Status**: Approved
**Supersedes**: None

## Problem Statement

Every new AI coding session on a repo starts from zero. Prior decisions, dead-ends, and half-finished threads from past Claude Code / Codex / Pi sessions evaporate, so you re-explain context you already worked out. `sessions` already indexes that history (SQLite + FTS5 in `cache.ts`) but only does retrieval — search, resume, usage reports — and stops short of feeding context back into the next session.

This adds the missing re-injection layer: a repo-scoped "context primer" surfacing what past-you decided, tried, and left open. To preserve the static-binary, no-LLM, no-network architecture (the project's actual moat), synthesis stays in the consuming agent via a skill; the binary only does deterministic extraction and ships the structured material.

## Goals

1. Produce a repo-scoped, two-tier context primer (recent sessions in detail + older sessions as dated headlines) from the existing index, across all three tools and across every worktree of a bare-repo project (aggregated by default, each branch-labeled).
2. Expose it on two surfaces sharing one extractor: a `get_context_primer` MCP tool (for in-agent synthesis) and a `sessions context` CLI command (for paste/pipe).
3. Ship a `context` skill that turns the structured data into a prose primer covering prior decisions, what was tried, and open threads.
4. Hold the line on the static-binary moat: no LLM call, no network, no new runtime dependencies.

## Success Criteria

- [ ] Two-tier markdown primer from `sessions context` (recent: intent/files/opening/closing-both-roles/meta; older: dated headlines), size-bounded — check: `bun test src/context.test.ts -t "two-tier"` — exits 0
- [ ] `get_context_primer` returns matching zod-validated JSON via MCP (house JSON style) — check: `bun test src/context.test.ts -t "mcp"` — exits 0
- [ ] `extractFiles` pulls edited paths from Claude, Codex, and Pi logs — check: `bun test src/extract-files.test.ts` — exits 0
- [ ] The `context` skill names prior decisions and flags the most-recent session's unfinished state as the open thread — judgment call: human review of a sample synthesized primer (agent-dependent prose, not mechanically testable)
- [ ] Cross-worktree aggregation with branch labels; `git --git-common-dir` resolution; boundary-aware match excludes sibling `dotfiles-v2` from `dotfiles` — check: `bun test src/context.test.ts -t "worktree"` — exits 0
- [ ] Repo with no sessions yields a graceful empty-state, not an error — check: `bun test src/context.test.ts -t "empty-state"` — exits 0
- [ ] After `SCHEMA_VERSION` 2→3, `files_touched` + closing messages stored as columns; `getContextPrimer` reads only indexed columns (no source-file reads) — check: `bun test src/context.test.ts -t "indexed-columns"` — exits 0
- [ ] No new runtime dep, no network call, no LLM call — check: `git diff --stat package.json` shows no added `dependencies`; `grep -rnE 'fetch\(|https?://|anthropic|openai' src/context.ts src/extract-files.ts` — no matches
- [ ] Full quality gate passes — check: `bun test` — exits 0; `bun run typecheck` — exits 0; `bun run lint` — exits 0; `bun run format:check` — exits 0; `bun run build` — exits 0 (last four mirror CI; `bun test` is local-only since CI does not run tests)

## Scope Boundaries

### In Scope

**MVP**

- `getContextPrimer(repoRoot, opts)` two-tier extractor (reuses `queryDateRange` pattern in `cache.ts`).
- Worktree-aware resolution + cross-worktree aggregation — `git-common-dir` resolver replacing the brittle `../.git`+`.bare` match (`cli.ts:79`); boundary-aware cwd fix for the confirmed sibling-capture bug (`scanner.ts:43`, `cache.ts:285/313`); per-session branch labels; default aggregates all worktrees. (Also changes existing search/scan behavior — intentional; existing search tests must stay green.)
- Cross-tool `extractFiles` for Claude, Codex, and Pi — net-new (no tool-call parsing exists today). Codex/Pi shapes reverse-engineered from real logs (top risk).
- Index-time precompute: `files_touched` + closing messages (both roles), `SCHEMA_VERSION` 2→3 (destructive reindex).
- Per-session data: intent, files, opening, closing (last user AND last assistant) — served from indexed columns.
- `get_context_primer` MCP tool (zod raw-shape, JSON output).
- `sessions context` CLI command (markdown to stdout; dispatch modeled on the `report` block in repo-root `index.ts:41`; flags via a new `src/context.ts`).
- `context` skill (`SKILL.md`) — synthesizes prose, anchors open threads on the most-recent closing state.
- Tests: per-tool `extractFiles` + fixture-based primer + CLI/MCP output (`bun test`, local-only).

**Full**

- CLI flags: `--limit`, `--days`, `--tool`, `--full`, `--worktree`.
- Empty-state and headline-cap handling.
- Plugin packaging: embed skill + advertise `/context` in `sessions setup`.

**Stretch**

- Opt-in SessionStart hook for auto-injection (wired into `sessions setup`, default off).
- `--out PRIMER.md` write-to-file convenience.

### Out of Scope

- LLM call inside the binary — breaks the static-binary / no-runtime moat; synthesis lives in the consuming agent.
- Team / shared / cloud context layer — Nessie's multi-user direction; a different product, would blow up local-CLI simplicity.
- Deterministic decision / open-thread detection in code — that synthesis is the agent's job via the skill.

### Future Considerations

- Topic-axis primer — cross-repo, organized by concept rather than repo.
- Decision provenance extraction (what was decided and why).
- Broader tool ingestion: Cursor, Windsurf, Aider, Gemini CLI logs.
- Read-on-demand serving fallback — considered and rejected 2026-06-19 in favor of precompute; revisit if the destructive reindex proves too heavy for large corpora.

## Execution Plan

### Dependency Graph

```
Phase 1: Extraction core
  └── Phase 2: Surfaces + skill  (blocked by Phase 1)
        └── Phase 3: SessionStart auto-injection hook  (blocked by Phase 2, stretch)
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, walks the dependency chain, and gates on failure:

```bash
/ideation:autopilot docs/ideation/sessions-context/contract.md
```

**Or run phases manually** in dependency order:

**Strategy**: Sequential

1. **Phase 1** — Extraction core _(blocking, high risk)_

   ```bash
   /ideation:execute-spec docs/ideation/sessions-context/spec-phase-1.md
   ```

2. **Phase 2** — Surfaces + skill _(blocked by Phase 1)_

   ```bash
   /ideation:execute-spec docs/ideation/sessions-context/spec-phase-2.md
   ```

3. **Phase 3** — SessionStart auto-injection hook _(blocked by Phase 2, stretch)_

   ```bash
   /ideation:execute-spec docs/ideation/sessions-context/spec-phase-3.md
   ```

---

_Approved 2026-06-19 by Nick Nisi. Rebuilt from the prior HTML-only contract under ideation v0.15 guidelines._
