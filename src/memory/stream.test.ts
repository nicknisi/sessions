import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { appendFileSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mineRestriction, persistMine, runMemory } from './cli';
import { FILE_CHUNK, mine } from './mine';
import { getMemoryDb, listMemories, setState } from './store';
import { advanceWatermark, changedSessions, readWatermark, type WatermarkEntry } from './watermark';
import { captureStreams, closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';
import type { MemoryRecord } from './types';

// Phase 6 in test form: an incremental mine must see a RESUMED session.
//
// The whole design rests on one claim — that a transcript's mtime/size pair is the
// only honest change signal, because transcripts are appended to long after they are
// first indexed. Every end-to-end test here therefore changes a fixture file after a
// mine and asserts what the next mine picks up.
//
// SESSIONS_REFRESH_INTERVAL_MS is pinned to '0' throughout. Without it,
// ensureIndexFresh (src/cache.ts:533-537) serves a cached scan for five seconds and a
// same-test append is simply not visible to the index — a test would then fail for a
// reason that has nothing to do with the watermark. It is deleted in afterAll because
// the whole `bun test` run shares one process and one cache.ts module instance
// (src/memory/mine.perf.test.ts:55 does the same).

const S1 = 'Always run the migration script before you deploy the api service';
const S2 = 'Never commit generated protobuf files into the repository tree';
const S3 = 'Always prefer the workspace script over invoking the bundler directly';
const APPENDED = 'Always tag the release commit before you publish the package';

/** One fact said in three unrelated repos. deriveScope calls that `workflow`. */
const SPREAD = 'Never leave a feature flag switched on after the rollout finishes';

let tmp: string;
let repo: string;
let paths: Record<'s1' | 's2' | 's3', string>;

let spreadTmp: string;
let spreadRepoC: string;

function capture(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  return captureStreams(() => runMemory(argv));
}

function batchOf(result: { stdout: string }): MemoryRecord[] {
  return JSON.parse(result.stdout) as MemoryRecord[];
}

function texts(records: MemoryRecord[]): string[] {
  return records.map((r) => r.text).sort();
}

/** Append a genuine user turn to an existing transcript, changing mtime AND size. */
function appendTurn(path: string, text: string, cwd: string): void {
  // The fixture joins lines with '\n' and writes no trailing newline, so the leading
  // separator belongs to the append.
  appendFileSync(path, '\n' + JSON.stringify({ ...userTurn(text, '2026-06-02T11:00:00Z'), cwd }));
}

/** Change mtime while leaving size byte-identical. An explicit offset, because
 *  rewriting the same bytes is at the mercy of filesystem timestamp granularity. */
function touchMtime(path: string): void {
  const now = statSync(path).mtimeMs;
  utimesSync(path, new Date(now), new Date(now + 60_000));
}

beforeAll(() => {
  tmp = makeTmp('memory-stream');
  repo = join(tmp, 'repo');
  paths = {
    s1: writeSession(tmp, 'stream-1', repo, [userTurn(S1, '2026-06-01T10:00:00Z')]),
    s2: writeSession(tmp, 'stream-2', repo, [userTurn(S2, '2026-06-01T10:05:00Z')]),
    s3: writeSession(tmp, 'stream-3', repo, [userTurn(S3, '2026-06-01T10:10:00Z')]),
  };

  // A second tree for the scope-union case, so its three-container fixture cannot
  // widen the scope of anything the tests above assert on.
  spreadTmp = makeTmp('memory-stream-spread');
  spreadRepoC = join(spreadTmp, 'repo-c');
  writeSession(spreadTmp, 'spread-a', join(spreadTmp, 'repo-a'), [userTurn(SPREAD, '2026-06-01T10:00:00Z')]);
  writeSession(spreadTmp, 'spread-b', join(spreadTmp, 'repo-b'), [userTurn(SPREAD, '2026-06-01T10:05:00Z')]);

  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  closeDatabases();
  // Each end-to-end test establishes its own baseline with a first --since-last run,
  // so the store and the watermark start empty rather than inheriting a sibling's
  // leftovers. Fixture mtimes drift upward across tests, which is exactly why the
  // baseline is re-established rather than assumed.
  const db = getMemoryDb();
  db.run('DELETE FROM memory');
  db.run('DELETE FROM mine_watermark');
});

afterAll(() => {
  closeDatabases();
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(spreadTmp, { recursive: true, force: true });
});

describe('changedSessions', () => {
  // Pure over its two inputs — no database, no clock, no index. This is the layer that
  // can exhaust the mtime/size matrix cheaply, and it is the fastest feedback in the
  // phase.
  const seen = (filePath: string, mtime: number, size: number): Map<string, WatermarkEntry> =>
    new Map([[filePath, { filePath, mtime, size }]]);

  test('both halves matching is the only unchanged cell', () => {
    const indexed = [{ filePath: '/s/a.jsonl', mtime: 1000.5, size: 42 }];
    expect(changedSessions(indexed, seen('/s/a.jsonl', 1000.5, 42))).toEqual([]);
    // mtime differs, size identical: an in-place rewrite of the same length.
    expect(changedSessions(indexed, seen('/s/a.jsonl', 999.5, 42))).toEqual(['/s/a.jsonl']);
    // size differs, mtime identical: possible when a write lands inside one tick.
    expect(changedSessions(indexed, seen('/s/a.jsonl', 1000.5, 41))).toEqual(['/s/a.jsonl']);
    expect(changedSessions(indexed, seen('/s/a.jsonl', 999.5, 41))).toEqual(['/s/a.jsonl']);
  });

  test('sub-millisecond mtime precision is compared, not rounded away', () => {
    // The index stores stat.mtimeMs in a REAL column: 1785329334744.8967 is a real
    // observed value. An INTEGER watermark would truncate and never match again.
    const indexed = [{ filePath: '/s/a.jsonl', mtime: 1785329334744.8967, size: 205 }];
    expect(changedSessions(indexed, seen('/s/a.jsonl', 1785329334744.8967, 205))).toEqual([]);
    expect(changedSessions(indexed, seen('/s/a.jsonl', 1785329334744, 205))).toEqual(['/s/a.jsonl']);
  });

  test('a file with no watermark row is changed by definition', () => {
    // Which is what makes the first --since-last run a full backfill.
    const indexed = [
      { filePath: '/s/a.jsonl', mtime: 1, size: 1 },
      { filePath: '/s/b.jsonl', mtime: 2, size: 2 },
    ];
    expect(changedSessions(indexed, new Map())).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
  });

  test('a watermark row whose transcript is gone is inert, not an error', () => {
    // runRefreshIndex prunes rows for vanished transcripts (src/cache.ts:446-464); the
    // watermark lives in another database and is never pruned. The orphan simply never
    // appears in the input.
    expect(changedSessions([], seen('/s/deleted.jsonl', 1, 1))).toEqual([]);
  });

  test('empty inputs are total, in every combination', () => {
    expect(changedSessions([], new Map())).toEqual([]);
    expect(changedSessions([{ filePath: '/s/a.jsonl', mtime: 1, size: 1 }], new Map())).toEqual(['/s/a.jsonl']);
  });

  test('the result is sorted, so chunk boundaries do not vary run to run', () => {
    const indexed = ['/s/c.jsonl', '/s/a.jsonl', '/s/b.jsonl'].map((filePath) => ({ filePath, mtime: 1, size: 1 }));
    expect(changedSessions(indexed, new Map())).toEqual(['/s/a.jsonl', '/s/b.jsonl', '/s/c.jsonl']);
  });
});

describe('the watermark table', () => {
  test('a round trip preserves the float mtime the index stores', () => {
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 1785329334744.8967, size: 205 }]);
    expect(readWatermark().get('/s/a.jsonl')).toEqual({
      filePath: '/s/a.jsonl',
      mtime: 1785329334744.8967,
      size: 205,
    });
  });

  test('advancing an existing path replaces it rather than duplicating it', () => {
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 1, size: 1 }]);
    advanceWatermark([{ filePath: '/s/a.jsonl', mtime: 2, size: 2 }]);
    const watermark = readWatermark();
    expect(watermark.size).toBe(1);
    expect(watermark.get('/s/a.jsonl')!.mtime).toBe(2);
  });

  test('an empty advance is a no-op, mirroring upsertCandidates', () => {
    advanceWatermark([]);
    expect(readWatermark().size).toBe(0);
  });

  test('the watermark is not advanced when the upsert throws', () => {
    // The ordering guarantee, asserted through the seam rather than by reading the
    // source: if this were advance-then-upsert, the entries below would be recorded as
    // mined and their material skipped forever.
    const entries: WatermarkEntry[] = [{ filePath: '/s/a.jsonl', mtime: 1, size: 1 }];
    expect(() =>
      persistMine([], entries, () => {
        throw new Error('disk on fire');
      }),
    ).toThrow('disk on fire');
    expect(readWatermark().size).toBe(0);

    // ...and the same call advances once the write succeeds.
    persistMine([], entries, () => {});
    expect(readWatermark().size).toBe(1);
  });
});

