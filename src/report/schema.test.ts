import { describe, test, expect } from 'bun:test';
import { aggregate } from './aggregate.ts';
import { toUsageReport } from './schema.ts';
import type { UsageEvent } from './parsers/types.ts';

const events: UsageEvent[] = [
  {
    tool: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    timestamp: '2026-06-01T14:30:00Z',
    sessionId: 's1',
    projectPath: '/Users/x/Developer/sessions',
    tokens: { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 200 },
  },
];
const report = toUsageReport(
  aggregate({ events, prs: [], now: '2026-06-06T00:00:00Z', tz: 'UTC', exclude: new Set<string>(), priorDaily: [] }),
);

describe('UsageReport contract', () => {
  test('owns its schema (generator + version, no tokenmaxing fields)', () => {
    expect(report.generator).toBe('sessions');
    expect(report.version).toBe(1);
    expect(report).not.toHaveProperty('weeklyHighlights');
    expect(report).not.toHaveProperty('schemaVersion');
  });

  test('has every top-level key', () => {
    for (const key of [
      'generator',
      'version',
      'generatedAt',
      'period',
      'summary',
      'byTool',
      'byProvider',
      'byModel',
      'byProject',
      'daily',
      'insights',
    ]) {
      expect(report).toHaveProperty(key);
    }
  });

  test('insights shape; weekly entries carry no PR fields', () => {
    expect(report.insights.hourCounts.length).toBe(24);
    expect(report.insights.weekdayCounts.length).toBe(7);
    expect(report.insights.weekly.length).toBeGreaterThan(0);
    const wk = report.insights.weekly[0]!;
    expect(wk).not.toHaveProperty('prsMerged');
    expect(wk).not.toHaveProperty('additions');
    expect(wk).not.toHaveProperty('deletions');
    expect(wk).toHaveProperty('tokens');
  });
});
