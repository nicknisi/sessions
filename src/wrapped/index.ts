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
import { writeStdoutFully } from '../stdout.ts';
import { computeEventStats, computeLoops, longestGapRange, longestStreakRange } from './compute.ts';
import { collectClaudeUserTurns } from './loops.ts';
import { computeContentStats } from './content.ts';
import { selectFunCards, selectPersona, selectWordOfYear } from './select.ts';
import { renderWrappedHtml } from './html.ts';
import { canonicalModel, isRealModel } from './model-name.ts';
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

interface RoastToolByName {
  [name: string]: RoastToolId;
}
const ROAST_TOOLS: RoastToolByName = { claude: 'claude', codex: 'codex', pi: 'pi' };

export interface WrappedResult {
  htmlPath?: string;
  json: string;
}

interface ToolIdByName {
  [name: string]: ToolId;
}
const TOOL_MAP: ToolIdByName = { claude: 'claude-code', codex: 'codex', pi: 'pi', opencode: 'opencode' };

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
  const roots = opts.roots ?? defaultRoots();
  const events = await gatherEvents(roots, tools);
  // The spend/volume headline (tokens, cost, messages, sessions, rhythm, models,
  // projects) is computed from the SAME events as `sessions report` so the two
  // reconcile exactly — automated eval/tmp runs cost real money and belong in the
  // total. Junk exclusion is a *content-pass* concern only (content.ts): it keeps
  // probes/evals out of the fun story (abandoned, drive-bys, word of year,
  // errors) where report has nothing to compare against and the noise misleads.
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

  // The loop pass re-walks the Claude Code root for the human-turn timestamps
  // the report parsers throw away. Claude-only by design (see loops.ts), so
  // skip the walk entirely when another tool was requested. Fail-open: an
  // unreadable root just means no loop slide.
  let loops = null;
  if (!opts.tool || opts.tool === 'claude-code') {
    try {
      loops = computeLoops(inRange, await collectClaudeUserTurns(roots.claudeCode), tz);
    } catch (err) {
      process.stderr.write(`warning: could not read user turns for the loop stat (${String(err)})\n`);
    }
  }

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
  // On local-model years (no token meter) rank by sessions so the list isn't a
  // pile of zero-token ties.
  const projSessions = (label: string, fallback: number): number => ev.sessionsByProject.get(label) ?? fallback;
  const projects = agg.byProject
    .slice()
    .sort((a, b) =>
      totalTokens > 0 ? b.tokens - a.tokens : projSessions(b.label, b.sessions) - projSessions(a.label, a.sessions),
    )
    .slice(0, 5)
    .map((p) => ({
      name: p.label,
      tokens: p.tokens,
      costUSD: p.costUSD,
      sessions: projSessions(p.label, p.sessions),
      share: totalTokens > 0 ? p.tokens / totalTokens : 0,
    }));

  // aggregate keys byModel by tool|provider|id, so one model split across tools —
  // and across dated snapshots / provider aliases (opus-4-5 vs opus-4-5-20251101
  // vs openai/gpt-oss-120b) — shows up as several rows. Merge on the canonical
  // display name so the cast list never lists the same model twice, and drop the
  // '<synthetic>' sentinel (turns with no real model) entirely.
  const totalMessages = agg.summary.messages;
  const byCanon = new Map<string, { id: string; label: string; messages: number; tokens: number }>();
  for (const m of agg.byModel) {
    if (!isRealModel(m.id)) continue;
    const key = canonicalModel(m.id);
    const cur = byCanon.get(key);
    if (cur) {
      cur.messages += m.messages;
      cur.tokens += m.tokens;
    } else {
      byCanon.set(key, { id: m.id, label: key, messages: m.messages, tokens: m.tokens });
    }
  }
  const models = [...byCanon.values()]
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 5)
    .map((m) => {
      // modelFirsts is keyed by canonical name (compute.ts), so first-seen /
      // first-top day already pool a model's snapshots.
      const firsts = ev.modelFirsts.get(m.label);
      return {
        id: m.id,
        label: m.label,
        messages: m.messages,
        tokens: m.tokens,
        share: totalMessages > 0 ? m.messages / totalMessages : 0,
        firstSeen: firsts?.firstSeen ?? agg.period.from,
        firstTopDay: firsts?.firstTopDay ?? null,
      };
    });

  const toolTokens = agg.byTool.reduce((sum, t) => sum + t.tokens, 0);
  const toolSessions = agg.byTool.reduce((sum, t) => sum + (ev.sessionsByTool.get(t.id) ?? t.sessions), 0);
  const toolsOut = agg.byTool.map((t) => {
    const sessions = ev.sessionsByTool.get(t.id) ?? t.sessions;
    return {
      id: t.id,
      label: t.label,
      sessions,
      tokens: t.tokens,
      // token share normally; session share on local-model years so a used tool
      // isn't stuck at 0%.
      share: toolTokens > 0 ? t.tokens / toolTokens : toolSessions > 0 ? sessions / toolSessions : 0,
    };
  });

  const daily = agg.daily.map((d) => ({ date: d.date, tokens: d.tokens, messages: d.messages }));
  const activeDaily = daily.filter((d) => d.messages > 0);
  let biggestDay: WrappedData['biggestDay'] = null;
  if (activeDaily.length > 0) {
    const median = (vals: number[]): number => {
      const s = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    };
    const medianTokens = median(activeDaily.map((d) => d.tokens));
    const medianMessages = median(activeDaily.map((d) => d.messages));
    // Rank by tokens normally; on local-model years (no token meter) rank by
    // messages so the "biggest day" is still a real day, not a 0-token tie.
    const peak =
      totalTokens > 0
        ? activeDaily.reduce((a, b) => (b.tokens > a.tokens ? b : a))
        : activeDaily.reduce((a, b) => (b.messages > a.messages ? b : a));
    biggestDay = { ...peak, medianTokens, medianMessages };
  }

  const activeDates = activeDaily.map((d) => d.date);
  const streak = longestStreakRange(activeDates);
  const longestGap = longestGapRange(activeDates);

  const fun = selectFunCards(content, ev.rhythm, {
    costUSD: agg.summary.totalCostUSD,
    activeDays: agg.summary.activeDays,
    modelsTried: ev.modelFirsts.size,
    cacheHitRate: ev.cacheHitRate,
  });
  const wordOfYear = selectWordOfYear(content);
  // Focus = concentration on one project. Token share when there's a token meter;
  // on local-model years fall back to session share so it isn't a false "0%".
  const topSessionShare =
    ev.distinctSessions > 0 ? Math.max(0, ...ev.sessionsByProject.values()) / ev.distinctSessions : 0;
  const focusShare = totalTokens > 0 ? (projects[0]?.share ?? 0) : topSessionShare;
  const persona = selectPersona(ev, focusShare, content);

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
    // modelFirsts is canonical-keyed (snapshots/aliases already merged,
    // '<synthetic>' excluded), so its size is the distinct-models-tried count.
    modelsTried: ev.modelFirsts.size,
    tools: toolsOut,
    cacheHitRate: ev.cacheHitRate,
    longestSession: ev.longestSession,
    loops,
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
    await writeStdoutFully(json + '\n');
    return result;
  }

  const html = renderWrappedHtml(data);
  const p = opts.out ?? join(await mkdtemp(join(tmpdir(), 'sessions-wrapped-')), 'wrapped.html');
  await writeFile(p, html, 'utf8');
  result.htmlPath = p;
  return result;
}
