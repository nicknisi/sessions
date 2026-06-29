# Search Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sessions` search faster and better by indexing commands/paths/errors/thinking into FTS5 with per-column weighting, unifying the CLI onto the same engine as the MCP, and hardening the index.

**Architecture:** New pure per-tool extractors (mirroring `src/extract-files.ts`) feed new structured + FTS columns populated during the existing `indexFile` pass in `src/cache.ts`. `searchSessions` gains weighted ranking, an `errored` filter, and per-result metadata. The CLI routes through `searchSessions` instead of the live filesystem scanner. A shared `src/search-format.ts` module (resume command + result formatting) is consumed by both the CLI and the MCP so the two surfaces can't drift.

**Tech Stack:** TypeScript, Bun (runtime + `bun:sqlite` + `bun test`), SQLite FTS5 (`porter unicode61`), `@modelcontextprotocol/sdk`, `zod`.

## Global Constraints

- **No new runtime dependencies.** Only `@modelcontextprotocol/sdk` and `zod` are allowed (current `dependencies`). No network, no LLM calls, no embedding models.
- **Single compiled binary.** Everything must work under `bun build --compile`.
- **Tokenizer stays `porter unicode61`.**
- **Schema migrations are destructive reindexes** keyed on `PRAGMA user_version` — the established pattern in `getDb()`. Bump the constant; let `getDb()` drop + rebuild.
- **Pure extractors live in their own `src/extract-*.ts` files, mirror `src/extract-files.ts`** (per-tool branches, a `push` that dedups + caps), and are unit-tested with inline JSONL.
- **Caps:** `MAX_COMMANDS = 100`, `MAX_FILES = 50` (existing), thinking length-capped.
- **Verification gate (every task ends green):** `bun test` exits 0; `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build` all exit 0.
- **Commits:** conventional-commit messages, one per task.

---

## File Structure

**Create:**

- `src/extract-commands.ts` — `extractCommands(lines, tool) → string[]` (Bash/exec commands).
- `src/extract-errors.ts` — `extractErrors(lines, tool) → SessionErrors` (error flag/count/messages).
- `src/extract-thinking.ts` — `extractThinking(lines, tool) → string` (reasoning text).
- `src/search-format.ts` — `buildResumeCommand()` + `formatResult()` shared by CLI and MCP.
- Tests: `src/extract-commands.test.ts`, `src/extract-errors.test.ts`, `src/extract-thinking.test.ts`, `src/search-format.test.ts`, `src/cache.search.test.ts`, `src/cli.test.ts`.

**Modify:**

- `src/extract-files.ts` — add `extractFilesRead(lines, tool) → string[]` (Read/Grep/Glob targets).
- `src/types.ts` — extend `SessionResult` (`files`, `commands`, `errored`); extend `CliArgs` (`errored`).
- `src/cache.ts` — `SCHEMA_VERSION` 5→6, new columns on both tables, `indexFile` population, `searchSessions` (options object + weighted bm25 + `errored` filter + metadata), `getDb` hardening, `closeDb`/`getDbPath` test helpers.
- `src/cli.ts` — parse `--errored`; add `toSearchOptions()`.
- `index.ts` — route the main path through `searchSessions`; use the shared resume builder.
- `src/display.ts` — show an errored marker.
- `src/scanner.ts` — populate the new `SessionResult` fields (kept as a no-index fallback).
- `src/mcp.ts` — extract the search handler to a testable function; add `errored`; return metadata + `resumeCommand`.

---

### Task 1: `extractCommands`

**Files:**

- Create: `src/extract-commands.ts`
- Test: `src/extract-commands.test.ts`

**Interfaces:**

- Produces: `extractCommands(lines: string[], tool: Tool): string[]`; `MAX_COMMANDS: number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/extract-commands.test.ts
import { test, expect } from 'bun:test';
import { extractCommands, MAX_COMMANDS } from './extract-commands';

const j = (o: unknown): string => JSON.stringify(o);

test('claude: extracts Bash commands, ignores other tools', () => {
  const lines = [
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
    }),
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
    }),
  ];
  expect(extractCommands(lines, 'claude')).toEqual(['bun test']);
});

test('codex: dual recording (function_call + exec_command_end) yields each command once', () => {
  const lines = [
    j({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":["docker","compose","up"]}',
        call_id: 'c1',
      },
    }),
    j({ type: 'event_msg', payload: { type: 'exec_command_end', command: 'docker compose up', exit_code: 0 } }),
  ];
  expect(extractCommands(lines, 'codex')).toEqual(['docker compose up']);
});

test('pi: extracts bashExecution commands', () => {
  const lines = [
    j({
      type: 'message',
      id: '1',
      parentId: null,
      message: { role: 'bashExecution', command: 'npm run build', output: 'ok', exitCode: 0 },
    }),
  ];
  expect(extractCommands(lines, 'pi')).toEqual(['npm run build']);
});

test('dedups identical commands and caps at MAX_COMMANDS', () => {
  const dup = Array.from({ length: 3 }, () =>
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
  );
  expect(extractCommands(dup, 'claude')).toEqual(['ls']);
  const many = Array.from({ length: MAX_COMMANDS + 50 }, (_, i) =>
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `cmd${i}` } }] },
    }),
  );
  expect(extractCommands(many, 'claude').length).toBe(MAX_COMMANDS);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/extract-commands.test.ts`
