/**
 * getSessionMetrics: the active-hours histogram.
 *
 * Transcript timestamps are Z-normalized, and the old implementation read the hour by
 * slicing characters 11-13 out of the ISO string — the UTC hour, labelled as the user's.
 * A US-Central user's 9am work showed up in the 14:00 or 15:00 bucket. The fixture below
 * is chosen to cross a day boundary so a UTC/local mixup cannot pass by coincidence.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);

let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → nothing leaks in
  // Re-index on every call. The default 5s freshness window would hide a fixture written
  // partway through this file, making the assertion pass against a stale index.
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

/** 02:30 UTC on June 1. In Chicago that is 21:30 on May 31 — a different hour AND day. */
const INSTANT = '2026-06-01T02:30:00Z';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-metrics-'));
  setEnv();
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });
  writeFileSync(
    join(dir, 'a.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoA',
        timestamp: INSTANT,
        promptSource: 'typed',
        message: { role: 'user', content: [{ type: 'text', text: 'late night refactor' }] },
      }),
      j({
        type: 'assistant',
        cwd: '/repoA',
        timestamp: '2026-06-01T02:35:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
      }),
    ].join('\n'),
  );
});

beforeEach(async () => {
  setEnv();
  cache = await import('./cache');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('buckets active hours in the given zone, not UTC', async () => {
  const m = await cache.getSessionMetrics('2026-05-30', '2026-06-02', '', '', 'America/Chicago');
  expect(m.totalSessions).toBe(1);
  // 21 on May 31 locally. Slicing the ISO string would have given '02'.
  expect(m.activeHours).toEqual({ '21': 1 });
});

test('the same instant lands in a different bucket in a different zone', async () => {
  // Proves the bucket tracks the zone rather than happening to match one fixture. The
  // zone is a parameter precisely because V8 caches the process default on first clock
  // read, which made the old getHours()-based conversion untestable in-process.
  const m = await cache.getSessionMetrics('2026-05-30', '2026-06-02', '', '', 'Asia/Tokyo');
  expect(m.activeHours).toEqual({ '11': 1 });
});

test('UTC is just another zone, and returns the hour the old code guessed', async () => {
  const m = await cache.getSessionMetrics('2026-05-30', '2026-06-02', '', '', 'UTC');
  expect(m.activeHours).toEqual({ '02': 1 });
});

test('midnight is bucketed as 00, never 24', async () => {
  // Pins the contract: buckets are 00-23. It does NOT prove the `% 24` guard in hourIn
  // fires — this machine's ICU already renders midnight as '00', so the test passes with
  // the guard removed. The guard follows the vendored localHour in
  // src/report/parsers/util.ts, which carries the same modulo for ICU builds that emit
  // '24'. Treat it as precedent-driven, not as covered here.
  const dir = join(tmp, 'claude', 'proj');
  writeFileSync(
    join(dir, 'midnight.jsonl'),
    j({
      type: 'user',
      cwd: '/repoB',
      timestamp: '2026-06-02T00:15:00Z',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'midnight' }] },
    }),
  );
  try {
    const m = await cache.getSessionMetrics('2026-06-02', '2026-06-02', '', '', 'UTC');
    expect(m.activeHours).toEqual({ '00': 1 });
  } finally {
    rmSync(join(dir, 'midnight.jsonl'));
  }
});

test('every matched session contributes exactly one hour', async () => {
  // The histogram total must equal the session count. The old implementation built it in
  // a second pass that reopened each transcript and swallowed every failure, so a
  // read error silently dropped sessions out of the histogram but not the totals.
  const m = await cache.getSessionMetrics('2026-05-30', '2026-06-02', '', '', 'America/Chicago');
  const bucketed = Object.values(m.activeHours).reduce((a, b) => a + b, 0);
  expect(bucketed).toBe(m.totalSessions);
});
