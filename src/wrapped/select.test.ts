import { describe, test, expect } from 'bun:test';
import { buildCandidates, selectFunCards, selectPersona, selectWordOfYear } from './select.ts';
import { costEquivalence, heroClass, prettyModel } from './html.ts';
import { cleanTitle, commandFamily, mineWords } from './content.ts';
import type { WrappedContentStats, WrappedRhythm } from './types.ts';
import type { WrappedEventStats } from './compute.ts';

const quietRhythm: WrappedRhythm = {
  heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
  peakHour: 10,
  peakWeekday: 2,
  nightsPastMidnight: 0,
  latestNight: null,
};

function contentWith(phrases: Record<string, number>, over: Partial<WrappedContentStats> = {}): WrappedContentStats {
  return {
    indexedSessions: 100,
    phrases: Object.entries(phrases).map(([id, count]) => ({
      id,
      count,
      role: id === 'absolutelyRight' || id === 'assistantApology' ? 'assistant' : 'user',
    })),
    monologue: null,
    driveBys: null,
    abandoned: null,
    errors: null,
    topFiles: [],
    topCommands: [],
    words: [],
    depthMedian: 50,
    ...over,
  };
}

function eventsWith(over: Partial<WrappedEventStats> = {}): WrappedEventStats {
  return {
    distinctSessions: 100,
    rhythm: quietRhythm,
    cacheReadTokens: 0,
    cacheHitRate: null,
    longestSession: null,
    medianReplies: 10,
    sessionsByTool: new Map(),
    sessionsByProject: new Map(),
    modelFirsts: new Map(),
    nightShare: 0.05,
    ...over,
  };
}