Expected: FAIL — `Cannot find module './extract-commands'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/extract-commands.ts
import type { Tool } from './types';

/** Upper bound on stored distinct commands per session (bounds the indexed column). */
export const MAX_COMMANDS = 100;

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Claude: assistant `message.content[]` tool_use named `Bash` → `input.command`.
function extractClaude(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
      const input = b.input as Record<string, unknown> | undefined;
      const cmd = input?.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    }
  }
}

// Codex: read the canonical `exec_command_end.command` only. The same exec also
// appears as a `response_item` `function_call`; reading a single source is the
// de-duplication (the shared seen-set also collapses identical repeats).
function extractCodex(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const p = d.payload as Record<string, unknown> | undefined;
    if (!p || p.type !== 'exec_command_end') continue;
    const cmd = p.command;
    if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    else if (Array.isArray(cmd)) {
      const joined = cmd
        .filter((x) => typeof x === 'string')
        .join(' ')
        .trim();
      if (joined) push(joined);
    }
  }
}

// Pi: the dedicated `bashExecution` channel, plus a `bash` toolCall block.
function extractPi(lines: string[], push: (c: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'bashExecution') {
      const cmd = msg.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'toolCall' || b.name !== 'bash') continue;
      const argsObj = b.arguments as Record<string, unknown> | undefined;
      const cmd = argsObj?.command;
      if (typeof cmd === 'string' && cmd.trim()) push(cmd.trim());
    }
  }
}

/** De-duplicated, order-preserving, capped list of shell commands run in a session. */
export function extractCommands(lines: string[], tool: Tool): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (c: string): void => {
    if (seen.has(c) || out.length >= MAX_COMMANDS) return;
    seen.add(c);
    out.push(c);
  };
  if (tool === 'claude') extractClaude(lines, push);
  else if (tool === 'codex') extractCodex(lines, push);
  else if (tool === 'pi') extractPi(lines, push);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/extract-commands.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-commands.ts src/extract-commands.test.ts
git commit -m "feat(extract): commands extractor for claude/codex/pi"
```

---

### Task 2: `extractErrors`

**Files:**

- Create: `src/extract-errors.ts`
- Test: `src/extract-errors.test.ts`

**Interfaces:**

- Produces: `extractErrors(lines: string[], tool: Tool): SessionErrors` where `interface SessionErrors { errored: boolean; count: number; messages: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/extract-errors.test.ts
import { test, expect } from 'bun:test';
import { extractErrors } from './extract-errors';

const j = (o: unknown): string => JSON.stringify(o);

test('claude: tool_result is_error flags an errored session', () => {
  const lines = [
    j({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'command not found' }],
      },
    }),
  ];
  const r = extractErrors(lines, 'claude');
  expect(r.errored).toBe(true);
  expect(r.count).toBe(1);
  expect(r.messages[0]).toContain('command not found');
});

test('claude: a clean session is not errored', () => {
  const lines = [
    j({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
    }),
  ];
  expect(extractErrors(lines, 'claude')).toEqual({ errored: false, count: 0, messages: [] });
});

test('codex: non-zero exit_code is an error', () => {
  const lines = [
    j({ type: 'event_msg', payload: { type: 'exec_command_end', command: 'x', exit_code: 1, stderr: 'boom' } }),
  ];
  expect(extractErrors(lines, 'codex').errored).toBe(true);
});

test('pi: toolResult isError is an error', () => {
  const lines = [
    j({
      type: 'message',
      message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'nope' }] },
    }),
  ];
  const r = extractErrors(lines, 'pi');
  expect(r.errored).toBe(true);
  expect(r.messages[0]).toContain('nope');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/extract-errors.test.ts`
Expected: FAIL — `Cannot find module './extract-errors'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/extract-errors.ts
import type { Tool } from './types';

export const MAX_ERROR_MESSAGES = 20;
export const MAX_ERROR_LEN = 300;

export interface SessionErrors {
  errored: boolean;
  count: number;
  messages: string[];
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string'
          ? (c as Record<string, string>).text
          : '',
      )
      .join(' ')
      .trim();
  }
  return '';
}

function extractClaude(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    if (d.isApiErrorMessage) {
      push(textOf((d.message as Record<string, unknown> | undefined)?.content) || 'api error');
      continue;
    }
    if (d.type !== 'user') continue;
    const content = (d.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && b.is_error === true) push(textOf(b.content) || 'tool error');
    }
  }
}

function extractCodex(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    const p = d.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    if (p.type === 'exec_command_end' && typeof p.exit_code === 'number' && p.exit_code !== 0) {
      push(textOf(p.stderr) || textOf(p.formatted_output) || `exit ${p.exit_code}`);
    } else if (p.type === 'error') {
      push(textOf(p.message) || 'error');
    }
  }
}

function extractPi(lines: string[], push: (m: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'message') continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (msg.role === 'toolResult' && msg.isError === true) push(textOf(msg.content) || 'tool error');
    else if (msg.role === 'assistant' && typeof msg.errorMessage === 'string' && msg.errorMessage)
      push(msg.errorMessage);
    else if (msg.role === 'bashExecution' && typeof msg.exitCode === 'number' && msg.exitCode !== 0)
      push(textOf(msg.output) || `exit ${msg.exitCode}`);
  }
}

/** Whether (and how) a session hit errors — drives the `errored` filter + `context_text` FTS column. */
export function extractErrors(lines: string[], tool: Tool): SessionErrors {
  const messages: string[] = [];
  let count = 0;
  const push = (m: string): void => {
    count++;
    if (messages.length < MAX_ERROR_MESSAGES) messages.push(m.slice(0, MAX_ERROR_LEN));
  };
  if (tool === 'claude') extractClaude(lines, push);
  else if (tool === 'codex') extractCodex(lines, push);
  else if (tool === 'pi') extractPi(lines, push);
  return { errored: count > 0, count, messages };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/extract-errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-errors.ts src/extract-errors.test.ts
git commit -m "feat(extract): error-signal extractor for claude/codex/pi"
```

