// The share card is painted by JavaScript that lives in a template string, so
// neither tsc nor oxlint ever looks at it. This harness runs that string against
// a stub DOM and a recording 2D context: it catches the reference errors and
// layout overflows a type checker structurally cannot, and it asserts the two
// aspect ratios and the reroll actually change what gets drawn.

import { describe, expect, test } from 'bun:test';
import { renderWrappedHtml } from './html.ts';
import type { WrappedData } from './types.ts';

const DAILY = Array.from({ length: 40 }, (_, i) => ({
  date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
  tokens: 1_000_000 * (i + 1),
  messages: 10 * (i + 1),
})).sort((a, b) => a.date.localeCompare(b.date));

const DATA: WrappedData = {
  generator: 'sessions',
  version: 1,
  generatedAt: '2026-12-31T12:00:00Z',
  year: 2026,
  period: { from: '2026-01-01', to: '2026-12-31' },
  dataBegins: null,
  tz: 'UTC',
  warnings: [],
  totals: {
    tokens: 1_200_000_000,
    cacheReadTokens: 400_000_000,
    costUSD: 4312.88,
    sessions: 2903,
    messages: 51_204,
    activeDays: 180,
    longestStreak: { days: 54, from: '2026-03-01', to: '2026-04-23' },
  },
  rhythm: {
    heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 3)),
    peakHour: 23,
    peakWeekday: 2,
    nightsPastMidnight: 40,
    latestNight: null,
  },
  daily: DAILY,
  biggestDay: { ...DAILY[10]!, medianTokens: 500_000, medianMessages: 20 },
  longestGap: null,
  projects: [{ name: 'sessions', tokens: 900_000_000, costUSD: 3000, sessions: 1800, share: 0.75 }],
  models: [],
  modelsTried: 3,
  tools: [],
  cacheHitRate: 0.82,
  longestSession: null,
  loops: null,
  sessionOfYear: null,
  content: null,
  fun: [],
  wordOfYear: null,
  // Deliberately long, to exercise the hero shrink and the tagline wrap.
  persona: {
    name: 'The Nocturnal Refactorer',
    tagline: 'You do your best thinking when everyone else has gone to bed, and it shows in the diffs.',
    axes: [{ label: 'CLOCK', value: '31% after dark', lean: 'night' }],
    flavor: null,
  },
  extras: [],
};

interface Painted {
  text: string;
  x: number;
  y: number;
  size: number;
}

/** A 2D context that records instead of rasterizing. `measureText` models a
 *  half-em average advance, which is close enough that wrap and shrink converge
 *  the same way they would on a real face. */
