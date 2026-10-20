import { describe, expect, test } from 'bun:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { renderTerminalCard, yearSparkline } from './terminal.ts';
import type { WrappedData } from './types.ts';

const DATA: WrappedData = {
  generator: 'sessions',
  version: 1,
  generatedAt: '2026-12-31T12:00:00Z',
  year: 2026,
  period: { from: '2026-01-01', to: '2026-12-31' },
  dataBegins: null,
  tz: 'UTC',
  warnings: [],
  totals: {
    tokens: 1_200_000_000,
    cacheReadTokens: 0,
    costUSD: 4312.88,
    sessions: 2903,
    messages: 51_204,
    activeDays: 180,
    longestStreak: { days: 54, from: '2026-03-01', to: '2026-04-23' },
  },
  rhythm: { heat: [], peakHour: 23, peakWeekday: 2, nightsPastMidnight: 0, latestNight: null },
  daily: Array.from({ length: 400 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    tokens: i % 9 === 0 ? 0 : 1000 * (i % 13),
    messages: 3,
  })),
  biggestDay: null,
  longestGap: null,
  projects: [],
  models: [],
  modelsTried: 0,
  tools: [],
  cacheHitRate: null,
  longestSession: null,
  loops: null,
  sessionOfYear: null,
  content: null,
  fun: [
    {
      id: 'lies',
      kicker: 'k',
      title: 't',
      stats: [{ big: '36', label: 'messages contained “should work”' }],
      score: 0.5,
    },
    {
      id: 'friction',
      kicker: 'k',
      title: 't',
      stats: [{ big: '649', label: 'times you cut Claude off mid-task' }],
      score: 0.9,
    },
  ],
  wordOfYear: { word: 'refactor', count: 40, sessions: 10, runnersUp: [] },
  persona: {
    name: 'The Nocturnal Refactorer With An Unreasonably Long Name',
    tagline: 'You do your best thinking when everyone else has gone to bed, and it shows in the diffs.',
    axes: [],
    flavor: null,
  },
  extras: [],
};

describe('terminal card', () => {
  test('is a closed box with every row the same width', () => {
    const lines = plain(renderTerminalCard(DATA)).trimEnd().split('\n');
    const box = lines.slice(0, -1);
    for (const l of box) expect([...l].length).toBe(60);
    expect(box[0]!.startsWith('╭')).toBe(true);
    expect(box.at(-1)!.startsWith('╰')).toBe(true);
  });

  test('carries the persona, the four numbers, the top fun stat and the command', () => {
    const out = plain(renderTerminalCard(DATA));
    expect(out).toContain('The Nocturnal Refactorer');
    expect(out).toContain('2,903 sessions');
    expect(out).toContain('1.20B tokens');
    expect(out).toContain('$4,313 at list prices');
    expect(out).toContain('54-day streak');
    expect(out).toContain('649 times you cut Claude off mid-task');
    expect(out).not.toContain('should work');
    expect(out).toContain('word of the year: refactor');
    expect(out).toContain('curl -fsSL https://sessions.engineering/wrapped | sh');
  });

  test('the year strip fits the card and leaves silent weeks blank', () => {
    const spark = yearSparkline(DATA.daily);
    expect([...spark].length).toBeLessThanOrEqual(56);
    expect(
      yearSparkline([
        { date: '2026-01-01', tokens: 5, messages: 1 },
        { date: '2026-01-20', tokens: 5, messages: 1 },
      ]),
    ).toBe('█ █');
  });
});
