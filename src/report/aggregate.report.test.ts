import { describe, test, expect } from 'bun:test';
import { aggregate } from './aggregate.ts';
import type { UsageEvent } from './parsers/types.ts';

// One Claude event + one Pi event (Pi carries a precomputed cost).
const events: UsageEvent[] = [
  {
    tool: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    timestamp: '2026-06-01T14:30:00Z',
    sessionId: 's1',
    projectPath: '/Users/x/Developer/sessions',
    tokens: { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 200 },
  },
  {
    tool: 'pi',
    provider: 'baseten',
    model: 'moonshotai/Kimi-K2.5',
    timestamp: '2026-06-02T09:00:00Z',
    sessionId: 'p1',
    projectPath: '/Users/x/Developer/tokenmaxing',
    tokens: { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    costUSD: 0.12,
  },
];

const data = aggregate({
  events,
  prs: [],
  now: '2026-06-06T00:00:00Z',
  tz: 'UTC',
  exclude: new Set<string>(),
  priorDaily: [],
});

describe('aggregate (report mode)', () => {
  test('schema + emptiness invariants', () => {
    expect(data.schemaVersion).toBe(2);
    expect(data.weeklyHighlights).toEqual([]);
    expect(data.period).toEqual({ from: '2026-06-01', to: '2026-06-06' });
  });

  test('summary totals', () => {
    // Claude totalTokens = 1000+500+200 = 1700 (cacheRead excluded).
    // Claude cost (per-token claude-opus-4-6: in 5e-6, out 25e-6, cacheRead 0.5e-6, cacheWrite 6.25e-6)
    //   = 1000*5e-6 + 500*25e-6 + 10000*0.5e-6 + 200*6.25e-6 = 0.02375 -> 0.02
    // Pi totalTokens = 3000, cost passthrough 0.12.
    expect(data.summary.totalTokens).toBe(4700);
    expect(data.summary.totalCostUSD).toBe(0.14);
    expect(data.summary.sessions).toBe(2);
    expect(data.summary.messages).toBe(2);
    expect(data.summary.activeDays).toBe(2);
    expect(data.summary.longestStreakDays).toBe(2);
    expect(data.summary.currentStreakDays).toBe(0);
    expect(data.summary.peakHourLocal).toBe(9);
    expect(data.summary.favoriteModel.id).toBe('claude-opus-4-6');
  });

  test('daily entries', () => {
    expect(data.daily.length).toBe(2);
    expect(data.daily[0]!.date).toBe('2026-06-01');
    expect(data.daily[0]!.tokens).toBe(1700);
    expect(data.daily[0]!.costUSD).toBe(0.02);
    expect(data.daily[0]!.hourCounts[14]).toBe(1);
    expect(data.daily[1]!.date).toBe('2026-06-02');
    expect(data.daily[1]!.costUSD).toBe(0.12);
  });

  test('breakdowns + insights', () => {
    const tool = data.byTool.find((t) => t.id === 'claude-code')!;
    expect(tool.costUSD).toBe(0.02);
    const pi = data.byTool.find((t) => t.id === 'pi')!;
    expect(pi.costUSD).toBe(0.12);
    expect(data.insights.hourCounts[9]).toBe(1);
    expect(data.insights.hourCounts[14]).toBe(1);
    expect(data.insights.weekdayCounts.reduce((a, b) => a + b, 0)).toBe(2);
  });
});
