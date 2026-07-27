# Implementation Spec: Memory Hygiene & Measured Retrieval - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: S
**Prerequisite**: Phase 1 (Durability hygiene) — `--no-refresh` sits on the refresh path the marker adds.

## Technical Approach

The capability already exists; it is only reachable over MCP. `search_sessions` returns structured JSON to any agent, while the CLI pipes the same results into `fzf` and offers no machine-readable form. A shell script, a statusline, or an editor plugin cannot get a ranked result without speaking MCP over stdio or opening the SQLite file directly. That is the whole gap: not a missing capability, a missing surface on the one it has.

The fix is small because `formatResult` (src/search-format.ts:33) is **already** the shared serializer — `src/mcp.ts:52` maps results through it before stringifying. A CLI `--json` reuses that exact function, so the two surfaces cannot drift. The metrics regression earlier in this branch is the cautionary tale: two code paths answering the same question is how `get_session_metrics` ended up UTC-wrong on one side only.

Three additions, all thin: a `search` subcommand (there is no such command word today — `index.ts` dispatches `cleanup|setup|uninstall|report|wrapped|context|lessons|digest|export` and a bare query falls through to the picker), a versioned envelope matching the `UsageReport` convention, and grep-style exit codes so a script can branch.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **`--json` covers search and context only, behind a versioned envelope** — rejected: adding `--json` to all four read commands. Only search and context have named consumers (shell/jq scripting and a statusline); `lessons` already emits JSON via `lessons export`, leaving `digest` as the sole genuine gap with nobody asking for it.
- **No network, daemon, or HTTP surface of any kind** — rejected: a localhost daemon or socket to amortize process startup. Measured 65ms warm end-to-end makes a subprocess fine for every local consumer, SQLite already handles concurrent readers, and a daemon reintroduces the orphan-process failure this repo already fixed once.
- **`--no-refresh` ships unconditionally** — rejected: making it contingent on measuring phase 1's marker. A caller that wants a stale-but-instant answer needs a way to say so regardless of how good the marker is; the marker changes how often the flag matters, not whether it exists. Leaving it contingent also made the contract self-contradictory, since a criterion requires it.
- **Acceptance commands run against temp stores and the fixture corpus, never the real ones** — rejected: the first draft's commands, which depended on the operator's own history containing a search term.

## Feedback Strategy

**Inner-loop command**: `bun test src/json-output.test.ts`

**Playground**: The CLI itself, over the eval fixture corpus with `SESSIONS_CACHE_DIR` and `SESSIONS_CLAUDE_DIR` pointed at temp/fixture paths — the tool is its own playground for a CLI surface.

**Why this approach**: Every change is observable as bytes on stdout and an exit code. A test that spawns the binary and parses its output checks exactly what a consumer will experience.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/json-output.test.ts` | Envelope shape, exit codes, `--no-refresh` behavior, MCP/CLI parity |

### Modified Files

| File Path | Changes |
| --- | --- |
| `index.ts` | Dispatch a `search` subcommand; `--json` bypasses `selectSession` and the stderr spinner; set exit codes |
| `src/cli.ts` | Parse `--json` and `--no-refresh`; exit 2 on an unknown flag rather than the current generic `die` |
| `src/search-format.ts` | Add `envelope()` — wraps any payload in `{generator, version, ...}` |
| `src/context.ts` | A structured return shape for `--json`, alongside the existing markdown renderer |
| `src/cache.ts` | Honor a `noRefresh` option by skipping `ensureIndexFresh` |

## Implementation Details

### 1. The versioned envelope

**Pattern to follow**: `src/report/schema.ts:53` — `UsageReport` already establishes `{generator: 'sessions', version: 1, ...}`.

**Overview**: One helper, used by both JSON surfaces, so a consumer can pin a shape.

```typescript
// src/search-format.ts
export const JSON_ENVELOPE_VERSION = 1;

/** Every machine-readable CLI payload carries the same envelope, so a consumer
 *  can pin `version` and fail loudly on a shape change instead of silently
 *  misreading one. Mirrors the UsageReport convention in report/schema.ts. */
