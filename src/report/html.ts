import type {
  UsageReport,
  ToolBreakdown,
  ModelBreakdown,
  ProjectBreakdown,
  SessionCost,
  SessionDistribution,
  ModelWeek,
  BurnStats,
  SubagentReport,
  CacheStats,
  PricingWarning,
  DailyEntry,
} from './schema.ts';
import { equivalenceChoices, pickEquivalence } from '../equivalence.ts';
import { SITE_HOST, SITE_URL } from '../site.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON destined for a <script> block: `<` is the only character that can close
 *  the block early, so it is the only one that has to go. */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const fmtUSD = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Whole dollars. Peak labels and the rate line round, because cents there are
 *  noise around a number the reader is only comparing by magnitude. */
const fmtUSD0 = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** fmtTokens split at its magnitude suffix, so the suffix can be set smaller and
 *  in the accent without the numeral losing its baseline. */
function splitMagnitude(n: number): { num: string; suffix: string } {
  const s = fmtTokens(n);
  const m = /^([\d.,]+)([A-Z]*)$/.exec(s);
  return { num: m?.[1] ?? s, suffix: m?.[2] ?? '' };
}

/** The same split, rendered — a big numeral with a small accented magnitude. */
function magnitude(n: number): string {
  const { num, suffix } = splitMagnitude(n);
  return esc(num) + (suffix ? `<span class="sfx">${esc(suffix)}</span>` : '');
}

const fmtInt = (n: number): string => n.toLocaleString('en-US');

const fmtPct = (frac: number): string => (frac * 100).toFixed(1) + '%';

/** Round to 2dp for SVG geometry: enough for sub-pixel placement, short enough
 *  that a 400-rect chart is not 400 seventeen-digit floats. */
const f = (n: number): number => Math.round(n * 100) / 100;

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? h + ' AM' : h - 12 + ' PM';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(ymdStr: string): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

/** "Mar 25" — the compact form used in peak labels and on the share card. */
function shortDate(ymdStr: string): string {
  const [, m, d] = ymdStr.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}`;
}

function periodLabel(from: string, to: string): string {
  return from === to ? formatDate(from) : `${formatDate(from)} → ${formatDate(to)}`;
}

const DAY_MS = 86_400_000;

const parseYmd = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
const toYmd = (dt: Date): string => dt.toISOString().slice(0, 10);
/** Inclusive day count between two YYYY-MM-DD dates. */
const spanDays = (from: string, to: string): number =>
  Math.max(1, Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / DAY_MS) + 1);

const sum = (ns: number[]): number => ns.reduce((t, n) => t + n, 0);
/** Every rate on this page is a division by something that can be zero — an
 *  empty period, a report with no sessions. None of them may render NaN. */
const safeDiv = (a: number, b: number): number => (b > 0 ? a / b : 0);

// ---------------------------------------------------------------------------
// Palette
//
// Neutrals are fixed per theme. Everything with hue in it derives from one
// accent — a hue + chroma pair — rather than being listed per shade, so adding
// an accent is two numbers and every chart, ramp, and the share card follow it.
//
// The rule that matters for the two ramps: the model-mix series and the heatmap
// are LIGHTNESS ramps of a single hue (±18° at the extremes), never a rotation
// around the wheel. Rotating hues reintroduces exactly the colours the accent
// was chosen to avoid.
// ---------------------------------------------------------------------------
const ACCENTS = {
  violet: { h: 288, c: 0.2 },
  cyan: { h: 212, c: 0.14 },
  magenta: { h: 348, c: 0.21 },
  mono: { h: 265, c: 0.022 },
} as const;

type AccentName = keyof typeof ACCENTS;

const ACCENT_ORDER: AccentName[] = ['violet', 'cyan', 'magenta', 'mono'];
const DEFAULT_ACCENT: AccentName = 'violet';

const ok = (l: number, c: number, h: number): string =>
  `oklch(${l}% ${Math.round(c * 1000) / 1000} ${((Math.round(h) % 360) + 360) % 360})`;

export interface Palette {
  accent: string;
  accentInk: string;
  hero: string;
  dotAccent: string;
  glow: string;
  linkHover: string;
  /** Chart fills: every bar that is not the peak, the peak itself, the clock
   *  spokes, and the hero sparkline. */
  base: string;
  peak: string;
  spoke: string;
  spark: string;
  /** Five heat levels; index 0 is "no activity". */
  heat: string[];
  /** Six model-mix bands; index 5 is the pooled "other". */
  mix: string[];
  /** Canvas-only surface trio. The share card is a standalone image rather than
   *  part of the page, so in light mode it sits a step lighter than the shell. */
  cardBg: string;
  cardInk: string;
  cardInk2: string;
}

export function palette(name: AccentName, light: boolean): Palette {
  const { h, c } = ACCENTS[name];
  return light
    ? {
        accent: ok(48, c * 0.92, h),
        accentInk: ok(98, 0.02, h),
        hero: ok(24, 0.045, h),
        dotAccent: ok(74, c * 0.5, h),
        glow: 'none',
        linkHover: ok(34, c * 0.8, h),
        base: ok(78, c * 0.5, h + 6),
        peak: ok(46, c * 0.95, h),
        spoke: ok(83, c * 0.35, h + 6),
        spark: ok(85, c * 0.3, h + 6),
        heat: [
          'oklch(93% 0.005 95)',
          ok(89, c * 0.28, h + 10),
          ok(78, c * 0.55, h + 5),
          ok(62, c * 0.8, h),
          ok(47, c * 0.95, h),
        ],
        mix: [
          ok(44, c * 0.95, h),
          ok(54, c * 0.85, h + 14),
          ok(64, c * 0.7, h - 14),
          ok(73, c * 0.5, h + 8),
          ok(82, c * 0.32, h - 8),
          'oklch(88% 0.006 265)',
        ],
        cardBg: 'oklch(97% 0.004 95)',
        cardInk: 'oklch(21% 0.01 265)',
        cardInk2: 'oklch(46% 0.015 265)',
      }
    : {
        accent: ok(82, c, h),
        accentInk: ok(17, 0.05, h),
        hero: ok(97, 0.012, h),
        dotAccent: ok(46, c * 0.5, h),
        glow: `0 0 60px ${ok(82, c, h).replace(')', ' / .32)')}`,
        linkHover: ok(92, c * 0.8, h),
        base: ok(52, c * 0.6, h + 8),
        peak: ok(82, c, h),
        spoke: ok(46, c * 0.5, h + 12),
        spark: ok(40, c * 0.45, h + 14),
        heat: [
          'oklch(23% 0.012 265)',
          ok(36, c * 0.35, h + 18),
          ok(52, c * 0.6, h + 10),
          ok(68, c * 0.85, h + 4),
          ok(82, c, h),
        ],
        mix: [
          ok(86, c * 0.95, h),
          ok(75, c, h + 14),
          ok(64, c * 0.9, h - 14),
          ok(54, c * 0.7, h + 8),
          ok(44, c * 0.5, h - 8),
          'oklch(36% 0.018 265)',
        ],
        cardBg: 'oklch(13.5% 0.014 265)',
        cardInk: 'oklch(95% 0.005 265)',
        cardInk2: 'oklch(66% 0.02 265)',
      };
}

/** Every accent × theme, precomputed here and shipped as data. The CSS
 *  fallback, the runtime custom properties, and the canvas card all read this
 *  one object, so none of the three can drift from the others. */
const PALETTES: Record<string, { dark: Palette; light: Palette }> = Object.fromEntries(
  ACCENT_ORDER.map((name) => [name, { dark: palette(name, false), light: palette(name, true) }]),
);

/** The accent-derived half of the custom properties, as a declaration list.
 *  Emitted statically for the default accent so the page is fully styled with
 *  JavaScript off, then rewritten on the root element by the boot script. */
function accentDecls(p: Palette): string {
  return [
    `--accent:${p.accent}`,
    `--accent-ink:${p.accentInk}`,
    `--hero:${p.hero}`,
    `--dot-accent:${p.dotAccent}`,
    `--glow:${p.glow}`,
    `--link-hover:${p.linkHover}`,
    `--c-base:${p.base}`,
    `--c-peak:${p.peak}`,
    `--c-spoke:${p.spoke}`,
    `--c-spark:${p.spark}`,
    ...p.heat.map((v, i) => `--c-heat-${i}:${v}`),
    ...p.mix.map((v, i) => `--c-mix-${i}:${v}`),
  ].join(';');
}

// ---------------------------------------------------------------------------
// Glossary — every number on the page can say what it means on hover.
//
// These definitions are the only place the report explains its own accounting
// (which tokens are counted, what the cost is an estimate OF, how a session is
// counted). Kept in one table so the page and the docs cannot drift apart, and
// so a reader never has to guess whether "tokens" includes cache reads.
// ---------------------------------------------------------------------------
const GLOSSARY = {
  totalCost:
    'Estimated from public per-token list prices. If you are on a Pro or Max plan this is what the same usage would have cost through the API, not what you were billed.',
  tokens:
    'Input + output + cache writes. Cache reads are excluded: they are context replayed from cache, not new work. Cache volume has its own card below.',
  sessions:
    'Distinct sessions counted per day and summed, so a session running past midnight counts on each day it touched.',
  messages: 'Assistant responses — one per API response, after de-duplicating resumed and forked transcripts.',
  streak: 'The longest run of consecutive days with at least one message.',
  activeDays: 'Days in the period with at least one message.',
  lede: 'Every figure in this paragraph is computed from the same events as the charts below. Nothing here is written by hand.',
  rateCard:
    'The total divided by the things that produced it, so the headline number becomes a rate you can reason about.',
  perMessage: 'Total estimated cost divided by every assistant response in the period.',
  perSession: 'Total estimated cost divided by the number of distinct sessions.',
  perActiveDay: 'Total estimated cost divided by the days with at least one message.',
  msgsPerDay: 'Assistant responses divided by the days with at least one message.',
  tokensPerDay: 'Billable tokens divided by the days with at least one message.',
  volume:
    'A rough equivalence, not a precise count: roughly 0.75 words per token against published word counts, or about 9 tokens per line for source trees. The unit is chosen from a pool of comparisons that land near your own magnitude, seeded on this period so it stays the same every time you open the report.',
  rhythm:
    'One square per day, darker for a more expensive day. The five levels are $0, under $10, under $50, under $150, and $150 or more.',
  dailyCost:
    'Cost per local calendar day, on a square-root scale so quiet days stay visible next to a day that cost fifty times as much. The peak day is named.',
  byHour:
    'Assistant messages by local hour, summed across every day in the period. Midnight is the top of the dial and the day runs clockwise.',
  byWeekday: 'Assistant messages by day of week, summed across the period.',
  byTool: 'Cost split across the coding tools whose logs were read: Claude Code, Codex, Pi, OpenCode.',
  byModel:
    'Cost per model. A model with no published price is flagged in the banner above rather than counted as zero.',
  byProject: 'Cost per project directory, from each message’s working directory.',
  weeklyTrend: 'Cost per week over the period, so a ramp or a drop is visible as a shape rather than a single total.',
  modelMix:
    'Weekly cost stacked by model, newest week last. A single total per model hides a shift between them; this shows it happening. Models beyond the top few are pooled into "other".',
  cacheDividend:
    'What the prompt cache returned over the period: those cache reads priced at full input rates, minus what they actually cost. The one figure on this page that is money you did not spend.',
  hitRate:
    'Share of prompt-side tokens served from cache rather than re-sent. Higher is better; a falling rate means context is being rebuilt instead of reused.',
  cacheRead:
    'Tokens replayed from the prompt cache, billed at roughly a tenth of the input rate. Not included in the token total.',
  cacheWrite:
    'Tokens written into the prompt cache, billed at a premium over input. These are new work, so they ARE included in the token total.',
  burn: 'Spend so far against a straight-line projection to the end of the period, and against the equally long window immediately before it.',
  distribution:
    'The shape of session spend across every session in the period, not just the ones listed. A max far above the median means a few sessions carry the bill.',
  distinctSessions:
    'Sessions counted once each. This is lower than the figure at the top of the page, which counts a session again on every day it touched — the two answer different questions.',
  costPerDispatch: 'What one invocation of this agent type costs on average — total spend divided by dispatches.',
  subagents:
    'Spend by agents dispatched with the Task tool, plus auto-compaction. Their tokens are already inside every total above; this breaks out who spent them.',
  agentTypes: 'Every agent type that was dispatched, with what a single dispatch of each one costs on average.',
  dispatch: 'One Task/Agent invocation. A dispatch can span many messages.',
  topSessions:
    'The costliest individual sessions, named by their custom title or opening prompt from the session index. Sessions the index has not seen show their id.',
  sessionSubagent:
    'Where the session ran, when it started, and how much of its cost was spent by agents it dispatched.',
  shareCard:
    'A 1200 × 630 image drawn in your browser from the same numbers as the report. It follows the theme and accent you have picked, and nothing is uploaded.',
} as const;

const tip = (text: string): string => ` data-tip="${esc(text)}"`;

/** Section heading whose title carries its own definition, with an optional
 *  right-aligned hint that does not. */
function h2(title: string, definition: string, hint?: string): string {
  const hintHtml = hint ? `<span class="hint">${esc(hint)}</span>` : '';
  return `<h2><span class="tt"${tip(definition)}>${esc(title)}</span>${hintHtml}</h2>`;
}

/** A stat cell in the hero grid: big number, small label, one definition. */
function cell(value: string, label: string, definition: string, accent = false): string {
  return `<div class="cell"${tip(definition)}><div class="n${accent ? ' on' : ''}">${value}</div><div class="l">${esc(label)}</div></div>`;
}

/** A rate tile: big number over a dotted-underlined caption. */
function rate(value: string, label: string, definition: string): string {
  return `<div class="rate"${tip(definition)}><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Fonts
