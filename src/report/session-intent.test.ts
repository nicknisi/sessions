import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupIntents } from './session-intent.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-intent-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let caseDir = '';
let caseNo = 0;

beforeEach(() => {
  caseDir = join(tmp, `case${caseNo++}`);
  mkdirSync(caseDir, { recursive: true });
  process.env.SESSIONS_CACHE_DIR = caseDir;
});

// Only the columns lookupIntents reads — deliberately not the full index schema,
// so this test does not silently depend on unrelated parts of it.
function seed(rows: { tool: string; sessionId: string; title?: string; prompt?: string; messages?: number }[]): void {
  const db = new Database(join(caseDir, 'index.db'));
  db.run(`CREATE TABLE sessions (
    file_path TEXT PRIMARY KEY, tool TEXT, session_id TEXT,
    custom_title TEXT DEFAULT '', first_prompt TEXT DEFAULT '', message_count INTEGER DEFAULT 0)`);
  for (const [i, r] of rows.entries()) {
    db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)', [
      `/f${i}.jsonl`,
      r.tool,
      r.sessionId,
      r.title ?? '',
      r.prompt ?? '',
      r.messages ?? 1,
    ]);
  }
  db.close();
}

describe('lookupIntents', () => {
  test('prefers a custom title over the opening prompt', () => {
    seed([{ tool: 'claude', sessionId: 's1', title: 'Auth migration', prompt: 'hello there' }]);
    const got = lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]);
    expect(got.get('claude-code|s1')).toBe('Auth migration');
  });

  test('falls back to the opening prompt', () => {
    seed([{ tool: 'claude', sessionId: 's1', prompt: 'fix the flaky test' }]);
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).get('claude-code|s1')).toBe('fix the flaky test');
  });

  test('maps the report tool id onto the index tool id', () => {
    // A row stored as 'claude' must be found by a lookup for 'claude-code'.
    seed([{ tool: 'claude', sessionId: 's1', prompt: 'x' }]);
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).size).toBe(1);
    // ...and must NOT be found by a lookup for a different tool with the same id.
    expect(lookupIntents([{ tool: 'codex', sessionId: 's1' }]).size).toBe(0);
  });

  test('picks the longest row when a resumed session spans files', () => {
    seed([
      { tool: 'claude', sessionId: 's1', prompt: 'the stub', messages: 2 },
      { tool: 'claude', sessionId: 's1', prompt: 'the real one', messages: 400 },
    ]);
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).get('claude-code|s1')).toBe('the real one');
  });

  test('flattens newlines and clips a long prompt to one line', () => {
    seed([{ tool: 'claude', sessionId: 's1', prompt: 'line one\n\n   line two' + ' padding'.repeat(40) }]);
    const got = lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).get('claude-code|s1')!;
    expect(got).not.toContain('\n');
    expect(got.startsWith('line one line two')).toBe(true);
    expect(got.length).toBeLessThanOrEqual(120);
  });

  test('a session the index has never seen is simply absent', () => {
    seed([{ tool: 'claude', sessionId: 's1', prompt: 'x' }]);
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 'nope' }]).size).toBe(0);
  });

  test('an empty title AND empty prompt yields no entry', () => {
    seed([{ tool: 'claude', sessionId: 's1' }]);
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).size).toBe(0);
  });

  test('no index at all degrades to no intents, not an error', () => {
    // caseDir exists but holds no index.db.
    expect(() => lookupIntents([{ tool: 'claude-code', sessionId: 's1' }])).not.toThrow();
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).size).toBe(0);
  });

  test('a corrupt index degrades the same way', () => {
    writeFileSync(join(caseDir, 'index.db'), 'not a database');
    expect(lookupIntents([{ tool: 'claude-code', sessionId: 's1' }]).size).toBe(0);
  });

  test('an empty key list never opens the database', () => {
    writeFileSync(join(caseDir, 'index.db'), 'not a database');
    expect(lookupIntents([]).size).toBe(0);
  });
});
