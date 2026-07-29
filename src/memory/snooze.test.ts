import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildRecord } from './record';
import { getMemoryDb, listMemories, setState, upsertCandidates } from './store';
import {
  approve,
  dropSuppressed,
  reject,
  shouldResurface,
  snooze,
  SNOOZE_DAYS,
  snoozeUntil,
  suppressedMemories,
} from './triage';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import type { MemoryRecord } from './types';

// The contract's snooze criterion in test form: a snoozed candidate is suppressed
// until its date, and comes back on a later re-mine ONLY when new distinct phrasings
// appeared since the snooze. If expiry alone brought it back, snooze would be a
// 30-day delay rather than a dismissal, and every dismissed candidate would return.
//
// `todayIso` is injected throughout, so nothing here is green only in some months.

function record(text: string, distinctPhrasings: number): MemoryRecord {
  return buildRecord({
    text,
    scope: { type: 'repo', key: '/repos/app' },
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-01-01'],
    distinctPhrasings,
  });
}

const SNOOZED = record('Always prefer the repo script over invoking the tool directly', 2);
const REJECTED = record('Never bump the lockfile in the same commit as a feature', 1);
const FRESH = record('Always keep the changelog entry in the same commit as the change', 1);

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-snooze');
  setMemoryEnv(tmp);
  closeDatabases();
});

// Shared module instances across a `bun test` run mean another file's env leaks in
// unless both are re-asserted per test (src/memory/fixtures.ts).
beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
  upsertCandidates([SNOOZED, REJECTED, FRESH]);
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('snoozeUntil', () => {
  test('is SNOOZE_DAYS after the given day', () => {
    expect(SNOOZE_DAYS).toBe(30);
    expect(snoozeUntil('2026-01-01')).toBe('2026-01-31');
  });

  test('crosses month, year, and leap-year boundaries by real calendar arithmetic', () => {
    expect(snoozeUntil('2026-01-31')).toBe('2026-03-02'); // 28-day February
    expect(snoozeUntil('2026-12-15')).toBe('2027-01-14'); // year rollover
    expect(snoozeUntil('2028-02-01')).toBe('2028-03-02'); // 29-day February
  });

  test('is timezone-independent — the same string on any machine', () => {
    // Date.parse of a date-only form is UTC midnight and toISOString renders in UTC,
    // so no local offset can shift the result by a day.
    expect(snoozeUntil('2026-06-30')).toBe('2026-07-30');
  });

  test('rejects a malformed date instead of throwing "Invalid time value"', () => {
    expect(() => snoozeUntil('yesterday')).toThrow(RangeError);
    expect(() => snoozeUntil('2026-6-1')).toThrow('YYYY-MM-DD');
    expect(() => snoozeUntil('')).toThrow('YYYY-MM-DD');
  });
});

describe('shouldResurface', () => {
  const snoozed: MemoryRecord = { ...SNOOZED, state: 'snoozed', snoozedUntil: '2026-01-31' };

  test('stays suppressed before the date even when new phrasings appeared', () => {
    expect(shouldResurface(snoozed, 4, '2026-01-15')).toBe(false);
  });

  test('stays suppressed after the date when nothing new appeared', () => {
    // The whole point of the second condition: expiry alone is not evidence.
    expect(shouldResurface(snoozed, 2, '2026-02-15')).toBe(false);
    expect(shouldResurface(snoozed, 1, '2026-02-15')).toBe(false);
  });

  test('resurfaces once expired and repeated in new words', () => {
    expect(shouldResurface(snoozed, 4, '2026-02-15')).toBe(true);
  });

  test('treats the expiry date itself as expired', () => {
    expect(shouldResurface(snoozed, 4, '2026-01-31')).toBe(true);
  });

  test('never resurfaces a snoozed row with no expiry recorded', () => {
    // Unreachable through snooze(), but a hand-edited store or a Phase 4 import
    // could produce one; it must not slip through on a null comparison.
    expect(shouldResurface({ ...snoozed, snoozedUntil: null }, 99, '2030-01-01')).toBe(false);
  });

  test('applies only to snoozed records', () => {
    expect(shouldResurface({ ...snoozed, state: 'rejected' }, 99, '2030-01-01')).toBe(false);
    expect(shouldResurface({ ...snoozed, state: 'candidate' }, 99, '2030-01-01')).toBe(false);
  });
});