---

### Task 3: `extractThinking`

**Files:**

- Create: `src/extract-thinking.ts`
- Test: `src/extract-thinking.test.ts`

**Interfaces:**

- Produces: `extractThinking(lines: string[], tool: Tool): string`; `MAX_THINKING_LEN: number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/extract-thinking.test.ts
import { test, expect } from 'bun:test';
import { extractThinking } from './extract-thinking';

const j = (o: unknown): string => JSON.stringify(o);

test('claude: collects thinking block text', () => {
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'consider memoization' },
          { type: 'text', text: 'done' },
        ],
      },
    }),
  ];
  expect(extractThinking(lines, 'claude')).toBe('consider memoization');
});

test('pi: collects thinking from assistant content', () => {
  const lines = [
    j({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pi reasoning' }] } }),
  ];
  expect(extractThinking(lines, 'pi')).toBe('pi reasoning');
});

test('codex: reasoning is encrypted, returns empty', () => {
  const lines = [j({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'xxxx' } })];
  expect(extractThinking(lines, 'codex')).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/extract-thinking.test.ts`
Expected: FAIL — `Cannot find module './extract-thinking'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/extract-thinking.ts
import type { Tool } from './types';

export const MAX_THINKING_LEN = 20_000;

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collect(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || (d.type !== 'assistant' && d.type !== 'message')) continue;
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    }
  }
  return parts.join('\n').slice(0, MAX_THINKING_LEN);
}

/**
 * Plaintext reasoning text for the (low-weighted) `thinking` FTS column. Claude and
 * Pi store `thinking` blocks in assistant content; Codex reasoning is encrypted in
 * the logs, so Codex returns empty.
 */
export function extractThinking(lines: string[], tool: Tool): string {
  if (tool === 'codex') return '';
  return collect(lines);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/extract-thinking.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-thinking.ts src/extract-thinking.test.ts
git commit -m "feat(extract): thinking-text extractor (claude/pi; codex empty)"
```

---

### Task 4: `extractFilesRead` (extend `extract-files.ts`)

**Files:**

- Modify: `src/extract-files.ts`
- Test: `src/extract-files.test.ts` (append)

**Interfaces:**

- Consumes: `MAX_FILES` (existing), `tryParse` (existing, file-local).
- Produces: `extractFilesRead(lines: string[], tool: Tool): string[]`.

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// src/extract-files.test.ts — append
import { extractFilesRead } from './extract-files';

test('read: claude Read/Grep targets, separate from edited files', () => {
  const j = (o: unknown): string => JSON.stringify(o);
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/cache.ts' } }],
      },
    }),
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/parser.ts' } }],
      },
    }),
  ];
  expect(extractFilesRead(lines, 'claude')).toEqual(['/repo/src/cache.ts']);
  expect(extractFiles(lines, 'claude')).toEqual(['/repo/src/parser.ts']);
});
```

(If `extractFiles` is not already imported at the top of the test file, add it to the existing import from `./extract-files`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/extract-files.test.ts -t "read"`
Expected: FAIL — `extractFilesRead is not a function` / not exported.

- [ ] **Step 3: Write the minimal implementation (append to `src/extract-files.ts`)**

```ts
// src/extract-files.ts — append (reuses the file-local tryParse + MAX_FILES)

/** Claude: read-only tool_use targets (Read/Grep/Glob), kept separate from edits. */
const CLAUDE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function extractClaudeRead(lines: string[], push: (p: string) => void): void {
  for (const line of lines) {
    const d = tryParse(line);
    if (!d || d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use' || typeof b.name !== 'string' || !CLAUDE_READ_TOOLS.has(b.name)) continue;
      const input = b.input as Record<string, unknown> | undefined;
      const path = input?.file_path ?? input?.path ?? input?.pattern;
      if (typeof path === 'string' && path) push(path);
    }
  }
}

/**
 * Read/searched (not edited) file targets, for the searchable `paths` column.
 * Codex/Pi read-target shapes need fixtures to confirm — deliberate no-op until
 * then, mirroring the edited-files Pi no-op.
 */
export function extractFilesRead(lines: string[], tool: Tool): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (path: string): void => {
    if (seen.has(path) || out.length >= MAX_FILES) return;
    seen.add(path);
    out.push(path);
  };
  if (tool === 'claude') extractClaudeRead(lines, push);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/extract-files.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/extract-files.ts src/extract-files.test.ts
git commit -m "feat(extract): read/grep file-target extractor (claude)"
```

---

### Task 5: Schema 5→6 + `indexFile` population

**Files:**

- Modify: `src/cache.ts` (`SCHEMA_VERSION`, both `CREATE TABLE`s, imports, `indexFile`)
- Create: `src/cache.search.test.ts` (hermetic harness + findability test)

**Interfaces:**

