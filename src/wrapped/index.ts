// `sessions wrapped` — a Spotify-Wrapped-style year in review, rendered as a
// self-contained HTML story and opened in the browser. Mirrors runReport's
// sequence (gather → period filter → pricing → aggregate) and layers wrapped-
// only passes on top: raw-event superlatives (compute.ts), index-backed content
// stats (content.ts), and dynamic slide selection (select.ts).

import { writeFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolId } from '../report/types.ts';
import { gatherEvents, defaultRoots, type ReportRoots } from '../report/extract.ts';
import { aggregate } from '../report/aggregate.ts';
import { drainPricingWarnings, resetPricingWarnings, mergeRuntimePricing } from '../report/pricing.ts';
import { loadRuntimePricing } from '../report/pricing-cache.ts';
import { localDate } from '../report/parsers/util.ts';
import { computeEventStats, longestGapRange, longestStreakRange } from './compute.ts';
import { computeContentStats } from './content.ts';
import { selectFunCards, selectPersona, selectWordOfYear } from './select.ts';
import { renderWrappedHtml } from './html.ts';
import { coerceExtras } from './extras.ts';
import { runRoast, type RoastRunner, type RoastToolId } from './roast.ts';
import type { WrappedData, WrappedExtra } from './types.ts';

export interface WrappedOptions {
  year?: number;
  tool?: ToolId;
  tz: string;
  out?: string;
  stdout: boolean;
  offline?: boolean;
  refreshPricing?: boolean;
  extras?: string;
  /** Ask an installed agent CLI to write bespoke roast slides from the stats. */
  roast?: boolean;
  /** Force a specific roast CLI instead of autodetecting. */
  roastWith?: RoastToolId;
  /** Test injection, same convention as report. */
  roots?: ReportRoots;
  now?: string;
  /** Skip the index-backed content pass (tests without an index). */
  noContent?: boolean;
  /** Test injection: stub the roast CLI instead of spawning one. */
  roastRunner?: RoastRunner;
}

const ROAST_TOOLS: Record<string, RoastToolId> = { claude: 'claude', codex: 'codex', pi: 'pi' };

export interface WrappedResult {
  htmlPath?: string;
  json: string;
}

const TOOL_MAP: Record<string, ToolId> = { claude: 'claude-code', codex: 'codex', pi: 'pi', opencode: 'opencode' };

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions wrapped — your year with AI agents, Spotify-Wrapped style

Generates a scroll-through story page from your local session transcripts:
tokens, cost, streaks, rhythm, top projects and models, plus fun stats mined
from what you and your agents actually said. Everything is computed locally.

Usage:
  sessions wrapped                  This year, opened in your browser
  sessions wrapped --year 2025      A past calendar year
  sessions wrapped --out w.html     Write the page to a file instead of opening
  sessions wrapped --stdout         Print the underlying JSON (no HTML)

Options:
  --year <YYYY>    Calendar year to wrap (default: current year)
  --tool <name>    Only one tool: claude, codex, pi, or opencode
  --tz <zone>      Timezone for day/hour bucketing (default: TIMEZONE env or America/Chicago)
  --extras <path>  JSON file of extra slides: [{"headline": "...", "title"?, "subline"?, "footnote"?}]
  --roast          Let an installed agent CLI (claude/codex/pi) improvise a few
                   roast slides from your stats — opt-in, needs no setup, and the
                   page still renders if it fails. Stats only; nothing else is sent.
  --roast-with <tool>  Force the roast CLI: claude, codex, or pi
  --out <path>     Write HTML here instead of a temp file (implies no auto-open)
  --stdout         Print wrapped data as JSON to stdout
  --offline        Skip the pricing refresh (use cached/embedded rates)
  --refresh-pricing  Force a pricing refresh even if the cache is fresh
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseWrappedArgs(argv: string[]): WrappedOptions {
  const opts: WrappedOptions = {
    tz: process.env['TIMEZONE'] ?? 'America/Chicago',
    stdout: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        help();
        break;
      case '--year': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 2000 || v > 2100) die('--year must be a four-digit year');
        opts.year = v;
        break;
      }
      case '--tool': {
        const v = argv[++i] ?? '';
        const mapped = TOOL_MAP[v];
        if (!mapped) die('--tool must be claude|codex|pi|opencode');
        opts.tool = mapped;
        break;
      }
      case '--tz':
        opts.tz = argv[++i] ?? opts.tz;
        break;
      case '--out':
        opts.out = argv[++i];
        break;
      case '--stdout':
        opts.stdout = true;
        break;
      case '--offline':
        opts.offline = true;
        break;
      case '--refresh-pricing':
        opts.refreshPricing = true;
        break;
      case '--extras':
        opts.extras = argv[++i];
        break;
      case '--roast':
        opts.roast = true;
        break;
      case '--roast-with': {
        const v = argv[++i] ?? '';
        const mapped = ROAST_TOOLS[v];
        if (!mapped) die('--roast-with must be claude|codex|pi');
        opts.roast = true;
        opts.roastWith = mapped;
        break;
      }
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }
  return opts;
}

