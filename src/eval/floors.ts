// The retrieval ratchet's thresholds, in a non-test module because two test files need
// them. Importing them from `eval.test.ts` would re-register that file's whole suite
// inside the importer — bun runs the imported module's `test()` calls again, `beforeAll`
// included — so the shared numbers live here and both files import them.
//
// Thresholds are what the harness MEASURES today, not what we want: the job is to make a
// regression visible, so any drop fails and any gain is recorded by re-running
// `bun run eval > docs/eval-baseline.md`.
import type { EvalReport } from './run';
import type { QueryClass } from './queries';

export interface RecallFloor {
  recallAt5: number;
  recallAt1: number;
  mrr: number;
}

// Measured 2026-07-27 against the 30-transcript fixture corpus. recall@5 saturates at
// this corpus size; recall@1 and MRR are the numbers that move when the ranking constants
// do. The negative class has no answer to rank, so it has no recall floor — only a
// ceiling.
//
// `command` and `multi-word-natural-language` sit below 1.00 because each carries one
// query whose answer is second today (cmd-prisma-migrate-deploy, nl-webhook-signature-fix)
// — recorded misses, explained in docs/eval-baseline.md. They are also the two classes
// src/eval/mutation.test.ts detects every mutant through: a class already ratcheted to a
// flat 1.00 can only ever notice a regression, and only a query decided by a margin narrow
// enough for a constant to close can notice a mistuning.
//
// Two things these floors quietly depend on. The exact-error-string and file-path 1.00s
// survive s21 (a /private/tmp throwaway) only because searchSessions removes junk cwds;
// unfiltered, s21 takes rank 1 from err-stripe-signature and path-stripe-webhook and both
// classes drop to 80%/0.90. And nl-webhook-signature-fix's recorded miss is load-bearing
// in the wrong direction: two of the four mutants *promote* its answer to rank 1, so the
// multi-word class only registers those mutants because other queries in it lose more
// than that query gains.
export const RECALL_FLOOR: Record<Exclude<QueryClass, 'negative'>, RecallFloor> = {
  'exact-error-string': { recallAt5: 1, recallAt1: 1, mrr: 1 },
  'file-path': { recallAt5: 1, recallAt1: 1, mrr: 1 },
  command: { recallAt5: 1, recallAt1: 5 / 6, mrr: 5.5 / 6 },
  'multi-word-natural-language': { recallAt5: 1, recallAt1: 7 / 8, mrr: 7.5 / 8 },
  scoped: { recallAt5: 1, recallAt1: 1, mrr: 1 },
};

/** Serialized chars of the worst top-5 page in each class, as measured. */
export const PAYLOAD_CEILING: Record<QueryClass, number> = {
  'exact-error-string': 6252,
  'file-path': 937,
  command: 4393,
  'multi-word-natural-language': 6359,
  scoped: 2177,
  negative: 5519,
};

/** Float means; compare with slack rather than exactly. */
export const EPSILON = 1e-9;

/**
 * Classes whose measured recall came in under its floor.
 *
 * Deliberately recall only — the payload ceilings are a *cost* ratchet, not a quality
 * one, and they move by tens of characters whenever result serialization wobbles. On the
 * 21-transcript corpus this one grew out of, `userHitBoost -> 1.0` and
 * `finalRankMode -> 'best'` each exceeded a ceiling by 21-86 chars while every expected
 * answer stayed at exactly the rank it had before; an oracle that accepted any violated
 * assertion would have called them dead while the corpus was still blind to what they
 * changed. Killing a mutant has to mean an answer moved.
 */
export function recallFloorViolations(report: EvalReport): string[] {
  const violations: string[] = [];
  for (const [cls, floor] of Object.entries(RECALL_FLOOR) as [keyof typeof RECALL_FLOOR, RecallFloor][]) {
    const measured = report.classes.find((c) => c.class === cls);
    if (!measured) {
      violations.push(`${cls}: absent from the report`);
      continue;
    }
    if (measured.recallAt5 < floor.recallAt5 - EPSILON) {
      violations.push(`${cls}: recall@5 ${measured.recallAt5.toFixed(3)} < ${floor.recallAt5.toFixed(3)}`);
    }
    if (measured.recallAt1 < floor.recallAt1 - EPSILON) {
      violations.push(`${cls}: recall@1 ${measured.recallAt1.toFixed(3)} < ${floor.recallAt1.toFixed(3)}`);
    }
    if (measured.mrr < floor.mrr - EPSILON) {
      violations.push(`${cls}: MRR ${measured.mrr.toFixed(3)} < ${floor.mrr.toFixed(3)}`);
    }
  }
  return violations;
}