describe('dynamic selection', () => {
  test('no content and a quiet rhythm → no fun cards at all', () => {
    expect(selectFunCards(null, quietRhythm)).toEqual([]);
  });

  test('zero-count stats never render as filler', () => {
    const content = contentWith({ interrupts: 0, actually: 0, swears: 0, please: 0, thanks: 0 });
    const cards = selectFunCards(content, quietRhythm);
    // Only the "absolutely right" zero-joke is allowed to exist, and at score
    // 0.45 it stays below the 0.4-lead… no: 0.45 ≥ 0.4, it may lead a card.
    for (const card of cards) {
      for (const stat of card.stats) {
        if (stat.big === '0') expect(stat.label).toContain('absolutely right');
      }
    }
  });

  test('a night owl gets the night slide; a daylight coder never does', () => {
    const nightRhythm: WrappedRhythm = {
      ...quietRhythm,
      nightsPastMidnight: 40,
      latestNight: { date: '2026-03-03', clock: '3:47 AM', weekday: 3 },
    };
    const owl = buildCandidates(null, nightRhythm);
    expect(owl.some((c) => c.stat.label.includes('past midnight'))).toBe(true);
    const daylight = buildCandidates(null, quietRhythm);
    expect(daylight.some((c) => c.stat.label.includes('past midnight'))).toBe(false);
  });

  test('bigger behavior scores higher', () => {
    const mild = buildCandidates(contentWith({ interrupts: 10 }), quietRhythm);
    const wild = buildCandidates(contentWith({ interrupts: 500 }), quietRhythm);
    const score = (cs: ReturnType<typeof buildCandidates>) =>
      cs.find((c) => c.stat.label.includes('cut Claude off'))!.score;
    expect(score(wild)).toBeGreaterThan(score(mild));
  });

  test('the lies card assembles from famous last words', () => {
    const cards = selectFunCards(contentWith({ quickQuestion: 40, shouldWork: 120, oneMoreThing: 25 }), quietRhythm);
    const lies = cards.find((c) => c.id === 'lies');
    expect(lies).toBeDefined();
    expect(lies!.kicker).toBe('famous last words');
    expect(lies!.stats).toHaveLength(3);
    expect(lies!.stats[0]!.label).toContain('should work');
    expect(lies!.stats.some((s) => s.label.includes('quick'))).toBe(true);
  });

  test('the H-word is notable at low counts, but never at one', () => {
    const cs = buildCandidates(contentWith({ hallucinate: 3 }), quietRhythm);
    expect(cs.some((c) => c.stat.label.includes('hallucinate'))).toBe(true);
    const none = buildCandidates(contentWith({ hallucinate: 1 }), quietRhythm);
    expect(none.some((c) => c.stat.label.includes('hallucinate'))).toBe(false);
  });

  test('a manifesto-length message becomes a blooper; a normal one never does', () => {
    const manifesto = contentWith({}, { monologue: { userAvg: 300, assistantAvg: 900, longestUser: 15_000 } });
    expect(buildCandidates(manifesto, quietRhythm).some((c) => c.stat.label.includes('longest single message'))).toBe(
      true,
    );
    const modest = contentWith({}, { monologue: { userAvg: 300, assistantAvg: 900, longestUser: 500 } });
    expect(buildCandidates(modest, quietRhythm).some((c) => c.stat.label.includes('longest single message'))).toBe(
      false,
    );
  });

  test('weekend warriors get called out; weekday coders never do', () => {
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    heat[6]![14] = 120; // Saturday afternoon
    heat[0]![10] = 40; // Sunday morning
    heat[2]![10] = 240; // Tuesday
    const cs = buildCandidates(null, { ...quietRhythm, heat });
    const weekend = cs.find((c) => c.stat.label.includes('weekend'));
    expect(weekend?.stat.big).toBe('40%');
    expect(buildCandidates(null, quietRhythm).some((c) => c.stat.label.includes('weekend'))).toBe(false);
  });

  test('headline extras add savage stats only when passed and above threshold', () => {
    const withExtras = buildCandidates(null, quietRhythm, {
      costUSD: 14000,
      activeDays: 167,
      modelsTried: 17,
      cacheHitRate: 0.94,
    });
    expect(withExtras.find((c) => c.stat.label.includes('per active day'))?.stat.big).toBe('$84');
    expect(withExtras.find((c) => c.stat.label.includes('models you kept in rotation'))?.stat.big).toBe('17');
    expect(withExtras.find((c) => c.stat.label.includes('re-reading context'))?.stat.big).toBe('94%');
    // Without extras, none of these appear.
    const none = buildCandidates(null, quietRhythm);
    expect(none.some((c) => c.stat.label.includes('per active day'))).toBe(false);
    // Below thresholds: free/local year (no cost), few models, low cache → nothing.
    const quiet = buildCandidates(null, quietRhythm, {
      costUSD: 0,
      activeDays: 3,
      modelsTried: 2,
      cacheHitRate: 0.1,
    });
    expect(quiet.some((c) => ['per active day', 'rotation', 're-reading'].some((t) => c.stat.label.includes(t)))).toBe(
      false,
    );
  });

  test('apology scoreboard flips its punchline from the data', () => {
    const humanSorry = buildCandidates(contentWith({ userSorry: 20, assistantApology: 5 }), quietRhythm);
    const sb = humanSorry.find((c) => c.stat.label.includes('apology scoreboard'))!;
    expect(sb.stat.sub).toContain('you apologized to the robot');
    const aiSorry = buildCandidates(contentWith({ userSorry: 2, assistantApology: 20 }), quietRhythm);
    const sb2 = aiSorry.find((c) => c.stat.label.includes('apology scoreboard'))!;
    expect(sb2.stat.sub).not.toContain('you apologized to the robot');
  });
});

describe('selectWordOfYear', () => {
  test('requires spread, not just volume', () => {
    expect(selectWordOfYear(contentWith({}, { words: [{ word: 'gnarly', count: 100, sessions: 3 }] }))).toBeNull();
    const w = selectWordOfYear(
      contentWith(
        {},
        {
          words: [
            { word: 'gnarly', count: 100, sessions: 30 },
            { word: 'vibes', count: 40, sessions: 12 },
          ],
        },
      ),
    );
    expect(w?.word).toBe('gnarly');
    expect(w?.runnersUp).toEqual(['vibes']);
  });
});