/** Parse and bound --extras: agent-authored slides are welcome, but the page
 *  stays in control of shape and size. */
export function parseExtras(raw: string): WrappedExtra[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die('--extras file is not valid JSON');
  }
  if (!Array.isArray(parsed)) die('--extras must be a JSON array of slides');
  return coerceExtras(parsed);
}

export async function runWrapped(opts: WrappedOptions): Promise<WrappedResult> {
  const now = opts.now ?? new Date().toISOString();
  const tz = opts.tz;
  const todayLocal = localDate(now, tz);
  const year = opts.year ?? Number(todayLocal.slice(0, 4));
  const from = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const to = todayLocal < yearEnd && todayLocal >= from ? todayLocal : yearEnd;

  const tools = opts.tool ? new Set<ToolId>([opts.tool]) : undefined;
  const events = await gatherEvents(opts.roots ?? defaultRoots(), tools);
  const inRange = events.filter((e) => {
    const d = localDate(e.timestamp, tz);
    return d >= from && d <= to;
  });
  if (inRange.length === 0) {
    process.stderr.write(`warning: no usage events found for ${year}; the page will be a quiet one\n`);
  }

  if (!opts.offline) {
    const live = await loadRuntimePricing({ force: opts.refreshPricing });
    if (live) mergeRuntimePricing(live);
  }
  resetPricingWarnings();
  const agg = aggregate({ events: inRange, prs: [], now, tz, exclude: new Set<string>(), priorDaily: [] });
  const warnings = drainPricingWarnings();
  if (warnings.length > 0) {
    const models = warnings.map((w) => w.model).join(', ');
    process.stderr.write(`warning: ${warnings.length} model(s) had no pricing — cost may be understated: ${models}\n`);
  }

  const ev = computeEventStats(inRange, tz);

  let extras: WrappedExtra[] = [];
  if (opts.extras) {
    // Size-check before reading — the per-field caps in parseExtras can't
    // help if JSON.parse already swallowed a multi-gigabyte file.
    let size = 0;
    try {
      ({ size } = await stat(opts.extras));
    } catch {
      die(`--extras: cannot read ${opts.extras}`);
    }
    if (size > 256 * 1024) die(`--extras: file too large (${size} bytes; max 256KB)`);
    let raw: string;
    try {
      raw = await readFile(opts.extras, 'utf8');
    } catch {
      die(`--extras: cannot read ${opts.extras}`);
    }
    extras = parseExtras(raw);
  }

  // Content pass degrades gracefully: no index (or a broken one) simply means
  // no fun cards — the dynamic selection treats absence like non-notability.
  let content = null;
  let sessionOfYear = null;
  if (!opts.noContent && inRange.length > 0) {
    try {
      const c = await computeContentStats({ from, to, tool: opts.tool });
      const { sessionOfYear: soy, ...rest } = c;
      // An index with zero sessions for the period must not feed the fun
      // cards — a "0 times" joke claiming to be counted from transcripts
      // that were never indexed is a fabrication.
      if (rest.indexedSessions > 0) {
        content = rest;
        sessionOfYear = soy;
      }
    } catch (err) {
      process.stderr.write(`warning: could not read the search index — skipping conversation stats (${String(err)})\n`);
    }
  }

  const totalTokens = agg.summary.totalTokens;
  // aggregate sorts by cost; the page ranks by tokens — re-sort so bars are
  // monotone. Session counts come from the event pass (distinct per project),
  // never aggregate's sum-of-daily, which double-counts cross-midnight sessions.
  const projects = agg.byProject
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((p) => ({
      name: p.label,
      tokens: p.tokens,
      costUSD: p.costUSD,
      sessions: ev.sessionsByProject.get(p.label) ?? p.sessions,
      share: totalTokens > 0 ? p.tokens / totalTokens : 0,
    }));

  // aggregate keys byModel by tool|provider|id, so one model reached through
  // two tools shows up as split rows — merge by model id before ranking.
  const totalMessages = agg.summary.messages;
  const byModelId = new Map<string, { id: string; label: string; messages: number; tokens: number }>();
  for (const m of agg.byModel) {
    const cur = byModelId.get(m.id);
    if (cur) {
      cur.messages += m.messages;
      cur.tokens += m.tokens;
    } else {
      byModelId.set(m.id, { id: m.id, label: m.label, messages: m.messages, tokens: m.tokens });
    }
  }
  const models = [...byModelId.values()]
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 5)
    .map((m) => {
      const firsts = ev.modelFirsts.get(m.id);
      return {
        ...m,
        share: totalMessages > 0 ? m.messages / totalMessages : 0,
        firstSeen: firsts?.firstSeen ?? agg.period.from,
        firstTopDay: firsts?.firstTopDay ?? null,
      };
    });

  const toolTokens = agg.byTool.reduce((sum, t) => sum + t.tokens, 0);
  const toolsOut = agg.byTool.map((t) => ({
    id: t.id,
    label: t.label,
    sessions: ev.sessionsByTool.get(t.id) ?? t.sessions,
    tokens: t.tokens,
    share: toolTokens > 0 ? t.tokens / toolTokens : 0,
  }));

  const daily = agg.daily.map((d) => ({ date: d.date, tokens: d.tokens, messages: d.messages }));
  const activeDaily = daily.filter((d) => d.messages > 0);
  let biggestDay: WrappedData['biggestDay'] = null;
  if (activeDaily.length > 0) {
    const sorted = activeDaily.map((d) => d.tokens).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianTokens = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const peak = activeDaily.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    biggestDay = { ...peak, medianTokens };
  }

  const activeDates = activeDaily.map((d) => d.date);
  const streak = longestStreakRange(activeDates);
  const longestGap = longestGapRange(activeDates);

  const fun = selectFunCards(content, ev.rhythm);
  const wordOfYear = selectWordOfYear(content);
  const persona = selectPersona(ev, projects[0]?.share ?? 0, content);

  const dataBegins = activeDaily[0]?.date ?? null;

  const data: WrappedData = {
    generator: 'sessions',
    version: 1,
    generatedAt: now,
    year,
    period: { from, to },
    dataBegins,
    tz,
    warnings,
    totals: {
      tokens: totalTokens,
      cacheReadTokens: ev.cacheReadTokens,
      costUSD: agg.summary.totalCostUSD,
      sessions: ev.distinctSessions,
      messages: totalMessages,
      activeDays: agg.summary.activeDays,
      longestStreak: streak,
    },
    rhythm: ev.rhythm,
    daily,
    biggestDay,
    longestGap,
    projects,
    models,
    modelsTried: ev.modelFirsts.size,
    tools: toolsOut,
    cacheHitRate: ev.cacheHitRate,
    longestSession: ev.longestSession,
    sessionOfYear,
    content,
    fun,
    wordOfYear,
    persona,
    extras,
  };

  // The roast runs last: it needs the finished stats to riff on, and it appends
  // to whatever --extras already supplied (capped at 6 total). Fail-open — a
  // missing/failed CLI just leaves the deterministic page untouched.
  if (opts.roast) {
    const roasted = await runRoast(data, { preferred: opts.roastWith, runner: opts.roastRunner });
    if (roasted.length > 0) data.extras = [...data.extras, ...roasted].slice(0, 6);
  }

  const json = JSON.stringify(data, null, 2);
  const result: WrappedResult = { json };

  if (opts.stdout) {
    // Bun.write awaits the flush; process.stdout.write + the caller's
    // process.exit(0) truncates piped output at the 64KB pipe buffer.
    await Bun.write(Bun.stdout, json + '\n');
    return result;
  }

  const html = renderWrappedHtml(data);
  const p = opts.out ?? join(await mkdtemp(join(tmpdir(), 'sessions-wrapped-')), 'wrapped.html');
  await writeFile(p, html, 'utf8');
  result.htmlPath = p;
  return result;
}