//
// Space Grotesk for numerals and headings, JetBrains Mono for labels. The report
// is a single file, so the faces are linked rather than embedded: when the link
// is unreachable — offline, or an archived copy — the stack degrades to the
// system UI faces and every measurement in the layout still holds. The canvas
// share card names the same two stacks, so it degrades identically.
//
// This is the only outbound request the document makes. Everything it renders is
// computed locally; embedding subset woff2 here would remove the request
// entirely at the cost of ~80KB on every generated report.
// ---------------------------------------------------------------------------
const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;500;700&display=swap">';

const CSS = `
:root{
--bg:oklch(10.5% 0.012 265);--shell:oklch(13.5% 0.014 265);--surface:oklch(17% 0.018 265);
--line:oklch(26% 0.02 265);--line-soft:oklch(21% 0.015 265);--track:oklch(24% 0.015 265);
--ink:oklch(95% 0.005 265);--ink-2:oklch(66% 0.02 265);--ink-3:oklch(57% 0.02 265);
--dot:oklch(42% 0.02 265);
--shadow:0 24px 60px oklch(20% 0.03 265 / .28);
--tip-bg:oklch(20% 0.015 265);--tip-ink:oklch(96% 0.005 265);--tip-shadow:0 6px 18px oklch(20% 0.02 265 / .3);
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
--sans:'Space Grotesk',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
--z-dropdown:5;--z-tooltip:50;
${accentDecls(PALETTES[DEFAULT_ACCENT]!.dark)};
}
[data-theme="light"]{
--bg:oklch(95.5% 0.004 95);--shell:oklch(92.5% 0.005 95);--surface:oklch(99.5% 0.002 95);
--line:oklch(87% 0.008 95);--line-soft:oklch(92% 0.006 95);--track:oklch(90% 0.008 95);
--ink:oklch(21% 0.01 265);--ink-2:oklch(44% 0.015 265);--ink-3:oklch(52% 0.015 265);
--dot:oklch(70% 0.015 265);
--shadow:0 18px 44px oklch(50% 0.02 95 / .14);
--tip-bg:oklch(22% 0.012 265);--tip-ink:oklch(97% 0.004 265);--tip-shadow:0 6px 18px oklch(40% 0.02 265 / .22);
${accentDecls(PALETTES[DEFAULT_ACCENT]!.light)};
}
*{box-sizing:border-box}
html{background:var(--bg);}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;transition:background .18s ease-out;}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid currentColor;}
a:hover{color:var(--link-hover);}
.page{padding:clamp(16px,3vw,40px);}
.shell{width:100%;max-width:1180px;margin:0 auto;background:var(--shell);border-radius:20px;padding:clamp(20px,3vw,40px);box-shadow:var(--shadow);}

/* --- header ------------------------------------------------------------- */
.topline{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:30px;}
.brand{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:var(--accent);border-bottom:0;}
.brand:hover{color:var(--link-hover);}
.topline .right{display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
.period{font-family:var(--mono);font-size:10.5px;color:var(--ink-2);letter-spacing:.08em;text-transform:uppercase;}
.sharelink{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;border-bottom:0;color:var(--accent);}
.sharelink:hover{color:var(--link-hover);}
#themetoggle{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink-2);cursor:pointer;padding:0;transition:border-color .15s ease-out,color .15s ease-out;}
#themetoggle:hover{border-color:var(--accent);color:var(--accent);}
#themetoggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
[data-theme="dark"] .ic-moon{display:none;}
[data-theme="light"] .ic-sun{display:none;}
.dd{position:relative;display:inline-block;}
.dd summary{list-style:none;display:inline-flex;align-items:center;gap:7px;height:30px;font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:0 10px;cursor:pointer;transition:border-color .15s ease-out,color .15s ease-out;}
.dd summary::-webkit-details-marker{display:none;}
.dd summary:hover{border-color:var(--accent);color:var(--accent);}
.dd summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.dd .caret{font-size:9px;color:var(--ink-3);}
.dd .menu{position:absolute;right:0;top:calc(100% + 6px);display:flex;flex-direction:column;gap:1px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:4px;min-width:11em;z-index:var(--z-dropdown);box-shadow:var(--tip-shadow);}
.opt{display:flex;align-items:center;gap:8px;background:none;border:0;color:var(--ink);font-family:var(--mono);font-size:11px;font-weight:600;padding:6px 10px;cursor:pointer;text-align:left;border-radius:6px;}
.opt:hover{background:var(--track);}
.opt:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
.dot{width:11px;height:11px;border-radius:50%;background:var(--c);border:1px solid var(--line);flex:none;}
.dot.cur{background:var(--accent);border-color:var(--accent);}
${ACCENT_ORDER.map((n) => `[data-accent="${n}"] .opt[data-pick="${n}"]{background:var(--track);}`).join('\n')}

/* --- card surfaces ------------------------------------------------------ */
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px 28px;}
.deck{margin-top:18px;}
.grid{display:grid;gap:18px;margin-top:18px;}
.g-hero{grid-template-columns:1.35fr 1fr;align-items:stretch;margin-top:0;}
.g-clock{grid-template-columns:1fr 1.15fr;}
.g-three{grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;}
.g-half{grid-template-columns:1fr 1fr;}
.g-deep{grid-template-columns:1.55fr 1fr;align-items:start;}
h2{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin:0 0 16px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
h2 .hint{font-weight:400;letter-spacing:.06em;color:var(--ink-3);font-size:10px;text-align:right;}
.tt{border-bottom:1px dotted var(--dot-accent);cursor:help;}

/* --- hero --------------------------------------------------------------- */
.hero{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:30px 32px;}
.hero .label{font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;color:var(--ink-2);text-transform:uppercase;margin:0;}
.hero .label .tt{border-bottom-color:var(--dot);}
.big{display:flex;align-items:flex-start;gap:6px;margin-top:16px;font-weight:700;letter-spacing:-0.04em;font-variant-numeric:tabular-nums;line-height:.85;}
.big .cur{font-size:clamp(24px,3vw,38px);color:var(--accent);line-height:1.1;}
.big .whole{font-size:clamp(52px,7.4vw,96px);color:var(--hero);text-shadow:var(--glow);}
.big .frac{font-size:clamp(24px,3vw,38px);color:var(--ink-2);line-height:1.1;}
.trend{display:flex;align-items:center;gap:10px;margin-top:24px;flex-wrap:wrap;}
.pill{display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:var(--accent-ink);font-family:var(--mono);font-size:11px;font-weight:700;padding:5px 10px;border-radius:999px;}
.pill em{font-style:normal;font-weight:400;opacity:.75;}
.trend .range{font-family:var(--mono);font-size:11px;color:var(--ink-2);}
.caption{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);letter-spacing:.1em;margin-top:8px;text-transform:uppercase;}
.hero svg{margin-top:22px;}
.cells{display:grid;grid-template-rows:repeat(2,1fr);grid-template-columns:repeat(2,1fr);gap:12px;}
.cell{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;cursor:help;}
.cell .n{font-size:36px;font-weight:700;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums;}
.cell .n.on{color:var(--accent);}
.cell .sfx{font-size:20px;color:var(--accent);}
.cell .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-2);margin-top:9px;}

/* --- lede + callouts ---------------------------------------------------- */
.lede p{margin:0;font-size:19px;line-height:1.55;max-width:64ch;text-wrap:pretty;color:var(--ink);font-weight:500;}
.lede b{color:var(--accent);font-weight:700;white-space:nowrap;}
.callouts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 28px;margin-top:24px;padding-top:22px;border-top:1px solid var(--line-soft);}
.callouts div{font-family:var(--mono);font-size:11px;color:var(--ink-3);line-height:1.6;}
.callouts b{color:var(--accent);font-weight:700;}

/* --- rate tiles --------------------------------------------------------- */
.rates{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:24px;}
.rate{cursor:help;}
.rate .n{font-size:30px;font-weight:700;letter-spacing:-0.02em;line-height:1;font-variant-numeric:tabular-nums;color:var(--ink);}
.rate .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-top:9px;border-bottom:1px dotted var(--dot);display:inline-block;}

/* --- charts ------------------------------------------------------------- */
svg{display:block;}
svg rect,svg line{transition:opacity .15s ease-out;}
svg rect:hover,svg line:hover{opacity:.72;}
.heat text{font-size:9px;font-family:var(--mono);letter-spacing:.08em;fill:var(--ink-3);}
.axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px;color:var(--ink-3);margin-top:8px;letter-spacing:.06em;text-transform:uppercase;}
.axis.days span{flex:1;text-align:center;}
.clock{display:flex;align-items:center;gap:20px;flex-wrap:wrap;}
.clock svg{flex:none;}
.clock .pk{font-size:22px;font-weight:700;font-family:var(--sans);fill:var(--accent);}
.clock .pkl{font-size:9px;letter-spacing:.14em;font-family:var(--mono);fill:var(--ink-2);}
.clock .facts{font-family:var(--mono);font-size:11px;color:var(--ink-2);line-height:2;}
.clock .facts span{color:var(--ink-3);}
.legend{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:12px;}
.lg{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:9.5px;color:var(--ink-2);}
.lg .sw{width:8px;height:8px;border-radius:2px;flex:none;}
.lg b{color:var(--ink);font-weight:700;}

/* --- bar lists ---------------------------------------------------------- */
.barlist{display:flex;flex-direction:column;gap:14px;}
.barlist .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;}
.barlist .name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.barlist .val{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--accent);cursor:help;}
.barlist .track{height:6px;background:var(--track);border-radius:3px;margin-top:7px;}
.barlist .fill{display:block;height:100%;border-radius:3px;background:var(--c-peak);}

/* --- cache + subagents -------------------------------------------------- */
.dividend{background:var(--accent);color:var(--accent-ink);border-radius:16px;padding:26px 30px;}
.dividend h2{color:var(--accent-ink);}
.dividend .tt{border-bottom-color:currentColor;}
.dividend .n{font-size:60px;font-weight:700;letter-spacing:-0.035em;line-height:1;margin-top:14px;font-variant-numeric:tabular-nums;}
.dividend p{font-size:14px;font-weight:500;margin:12px 0 0;max-width:30ch;text-wrap:pretty;}
.dividend .vols{display:flex;gap:26px;margin-top:20px;font-family:var(--mono);font-size:10.5px;}
.dividend .vols span{cursor:help;}
.subshare{display:flex;align-items:baseline;gap:12px;margin-top:14px;}
.subshare .n{font-size:60px;font-weight:700;letter-spacing:-0.035em;line-height:1;font-variant-numeric:tabular-nums;}
.subshare .n em{font-style:normal;font-size:30px;}
.subshare .note{font-family:var(--mono);font-size:11px;color:var(--ink-2);max-width:11em;}
.meter{height:8px;background:var(--track);border-radius:4px;margin-top:22px;overflow:hidden;}
.meter span{display:block;height:100%;background:var(--accent);}
.ends{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--ink-3);margin-top:9px;}

/* --- tables ------------------------------------------------------------- */
table.tbl{width:100%;border-collapse:collapse;font-size:12.5px;}
table.tbl th{text-align:left;font-family:var(--mono);font-size:9.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);padding:0 10px 8px 0;border-bottom:1px solid var(--line);white-space:nowrap;}
table.tbl td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line-soft);}
table.tbl th:last-child,table.tbl td:last-child{padding-right:0;}
table.tbl td.t{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22em;}
table.tbl th.num,table.tbl td.num{text-align:right;font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--ink-2);}
table.tbl td.tot{text-align:right;font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--accent);}
table.tbl th[data-tip]{cursor:help;text-decoration:underline dotted var(--dot);text-underline-offset:3px;}
.trunc{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);margin-top:10px;letter-spacing:.08em;text-transform:uppercase;}
.dotted{border-bottom:1px dotted var(--dot);}

/* --- sessions ----------------------------------------------------------- */
.sess{display:flex;flex-direction:column;}
.sess .row{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:baseline;padding:13px 0;border-bottom:1px solid var(--line-soft);}
.sess .t{font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);}
.sess .m{font-family:var(--mono);font-size:10px;color:var(--ink-3);margin-top:5px;letter-spacing:.04em;cursor:help;}
.sess .c{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;color:var(--accent);}

/* --- share card --------------------------------------------------------- */
#cardcanvas{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--line);}
.actions{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap;}
.actions button{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:10px 16px;border-radius:9px;cursor:pointer;background:transparent;color:var(--ink-2);border:1px solid var(--line);}
.actions button:hover{color:var(--accent);border-color:var(--accent);}
.actions button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);}
.actions button.primary:hover{filter:brightness(1.06);color:var(--accent-ink);}
.actions button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
#flash{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);letter-spacing:.04em;}

/* --- warnings + footer -------------------------------------------------- */
.pricewarn{border:1px solid var(--accent);border-left-width:4px;border-radius:12px;padding:14px 18px;margin-top:18px;font-size:13px;color:var(--ink);background:var(--surface);}
.pricewarn .hd{font-family:var(--mono);font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--accent);margin-bottom:6px;}
.pricewarn .models{font-family:var(--mono);font-size:12px;word-break:break-all;color:var(--ink-2);}
.pricewarn .models .m+.m::before{content:", ";color:var(--ink-3);}
footer.rep{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:26px;font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.08em;text-transform:uppercase;}
/* The footer's own register, not the page's link register: an underlined accent
   rule across a 10px uppercase mono line reads as damage. It earns the underline
   on hover, where it has to look clickable. */
footer.rep a{color:var(--accent);border-bottom:0;}
footer.rep a:hover{color:var(--link-hover);border-bottom:1px solid currentColor;}

/* --- tooltip ------------------------------------------------------------ */
.tip{position:fixed;left:0;top:0;pointer-events:none;background:var(--tip-bg);color:var(--tip-ink);font-family:var(--sans);font-size:12px;line-height:1.45;padding:7px 10px;border-radius:6px;opacity:0;transform:translateX(-50%);max-width:34ch;text-wrap:pretty;font-variant-numeric:tabular-nums;z-index:var(--z-tooltip);box-shadow:var(--tip-shadow);}

@media (max-width:900px){
.g-hero,.g-clock,.g-half,.g-deep,.g-three{grid-template-columns:1fr;}
.shell{padding:20px;}
.hero{padding:22px 20px;}
.card,.dividend{padding:20px;}
.cell .n,.rate .n{font-size:30px;}
.dividend .n,.subshare .n{font-size:44px;}
.lede p{font-size:17px;}
}
@media (prefers-reduced-motion:reduce){svg rect,svg line,#themetoggle,body{transition:none;}}
`;

