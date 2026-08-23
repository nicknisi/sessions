import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from '../report/parsers/types.ts';
import { collectClaudeUserTurns, type UserTurn } from './loops.ts';
import { computeLoops, SITTING_GAP_MS } from './compute.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-loops-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = Date.parse('2026-03-04T20:00:00Z');
const iso = (at: number): string => new Date(at).toISOString();

const ev = (sessionId: string, at: number, cwd = '/Users/x/Developer/sessions'): UsageEvent => ({
  tool: 'claude-code',
  provider: 'anthropic',
  model: 'claude-fable-5',
  timestamp: iso(at),
  sessionId,
  projectPath: cwd,
  tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10 },
});

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const turns = (entries: [string, UserTurn[]][]): Map<string, UserTurn[]> => new Map(entries);

describe('collectClaudeUserTurns', () => {
  const root = join(tmp, 'claude');
  mkdirSync(join(root, 'proj', 'sub', 'subagents'), { recursive: true });

  const line = (o: JsonObject): string => JSON.stringify(o) + '\n';
  const user = (sessionId: string, timestamp: string, content: JsonValue, extra: JsonObject = {}) =>
    line({ type: 'user', sessionId, timestamp, message: { role: 'user', content }, ...extra });

  writeFileSync(
    join(root, 'proj', 'main.jsonl'),
    user('s1', '2026-03-04T20:00:00Z', 'fix the flaky test', { promptSource: 'typed' }) +
      // Queued counts — the human typed it, even if it landed mid-run.
      user('s1', '2026-03-04T20:05:00Z', 'also update the docs', { promptSource: 'queued' }) +
      // Injected turns, tool results, and compaction summaries are not humans.
      user('s1', '2026-03-04T20:06:00Z', 'harness ping', { promptSource: null }) +
      user('s1', '2026-03-04T20:07:00Z', [{ type: 'tool_result', content: 'ok' }]) +
      user('s1', '2026-03-04T20:08:00Z', 'summary of prior conversation', { isCompactSummary: true }) +
      // Legacy line without promptSource: non-empty text passes the heuristic.
      user('s2', '2026-03-04T21:00:00Z', 'old-style prompt') +
      // Assistant lines are not turns.
      line({ type: 'assistant', sessionId: 's1', timestamp: '2026-03-04T20:01:00Z', message: { role: 'assistant' } }),
  );
  // A resumed session copies history verbatim — same turn, same timestamp, second file.
  writeFileSync(
    join(root, 'proj', 'resume.jsonl'),
    user('s1', '2026-03-04T20:00:00Z', 'fix the flaky test', { promptSource: 'typed' }),
  );
  // A subagent transcript carries the parent sessionId and isSidechain: true.
  writeFileSync(
    join(root, 'proj', 'sub', 'subagents', 'agent-abc.jsonl'),
    user('s1', '2026-03-04T20:02:00Z', 'Explore the repo thoroughly.', { isSidechain: true }),
  );

  test('keeps genuine human turns, keyed and sorted, deduped across copies', async () => {
    const map = await collectClaudeUserTurns(root);
    expect([...map.keys()].sort()).toEqual(['claude-code|s1', 'claude-code|s2']);
    const s1 = map.get('claude-code|s1')!;
    expect(s1.map((t) => t.text)).toEqual(['fix the flaky test', 'also update the docs']);
    expect(s1[0]!.at).toBe(Date.parse('2026-03-04T20:00:00Z'));
    expect(map.get('claude-code|s2')!).toHaveLength(1);
  });

  test('a missing root yields an empty map, not a crash', async () => {
    expect((await collectClaudeUserTurns(join(tmp, 'nope'))).size).toBe(0);
  });
});

