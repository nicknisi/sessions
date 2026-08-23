// Dynamic slide selection — the mechanism that makes wrapped personal. Every
// fun stat is a scored candidate; only notable ones render, grouped into themed
// cards. A user who never codes at 3 AM never sees a 3 AM slide, and an empty
// index simply yields no fun cards — graceful degradation and personalization
// are the same mechanism.

import type { FunCard, FunStat, PhraseStat, WrappedContentStats, WrappedPersona, WrappedRhythm } from './types.ts';
import type { WrappedEventStats } from './compute.ts';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const fmtInt = (n: number): string => n.toLocaleString('en-US');
/** "1 reply" / "2 replies" — never "1 replies". */
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

interface Candidate {
  theme: 'friction' | 'relationship' | 'lies' | 'bloopers';
  score: number;
  stat: FunStat;
}

/** Headline totals the fun cards can mine for savage angles beyond the index. */
export interface FunExtras {
  costUSD: number;
  activeDays: number;
  modelsTried: number;
  cacheHitRate: number | null;
}

const fmtUSD = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

function phrase(phrases: PhraseStat[], id: string): number {
  return phrases.find((p) => p.id === id)?.count ?? 0;
}

/** Saturating notability: 0 at zero, ~0.63 at `mid`, →1 asymptotically. */
function sat(count: number, mid: number): number {
  return count <= 0 ? 0 : 1 - Math.exp(-count / mid);
}