function makeCtx(): { ctx: Record<string, unknown>; painted: Painted[] } {
  const painted: Painted[] = [];
  const state = {
    font: '400 16px sans-serif',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    letterSpacing: '0px',
    textBaseline: '',
  };
  const size = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 16);
  const ctx = {
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get letterSpacing() {
      return state.letterSpacing;
    },
    set letterSpacing(v: string) {
      state.letterSpacing = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: string) {
      state.textBaseline = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    setTransform: () => {},
    fillRect: () => {},
    beginPath: () => {},
    fill: () => {},
    stroke: () => {},
    roundRect: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    measureText: (t: string) => ({ width: t.length * size() * 0.5 }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillText: (text: string, x: number, y: number) => {
      painted.push({ text, x, y, size: size() });
    },
    // The decoration layer strokes rather than fills, so it stays out of the
    // painted log the layout assertions run against.
    strokeText: () => {},
  };
  return { ctx, painted };
}

class StubEl {
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  attrs: Record<string, string> = {};
  props: Record<string, string> = {};
  style = { setProperty: (k: string, v: string) => (this.props[k] = v) };
  textContent = '';
  width = 0;
  height = 0;
  classNames = new Set<string>();
  ctx: Record<string, unknown> | null = null;
  classList = {
    add: (c: string) => this.classNames.add(c),
    remove: (c: string) => this.classNames.delete(c),
    toggle: (c: string, on?: boolean) => (on ? this.classNames.add(c) : this.classNames.delete(c)),
    contains: (c: string) => this.classNames.has(c),
  };
  addEventListener(ev: string, fn: (e: unknown) => void): void {
    (this.listeners[ev] ??= []).push(fn);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getContext(): Record<string, unknown> | null {
    return this.ctx;
  }
  toDataURL(): string {
    return 'data:image/png;base64,';
  }
  querySelectorAll(): StubEl[] {
    return [];
  }
  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn({ target: this });
  }
}

function runPage(data: WrappedData): {
  painted: Painted[];
  canvas: StubEl;
  byId: Map<string, StubEl>;
  seg: StubEl[];
  swatches: StubEl[];
  slide: StubEl;
} {
  const html = renderWrappedHtml(data);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!script) throw new Error('no inline script found in the wrapped page');
  const cardJson = /<script type="application\/json" id="wcard-data">([\s\S]*?)<\/script>/.exec(html);
  if (!cardJson) throw new Error('no share-card data found in the wrapped page');

  const { ctx, painted } = makeCtx();
  const byId = new Map<string, StubEl>();
  const mk = (id: string): StubEl => {
    const el = new StubEl();
    byId.set(id, el);
    return el;
  };
  const canvas = mk('wcard');
  canvas.ctx = ctx;
  mk('wcard-data').textContent = cardJson[1]!;
  mk('tip');
  mk('wc-flash');
  for (const id of ['wc-png', 'wc-img', 'wc-txt', 'wc-eq']) mk(id);

  const slide = mk('share');

  const seg = ['wide', 'story'].map((a) => {
    const el = new StubEl();
    el.attrs['data-aspect'] = a;
    return el;
  });
  seg[0]!.classNames.add('on');

  const swatches = Array.from({ length: 6 }, (_, i) => {
    const el = new StubEl();
    el.attrs['data-acc'] = String(i);
    return el;
  });

  const doc = {
    documentElement: new StubEl(),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (sel: string) => (sel === '.seg button' ? seg : sel === '.swatches .sw' ? swatches : []),
    addEventListener: () => {},
    // A promise that never settles: the painter re-draws on fonts.ready, and a
    // resolved one would land after the test body and double the paint log.
    fonts: { ready: new Promise<void>(() => {}) },
  };
  const win = {
    matchMedia: () => ({ matches: false }),
    IntersectionObserver: class {
      observe(): void {}
    },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { log: () => {} },
  };

  const fn = new Function(
    'document',
    'window',
    'IntersectionObserver',
    'requestAnimationFrame',
    'setTimeout',
    'clearTimeout',
    'console',
    'navigator',
    script[1]!,
  );
  fn(doc, win, win.IntersectionObserver, win.requestAnimationFrame, win.setTimeout, win.clearTimeout, win.console, {});
  return { painted, canvas, byId, seg, swatches, slide };
}

