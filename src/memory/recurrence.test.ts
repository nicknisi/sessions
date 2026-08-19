// Unit + golden coverage for recurrence matching (the G2 instrument of
// docs/ideation/memory-recurrence/spec-phase-2.md). No tmpdir harness: the matcher
// is pure, so every fixture is a hand-built record.

import { describe, expect, test } from 'bun:test';
import { buildRecord } from './record';
import {
  classifyRecurrence,
  jaccard,
  MIN_SIMILARITY_TOKENS,
  SIMILARITY_ASSERT,
  SIMILARITY_FUZZY,
} from './recurrence';
import { tokenize } from './topic';
import type { MemoryRecord, MemoryState } from './types';

function record(
  text: string,
  opts: { state?: MemoryState; sessions?: string[]; dates?: string[] } = {},
): MemoryRecord {
  return buildRecord({
    text,
    scope: { type: 'repo', key: '/repos/app' },
    author: 'dev@example.com',
    sessions: opts.sessions ?? ['/s/a.jsonl'],
    dates: opts.dates ?? ['2026-06-01'],
    distinctPhrasings: 1,
    state: opts.state ?? 'candidate',
  });
}

describe('jaccard', () => {
  test('identical sets score 1, disjoint sets score 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('a subset scores |intersection| / |union|, not containment', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd']))).toBe(0.5);
  });

  test('a near-miss lands strictly inside the fuzzy band', () => {
    // 2 of 3 tokens shared: 0.667 — above SIMILARITY_FUZZY, below SIMILARITY_ASSERT.
    const score = jaccard(new Set(['never', 'push', 'ask']), new Set(['never', 'push']));
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_FUZZY);
    expect(score).toBeLessThan(SIMILARITY_ASSERT);
  });

  test('empty sets score 0 explicitly rather than NaN-abstaining by accident', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('tokenize reuse', () => {
  test('the spec\'s false pair tokenizes below the similarity floor', () => {
    // "don't commit" / "don't push": `don` is a stopword and `t` is under the length
    // floor, so both sides are singletons and similarity never runs.
    expect(tokenize("don't commit").size).toBeLessThan(MIN_SIMILARITY_TOKENS);
    expect(tokenize("don't push").size).toBeLessThan(MIN_SIMILARITY_TOKENS);
  });
});

describe('classifyRecurrence', () => {
  const VIOLATION_TEXT = 'Always run the full test suite before telling me the work is done';

  test('an approved memory re-corrected after its lastSeen is a violation', () => {
    const memory = record(VIOLATION_TEXT, { state: 'approved', dates: ['2026-05-03'] });
    const cluster = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    const report = classifyRecurrence([cluster], [memory]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.memory.id).toBe(memory.id);
    expect(report.violations[0]!.similarity).toBe(1);
    expect(report.violations[0]!.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
    expect(report.violations[0]!.latestDate).toBe('2026-06-02');
    expect(report.repeats).toHaveLength(0);
  });

  test('a match entirely within the memory\'s evidence window is NOT a violation', () => {
    const memory = record(VIOLATION_TEXT, { state: 'approved', dates: ['2026-05-01', '2026-06-30'] });
    const cluster = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    const report = classifyRecurrence([cluster], [memory]);
    expect(report.violations).toHaveLength(0);
    // Residue is consumed by the pairing, not re-reported as an untriaged repeat.
    expect(report.repeats).toHaveLength(0);
  });

  test('a same-day re-violation is invisible to the strictly-after proxy', () => {
    const memory = record(VIOLATION_TEXT, { state: 'approved', dates: ['2026-06-02'] });
    const cluster = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    expect(classifyRecurrence([cluster], [memory]).violations).toHaveLength(0);
  });

  test('merged, rejected, and snoozed memories never pair as violations', () => {
    for (const state of ['merged', 'rejected', 'snoozed'] as const) {
      const memory = record(VIOLATION_TEXT, { state, dates: ['2026-05-03'] });
      const cluster = record(VIOLATION_TEXT, {
        sessions: ['/s/a.jsonl', '/s/b.jsonl'],
        dates: ['2026-06-01', '2026-06-02'],
      });
      expect(classifyRecurrence([cluster], [memory]).violations).toHaveLength(0);
    }
  });

  test('a repeat matching a candidate memory is a repeat-with-candidate, not a violation', () => {
    const candidate = record(VIOLATION_TEXT, { state: 'candidate', dates: ['2026-05-03'] });
    const cluster = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    const report = classifyRecurrence([cluster], [candidate]);
    expect(report.violations).toHaveLength(0);
    expect(report.repeats).toHaveLength(1);
    expect(report.repeats[0]!.candidateId).toBe(candidate.id);
  });

  test('a repeat needs both >=2 sessions and >=2 dates', () => {
    const oneSession = record(VIOLATION_TEXT, { sessions: ['/s/a.jsonl'], dates: ['2026-06-01', '2026-06-02'] });
    const oneDate = record(VIOLATION_TEXT, { sessions: ['/s/a.jsonl', '/s/b.jsonl'], dates: ['2026-06-01'] });
    expect(classifyRecurrence([oneSession], []).repeats).toHaveLength(0);
    expect(classifyRecurrence([oneDate], []).repeats).toHaveLength(0);
    const both = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    expect(classifyRecurrence([both], []).repeats).toHaveLength(1);
  });

  test('the known paraphrase pair lands fuzzy and the false pair stays silent', () => {
    const memory = record('never push without asking', { state: 'approved', dates: ['2026-05-03'] });
    const paraphrase = record('I said never push on your own', {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    const report = classifyRecurrence([paraphrase], [memory]);
    expect(report.violations).toHaveLength(0);
    expect(report.fuzzy).toHaveLength(1);
    expect(report.fuzzy[0]!.memory.id).toBe(memory.id);
    // A fuzzy-paired cluster is not also an untriaged repeat — one signal, one section.
    expect(report.repeats).toHaveLength(0);

    const falsePair = record("don't push", {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    const control = classifyRecurrence([falsePair], [record("don't commit", { state: 'approved' })]);
    expect(control.violations).toHaveLength(0);
    expect(control.fuzzy).toHaveLength(0);
  });

  test('stopword-only texts never pair, with each other or anything else', () => {
    const a = record('the and it', { state: 'approved' });
    const b = record('the and it too', { sessions: ['/s/a.jsonl', '/s/b.jsonl'], dates: ['2026-06-01', '2026-06-02'] });
    const report = classifyRecurrence([b], [a]);
    expect(report.violations).toHaveLength(0);
    expect(report.fuzzy).toHaveLength(0);
  });

  test('--since drops clusters whose evidence ends before the date', () => {
    const cluster = record(VIOLATION_TEXT, {
      sessions: ['/s/a.jsonl', '/s/b.jsonl'],
      dates: ['2026-06-01', '2026-06-02'],
    });
    expect(classifyRecurrence([cluster], [], { since: '2026-06-02' }).repeats).toHaveLength(1);
    expect(classifyRecurrence([cluster], [], { since: '2026-06-03' }).repeats).toHaveLength(0);
  });

  test('G2 golden: known corpus splits into violations, repeats, and silence', () => {
    // By construction: one approved memory violated twice, one approved memory
    // matched only inside its own window (silence), one untriaged repeat, one
    // one-off correction below the repeat bar.
    const violated = record(VIOLATION_TEXT, { state: 'approved', dates: ['2026-05-03'] });
    const quiet = record('use pnpm for every install in this repo', {
      state: 'approved',
      dates: ['2026-05-01', '2026-08-01'],
    });
    const clusters = [
      record(VIOLATION_TEXT, { sessions: ['/s/a.jsonl', '/s/b.jsonl'], dates: ['2026-06-01', '2026-06-02'] }),
      record('use pnpm for every install in this repo', {
        sessions: ['/s/c.jsonl', '/s/d.jsonl'],
        dates: ['2026-06-01', '2026-07-01'],
      }),
      record('never edit generated files by hand', {
        sessions: ['/s/e.jsonl', '/s/f.jsonl'],
        dates: ['2026-06-05', '2026-06-09'],
      }),
      record('stop rebasing the shared release branch', { sessions: ['/s/g.jsonl'], dates: ['2026-06-07'] }),
    ];
    const report = classifyRecurrence(clusters, [violated, quiet]);
    expect(report.violations.map((v) => v.memory.id)).toEqual([violated.id]);
    expect(report.repeats).toHaveLength(1);
    expect(report.repeats[0]!.cluster.text).toBe('never edit generated files by hand');
    expect(report.fuzzy).toHaveLength(0);

    // Control: the same clusters against an empty store produce zero pairings.
    const control = classifyRecurrence(clusters, []);
    expect(control.violations).toHaveLength(0);
    expect(control.fuzzy).toHaveLength(0);
  });

  test('output order is deterministic: count desc, then cluster id', () => {
    const mk = (text: string, sessions: string[]) =>
      record(text, { sessions, dates: ['2026-06-01', '2026-06-02'] });
    const clusters = [
      mk('alpha correction repeated across sessions here', ['/s/1.jsonl', '/s/2.jsonl']),
      mk('beta correction repeated across sessions here', ['/s/1.jsonl', '/s/2.jsonl', '/s/3.jsonl']),
      mk('gamma correction repeated across sessions here', ['/s/1.jsonl', '/s/2.jsonl']),
    ];
    const a = classifyRecurrence(clusters, []);
    const b = classifyRecurrence([...clusters].reverse(), []);
    expect(a.repeats.map((r) => r.cluster.text)).toEqual(b.repeats.map((r) => r.cluster.text));
    expect(a.repeats[0]!.sessions).toHaveLength(3);
  });
});
