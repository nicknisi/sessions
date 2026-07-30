import { describe, test, expect, beforeEach } from 'bun:test';
import { computeFacets, computeBurn, TOP_DISPATCHES, TOP_SESSIONS } from './facets.ts';
import { resetPricing, resetPricingWarnings, drainPricingWarnings } from './pricing.ts';
import type { UsageEvent } from './parsers/types.ts';

beforeEach(() => {
  resetPricing();
  resetPricingWarnings();
});

type EventOverrides = Omit<Partial<UsageEvent>, 'tokens'> & { tokens?: Partial<UsageEvent['tokens']> };

function ev(over: EventOverrides = {}): UsageEvent {
  const { tokens, ...rest } = over;
  return {
    tool: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    timestamp: '2026-06-01T14:30:00Z',
    sessionId: 's1',
    projectPath: '/Users/x/Developer/sessions',
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 200, ...tokens },
    ...rest,
  };
}

describe('cache facet', () => {
  test('hit rate is cache read over all prompt-side tokens', () => {
    const { cache } = computeFacets([ev({ tokens: { input: 1000, cacheWrite: 1000, cacheRead: 8000 } })], 'UTC');
    expect(cache.cacheReadTokens).toBe(8000);
    expect(cache.hitRate).toBeCloseTo(0.8, 4);
  });

  test('output tokens do not dilute the hit rate', () => {
    const a = computeFacets([ev({ tokens: { input: 100, cacheWrite: 0, cacheRead: 900, output: 0 } })], 'UTC');
    const b = computeFacets([ev({ tokens: { input: 100, cacheWrite: 0, cacheRead: 900, output: 999999 } })], 'UTC');
    expect(a.cache.hitRate).toBe(b.cache.hitRate);
  });

  test('no prompt tokens at all yields 0, not NaN', () => {
    const { cache } = computeFacets([ev({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })], 'UTC');
    expect(cache.hitRate).toBe(0);
    expect(cache.savedUSD).toBe(0);
  });

  test('savings are the gap between the cache-read rate and the input rate', () => {
    // claude-opus-4-8: input $5/MTok, cache read $0.50/MTok → $4.50 per MTok saved.
    const { cache } = computeFacets(
      [ev({ tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 } })],
      'UTC',
    );
    expect(cache.savedUSD).toBeCloseTo(4.5, 2);
  });

  test('an unpriced model reports no savings and adds no warnings of its own', () => {
    resetPricingWarnings();
    const { cache } = computeFacets(
      [ev({ model: 'totally-unknown-model', tokens: { cacheRead: 1_000_000, input: 0, output: 0, cacheWrite: 0 } })],
      'UTC',
    );
    expect(cache.savedUSD).toBe(0);
    // One warning from costOf, not three from also pricing the savings both ways.
    expect(drainPricingWarnings()).toHaveLength(1);
  });
});

