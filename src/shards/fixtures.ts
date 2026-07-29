// Hermetic fixture helpers shared by the src/shards/*.test.ts files.
//
// This is NOT a test file — `bun test` collects *.test.ts / *_test.ts / *.spec.ts,
// and this matches none of them. It exists because five shard test files need the
// same synthesized-JSONL + SESSIONS_* env harness that src/cache.search.test.ts
// established, and five copies of it would drift apart.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../cache';
import { closeShardsDb } from './store';

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
export function setShardEnv(tmp: string): void {
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
  closeShardsDb();
}

export function claudeDir(tmp: string): string {
  return join(tmp, 'claude');
}

/** A genuine typed human turn: `promptSource: 'typed'` is what parser.ts requires. */
export function userTurn(text: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: 'typed',
  };
}

/** A harness/skill injection: present-but-null promptSource, so parser.ts rejects it
 *  and it never reaches message_fts. */
export function injectedTurn(text: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: null,
  };
}

export function assistantTurn(text: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** Write a Claude transcript at <claudeDir>/proj/<id>.jsonl with `cwd` on every line. */
export function writeSession(tmp: string, id: string, cwd: string, records: Record<string, unknown>[]): string {
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