describe('write-back', () => {
  test('snooze records both the state and the expiry the filter reads', () => {
    snooze(SNOOZED.id, '2026-01-01');
    const stored = listMemories({ state: 'snoozed' })[0]!;
    expect(stored.id).toBe(SNOOZED.id);
    expect(stored.snoozedUntil).toBe('2026-01-31');
  });

  test('approve on a rejected id succeeds — a user may change their mind', () => {
    reject(REJECTED.id);
    expect(listMemories({ state: 'rejected' }).map((r) => r.id)).toEqual([REJECTED.id]);
    approve(REJECTED.id);
    expect(listMemories({ state: 'rejected' })).toHaveLength(0);
    expect(listMemories({ state: 'approved' }).map((r) => r.id)).toEqual([REJECTED.id]);
  });

  test('approve and reject clear a pending snooze', () => {
    snooze(SNOOZED.id, '2026-01-01');
    approve(SNOOZED.id);
    expect(listMemories({ state: 'approved' })[0]!.snoozedUntil).toBeNull();
  });
});

describe('dropSuppressed', () => {
  test('a rejected candidate leaves the batch entirely', () => {
    reject(REJECTED.id);
    const batch = dropSuppressed([REJECTED, FRESH], suppressedMemories(), '2030-01-01');
    expect(batch.map((r) => r.id)).toEqual([FRESH.id]);
  });

  test('an untriaged candidate always passes through', () => {
    expect(dropSuppressed([FRESH], suppressedMemories(), '2030-01-01')).toEqual([FRESH]);
  });

  test('an approved memory stays in the batch — the pipe mirrors the table', () => {
    approve(FRESH.id);
    expect(dropSuppressed([FRESH], suppressedMemories(), '2030-01-01').map((r) => r.id)).toEqual([FRESH.id]);
  });

  test('the spec walkthrough: suppressed, still suppressed on expiry, back on new evidence', () => {
    snooze(SNOOZED.id, '2026-01-01'); // expires 2026-01-31, baseline 2 phrasings
    const stored = suppressedMemories();
    const unchanged = [{ ...SNOOZED, evidence: { ...SNOOZED.evidence, distinctPhrasings: 2 } }];
    const repeated = [{ ...SNOOZED, evidence: { ...SNOOZED.evidence, distinctPhrasings: 4 } }];

    expect(dropSuppressed(unchanged, stored, '2026-01-15')).toHaveLength(0); // inside the window
    expect(dropSuppressed(unchanged, stored, '2026-02-15')).toHaveLength(0); // expired, no new evidence
    expect(dropSuppressed(repeated, stored, '2026-01-15')).toHaveLength(0); // new evidence, still inside
    expect(dropSuppressed(repeated, stored, '2026-02-15')).toHaveLength(1); // both conditions
  });

  test('the baseline comes from the stored snapshot, not the re-mined record', () => {
    // upsertCandidates refreshes `evidence` on every mine (store.ts ON CONFLICT), so
    // a caller that read the store AFTER upserting would be comparing the fresh count
    // against itself and could never resurface anything.
    snooze(SNOOZED.id, '2026-01-01');
    const before = suppressedMemories();
    const remined = { ...SNOOZED, evidence: { ...SNOOZED.evidence, distinctPhrasings: 5 } };
    upsertCandidates([remined]);
    const after = suppressedMemories();

    expect(before.get(SNOOZED.id)!.evidence.distinctPhrasings).toBe(2);
    expect(after.get(SNOOZED.id)!.evidence.distinctPhrasings).toBe(5);
    expect(dropSuppressed([remined], before, '2026-02-15')).toHaveLength(1);
    expect(dropSuppressed([remined], after, '2026-02-15')).toHaveLength(0);
  });

  test('suppressedMemories carries evidence, which getPersistedStates cannot', () => {
    setState(SNOOZED.id, 'snoozed', '2026-01-31');
    const stored = suppressedMemories().get(SNOOZED.id)!;
    expect(stored.evidence.distinctPhrasings).toBe(2);
    expect(stored.snoozedUntil).toBe('2026-01-31');
  });
});