describe('subagent facet', () => {
  const main = ev({ tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const sub = (id: string, type: string, input = 1_000_000): UsageEvent =>
    ev({ agent: { id, type }, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

  test('rolls up spend, dispatch count, and share of total cost', () => {
    const { subagents } = computeFacets([main, sub('a1', 'Explore'), sub('a2', 'Explore')], 'UTC');
    expect(subagents.dispatches).toBe(2);
    expect(subagents.shareOfCost).toBeCloseTo(2 / 3, 3);
    expect(subagents.byType).toHaveLength(1);
    expect(subagents.byType[0]).toMatchObject({ agentType: 'Explore', dispatches: 2, messages: 2 });
  });

  test('counts dispatches distinctly, not per message', () => {
    const { subagents } = computeFacets([sub('a1', 'Explore'), sub('a1', 'Explore')], 'UTC');
    expect(subagents.dispatches).toBe(1);
    expect(subagents.byType[0]!.messages).toBe(2);
  });

  test('main-loop-only input leaves the facet empty rather than absent', () => {
    const { subagents } = computeFacets([main], 'UTC');
    expect(subagents).toMatchObject({ dispatches: 0, costUSD: 0, tokens: 0, shareOfCost: 0 });
    expect(subagents.topDispatches).toEqual([]);
  });

  test('types sort by cost, dispatches by cost', () => {
    const { subagents } = computeFacets(
      [sub('a1', 'cheap', 100), sub('a2', 'pricey', 5_000_000), sub('a3', 'mid', 900_000)],
      'UTC',
    );
    expect(subagents.byType.map((t) => t.agentType)).toEqual(['pricey', 'mid', 'cheap']);
    expect(subagents.topDispatches[0]!.agentId).toBe('a2');
  });

  test('the dispatch list is capped but reports the true total', () => {
    const many = Array.from({ length: TOP_DISPATCHES + 7 }, (_, i) => sub(`a${i}`, 'Explore', 1000 * (i + 1)));
    const { subagents } = computeFacets(many, 'UTC');
    expect(subagents.topDispatches).toHaveLength(TOP_DISPATCHES);
    expect(subagents.totalDispatches).toBe(TOP_DISPATCHES + 7);
  });

  test('a dispatch is dated by its earliest message regardless of input order', () => {
    const late = ev({ agent: { id: 'a1', type: 'Explore' }, timestamp: '2026-06-03T10:00:00Z' });
    const early = ev({ agent: { id: 'a1', type: 'Explore' }, timestamp: '2026-06-01T10:00:00Z' });
    const { subagents } = computeFacets([late, early], 'UTC');
    expect(subagents.topDispatches[0]!.date).toBe('2026-06-01');
  });
});

describe('session-cost facet', () => {
  test('groups by session, ranks by cost, and reports the true total', () => {
    const { topSessions, totalSessions } = computeFacets(
      [
        ev({ sessionId: 'cheap', tokens: { input: 1000 } }),
        ev({ sessionId: 'dear', tokens: { input: 5_000_000 } }),
        ev({ sessionId: 'dear', tokens: { input: 5_000_000 } }),
      ],
      'UTC',
    );
    expect(totalSessions).toBe(2);
    expect(topSessions[0]!.sessionId).toBe('dear');
    expect(topSessions[0]!.messages).toBe(2);
    expect(topSessions[0]!.intent).toBeNull();
  });

  test('the same session id under two tools stays two sessions', () => {
    const { totalSessions } = computeFacets(
      [ev({ sessionId: 'x' }), ev({ sessionId: 'x', tool: 'codex', provider: 'openai', model: 'gpt-5.5' })],
      'UTC',
    );
    expect(totalSessions).toBe(2);
  });

  test('reports the branch the session spent the most on, not the first seen', () => {
    const { topSessions } = computeFacets(
      [
        ev({ sessionId: 's1', branch: 'main', tokens: { input: 1000 } }),
        ev({ sessionId: 's1', branch: 'feat/x', tokens: { input: 5_000_000 } }),
      ],
      'UTC',
    );
    expect(topSessions[0]!.branch).toBe('feat/x');
  });

  test('a session from a tool that logs no branch reports null, not empty string', () => {
    const { topSessions } = computeFacets([ev({ tool: 'codex', provider: 'openai', model: 'gpt-5.5' })], 'UTC');
    expect(topSessions[0]!.branch).toBeNull();
  });

  test('separates the subagent share of a session from its total', () => {
    const { topSessions } = computeFacets(
      [
        ev({ sessionId: 's1', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        ev({
          sessionId: 's1',
          agent: { id: 'a1', type: 'Explore' },
          tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
      'UTC',
    );
    expect(topSessions[0]!.costUSD).toBeCloseTo(10, 2);
    expect(topSessions[0]!.subagentCostUSD).toBeCloseTo(5, 2);
  });

  test('is dated by the session’s first message', () => {
    const { topSessions } = computeFacets(
      [
        ev({ sessionId: 's1', timestamp: '2026-06-05T10:00:00Z' }),
        ev({ sessionId: 's1', timestamp: '2026-06-02T10:00:00Z' }),
      ],
      'UTC',
    );
    expect(topSessions[0]!.date).toBe('2026-06-02');
  });

  test('the list is capped at TOP_SESSIONS', () => {
    const many = Array.from({ length: TOP_SESSIONS + 5 }, (_, i) =>
      ev({ sessionId: `s${i}`, tokens: { input: 1000 * (i + 1) } }),
    );
    const { topSessions, totalSessions } = computeFacets(many, 'UTC');
    expect(topSessions).toHaveLength(TOP_SESSIONS);
    expect(totalSessions).toBe(TOP_SESSIONS + 5);
  });
});

describe('cost per dispatch', () => {
  const sub = (id: string, input: number): UsageEvent =>
    ev({ agent: { id, type: 'Explore' }, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

  test('divides total spend by dispatches, not by messages', () => {
    // Three messages, two dispatches: the average is per dispatch.
    const { subagents } = computeFacets([sub('a1', 1_000_000), sub('a1', 1_000_000), sub('a2', 2_000_000)], 'UTC');
    const t = subagents.byType[0]!;
    expect(t.messages).toBe(3);
    expect(t.dispatches).toBe(2);
    expect(t.costUSD).toBeCloseTo(20, 2);
    expect(t.costPerDispatchUSD).toBeCloseTo(10, 2);
  });
});

describe('session distribution', () => {
  const at = (id: string, input: number): UsageEvent =>
    ev({ sessionId: id, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

  test('covers every session, not just the ones in the table', () => {
    const many = Array.from({ length: TOP_SESSIONS + 20 }, (_, i) => at(`s${i}`, 200_000 * (i + 1)));
    const { sessionDistribution, topSessions } = computeFacets(many, 'UTC');
    expect(topSessions).toHaveLength(TOP_SESSIONS);
    expect(sessionDistribution.count).toBe(TOP_SESSIONS + 20);
  });

  test('median, p90 and max describe the shape', () => {
    // Costs of $1..$10 at $1 per 200k input tokens on opus-4-8 ($5/MTok).
    const evs = Array.from({ length: 10 }, (_, i) => at(`s${i}`, 200_000 * (i + 1)));
    const { sessionDistribution: d } = computeFacets(evs, 'UTC');
    expect(d.medianUSD).toBeCloseTo(5, 2);
    expect(d.p90USD).toBeCloseTo(9, 2);
    expect(d.maxUSD).toBeCloseTo(10, 2);
    expect(d.meanUSD).toBeCloseTo(5.5, 2);
  });

  test('one session is its own median and max', () => {
    const { sessionDistribution: d } = computeFacets([at('s1', 1_000_000)], 'UTC');
    expect(d.count).toBe(1);
    expect(d.medianUSD).toBe(d.maxUSD);
  });

  test('no sessions yields zeros rather than NaN', () => {
    const { sessionDistribution: d } = computeFacets([], 'UTC');
    expect(d).toEqual({ count: 0, medianUSD: 0, p90USD: 0, maxUSD: 0, meanUSD: 0 });
  });
});

describe('model mix', () => {
  const on = (day: string, model: string, input: number): UsageEvent =>
    ev({ model, timestamp: `${day}T12:00:00Z`, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

  test('splits each week by model and orders models by total cost', () => {
    const { modelWeekly, modelOrder } = computeFacets(
      [
        on('2026-06-01', 'claude-opus-4-8', 1_000_000),
        on('2026-06-08', 'claude-haiku-4-5', 1_000_000),
        on('2026-06-08', 'claude-opus-4-8', 1_000_000),
      ],
      'UTC',
    );
    expect(modelOrder).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(modelWeekly).toHaveLength(2);
    expect(Object.keys(modelWeekly[1]!.byModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
  });

  test('fills the gap weeks so the series can be drawn without holes', () => {
    const { modelWeekly } = computeFacets(
      [on('2026-06-01', 'claude-opus-4-8', 1000), on('2026-06-29', 'claude-opus-4-8', 1000)],
      'UTC',
    );
    expect(modelWeekly.length).toBeGreaterThanOrEqual(5);
    expect(modelWeekly.some((w) => w.totalUSD === 0)).toBe(true);
  });
});

describe('burn', () => {
  const spend = (day: string, input: number): UsageEvent =>
    ev({ timestamp: `${day}T12:00:00Z`, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });

  test('projects a running period from the days elapsed', () => {
    // $1/day for 5 of 10 days -> $10 projected.
    const evs = Array.from({ length: 5 }, (_, i) => spend(`2026-06-0${i + 1}`, 200_000));
    const b = computeBurn(evs, null, { from: '2026-06-01', to: '2026-06-10' }, '2026-06-05');
    expect(b.inProgress).toBe(true);
    expect(b.elapsedDays).toBe(5);
    expect(b.periodDays).toBe(10);
    expect(b.spentUSD).toBeCloseTo(5, 2);
    expect(b.projectedUSD).toBeCloseTo(10, 2);
  });

  test('a finished period projects to exactly what it cost', () => {
    const b = computeBurn([spend('2026-06-01', 200_000)], null, { from: '2026-06-01', to: '2026-06-10' }, '2026-07-01');
    expect(b.inProgress).toBe(false);
    expect(b.projectedUSD).toBe(b.spentUSD);
    expect(b.elapsedDays).toBe(b.periodDays);
  });

  test('the last day of a period is not still in progress', () => {
    const b = computeBurn([spend('2026-06-10', 200_000)], null, { from: '2026-06-01', to: '2026-06-10' }, '2026-06-10');
    expect(b.inProgress).toBe(false);
  });

  test('compares against the prior window when one was gathered', () => {
    const now = [spend('2026-06-01', 400_000)];
    const before = [spend('2026-05-01', 200_000)];
    const b = computeBurn(now, before, { from: '2026-06-01', to: '2026-06-10' }, '2026-07-01');
    expect(b.priorPeriodUSD).toBeCloseTo(1, 2);
    expect(b.changePct).toBeCloseTo(1, 2); // doubled
  });

  test('no prior window means no comparison, not a zero one', () => {
    const b = computeBurn([spend('2026-06-01', 200_000)], null, { from: '2026-06-01', to: '2026-06-10' }, '2026-07-01');
    expect(b.priorPeriodUSD).toBeNull();
    expect(b.changePct).toBeNull();
  });

  test('a prior window that cost nothing yields no percentage rather than infinity', () => {
    const b = computeBurn([spend('2026-06-01', 200_000)], [], { from: '2026-06-01', to: '2026-06-10' }, '2026-07-01');
    expect(b.priorPeriodUSD).toBe(0);
    expect(b.changePct).toBeNull();
  });
});