// Runs in <head> so the theme, the accent, and every accent-derived custom
// property land before first paint. The palette table is computed at render
// time (see PALETTES) rather than re-derived here, so this script only has to
// look one up and write it — there is no colour maths in the browser.
const THEME_BOOT_JS = `(function(){var d=document.documentElement;var PAL=${jsonForScript(PALETTES)};var A=${jsonForScript(ACCENT_ORDER)};
var t=null;try{t=localStorage.getItem('sessions-report-theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
d.setAttribute('data-theme',t);
var a=null;try{a=localStorage.getItem('sessions-report-accent')}catch(e){}
if(A.indexOf(a)<0){a=${JSON.stringify(DEFAULT_ACCENT)};}
d.setAttribute('data-accent',a);
window.sessionsPalette=PAL;
window.setAccentVars=function(name,theme){var p=PAL[name]&&PAL[name][theme];if(!p)return;var s=d.style;
s.setProperty('--accent',p.accent);s.setProperty('--accent-ink',p.accentInk);s.setProperty('--hero',p.hero);
s.setProperty('--dot-accent',p.dotAccent);s.setProperty('--glow',p.glow);s.setProperty('--link-hover',p.linkHover);
s.setProperty('--c-base',p.base);s.setProperty('--c-peak',p.peak);s.setProperty('--c-spoke',p.spoke);s.setProperty('--c-spark',p.spark);
for(var i=0;i<p.heat.length;i++){s.setProperty('--c-heat-'+i,p.heat[i]);}
for(var j=0;j<p.mix.length;j++){s.setProperty('--c-mix-'+j,p.mix[j]);}};
window.setAccentVars(a,t);})();`;

