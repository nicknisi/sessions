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

describe('parseReportArgs', () => {
  test('defaults', () => {
    const o = parseReportArgs([]);
    expect(o.format).toBe('both');
    expect(o.stdout).toBe(false);
  });
  test('parses flags', () => {
    const o = parseReportArgs(['--format', 'json', '--days', '7', '--tool', 'claude', '--tz', 'UTC', '--stdout']);
    expect(o.format).toBe('json');
    expect(o.days).toBe(7);
    expect(o.tool).toBe('claude-code');
    expect(o.tz).toBe('UTC');
    expect(o.stdout).toBe(true);
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
    });
    const report = JSON.parse(readFileSync(res.jsonPath!, 'utf8'));
    expect(report.period).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(report.summary.sessions).toBe(0);
    expect(report.summary.totalTokens).toBe(0);
  });
});
