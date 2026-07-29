// The quorum metric: the signal that makes volume evidential once more than one
// author exists.
//
// Pure, and deliberately tiny. It imports only the `MergedMemory` TYPE — an erased
// import under `verbatimModuleSyntax`, so nothing in this module's runtime graph can
// open a database or read a clock, and quorum.test.ts needs no harness at all.

import type { MergedMemory } from './portable';

/**
 * Distinct contributing authors. Deliberately NOT an occurrence count.
 *
 * This one-liner is the correction that makes repetition evidential, so it gets a
 * comment out of proportion to its size: the "obvious" implementation returns
 * `totalPhrasings`, and a future editor WILL be tempted, because a merged memory is
 * sitting right there with a count on it.
 *
 * Counting occurrences is the exact failure that made raw volume unusable. One eval
 * fixture prompt appeared 14 times byte-identical in the real corpus and would have
 * been promoted as the strongest fact on the machine. Five records from one author
 * must score 1; one record each from five authors scores 5. A verbose individual
 * cannot manufacture a quorum — only independent agreement can.
 *
 * KNOWN, and not a bug: `totalPhrasings` and `authors.length` are numerically
 * identical today, because `mine()` hardcodes `distinctPhrasings = 1` per cluster
 * (src/memory/mine.ts:234-237) with no write-back path from the triage skill. The two
 * numbers coincide by accident of the current pipeline, not by definition — the moment
 * merged phrasing counts reach the store they diverge, and the wrong one silently
 * becomes wrong. Read `authors`.
 *
 * Under the current single-author scope this returns 1 for everything, which is why
 * the metric ships alongside the merge rather than earlier: it is a constant until a
 * second author's export is imported.
 */
export function quorum(memory: MergedMemory): number {
  return memory.authors.length;
}

/**
 * Does this memory clear the bar for promotion consideration?
 *
 * `threshold` is a parameter with no default, on purpose. There is no defensible
 * default before real multi-author data exists, and a plausible-looking constant here
 * would be treated as a measured value by everything downstream.
 *
 * `>=`: a threshold of 3 means "three authors is enough", which is how a quorum reads
 * in English. A threshold of 0 or 1 therefore admits everything, which is the correct
 * degenerate behavior for a single-author machine.
 */
export function meetsQuorum(memory: MergedMemory, threshold: number): boolean {
  return quorum(memory) >= threshold;
}