export function envelope<T extends object>(payload: T): T & { generator: 'sessions'; version: number } {
  return { generator: 'sessions', version: JSON_ENVELOPE_VERSION, ...payload };
}
```

**Key decisions**:
- `version` is the envelope's, not the tool's. It changes only when the payload shape breaks.
- Non-pretty `JSON.stringify` — indentation is pure token and byte cost on a machine surface, the same call the MCP handlers already make.

**Implementation steps**:
1. Add `JSON_ENVELOPE_VERSION` and `envelope()`.
2. Use it in both `search --json` and `context --json`.

**Feedback loop**: skipped — this is a five-line pure function covered by the consumers' tests.

### 2. The `search` subcommand and exit codes

**Pattern to follow**: `index.ts:99` (the `export` dispatch) for command-word handling; `src/cli.ts:106` for flag parsing.

**Overview**: `sessions search <query> [--json]`, added *alongside* the existing bare-query default so `sessions "foo"` keeps working. `--json` skips the interactive picker entirely.

```typescript
// index.ts
if (command === 'search') {
  const args = parseSearchArgs(Bun.argv.slice(3));
  const results = await searchSessions(args.query, { ...args.options, noRefresh: args.noRefresh });
  if (args.json) {
    writeStdoutFully(JSON.stringify(envelope({ query: args.query, results: results.map(formatResult) })));
    process.exit(results.length ? 0 : 1);   // grep semantics
  }
  // ...existing interactive path
}
```

**Key decisions**:
- **Grep exit codes**: `0` matches, `1` no matches, `2` error. Familiar to anyone who has scripted around `grep`, and it makes `if sessions search --json q >/dev/null; then` a useful branch. This requires changing `die()` for the search path to exit 2 rather than 1 — otherwise "no matches" and "bad flag" are indistinguishable.
- `--json` implies non-interactive: no `fzf`, no spinner, nothing on stderr that a pipe would capture.
- `writeStdoutFully` (src/stdout.ts) rather than `console.log` — the repo already has it because a piped stdout can truncate on exit.

**Implementation steps**:
1. `parseSearchArgs` in `src/cli.ts`; unknown flag → exit 2.
2. Dispatch `search` in `index.ts` before the bare-query fallback.
3. JSON branch: envelope, `writeStdoutFully`, exit code.
4. Confirm the bare-query path is untouched.

**Feedback loop**:
- **Playground**: the CLI over the fixture corpus.
- **Experiment**: `stripe` → exit 0 with results; `zzq-no-such-term` → exit 1, empty array; `--bogus-flag` → exit 2.
- **Check command**: `bun test src/json-output.test.ts`

### 3. `context --json` and `--no-refresh`

**Overview**: The primer already computes a structured value before rendering markdown; `--json` returns it instead of rendering. `--no-refresh` skips the source scan for latency-sensitive callers.

**Key decisions**:
- `--no-refresh` is observable, not just accepted: against an empty cache dir it must build **no index at all**. That is what the criterion asserts, because a flag that is parsed and ignored would otherwise pass.
- The flag lives on `SearchOptions` and short-circuits `ensureIndexFresh` (src/cache.ts:543).
- A stale or absent index with `--no-refresh` returns empty rather than erroring — a statusline wants a fast wrong-ish answer over a slow right one, and the envelope makes staleness detectable by the caller if it cares.

**Implementation steps**:
1. Add `noRefresh?: boolean` to the options; short-circuit in `ensureIndexFresh`.
2. Extract the primer's structured value; render markdown from it as today.
3. `context --json` emits `envelope(primer)`.

**Feedback loop**:
- **Playground**: the CLI with `SESSIONS_CACHE_DIR` at a fresh temp dir.
- **Experiment**: `context --json --no-refresh` → valid envelope AND no `index.db` created; without the flag → `index.db` appears.
- **Check command**: `bun test src/json-output.test.ts`

## API Design

```jsonc
// sessions search --json "stripe"
{
  "generator": "sessions",
  "version": 1,
  "query": "stripe",
  "results": [ /* FormattedResult[] — the same shape search_sessions returns over MCP */ ]
}
```

| Exit code | Meaning |
| --- | --- |
| `0` | One or more matches |
| `1` | No matches |
| `2` | Usage error (unknown flag, bad argument) |

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `src/json-output.test.ts` | Envelope shape and version; the three exit codes; `--no-refresh` builds no index; CLI/MCP parity |

**Key test cases**:
- `search --json` emits `generator: "sessions"`, `version: 1`, and a non-empty `results` array over the fixture corpus.
- Exit codes 0 / 1 / 2 are distinct.
- `--json` writes nothing to stderr and never invokes `fzf`.
- `context --json --no-refresh` against an empty cache dir creates no `index.db`.
- **Parity**: the CLI's `results[0]` deep-equals the MCP handler's first result for the same query — the guarantee that reusing `formatResult` is supposed to buy.
- A bare `sessions "query"` still reaches the interactive picker.

### Manual Testing

- [ ] `sessions search --json auth | jq '.results[0].resumeCommand'`
- [ ] `sessions context --json --no-refresh | jq '.lessons | length'`
- [ ] Time `sessions context --json --no-refresh` — should be well under the 65ms warm baseline.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| `search` subcommand | Shadows a real query | Someone searching for the word "search" | Query interpreted as a command | `sessions "search"` (quoted, bare) still reaches the picker; documented |
| `--json` | Truncated on a pipe | Large result set, consumer closes early | Invalid JSON | `writeStdoutFully`, already used for this reason |
| Exit codes | Script misreads no-match as error | Consumer assumes 0-or-fail | False alarm | Grep semantics are conventional; documented in `--help` and README |
| `--no-refresh` | Serves an empty result on a cold cache | First run with the flag | Statusline shows nothing | Documented: the flag trades freshness for latency by design |
| Envelope | Consumer pins `version` and we bump it | A future shape change | Consumer fails loudly | Intended — loud beats silent misreading |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test
bun run format:check
bun run build
```

## Rollout Considerations

- **Schema**: none.
- **Docs**: README gains a "Scripting" section — the envelope, the exit codes, `--no-refresh`.
- **Rollback**: purely additive. Removing the flags restores today's behavior; no persisted state changes.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
