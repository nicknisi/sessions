import { describe, test, expect } from 'bun:test';
import { aggregate } from './aggregate.ts';
import { renderHtml, palette } from './html.ts';
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

const render = () => renderHtml(toUsageReport(data, computeFacets(events, 'UTC')));

describe('renderHtml', () => {
  test('produces a document with expected anchors', () => {
    const html = render();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('AI Usage Report');
    expect(html).toContain('<svg');
    expect(html).toContain('Total cost');
    expect(html).toContain('sessions usage report');
    // prominent period badge with human-formatted dates
    expect(html).toContain('class="period"');
    expect(html).toContain('Jun 1, 2026');
    expect(html).toContain('Jun 6, 2026');
    // safe DOM: no innerHTML usage in the inline scripts
    expect(html).not.toContain('innerHTML');
  });

  // The report is one file with no build step behind it. The two font hosts are
  // the only exception, and they are a progressive enhancement: with them
  // unreachable the stack falls back to the system faces. Anything else — an
  // image, a script, a stylesheet, an analytics beacon — would make the document
  // depend on a network it promises not to touch.
  test('references no external resource except the font stylesheet', () => {
    const html = render();
    const urls = html.match(/https?:\/\/[^"' )]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  test('renders the facet sections', () => {
    const html = render();
    expect(html).toContain('cache hit rate');
    expect(html).toContain('>Subagent share</span>');
    expect(html).toContain('Explore');
    expect(html).toContain('Biggest sessions');
    expect(html).toContain('feat/thing');
  });

  test('renders the narrative, rate card, and rhythm sections', () => {
    const html = render();
    expect(html).toContain('>The short version</span>');
    expect(html).toContain('days of records');
    expect(html).toContain('>The rate card</span>');
    expect(html).toContain('per message');
    expect(html).toContain('>Rhythm</span>');
    expect(html).toContain('class="heat"');
  });

  // The volume tile compares the token total to something human. These events
  // total ~3k tokens, which is smaller than every unit in the pool, so the tile
  // drops instead of claiming "0 copies" of anything.
  test('omits the volume comparison when the total is too small to compare', () => {
    expect(render()).not.toContain('roughly 0.75 words per token');
  });

  test('renders a volume comparison once there is real volume', () => {
    const big = events.map((e) => ({
      ...e,
      tokens: { input: 40_000_000, output: 20_000_000, cacheRead: 0, cacheWrite: 0 },
    }));
    const html = renderHtml(
      toUsageReport(
        aggregate({ events: big, prs: [], now: '2026-06-06T00:00:00Z', tz: 'UTC', exclude: new Set(), priorDaily: [] }),
        computeFacets(big, 'UTC'),
      ),
    );
    expect(html).toContain('roughly 0.75 words per token');
    // Whichever unit the seed lands on, the card offers the rest for rerolling.
    expect(html).toContain('"equivalents"');
    expect(html).toContain('Another comparison');
  });

  test('every stat cell and section heading explains itself on hover', () => {
    const html = render();
    // No stat cell ships without a definition.
    const cells = html.match(/<div class="cell"[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain('data-tip=');
    // Nor any rate tile.
    const rates = html.match(/<div class="rate"[^>]*>/g) ?? [];
    expect(rates.length).toBeGreaterThan(0);
    for (const r of rates) expect(r).toContain('data-tip=');
    // Nor any section heading.
    const headings = html.match(/<h2>.*?<\/h2>/g) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h).toContain('data-tip=');
    // Definitions are prose. A double quote inside one would close the attribute
    // early, so they must arrive escaped: what follows the closing quote can only
    // be another attribute, the end of the tag, or a self-closing slash.
    expect(html).not.toMatch(/data-tip="[^"]*"[^\s>/]/);
  });

  test('the total-cost figure says what it is an estimate of', () => {
    const html = render();
    expect(html).toContain('not what you were billed');
  });

  test('omits the subagent sections when nothing was dispatched', () => {
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
    // The section heading, not the word: the lede and the share card both name
    // subagents in prose when there are any.
    expect(html).not.toContain('>Subagent share</span>');
    expect(html).not.toContain('>Agent types</span>');
    // the cache card is unconditional — it describes volume, not an event class
    expect(html).toContain('cache hit rate');
  });
});

// The accent is picked in the browser, so the colours cannot be baked into the
// markup: every chart fill is a custom property, and the boot script rewrites
// them from a table computed here. These two tests pin that contract.
describe('accent palette', () => {
  test('the boot script ships a palette for every accent and both themes', () => {
    const html = render();
    for (const name of ['violet', 'cyan', 'magenta', 'mono']) {
      expect(html).toContain(`"${name}":{"dark":`);
    }
    expect(html).toContain('window.setAccentVars');
    // Applied before first paint, from the <head> script.
    expect(html.indexOf('window.setAccentVars(a,t)')).toBeLessThan(html.indexOf('<body>'));
  });

  test('chart fills are custom properties, never literal colours', () => {
    const html = render();
    const fills = html.match(/(?:fill|stroke)="(?!none|currentColor)[^"]+"/g) ?? [];
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f).toMatch(/var\(--/);
  });

  test('the mix and heat ramps stay on one hue', () => {
    // Rotating hues around the wheel would reintroduce the colours the accent was
    // chosen to avoid, so both ramps vary lightness and hold hue. Each anchor may
    // drift at most 18° from its accent. Entries below the chroma floor are the
    // neutral ends of the ramps, where a hue angle carries no colour at all.
    const CHROMA_FLOOR = 0.02;
    const parse = (c: string): { chroma: number; hue: number } | null => {
      const m = /^oklch\([\d.]+% ([\d.]+) (\d+)\)$/.exec(c);
      return m ? { chroma: Number(m[1]), hue: Number(m[2]) } : null;
    };
    for (const [name, base] of [
      ['violet', 288],
      ['cyan', 212],
      ['magenta', 348],
      ['mono', 265],
    ] as const) {
      for (const light of [true, false]) {
        const p = palette(name, light);
        for (const c of [...p.mix, ...p.heat]) {
          const parsed = parse(c);
          expect(parsed).not.toBeNull();
          if (parsed!.chroma < CHROMA_FLOOR) continue;
          const raw = Math.abs(parsed!.hue - base);
          expect(Math.min(raw, 360 - raw)).toBeLessThanOrEqual(18);
        }
      }
    }
  });
});
