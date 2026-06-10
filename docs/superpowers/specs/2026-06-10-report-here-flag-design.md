# `sessions report --here` — scope report to current project

**Date:** 2026-06-10
**Status:** Approved

## Goal

Let `sessions report` be scoped to the project the user is standing in. Default behavior (no flag) is unchanged: the report covers every project.

## CLI

- New boolean flag: `--here`.
- No value taken. Scoping to a project you're *not* in is out of scope (a future `--project <name>` could coexist without breaking `--here`).

## Behavior

- `ReportOptions` gains `here?: boolean` and `cwd?: string` (defaults to `process.cwd()` at the use site; injectable for tests, same pattern as `now?`).
- In `runReport` (`src/report/index.ts`), when `here` is set:
  - `target = resolveProject(cwd)` using the existing vendored `resolveProject()` (`src/report/project.ts`).
  - Filter events to those where `resolveProject(e.projectPath) === target`, applied alongside the existing date-range filter.
- Reusing `resolveProject` on both sides keeps flag and event data consistent: matching is by project *name* (`~/Developer/<repo>` → repo name, else basename of cwd).
- Events with no `projectPath` resolve to `unknown` and are excluded when `--here` is active.
- Empty-result warning mentions the project name when `--here` is active.

## Non-goals / invariants

- JSON output schema unchanged (schemaVersion 2, vendored tokenmaxing contract). A scoped report is just a report built from fewer events; the JSON does not record that it was scoped.
- No change to default (unscoped) behavior, HTML rendering, or aggregation logic.

## Known limitations (accepted)

- Name-based matching: two repos with the same basename in different locations merge. Already true of the per-project breakdown; `--here` doesn't worsen it.
- Sessions whose logs lack a cwd silently drop out of a scoped report.

## Testing

- Arg parsing: `--here` sets the flag; absence leaves it unset.
- Filtering: events from other projects and `unknown`-cwd events are dropped; same-project events kept.
- cwd injection: `opts.cwd` overrides `process.cwd()`.
- Default path: without `--here`, results identical to before.
