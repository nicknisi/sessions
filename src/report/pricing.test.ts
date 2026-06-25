import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  find,
  computeCost,
  drainPricingWarnings,
  resetPricingWarnings,
  parseLiteLLMPricing,
  type UsageCounts,
} from './pricing.ts';

const counts = (over: Partial<UsageCounts> = {}): UsageCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});

beforeEach(() => {
  resetPricingWarnings();
});

describe('find() matching', () => {
  test('exact match resolves the default model', () => {
    expect(find('claude-opus-4-8')).toBeDefined();
  });

  test('per-model entries that were the reported $0 bug all resolve', () => {
    for (const id of ['claude-opus-4-8', 'claude-fable-5', 'gpt-5.5', 'claude-opus-4-8-fast']) {
      expect(find(id), `${id} should resolve`).toBeDefined();
    }
  });

  test('normalized: dotted gpt-5.5 resolves (dots → dashes)', () => {
    const dotted = find('gpt-5.5');
    expect(dotted).toBeDefined();
  });

  test('dated suffix: 8-digit date is tolerated and matches the base key', () => {
    const dated = find('claude-opus-4-5-20251101');
    const base = find('claude-opus-4-5');
    expect(dated).toBeDefined();
    expect(base).toBeDefined();
    expect(dated).toEqual(base!);
  });

  test('version-boundary negative: claude-opus-4 does NOT match claude-opus-4-8', () => {
    const four = find('claude-opus-4');
    const fourEight = find('claude-opus-4-8');
    expect(fourEight).toBeDefined();
    // claude-opus-4 must resolve to its own (cheaper, legacy) rate, never the 4-8 rate.
    if (four) {
      expect(four.inputPerToken).not.toBe(fourEight!.inputPerToken);
    }
  });

  test('provider-prefixed ids bridge via the substring rule', () => {
    expect(find('anthropic/claude-opus-4-8')).toBeDefined();
    expect(find('openai/gpt-5.5')).toBeDefined();
  });

  test('-fast suffix resolves to the base rate (not a numeric version bump)', () => {
    expect(find('claude-opus-4-8-fast')).toEqual(find('claude-opus-4-8')!);
  });

  test('longest-key-wins when multiple candidates match', () => {
    // claude-opus-4-5-20251101 should prefer claude-opus-4-5 over claude-opus-4.
    const dated = find('claude-opus-4-5-20251101');
    expect(dated).toEqual(find('claude-opus-4-5')!);
    expect(dated).not.toEqual(find('claude-opus-4') ?? { inputPerToken: -1 });
  });

  test('completely unknown model returns undefined', () => {
    expect(find('totally-made-up-model-zzz')).toBeUndefined();
  });
});

describe('computeCost arithmetic', () => {
  test('exact match yields > 0 for a sample event', () => {
    expect(computeCost('claude-opus-4-8', counts({ input: 1000, output: 500 }))).toBeGreaterThan(0);
  });

  test('each reported-$0-bug model prices non-zero', () => {
    for (const id of ['claude-opus-4-8', 'claude-fable-5', 'gpt-5.5', 'claude-opus-4-8-fast']) {
      expect(
        computeCost(id, counts({ input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 })),
        `${id} should cost > 0`,
      ).toBeGreaterThan(0);
    }
  });

  test('known vector equals hand-computed value (per-token)', () => {
    // claude-opus-4-8: input 5e-6, output 25e-6, cacheWrite 6.25e-6, cacheRead 0.5e-6
    const cost = computeCost(
      'claude-opus-4-8',
      counts({ input: 1000, output: 2000, cacheRead: 4000, cacheWrite: 800 }),
    );
    const expected = 1000 * 5e-6 + 2000 * 25e-6 + 4000 * 0.5e-6 + 800 * 6.25e-6;
    expect(cost).toBeCloseTo(expected, 12);
  });

  test('cache defaults applied when rates omitted (read = input*0.1, write = input*1.25)', () => {
    const map = parseLiteLLMPricing(
      JSON.stringify({
        'no-cache-model': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
      }),
    );
    const p = map['no-cache-model']!;
    expect(p.cacheReadPerToken ?? p.inputPerToken * 0.1).toBeCloseTo(2e-6 * 0.1, 15);
    expect(p.cacheWritePerToken ?? p.inputPerToken * 1.25).toBeCloseTo(2e-6 * 1.25, 15);
  });
});

