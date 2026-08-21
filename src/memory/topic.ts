// Topic matching: how relevant a memory is to what the agent says it is about to do.
//
// This module is PURE and imports nothing — no store, no index, no clock. That is a
// constraint, not an accident: src/memory/topic.test.ts drives it with plain strings
// and needs no tmpdir harness, and anything that reaches into src/memory/store.ts or
// src/wrapped/content.ts transitively opens a database on import. Same rule
// src/memory/quorum.ts ships under.
//
// What this is NOT: a ranker. See the comment on `matchTopic`.

/**
 * Below this score, a memory that is not marked always-on is dropped from the active
 * set for a given topic.
 *
 * The score is `|topic ∩ memory| / |topicTokens|`, so the memory's length never enters
 * the denominator — only the topic's does. At 0.15 a topic with one to six content
 * tokens passes on a single hit, and a seven-token topic needs two. That is the
 * intended shape: a terse topic ("keychain") should be permissive, and a long
 * paste-in-the-whole-task topic should demand more than one incidental word overlap.
 *
 * This number is a guess made before there was enough memory volume to tune anything
 * against, which is why it is an exported constant rather than a literal — tuning is a
 * one-line change, and replacing `matchTopic` outright is the other option the seam is
 * there for.
 */
export const TOPIC_THRESHOLD = 0.15;

/**
 * Function words only.
 *
 * Deliberately NOT src/wrapped/content.ts's STOPWORDS, for two reasons. It lives in a
 * module that pulls the index open, which would cost this file its purity; and it is
 * built for a different job — crowning a user's distinctive vocabulary — so it drops
 * `add`, `use`, `check`, `file`, `code`, and `test`, every one of which is load-bearing
 * inside a real topic string ("add keychain support", "check the build config"). A word
 * dropped here shrinks the denominator, so an aggressive list silently inflates every
 * score.
 */
const STOPWORDS = new Set(
  (
    'a an the this that these those it its and or but nor so if then than as of in on at by to from for with without ' +
    'into onto over under about above below up down out off again once here there when where which who whom whose what ' +
    'why how all any both each few more most other some such no not only own same very can cant cannot will wont just ' +
    // `don` earns its place: unicode61 splits "don't" into don + t, so without it every
    // negated topic carries a spurious content token (src/memory/mine.ts:41-46).
    'don dont doesnt didnt is are was were be been being am do does did done has have had having i me my we us our you your ' +
    'he she they them their his her theirs would should could shall may might must let lets'
  ).split(' '),
);

/**
 * Suffixes stripped to a common stem, LONGEST FIRST so `serialization` reaches
 * `-ization` before `-s` and the pairs below collapse together.
 *
 * The spec proposed three suffixes (`-ing`, `-ed`, `-s`) and named "serialization
 * matches serialize" as the goal, but those two rules are incompatible: neither word
 * ends in any of the three, so the stated stemmer scores that pair 0. Real Porter gets
 * there through an `-ization -> -ize -> -ize->0` chain, which is a rules table rather
 * than a suffix list. This is the smallest table that closes the gap:
 *
 *   serialization -> serial   serialize -> serial   serialized -> serial
 *   migrations    -> migr     migrate   -> migr     migrating  -> migr
 *   refactoring   -> refactor refactor  -> refactor
 *   stored        -> stor     store     -> stor     stores     -> stor
 *
 * The trailing `-e` rule is what makes that last row work. Without it the strip is
 * asymmetric (`stored -> stor` but `store -> store`) and produces a false negative on
 * a pair any user would call the same word. Symmetry matters more than linguistic
 * correctness here: both sides go through the same function, so an over-eager rule
 * costs precision but never creates a one-sided miss.
 */
const SUFFIXES = [
  'izations',
  'isations',
  'ization',
  'isation',
  'ations',
  'ation',
  'izing',
  'ising',
  'ating',
  'ized',
  'ised',
  'izes',
  'ises',
  'ated',
  'ates',
  'ings',
  'ize',
  'ise',
  'ate',
  'ing',
  'es',
  'ed',
  's',
  'e',
];

/**
 * Shortest stem a strip may leave behind. Below this, stripping does more harm than
 * good: `-s` off `is`/`as`/`us` leaves a one-character token that matches everything.
 */
const MIN_STEM_LENGTH = 3;

/** Strip the longest matching suffix, once, if the remainder is still a real word. */
function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length < MIN_STEM_LENGTH) continue;
    if (token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/**
 * Lowercase, split on non-alphanumerics, drop stopwords, stem, dedupe.
 *
 * Splitting on non-alphanumerics is what `unicode61` does inside FTS5, so `"don't"`
 * becomes `don` + `t` here exactly as it does in the index (documented at
 * src/memory/mine.ts:41-46). That looks like a bug and is not — matching the index's
 * behavior is the point. The single-character fragment it leaves behind is dropped by
 * the length floor below, which is why that floor is 2 rather than 1.
 *
 * A `Set` rather than an array: a topic that repeats a word must not inflate its own
 * denominator, and the intersection below is a membership test either way.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * Relevance of `memoryText` to `topic`, in [0, 1].
 *
 * SWAPPABLE SEAM. This is deliberately the simplest defensible matcher — stemmed token
 * overlap, mirroring the `porter unicode61` tokenization the index already applies
 * (src/cache.ts:162,175) without pulling in a library, because the dependency ceiling
 * is an asserted success criterion. It was written before there was enough memory volume
 * to tune anything more sophisticated against, and a bespoke scorer fitted to fifteen
 * memory would be fitted to noise. Replace the body, not the signature, once real usage
 * shows what matching should key on.
 *
 * Returns 1 — "no opinion, keep everything" — when the topic contributes no tokens.
 * That covers the empty string, whitespace, and the case the spec does not name: a
 * topic made entirely of stopwords ("the and it"), which yields 0/0 = NaN, and
 * `NaN >= TOPIC_THRESHOLD` is false, so every conditional memory would vanish. A silent
 * empty result is the exact failure the always-on flag exists to prevent; a matcher
 * that cannot form an opinion must abstain, not veto.
 */
export function matchTopic(memoryText: string, topic: string): number {
  const topicTokens = tokenize(topic);
  if (topicTokens.size === 0) return 1;
  const memoryTokens = tokenize(memoryText);
  if (memoryTokens.size === 0) return 0;
  let hits = 0;
  for (const token of topicTokens) {
    if (memoryTokens.has(token)) hits++;
  }
  return hits / topicTokens.size;
}
