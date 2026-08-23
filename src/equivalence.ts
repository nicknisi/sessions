// Token volume, restated as something a person can feel.
//
// A raw token count is unreadable at every scale — "1,247,003,912" and
// "84,209,551" produce the same shrug. The fix both `sessions report` and
// `sessions wrapped` use is an equivalence: divide the number by something the
// reader has actually finished.
//
// Three rules earned from the first version, which always said "copies of War
// and Peace":
//
//   1. The unit has to be something people have really read or watched. A book
//      famous for being long but unfinished measures nothing.
//   2. The unit has to be near the number's own magnitude. "1,500 copies of X"
//      is as abstract as the raw count, so units only enter the running when
//      the multiplier lands between 1.5 and 999.
//   3. Rotating the *frame* beats rotating the noun. The same billion tokens is
//      a shelf of novels, a source tree, or a human lifetime of typing, and the
//      time frames stay legible at volumes where every book count goes numb.
//
// The pick is seeded, never `Math.random()`. A report re-rendered, re-opened,
// or merely repainted after an accent change must say the same thing, and the
// tests assert exact strings. Seeding on the user's own numbers still gives
// every year and every person a different line.

/** Tokenizers vary; ~0.75 words per token is the long-standing English rule of
 *  thumb. Every derivation below uses it, so the whole table moves together if
 *  it is ever retuned. */
export const WORDS_PER_TOKEN = 0.75;

const tokensFromWords = (words: number): number => words / WORDS_PER_TOKEN;

/** Source trees tokenize denser than prose — punctuation and short identifiers
 *  split hard. ~9 tokens per line is the working estimate, and it is disclosed
 *  wherever a code unit is shown. */
const tokensFromLines = (lines: number): number => lines * 9;

export interface Equivalence {
  /** Stable across renders — the seed indexes this, and tests name it. */
  id: string;
  /** The multiplier alone, formatted: "830", "3.3", "21 yrs". */
  value: string;
  /** Reads under `value` in a stat tile: "Harry Potter marathons". */
  label: string;
  /** The natural-language form, for prose: "830 back-to-back reads of ...". */
  phrase: string;
}

/** A unit of comparison. `count` units divide the token total; `span` units
 *  convert it to the time a human would need to produce or perform it. */
type Unit =
  | { kind: 'count'; id: string; tokens: number; label: string; phrase: (n: string) => string }
  | { kind: 'span'; id: string; wpm: number; label: string; phrase: (span: string) => string };

// Word counts below are published figures for the works named. The series
// totals are the sums of their volumes and are approximate where the
// publishers never released per-book counts.
const UNITS: Unit[] = [
  {
    kind: 'count',
    id: 'gatsby',
    tokens: tokensFromWords(47_094), // The Great Gatsby
    label: 'trips through Gatsby',
    phrase: (n) => `${n} trips through The Great Gatsby`,
  },
  {
    kind: 'count',
    id: 'hobbit',
    tokens: tokensFromWords(95_356), // The Hobbit
    label: 'journeys there and back',
    phrase: (n) => `${n} round trips through The Hobbit`,
  },
  {
    kind: 'count',
    id: 'dune',
    tokens: tokensFromWords(187_240), // Dune
    label: 'crossings of Dune',
    phrase: (n) => `${n} crossings of Dune`,
  },
  {
    kind: 'count',
    id: 'hunger-games',
    tokens: tokensFromWords(301_583), // The Hunger Games trilogy
    label: 'Hunger Games trilogies',
    phrase: (n) => `${n} runs through the Hunger Games trilogy`,
  },
  {
    kind: 'count',
    id: 'narnia',
    tokens: tokensFromWords(345_535), // The Chronicles of Narnia, all seven
    label: 'trips through Narnia',
    phrase: (n) => `${n} trips through all seven Narnia books`,
  },
  {
    kind: 'count',
    id: 'lotr',
    tokens: tokensFromWords(481_103), // The Lord of the Rings, three volumes
    label: 'trips to Mordor and back',
    phrase: (n) => `${n} trips to Mordor and back`,
  },
  {
    kind: 'count',
    id: 'harry-potter',
    tokens: tokensFromWords(1_084_170), // Harry Potter, all seven
    label: 'Harry Potter marathons',
    phrase: (n) => `${n} back-to-back reads of all seven Harry Potter books`,
  },
  {
    kind: 'count',
    id: 'asoiaf',
    tokens: tokensFromWords(1_770_000), // A Song of Ice and Fire, five published volumes
    label: 'Ice and Fire re-reads',
    phrase: (n) => `${n} re-reads of every Song of Ice and Fire book so far`,
  },
  {
    kind: 'count',
    id: 'wheel-of-time',
    tokens: tokensFromWords(4_410_000), // The Wheel of Time, fourteen volumes
    label: 'Wheel of Time re-reads',
    phrase: (n) => `${n} full turns of the Wheel of Time`,
  },
  {
    kind: 'count',
    id: 'sqlite',
    tokens: tokensFromLines(156_000), // SQLite core, ~156K SLOC of C
    label: 'copies of SQLite',
    phrase: (n) => `${n} copies of the entire SQLite source`,
  },
  {
    kind: 'count',
    id: 'linux',
    tokens: tokensFromLines(40_000_000), // The Linux kernel, ~40M lines
    label: 'Linux kernels',
    phrase: (n) => `${n} copies of the entire Linux kernel`,
  },
  {
    kind: 'count',
    id: 'wikipedia',
    tokens: tokensFromWords(4_600_000_000), // English Wikipedia, all articles
    label: 'English Wikipedias',
    phrase: (n) => `${n} copies of the English Wikipedia`,
  },
  {
    kind: 'span',
    id: 'typing',
    wpm: 80, // a fast touch typist, sustained
    label: 'of non-stop typing',
    phrase: (s) => `${s} of typing at 80 words a minute without ever stopping`,
  },
  {
    kind: 'span',
    id: 'stenographer',
    wpm: 225, // the certification standard for court reporters
    label: 'of a stenographer flat out',
    phrase: (s) => `${s} of a court stenographer working flat out`,
  },
  {
    kind: 'span',
    id: 'aloud',
    wpm: 150, // audiobook narration pace
    label: 'of reading aloud',
    phrase: (s) => `${s} of reading aloud at audiobook pace, without sleeping`,
  },
];

