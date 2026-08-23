import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolId } from './types.ts';
import { gatherEvents, defaultRoots, type ReportRoots } from './extract.ts';
import { aggregate } from './aggregate.ts';
import { renderHtml } from './html.ts';
import { renderText } from './text.ts';
import { computeFacets, computeBurn } from './facets.ts';
import { lookupIntents } from './session-intent.ts';
import { toUsageReport } from './schema.ts';
import { drainPricingWarnings, resetPricingWarnings, mergeRuntimePricing } from './pricing.ts';
import { loadRuntimePricing } from './pricing-cache.ts';
import { resolvePeriod, periodRunsTo, type PeriodPreset } from './period.ts';
import { resolveProject } from './project.ts';
import { localDate } from './parsers/util.ts';
import { writeStdoutFully } from '../stdout.ts';

export type ReportFormat = 'json' | 'html' | 'both' | 'text';

export interface ReportOptions {
  format: ReportFormat;
  out?: string;
  from?: string;
  to?: string;
  days?: number;
  preset?: PeriodPreset;
  month?: string;
  tool?: ToolId;
  tz: string;
  stdout: boolean;
  roots?: ReportRoots;
  now?: string;
  here?: boolean;
  cwd?: string;
  offline?: boolean;
  refreshPricing?: boolean;
  /** Bypass the incremental parse cache and read every transcript. */
  noCache?: boolean;
}

export interface ReportResult {
  jsonPath?: string;
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

export function parseReportArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = {
    format: 'html',
    tz: process.env['TIMEZONE'] ?? 'America/Chicago',
    stdout: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '--format': {
        const v = argv[++i];
        if (v !== 'json' && v !== 'html' && v !== 'both' && v !== 'text') die('--format must be json|html|both|text');
        opts.format = v;
        break;
      }
      case '--out':
        opts.out = argv[++i];
        break;
      case '--from':
        opts.from = argv[++i];
        break;
      case '--to':
        opts.to = argv[++i];
        break;
      case '--days': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('--days must be a positive integer');
        opts.days = v;
        break;
      }
      case '--tz':
        opts.tz = argv[++i] ?? opts.tz;
        break;
      case '--stdout':
        opts.stdout = true;
        break;
      case '--here':
        opts.here = true;
        break;
      case '--offline':
        opts.offline = true;
        break;
      case '--refresh-pricing':
        opts.refreshPricing = true;
        break;
      case '--no-cache':
        opts.noCache = true;
        break;
      case '--tool': {
        const v = argv[++i] ?? '';
        const mapped = TOOL_MAP[v];
        if (!mapped) die('--tool must be claude|codex|pi|opencode');
        opts.tool = mapped;
        break;
      }
      case '--today':
      case '--this-week':
      case '--this-month':
      case '--last-month':
      case '--this-year':
        // SAFETY: the case labels above constrain `a` to '--'+PeriodPreset members.
        opts.preset = a.slice(2) as PeriodPreset;
        break;
      case '--month':
        opts.preset = 'month';
        opts.month = argv[++i];
        break;
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }
  return opts;
}