describe('computeLoops', () => {
  test('anchors at the prompt and ends at the last event before the gap', () => {
    const loops = computeLoops(
      [ev('s1', T0 + 2 * MIN), ev('s1', T0 + 10 * MIN), ev('s1', T0 + 20 * MIN)],
      turns([['claude-code|s1', [{ at: T0, text: 'go' }]]]),
      'UTC',
    )!;
    expect(loops.longest.durationMs).toBe(20 * MIN);
    expect(loops.longest.steps).toBe(3);
    expect(loops.longest.tokens).toBe(3 * 160); // input + output + cacheWrite, cacheRead excluded
    expect(loops.longest.prompt).toBe('go');
    expect(loops.longest.startClock).toBe('8:00 PM');
    expect(loops.count).toBe(1);
  });

  test('a genuine turn splits a run even when the events are seconds apart', () => {
    const loops = computeLoops(
      [ev('s1', T0 + 1 * MIN), ev('s1', T0 + 2 * MIN), ev('s1', T0 + 3 * MIN)],
      turns([
        [
          'claude-code|s1',
          [
            { at: T0, text: 'first' },
            { at: T0 + 2 * MIN + 30_000, text: 'wait, stop' },
          ],
        ],
      ]),
      'UTC',
    )!;
    // Run 1: T0 → T0+2m (anchored at the prompt). Run 2: the single event at
    // T0+3m, anchored at "wait, stop" 30s earlier.
    expect(loops.count).toBe(2);
    expect(loops.longest.durationMs).toBe(2 * MIN);
    expect(loops.longest.prompt).toBe('first');
    expect(loops.medianMs).toBe(((2 * MIN + 30_000) / 2) | 0);
  });

  test('a 30-min silence breaks the loop even with no human in sight', () => {
    const loops = computeLoops(
      [ev('s1', T0 + MIN), ev('s1', T0 + MIN + SITTING_GAP_MS + 1), ev('s1', T0 + 2 * MIN + SITTING_GAP_MS)],
      turns([['claude-code|s1', [{ at: T0, text: 'go' }]]]),
      'UTC',
    )!;
    expect(loops.count).toBe(2);
    // Run 1 (anchored at the prompt, 60s) narrowly beats run 2, whose stale
    // trigger (> gap away) means it is timed on its own events (59 999 ms).
    expect(loops.longest.durationMs).toBe(MIN);
    expect(loops.longest.prompt).toBe('go');
  });

  test('a stale trigger names the prompt but never extends the clock', () => {
    const loops = computeLoops(
      [ev('s1', T0 + 2 * 3_600_000), ev('s1', T0 + 2 * 3_600_000 + 5 * MIN)],
      turns([['claude-code|s1', [{ at: T0, text: 'run the loop overnight' }]]]),
      'UTC',
    )!;
    expect(loops.longest.durationMs).toBe(5 * MIN);
    expect(loops.longest.prompt).toBe('run the loop overnight');
  });

  test('sessions with no genuine turns and junk cwds are invisible', () => {
    const loops = computeLoops(
      [
        // No turns recorded for this session — automation end-to-end.
        ev('auto', T0),
        ev('auto', T0 + 4 * 3_600_000),
        // Has a turn, but ran from a throwaway dir.
        ev('junk', T0, '/private/tmp/eval-run'),
        ev('junk', T0 + 3_600_000, '/private/tmp/eval-run'),
      ],
      turns([['claude-code|junk', [{ at: T0 - MIN, text: 'evaluate' }]]]),
      'UTC',
    );
    expect(loops).toBeNull();
  });

  test('prompt is cleaned for display: markdown stripped, long text clamped', () => {
    const loops = computeLoops(
      [ev('s1', T0 + MIN)],
      turns([['claude-code|s1', [{ at: T0, text: '## fix `everything`\n' + 'x'.repeat(200) }]]]),
      'UTC',
    )!;
    expect(loops.longest.prompt).not.toContain('#');
    expect(loops.longest.prompt).not.toContain('`');
    expect(loops.longest.prompt!.endsWith('…')).toBe(true);
    expect([...loops.longest.prompt!].length).toBeLessThanOrEqual(91);
  });
});