export function buildCandidates(
  content: WrappedContentStats | null,
  rhythm: WrappedRhythm,
  extras?: FunExtras,
): Candidate[] {
  const out: Candidate[] = [];
  const p = content?.phrases ?? [];

  // — friction —
  const interrupts = phrase(p, 'interrupts');
  if (interrupts > 0) {
    out.push({
      theme: 'friction',
      score: 0.15 + 0.8 * sat(interrupts, 150),
      stat: {
        big: fmtInt(interrupts),
        label: 'times you cut Claude off mid-task',
        sub: 'it was mid-sentence. you hit Escape like it owed you money.',
      },
    });
  }
  if (content?.errors && content.errors.totalErrors > 0) {
    const e = content.errors;
    out.push({
      theme: 'friction',
      score: 0.1 + 0.75 * sat(e.totalErrors, 800),
      stat: {
        big: fmtInt(e.totalErrors),
        label: 'errors weathered together',
        sub:
          e.cursedWeekday !== null
            ? `${WEEKDAYS[e.cursedWeekday]} was your most cursed day (${fmtInt(e.cursedCount)} of them)`
            : undefined,
      },
    });
  }
  const actually = phrase(p, 'actually');
  if (actually >= 10) {
    const tryAgain = phrase(p, 'tryAgain');
    out.push({
      theme: 'friction',
      score: 0.1 + 0.7 * sat(actually, 200),
      stat: {
        // LIKE '%actually%' matches anywhere in the message, so the copy can't
        // claim position ("began with") — it's "contained an actually".
        big: fmtInt(actually),
        label: 'times you said "actually" and moved the goalposts',
        sub: tryAgain > 0 ? `plus ${fmtInt(tryAgain)} rounds of "try again," just to be sure` : undefined,
      },
    });
  }
  const noWait = phrase(p, 'noWait');
  if (noWait >= 3) {
    out.push({
      theme: 'friction',
      score: 0.2 + 0.6 * sat(noWait, 30),
      stat: {
        big: fmtInt(noWait),
        label: 'hard reverses mid-prompt — "no, wait—"',
        sub: 'you heard your own idea out loud and flinched',
      },
    });
  }
  const swears = phrase(p, 'swears');
  if (swears >= 5) {
    out.push({
      theme: 'friction',
      score: 0.2 + 0.6 * sat(swears, 60),
      stat: {
        big: fmtInt(swears),
        label: 'prompts contained… strong language',
        sub: 'we counted every one. the repo has feelings, you know.',
      },
    });
  }
  const stillBroken = phrase(p, 'stillBroken');
  if (stillBroken >= 3) {
    out.push({
      theme: 'friction',
      score: 0.2 + 0.65 * sat(stillBroken, 60),
      stat: {
        big: fmtInt(stillBroken),
        label: '“still broken” status reports filed',
        sub: 'same error, same fix, renewed optimism',
      },
    });
  }

  // — relationship —
  // Base score is deliberately high: this is the pre-validated crowd-pleaser
  // of the Claude-wrapped genre, and the joke works at any count — including 3.
  const absolutely = phrase(p, 'absolutelyRight');
  if (content) {
    out.push({
      theme: 'relationship',
      score: absolutely > 0 ? 0.62 + 0.33 * sat(absolutely, 40) : 0.45,
      stat:
        absolutely > 0
          ? {
              big: fmtInt(absolutely),
              label: 'times Claude said "you’re absolutely right"',
              sub: 'you were, presumably',
            }
          : { big: '0', label: 'times Claude said "you’re absolutely right"', sub: 'who’s training whom?' },
    });
  }
  const userSorry = phrase(p, 'userSorry');
  const aiSorry = phrase(p, 'assistantApology');
  if (userSorry + aiSorry >= 5) {
    const flip = userSorry > aiSorry;
    out.push({
      theme: 'relationship',
      score: 0.25 + 0.55 * sat(userSorry + aiSorry, 40) + (flip ? 0.1 : 0),
      stat: {
        big: `${fmtInt(userSorry)}–${fmtInt(aiSorry)}`,
        label: 'the apology scoreboard, you vs. Claude',
        sub: flip ? 'you apologized to the robot more than it apologized to you' : 'at least it knows when it’s wrong',
      },
    });
  }
  const please = phrase(p, 'please');
  const thanks = phrase(p, 'thanks');
  if (please + thanks >= 20) {
    out.push({
      theme: 'relationship',
      score: 0.2 + 0.5 * sat(please + thanks, 250),
      stat: {
        big: fmtInt(please),
        label: 'prompts said "please"',
        sub: `and ${fmtInt(thanks)} said thanks — hedging your bets for the uprising`,
      },
    });
  }
  if (content?.monologue && content.monologue.assistantAvg > 0) {
    const m = content.monologue;
    const youTalkMore = m.userAvg > m.assistantAvg;
    out.push({
      theme: 'relationship',
      score: 0.55,
      stat: {
        // Mean chars/message: the user's is dominated by pastes, not chattiness,
        // so the copy attributes length to pasting rather than claiming "chattier".
        big: `${fmtInt(m.userAvg)} vs ${fmtInt(m.assistantAvg)}`,
        label: 'characters per message — you vs. Claude',
        sub: youTalkMore
          ? 'you didn’t type that, you pasted it — and the average tattled'
          : 'Claude does love a thorough answer',
      },
    });
  }
  const areYouSure = phrase(p, 'areYouSure');
  if (areYouSure >= 3) {
    out.push({
      theme: 'relationship',
      score: 0.3 + 0.5 * sat(areYouSure, 25),
      stat: {
        big: fmtInt(areYouSure),
        label: 'times you asked “are you sure?”',
        sub: 'faith in the machine: repeatedly shaken',
      },
    });
  }
  const hallucinate = phrase(p, 'hallucinate');
  if (hallucinate >= 2) {
    out.push({
      theme: 'relationship',
      score: 0.4 + 0.45 * sat(hallucinate, 12),
      stat: {
        big: fmtInt(hallucinate),
        label: 'times you used the H-word — “hallucinate”',
        sub: 'it prefers the term “creative recall”',
      },
    });
  }
  const perfect = phrase(p, 'perfectExclaim');
  if (perfect >= 10) {
    out.push({
      theme: 'relationship',
      score: 0.2 + 0.5 * sat(perfect, 150),
      stat: {
        big: fmtInt(perfect),
        label: 'times Claude declared “Perfect!”',
        sub: 'we’ll be the judge of that',
      },
    });
  }

  // — lies (famous last words) —
  const quickQuestion = phrase(p, 'quickQuestion');
  if (quickQuestion >= 3) {
    out.push({
      theme: 'lies',
      score: 0.25 + 0.6 * sat(quickQuestion, 40),
      stat: {
        big: fmtInt(quickQuestion),
        label: 'prompts promised it would be quick',
        sub: 'narrator: it was not quick',
      },
    });
  }
  const shouldWork = phrase(p, 'shouldWork');
  if (shouldWork >= 5) {
    out.push({
      theme: 'lies',
      score: 0.2 + 0.6 * sat(shouldWork, 40),
      stat: {
        big: fmtInt(shouldWork),
        label: 'messages contained “should work”',
        sub: 'the four most cursed words in software',
      },
    });
  }
  const oneMore = phrase(p, 'oneMoreThing');
  if (oneMore >= 3) {
    out.push({
      theme: 'lies',
      score: 0.2 + 0.55 * sat(oneMore, 40),
      stat: {
        big: fmtInt(oneMore),
        label: 'rounds of “one more thing”',
        sub: 'it was never just one more thing',
      },
    });
  }

  // — bloopers —
  if (rhythm.nightsPastMidnight >= 5 && rhythm.latestNight) {
    out.push({
      theme: 'bloopers',
      score: 0.2 + 0.75 * sat(rhythm.nightsPastMidnight, 30),
      stat: {
        big: fmtInt(rhythm.nightsPastMidnight),
        label: 'nights you coded past midnight',
        sub: `latest clock-out: ${rhythm.latestNight.clock} on a ${WEEKDAYS[rhythm.latestNight.weekday]} — sleep is a suggestion`,
      },
    });
  }
  if (content?.driveBys && content.driveBys.count >= 20 && content.driveBys.count / content.driveBys.total >= 0.15) {
    out.push({
      theme: 'bloopers',
      score: 0.2 + 0.6 * sat(content.driveBys.count, 800),
      stat: {
        big: fmtInt(content.driveBys.count),
        label: 'drive-by sessions: one question, answer, gone',
        sub: 'the world’s most expensive search engine',
      },
    });
  }
  if (content?.abandoned) {
    out.push({
      theme: 'bloopers',
      score: 0.3 + 0.4 * sat(content.abandoned.sessions, 30),
      stat: {
        big: content.abandoned.name,
        label: `${fmtInt(content.abandoned.sessions)} sessions of love, then silence since ${content.abandoned.lastSeen}`,
        sub: 'paused, not dead. definitely paused.',
      },
    });
  }
  const ultrathink = phrase(p, 'ultrathink');
  if (ultrathink >= 3) {
    out.push({
      theme: 'bloopers',
      score: 0.45 + 0.4 * sat(ultrathink, 15),
      stat: { big: fmtInt(ultrathink), label: 'invocations of "ultrathink"', sub: 'it thought ultra hard' },
    });
  }
  if (content?.monologue && content.monologue.longestUser >= 2000) {
    out.push({
      theme: 'bloopers',
      score: 0.2 + 0.5 * sat(content.monologue.longestUser, 12_000),
      stat: {
        big: fmtInt(content.monologue.longestUser),
        label: 'characters in your longest single message',
        sub: 'that’s not a prompt, that’s a manifesto (pastes count)',
      },
    });
  }
  // Weekend share straight off the heatmap — column 0 is Sunday, 6 is Saturday.
  let weekendMsgs = 0;
  let totalMsgs = 0;
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const v = rhythm.heat[wd]?.[h] ?? 0;
      totalMsgs += v;
      if (wd === 0 || wd === 6) weekendMsgs += v;
    }
  }
  const weekendShare = totalMsgs > 0 ? weekendMsgs / totalMsgs : 0;
  if (totalMsgs >= 200 && weekendShare >= 0.2) {
    out.push({
      theme: 'bloopers',
      score: 0.15 + weekendShare,
      stat: {
        // heat counts assistant replies, not user-authored messages — don't claim
        // "you sent"; attribute to activity.
        big: `${Math.round(weekendShare * 100)}%`,
        label: 'of the year’s activity happened on a weekend',
        sub: 'the repo doesn’t know what a Saturday is',
      },
    });
  }

  // — headline-derived savagery (only when the totals are passed in) —
  if (extras) {
    // The daily burn rate — a running meter is scarier than one big total.
    if (extras.costUSD > 0 && extras.activeDays > 0) {
      const perDay = extras.costUSD / extras.activeDays;
      out.push({
        theme: 'bloopers',
        score: 0.35 + 0.5 * sat(perDay, 40),
        stat: {
          big: fmtUSD(perDay),
          label: 'torched per active day, on average',
          sub: `${fmtUSD(extras.costUSD)} all year — and you'd do it again tomorrow`,
        },
      });
    }
    // Model rotation — commitment issues, quantified.
    if (extras.modelsTried >= 4) {
      out.push({
        theme: 'relationship',
        score: 0.35 + 0.4 * sat(extras.modelsTried, 12),
        stat: {
          big: fmtInt(extras.modelsTried),
          label: 'models you kept in rotation this year',
          sub: 'monogamy was never really on the table',
        },
      });
    }
    // Cache reads are replayed context, not new thinking — the honest, brutal framing.
    if (extras.cacheHitRate !== null && extras.cacheHitRate >= 0.8) {
      out.push({
        theme: 'bloopers',
        score: 0.25 + 0.45 * extras.cacheHitRate,
        stat: {
          big: `${Math.round(extras.cacheHitRate * 100)}%`,
          label: 'of your token bill was re-reading context you’d already sent',
          sub: 'you don’t have conversations, you have reruns',
        },
      });
    }
  }

  return out;
}