// Delegated tooltip, theme toggle, accent picker, and the share card. Every DOM
// write is textContent — never innerHTML.
const JS = `(function(){
var d=document.documentElement;
var t=document.getElementById('tip');
function find(e){return e.target&&e.target.closest?e.target.closest('[data-tip]'):null;}
document.addEventListener('mousemove',function(e){var el=find(e);if(!el){t.style.opacity='0';return;}
t.textContent=el.getAttribute('data-tip');t.style.opacity='1';
var r=t.getBoundingClientRect(),half=r.width/2+10;
t.style.left=Math.min(Math.max(e.clientX,half),window.innerWidth-half)+'px';
var above=e.clientY-r.height-16;t.style.top=(above<8?e.clientY+20:above)+'px';});

function theme(){return d.getAttribute('data-theme')==='light'?'light':'dark';}
function accent(){return d.getAttribute('data-accent')||${JSON.stringify(DEFAULT_ACCENT)};}
function repaint(){window.setAccentVars(accent(),theme());drawCard();}

document.getElementById('themetoggle').addEventListener('click',function(){
var next=theme()==='dark'?'light':'dark';d.setAttribute('data-theme',next);
try{localStorage.setItem('sessions-report-theme',next)}catch(e){}repaint();});

var dd=document.getElementById('accentdd'),nm=document.getElementById('accentname');
if(dd){nm.textContent=accent();
dd.querySelectorAll('.opt').forEach(function(el){el.addEventListener('click',function(){
var p=el.getAttribute('data-pick');d.setAttribute('data-accent',p);nm.textContent=p;
try{localStorage.setItem('sessions-report-accent',p)}catch(e){}
dd.removeAttribute('open');repaint();});});
document.addEventListener('click',function(e){if(dd.hasAttribute('open')&&!dd.contains(e.target))dd.removeAttribute('open');});
document.addEventListener('keydown',function(e){if(e.key==='Escape')dd.removeAttribute('open');});}

var CARD=null;try{CARD=JSON.parse(document.getElementById('card-data').textContent);}catch(e){}
var cv=document.getElementById('cardcanvas');
// Which comparison is showing. Seeded server-side so the card is identical on
// every repaint; the reroll button is the only thing that moves it.
var eqIdx=CARD&&CARD.eqStart||0;
function drawCard(){
if(!cv||!CARD)return;
var S=2,W=1200,H=630;cv.width=W*S;cv.height=H*S;
var c=cv.getContext('2d');if(!c)return;
c.setTransform(S,0,0,S,0,0);
var p=window.sessionsPalette[accent()][theme()];
function mono(w){return w+'px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace';}
function disp(wt,sz){return wt+' '+sz+'px "Space Grotesk",ui-sans-serif,system-ui,sans-serif';}
function ls(v){try{c.letterSpacing=v;}catch(e){}}
function right(s,y){c.fillText(s,W-64-c.measureText(s).width,y);}
c.fillStyle=p.cardBg;c.fillRect(0,0,W,H);
var X=64;
ls('4px');c.font='700 '+mono(19);c.fillStyle=p.accent;c.fillText(CARD.brand,X,84);
c.font=mono(17);c.fillStyle=p.cardInk2;right(CARD.period,84);
ls('3px');c.font=mono(16);c.fillStyle=p.cardInk2;c.fillText(CARD.label,X,158);
ls('0px');
c.font=disp(700,46);c.fillStyle=p.accent;c.fillText(CARD.cur,X,262);
var dx=X+c.measureText(CARD.cur).width+8;
c.font=disp(700,132);c.fillStyle=p.hero;c.fillText(CARD.whole,dx,262);
var fx=dx+c.measureText(CARD.whole).width+4;
c.font=disp(700,46);c.fillStyle=p.cardInk2;c.fillText(CARD.frac,fx,262);
c.font=mono(19);c.fillStyle=p.cardInk2;c.fillText(CARD.rate,X,306);
c.font=disp(500,31);c.fillStyle=p.cardInk;c.fillText(CARD.verdict,X,386);
// The comparison line is user-swappable and its length is unbounded, so it
// shrinks to the column instead of running off the card.
var eq=CARD.equivalents[eqIdx];
if(eq){var sz=29,maxW=W-2*X;c.font=disp(500,sz);
while(sz>17&&c.measureText(eq).width>maxW){sz-=1;c.font=disp(500,sz);}
c.fillStyle=p.cardInk2;c.fillText(eq,X,424);}
for(var i=0;i<CARD.stats.length;i++){var sx=X+i*272;
c.font=disp(700,38);c.fillStyle=CARD.stats[i][2]?p.accent:p.cardInk;c.fillText(CARD.stats[i][0],sx,492);
ls('2.5px');c.font=mono(13);c.fillStyle=p.cardInk2;c.fillText(CARD.stats[i][1],sx,518);ls('0px');}
var CS=9,CG=2.4;
for(var col=0;col<CARD.heat.length;col++){for(var r=0;r<7;r++){
var L=CARD.heat[col][r];if(L<0)continue;
c.fillStyle=p.heat[L];
var hx=X+col*(CS+CG),hy=545+r*(CS+CG);
if(c.roundRect){c.beginPath();c.roundRect(hx,hy,CS,CS,2);c.fill();}else{c.fillRect(hx,hy,CS,CS);}}}
ls('2px');c.font=mono(14);c.fillStyle=p.cardInk2;
for(var k=0;k<CARD.footer.length;k++){right(CARD.footer[k],571+k*24);}
ls('0px');}

var flashEl=document.getElementById('flash'),flashTimer=null;
function flash(msg){if(!flashEl)return;flashEl.textContent=msg;clearTimeout(flashTimer);
flashTimer=setTimeout(function(){flashEl.textContent='';},2400);}
var BLOCKED='Clipboard blocked here \\u2014 use Download PNG.';
// The copied text carries whichever comparison is on screen, spliced in ahead
// of the sign-off sentence so the two never disagree.
function summaryNow(){var parts=CARD.summary.slice();
if(CARD.equivalents.length)parts.splice(CARD.eqSlot,0,CARD.equivalents[eqIdx]);
return parts.join(' ');}
var dl=document.getElementById('card-png'),cp=document.getElementById('card-img'),tx=document.getElementById('card-txt'),eqb=document.getElementById('card-eq');
if(eqb)eqb.addEventListener('click',function(){
eqIdx=(eqIdx+1)%CARD.equivalents.length;drawCard();flash('Swapped the comparison.');});
if(dl)dl.addEventListener('click',function(){var a=document.createElement('a');a.download=CARD.filename;
a.href=cv.toDataURL('image/png');a.click();flash('PNG saved to your downloads.');});
if(cp)cp.addEventListener('click',function(){
if(!navigator.clipboard||!window.ClipboardItem){flash(BLOCKED);return;}
cv.toBlob(function(b){navigator.clipboard.write([new ClipboardItem({'image/png':b})])
.then(function(){flash('Card copied \\u2014 paste it anywhere.');}).catch(function(){flash(BLOCKED);});},'image/png');});
if(tx)tx.addEventListener('click',function(){
if(!navigator.clipboard){flash(BLOCKED);return;}
navigator.clipboard.writeText(summaryNow()).then(function(){flash('Summary copied as text.');}).catch(function(){flash(BLOCKED);});});

drawCard();
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(drawCard);
console.log('sessions report \\u2014 generated locally from your own session logs. No telemetry.');})();`;

// A loud, URL-free banner naming every model that had no price of its own. The
// two cases read differently on purpose: a same-family estimate still produces a
// number, an unpriced model leaves a hole in the total.
function warningBanner(warnings: PricingWarning[]): string {
  if (warnings.length === 0) return '';
  const estimated = warnings.filter((w) => w.pricedAs);
  const zeroed = warnings.filter((w) => !w.pricedAs);
  const block = (head: string, list: PricingWarning[], fmtName: (w: PricingWarning) => string): string =>
    list.length === 0
      ? ''
      : `<div class="pricewarn" role="alert"><div class="hd">${esc(head)}</div><div class="models">${list
          .map((w) => `<span class="m">${esc(fmtName(w))}</span>`)
          .join('')}</div></div>`;
  return (
    block(
      `${zeroed.length} model${zeroed.length === 1 ? '' : 's'} had no pricing — cost is understated`,
      zeroed,
      (w) => w.model,
    ) +
    block(
      `${estimated.length} model${estimated.length === 1 ? '' : 's'} priced at a same-family estimate`,
      estimated,
      (w) => `${w.model} → ${w.pricedAs}`,
    )
  );
}

