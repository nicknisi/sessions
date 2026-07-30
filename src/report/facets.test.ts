import { describe, test, expect, beforeEach } from 'bun:test';
import { computeFacets, TOP_DISPATCHES } from './facets.ts';
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

describe('branch facet', () => {
  test('splits one project across branches and counts sessions per branch', () => {
    const { byBranch } = computeFacets(
      [
        ev({ branch: 'main', sessionId: 's1' }),
        ev({ branch: 'feat/x', sessionId: 's2', tokens: { input: 9_000_000 } }),
        ev({ branch: 'feat/x', sessionId: 's3', tokens: { input: 9_000_000 } }),
      ],
      'UTC',
    );
    expect(byBranch.map((b) => b.branch)).toEqual(['feat/x', 'main']);
    expect(byBranch[0]!.sessions).toBe(2);
    expect(byBranch[0]!.project).toBe('sessions');
  });

  test('events from a tool that logs no branch are omitted, not bucketed as unknown', () => {
    const { byBranch } = computeFacets([ev({ tool: 'codex', provider: 'openai', model: 'gpt-5.5' })], 'UTC');
    expect(byBranch).toEqual([]);
  });

  test('the same branch name in two projects stays separate', () => {
    const { byBranch } = computeFacets(
      [
        ev({ branch: 'main', projectPath: '/Users/x/Developer/alpha' }),
        ev({ branch: 'main', projectPath: '/Users/x/Developer/beta' }),
      ],
      'UTC',
    );
    expect(byBranch).toHaveLength(2);
    expect(byBranch.map((b) => b.project).sort()).toEqual(['alpha', 'beta']);
  });
});
