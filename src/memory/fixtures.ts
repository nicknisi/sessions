// Hermetic fixture helpers shared by the src/memory/*.test.ts files.
//
// This is NOT a test file — `bun test` collects *.test.ts / *_test.ts / *.spec.ts,
// and this matches none of them. It exists because five memory test files need the
// same synthesized-JSONL + SESSIONS_* env harness that src/cache.search.test.ts
// established, and five copies of it would drift apart.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../cache';
import { closeMemoryDb } from './store';

/** realpathSync because macOS resolves /var -> /private/var, and git's --show-toplevel
 *  reports the real path — an unresolved fixture path would never compare equal. */
export function makeTmp(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `sessions-${label}-`)));
}

/**
 * Point every source root, the index, and the durable store at one temp tree.
 * Re-assert this in `beforeEach`: cache.ts and store.ts are single shared module
 * instances across a `bun test` run, so another file's env would otherwise leak in.
 */
export function setMemoryEnv(tmp: string): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent -> no OpenCode sessions leak in
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data');
}

/** Release both shared handles so the next call reopens against the current env. */
export function closeDatabases(): void {
  closeDb();
  closeMemoryDb();
}

export function claudeDir(tmp: string): string {
  return join(tmp, 'claude');
}

/**
 * Run something with both streams captured, so a test can assert on the batch the CLI
 * writes to stdout.
 *
 * Takes a thunk rather than an argv so this file keeps importing nothing but cache.ts
 * and store.ts. The sinks honor the callback argument because `writeStdoutFully`
 * (src/stdout.ts) resolves only when it fires.
 */
export async function captureStreams(run: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const sink =
    (into: string[]) =>
    (chunk: string | Uint8Array, cb?: () => void): boolean => {
      into.push(String(chunk));
      cb?.();
      return true;
    };
  // SAFETY: the stub implements only the (chunk, cb) overload the CLIs under test use.
  process.stdout.write = sink(out) as typeof process.stdout.write;
  // SAFETY: same stub contract as stdout above.
  process.stderr.write = sink(err) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

/** A genuine typed human turn: `promptSource: 'typed'` is what parser.ts requires. */
export function userTurn(text: string, timestamp: string) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: 'typed',
  };
}

/** A harness/skill injection: present-but-null promptSource, so parser.ts rejects it
 *  and it never reaches message_fts. */
export function injectedTurn(text: string, timestamp: string) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: null,
  };
}

export function assistantTurn(text: string, timestamp: string) {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/** Write a Claude transcript at <claudeDir>/proj/<id>.jsonl with `cwd` on every line. */
export function writeSession(tmp: string, id: string, cwd: string, records: JsonObject[]): string {
  const dir = join(claudeDir(tmp), 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify({ ...r, cwd })).join('\n');
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines);
  return path;
}

/**
 * Write a subagent transcript beside session `id`. cache.ts folds every user turn
 * found here into ONE parent row at msg_index -1 (the sentinel), which is agent-
 * authored prose that must never be mined as something the human said.
 */
export function writeSubagent(tmp: string, id: string, cwd: string, texts: string[]): void {
  const dir = join(claudeDir(tmp), 'proj', id, 'subagents');
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((t, i) =>
    JSON.stringify({ ...userTurn(t, `2026-06-01T10:${String(i).padStart(2, '0')}:00Z`), cwd }),
  );
  writeFileSync(join(dir, 'agent.jsonl'), lines.join('\n'));
}