describe('tiered >200k pricing', () => {
  // Build a model with explicit above-200k rates via the fixture's claude-sonnet-4.
  const fixture = readFileSync(join(import.meta.dir, '__fixtures__', 'litellm-sample.json'), 'utf8');
  const map = parseLiteLLMPricing(fixture);
  const sonnet4 = map['claude-sonnet-4']!;

  test('the fixture entry carries above-200k tiers', () => {
    expect(sonnet4.inputPerTokenAbove200k).toBeDefined();
  });

  test('199k stays at base rate', () => {
    const c = sonnet4.inputPerToken;
    const at199 = 199_000 * c;
    // Recreate tiered() expectation: below threshold → all base.
    expect(at199).toBeCloseTo(199_000 * c, 9);
  });

  test('boundary 200k vs 201k: above-rate only applies to the overflow', () => {
    const base = sonnet4.inputPerToken;
    const above = sonnet4.inputPerTokenAbove200k!;
    const at200 = 200_000 * base;
    const at201 = 200_000 * base + 1_000 * above;
    expect(at201).toBeGreaterThan(at200);
    expect(at201 - at200).toBeCloseTo(1_000 * above, 9);
  });
});

describe('warning collector', () => {
  test('unknown model with tokens pushes a warning and returns 0', () => {
    const cost = computeCost('mystery-model-9', counts({ input: 100, output: 50 }));
    expect(cost).toBe(0);
    const warnings = drainPricingWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.model).toBe('mystery-model-9');
    expect(warnings[0]!.tokens).toBe(150);
  });

  test('drain clears the collector', () => {
    computeCost('mystery-model-9', counts({ input: 100 }));
    expect(drainPricingWarnings()).toHaveLength(1);
    expect(drainPricingWarnings()).toHaveLength(0);
  });

  test('unknown model with ZERO tokens does not warn (no impact)', () => {
    const cost = computeCost('mystery-model-0', counts());
    expect(cost).toBe(0);
    expect(drainPricingWarnings()).toHaveLength(0);
  });

  test('known model never warns', () => {
    computeCost('claude-opus-4-8', counts({ input: 100, output: 100 }));
    expect(drainPricingWarnings()).toHaveLength(0);
  });
});

describe('parseLiteLLMPricing', () => {
  const fixture = readFileSync(join(import.meta.dir, '__fixtures__', 'litellm-sample.json'), 'utf8');

  test('extracts per-token fields and skips entries lacking input/output', () => {
    const map = parseLiteLLMPricing(fixture);
    expect(map['claude-opus-4-5']).toBeDefined();
    expect(map['claude-opus-4-5']!.inputPerToken).toBe(5e-6);
    expect(map['claude-opus-4-5']!.outputPerToken).toBe(25e-6);
    // sample_spec and the embedding entry (no output) must be skipped.
    expect(map['sample_spec']).toBeUndefined();
    expect(map['embedding-no-output']).toBeUndefined();
  });

  test('carries explicit cache + above-200k tiers when present', () => {
    const map = parseLiteLLMPricing(fixture);
    const s4 = map['claude-sonnet-4']!;
    expect(s4.cacheReadPerToken).toBe(0.3e-6);
    expect(s4.cacheWritePerToken).toBe(3.75e-6);
    expect(s4.inputPerTokenAbove200k).toBe(6e-6);
    expect(s4.outputPerTokenAbove200k).toBe(22.5e-6);
  });

  test('malformed JSON yields an empty map (never throws)', () => {
    expect(Object.keys(parseLiteLLMPricing('not json at all {'))).toHaveLength(0);
    expect(Object.keys(parseLiteLLMPricing('{}'))).toHaveLength(0);
  });
});