describe('wrapped share card', () => {
  test('paints the payoff without throwing', () => {
    const { painted } = runPage(DATA);
    const all = painted.map((p) => p.text).join(' | ');
    expect(all).toContain('SESSIONS WRAPPED');
    expect(all).toContain('2026');
    expect(all).toContain('The Nocturnal Refactorer');
    expect(all).toContain('2,903');
    expect(all).toContain('SESSIONS');
    expect(all).toContain('$4,313');
    expect(all).toContain('54');
    expect(all).toContain('no telemetry');
  });

  test('opens at 1200 × 630 and switches to the story aspect', () => {
    const { canvas, seg, painted } = runPage(DATA);
    // Backing store is 2x for retina, so the CSS sizes double.
    expect([canvas.width, canvas.height]).toEqual([2400, 1260]);
    const wide = painted.length;
    seg[1]!.click();
    expect([canvas.width, canvas.height]).toEqual([2160, 3840]);
    expect(painted.length).toBeGreaterThan(wide);
    expect(seg[1]!.classNames.has('on')).toBe(true);
    expect(seg[0]!.classNames.has('on')).toBe(false);
  });

  test('keeps every painted line inside the column at both aspects', () => {
    for (const [story, W, pad] of [
      [false, 1200, 64],
      [true, 1080, 80],
    ] as const) {
      const { painted, seg } = runPage(DATA);
      let drawn = painted;
      if (story) {
        const n = painted.length;
        seg[1]!.click();
        drawn = painted.slice(n);
      }
      for (const p of drawn) {
        expect(p.x).toBeGreaterThanOrEqual(pad - 1);
        expect(p.x + p.text.length * p.size * 0.5).toBeLessThanOrEqual(W - pad + 1);
      }
    }
  });

  // The bug the first render shipped with: the stack was taller than the card,
  // so the year strip ran under the footer and off the bottom edge.
  test('fits the whole stack between the chrome at both aspects', () => {
    for (const [story, H, pad] of [
      [false, 630, 64],
      [true, 1920, 80],
    ] as const) {
      const { painted, seg } = runPage(DATA);
      let drawn = painted;
      if (story) {
        const n = painted.length;
        seg[1]!.click();
        drawn = painted.slice(n);
      }
      for (const p of drawn) {
        expect(p.y).toBeGreaterThan(pad);
        expect(p.y).toBeLessThanOrEqual(H - pad);
      }
    }
  });

  test('reroll swaps the comparison line for a different one', () => {
    const { painted, byId } = runPage(DATA);
    const isComparison = (t: string): boolean =>
      t.startsWith('That’s') || t.includes('years of') || t.includes('reads');
    const before = painted.filter((p) => isComparison(p.text)).map((p) => p.text);
    expect(before.length).toBeGreaterThan(0);
    const n = painted.length;
    byId.get('wc-eq')!.click();
    const after = painted
      .slice(n)
      .filter((p) => isComparison(p.text))
      .map((p) => p.text);
    expect(after.length).toBeGreaterThan(0);
    expect(after.join(' ')).not.toBe(before.join(' '));
  });

  test('a persona-less year leads with the biggest honest number', () => {
    const { painted } = runPage({ ...DATA, persona: null });
    const all = painted.map((p) => p.text).join(' | ');
    expect(all).toContain('1.20B');
    expect(all).toContain('YOUR 2026 IN REVIEW');
  });

  test('a local-model year shows replies instead of a $0 receipt', () => {
    const { painted } = runPage({
      ...DATA,
      totals: { ...DATA.totals, costUSD: 0, tokens: 0 },
    });
    const all = painted.map((p) => p.text).join(' | ');
    expect(all).toContain('REPLIES');
    expect(all).not.toContain('$0');
    expect(all).not.toContain('TOKENS');
  });

  test('the accent is pickable, not fixed to the deck rotation', () => {
    const { painted, swatches, slide } = runPage(DATA);
    const html = renderWrappedHtml(DATA);
    // Six swatches, exactly one preselected.
    expect((html.match(/class="sw[ "]/g) ?? []).length).toBe(6);
    expect((html.match(/class="sw on"/g) ?? []).length).toBe(1);
    // Picking one repaints the card and recolours the slide behind it.
    const n = painted.length;
    swatches[3]!.click();
    expect(painted.length).toBeGreaterThan(n);
    expect(slide.props['--a']).toBe('oklch(70% 0.17 262)');
    expect(swatches[3]!.classNames.has('on')).toBe(true);
  });

  test('an empty year has no share slide at all', () => {
    const html = renderWrappedHtml({
      ...DATA,
      totals: { ...DATA.totals, sessions: 0 },
    });
    // The painter's own lookup string lives in the inline script either way, so
    // this has to check for the data block itself.
    expect(html).not.toContain('id="wcard-data"');
    expect(html).not.toContain('class="card sharecard"');
  });
});
