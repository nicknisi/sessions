# Implementation Spec: sessions context — Phase 3 (SessionStart Auto-Injection — Stretch)

**Contract**: ./contract.md
**Estimated Effort**: M
**Prereq**: Phase 2 (`sessions context` CLI + `get_context_primer`) merged and green.
**Tier**: Stretch — this is the full re-injection vision, paid for on every session start, so it is **opt-in**.

## Technical Approach

Phases 1–2 make the primer _available on demand_. Phase 3 makes it _appear automatically_ at the start of a coding session, so past-you's context is in front of the agent without anyone asking.

The mechanism: an opt-in **SessionStart hook** that runs `sessions context --here` and injects its output as additional session context. The hook is registered through `sessions setup` (off by default) and is fully reversible through `sessions uninstall`.

Two deliberate constraints:

1. **Opt-in only.** Auto-injection costs tokens on every session. `sessions setup` must not enable it silently; it's behind an explicit choice (`sessions setup --hooks`, or an interactive prompt when run without flags).
2. **Cheap and bounded.** The hook calls the existing CLI with a tight default (`--limit` small) so startup stays fast and the injected context stays small. A slow or failing hook must never block session start — it degrades to injecting nothing.

The honest unknown here is the **hook registration surface per tool**: Claude Code, Codex, and Cursor expose session-start hooks differently (and some may not at all). This spec targets Claude Code first (best-understood), and treats other tools as follow-on once their hook contracts are confirmed.

## Feedback Strategy

**Inner-loop command**: `bun test src/hooks.test.ts`

**Playground**: The generated hook command, run by hand (`sessions context --here --limit 3`) to confirm its stdout is the exact payload the hook will inject; plus a unit test over the settings-merge logic.

**Why this approach**: The risky logic is _editing the user's settings safely_ (idempotent enable/disable without clobbering existing hooks) — a logic layer best tested in isolation. The injection payload is just the Phase-2 CLI output, already covered.

## File Changes

### New Files

| File Path           | Purpose                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/hooks.ts`      | `enableSessionHook()` / `disableSessionHook()` — idempotent settings merge for the SessionStart hook. |
| `src/hooks.test.ts` | Settings-merge unit tests (enable, re-enable, disable, preserve-existing-hooks).                      |

### Modified Files

| File Path                       | Changes                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/setup.ts`                  | Add `--hooks` opt-in (or interactive prompt) calling `enableSessionHook`; advertise the choice.               |
| `src/setup.ts` (uninstall path) | Call `disableSessionHook` so `sessions uninstall` removes the hook.                                           |
| `src/cli.ts`                    | Document the `setup --hooks` option in help text.                                                             |
| `index.ts` (repo root)          | If a hidden helper subcommand is needed (e.g. `sessions context --hook`), wire it; otherwise reuse `context`. |

### Deleted Files

None.

## Implementation Details

### Component 1 — Hook payload (reuse `sessions context`)

**Overview**: The hook runs the Phase-2 CLI. No new rendering. A `--hook` mode may trim the output further (headlines-only or a hard size cap) so startup context stays minimal.

**Key decisions**:

- **Reuse `runContext`** with hook-tuned defaults (small `--limit`, maybe headlines suppressed). Add a `--hook` flag that sets those defaults and guarantees exit 0 + empty output when there's no repo/history (a hook must never error at session start).
- **Boundedness**: hook mode caps total output (e.g. ≤ ~1.5k tokens worth) so it's a primer, not a transcript.

**Implementation steps**:

1. Add a `--hook` branch to `parseContextArgs`/`runContext` (tight defaults, never-throw, empty-on-nothing).
2. Verify `sessions context --hook` prints fast and small in this repo.

**Feedback loop**:

- **Playground**: run `sessions context --hook` by hand.
- **Experiment**: in a repo with history → small primer; in `/tmp` (no repo) → empty output, exit 0.
- **Check command**: `bun run dev context --hook`

### Component 2 — Idempotent settings merge (`src/hooks.ts`)

**Pattern to follow**: `src/setup.ts` (existing config-writing: `writeMarketplaceJson`, MCP-config merge) — read JSON, merge, write, never clobber unrelated keys.

**Overview**: Enable/disable the SessionStart hook in the target tool's settings without disturbing existing hooks.

```typescript
export function enableSessionHook(tool: SupportedTool): { changed: boolean };
export function disableSessionHook(tool: SupportedTool): { changed: boolean };
// Reads the tool's settings JSON, adds/removes a tagged SessionStart hook entry
// (command: "sessions context --hook"), preserving any other hooks. Idempotent.
```