- Consumes: `extractCommands`, `extractErrors`, `extractThinking` (Tasks 1-3), `extractFiles`/`extractFilesRead` (Task 4).
- Produces: `session_fts` columns `headline, user_content, assistant_content, commands, paths, context_text, thinking` (this column order is load-bearing for Task 6's bm25 weights); `sessions` columns `files_read, commands, errored, error_count`.

- [ ] **Step 1: Write the failing test (hermetic harness)**

```ts
// src/cache.search.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts reads SESSIONS_* env at module load, so set env BEFORE importing it (dynamic import).
let tmp: string;
let cache: typeof import('./cache');

function writeClaude(claudeDir: string, id: string, cwd: string, records: unknown[]): void {
  const dir = join(claudeDir, 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => j({ ...(r as object), cwd })).join('\n');
  writeFileSync(join(dir, `${id}.jsonl`), lines);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cache-'));
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: ran "docker compose up", Read cache.ts, errored, thinking mentions "memoization".
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'a', '/repoA', [
    {
      type: 'user',
      timestamp: '2026-06-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'set up containers' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'docker compose up' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:02:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repoA/src/cache.ts' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:03:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'use memoization' }] },
    },
    {
      type: 'user',
      timestamp: '2026-06-01T10:04:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] },
    },
  ]);

  cache = await import('./cache');
  await cache.refreshIndex();
});

afterAll(() => {
  cache.closeDb?.();
  rmSync(tmp, { recursive: true, force: true });
});

test('indexes new content: a command query finds the session that ran it', async () => {
  const r = await cache.searchSessions('docker', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});

test('commands and paths are findable: a file-path query matches a Read target', async () => {
  const r = await cache.searchSessions('cache.ts', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cache.search.test.ts`
Expected: FAIL — `cache.closeDb is not a function` and/or the FTS table lacks the new columns so the file-path query returns nothing. (Tasks 5 and 10 both touch this file; `closeDb` is added in Task 10. For Step 4 here, comment out the `afterAll` body or expect the two `test(...)` assertions to pass even if `afterAll` errors — the findability assertions are what this task delivers.)

- [ ] **Step 3: Implement the schema + population changes in `src/cache.ts`**

Bump the version constant and its comment:

```ts
// Bump 5 -> 6: the FTS index gains headline/commands/paths/context_text/thinking
// columns and the sessions table gains files_read/commands/errored/error_count, so
// search can match (and weight) commands, file paths, errors, and reasoning. The
// virtual-table shape changes, so getDb drops + rebuilds on a user_version mismatch.
const SCHEMA_VERSION = 6;
```

Add imports near the existing `extractFiles` import:

```ts
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
```

Extend the `sessions` `CREATE TABLE` (add the four columns before `closing_user`):

```ts
      files_touched TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      errored INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      closing_user TEXT NOT NULL DEFAULT '',
```

Replace the `session_fts` `CREATE VIRTUAL TABLE` with the wider shape (column order matters):

```ts
db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      headline,
      user_content,
      assistant_content,
      commands,
      paths,
      context_text,
      thinking,
      tokenize = 'porter unicode61'
    )
  `);
```

In `indexFile`, after the existing `filesTouched` line, compute the new values:

```ts
const filesTouchedArr = extractFiles(lines, tool);
const filesTouched = JSON.stringify(filesTouchedArr);
const filesReadArr = extractFilesRead(lines, tool);
const filesRead = JSON.stringify(filesReadArr);
const commandsArr = extractCommands(lines, tool);
const commands = JSON.stringify(commandsArr);
const errors = extractErrors(lines, tool);
const thinking = extractThinking(lines, tool);
const headline = `${prompt}\n${title}`;
const pathsText = [...filesTouchedArr, ...filesReadArr].join('\n');
const commandsText = commandsArr.join('\n');
const contextText = errors.messages.join('\n');
```

(Remove the now-duplicated original `const filesTouched = JSON.stringify(extractFiles(lines, tool));` line.)

Replace the `sessions` INSERT with the wider column list:

```ts
db.run(
  `INSERT OR REPLACE INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count, files_touched, files_read, commands, errored, error_count, closing_user, closing_assistant, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    filePath,
    stat.mtimeMs,
    stat.size,
    cwd,
    tool,
    sessionId,
    date,
    createdAt,
    prompt,
    title,
    msgCount,
    filesTouched,
    filesRead,
    commands,
    errors.errored ? 1 : 0,
    errors.count,
    closing.user,
    closing.assistant,
    branch,
  ],
);
```

Replace the `session_fts` INSERT:

```ts
db.run(
  'INSERT INTO session_fts (file_path, headline, user_content, assistant_content, commands, paths, context_text, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [filePath, headline, fullContent, assistantContent, commandsText, pathsText, contextText, thinking],
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/cache.search.test.ts -t "findable"` and `bun test src/cache.search.test.ts -t "indexes new content"`
Expected: PASS. (Delete the stale `~/.cache/sessions/index.db` if running against a real home — the test uses a temp dir so this is N/A in CI.)

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts src/cache.search.test.ts
git commit -m "feat(index): schema 5->6 — index commands/paths/errors/thinking"
```

---

### Task 6: Weighted ranking, options object, `errored` filter, result metadata

**Files:**

- Modify: `src/types.ts` (`SessionResult`), `src/scanner.ts` (fallback defaults), `src/cache.ts` (`searchSessions`), `src/mcp.ts` (update the one call site to the new signature)
- Test: `src/cache.search.test.ts` (append)

**Interfaces:**

- Consumes: the schema from Task 5.
- Produces: `interface SearchOptions { tool?: Tool | ''; project?: string; errored?: boolean; limit?: number }`; `searchSessions(query: string, opts?: SearchOptions): Promise<SessionResult[]>`; `SessionResult` now has `files: string[]; commands: string[]; errored: boolean`.

- [ ] **Step 1: Write the failing test (append to `src/cache.search.test.ts`)**

Add to `beforeAll`, after Session A, a second clean session B whose only "docker" mention is in thinking, plus the writes:

```ts
writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'b', '/repoB', [
  {
    type: 'user',
    timestamp: '2026-06-02T10:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'thoughts' }] },
    promptSource: 'typed',
  },
  {
    type: 'assistant',
    timestamp: '2026-06-02T10:01:00Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'maybe docker later' }] },
  },
]);
```

Then append the tests:

```ts
test('ranking: a command hit outranks a thinking-only hit for the same term', async () => {
  const r = await cache.searchSessions('docker', {});
  const aIdx = r.findIndex((x) => x.sessionId === 'a');
  const bIdx = r.findIndex((x) => x.sessionId === 'b');
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThanOrEqual(0);
  expect(aIdx).toBeLessThan(bIdx); // A (command) ranked above B (thinking)
});

