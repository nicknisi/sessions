import { describe, test, expect } from 'bun:test';
import { aggregate } from './aggregate.ts';
import { renderHtml } from './html.ts';
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
const data = aggregate({
  events,
  prs: [],
  now: '2026-06-06T00:00:00Z',
  tz: 'UTC',
  exclude: new Set<string>(),
  priorDaily: [],
});

describe('renderHtml', () => {
  test('produces a self-contained document with expected anchors', () => {
    const html = renderHtml(toUsageReport(data));
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('AI Usage Report');
    expect(html).toContain('<svg');
    expect(html).toContain('Total cost');
    expect(html).toContain('sessions usage report');
    // prominent period badge with human-formatted dates
    expect(html).toContain('class="period"');
    expect(html).toContain('Jun 1, 2026');
    expect(html).toContain('Jun 6, 2026');
    // self-contained: no external resource references
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    // safe DOM: no innerHTML usage in the inline script
    expect(html).not.toContain('innerHTML');
  });
});
