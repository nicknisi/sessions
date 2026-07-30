// Resolve named period presets to an inclusive { from, to } local-date range.
// All math is done on YYYY-MM-DD strings via UTC date arithmetic (no local-TZ
// drift), consistent with the rest of the report's day bucketing.

export type PeriodPreset = 'today' | 'this-week' | 'this-month' | 'last-month' | 'this-year' | 'month';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Last calendar day of 1-based month `m` in year `y`.
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The day a preset's period actually runs to, which is not the same as the last
 * day of data it reports. `--this-month` reports up to today (there is no data
 * from the future) but the month runs to its last day — and pacing a month needs
 * the month, not the part of it that has happened.
 *
 * Returns null for presets with no forward horizon, where the period and the
 * data range are the same thing.
 */
export function periodRunsTo(preset: PeriodPreset, month: string | undefined, today: string): string | null {
  const [ty, tm, td] = today.split('-').map(Number);
  const y = ty!;
  const m = tm!;
  const d = td!;
  switch (preset) {
    case 'this-month':
      return fmt(y, m, lastDayOfMonth(y, m));
    case 'this-week': {
      // The Sunday that closes the Monday-start week containing today.
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + ((7 - dt.getUTCDay()) % 7));
      return dt.toISOString().slice(0, 10);
    }
    case 'this-year':
      return fmt(y, 12, 31);
    // today / last-month / month are already closed at their reported end.
    default:
      return null;
  }
}

export function resolvePeriod(
  preset: PeriodPreset,
  month: string | undefined,
  today: string,
): { from: string; to: string } {
  const [ty, tm, td] = today.split('-').map(Number);
  const y = ty!;
  const m = tm!;
  const d = td!;

  switch (preset) {
    case 'today':
      return { from: today, to: today };

    case 'this-week': {
      // Weeks run Monday→Sunday (the report's weeks end on Sunday).
      const dt = new Date(Date.UTC(y, m - 1, d));
      const back = (dt.getUTCDay() + 6) % 7; // days since Monday
      dt.setUTCDate(dt.getUTCDate() - back);
      return { from: dt.toISOString().slice(0, 10), to: today };
    }

    case 'this-month':
      return { from: fmt(y, m, 1), to: today };

    case 'last-month': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: fmt(ly, lm, 1), to: fmt(ly, lm, lastDayOfMonth(ly, lm)) };
    }

    case 'this-year':
      return { from: fmt(y, 1, 1), to: today };

    case 'month': {
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        throw new Error('--month requires a YYYY-MM value');
      }
      const [my, mm] = month.split('-').map(Number);
      return { from: fmt(my!, mm!, 1), to: fmt(my!, mm!, lastDayOfMonth(my!, mm!)) };
    }
  }
}