test('errored filter and metadata: only errored sessions, with files/commands/errored populated', async () => {
  const r = await cache.searchSessions('', { errored: true });
  expect(r.map((x) => x.sessionId)).toContain('a');
  expect(r.map((x) => x.sessionId)).not.toContain('b');
  const a = r.find((x) => x.sessionId === 'a')!;
  expect(a.errored).toBe(true);
  expect(a.commands).toContain('docker compose up');
  expect(a.files).toContain('/repoA/src/cache.ts'); // read target surfaced in metadata
});
```

(Adjust the file-path metadata expectation if you choose to expose only edited files in `files`; see Step 3.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cache.search.test.ts -t "ranking"` and `-t "errored filter"`
Expected: FAIL — `searchSessions` ignores `opts`/`errored`, results lack `files`/`commands`/`errored`.

- [ ] **Step 3: Implement**

In `src/types.ts`, extend `SessionResult`:

```ts
export interface SessionResult {
  date: string;
  createdAt: string;
  cwd: string;
  tool: Tool;
  sessionId: string;
  displayText: string;
  customTitle: string;
  messageCount: number;
  filePath: string;
  exists: boolean;
  files: string[];
  commands: string[];
  errored: boolean;
}
```

In `src/scanner.ts`, the fallback can't extract these — set empty defaults in **both** returned objects in `processSession` (add to each object literal):

```ts
      files: [],
      commands: [],
      errored: false,
```

In `src/cache.ts`, replace the `searchSessions` signature and body. New signature + options:

```ts
export interface SearchOptions {
  tool?: Tool | '';
  project?: string;
  errored?: boolean;
  limit?: number;
}

export async function searchSessions(query: string, opts: SearchOptions = {}): Promise<SessionResult[]> {
  const db = getDb();
  await refreshIndex();

  const toolFilter = opts.tool ?? '';
  const project = opts.project ?? '';
  const limit = opts.limit ?? 50;

  interface SessionRow {
    file_path: string;
    cwd: string;
    tool: string;
    session_id: string;
    date: string;
    created_at: string;
    first_prompt: string;
    custom_title: string;
    message_count: number;
    files_touched: string;
    commands: string;
    errored: number;
    snippet: string | null;
  }

  let rows: SessionRow[];

  const ftsTerms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`);
  const ftsQuery = ftsTerms.join(' OR ');

  // bm25 weights map to session_fts columns in declaration order:
  // file_path, headline, user_content, assistant_content, commands, paths, context_text, thinking.
  // Favor headline/commands/paths; de-emphasize verbose thinking so it adds recall without dominating.
  const RANK = 'bm25(session_fts, 0.0, 10.0, 3.0, 2.0, 6.0, 5.0, 2.0, 0.5)';

  if (ftsQuery) {
    const conditions: string[] = [];
    const params: (string | number)[] = [ftsQuery];
    if (toolFilter) {
      conditions.push('s.tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      conditions.push('(s.cwd = ? OR s.cwd GLOB ?)');
      params.push(project, globPrefix(project));
    }
    if (opts.errored) conditions.push('s.errored = 1');
    params.push(limit);

    const extra = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    rows = db
      .query<SessionRow, any[]>(
        `
      SELECT s.file_path, s.cwd, s.tool, s.session_id, s.date, s.created_at, s.first_prompt,
             s.custom_title, s.message_count, s.files_touched, s.commands, s.errored,
             snippet(session_fts, -1, '', '', '…', 32) as snippet
      FROM session_fts f
      JOIN sessions s ON s.file_path = f.file_path
      WHERE f.session_fts MATCH ?
      ${extra}
      ORDER BY ${RANK}
      LIMIT ?
    `,
      )
      .all(...params);
  } else {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (toolFilter) {
      conditions.push('tool = ?');
      params.push(toolFilter);
    }
    if (project) {
      conditions.push('(cwd = ? OR cwd GLOB ?)');
      params.push(project, globPrefix(project));
    }
    if (opts.errored) conditions.push('errored = 1');
    params.push(limit);

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    rows = db
      .query<SessionRow, any[]>(
        `
      SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
             custom_title, message_count, files_touched, commands, errored, NULL as snippet
      FROM sessions ${where}
      ORDER BY date DESC LIMIT ?
    `,
      )
      .all(...params);
  }

  return rows.map((r) => ({
    date: r.date,
    createdAt: r.created_at,
    cwd: r.cwd,
    tool: r.tool as Tool,
    sessionId: r.session_id,
    displayText: r.snippet ?? (r.custom_title || r.first_prompt),
    customTitle: r.custom_title,
    messageCount: r.message_count,
    filePath: r.file_path,
    exists: existsSync(r.cwd),
    files: parseFiles(r.files_touched),
    commands: parseFiles(r.commands),
    errored: r.errored === 1,
  }));
}
```

Note: `parseFiles` is defined later in `cache.ts` (function declaration, hoisted — safe to call here). The test in Step 1 expects a Read target in `files`; this implementation returns **edited** files (`files_touched`). Either change the test to assert `a.commands` only, or also include read files: `files: [...parseFiles(r.files_touched), ...parseFiles(r.files_read)]` and add `files_read` to the SELECT + `SessionRow`. Pick one and keep the test consistent. **Recommended:** include both (union) so `files` answers "what files did this session involve."

In `src/mcp.ts`, update the single call site to the new signature (keeps the build green; Task 9 enriches it):

```ts
const results = await searchSessions(query ?? '', { tool: tool ?? '', project: project ?? '', limit });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/cache.search.test.ts`
Expected: PASS (all cache tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/scanner.ts src/cache.ts src/mcp.ts src/cache.search.test.ts
git commit -m "feat(search): weighted ranking, options object, errored filter, result metadata"
```

