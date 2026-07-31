import { describe, expect, test } from 'bun:test';
import { equivalences, equivalenceChoices, pickEquivalence } from './equivalence.ts';

describe('equivalences', () => {
  test('offers nothing for a trivial or impossible total', () => {
    expect(equivalences(50_000)).toEqual([]);
    expect(equivalences(0)).toEqual([]);
    expect(equivalences(-1)).toEqual([]);
    expect(equivalences(Number.NaN)).toEqual([]);
    expect(pickEquivalence(50_000, 'seed')).toBeNull();
  });

  test('keeps every multiplier inside the readable band', () => {
    // The whole point of the filter: no "0.3 Wikipedias", no "48,000 Hobbits".
    for (const tokens of [400_000, 2_000_000, 40_000_000, 300_000_000, 1_200_000_000, 20_000_000_000]) {
      const all = equivalences(tokens);
      expect(all.length).toBeGreaterThan(0);
      for (const e of all) {
        const n = Number(e.value.replace(/[^0-9.]/g, ''));
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThan(1000);
      }
    }
  });

  test('swaps the pool as the magnitude climbs', () => {
    const small = equivalences(2_000_000).map((e) => e.id);
    const huge = equivalences(20_000_000_000).map((e) => e.id);
    // Short books measure a small year and drop out of a giant one; the kernel
    // and Wikipedia do the reverse.
    expect(small).toContain('gatsby');
    expect(small).not.toContain('linux');
    expect(huge).toContain('wikipedia');
    expect(huge).not.toContain('gatsby');
  });

  test('mixes count frames with time frames', () => {
    const ids = equivalences(1_200_000_000).map((e) => e.id);
    expect(ids).toContain('harry-potter');
    expect(ids).toContain('linux');
    expect(ids).toContain('typing');
  });

  test('drops a trailing .0 but keeps a real decimal', () => {
    // 2M tokens puts Dune at exactly 8.0x — "8.0" reads like a rounding artifact.
    const dune = equivalences(2_000_000).find((e) => e.id === 'dune');
    expect(dune?.value).toBe('8');
    const kernel = equivalences(1_200_000_000).find((e) => e.id === 'linux');
    expect(kernel?.value).toBe('3.3');
  });

  test('renders the time frames as spans, not counts', () => {
    const typing = (t: number) => equivalences(t).find((e) => e.id === 'typing')?.value;
    expect(typing(400_000)).toBe('3 days');
    expect(typing(40_000_000)).toBe('260 days');
    expect(typing(1_200_000_000)).toBe('21 yrs');
  });
});

describe('seeding', () => {
  test('is stable for the same tokens and seed', () => {
    // A repaint after an accent change must not reshuffle the copy.
    const once = pickEquivalence(1_200_000_000, '2025|sharecard');
    for (let i = 0; i < 20; i++) {
      expect(pickEquivalence(1_200_000_000, '2025|sharecard')).toEqual(once);
    }
  });

  test('differs across seeds so two slots on one page disagree', () => {
    const seeds = ['2025|ratecard', '2025|sharecard', '2024|ratecard', '2023|ratecard'];
    const picked = new Set(seeds.map((s) => pickEquivalence(1_200_000_000, s)?.id));
    expect(picked.size).toBeGreaterThan(1);
  });

  test('start always indexes a real option', () => {
    for (const tokens of [400_000, 40_000_000, 20_000_000_000]) {
      const { options, start } = equivalenceChoices(tokens, 'seed');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThan(options.length);
      expect(options[start]).toBeDefined();
    }
  });

  test('an empty pool yields a safe start index', () => {
    expect(equivalenceChoices(50_000, 'seed')).toEqual({ options: [], start: 0 });
  });
});