describe('mine --since-last', () => {
  test('the first run mines everything and records a watermark for what it saw', async () => {
    const { stdout, stderr } = await capture(['mine', '--repo', repo, '--since-last', '--json']);
    expect(texts(batchOf({ stdout }))).toEqual([S1, S2, S3].sort());
    expect(stderr).toContain('no watermark yet');
    expect([...readWatermark().keys()].sort()).toEqual([paths.s1, paths.s2, paths.s3].sort());
  });

  test('the short-circuited first run emits exactly what a full backfill emits', async () => {
    // `mineRestriction` hands `mine` no file list at all when the changed set is the
    // whole inventory. The saving is scans, never records: this pins the output
    // equivalence the optimization rests on.
    const backfill = texts(await mine({ repo }));
    expect(texts(batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json'])))).toEqual(backfill);
  });

  test('a second consecutive run emits an empty batch and exits without erroring', async () => {
    await capture(['mine', '--repo', repo, '--since-last', '--json']);
    const { stdout, stderr } = await capture(['mine', '--repo', repo, '--since-last', '--json']);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toContain('0 sessions changed');
  });

  test('appending a corrective turn marks exactly that session changed', async () => {
    await capture(['mine', '--repo', repo, '--since-last', '--json']);
    // Restored afterwards so the shared fixture stays pristine for its siblings; every
    // test re-baselines its own watermark, so the mtime churn is harmless.
    const before = readFileSync(paths.s2, 'utf-8');
    try {
      appendTurn(paths.s2, APPENDED, repo);
      const batch = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));
      // Session 2's phrasings — both of them — and nothing from the untouched sessions.
      expect(texts(batch)).toEqual([APPENDED, S2].sort());
    } finally {
      writeFileSync(paths.s2, before);
    }
  });

  test('changing mtime alone still counts as changed', async () => {
    await capture(['mine', '--repo', repo, '--since-last', '--json']);
    touchMtime(paths.s3);

    expect(texts(batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json'])))).toEqual([S3]);
  });

  test('deleting a watermark row makes that session changed again', async () => {
    await capture(['mine', '--repo', repo, '--since-last', '--json']);
    getMemoryDb().run('DELETE FROM mine_watermark WHERE file_path = ?', [paths.s1]);

    expect(texts(batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json'])))).toEqual([S1]);
  });

  test('a rediscovered phrasing on a rejected memory stays rejected', async () => {
    const first = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));
    const rejected = first.find((r) => r.text === S1)!;
    setState(rejected.id, 'rejected');

    touchMtime(paths.s1);
    const batch = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));

    expect(batch.find((r) => r.id === rejected.id)).toBeUndefined();
    expect(listMemories().find((r) => r.id === rejected.id)!.state).toBe('rejected');
  });

  test('evidence is rebuilt over the whole corpus, not the changed slice alone', async () => {
    // The destructive failure this phase had to avoid: upsertCandidates overwrites
    // `evidence` wholesale, so a record built from one changed session would replace a
    // multi-session evidence list and reset firstSeen. Two sessions say the same thing;
    // only one of them changes.
    const shared = 'Always regenerate the client stubs after you edit the schema file';
    const a = writeSession(tmp, 'stream-shared-a', repo, [userTurn(shared, '2026-06-01T09:00:00Z')]);
    const b = writeSession(tmp, 'stream-shared-b', repo, [userTurn(shared, '2026-06-03T09:00:00Z')]);
    try {
      await capture(['mine', '--repo', repo, '--since-last', '--json']);
      touchMtime(a);
      const batch = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));

      const record = batch.find((r) => r.text === shared)!;
      expect(record.evidence.sessions.sort()).toEqual([a, b].sort());
      expect(record.evidence.firstSeen).toBe('2026-06-01');
      expect(record.evidence.lastSeen).toBe('2026-06-03');
      // ...and the stored row agrees, which is what `export` and `quorum` read.
      expect(
        listMemories()
          .find((r) => r.id === record.id)!
          .evidence.sessions.sort(),
      ).toEqual([a, b].sort());
    } finally {
      rmSync(a, { force: true });
      rmSync(b, { force: true });
    }
  });

  test('mining a repo advances only that repo, leaving other repos to be mined later', async () => {
    // The silent, unrecoverable failure: a scoped mine that advanced the whole index
    // inventory would mark every other repo's sessions as seen without examining them.
    const other = join(tmp, 'other-repo');
    const otherFact = 'Never hand edit the generated lockfile, always run the installer';
    const otherPath = writeSession(tmp, 'stream-other', other, [userTurn(otherFact, '2026-06-01T10:00:00Z')]);
    try {
      await capture(['mine', '--repo', repo, '--since-last', '--json']);
      expect(readWatermark().has(otherPath)).toBe(false);

      const batch = batchOf(await capture(['mine', '--repo', other, '--since-last', '--json']));
      expect(texts(batch)).toEqual([otherFact]);
      expect(readWatermark().has(otherPath)).toBe(true);
    } finally {
      rmSync(otherPath, { force: true });
    }
  });

  test('scope is derived over the union, so a third repo widens an existing memory', async () => {
    setMemoryEnv(spreadTmp);
    closeDatabases();
    try {
      const first = batchOf(await capture(['mine', '--all', '--since-last', '--json']));
      // Two containers is ambiguous and resolves toward `repo` (src/memory/mine.ts).
      expect(first.find((r) => r.text === SPREAD)!.scope.type).toBe('repo');

      writeSession(spreadTmp, 'spread-c', spreadRepoC, [userTurn(SPREAD, '2026-06-04T10:00:00Z')]);
      const second = batchOf(await capture(['mine', '--all', '--since-last', '--json']));
      const widened = second.find((r) => r.text === SPREAD)!;
      expect(widened.scope.type).toBe('workflow');
      expect(widened.evidence.sessions).toHaveLength(3);
    } finally {
      closeDatabases();
    }
  });
});

