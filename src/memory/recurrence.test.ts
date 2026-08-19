// Unit + golden coverage for recurrence matching (the G2 instrument of
// docs/ideation/memory-recurrence/spec-phase-2.md), plus the phase-4 trend
// snapshot coverage (G4 of spec-phase-4.md). The matching unit tests keep the
// no-tmpdir promise — hand-built records, matcher is pure; the snapshot tests
// below bring the tmpdir harness because the snapshot file is the G4 instrument.

import { beforeAll, beforeEach, afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../paths';
import { runMemory } from './cli';
import { buildRecord } from './record';
import {
  classifyRecurrence,
  jaccard,
  MIN_SIMILARITY_TOKENS,
  SIMILARITY_ASSERT,
  SIMILARITY_FUZZY,
} from './recurrence';
import { appendSnapshot, diffSnapshots, readSnapshots, snapshotPath } from './snapshots';
import { setState, upsertCandidates } from './store';
import { tokenize } from './topic';
import type { MemoryRecord, MemoryState } from './types';
import { captureStreams, closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

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

describe('snapshots: read/append/diff (phase 4 unit)', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTmp('memory-snapshots-unit');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One violation row built by the classifier itself, so the shape cannot drift. */
  function violation(text: string, sessions: string[]) {
    const memory = record(text, { state: 'approved', dates: ['2026-05-03'] });
    const cluster = record(text, { sessions, dates: ['2026-06-01', '2026-06-02'] });
    return classifyRecurrence([cluster], [memory]).violations[0]!;
  }

  test('a missing file reads as an empty history, not an error', () => {
    expect(readSnapshots(dir)).toEqual([]);
  });

  test('append then read round-trips one line per run', () => {
    appendSnapshot({ v: 1, date: '2026-08-18', scope: 'all', counts: { 'sha256:a': 3 } }, dir);
    appendSnapshot({ v: 1, date: '2026-08-19', scope: 'all', counts: { 'sha256:a': 4 } }, dir);
    const read = readSnapshots(dir);
    expect(read).toHaveLength(2);
    expect(read[1]!.date).toBe('2026-08-19');
    expect(read[1]!.counts['sha256:a']).toBe(4);
  });

  test('diffSnapshots: new id gets null delta, matched id gets the arithmetic', () => {
    const v = violation('always verify the schema drift before cutting a release', ['/s/a.jsonl', '/s/b.jsonl']);
    const first = diffSnapshots(null, [v]);
    expect(first[0]).toEqual({ id: v.memory.id, violations: 2, previous: null, delta: null });

    const second = diffSnapshots({ v: 1, date: '2026-08-18', scope: 'all', counts: { [v.memory.id]: 1 } }, [v]);
    expect(second[0]).toEqual({ id: v.memory.id, violations: 2, previous: 1, delta: 1 });
    // Id order follows the violations order, never Object.entries accidentals.
    expect(second.map((t) => t.id)).toEqual([v.memory.id]);
  });
});

describe('trend snapshots (G4: the two-run delta instrument)', () => {
  const FACT = 'Always run the whole test suite before you report the change done';
  const SECOND = 'Never force push to a shared branch without asking first';
  let tmp: string;
  let repo: string;

  const path = (): string => snapshotPath(getDataDir());
  /** Snapshot lines so far; [] when the file does not exist yet. */
  const lines = (): string[] => (existsSync(path()) ? readFileSync(path(), 'utf-8').split('\n').filter(Boolean) : []);
  const capture = (argv: string[]): Promise<{ stdout: string; stderr: string }> => captureStreams(() => runMemory(argv));

  beforeAll(() => {
    tmp = makeTmp('memory-snapshots');
    setMemoryEnv(tmp);
    repo = join(tmp, 'repo');
    closeDatabases();
  });
  beforeEach(() => {
    // Re-assert, per fixtures.ts: the shared module instances would otherwise read
    // the last test's env.
    setMemoryEnv(tmp);
    closeDatabases();
  });
  afterAll(() => {
    closeDatabases();
    rmSync(tmp, { recursive: true, force: true });
  });

  function approve(text: string, lastSeen: string): MemoryRecord {
    const memory = buildRecord({
      text,
      scope: { type: 'repo', key: repo },
      author: 'dev@example.com',
      sessions: ['/s/old.jsonl'],
      dates: [lastSeen],
      distinctPhrasings: 1,
    });
    upsertCandidates([memory]);
    setState(memory.id, 'approved');
    return memory;
  }

  interface TrendRow {
    id: string;
    violations: number;
    previous: number | null;
    delta: number | null;
  }
  interface TrendJson {
    trend: TrendRow[];
    trendNote?: string;
  }

  test('G4: two runs over a mutated corpus — the delta shows exactly the new violation', async () => {
    writeSession(tmp, 's1', repo, [userTurn(FACT, '2026-06-01T10:00:00Z')]);
    writeSession(tmp, 's2', repo, [userTurn(FACT, '2026-06-02T10:00:00Z')]);
    const memory = approve(FACT, '2026-05-03');
    closeDatabases();

    // First run: no previous run, every violation is (new), one snapshot line lands.
    const first = JSON.parse((await capture(['report', '--repo', repo, '--json'])).stdout) as TrendJson;
    expect(first.trendNote).toBe('first snapshot — no previous run');
    expect(first.trend.every((t) => t.delta === null && t.previous === null)).toBe(true);
    const firstCount = first.trend.find((t) => t.id === memory.id)!.violations;
    expect(lines()).toHaveLength(1);

    // Mutate the corpus: a second approved memory violated by two new sessions.
    const second = approve(SECOND, '2026-05-04');
    writeSession(tmp, 's3', repo, [userTurn(SECOND, '2026-06-03T10:00:00Z')]);
    writeSession(tmp, 's4', repo, [userTurn(SECOND, '2026-06-04T10:00:00Z')]);
    closeDatabases();

    const next = JSON.parse((await capture(['report', '--repo', repo, '--json'])).stdout) as TrendJson;
    // The unchanged memory deltas exactly 0; the mutated corpus' addition is the
    // ONLY (new) row — the whole G4 claim: the diff shows exactly the new violation
    // and nothing else.
    const unchanged = next.trend.find((t) => t.id === memory.id)!;
    expect({ id: unchanged.id, delta: unchanged.delta }).toEqual({ id: memory.id, delta: 0 });
    const added = next.trend.find((t) => t.id === second.id)!;
    expect(added.delta).toBeNull();
    expect(next.trend.some((t) => t.previous === null && t.id !== second.id)).toBe(false);
    expect(lines()).toHaveLength(2);
    expect(firstCount).toBe(unchanged.violations);
  });

  test('--no-snapshot leaves the snapshot file byte-untouched, including never-created', async () => {
    const before = existsSync(path()) ? readFileSync(path(), 'utf-8') : null;
    await capture(['report', '--repo', repo, '--no-snapshot']);
    if (before === null) {
      expect(existsSync(path())).toBe(false);
    } else {
      expect(readFileSync(path(), 'utf-8')).toBe(before);
    }
  });

  test('a corrupt trailing line (a truncated write) is skipped with a warning, not fatal', async () => {
    // Simulate the torn line directly rather than mocking a failed write.
    const garbage = '{"v":1,"date":"2026-08-18","sco\n';
    const prior = existsSync(path()) ? readFileSync(path(), 'utf-8') : '';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path(), prior + garbage);
    const result = await capture(['report', '--repo', repo]);
    expect(result.stderr).toContain('skipping corrupt snapshot line');
    expect(result.stdout).toContain('memory report');
  });
});