---

### Task 7: Shared `search-format.ts` (resume command + result formatter)

**Files:**

- Create: `src/search-format.ts`
- Test: `src/search-format.test.ts`

**Interfaces:**

- Consumes: `SessionResult` (Task 6 shape), `Tool`.
- Produces: `buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string`; `formatResult(r: SessionResult): FormattedResult` where `FormattedResult` includes `sessionId, tool, date, createdAt, project, title, snippet, messageCount, files, commands, errored, exists, filePath, resumeCommand`.

- [ ] **Step 1: Write the failing test**

```ts
// src/search-format.test.ts
import { test, expect } from 'bun:test';
import { buildResumeCommand, formatResult } from './search-format';
import type { SessionResult } from './types';

test('buildResumeCommand: claude resumes, pi/codex cd only', () => {
  expect(buildResumeCommand('claude', '/r', 'abc')).toBe('cd /r && claude --resume abc');
  expect(buildResumeCommand('pi', '/r', 'abc')).toBe('cd /r');
  expect(buildResumeCommand('codex', '/r', 'abc')).toBe('cd /r');
});

test('formatResult: shapes a SessionResult for callers, including resumeCommand', () => {
  const r: SessionResult = {
    date: '2026-06-01',
    createdAt: '2026-06-01',
    cwd: '/r',
    tool: 'claude',
    sessionId: 'abc',
    displayText: 'snip',
    customTitle: 'Title',
    messageCount: 5,
    filePath: '/f.jsonl',
    exists: true,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
  };
  expect(formatResult(r)).toEqual({
    sessionId: 'abc',
    tool: 'claude',
    date: '2026-06-01',
    createdAt: '2026-06-01',
    project: '/r',
    title: 'Title',
    snippet: 'snip',
    messageCount: 5,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
    exists: true,
    filePath: '/f.jsonl',
    resumeCommand: 'cd /r && claude --resume abc',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/search-format.test.ts`
Expected: FAIL — `Cannot find module './search-format'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/search-format.ts
import type { SessionResult, Tool } from './types';

/** The exact resume affordance both the CLI (clipboard) and the MCP (returned field) use. */
export function buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string {
  if (tool === 'claude') return `cd ${cwd} && claude --resume ${sessionId}`;
  return `cd ${cwd}`; // pi, codex: no direct session resume
}

export interface FormattedResult {
  sessionId: string;
  tool: Tool;
  date: string;
  createdAt: string;
  project: string;
  title: string | null;
  snippet: string;
  messageCount: number;
  files: string[];
  commands: string[];
  errored: boolean;
  exists: boolean;
  filePath: string;
  resumeCommand: string;
}

/** Single source of truth for the search-result payload shared across surfaces. */
export function formatResult(r: SessionResult): FormattedResult {
  return {
    sessionId: r.sessionId,
    tool: r.tool,
    date: r.date,
    createdAt: r.createdAt,
    project: r.cwd,
    title: r.customTitle || null,
    snippet: r.displayText,
    messageCount: r.messageCount,
    files: r.files,
    commands: r.commands,
    errored: r.errored,
    exists: r.exists,
    filePath: r.filePath,
    resumeCommand: buildResumeCommand(r.tool, r.cwd, r.sessionId),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/search-format.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/search-format.ts src/search-format.test.ts
git commit -m "feat(search): shared resume-command + result formatter (CLI/MCP parity)"
```

---

### Task 8: CLI unification (route through `searchSessions`)

**Files:**

- Modify: `src/types.ts` (`CliArgs.errored`), `src/cli.ts` (parse `--errored`, add `toSearchOptions`, usage), `index.ts` (swap engine + shared resume), `src/display.ts` (errored marker)
- Test: `src/cli.test.ts`

**Interfaces:**

- Consumes: `searchSessions`/`SearchOptions` (Task 6), `buildResumeCommand` (Task 7), `scanSessions` (fallback, existing).
- Produces: `toSearchOptions(args: CliArgs, repoRoot: string): { query: string; opts: SearchOptions }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli.test.ts
import { test, expect } from 'bun:test';
import { parseArgs, toSearchOptions } from './cli';

test('parseArgs: --errored sets the flag; query and tool still parse', () => {
  const a = parseArgs(['--errored', '--tool', 'claude', 'rate limit']);
  expect(a.errored).toBe(true);
  expect(a.toolFilter).toBe('claude');
  expect(a.searchQuery).toBe('rate limit');
});

test('toSearchOptions: maps CLI args + repoRoot to a SearchOptions call', () => {
  const a = parseArgs(['--errored', '--here', 'auth']);
  const { query, opts } = toSearchOptions(a, '/repo');
  expect(query).toBe('auth');
  expect(opts.errored).toBe(true);
  expect(opts.project).toBe('/repo');
  expect(opts.tool).toBe('');
  expect(opts.limit).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli.test.ts`
Expected: FAIL — `a.errored` undefined / `toSearchOptions` not exported.