// ---------------------------------------------------------------------------
// Chart primitives
//
// Every fill is a custom property, never a literal. The accent and the theme are
// both chosen in the browser, and a static document can only follow them if its
// colours are indirections the boot script rewrites.
// ---------------------------------------------------------------------------

interface Bar {
  value: number;
  tip: string;
}

/** Vertical bars: the peak in `--c-peak`, the rest in `--c-base`. `sqrt` keeps a
 *  quiet day visible next to a day that cost fifty times as much. */
function vBars(bars: Bar[], w: number, h: number, opts: { rx?: number; sqrt?: boolean; gap?: number } = {}): string {
  if (bars.length === 0) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"></svg>`;
  const { rx, sqrt = false, gap = 1.3 } = opts;
  const max = Math.max(...bars.map((b) => b.value));
  const step = w / bars.length;
  const bw = f(Math.max(1.5, step - gap));
  const norm = (v: number): number => (max <= 0 ? 0 : sqrt ? Math.sqrt(v / max) : v / max);
  const rxAttr = rx ? ` rx="${rx}"` : '';
  const rects = bars
    .map((b, i) => {
      const bh = Math.max(1.5, norm(b.value) * h);
      const fill = max > 0 && b.value === max ? 'var(--c-peak)' : 'var(--c-base)';
      return `<rect x="${f(i * step)}" y="${f(h - bh)}" width="${bw}" height="${f(bh)}" fill="${fill}"${rxAttr} data-tip="${esc(b.tip)}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${rects}</svg>`;
}

/** Name and cost on one line above a rounded track. Widths are relative to the
 *  largest row, not to the total: this is a ranking, not a pie. */
function barList(rows: { name: string; value: number; tip: string }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="barlist">${rows
    .map((r) => {
      const pct = f(Math.max(1.5, (r.value / max) * 100));
      return `<div><div class="top"><span class="name">${esc(r.name)}</span><span class="val"${tip(r.tip)}>${fmtUSD(r.value)}</span></div><div class="track"><span class="fill" style="width:${pct}%"></span></div></div>`;
    })
    .join('')}</div>`;
}

/** Stacked weekly bars. Bands are a lightness ramp of the accent's single hue
 *  (`--c-mix-0..5`), drawn baseline-up in the same key order every week so a
 *  band stays in the same place and the eye can follow it across the series. */
function stackedBars(
  weeks: { label: string; parts: { key: string; value: number }[] }[],
  keys: string[],
  w: number,
  h: number,
): string {
  const max = Math.max(1, ...weeks.map((wk) => sum(wk.parts.map((p) => p.value))));
  const step = w / Math.max(1, weeks.length);
  const bw = f(Math.max(1, step - 2));
  const cols = weeks
    .map((week, i) => {
      const x = f(i * step);
      let y = h;
      let out = '';
      for (const key of keys) {
        const value = week.parts.find((p) => p.key === key)?.value ?? 0;
        if (value <= 0) continue;
        const bh = (value / max) * h;
        y -= bh;
        const band = Math.min(keys.indexOf(key), 5);
        out += `<rect x="${x}" y="${f(y)}" width="${bw}" height="${f(Math.max(0.6, bh))}" fill="var(--c-mix-${band})" data-tip="${esc(`${week.label} · ${key}: ${fmtUSD(value)}`)}"/>`;
      }
      return out;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${cols}</svg>`;
}

function legend(keys: string[], totals: Map<string, number>): string {
  return `<div class="legend">${keys
    .map(
      (k, i) =>
        `<span class="lg"><span class="sw" style="background:var(--c-mix-${Math.min(i, 5)})"></span>${esc(k)} <b>${fmtUSD0(totals.get(k) ?? 0)}</b></span>`,
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Activity heatmap
//
// One square per day, seven rows per column, Sunday at the top — the shape of a
// year of work, and the only chart on the page that shows the days when nothing
// happened. `daily` carries only days with activity, so the calendar is walked
// across the whole period and a missing day reads as level 0 rather than as a
// gap in the grid.
// ---------------------------------------------------------------------------
const HEAT_CELL = 13;
const HEAT_GAP = 3;
/** $0 / <$10 / <$50 / <$150 / ≥$150. Fixed thresholds rather than quantiles: the
 *  reader is comparing days against dollars, not against each other. */
const heatLevel = (costUSD: number): number =>
  costUSD === 0 ? 0 : costUSD < 10 ? 1 : costUSD < 50 ? 2 : costUSD < 150 ? 3 : 4;

interface HeatColumn {
  /** Seven entries, Sunday first. -1 marks a day outside the period. */
  levels: number[];
  costs: number[];
  dates: string[];
  monthLabel: string | null;
}

function heatColumns(daily: DailyEntry[], from: string, to: string): HeatColumn[] {
  const byDate = new Map(daily.map((d) => [d.date, d.costUSD]));
  const start = parseYmd(from);
  const end = parseYmd(to);
  // Back up to the Sunday on or before the first day so every column is a full
  // calendar week and each row is the weekday it claims to be.
  const cur = new Date(start);
  cur.setUTCDate(cur.getUTCDate() - cur.getUTCDay());
  const out: HeatColumn[] = [];
  let lastMonth = -1;
  while (cur <= end) {
    const levels: number[] = [];
    const costs: number[] = [];
    const dates: string[] = [];
    for (let r = 0; r < 7; r++) {
      const day = new Date(cur);
      day.setUTCDate(day.getUTCDate() + r);
      if (day < start || day > end) {
        levels.push(-1);
        costs.push(0);
        dates.push('');
        continue;
      }
      const key = toYmd(day);
      const cost = byDate.get(key) ?? 0;
      levels.push(heatLevel(cost));
      costs.push(cost);
      dates.push(key);
    }
    let monthLabel: string | null = null;
    if (cur.getUTCMonth() !== lastMonth && cur.getUTCDate() <= 7) {
      lastMonth = cur.getUTCMonth();
      monthLabel = MONTHS[lastMonth]!;
    }
    out.push({ levels, costs, dates, monthLabel });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

function heatmap(cols: HeatColumn[]): string {
  const pitch = HEAT_CELL + HEAT_GAP;
  const w = cols.length * pitch - HEAT_GAP;
  const h = 18 + 7 * pitch - HEAT_GAP;
  const months = cols
    .map((c, i) => (c.monthLabel ? `<text x="${f(i * pitch)}" y="8">${esc(c.monthLabel)}</text>` : ''))
    .join('');
  const cells = cols
    .map((c, i) =>
      c.levels
        .map((level, r) => {
          if (level < 0) return '';
          const label = `${c.dates[r]} · ${c.costs[r]! > 0 ? fmtUSD(c.costs[r]!) : 'no activity'}`;
          return `<rect x="${f(i * pitch)}" y="${f(r * pitch)}" width="${HEAT_CELL}" height="${HEAT_CELL}" rx="3" fill="var(--c-heat-${level})" data-tip="${esc(label)}"/>`;
        })
        .join(''),
    )
    .join('');
  // The one chart drawn at a fixed cell size rather than stretched to the card:
  // a square per day only reads as a calendar if the squares stay square and
  // stay the same size whatever the period length. `xMinYMid meet` holds them at
  // 13px and starts the strip at the left edge — a short period ends early
  // instead of floating in the middle — and scales the whole grid down together
  // once the card is narrower than the year.
  return `<svg class="heat" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMinYMid meet">${months}<g transform="translate(0,18)">${cells}</g></svg>`;
}

// ---------------------------------------------------------------------------
// Radial clock — 24 spokes, midnight at the top, length by message count. A bar
// chart of hours answers "which hour"; the dial answers "which part of the day",
// which is the question people actually ask of their own logs.
// ---------------------------------------------------------------------------
function clockDial(hourCounts: number[], peakHour: number): string {
  const max = Math.max(1, ...hourCounts);
  const spokes = hourCounts
    .map((v, i) => {
      const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
      const r0 = 44;
      const r1 = 44 + (v / max) * 54;
      const stroke = i === peakHour ? 'var(--c-peak)' : 'var(--c-spoke)';
      return `<line x1="${f(100 + Math.cos(a) * r0)}" y1="${f(100 + Math.sin(a) * r0)}" x2="${f(100 + Math.cos(a) * r1)}" y2="${f(100 + Math.sin(a) * r1)}" stroke="${stroke}" stroke-width="7" stroke-linecap="round" data-tip="${esc(`${hourLabel(i)} · ${fmtInt(v)} messages`)}"/>`;
    })
    .join('');
  const [hh, meridiem] = hourLabel(peakHour).split(' ');
  return `<svg viewBox="0 0 200 200" width="200" height="200"><circle cx="100" cy="100" r="38" fill="none" stroke="var(--line)" stroke-width="1"/>${spokes}<text class="pk" x="100" y="96" text-anchor="middle">${esc(hh!)}</text><text class="pkl" x="100" y="112" text-anchor="middle">${esc(meridiem!)} PEAK</text></svg>`;
}

// ---------------------------------------------------------------------------
// Derived figures
//
// Everything the lede, the rate card, and the share card say, computed once so
// the paragraph and the image can never disagree with each other.
// ---------------------------------------------------------------------------
interface Derived {
  total: number;
  distinctSessions: number;
  activeDays: number;
  /** The first day that actually cost something, through to the end of the
   *  period. Transcripts begin when the tools' retention begins, so an all-time
   *  report would otherwise claim months of records it has no data for. */
  recordFrom: string;
  recordDays: number;
  perMonth: number;
  last4: number;
  prev4: number;
  /** Last four weeks over the four before them. Null when there is no prior
   *  window to compare against. */
  trendX: number | null;
  shareLast4: number;
}

function derive(data: UsageReport): Derived {
  const total = data.summary.totalCostUSD;
  const paid = data.daily.find((d) => d.costUSD > 0);
  const recordFrom = paid?.date ?? data.period.from;
  const recordDays = spanDays(recordFrom, data.period.to);
  const weekly = data.insights.weekly;
  const last4 = sum(weekly.slice(-4).map((w) => w.costUSD));
  const prev4 = sum(weekly.slice(-8, -4).map((w) => w.costUSD));
  return {
    total,
    distinctSessions: data.sessionDistribution.count,
    activeDays: data.summary.activeDays,
    recordFrom,
    recordDays,
    perMonth: safeDiv(total, recordDays / 30.44),
    last4,
    prev4,
    trendX: prev4 > 0 ? last4 / prev4 : null,
    shareLast4: safeDiv(last4, total),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function heroSection(data: UsageReport, dv: Derived): string {
  const s = data.summary;
  const money = fmtUSD(dv.total);
  const dot = money.lastIndexOf('.');

  // Twelve weeks is the window where a ramp is still legible as a shape; the
  // full series gets its own card further down.
  const spark = data.insights.weekly.slice(-12);
  const sparkSvg =
    spark.length > 1
      ? vBars(
          spark.map((w) => ({
            value: w.costUSD,
            tip: `week ending ${w.weekEnding} · ${fmtUSD(w.costUSD)} · ${fmtInt(w.messages)} msgs`,
          })),
          300,
          56,
          { rx: 1.5, gap: 5 },
        ) + `<div class="caption">last ${spark.length} weeks</div>`
      : '';

  // The arrow follows the multiple as displayed, not as computed: a 0.997 that
  // prints "1.0×" next to a ▼ reads as a contradiction.
  const shown = dv.trendX === null ? '' : dv.trendX.toFixed(1);
  const arrow = Number(shown) > 1 ? '▲' : Number(shown) < 1 ? '▼' : '·';
  const trend =
    dv.trendX === null
      ? ''
      : `<div class="trend"><span class="pill">${arrow} ${esc(shown)}× <em>last 4 wks vs prior</em></span><span class="range">${esc(fmtUSD0(dv.prev4))} → ${esc(fmtUSD0(dv.last4))}</span></div>`;

  return `<div class="grid g-hero">
<div class="hero">
<p class="label"><span class="tt"${tip(GLOSSARY.totalCost)}>Total cost at API list prices</span></p>
<div class="big"><span class="cur">$</span><span class="whole">${esc(money.slice(1, dot))}</span><span class="frac">${esc(money.slice(dot))}</span></div>
${trend}
${sparkSvg}
</div>
<div class="cells">
${cell(magnitude(s.totalTokens), 'tokens', GLOSSARY.tokens)}
${cell(fmtInt(s.sessions), 'sessions', GLOSSARY.sessions)}
${cell(magnitude(s.messages), 'messages', GLOSSARY.messages)}
${cell(fmtInt(s.longestStreakDays), 'day streak', `${GLOSSARY.streak} ${fmtInt(dv.activeDays)} of the period’s days were active.`, true)}
</div>
</div>`;
}

/** One computed paragraph and up to four one-line callouts. Nothing here is
 *  written by hand: every clause is a field, and a clause whose field is missing
 *  is dropped rather than filled with a zero. */
function ledeSection(data: UsageReport, dv: Derived): string {
  const b = (v: string): string => `<b>${esc(v)}</b>`;
  const clauses: string[] = [
    `${b(fmtInt(dv.recordDays))} days of records, ${b(fmtInt(dv.activeDays))} of them active, ${b(fmtUSD0(dv.total))} of estimated API cost — about ${b(fmtUSD0(dv.perMonth))} a month at list prices.`,
  ];
  if (dv.trendX !== null) {
    clauses.push(
      `The last four weeks ran ${b(dv.trendX.toFixed(1) + '×')} the four before them — ${b(fmtPct(dv.shareLast4))} of everything spent in the period.`,
    );
  }
  const topProject = data.byProject[0];
  if (topProject && dv.total > 0) {
    const subClause =
      data.subagents.dispatches > 0
        ? `, and ${b(fmtPct(data.subagents.shareOfCost))} of it was spent by subagents you never spoke to directly`
        : '';
    clauses.push(`One project took ${b(fmtPct(safeDiv(topProject.costUSD, dv.total)))} of the bill${subClause}.`);
  }

  const callouts: string[] = [];
  const wd = data.insights.weekdayCounts;
  const wdMax = Math.max(...wd);
  const wdMin = Math.min(...wd);
  if (wdMin > 0 && wdMax > wdMin) {
    callouts.push(
      `${b((wdMax / wdMin).toFixed(1) + '×')} more messages on ${esc(WEEKDAYS_LONG[wd.indexOf(wdMax)]!)}s than ${esc(WEEKDAYS_LONG[wd.indexOf(wdMin)]!)}s`,
    );
  }
  const topSession = data.topSessions[0];
  if (topSession && dv.total > 0) {
    callouts.push(
      `one session — ${b(fmtUSD(topSession.costUSD))} — was ${esc(fmtPct(safeDiv(topSession.costUSD, dv.total)))} of the period`,
    );
  }
  if (data.cache.savedUSD > 0 && dv.total > 0) {
    callouts.push(
      `the prompt cache saved ${b(safeDiv(data.cache.savedUSD, dv.total).toFixed(1) + '×')} the bill itself`,
    );
  }
  const dist = data.sessionDistribution;
  if (dist.count > 1) {
    callouts.push(`median session ${b(fmtUSD(dist.medianUSD))}, p90 ${esc(fmtUSD(dist.p90USD))} — a few carry it`);
  }

  return `<div class="card deck lede">
${h2('The short version', GLOSSARY.lede)}
<p>${clauses.join(' ')}</p>
${callouts.length > 0 ? `<div class="callouts">${callouts.map((c) => `<div>${c}</div>`).join('')}</div>` : ''}
</div>`;
}

/** The volume tile picks its own unit — see `src/equivalence.ts`. Seeded on the
 *  period so a given report always shows the same one, and on a slot name so it
 *  never duplicates the share card's pick. A total too small for any unit drops
 *  the tile rather than printing "0 copies" of something. */
function volumeTile(data: UsageReport, seed: string): string {
  const eq = pickEquivalence(data.summary.totalTokens, seed);
  return eq ? rate(eq.value, eq.label, `${eq.phrase}. ${GLOSSARY.volume}`) : '';
}

function rateCardSection(data: UsageReport, dv: Derived): string {
  const s = data.summary;
  return `<div class="card deck">
${h2('The rate card', GLOSSARY.rateCard, 'what a day of this costs')}
<div class="rates">
${rate('$' + safeDiv(dv.total, s.messages).toFixed(3), 'per message', GLOSSARY.perMessage)}
${rate(fmtUSD(safeDiv(dv.total, dv.distinctSessions)), 'per session', `${GLOSSARY.perSession} ${fmtInt(dv.distinctSessions)} in this period.`)}
${rate(fmtUSD(safeDiv(dv.total, dv.activeDays)), 'per active day', `${GLOSSARY.perActiveDay} ${fmtInt(dv.activeDays)} of them.`)}
${rate(fmtInt(Math.round(safeDiv(s.messages, dv.activeDays))), 'msgs / active day', `${GLOSSARY.msgsPerDay} ${fmtInt(s.messages)} across ${fmtInt(dv.activeDays)} days.`)}
${rate(fmtTokens(Math.round(safeDiv(s.totalTokens, dv.activeDays))), 'tokens / active day', `${GLOSSARY.tokensPerDay} ${fmtTokens(s.totalTokens)} across ${fmtInt(dv.activeDays)} days.`)}
${volumeTile(data, `${data.period.from}|${data.period.to}|ratecard`)}
</div>
</div>`;
}

/** Pace against the period, kept from the previous report and restated as rate
 *  tiles. Absent for an all-time report, which has no period to pace against. */
function burnSection(burn: BurnStats | null): string {
  if (!burn) return '';
  const change =
    burn.changePct === null ? '—' : `${burn.changePct >= 0 ? '+' : ''}${(burn.changePct * 100).toFixed(0)}%`;
  const projection = burn.inProgress
    ? rate(fmtUSD0(burn.projectedUSD), `projected · day ${burn.elapsedDays}/${burn.periodDays}`, GLOSSARY.burn)
    : rate(fmtInt(burn.periodDays), 'days in period', GLOSSARY.burn);
  return `<div class="card deck">
${h2('Pace', GLOSSARY.burn, burn.inProgress ? `day ${burn.elapsedDays} of ${burn.periodDays}` : 'period closed')}
<div class="rates">
${rate(fmtUSD(burn.dailyMeanUSD), 'per elapsed day', GLOSSARY.burn)}
${projection}
${rate(burn.priorPeriodUSD === null ? '—' : fmtUSD0(burn.priorPeriodUSD), 'prior period', GLOSSARY.burn)}
${rate(change, `change vs prior ${burn.periodDays}d`, GLOSSARY.burn)}
</div>
</div>`;
}

function rhythmSection(cols: HeatColumn[], activeDays: number): string {
  return `<div class="card deck">
${h2('Rhythm', GLOSSARY.rhythm, `spend per day · ${fmtInt(activeDays)} active days`)}
${heatmap(cols)}
</div>`;
}

function dailySection(data: UsageReport): string {
  if (data.daily.length === 0) return '';
  const bars = data.daily.map((d) => ({ value: d.costUSD, tip: `${d.date} · ${fmtUSD(d.costUSD)}` }));
  const peak = data.daily.reduce((a, d) => (d.costUSD > a.costUSD ? d : a), data.daily[0]!);
  const first = data.daily[0]!.date;
  const last = data.daily[data.daily.length - 1]!.date;
  return `<div class="card deck">
${h2('Daily cost', GLOSSARY.dailyCost, `peak day · ${shortDate(peak.date)} · ${fmtUSD(peak.costUSD)}`)}
${vBars(bars, 920, 148, { sqrt: true })}
<div class="axis"><span>${esc(formatDate(first))}</span><span>${esc(formatDate(last))}</span></div>
</div>`;
}

function clockSection(data: UsageReport): string {
  const hours = data.insights.hourCounts;
  const total = sum(hours);
  const peakHour = hours.indexOf(Math.max(...hours));
  const wd = data.insights.weekdayCounts;
  const wdPeak = wd.indexOf(Math.max(...wd));
  const wdBars = wd.map((v, i) => ({ value: v, tip: `${WEEKDAYS[i]!} · ${fmtInt(v)} messages` }));
  return `<div class="grid g-clock">
<div class="card">
${h2('Clock', GLOSSARY.byHour, 'messages by hour')}
<div class="clock">
${clockDial(hours, peakHour)}
<div class="facts">
<div>12A <span>— top of dial</span></div>
<div>${esc(fmtInt(hours[peakHour] ?? 0))} <span>msgs at ${esc(hourLabel(peakHour))}</span></div>
<div>${esc(fmtInt(hours[0] ?? 0))} <span>after midnight</span></div>
<div>${esc(Math.round(safeDiv(sum(hours.slice(8)), total) * 100) + '%')} <span>between 8A–11P</span></div>
</div>
</div>
</div>
<div class="card">
${h2('Weekday', GLOSSARY.byWeekday, `${WEEKDAYS_LONG[wdPeak]!} is the heaviest`)}
${vBars(wdBars, 320, 150, { rx: 2, gap: 4 })}
<div class="axis days">${WEEKDAYS.map((d) => `<span>${d[0]}</span>`).join('')}</div>
</div>
</div>`;
}

function breakdownSection(data: UsageReport): string {
  const byTool = barList(
    data.byTool.map((t: ToolBreakdown) => ({
      name: t.label,
      value: t.costUSD,
      tip: `${fmtTokens(t.tokens)} tokens · ${fmtInt(t.sessions)} sessions`,
    })),
  );
  const byModel = barList(
    data.byModel.slice(0, 6).map((m: ModelBreakdown) => ({
      name: m.label,
      value: m.costUSD,
      tip: `${fmtTokens(m.tokens)} tokens · ${fmtInt(m.messages)} msgs`,
    })),
  );
  const byProject = barList(
    data.byProject.slice(0, 8).map((p: ProjectBreakdown) => ({
      name: p.label,
      value: p.costUSD,
      tip: `${fmtTokens(p.tokens)} tokens · ${fmtInt(p.sessions)} sessions`,
    })),
  );
  return `<div class="grid g-three">
<div class="card">${h2('By tool', GLOSSARY.byTool)}${byTool}</div>
<div class="card">${h2('By model', GLOSSARY.byModel)}${byModel}</div>
<div class="card">${h2('By project', GLOSSARY.byProject)}${byProject}</div>
</div>`;
}

// Cap the number of drawn series and pool the rest, so a corpus with thirty model
// ids does not become thirty indistinguishable bands.
const MODEL_SERIES = 5;
const OTHER = 'other';

function modelMixCard(weeks: ModelWeek[], order: string[]): string {
  if (weeks.length < 2 || order.length === 0) return '';
  const top = order.slice(0, MODEL_SERIES);
  const keys = order.length > top.length ? [...top, OTHER] : top;
  const totals = new Map<string, number>();
  const series = weeks.map((wk) => {
    const parts: { key: string; value: number }[] = [];
    let other = 0;
    for (const [model, cost] of Object.entries(wk.byModel)) {
      if (top.includes(model)) parts.push({ key: model, value: cost });
      else other += cost;
    }
    if (other > 0) parts.push({ key: OTHER, value: other });
    for (const p of parts) totals.set(p.key, (totals.get(p.key) ?? 0) + p.value);
    return { label: wk.weekEnding, parts };
  });
  return `<div class="card">
${h2('Model mix', GLOSSARY.modelMix, 'stacked')}
${stackedBars(series, keys, 440, 132)}
${legend(keys, totals)}
</div>`;
}

function weeklyMixSection(data: UsageReport): string {
  const weeks = data.insights.weekly;
  // One bar is not a trend; a single-week period says nothing these charts add.
  if (weeks.length < 2) return '';
  const peak = weeks.reduce((a, w) => (w.costUSD > a.costUSD ? w : a), weeks[0]!);
  const weeklyCard = `<div class="card">
${h2('Weekly trend', GLOSSARY.weeklyTrend, `peak week · ${shortDate(peak.weekEnding)} · ${fmtUSD0(peak.costUSD)}`)}
${vBars(
  weeks.map((w) => ({
    value: w.costUSD,
    tip: `week ending ${w.weekEnding} · ${fmtUSD(w.costUSD)} · ${fmtInt(w.messages)} msgs`,
  })),
  440,
  132,
  { rx: 1.5, gap: 1.6 },
)}
<div class="axis"><span>${esc(formatDate(weeks[0]!.weekEnding))}</span><span>${esc(formatDate(weeks[weeks.length - 1]!.weekEnding))}</span></div>
</div>`;
  const mixCard = modelMixCard(data.modelWeekly, data.modelOrder);
  return `<div class="grid${mixCard ? ' g-half' : ''}">${weeklyCard}${mixCard}</div>`;
}

// Cache volume sits outside the headline token count (which excludes replayed
// context by design), so it gets its own card rather than being folded in. The
// dividend is the one number on the page that is money you did NOT spend, so it
// is the one card drawn in the accent rather than on it.
function cacheSection(c: CacheStats, sub: SubagentReport, total: number): string {
  const multiple = safeDiv(c.savedUSD, total);
  const dividend = `<div class="dividend">
${h2('Cache dividend', GLOSSARY.cacheDividend)}
<div class="n">${esc(fmtUSD0(c.savedUSD))}</div>
<p>saved against uncached input rates${multiple >= 0.1 ? ` — ${esc(multiple.toFixed(1))}× the bill itself` : ''}, at a <b${tip(GLOSSARY.hitRate)}>${esc(fmtPct(c.hitRate))}</b> cache hit rate.</p>
<div class="vols"><span${tip(GLOSSARY.cacheRead)}>${esc(fmtTokens(c.cacheReadTokens))} read</span><span${tip(GLOSSARY.cacheWrite)}>${esc(fmtTokens(c.cacheWriteTokens))} written</span></div>
</div>`;

  if (sub.dispatches === 0) return `<div class="grid">${dividend}</div>`;

  const pct = sub.shareOfCost * 100;
  return `<div class="grid g-half">${dividend}<div class="card">
${h2('Subagent share', GLOSSARY.subagents)}
<div class="subshare"><span class="n">${esc(pct.toFixed(1))}<em>%</em></span><span class="note">of spend across ${esc(fmtInt(sub.dispatches))} dispatches</span></div>
<div class="meter"><span style="width:${f(Math.min(100, pct))}%"></span></div>
<div class="ends"><span>you + the main loop</span><span>agents you never met</span></div>
</div></div>`;
}

const TABLE_ROWS = 10;

function subagentTables(sub: SubagentReport): string {
  if (sub.dispatches === 0) return '';
  const typeRows = sub.byType
    .slice(0, TABLE_ROWS)
    .map(
      (t) =>
        `<tr><td class="t">${esc(t.agentType)}</td><td class="num">${fmtInt(t.dispatches)}</td><td class="num">${fmtUSD(t.costPerDispatchUSD)}</td><td class="tot">${fmtUSD(t.costUSD)}</td></tr>`,
    )
    .join('');
  // Say what the tables leave out — a silent top-N reads as "this is all of them".
  const typeTrunc =
    sub.byType.length > TABLE_ROWS
      ? `<div class="trunc">${TABLE_ROWS} of ${fmtInt(sub.byType.length)} agent types</div>`
      : '';
  const rows = sub.topDispatches
    .slice(0, TABLE_ROWS)
    .map(
      (d) =>
        `<tr><td class="t"${tip(`${d.project} · ${d.date} · ${fmtTokens(d.tokens)} tokens · ${fmtInt(d.messages)} messages`)}><span class="dotted">${esc(d.agentType)}</span></td><td class="tot">${fmtUSD(d.costUSD)}</td></tr>`,
    )
    .join('');
  const trunc =
    sub.totalDispatches > TABLE_ROWS
      ? `<div class="trunc">top ${TABLE_ROWS} of ${fmtInt(sub.totalDispatches)} · more in the JSON report</div>`
      : '';
  return `<div class="grid g-deep">
<div class="card">${h2('Agent types', GLOSSARY.agentTypes)}
<table class="tbl"><thead><tr><th${tip(GLOSSARY.dispatch)}>Type</th><th class="num">Runs</th><th class="num"${tip(GLOSSARY.costPerDispatch)}>Each</th><th class="num">Total</th></tr></thead><tbody>${typeRows}</tbody></table>${typeTrunc}</div>
<div class="card">${h2('Costliest dispatches', GLOSSARY.dispatch)}
<table class="tbl"><tbody>${rows}</tbody></table>${trunc}</div>
</div>`;
}

// The one view a dollar total cannot give you: which pieces of work cost the
// most. Intent comes from the search index; without it the row still carries
// project, branch, and date, which is usually enough to recognise the session.
function sessionSection(sessions: SessionCost[], total: number, dist: SessionDistribution): string {
  if (sessions.length === 0) return '';
  const rows = sessions
    .slice(0, TABLE_ROWS)
    .map((s) => {
      const where = s.branch ? `${s.project} · ${s.branch}` : s.project;
      const sub = s.subagentCostUSD > 0 ? ` · ${fmtUSD(s.subagentCostUSD)} to subagents` : '';
      return `<div class="row"><div><div class="t">${esc(s.intent ?? s.sessionId.slice(0, 8))}</div><div class="m"${tip(GLOSSARY.sessionSubagent)}>${esc(where + ' · ' + s.date + sub)}</div></div><div class="c">${fmtUSD(s.costUSD)}</div></div>`;
    })
    .join('');
  const hint =
    dist.count > 0
      ? `median ${fmtUSD(dist.medianUSD)} · p90 ${fmtUSD(dist.p90USD)} · max ${fmtUSD(dist.maxUSD)} · ${fmtInt(dist.count)} sessions`
      : undefined;
  const trunc =
    total > TABLE_ROWS
      ? `<div class="trunc">top ${TABLE_ROWS} of ${fmtInt(total)} · full list in the JSON report</div>`
      : '';
  return `<div class="card deck">
${h2('Biggest sessions', GLOSSARY.topSessions, hint)}
<div class="sess">${rows}</div>${trunc}
</div>`;
}

// ---------------------------------------------------------------------------
// Share card
//
// A 1200 × 630 image drawn on canvas in the reader's browser, following whatever
// theme and accent they picked. Everything it needs is serialised into the page
// as JSON so the drawing code can stay a static string. It is not a second
// report: it is the seven things worth screenshotting, in order — who, over
// what span, what it would have cost, at what rate, the volume as something
// human-scale, four stats, and the year strip as the visual signature.
// ---------------------------------------------------------------------------
interface CardData {
  brand: string;
  period: string;
  label: string;
  cur: string;
  whole: string;
  frac: string;
  rate: string;
  /** The fixed half of the verdict — always one line. */
  verdict: string;
  /** Every equivalence that fits this volume, already worded. The reroll button
   *  walks the array; `eqStart` is where the seed landed. Empty on a total too
   *  small for any comparison, and the card simply omits the line. */
  equivalents: string[];
  eqStart: number;
  /** [value, label, draw in the accent] */
  stats: [string, string, boolean][];
  /** One entry per heatmap column: seven levels, -1 outside the period. */
  heat: number[][];
  footer: string[];
  /** Sentences, plus where the equivalence gets spliced in when copied. It has
   *  to follow the sentence carrying the token count — "That's 5.7 years of ..."
   *  is a non-sequitur anywhere else. */
  summary: string[];
  eqSlot: number;
  filename: string;
}

function summaryText(data: UsageReport, dv: Derived): string[] {
  const s = data.summary;
  const parts = [
    `${fmtInt(dv.recordDays)} days of AI pairing, at API list prices: ${fmtUSD(dv.total)} — about ${fmtUSD0(dv.perMonth)} a month, or ${(safeDiv(dv.total, s.messages) * 100).toFixed(1)} cents per assistant message.`,
    `${fmtTokens(s.totalTokens)} tokens, ${fmtInt(s.messages)} messages (${fmtInt(Math.round(safeDiv(s.messages, dv.activeDays)))} a day), ${fmtInt(dv.distinctSessions)} sessions, ${fmtInt(dv.activeDays)} active days, a ${fmtInt(s.longestStreakDays)}-day streak.`,
  ];
  const tail: string[] = [];
  if (data.cache.savedUSD > 0) tail.push(`The prompt cache saved another ${fmtUSD0(data.cache.savedUSD)}`);
  if (data.subagents.dispatches > 0) {
    tail.push(
      `${tail.length > 0 ? 'and ' : ''}${fmtPct(data.subagents.shareOfCost)} of the bill was spent by subagents`,
    );
  }
  if (tail.length > 0) parts.push(tail.join(', ') + '.');
  // Last line of what lands in someone's clipboard, so it carries the domain —
  // a pasted summary is otherwise unattributable.
  parts.push(`Computed locally with sessions report · ${SITE_HOST}`);
  return parts;
}

function cardData(data: UsageReport, dv: Derived, cols: HeatColumn[]): CardData {
  const s = data.summary;
  const money = fmtUSD(dv.total);
  const dot = money.lastIndexOf('.');
  // A different slot name than the rate card's, so the two never land on the
  // same comparison and the page repeats itself.
  const eq = equivalenceChoices(s.totalTokens, `${data.period.from}|${data.period.to}|sharecard`);
  return {
    brand: 'SESSIONS',
    period: `${shortDate(dv.recordFrom).toUpperCase()} → ${formatDate(data.period.to).toUpperCase()}`,
    label: 'WHAT THIS WOULD COST AT API LIST PRICES',
    cur: '$',
    whole: money.slice(1, dot),
    frac: money.slice(dot),
    rate: `≈ ${fmtUSD0(dv.perMonth)} a month  ·  $${safeDiv(dv.total, s.messages).toFixed(3)} per assistant message`,
    verdict: `${fmtTokens(s.totalTokens)} tokens, written and re-read in ${fmtInt(dv.recordDays)} days.`,
    equivalents: eq.options.map((o) => `That’s ${o.phrase}.`),
    eqStart: eq.start,
    stats: [
      [fmtInt(Math.round(safeDiv(s.messages, dv.activeDays))), 'MSGS / ACTIVE DAY', false],
      [fmtInt(s.longestStreakDays), 'DAY STREAK', false],
      [fmtUSD0(data.cache.savedUSD), 'SAVED BY CACHE', true],
      [fmtPct(data.subagents.shareOfCost), 'SPENT BY SUBAGENTS', false],
    ],
    heat: cols.map((c) => c.levels),
    // Two lines, right-aligned, drawn at y=571 and y=595 on a 630px card. A
    // third would land at 619 with only 11px of card left under the baseline,
    // so the domain rides on the first line rather than getting its own.
    footer: [`sessions report · ${SITE_HOST}`, `computed locally · ${fmtInt(dv.activeDays)} active days`],
    summary: summaryText(data, dv),
    // summaryText puts the token count in its second sentence.
    eqSlot: 2,
    filename: `ai-usage-${data.period.to}.png`,
  };
}

function shareCardSection(card: CardData): string {
  return `<div class="card deck" id="share">
${h2('Shareable card', GLOSSARY.shareCard, '1200 × 630 · follows your theme and accent')}
<canvas id="cardcanvas" width="2400" height="1260" role="img" aria-label="Usage summary card"></canvas>
<div class="actions">
<button type="button" id="card-png" class="primary">Download PNG</button>
<button type="button" id="card-img">Copy image</button>
<button type="button" id="card-txt">Copy summary text</button>
${card.equivalents.length > 1 ? `<button type="button" id="card-eq">↻ Another comparison</button>` : ''}
<span id="flash" role="status" aria-live="polite"></span>
</div>
<script type="application/json" id="card-data">${jsonForScript(card)}</script>
</div>`;
}

export function renderHtml(data: UsageReport): string {
  const dv = derive(data);
  const cols = heatColumns(data.daily, data.period.from, data.period.to);

  const accentPicker = `<details class="dd" id="accentdd"><summary aria-label="Accent colour"><span class="dot cur"></span><span id="accentname">${DEFAULT_ACCENT}</span><span class="caret">▾</span></summary><div class="menu">${ACCENT_ORDER.map(
    (n) =>
      `<button class="opt" type="button" data-pick="${n}"><span class="dot" style="--c:${PALETTES[n]!.dark.accent}"></span>${n}</button>`,
  ).join('')}</div></details>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Usage Report — ${esc(data.period.from)} to ${esc(data.period.to)}</title>
${FONT_LINK}
<script>${THEME_BOOT_JS}</script>
<style>${CSS}</style></head>
<body>
<div class="page"><div class="shell">
<div class="topline">
<a class="brand" href="${SITE_URL}">sessions</a>
<span class="right">
<span class="period">${esc(periodLabel(data.period.from, data.period.to))} · local data only</span>
<a class="sharelink" href="#share">share ↓</a>
${accentPicker}
<button id="themetoggle" type="button" aria-label="Toggle light and dark theme"><svg class="ic-sun" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1"/></svg><svg class="ic-moon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
</span>
</div>
${warningBanner(data.warnings)}
${heroSection(data, dv)}
${ledeSection(data, dv)}
${rateCardSection(data, dv)}
${burnSection(data.burn)}
${rhythmSection(cols, dv.activeDays)}
${dailySection(data)}
${clockSection(data)}
${breakdownSection(data)}
${weeklyMixSection(data)}
${cacheSection(data.cache, data.subagents, dv.total)}
${subagentTables(data.subagents)}
${sessionSection(data.topSessions, data.totalSessions, data.sessionDistribution)}
${shareCardSection(cardData(data, dv, cols))}
<footer class="rep"><span>sessions usage report</span><span>estimated from public list prices</span><span>computed locally · no telemetry</span><a href="${SITE_URL}">${SITE_HOST}</a></footer>
</div></div>
<div class="tip" id="tip"></div>
<script>${JS}</script>
</body></html>`;
}