const THEME_META = {
  friction: { kicker: 'the friction reel', title: 'It wasn’t always pretty.' },
  relationship: { kicker: 'the relationship', title: 'You two have a dynamic.' },
  lies: { kicker: 'famous last words', title: 'The lies you told yourself.' },
  bloopers: { kicker: 'the bloopers', title: 'And then there’s… this.' },
} satisfies Record<Candidate['theme'], { kicker: string; title: string }>;

const FOOTNOTES = {
  friction:
    'errors = any failed tool call (a denied command, a missing file, a bad API call) — friction, not disasters · cursed day by session start date (UTC)',
  relationship: 'counted from your local transcripts — messages containing each phrase',
  lies: 'counted from your own prompts — messages containing each phrase, in any context',
  bloopers: 'all counted locally from your own transcripts and usage',
} satisfies Record<Candidate['theme'], string>;

/** Assemble themed cards from the highest-scoring candidates. A card renders
 *  only when its lead stat clears the bar — thresholds, not quotas. */
export function selectFunCards(
  content: WrappedContentStats | null,
  rhythm: WrappedRhythm,
  extras?: FunExtras,
): FunCard[] {
  const candidates = buildCandidates(content, rhythm, extras);
  const cards: FunCard[] = [];
  for (const theme of ['friction', 'relationship', 'lies', 'bloopers'] as const) {
    const pool = candidates
      .filter((c) => c.theme === theme && c.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const lead = pool[0];
    if (!lead || lead.score < 0.4) continue;
    cards.push({
      id: theme,
      kicker: THEME_META[theme].kicker,
      title: THEME_META[theme].title,
      stats: pool.map((c) => c.stat),
      footnote: FOOTNOTES[theme],
      score: lead.score,
    });
  }
  return cards;
}

export function selectWordOfYear(
  content: WrappedContentStats | null,
): { word: string; count: number; sessions: number; runnersUp: string[] } | null {
  const words = content?.words ?? [];
  const top = words[0];
  if (!top || top.count < 25 || top.sessions < 8) return null;
  return { ...top, runnersUp: words.slice(1, 4).map((w) => w.word) };
}

// Persona: three median-split behavioral axes → eight archetypes, every one a
// compliment (the Spotify Listening Personality recipe). The axis evidence is
// printed on the card so the label never reads as hallucinated.
const NIGHT_THRESHOLD = 0.25;
const FOCUS_THRESHOLD = 0.4;
const DEPTH_THRESHOLD = 40; // raw indexed message_count median (tool turns included)

interface ArchetypeMap {
  [axisKey: string]: { name: string; tagline: string };
}
const ARCHETYPES: ArchetypeMap = {
  'night|focus|deep': { name: 'The Midnight Machinist', tagline: 'One project, the small hours, total immersion.' },
  'night|focus|quick': { name: 'The Nocturnal Sniper', tagline: 'In after dark, one clean shot, out.' },
  'night|multi|deep': { name: 'The Moonlit Cartographer', tagline: 'Mapping every repo while the world sleeps.' },
  'night|multi|quick': { name: 'The 3 AM Tinkerer', tagline: 'No project is safe from a small-hours "what if".' },
  'day|focus|deep': { name: 'The Deep-Work Artisan', tagline: 'Long sessions, one obsession, real craft.' },
  'day|focus|quick': { name: 'The Surgical Striker', tagline: 'Precise questions, fast exits, ruthless focus.' },
  'day|multi|deep': { name: 'The Systems Gardener', tagline: 'Tending a dozen codebases until they all bloom.' },
  'day|multi|quick': {
    name: 'The Rapid Prototyper',
    tagline: 'A new idea every time you sit down — some even survive.',
  },
};

export function selectPersona(
  events: WrappedEventStats,
  topProjectShare: number,
  content: WrappedContentStats | null,
): WrappedPersona | null {
  if (events.distinctSessions < 10) return null; // too little behavior to name

  const night = events.nightShare;
  const depth = content?.depthMedian ?? null;
  const deep = depth !== null ? depth >= DEPTH_THRESHOLD : events.medianReplies >= 20;
  const key = [
    night >= NIGHT_THRESHOLD ? 'night' : 'day',
    topProjectShare >= FOCUS_THRESHOLD ? 'focus' : 'multi',
    deep ? 'deep' : 'quick',
  ].join('|');
  const archetype = ARCHETYPES[key]!;

  const interrupts = phrase(content?.phrases ?? [], 'interrupts');
  const interruptRate = content && content.indexedSessions > 0 ? interrupts / content.indexedSessions : 0;
  const flavor =
    interruptRate >= 0.2
      ? 'trust style: hands on the wheel — you interrupt and steer'
      : interruptRate > 0
        ? 'trust style: delegator — you mostly let it cook'
        : null;

  return {
    name: archetype.name,
    tagline: archetype.tagline,
    axes: [
      {
        label: 'clock',
        value: `${Math.round(night * 100)}% after dark`,
        lean: night >= NIGHT_THRESHOLD ? 'night owl' : 'daylight',
      },
      {
        label: 'focus',
        value: `${Math.round(topProjectShare * 100)}% one project`,
        lean: topProjectShare >= FOCUS_THRESHOLD ? 'devoted' : 'explorer',
      },
      {
        // message_count includes tool-loop/subagent turns, so this is "messages",
        // not conversational "turns" — the honest unit for the raw count.
        label: 'depth',
        value:
          depth !== null
            ? `${fmtInt(Math.round(depth))} ${plural(Math.round(depth), 'message')} per real session`
            : `${fmtInt(Math.round(events.medianReplies))} ${plural(Math.round(events.medianReplies), 'reply', 'replies')} per session`,
        lean: deep ? 'marathoner' : 'sprinter',
      },
    ],
    flavor,
  };
}
