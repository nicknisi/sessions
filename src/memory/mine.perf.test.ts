import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { refreshIndex } from '../cache';
import { mine } from './mine';
import { closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

// The budget measures MINE time against an already-refreshed index. A first mine
// after --clear-cache pays for reindexing thousands of transcripts, which is a
// documented cold-start cost of the index, not of the mine.
//
// Wall clock alone is a weak assertion on a loaded laptop, so the real guard against
// the "859 subprocess spawns" failure mode is the memoization test in scope.test.ts,
// which counts resolver calls instead of milliseconds. This one catches the coarse
// regression: a mine that went quadratic or lost its single-query shape.
const BUDGET_MS = 5_000;
const SESSIONS = 120;
const TURNS_PER_SESSION = 8;
const CWDS = ['/perf/one', '/perf/two', '/perf/three', '/perf/four', '/perf/five'];

let tmp: string;
/** Every fixture transcript, in write order — the "everything changed" set. */
const sessionPaths: string[] = [];

function setPerfEnv(): void {
  setMemoryEnv(tmp);
  // Keep ensureIndexFresh from rescanning between measurements: the fixture never
  // changes after beforeAll, so a rescan would only add noise to the timing.
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '600000';
}

beforeAll(async () => {
  tmp = makeTmp('memory-perf');
  setPerfEnv();

  for (let s = 0; s < SESSIONS; s++) {
    const turns = Array.from({ length: TURNS_PER_SESSION }, (_, t) =>
      userTurn(
        `Always run the ${s}-${t} checks before you push that branch upstream`,
        `2026-06-01T10:${String(t).padStart(2, '0')}:00Z`,
      ),
    );
    sessionPaths.push(writeSession(tmp, `perf-${s}`, CWDS[s % CWDS.length]!, turns));
  }

  closeDatabases();
  await refreshIndex(); // pay the indexing cost outside the measured window
});

beforeEach(() => {
  // Deliberately no closeDatabases() here: closing resets the refresh clock and the
  // next mine would reindex the whole fixture inside the measured window.
  setPerfEnv();
});

afterAll(() => {
  closeDatabases();
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe('mine performance', () => {
  test(`mines a ${SESSIONS}-session fixture in under ${BUDGET_MS}ms`, async () => {
    const started = Bun.nanoseconds();
    const records = await mine({});
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(records.length).toBe(SESSIONS * TURNS_PER_SESSION);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  test(`mines a restricted changed set in under ${BUDGET_MS}ms`, async () => {
    // The incremental path (`files`) costs `ceil(files.length / FILE_CHUNK)` restricted
    // MATCH scans for pass 1 PLUS the unconditional full-corpus pass 2 — the two-pass
    // shape mine.ts's comment argues for. That is the honest cost of a genuine subset,
    // and it is what this measures: 120 paths is one chunk, so two scans.
    //
    // It is NOT what a first `--since-last` run costs. There the changed set IS the
    // whole inventory, and `runMine` drops the restriction (`mineRestriction`,
    // src/memory/cli.ts) so the run costs one scan rather than ceil(N/400)+1 — 13 of
    // them at the author's ~4,498-session corpus. Without that short-circuit this
    // budget would be the wrong guard entirely: the fixture is small enough that 13
    // scans still fit inside it, while the real corpus would not.
    const started = Bun.nanoseconds();
    const records = await mine({ files: sessionPaths });
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // Same output as the unrestricted mine above: a filter that admits every session
    // admits every phrasing.
    expect(records.length).toBe(SESSIONS * TURNS_PER_SESSION);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
