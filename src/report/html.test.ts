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
    expect(html).toContain('>Subagents</span>');
    expect(html).toContain('Explore');
    expect(html).toContain('Most expensive sessions');
    expect(html).toContain('feat/thing');
  });

  test('every stat cell and section heading explains itself on hover', () => {
    const html = renderHtml(toUsageReport(data, computeFacets(events, 'UTC')));
    // No stat cell ships without a definition.
    const cells = html.match(/<div class="cell"[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain('data-tip=');
    // Nor any section heading.
    const headings = html.match(/<h2>.*?<\/h2>/g) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h).toContain('data-tip=');
    // Definitions are prose. A double quote inside one would close the attribute
    // early, so they must arrive escaped.
    expect(html).not.toMatch(/data-tip="[^"]*"[^\s>]/);
  });

  test('the total-cost figure says what it is an estimate of', () => {
    const html = renderHtml(toUsageReport(data, computeFacets(events, 'UTC')));
    expect(html).toContain('not what you were billed');
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
    // The section heading, not the word: the session table has a Subagents column
    // header that renders either way.
    expect(html).not.toContain('>Subagents</span>');
    // the cache strip is unconditional — it describes volume, not an event class
    expect(html).toContain('cache hit rate');
  });
});
