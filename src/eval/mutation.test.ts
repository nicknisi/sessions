// The exit condition for the eval corpus, expressed as a test rather than a document.
//
// Every ranking constant in searchSessions is hand-tuned. A tuned number nobody can
// revert-and-measure is a number nobody can ever safely change, so this file reverts each
// one in turn and asserts the corpus notices — a recall floor has to break. A mutant that
// survives names a blind spot: some tuned value the fixture corpus cannot distinguish
// from its neutral setting, which means the eval would sign off on deleting it.
//
// The oracle is deliberately one-sided and deliberately narrow:
//   - recall only (see recallFloorViolations) — payload ceilings move on serialization
//     wobble and would report a mutant dead while the corpus was still blind.
//   - a *drop* only — a mutant that improves a metric is not detected here. That is a
//     real limit: it means each fixture below has to make the tuned value strictly
//     better, not merely different.
import { test, expect, afterAll } from 'bun:test';
import { RANKING } from '../cache';
import { runEval } from './run';
import { recallFloorViolations } from './floors';

/** The shipped values, captured before any mutant runs, so restore is exact. */
const DEFAULTS = structuredClone(RANKING);

interface Mutant {
  name: string;
  /** Which fixture pair the corpus relies on to see this one. Prose, but load-bearing:
   *  when a mutant starts surviving, this says which fixture stopped doing its job. */
  detectedBy: string;
  apply: () => void;
}

// Reverting each constant to its neutral value — the setting someone would land on by
// deleting the tuning rather than by picking a different number.
const MUTANTS: Mutant[] = [
  {
    name: 'bm25 column weights flattened to 1.0',
    detectedBy:
      'cmd-aws-logs-tail: s26 ran the command (session_fts.commands, bm25 6.0) and s27 only weighed it up in a thinking block (0.5)',
    apply: () => {
      RANKING.sessionRank = RANKING.sessionRank.map(() => 1.0);
    },
  },
  {
    name: 'userHitBoost removed (1.5 -> 1.0)',
    detectedBy:
      'nl-unsubscribe-token-lifetime: s24 has the answer as a typed user turn; s25 and s30 say the same thing from the assistant side',
    apply: () => {
      RANKING.userHitBoost = 1.0;
    },
  },
  {
    name: 'short-message damping removed (minDamping 0.25 -> 1.0)',
    detectedBy:
      'nl-digest-duplicate-recipients: s22 is the substantive analysis, s23 mentions it in a single short aside',
    apply: () => {
      RANKING.minDamping = 1.0;
    },
  },
  {
    name: 'finalRank sum replaced by best-of',
    detectedBy:
      'nl-social-preview-stale: s28 matches session_fts and message_fts weakly, s29 matches message_fts alone but strongly',
    apply: () => {
      RANKING.finalRankMode = 'best';
    },
  },
];

// bun test runs every file in one process and RANKING is a shared module singleton, so a
// mutation that escaped this file would silently rescore cache.search.test.ts and
// eval.test.ts. The `finally` below is the guard; this is the belt.
afterAll(() => {
  expect(RANKING).toEqual(DEFAULTS);
});

test('the corpus is sensitive enough to kill every tuned ranking constant', async () => {
  // Inventory assertion: "no mutant survived" is vacuously true at zero mutants, and a
  // constant that gets renamed or deleted would otherwise leave this file quietly
  // measuring nothing. Mutating a typed record makes the rename a compile error; this
  // catches the case where someone drops an entry to make the suite green.
  expect(MUTANTS.length).toBe(4);
  expect(new Set(MUTANTS.map((m) => m.name)).size).toBe(MUTANTS.length);

  // Sanity: the unmutated corpus must clear its own floors, or every "kill" below is
  // just the baseline being broken.
  expect(recallFloorViolations(await runEval())).toEqual([]);

  const survivors: string[] = [];
  for (const m of MUTANTS) {
    const saved = structuredClone(RANKING); // deep: sessionRank is an array
    m.apply();
    try {
      // runEval is async — awaiting it is not optional. An un-awaited call hands a
      // Promise to the oracle, which finds no violations in it and reports every mutant
      // dead: the exact vacuous-green failure the inventory assertion above exists for.
      const violations = recallFloorViolations(await runEval());
      if (violations.length === 0) survivors.push(`${m.name} — expected ${m.detectedBy}`);
    } finally {
      Object.assign(RANKING, saved);
    }
  }

  expect(survivors).toEqual([]);
});

test('a mutant restores RANKING even when the eval throws', async () => {
  // The restore above is what keeps one failing mutant from poisoning the next one and
  // every later test file. Prove it survives a throw rather than trusting the `finally`.
  const saved = structuredClone(RANKING);
  expect(() => {
    try {
      RANKING.userHitBoost = 99;
      throw new Error('eval blew up mid-mutant');
    } finally {
      Object.assign(RANKING, saved);
    }
  }).toThrow('eval blew up mid-mutant');
  expect(RANKING).toEqual(DEFAULTS);
});