/** Below 1.5 the unit is bigger than the thing it measures; past 999 the count
 *  is just another unreadable number wearing a costume. */
const MIN_RATIO = 1.5;
const MAX_RATIO = 999;
/** A span shorter than a full day is not a boast. */
const MIN_SPAN_HOURS = 24;

/** Two significant-ish digits under 10, whole numbers above — "3.3" and "830"
 *  both read instantly, "3.28" and "829.6" do not. A trailing ".0" is noise
 *  that makes a clean number look like a rounding artifact, so it goes. */
function ratio(n: number): string {
  if (n >= 10) return Math.round(n).toLocaleString('en-US');
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

interface TimeSpan {
  short: string;
  long: string;
}

/** Hours, days, or years — whichever keeps the number under three digits. */
function span(hours: number): TimeSpan {
  if (hours < 48) {
    const n = Math.round(hours);
    return { short: `${n} hrs`, long: `${n} hours` };
  }
  const days = hours / 24;
  if (days < 365) {
    const n = Math.round(days);
    return { short: `${n} days`, long: `${n} days` };
  }
  const n = ratio(days / 365);
  return { short: `${n} yrs`, long: `${n} years` };
}

function render(unit: Unit, tokens: number): Equivalence | null {
  if (unit.kind === 'count') {
    const x = tokens / unit.tokens;
    if (x < MIN_RATIO || x > MAX_RATIO) return null;
    const n = ratio(x);
    return { id: unit.id, value: n, label: unit.label, phrase: unit.phrase(n) };
  }
  const hours = (tokens * WORDS_PER_TOKEN) / unit.wpm / 60;
  if (hours < MIN_SPAN_HOURS) return null;
  const s = span(hours);
  return { id: unit.id, value: s.short, label: unit.label, phrase: unit.phrase(s.long) };
}

/** Every unit that lands in a readable range for this many tokens, in table
 *  order. Empty for a trivial total, which is the honest answer — there is no
 *  flattering comparison for two sessions. */
export function equivalences(tokens: number): Equivalence[] {
  if (!Number.isFinite(tokens) || tokens <= 0) return [];
  const out: Equivalence[] = [];
  for (const unit of UNITS) {
    const rendered = render(unit, tokens);
    if (rendered) out.push(rendered);
  }
  return out;
}

/** FNV-1a. Not cryptographic — it just needs to scatter similar seeds to
 *  unrelated indexes so two adjacent years don't draw the same unit. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The candidate list plus where the seed lands in it. Callers serialize both:
 *  the page opens on `start` and the reroll control walks the array, so the
 *  cycling happens without shipping the hash to the browser. */
export interface EquivalenceChoices {
  options: Equivalence[];
  start: number;
}

export function equivalenceChoices(tokens: number, seed: string): EquivalenceChoices {
  const options = equivalences(tokens);
  if (options.length === 0) return { options, start: 0 };
  return { options, start: hash(seed) % options.length };
}

/** One equivalence, stable for a given (tokens, seed). `seed` should carry
 *  whatever makes this render distinct — the period, and a slot name when one
 *  page shows two of these and they should not match. */
export function pickEquivalence(tokens: number, seed: string): Equivalence | null {
  const { options, start } = equivalenceChoices(tokens, seed);
  return options[start] ?? null;
}