/** Start of the equally long window immediately before [from, to]. */
function previousWindowStart(from: string, to: string): string {
  const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000) + 1;
  const dt = new Date(Date.parse(from + 'T00:00:00Z'));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function daysAgo(todayLocal: string, n: number): string {
  const [y, m, d] = todayLocal.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - (n - 1));
  return dt.toISOString().slice(0, 10);
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
  const now = opts.now ?? new Date().toISOString();
  const tz = opts.tz;
  const tools = opts.tool ? new Set<ToolId>([opts.tool]) : undefined;

  const todayLocal = localDate(now, tz);
  // Precedence: a named preset wins, then --days, then explicit --from/--to.
  let from = opts.from;
  let to = opts.to;
  let runsTo: string | null = null;
  if (opts.preset) {
    ({ from, to } = resolvePeriod(opts.preset, opts.month, todayLocal));
    runsTo = periodRunsTo(opts.preset, opts.month, todayLocal);
  } else if (opts.days) {
    from = daysAgo(todayLocal, opts.days);
  }

  // The equally long window immediately before this one, gathered so the report
  // can say whether spend is up or down. Only the comparison total is taken from
  // it — these events never enter the report's own figures.
  const priorFrom = from ? previousWindowStart(from, to ?? todayLocal) : undefined;

  // Resolved before gathering so a bounded period can skip transcripts that were
  // last written before the window — the difference between reading the whole
  // corpus and reading the part that can matter. `since` reaches back to the
  // comparison window, which is why the range filter below is what defines the
  // report, not the gather.
  const events = await gatherEvents(opts.roots ?? defaultRoots(), tools, {
    since: priorFrom ?? from,
    noCache: opts.noCache,
  });
  // Project scoping matches by resolved name on both sides, so events whose
  // cwd lacks a known project ('unknown') drop out of a --here report.
  const hereProject = opts.here ? resolveProject(opts.cwd ?? process.cwd()) : undefined;
  const inScope = events.filter((e) => !hereProject || resolveProject(e.projectPath) === hereProject);
  const inRange = inScope.filter((e) => {
    const d = localDate(e.timestamp, tz);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  const priorRange =
    priorFrom && from
      ? inScope.filter((e) => {
          const d = localDate(e.timestamp, tz);
          return d >= priorFrom && d < from;
        })
      : null;

  if (inRange.length === 0) {
    const scope = hereProject ? ` for project ${hereProject}` : '';
    process.stderr.write(`warning: no usage events in range${scope}; report is empty\n`);
  }

  // Refresh pricing at runtime so costs reflect current LiteLLM rates without a
  // recompile. Must run before aggregate(), since computeCost reads the module
  // pricing map during aggregation. --offline skips the network entirely;
  // failures degrade gracefully (loadRuntimePricing returns null → embedded floor).
  if (!opts.offline) {
    const live = await loadRuntimePricing({ force: opts.refreshPricing });
    if (live) mergeRuntimePricing(live);
  }

  // Facets price the same events a second time, so they run BEFORE the reset —
  // otherwise every unpriced model would be warned about twice and its token
  // count doubled in the drained warning.
  const facets = computeFacets(inRange, tz);

  // Name the expensive sessions from the search index, if there is one. Best
  // effort by design: a report on a machine that has never indexed still works,
  // it just shows ids instead of intents.
  const intents = lookupIntents(facets.topSessions.map((s) => ({ tool: s.tool, sessionId: s.sessionId })));
  for (const s of facets.topSessions) s.intent = intents.get(`${s.tool}|${s.sessionId}`) ?? null;

  const burn = from ? computeBurn(inRange, priorRange, { from, to: to ?? todayLocal, runsTo }, todayLocal) : null;

  // Clear any pricing warnings from a prior run so the collector reflects only
  // this aggregation (computeCost accumulates as a side effect during aggregate).
  resetPricingWarnings();
  const data = aggregate({ events: inRange, prs: [], now, tz, exclude: new Set<string>(), priorDaily: [] });
  const report = toUsageReport(data, facets);
  // The internal aggregate always reports "to today"; reflect the requested
  // window instead so an explicit range (e.g. --month 2026-05) reads correctly.
  report.period = { from: from ?? data.period.from, to: to ?? data.period.to };
  report.burn = burn;

  // Drain unpriced-model warnings into the report and surface them loudly. A
  // model with tokens but no price match is never silently zeroed — it is either
  // estimated at a same-family rate (pricedAs) or reported as a $0 shortfall.
  report.warnings = drainPricingWarnings();
  if (report.warnings.length > 0) {
    const estimated = report.warnings.filter((w) => w.pricedAs);
    const zeroed = report.warnings.filter((w) => !w.pricedAs);
    if (estimated.length > 0) {
      const list = estimated.map((w) => `${w.model} (as ${w.pricedAs})`).join(', ');
      process.stderr.write(`warning: ${estimated.length} model(s) priced at a same-family estimate: ${list}\n`);
    }
    if (zeroed.length > 0) {
      const list = zeroed.map((w) => w.model).join(', ');
      process.stderr.write(`warning: ${zeroed.length} model(s) had no pricing — cost is understated: ${list}\n`);
    }
  }
  const json = JSON.stringify(report, null, 2);
  const result: ReportResult = { json };

  // `text` goes straight to stdout and writes nothing to disk — it's the quick
  // "what did today cost" answer, not an artifact.
  if (opts.format === 'text') {
    await writeStdoutFully(renderText(report));
    return result;
  }

  const wantJson = opts.format === 'json' || opts.format === 'both';
  const wantHtml = opts.format === 'html' || opts.format === 'both';

  // With no --out, files land in a fresh temp dir (the CLI opens the HTML from there).
  const needsFile = wantHtml || (wantJson && !opts.stdout);
  const outBase = opts.out ?? (needsFile ? await mkdtemp(join(tmpdir(), 'sessions-report-')) : undefined);

  if (opts.stdout) {
    await writeStdoutFully(json + '\n');
  } else if (wantJson) {
    const p = opts.format === 'both' || !opts.out ? join(outBase!, 'usage-report.json') : opts.out;
    await writeFile(p, json, 'utf8');
    result.jsonPath = p;
  }

  if (wantHtml) {
    const html = renderHtml(report);
    const p = opts.format === 'both' || !opts.out ? join(outBase!, 'report.html') : opts.out;
    await writeFile(p, html, 'utf8');
    result.htmlPath = p;
  }

  return result;
}
