import { describe, test, expect } from 'bun:test';
import { aggregate } from './aggregate.ts';
import { renderHtml } from './html.ts';
import { toUsageReport } from './schema.ts';
import { computeFacets } from './facets.ts';
import type { UsageEvent } from './parsers/types.ts';

const events: UsageEvent[] = [
  {
    tool: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    timestamp: '2026-06-01T14:30:00Z',
    sessionId: 's1',
    projectPath: '/Users/x/Developer/sessions',
    branch: 'feat/thing',
    tokens: { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 200 },
  },
  {
    tool: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    timestamp: '2026-06-01T15:00:00Z',
    sessionId: 's1',
    projectPath: '/Users/x/Developer/sessions',
    branch: 'feat/thing',
    agent: { id: 'a1', type: 'Explore' },
    tokens: { input: 400, output: 900, cacheRead: 5000, cacheWrite: 50 },
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
    const html = renderHtml(toUsageReport(data, computeFacets(events, 'UTC')));
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

  test('renders the facet sections', () => {
    const html = renderHtml(toUsageReport(data, computeFacets(events, 'UTC')));
    expect(html).toContain('cache hit rate');
    expect(html).toContain('Subagents');
    expect(html).toContain('Explore');
    expect(html).toContain('By branch');
    expect(html).toContain('feat/thing');
  });

  test('omits the subagent section when nothing was dispatched', () => {
    const solo = events.slice(0, 1);
    const html = renderHtml(
      toUsageReport(
        aggregate({
          events: solo,
          prs: [],
          now: '2026-06-06T00:00:00Z',
          tz: 'UTC',
          exclude: new Set<string>(),
          priorDaily: [],
        }),
        computeFacets(solo, 'UTC'),
      ),
    );
    expect(html).not.toContain('Subagents');
    // the cache strip is unconditional — it describes volume, not an event class
    expect(html).toContain('cache hit rate');
  });
});