**Key decisions**:

- **Tag the entry** (a stable marker/comment field or a recognizable command string) so enable is idempotent and disable removes exactly our entry, never the user's other hooks.
- **Claude Code first.** The Claude Code SessionStart hook injects the command's stdout as additional context. Confirm the exact settings location and schema (`~/.claude/settings.json` hooks block) during implementation — see Open Items.
- **Fail safe.** If the settings file is missing/unparseable, create-or-skip with a clear message rather than corrupting it.

**Implementation steps**:

1. Define the tagged hook entry shape for Claude Code.
2. `enableSessionHook`: load → ensure SessionStart array → add tagged entry if absent → write.
3. `disableSessionHook`: load → drop tagged entry → write.
4. Wire both into `setup.ts` (`--hooks` / uninstall).

**Feedback loop**:

- **Playground**: `src/hooks.test.ts` operating on a temp settings file.
- **Experiment**: enable on empty settings → entry present; enable twice → still one entry (idempotent); pre-existing unrelated hook survives enable+disable; disable → entry gone, others intact.
- **Check command**: `bun test src/hooks.test.ts`

### Component 3 — `setup --hooks` opt-in (`src/setup.ts`)

**Overview**: Surface the choice during setup, off by default.

**Key decisions**:

- **Default off.** `sessions setup` alone does NOT enable the hook. `sessions setup --hooks` enables it; without flags, optionally prompt interactively (only when a TTY).
- **Advertise reversibility**: tell the user `sessions uninstall` removes it.

**Feedback loop**: None (wiring; covered by the manual checklist).

## Data Model

No schema changes. Configuration only.

## Testing Requirements

### Unit Tests

| Test File           | Coverage                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `src/hooks.test.ts` | enable/disable idempotency; preservation of pre-existing hooks; missing-file safety. |

**Key test cases**:

- Enable on empty/missing settings → creates the tagged entry.
- Enable twice → exactly one entry.
- Disable → removes only the tagged entry; an unrelated user hook remains.
- Unparseable settings → no corruption, clear failure.

### Manual Testing

- [ ] `sessions setup --hooks` enables; starting a new Claude Code session in a repo with history shows the primer injected.
- [ ] Starting a session in a fresh repo injects nothing and does not error.
- [ ] `sessions uninstall` removes the hook; sessions start clean.
- [ ] Hook startup feels instant (sub-second) and the injected block is small.

## Error Handling

| Error Scenario                                 | Handling Strategy                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Hook runs outside a git repo                   | `--hook` mode prints nothing, exits 0 — no session-start error.           |
| `sessions` binary not on PATH at session start | Hook is a no-op for that session; document PATH requirement.              |
| Settings file unparseable                      | Abort the enable/disable with a clear message; never write garbage.       |
| Index rebuild mid-hook (post-upgrade)          | First session after upgrade may inject nothing; subsequent sessions fine. |

## Failure Modes

| Component      | Failure Mode                            | Trigger                            | Impact                                    | Mitigation                                                |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Hook payload   | Slow startup                            | Large repo / no `--limit` cap      | Laggy session start                       | `--hook` enforces tight defaults + size cap.              |
| Settings merge | Clobbers user's existing hooks          | Naive overwrite of the hooks block | User loses their config                   | Tagged-entry add/remove; preservation test locks it.      |
| Opt-in         | Silently enabled                        | Enabling inside plain `setup`      | Surprise token cost every session         | Default off; explicit `--hooks` / TTY prompt only.        |
| Cross-tool     | Codex/Cursor hook schema differs/absent | Assuming Claude's shape everywhere | Hook silently does nothing on those tools | Ship Claude Code first; gate others on confirmed schemas. |

## Rollout Considerations

- **Feature flag**: the hook itself is the opt-in; no separate flag.
- **Rollback**: `sessions uninstall` (and `disableSessionHook`) fully removes it.
- **Docs**: README note on what the hook injects, its cost, and how to disable.

## Open Items

- [ ] **Confirm the Claude Code SessionStart hook contract** — exact settings path/schema and how stdout becomes `additionalContext`. This is the gating unknown for the whole phase.
- [ ] Decide enablement UX: `--hooks` flag only, or also an interactive TTY prompt in `setup`.
- [ ] Decide hook output shape: full primer vs headlines-only vs a hard token cap.
- [ ] Defer/confirm Codex + Cursor support until their session-start hook contracts are verified (may be out of reach → Claude-only stretch).

---

_This spec is ready for implementation, but resolve the Claude Code hook-contract Open Item first — it determines Component 2's entry shape._
