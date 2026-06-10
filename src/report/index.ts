import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolId } from './types.ts';
import { gatherEvents, defaultRoots, type ReportRoots } from './extract.ts';
import { aggregate } from './aggregate.ts';
import { renderHtml } from './html.ts';
import { toUsageReport } from './schema.ts';
import { resolvePeriod, type PeriodPreset } from './period.ts';
import { resolveProject } from './project.ts';
import { localDate } from './parsers/util.ts';

export type ReportFormat = 'json' | 'html' | 'both';

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
}

export interface ReportResult {
  jsonPath?: string;
  htmlPath?: string;
  json: string;
}

const TOOL_MAP: Record<string, ToolId> = { claude: 'claude-code', codex: 'codex', pi: 'pi' };

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

export function parseReportArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = {
    format: 'both',
    tz: process.env['TIMEZONE'] ?? 'America/Chicago',
    stdout: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '--format': {
        const v = argv[++i];
        if (v !== 'json' && v !== 'html' && v !== 'both') die('--format must be json|html|both');
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
      case '--tool': {
        const v = argv[++i] ?? '';
        const mapped = TOOL_MAP[v];
        if (!mapped) die('--tool must be claude|codex|pi');
        opts.tool = mapped;
        break;
      }
      case '--today':
      case '--this-week':
      case '--this-month':
      case '--last-month':
      case '--this-year':
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
  const events = await gatherEvents(opts.roots ?? defaultRoots(), tools);

  const todayLocal = localDate(now, tz);
  // Precedence: a named preset wins, then --days, then explicit --from/--to.
  let from = opts.from;
  let to = opts.to;
  if (opts.preset) {
    ({ from, to } = resolvePeriod(opts.preset, opts.month, todayLocal));
  } else if (opts.days) {
    from = daysAgo(todayLocal, opts.days);
  }
  // Project scoping matches by resolved name on both sides, so events whose
  // cwd lacks a known project ('unknown') drop out of a --here report.
  const hereProject = opts.here ? resolveProject(opts.cwd ?? process.cwd()) : undefined;
  const inRange = events.filter((e) => {
    if (hereProject && resolveProject(e.projectPath) !== hereProject) return false;
    const d = localDate(e.timestamp, tz);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  if (inRange.length === 0) {
    const scope = hereProject ? ` for project ${hereProject}` : '';
    process.stderr.write(`warning: no usage events in range${scope}; report is empty\n`);
  }

  const data = aggregate({ events: inRange, prs: [], now, tz, exclude: new Set<string>(), priorDaily: [] });
  const report = toUsageReport(data);
  // The internal aggregate always reports "to today"; reflect the requested
  // window instead so an explicit range (e.g. --month 2026-05) reads correctly.
  report.period = { from: from ?? data.period.from, to: to ?? data.period.to };
  const json = JSON.stringify(report, null, 2);
  const result: ReportResult = { json };

  const wantJson = opts.format === 'json' || opts.format === 'both';
  const wantHtml = opts.format === 'html' || opts.format === 'both';

  if (opts.stdout) {
    process.stdout.write(json + '\n');
  } else if (wantJson) {
    const p = opts.format === 'both' ? join(opts.out ?? '.', 'usage-report.json') : (opts.out ?? './usage-report.json');
    await writeFile(p, json, 'utf8');
    result.jsonPath = p;
  }

  if (wantHtml) {
    const html = renderHtml(report);
    const p = opts.format === 'both' ? join(opts.out ?? '.', 'report.html') : (opts.out ?? './report.html');
    await writeFile(p, html, 'utf8');
    result.htmlPath = p;
  }

  return result;
}
