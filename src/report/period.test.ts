import { describe, test, expect } from 'bun:test';
import { resolvePeriod, periodRunsTo } from './period.ts';

const TODAY = '2026-06-15';

describe('resolvePeriod', () => {
  test('today', () => {
    expect(resolvePeriod('today', undefined, TODAY)).toEqual({ from: '2026-06-15', to: '2026-06-15' });
  });

  test('this-month → first of month through today', () => {
    expect(resolvePeriod('this-month', undefined, TODAY)).toEqual({ from: '2026-06-01', to: '2026-06-15' });
  });

  test('last-month → full previous calendar month', () => {
    expect(resolvePeriod('last-month', undefined, TODAY)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  test('last-month handles January → previous December', () => {
    expect(resolvePeriod('last-month', undefined, '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  test('this-year → Jan 1 through today', () => {
    expect(resolvePeriod('this-year', undefined, TODAY)).toEqual({ from: '2026-01-01', to: '2026-06-15' });
  });

  test('month YYYY-MM → that whole month (non-leap Feb)', () => {
    expect(resolvePeriod('month', '2026-02', TODAY)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  test('this-week → ends today, starts on a Monday within the last 7 days', () => {
    const wk = resolvePeriod('this-week', undefined, TODAY);
    expect(wk.to).toBe(TODAY);
    expect(new Date(wk.from + 'T00:00:00Z').getUTCDay()).toBe(1); // Monday
    expect(wk.from <= wk.to).toBe(true);
  });

  test('month requires YYYY-MM', () => {
    expect(() => resolvePeriod('month', 'nope', TODAY)).toThrow();
    expect(() => resolvePeriod('month', undefined, TODAY)).toThrow();
  });
});

describe('periodRunsTo', () => {
  test('this-month runs to the end of the month, not to today', () => {
    expect(periodRunsTo('this-month', undefined, '2026-07-30')).toBe('2026-07-31');
    expect(periodRunsTo('this-month', undefined, '2026-02-03')).toBe('2026-02-28');
  });

  test('this-week runs to the closing Sunday', () => {
    // 2026-07-30 is a Thursday; the Monday-start week closes Sunday 2026-08-02.
    expect(periodRunsTo('this-week', undefined, '2026-07-30')).toBe('2026-08-02');
    // A Sunday closes on itself.
    expect(periodRunsTo('this-week', undefined, '2026-08-02')).toBe('2026-08-02');
  });

  test('this-year runs to December 31', () => {
    expect(periodRunsTo('this-year', undefined, '2026-07-30')).toBe('2026-12-31');
  });

  test('closed periods have no forward horizon', () => {
    expect(periodRunsTo('today', undefined, '2026-07-30')).toBeNull();
    expect(periodRunsTo('last-month', undefined, '2026-07-30')).toBeNull();
    expect(periodRunsTo('month', '2026-05', '2026-07-30')).toBeNull();
  });
});