describe('selectPersona', () => {
  test('too little behavior → no persona rather than a fake one', () => {
    expect(selectPersona(eventsWith({ distinctSessions: 5 }), 0.5, null)).toBeNull();
  });

  test('axes combine into the right archetype', () => {
    const p = selectPersona(eventsWith({ nightShare: 0.4 }), 0.6, contentWith({}, { depthMedian: 90 }));
    expect(p?.name).toBe('The Midnight Machinist');
    const q = selectPersona(eventsWith({ nightShare: 0.02 }), 0.1, contentWith({}, { depthMedian: 5 }));
    expect(q?.name).toBe('The Rapid Prototyper');
  });

  test('evidence values are printed on the card', () => {
    const p = selectPersona(eventsWith({ nightShare: 0.31 }), 0.42, contentWith({}, { depthMedian: 93 }));
    expect(p?.axes.map((a) => a.value)).toEqual(['31% after dark', '42% one project', '93 messages per real session']);
  });
});

describe('display helpers', () => {
  test('costEquivalence scales the bill to street prices', () => {
    expect(costEquivalence(5)).toBeNull();
    expect(costEquivalence(60)).toContain('oat-milk lattes');
    expect(costEquivalence(600)).toContain('AirPods');
    expect(costEquivalence(13_427)).toContain('MacBook Airs');
  });

  test('heroClass steps the type ramp down as text grows', () => {
    expect(heroClass('1,024')).toBe('big');
    expect(heroClass('1,024', 'word')).toBe('big bigword'); // roast text never gets the numeral ramp
    expect(heroClass('an-abandoned-project-name')).toBe('big bigword');
    expect(heroClass('x'.repeat(60), 'word')).toBe('big midword');
    expect(heroClass('x'.repeat(100), 'word')).toBe('big punchline');
  });

  test('prettyModel prettifies known families and leaves the rest alone', () => {
    expect(prettyModel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('claude-fable-5')).toBe('Fable 5');
    expect(prettyModel('gpt-5.5-codex')).toBe('GPT-5.5-codex');
    expect(prettyModel('mystery-model-9')).toBe('mystery-model-9');
    // A date suffix is not a minor version — never invent "Opus 4.20250514".
    expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4');
    expect(prettyModel('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    // Context-window / tier suffixes and provider prefixes are stripped before matching,
    // and collapse to the same canonical name so snapshot variants merge.
    expect(prettyModel('claude-opus-4-8[1m]')).toBe('Opus 4.8');
    expect(prettyModel('claude-opus-4-8:thinking')).toBe('Opus 4.8');
    expect(prettyModel('claude-opus-4-8[1m]:thinking')).toBe('Opus 4.8'); // both suffixes, any order
    expect(prettyModel('anthropic/claude-opus-4-8')).toBe('Opus 4.8');
    expect(prettyModel('openai/gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(prettyModel('claude-opus-4-5-20251101')).toBe(prettyModel('claude-opus-4-5'));
  });

  test('cleanTitle strips markdown noise and truncates', () => {
    expect(cleanTitle('Read this: # Workflow: **Status:** ✅ done')).toBe('Read this: Workflow: Status: done');
    expect(cleanTitle('x'.repeat(200)).length).toBeLessThanOrEqual(73);
    expect(cleanTitle('   ')).toBe('untitled');
  });

  test('commandFamily groups by first two meaningful tokens', () => {
    expect(commandFamily('git status -sb')).toBe('git status');
    expect(commandFamily('git -C /tmp status')).toBe('git');
    expect(commandFamily('bun test')).toBe('bun test');
    expect(commandFamily('ls')).toBe('ls');
  });

  test('mineWords skips stopwords, code, and single-session obsessions', () => {
    const texts = [
      ...Array.from({ length: 12 }, (_, i) => ({ text: 'the gnarly function should work', file: `f${i}` })),
      { text: '```\ngnarlyinternal secret\n```', file: 'f0' },
      ...Array.from({ length: 15 }, () => ({ text: 'once more: gadget gadget', file: 'one-file' })),
    ];
    const words = mineWords(texts, 5);
    expect(words[0]?.word).toBe('gnarly');
    // "function"/"should"/"work" are stopworded; "gadget" is confined to one session.
    expect(words.some((w) => w.word === 'function')).toBe(false);
    expect(words.some((w) => w.word === 'gadget')).toBe(false);
  });
});
