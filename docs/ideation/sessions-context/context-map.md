# Context Map: sessions-context

**Phase**: 3
**Scout Confidence**: 88/100
**Verdict**: GO

## Dimensions

| Dimension            | Score | Notes                                                                                                                                                                                                       |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | 18/20 | New: `src/hooks.ts`, `src/hooks.test.ts`. Modified: `src/setup.ts` (--hooks opt-in + uninstall), `src/cli.ts` (help text), `src/context.ts` (--hook mode), `index.ts` (no change needed — reuse `context`). |
| Pattern familiarity  | 18/20 | `configureMcp` and uninstall path in `src/setup.ts` establish the JSON read→merge→write idempotent pattern. `parseContextArgs` establishes arg-flag pattern.                                                |
| Dependency awareness | 18/20 | `runContext`/`parseContextArgs` consumed by `index.ts` `context` branch and `context.test.ts`. `runSetup`/`runUninstall` consumed by `index.ts`. No other consumers.                                        |
| Edge case coverage   | 17/20 | Hook outside repo → empty/exit0; idempotent enable; preserve unrelated hooks on disable; unparseable settings → no corruption.                                                                              |
| Test strategy        | 17/20 | `bun test src/hooks.test.ts` over a temp settings file. Matches `context.test.ts` temp-dir fixture pattern.                                                                                                 |

## Key Patterns

- `src/setup.ts:110-134` (`configureMcp`) — read JSON (tolerate missing/unparseable with try/catch), merge into a nested key, `mkdirSync(dirname)`, write `JSON.stringify(_, null, 2) + '\n'`. Replicate for hooks.
- `src/setup.ts:207-237` (`runUninstall`) — delete a specific nested key, write back; tolerate errors.
- `src/context.ts:46-102` (`parseContextArgs`) — switch-based arg parser; add `--hook` branch.
- `src/context.ts:145-171` (`runContext`) — resolve repo, build primer, render. `--hook` mode must never throw and exit 0 on no repo.

## Dependencies

- `src/context.ts` (`runContext`, `parseContextArgs`) — consumed by → `index.ts` (`context` branch), `src/context.test.ts`.
- `src/setup.ts` (`runSetup`, `runUninstall`) — consumed by → `index.ts` (`setup`, `uninstall`, `cleanup` branches).
- `src/cli.ts` (`usage`) — help text only.

## Conventions

- **Naming**: camelCase functions, kebab-case files. Test files `*.test.ts` next to source.
- **Imports**: relative (`./repo`, `./types`); node builtins via `node:` prefix.
- **Error handling**: try/catch that swallows to a boolean success, or `die()` for fatal CLI errors. Hook mode must NOT call `die` — exit 0.
- **Types**: `interface` for shapes, `type` for unions. `Tool = 'claude' | 'pi' | 'codex'`.
- **Testing**: `bun:test` (`describe/test/expect`), temp dirs via `mkdtempSync(tmpdir())`, cleaned in `afterAll`.

## Risks

- Spec references `SupportedTool` which does not exist. Claude Code is the only confirmed target; use a narrow local type/literal rather than inventing a broad union. Codex/Cursor session-start hook schemas are unconfirmed → Claude-only.
- Claude Code settings: `~/.claude/settings.json`, `hooks.SessionStart` is an array of `{ matcher?, hooks: [{ type:'command', command, timeout }] }`. Confirmed by existing `SessionEnd` entry in the user's own settings.
- `runUninstall` already `rmSync`s the whole `~/.local/share/sessions` dir but NOT `~/.claude/settings.json`; the hook lives in settings.json, so disable must explicitly edit settings.json.
- Hook command must be stable/idempotent — tag by exact command string `sessions context --hook`.
