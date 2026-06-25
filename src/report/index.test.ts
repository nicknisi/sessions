import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReport, parseReportArgs } from './index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-report-run-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
mkdirSync(join(claudeDir, 'proj'), { recursive: true });
writeFileSync(
  join(claudeDir, 'proj', 'a.jsonl'),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: '2026-06-01T14:30:00Z',
    message: {
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 10000,
      },
    },
  }) + '\n',
);
const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };

// Separate fixture set for --here: three events across two projects plus one with no cwd.
const hereClaudeDir = join(tmp, 'claude-here');
mkdirSync(join(hereClaudeDir, 'proj'), { recursive: true });
const hereEvent = (sessionId: string, cwd: string | undefined, input: number, output: number) =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    ...(cwd ? { cwd } : {}),
    timestamp: '2026-06-01T14:30:00Z',
    message: { model: 'claude-opus-4-6', usage: { input_tokens: input, output_tokens: output } },
  }) + '\n';
writeFileSync(
  join(hereClaudeDir, 'proj', 'b.jsonl'),
  hereEvent('s1', '/Users/x/Developer/sessions', 1000, 500) +
    hereEvent('s2', '/Users/x/Developer/otherproj', 100, 50) +
    hereEvent('s3', undefined, 10, 5),
);
const hereRoots = { claudeCode: hereClaudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };

describe('parseReportArgs', () => {
  test('defaults', () => {
    const o = parseReportArgs([]);
    expect(o.format).toBe('html');
    expect(o.stdout).toBe(false);
    expect(o.out).toBeUndefined();
  });
  test('parses flags', () => {
    const o = parseReportArgs(['--format', 'json', '--days', '7', '--tool', 'claude', '--tz', 'UTC', '--stdout']);
    expect(o.format).toBe('json');
    expect(o.days).toBe(7);
    expect(o.tool).toBe('claude-code');
    expect(o.tz).toBe('UTC');
    expect(o.stdout).toBe(true);
  });

  test('parses --here', () => {
    expect(parseReportArgs(['--here']).here).toBe(true);
    expect(parseReportArgs([]).here).toBeUndefined();
  });

  test('parses --offline and --refresh-pricing', () => {
    expect(parseReportArgs(['--offline']).offline).toBe(true);
    expect(parseReportArgs(['--refresh-pricing']).refreshPricing).toBe(true);
    const o = parseReportArgs([]);
    expect(o.offline).toBeUndefined();
    expect(o.refreshPricing).toBeUndefined();
  });

  test('unknown flag still dies', () => {
    // parseReportArgs calls process.exit(1) on an unknown option; run it in a
    // child process so the assertion survives.
    const r = Bun.spawnSync(['bun', '-e', "require('./src/report/index.ts').parseReportArgs(['--nope'])"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('unknown option');
  });

  test('parses period presets', () => {
    expect(parseReportArgs(['--this-month']).preset).toBe('this-month');
    expect(parseReportArgs(['--today']).preset).toBe('today');
    const m = parseReportArgs(['--month', '2026-05']);
    expect(m.preset).toBe('month');
    expect(m.month).toBe('2026-05');
  });
});

describe('runReport', () => {
  test('without --out, writes html to a fresh temp dir', async () => {
    const res = await runReport({
      format: 'html',
      tz: 'UTC',
      stdout: false,
      roots,
      now: '2026-06-06T00:00:00Z',
      offline: true,
    });
    expect(res.jsonPath).toBeUndefined();
    expect(res.htmlPath).toContain('sessions-report-');
    expect(res.htmlPath!.endsWith('report.html')).toBe(true);
    expect(readFileSync(res.htmlPath!, 'utf8').startsWith('<!DOCTYPE html>')).toBe(true);
    rmSync(join(res.htmlPath!, '..'), { recursive: true, force: true });
  });

  test('without --out, format both puts both files in the same temp dir', async () => {
    const res = await runReport({
      format: 'both',
      tz: 'UTC',
      stdout: false,
      roots,
      now: '2026-06-06T00:00:00Z',
      offline: true,
    });
    expect(res.jsonPath).toContain('sessions-report-');
    expect(join(res.jsonPath!, '..')).toBe(join(res.htmlPath!, '..'));
    expect(existsSync(res.jsonPath!)).toBe(true);
    rmSync(join(res.jsonPath!, '..'), { recursive: true, force: true });
  });

  test('writes both json and html to the out dir', async () => {
    const outDir = join(tmp, 'out');
    mkdirSync(outDir, { recursive: true });
    const res = await runReport({
      format: 'both',
      out: outDir,
      tz: 'UTC',
      stdout: false,
      roots,
      now: '2026-06-06T00:00:00Z',
      offline: true,
    });
    expect(res.jsonPath).toBe(join(outDir, 'usage-report.json'));
    expect(res.htmlPath).toBe(join(outDir, 'report.html'));
    expect(existsSync(res.jsonPath!)).toBe(true);
    expect(existsSync(res.htmlPath!)).toBe(true);
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.generator).toBe('sessions');
    expect(report.version).toBe(1);
    expect(report.weeklyHighlights).toBeUndefined();
    expect(report.summary.totalTokens).toBe(1700);
    expect(readFileSync(res.htmlPath!, 'utf8').startsWith('<!DOCTYPE html>')).toBe(true);
  });

  test('period reflects the requested range, and out-of-range events are excluded', async () => {
    const out = join(tmp, 'may.json');
    // The only fixture event is 2026-06-01, so a May window yields an empty report.
    const res = await runReport({
      format: 'json',
      out,
      tz: 'UTC',
      stdout: false,
      roots,
      now: '2026-06-06T00:00:00Z',
      from: '2026-05-01',
      to: '2026-05-31',
      offline: true,
    });
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.period).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(report.summary.sessions).toBe(0);
    expect(report.summary.totalTokens).toBe(0);
  });

  const hereOpts = {
    format: 'json' as const,
    tz: 'UTC',
    stdout: false,
    roots: hereRoots,
    now: '2026-06-06T00:00:00Z',
    here: true,
    offline: true,
  };

  test('--here keeps only events from the cwd project, dropping other and unknown projects', async () => {
    const out = join(tmp, 'here-sessions.json');
    const res = await runReport({ ...hereOpts, out, cwd: '/Users/x/Developer/sessions' });
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.summary.sessions).toBe(1);
    expect(report.summary.totalTokens).toBe(1500);
  });

  test('--here matches by project name from any cwd path resolving to it', async () => {
    const out = join(tmp, 'here-other.json');
    // A subdirectory cwd still resolves to the repo name.
    const res = await runReport({ ...hereOpts, out, cwd: '/Users/x/Developer/otherproj/src/deep' });
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.summary.sessions).toBe(1);
    expect(report.summary.totalTokens).toBe(150);
  });

  test('without --here all projects are included', async () => {
    const out = join(tmp, 'here-off.json');
    const res = await runReport({ ...hereOpts, here: false, out });
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.summary.sessions).toBe(3);
    expect(report.summary.totalTokens).toBe(1665);
  });
});