describe('mineRestriction', () => {
  // Pass 1 costs one FTS MATCH scan per chunk, so restricting to a set that is already
  // the whole inventory buys nothing and costs ~13 extra scans on the author's corpus.
  test('a changed set covering the whole inventory restricts nothing', () => {
    expect(mineRestriction(['/s/a.jsonl', '/s/b.jsonl'], 2)).toBeUndefined();
  });

  test('a genuine subset is passed through untouched', () => {
    expect(mineRestriction(['/s/a.jsonl'], 2)).toEqual(['/s/a.jsonl']);
  });

  test('an empty changed set stays empty, whatever the inventory size', () => {
    // The one place `[]` and `undefined` disagree: `[]` means "nothing changed" and
    // `undefined` means "mine everything". An empty inventory must yield the former.
    expect(mineRestriction([], 0)).toEqual([]);
    expect(mineRestriction([], 5)).toEqual([]);
  });
});

describe('distinctPhrasings stays 1, and snooze-resurface therefore cannot fire', () => {
  // A RECORDED LIMITATION, locked so a future change has to be deliberate. See the
  // amendment and Open Item in docs/ideation/context-memory/spec-phase-6.md: the spec's
  // "a genuinely new phrasing bumps distinctPhrasings and can trigger resurface" case is
  // not reachable through the shipped pipeline, because a record is content-addressed on
  // its own text. Closing the gap needs a clustering write-back no phase specifies; when
  // one lands, these two tests are the ones that must change on purpose.
  const REWORDED = 'Always run the migration script first, before the api service is deployed';

  test('a new wording becomes a new record instead of bumping the existing one', async () => {
    const first = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));
    const original = first.find((r) => r.text === S1)!;
    expect(original.evidence.distinctPhrasings).toBe(1);

    const before = readFileSync(paths.s1, 'utf-8');
    try {
      appendTurn(paths.s1, REWORDED, repo);
      const second = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));

      const reworded = second.find((r) => r.text === REWORDED)!;
      expect(reworded.id).not.toBe(original.id);
      expect(reworded.evidence.distinctPhrasings).toBe(1);
      // The original is unbumped — this is the assertion the resurface predicate needs
      // to become false, and it is the whole reason that predicate cannot fire.
      expect(second.find((r) => r.id === original.id)!.evidence.distinctPhrasings).toBe(1);
    } finally {
      writeFileSync(paths.s1, before);
    }
  });

  test('a snoozed candidate stays hidden even once a paraphrase arrives and the date passes', async () => {
    const first = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));
    const target = first.find((r) => r.text === S1)!;
    // An expiry in the past satisfies the DATE half of shouldResurface outright, so the
    // only thing left to decide the outcome is the phrasing count.
    setState(target.id, 'snoozed', '2020-01-01');

    const before = readFileSync(paths.s1, 'utf-8');
    try {
      appendTurn(paths.s1, REWORDED, repo);
      const second = batchOf(await capture(['mine', '--repo', repo, '--since-last', '--json']));

      expect(second.find((r) => r.id === target.id)).toBeUndefined();
      expect(listMemories().find((r) => r.id === target.id)!.state).toBe('snoozed');
      // ...while the paraphrase itself IS surfaced, as its own untriaged candidate.
      expect(second.find((r) => r.text === REWORDED)!.state).toBe('candidate');
    } finally {
      writeFileSync(paths.s1, before);
    }
  });
});