- [ ] **Step 3: Implement**

In `src/types.ts`, extend `CliArgs`:

```ts
export interface CliArgs {
  toolFilter: Tool | '';
  searchQuery: string;
  scopeHere: boolean;
  errored: boolean;
}
```

In `src/cli.ts`: import the search type, initialize the flag, parse it, and add the mapper. Update the `import` line and `parseArgs` init:

```ts
import { type Tool, type CliArgs } from './types';
import type { SearchOptions } from './cache';
```

```ts
const args: CliArgs = { toolFilter: '', searchQuery: '', scopeHere: false, errored: false };
```

Add a case inside the `switch` (next to `--here`):

```ts
      case '--errored':
        args.errored = true;
        break;
```

Add a usage line under Options (after `--tool`): `  --errored        Only sessions that hit an error`.

Append the mapper:

```ts
/** The single mapping from CLI args to a searchSessions() call (keeps the CLI a thin shell). */
export function toSearchOptions(args: CliArgs, repoRoot: string): { query: string; opts: SearchOptions } {
  return {
    query: args.searchQuery,
    opts: { tool: args.toolFilter, project: repoRoot, errored: args.errored, limit: 1000 },
  };
}
```

In `index.ts`: add imports at the top (after the existing imports):

```ts
import { buildResumeCommand } from './src/search-format';
import type { Tool } from './src/types';
```

Replace the scanner call (the `const results = await scanSessions(...)` line) with the index path + fallback:

```ts
const { searchSessions } = await import('./src/cache');
const { toSearchOptions } = await import('./src/cli');
const { query, opts } = toSearchOptions(args, repoRoot);
let results;
try {
  results = await searchSessions(query, opts);
} catch {
  results = await scanSessions(repoRoot, args.toolFilter, args.searchQuery); // no-index fallback
}
```

Replace the inline resume builder (the `let resumeCmd = ''; if (tool === 'claude') {...}` block) with:

```ts
const resumeCmd = buildResumeCommand(tool as Tool, fullPath, sessionId);
```

In `src/display.ts`, add an errored marker. Before the `display` template, add:

```ts
const warn = r.errored ? `${C.red}⚠${C.reset} ` : '';
```

and insert `${warn}` immediately before `${truncated}` in the `display` template literal.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/cli.test.ts`
Expected: PASS (2 tests). Then smoke the binary: `bun run dev "test"` lists ranked results from the index.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/cli.ts index.ts src/display.ts src/cli.test.ts
git commit -m "feat(cli): route search/browse through the FTS index (with scanner fallback)"
```

---

### Task 9: MCP enhancements (errored filter + metadata + resumeCommand)

**Files:**

- Modify: `src/mcp.ts`
- Test: `src/mcp.test.ts`

**Interfaces:**

- Consumes: `searchSessions`/`SearchOptions` (Task 6), `formatResult` (Task 7).
- Produces: `export async function runSearchSessions(args: { query?: string; tool?: Tool; project?: string; errored?: boolean; limit?: number }): Promise<{ content: { type: 'text'; text: string }[] }>`.

- [ ] **Step 1: Write the failing test (reuses the hermetic harness pattern)**

```ts
// src/mcp.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);
let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-'));
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });
  writeFileSync(
    join(dir, 'a.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'deploy' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl apply' } }],
        },
      }),
    ].join('\n'),
  );
  cache = await import('./cache');
  await cache.refreshIndex();
  mcp = await import('./mcp');
});

afterAll(() => {
  cache.closeDb?.();
  rmSync(tmp, { recursive: true, force: true });
});

test('search_sessions handler returns metadata + resumeCommand', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed[0].commands).toContain('kubectl apply');
  expect(parsed[0].resumeCommand).toContain('claude --resume');
});

test('search_sessions handler honors the errored filter', async () => {
  const res = await mcp.runSearchSessions({ errored: true });
  expect(res.content[0]!.text).toContain('No sessions found'); // session A did not error
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/mcp.test.ts`
Expected: FAIL — `mcp.runSearchSessions is not a function`.

- [ ] **Step 3: Implement in `src/mcp.ts`**

Update imports:

```ts
import { searchSessions, getActivityDigest, getSessionMetrics, getContextPrimer } from './cache';
import { formatResult } from './search-format';
import { type Tool } from './types';
```

Extract the handler into an exported, testable function (replaces the inline `async ({ query, tool, project, limit }) => {...}` body):

```ts
export async function runSearchSessions(args: {
  query?: string;
  tool?: Tool;
  project?: string;
  errored?: boolean;
  limit?: number;
}): Promise<{ content: { type: 'text'; text: string }[] }> {
  const results = await searchSessions(args.query ?? '', {
    tool: args.tool ?? '',
    project: args.project ?? '',
    errored: args.errored,
    limit: args.limit ?? 20,
  });
  if (results.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No sessions found.' }] };
  }
  const formatted = results.map(formatResult);
  return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
}
```

Register it, adding the `errored` param to the schema:

```ts
server.tool(
  'search_sessions',
  'Search across AI coding sessions from Claude Code, Codex, and Pi. Returns matching sessions with snippets, the files/commands involved, an errored flag, and a ready-to-run resume command.',
  {
    query: z
      .string()
      .optional()
      .describe(
        'Text to search across session messages, commands, file paths, errors, and reasoning. Natural-language queries work — results are ranked by relevance and any term may match. Omit to list recent sessions.',
      ),
    tool: z.enum(['claude', 'codex', 'pi']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
    errored: z.boolean().optional().describe('Only return sessions that hit an error'),
    limit: z.number().optional().default(20).describe('Max results to return (default 20)'),
  },
  async ({ query, tool, project, errored, limit }) => runSearchSessions({ query, tool, project, errored, limit }),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/mcp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "feat(mcp): errored filter + per-result metadata + resumeCommand"
```

