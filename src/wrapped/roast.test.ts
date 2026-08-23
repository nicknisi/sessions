import { describe, test, expect } from 'bun:test';
import { buildRoastPrompt, extractJsonArray, runRoast, detectRoastTool } from './roast.ts';
import type { WrappedData } from './types.ts';

const data = {
  generator: 'sessions',
  version: 1,
  generatedAt: '2026-07-13T12:00:00Z',
  year: 2026,
  period: { from: '2026-01-01', to: '2026-07-13' },
  dataBegins: '2026-01-09',
  tz: 'UTC',
  warnings: [],
  totals: {
    tokens: 656_000_000,
    cacheReadTokens: 1_000_000,
    costUSD: 13_427,
    sessions: 2288,
    messages: 134_056,
    activeDays: 163,
    longestStreak: { days: 54, from: '2026-03-02', to: '2026-04-24' },
  },
  rhythm: { heat: [], peakHour: 10, peakWeekday: 4, nightsPastMidnight: 13, latestNight: null },
  daily: [],
  biggestDay: null,
  projects: [{ name: 'cli', tokens: 1, costUSD: 1, sessions: 1, share: 0.24 }],
  models: [
    {
      id: 'claude-opus-4-8',
      label: 'claude-opus-4-8',
      messages: 1,
      tokens: 1,
      share: 1,
      firstSeen: '2026-05-28',
      firstTopDay: '2026-05-28',
    },
  ],
  tools: [],
  cacheHitRate: 0.99,
  longestSession: null,
  sessionOfYear: {
    title: 'secret internal prompt text',
    project: 'cli',
    date: '2026-06-25',
    messageCount: 4384,
    filesTouched: 50,
    shipped: true,
  },
  content: {
    indexedSessions: 3939,
    phrases: [{ id: 'interrupts', count: 524, role: 'user' }],
    monologue: null,
    driveBys: { count: 2047, total: 3935 },
    abandoned: { name: 'ClaudeProbe', sessions: 990, lastSeen: '2026-03-07' },
    errors: { sessionsErrored: 1, totalErrors: 5571, cursedWeekday: 2, cursedCount: 2038 },
    topFiles: [],
    topCommands: [{ name: 'git diff', sessions: 365 }],
    words: [],
    depthMedian: 93,
  },
  fun: [],
  wordOfYear: { word: 'workos', count: 7516, sessions: 1038, runnersUp: [] },
  persona: {
    name: 'The Systems Gardener',
    tagline: 't',
    axes: [{ label: 'clock', value: '6%', lean: 'daylight' }],
    flavor: null,
  },
  extras: [],
  longestGap: null,
  modelsTried: 1,
  loops: null,
} satisfies WrappedData;

describe('buildRoastPrompt', () => {
  test('includes stats but never raw transcript text', () => {
    const p = buildRoastPrompt(data);
    expect(p).toContain('656000000'); // tokens
    expect(p).toContain('workos'); // word of the year (aggregate)
    expect(p).toContain('JSON array'); // schema instruction
    // Headlines render as full-screen type — the prompt must demand brevity.
    expect(p).toContain('<=80 chars');
    // The session-of-the-year *title* is free text — it must not be sent.
    expect(p).not.toContain('secret internal prompt text');
  });
});

describe('extractJsonArray', () => {
  test('pulls an array out of prose', () => {
    expect(extractJsonArray('Sure! Here you go:\n[{"headline":"hi"}]\nEnjoy')).toEqual([{ headline: 'hi' }]);
  });
  test('handles a ```json fence', () => {
    expect(extractJsonArray('```json\n[{"headline":"hi"}]\n```')).toEqual([{ headline: 'hi' }]);
  });
  test('returns null on garbage', () => {
    expect(extractJsonArray('no json here')).toBeNull();
    expect(extractJsonArray('[not valid')).toBeNull();
  });
});

describe('runRoast', () => {
  const runner = (out: string) => async () => out;

  test('validates model output and stamps provenance on every slide', async () => {
    const slides = await runRoast(data, {
      preferred: 'claude',
      runner: runner(
        '[{"title":"ouch","headline":"$13,427 and you still say please","footnote":"model tried to lie here"}]',
      ),
      log: () => {},
    });
    expect(slides).toHaveLength(1);
    expect(slides[0]!.headline).toContain('$13,427');
    // The model's own footnote is overridden — provenance is guaranteed.
    expect(slides[0]!.footnote).toBe('improvised by Claude from your stats');
  });

  test('fails open on unparseable output', async () => {
    const warnings: string[] = [];
    const slides = await runRoast(data, {
      preferred: 'claude',
      runner: runner('I refuse'),
      log: (m) => warnings.push(m),
    });
    expect(slides).toEqual([]);
    expect(warnings.some((w) => w.includes('nothing usable'))).toBe(true);
  });

  test('fails open when the runner throws', async () => {
    const slides = await runRoast(data, {
      preferred: 'claude',
      runner: async () => {
        throw new Error('spawn failed');
      },
      log: () => {},
    });
    expect(slides).toEqual([]);
  });

  test('caps at the shared 6-slide limit', async () => {
    const many = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ headline: `roast ${i}` })));
    const slides = await runRoast(data, { preferred: 'claude', runner: runner(many), log: () => {} });
    expect(slides).toHaveLength(6);
  });
});

describe('detectRoastTool', () => {
  test('preferred tool that is not installed yields null, not a fallback', () => {
    // 'pi' is very unlikely to be on the test PATH; a preferred-but-absent tool
    // must not silently fall back to claude/codex.
    const tool = detectRoastTool('pi');
    if (tool) expect(tool.id).toBe('pi');
  });
});