describe('changed-set chunking', () => {
  // FILE_CHUNK bounds an unbounded changed set against SQLite's 999-parameter cap. The
  // boundary cases are what catch a loop that drops its remainder — a phrasing in the
  // dropped chunk would silently stop being mined.
  const pad = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `/absent/${String(i).padStart(5, '0')}.jsonl`);

  test('a real path in the final partial chunk is still mined', async () => {
    // FILE_CHUNK + 1 paths: the last chunk holds exactly one entry, and it is the only
    // one that exists.
    const files = [...pad(FILE_CHUNK), paths.s1];
    expect(files).toHaveLength(FILE_CHUNK + 1);
    expect(texts(await mine({ repo, files }))).toEqual([S1]);
  });

  test('a changed set of exactly FILE_CHUNK binds in one statement', async () => {
    const files = [...pad(FILE_CHUNK - 1), paths.s2];
    expect(texts(await mine({ repo, files }))).toEqual([S2]);
  });

  test('an empty changed set mines nothing rather than everything', async () => {
    // `files: []` means "nothing changed", which is the common case at a few facts per
    // month. Treating it as absent would re-emit the entire backfill every run.
    expect(await mine({ repo, files: [] })).toEqual([]);
    // Only unknown paths is the same answer by a different route.
    expect(await mine({ repo, files: pad(3) })).toEqual([]);
  });
});