---

### Task 10: Index hardening (`busy_timeout` + corrupt-DB self-heal)

**Files:**

- Modify: `src/cache.ts` (`getDb`, plus `closeDb`/`getDbPath` test helpers)
- Test: `src/cache.search.test.ts` (append)

**Interfaces:**

- Produces: `closeDb(): void`; `getDbPath(): string`. `getDb()` sets `busy_timeout` and rebuilds on corruption.

- [ ] **Step 1: Write the failing test (append to `src/cache.search.test.ts`)**

```ts
import { writeFileSync as writeFileSync2 } from 'node:fs';

test('hardening: busy_timeout is set and a corrupt DB rebuilds instead of throwing', async () => {
  // busy_timeout present
  expect(cache.getDbPath().endsWith('index.db')).toBe(true);

  // Corrupt the DB file, then a search must self-heal (rebuild) rather than throw.
  cache.closeDb();
  writeFileSync2(cache.getDbPath(), 'not a sqlite database at all');
  const r = await cache.searchSessions('docker', {});
  expect(Array.isArray(r)).toBe(true);
  expect(r.map((x) => x.sessionId)).toContain('a'); // rebuilt + reindexed
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cache.search.test.ts -t "hardening"`
Expected: FAIL — `cache.closeDb`/`cache.getDbPath` not functions (and/or a corrupt DB throws).

- [ ] **Step 3: Implement in `src/cache.ts`**

Add the helpers near `clearCache`:

```ts
export function getDbPath(): string {
  return DB_PATH;
}

export function closeDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
}

function removeDbFiles(): void {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try {
      require('node:fs').unlinkSync(f);
    } catch {}
  }
}

function isCorruption(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database');
}
```

Refactor `getDb()` to open via a helper (with `busy_timeout`) and self-heal on corruption:

```ts
function openDb(): Database {
  const db = new Database(DB_PATH);
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');
  db.run('PRAGMA busy_timeout=5000');

  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  if (!row || row.user_version !== SCHEMA_VERSION) {
    db.run('DROP TABLE IF EXISTS sessions');
    db.run('DROP TABLE IF EXISTS session_fts');
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '?',
      first_prompt TEXT NOT NULL,
      custom_title TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      files_touched TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      errored INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      closing_user TEXT NOT NULL DEFAULT '',
      closing_assistant TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      headline,
      user_content,
      assistant_content,
      commands,
      paths,
      context_text,
      thinking,
      tokenize = 'porter unicode61'
    )
  `);
  return db;
}

function getDb(): Database {
  if (_db) return _db;
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    _db = openDb();
  } catch (e) {
    if (!isCorruption(e)) throw e;
    removeDbFiles();
    _db = openDb(); // fresh DB; refreshIndex repopulates
  }
  return _db;
}
```

(This replaces the existing inline `getDb` body; the `CREATE TABLE`/`CREATE VIRTUAL TABLE` blocks moved into `openDb` are the Task 5 schema — keep them identical.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/cache.search.test.ts`
Expected: PASS (all cache tests, including hardening).

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts src/cache.search.test.ts
git commit -m "feat(index): busy_timeout + corrupt-DB self-heal"
```

---

## Final Verification

- [ ] **Full gate:**

```bash
bun test && bun run typecheck && bun run lint && bun run format:check && bun run build
```

Expected: all exit 0.

- [ ] **No new deps / no network:** `grep -rnE 'fetch\(|https?://|anthropic|openai' src/extract-commands.ts src/extract-errors.ts src/extract-thinking.ts src/search-format.ts` → no matches; `package.json` `dependencies` unchanged.

---

## Self-Review

**Spec coverage:**

- One engine / CLI unification → Task 8 (+ shared module Task 7). ✓
- Index commands/paths/errors/thinking, each its own FTS column → Tasks 1-5. ✓
- Per-column BM25 weights → Task 6 (`RANK`). ✓
- `errored` filter both surfaces → Task 6 (engine), Task 8 (CLI), Task 9 (MCP). ✓
- Per-result metadata + `resumeCommand` (parity) → Tasks 6, 7, 9. ✓
- Hardening: busy_timeout, corrupt-DB self-heal, Codex dedup → Task 10 + Task 1. ✓
- Tests incl. closing the `cache.ts` zero-coverage gap → Task 5 harness. ✓
- Schema 5→6 destructive reindex → Task 5 / Task 10 `openDb`. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows complete code. The bm25 weights are concrete starting values with a ranking test as the oracle (intentional, not a placeholder). ✓

**Type consistency:** `SearchOptions` (Task 6) consumed identically in Tasks 8/9; `SessionResult.{files,commands,errored}` defined in Task 6, populated in `searchSessions` (Task 6) and `scanner.ts` (Task 6), consumed in `formatResult` (Task 7) and `display.ts` (Task 8); `buildResumeCommand`/`formatResult` names stable across Tasks 7/8/9; `closeDb`/`getDbPath` defined in Task 10 and used by the Task 5/9 harnesses' `afterAll` (note: `closeDb?.()` optional-chaining tolerates running individual files before Task 10 lands). ✓

**One ordering note for the executor:** the `cache.search.test.ts` `afterAll` calls `closeDb` (added in Task 10). Tasks 5/6 use `closeDb?.()` so earlier runs don't hard-fail; it becomes a real close once Task 10 lands.
