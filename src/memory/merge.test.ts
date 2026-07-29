import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildRecord } from './record';
import { getMemoryDb, listMemories, setState, upsertCandidates } from './store';
import { dropSuppressed, mergeInto, snooze, suppressedMemories } from './triage';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import type { MemoryRecord } from './types';

// Cluster write-back — the path that makes `distinctPhrasings` mean what its name says.
//
// Before this existed, every record carried 1 forever: an id is a hash of that record's
// own normalized text, so a new wording is a new row rather than a bigger count, and
// `shouldResurface`'s "more phrasings than when you snoozed it" condition could never
// become true. The resurface test at the bottom of this file is the one that would have
// been impossible to write, and it is the reason the rest of this exists.
//
// `todayIso` is injected everywhere, so none of this is green only in some months.

function record(text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    ...buildRecord({
      text,
      scope: { type: 'repo', key: '/repos/app' },
      author: 'dev@example.com',
      sessions: ['/s/a.jsonl'],
      dates: ['2026-02-01'],
      distinctPhrasings: 1,
    }),
    ...over,
  };
}

// One fact, three ways of saying it — the shape the triage skill clusters.
const CANON = record('Always run the migrations before you start the dev server', {
  evidence: {
    distinctPhrasings: 1,
    sessions: ['/s/a.jsonl'],
    firstSeen: '2026-02-01',
    lastSeen: '2026-02-01',
  },
});
const PARA_1 = record('Remember the migrations have to run before the dev server does', {
  evidence: {
    distinctPhrasings: 1,
    sessions: ['/s/b.jsonl'],
    firstSeen: '2026-01-10',
    lastSeen: '2026-01-10',
  },
});
const PARA_2 = record('Never start the dev server on an unmigrated database', {
  evidence: {
    distinctPhrasings: 1,
    sessions: ['/s/c.jsonl'],
    firstSeen: '2026-03-20',
    lastSeen: '2026-03-20',
  },
});

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-merge');
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
  upsertCandidates([CANON, PARA_1, PARA_2]);
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

function stored(id: string): MemoryRecord {
  return listMemories().find((r) => r.id === id)!;
}

describe('mergeInto', () => {
  test('counts distinct phrasings rather than rows', () => {
    const result = mergeInto(CANON.id, [PARA_1.id, PARA_2.id], '2026-06-01');
    expect(result.distinctPhrasings).toBe(3);
    expect(stored(CANON.id).evidence.distinctPhrasings).toBe(3);
  });

  test('unions the contributing sessions and widens the date range', () => {
    mergeInto(CANON.id, [PARA_1.id, PARA_2.id], '2026-06-01');
    const evidence = stored(CANON.id).evidence;
    expect(evidence.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl', '/s/c.jsonl']);
    // The range spans every phrasing, not just the canonical's own.
    expect(evidence.firstSeen).toBe('2026-01-10');
    expect(evidence.lastSeen).toBe('2026-03-20');
  });

  test('marks members merged and points them at the canonical', () => {
    mergeInto(CANON.id, [PARA_1.id], '2026-06-01');
    expect(stored(PARA_1.id).state).toBe('merged');
    expect(stored(PARA_1.id).mergedInto).toBe(CANON.id);
    // The absorbed row keeps its own text and id, so a merge is auditable rather than
    // a silent delete.
    expect(stored(PARA_1.id).text).toBe(PARA_1.text);
  });

  test('a merged member stops being offered for triage', () => {
    mergeInto(CANON.id, [PARA_1.id], '2026-06-01');
    const suppressed = suppressedMemories();
    expect(suppressed.has(PARA_1.id)).toBe(true);
    expect(dropSuppressed([PARA_1], suppressed, '2026-06-01')).toEqual([]);
  });

  test('is idempotent — re-merging an absorbed member changes nothing', () => {
    mergeInto(CANON.id, [PARA_1.id], '2026-06-01');
    const again = mergeInto(CANON.id, [PARA_1.id], '2026-06-01');
    expect(again.absorbed).toEqual([]);
    expect(stored(CANON.id).evidence.distinctPhrasings).toBe(2);
  });

  test('ignores a member id equal to the canonical rather than double-counting it', () => {
    const result = mergeInto(CANON.id, [CANON.id, PARA_1.id], '2026-06-01');
    expect(result.absorbed).toEqual([PARA_1.id]);
    expect(result.distinctPhrasings).toBe(2);
  });

  test('throws on an unknown id instead of silently merging nothing', () => {
    expect(() => mergeInto(CANON.id, ['sha256:deadbeef'], '2026-06-01')).toThrow('unknown memory id');
    expect(() => mergeInto('sha256:deadbeef', [PARA_1.id], '2026-06-01')).toThrow('unknown memory id');
  });
});

describe('merge and snooze-resurface', () => {
  test('a snoozed memory resurfaces when a new phrasing arrives after its date', () => {
    // Snoozed on Feb 1 with one phrasing; its 30 days are up by June.
    snooze(CANON.id, '2026-02-01');
    expect(stored(CANON.id).state).toBe('snoozed');

    const result = mergeInto(CANON.id, [PARA_1.id], '2026-06-01');

    expect(result.resurfaced).toBe(true);
    expect(stored(CANON.id).state).toBe('candidate');
    // The snooze is cleared, not merely stepped over — a resurfaced row is a live
    // candidate again, and a stale expiry would make it look suppressed to a reader.
    expect(stored(CANON.id).snoozedUntil).toBeNull();
  });

  test('does not resurface before the snooze date, however much new evidence arrives', () => {
    snooze(CANON.id, '2026-02-01');
    const result = mergeInto(CANON.id, [PARA_1.id, PARA_2.id], '2026-02-15');
    expect(result.resurfaced).toBe(false);
    expect(stored(CANON.id).state).toBe('snoozed');
  });

  test('does not resurface on expiry alone — that would make snooze a 30-day delay', () => {
    snooze(CANON.id, '2026-02-01');
    // A "merge" carrying no new phrasing: the member is already absorbed.
    mergeInto(CANON.id, [PARA_1.id], '2026-02-02');
    setState(CANON.id, 'snoozed', '2026-03-03');
    const result = mergeInto(CANON.id, [PARA_1.id], '2026-06-01');
    expect(result.resurfaced).toBe(false);
    expect(stored(CANON.id).state).toBe('snoozed');
  });

  test('never resurrects a rejected memory — reject stays terminal', () => {
    setState(CANON.id, 'rejected');
    const result = mergeInto(CANON.id, [PARA_1.id, PARA_2.id], '2026-06-01');
    expect(result.resurfaced).toBe(false);
    expect(stored(CANON.id).state).toBe('rejected');
    // The evidence still accumulates, so the count is right if the user later approves it.
    expect(stored(CANON.id).evidence.distinctPhrasings).toBe(3);
  });
});
