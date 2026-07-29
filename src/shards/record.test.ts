import { describe, test, expect } from 'bun:test';
import { buildRecord, fingerprint, gitAuthorEmail, normalizeText } from './record';
import { SHARD_SCHEMA_VERSION } from './types';

describe('normalizeText', () => {
  test('collapses whitespace runs and trims, preserving case', () => {
    // Case survives because the stored text is what a human reads back on triage;
    // folding happens inside fingerprint so identity is still case-insensitive.
    expect(normalizeText('  Never   commit\n\tdirectly to main.  ')).toBe('Never commit directly to main.');
  });
});

describe('fingerprint', () => {
  // Hardcoded, not recomputed in the test: a fingerprint that changes silently
  // breaks every stored triage decision, because the id is the store's primary key.
  // Recomputing the hash inside the assertion would let a normalization change slip
  // through green.
  const KNOWN = 'sha256:57fc50ca681a44a5c0b90706db0de0096123260f4ebb83dea7637667b27e31a7';

  test('a known string hashes to a stable id', () => {
    expect(fingerprint('Never commit directly to main.')).toBe(KNOWN);
  });

  test('is case-insensitive', () => {
    expect(fingerprint('NEVER COMMIT DIRECTLY TO MAIN.')).toBe(KNOWN);
  });
});

describe('buildRecord', () => {
  const base = {
    text: 'Never commit directly to main.',
    scope: { type: 'repo' as const, key: '/repos/app' },
    author: 'dev@example.com',
    sessions: ['/s/b.jsonl', '/s/a.jsonl'],
    dates: ['2026-03-04', '2026-01-02'],
    distinctPhrasings: 1,
  };

  test('produces a schema-valid record with sorted evidence and date bounds', () => {
    const r = buildRecord(base);
    expect(r.v).toBe(SHARD_SCHEMA_VERSION);
    expect(r.kind).toBe('instruction');
    expect(r.state).toBe('candidate');
    expect(r.snoozedUntil).toBeNull();
    expect(r.evidence.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
    expect(r.evidence.firstSeen).toBe('2026-01-02');
    expect(r.evidence.lastSeen).toBe('2026-03-04');
  });

  test('is byte-identical across two runs given the same inputs in different orders', () => {
    // The determinism criterion compares whole records, not just ids — unsorted
    // evidence arrays are the likeliest source of a run-to-run byte difference.
    const run1 = buildRecord(base);
    const run2 = buildRecord({
      ...base,
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-03-04', '2026-01-02'].reverse(),
    });
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  test('whitespace-only differences in the source text produce the same id', () => {
    const spaced = buildRecord({ ...base, text: '  Never\n commit   directly  to main.  ' });
    expect(spaced.id).toBe(buildRecord(base).id);
    expect(spaced.text).toBe('Never commit directly to main.');
  });

  test('drops undated sessions rather than emitting the index sentinel', () => {
    // src/cache.ts stores '?' for a transcript with no parseable timestamp. That is
    // not a date and must never reach a record's firstSeen/lastSeen.
    const r = buildRecord({ ...base, dates: ['?', '2026-05-06'] });
    expect(r.evidence.firstSeen).toBe('2026-05-06');
    expect(r.evidence.lastSeen).toBe('2026-05-06');
  });

  test('deduplicates repeated session paths', () => {
    const r = buildRecord({ ...base, sessions: ['/s/a.jsonl', '/s/a.jsonl'] });
    expect(r.evidence.sessions).toEqual(['/s/a.jsonl']);
  });
});

describe('gitAuthorEmail', () => {
  test('always returns a non-empty string, never throws', () => {
    // A machine with no git identity (or no git at all) must still mine.
    expect(gitAuthorEmail().length).toBeGreaterThan(0);
  });
});
