import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildRecord } from './record';
import { getPersistedStates, getMemoryDb, listMemories, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import type { MemoryRecord, MemoryScope } from './types';

// The filters Phase 2 triage and Phase 3 injection both read through: `--state`
// narrowing for the triage queue, scope narrowing for "what applies to this repo".

const REPO_A: MemoryScope = { type: 'repo', key: '/repos/app' };
const REPO_B: MemoryScope = { type: 'repo', key: '/repos/other' };
const WORKFLOW: MemoryScope = { type: 'workflow', key: '' };

function record(text: string, scope: MemoryScope): MemoryRecord {
  return buildRecord({
    text,
    scope,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

const APPROVED = record('Always run the migrations before starting the dev server', REPO_A);
const REJECTED = record('Never rewrite the lockfile by hand, run the installer', REPO_A);
const SNOOZED = record('Always ask before force pushing to a shared branch', REPO_B);
const CANDIDATE = record('Never leave a failing test behind at the end of a task', WORKFLOW);

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-store');
  setMemoryEnv(tmp);
  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
  upsertCandidates([APPROVED, REJECTED, SNOOZED, CANDIDATE]);
  setState(APPROVED.id, 'approved');
  setState(REJECTED.id, 'rejected');
  setState(SNOOZED.id, 'snoozed', '2026-09-01');
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

function texts(records: MemoryRecord[]): string[] {
  return records.map((r) => r.text).sort();
}

describe('listMemories', () => {
  test('no filter returns every memory, ordered by id', () => {
    const all = listMemories();
    expect(all).toHaveLength(4);
    const ids = all.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  test('filters by each state', () => {
    expect(texts(listMemories({ state: 'approved' }))).toEqual([APPROVED.text]);
    expect(texts(listMemories({ state: 'rejected' }))).toEqual([REJECTED.text]);
    expect(texts(listMemories({ state: 'candidate' }))).toEqual([CANDIDATE.text]);

    const snoozed = listMemories({ state: 'snoozed' });
    expect(texts(snoozed)).toEqual([SNOOZED.text]);
    expect(snoozed[0]!.snoozedUntil).toBe('2026-09-01');
  });

  test('filters by a repo scope, matching type AND key', () => {
    expect(texts(listMemories({ scope: REPO_A }))).toEqual([APPROVED.text, REJECTED.text].sort());
    expect(texts(listMemories({ scope: REPO_B }))).toEqual([SNOOZED.text]);
    expect(listMemories({ scope: { type: 'repo', key: '/repos/nothing' } })).toEqual([]);
  });

  test('filters by workflow scope, whose key is the empty string', () => {
    // The empty key is a real value, not "unset": a workflow filter must not fall
    // through to every repo memory.
    expect(texts(listMemories({ scope: WORKFLOW }))).toEqual([CANDIDATE.text]);
  });

  test('state and scope compose', () => {
    expect(texts(listMemories({ state: 'rejected', scope: REPO_A }))).toEqual([REJECTED.text]);
    expect(listMemories({ state: 'approved', scope: REPO_B })).toEqual([]);
  });
});

describe('getPersistedStates', () => {
  test('returns the stored state for known ids and omits unknown ones', () => {
    const states = getPersistedStates([APPROVED.id, SNOOZED.id, 'sha256:notstored']);
    expect(states.get(APPROVED.id)).toEqual({ state: 'approved', snoozedUntil: null });
    expect(states.get(SNOOZED.id)).toEqual({ state: 'snoozed', snoozedUntil: '2026-09-01' });
    expect(states.has('sha256:notstored')).toBe(false);
  });

  test('an empty id list is a no-op', () => {
    expect(getPersistedStates([]).size).toBe(0);
  });
});
