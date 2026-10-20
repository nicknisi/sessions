// The terminal card: a screenshot-sized summary printed before the browser
// opens. Developers post terminal screenshots more readily than anything else,
// so the payoff has to exist here too, not only behind a page they may never
// switch to. Same honesty rules as the page: counted numbers only.

import { C } from '../colors.ts';
import { WRAPPED_CMD } from '../site.ts';
import type { WrappedData } from './types.ts';

/** Inner width. With the border and padding the card is 60 columns — narrow
 *  enough for a half-width terminal and a phone-sized screenshot. */
const INNER = 56;
const SPARKS = '▁▂▃▄▅▆▇█';

const fmtInt = (n: number): string => n.toLocaleString('en-US');

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// shortcut: counts code points, so a wide (CJK/emoji) character in a project or
// persona name misaligns the right border; use a wcwidth table if that shows up.
const width = (s: string): number => [...s].length;

function wrapText(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && width(next) > max) {
      out.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) out.push(cur);
  // A single word longer than the line is cut rather than allowed to break the border.
  return out.map((l) => (width(l) > max ? [...l].slice(0, max - 1).join('') + '…' : l));
}

/** The year as one sparkline character per week, by tokens (messages on a
 *  local-model year with no token meter). */
export function yearSparkline(daily: WrappedData['daily'], max = INNER): string {
  if (daily.length === 0) return '';
  const byTokens = daily.some((d) => d.tokens > 0);
  const weeks: number[] = [];
  const start = Date.parse(`${daily[0]!.date}T00:00:00Z`);
  for (const d of daily) {
    const w = Math.floor((Date.parse(`${d.date}T00:00:00Z`) - start) / (7 * 86_400_000));
    weeks[w] = (weeks[w] ?? 0) + (byTokens ? d.tokens : d.messages);
  }
  const vals = Array.from(weeks, (v) => v ?? 0).slice(-max);
  const peak = Math.max(...vals, 1);
  return vals.map((v) => (v === 0 ? ' ' : SPARKS[Math.min(7, Math.floor((v / peak) * 7.999))])).join('');
}

export function renderTerminalCard(d: WrappedData): string {
  const t = d.totals;
  // Each row is [plain text, styled text]: the plain one measures, the styled one prints.
  const rows: [string, string][] = [];
  const row = (plain: string, styled = plain) => rows.push([plain, styled]);
  const blank = () => row('');

  const year = String(d.year);
  const brand = 'SESSIONS WRAPPED';
  row(
    brand + ' '.repeat(INNER - brand.length - year.length) + year,
    `${C.purple}${C.bold}${brand}${C.reset}${' '.repeat(INNER - brand.length - year.length)}${C.gray}${year}${C.reset}`,
  );
  blank();

  if (d.persona) {
    row('this year you were', `${C.gray}this year you were${C.reset}`);
    for (const l of wrapText(d.persona.name, INNER)) row(l, `${C.purple}${C.bold}${l}${C.reset}`);
    for (const l of wrapText(d.persona.tagline, INNER)) row(l);
    blank();
  }

  // Same four as the image: never a meaningless zero.
  const stats: [string, string][] = [[fmtInt(t.sessions), 'sessions']];
  if (t.tokens > 0) stats.push([fmtTokens(t.tokens), 'tokens']);
  if (t.costUSD > 0) stats.push([`$${fmtInt(Math.round(t.costUSD))}`, 'at list prices']);
  else stats.push([fmtInt(t.messages), 'replies']);
  stats.push(t.longestStreak ? [`${t.longestStreak.days}-day`, 'streak'] : [fmtInt(t.activeDays), 'active days']);
  const cell = 27;
  for (let i = 0; i < stats.length; i += 2) {
    const pair = stats.slice(i, i + 2);
    const plain = pair.map(([v, l]) => `${v} ${l}`.padEnd(cell)).join('');
    const styled = pair
      .map(
        ([v, l]) =>
          `${C.purple}${C.bold}${v}${C.reset} ${C.gray}${l}${C.reset}${' '.repeat(cell - width(`${v} ${l}`))}`,
      )
      .join('');
    row(plain.trimEnd(), styled.trimEnd());
  }

  const spark = yearSparkline(d.daily);
  if (spark) {
    blank();
    row(spark, `${C.purple}${spark}${C.reset}`);
  }

  const top = [...d.fun].sort((a, b) => b.score - a.score)[0]?.stats[0];
  if (top || d.wordOfYear) blank();
  if (top) for (const l of wrapText(`${top.big} ${top.label}`, INNER)) row(l);
  if (d.wordOfYear) {
    const plain = `word of the year: ${d.wordOfYear.word}`;
    if (width(plain) <= INNER)
      row(plain, `${C.gray}word of the year:${C.reset} ${C.bold}${d.wordOfYear.word}${C.reset}`);
  }

  const bar = '─'.repeat(INNER + 2);
  const lines = [`${C.gray}╭${bar}╮${C.reset}`];
  for (const [plain, styled] of rows) {
    lines.push(`${C.gray}│${C.reset} ${styled}${' '.repeat(Math.max(0, INNER - width(plain)))} ${C.gray}│${C.reset}`);
  }
  lines.push(`${C.gray}╰${bar}╯${C.reset}`);
  lines.push(`  ${C.gray}make yours:${C.reset} ${WRAPPED_CMD}`);
  return lines.join('\n') + '\n';
}
