// The eval runner: seeds the frozen corpus, plays every golden query through the
// real search engine, and gates on the metrics (docs/EVAL.md). Runs as part of
// `bun test` so CI enforces it; `bun run eval` runs just this file for tuning.
//
// Every golden query is executed ONCE in beforeAll and materialized into plain
// data — the tests below assert over outcomes, so they don't care about DB env
// state the way cache-importing suites do.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEvalCorpus } from './corpus';
import { EVAL_V, GATES, GOLDEN, RECALL_K, type GoldenClass, type GoldenQuery } from './golden';

interface Outcome {
  golden: GoldenQuery;
  /** Result session ids, in rank order. */
  ids: string[];
}

let tmp: string;
let outcomes: Outcome[];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-eval-'));
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });
  seedEvalCorpus({ claudeDir: join(tmp, 'claude'), piDir: join(tmp, 'pi') });

  const cache = await import('../cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();

  outcomes = [];
  for (const golden of GOLDEN) {
    const results = await cache.searchSessions(golden.query, golden.opts ?? {});
    outcomes.push({ golden, ids: results.map((r) => r.sessionId) });
  }
  cache.closeDb(); // release the handle; tests below read only `outcomes`
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const outcomeFor = (id: string): Outcome => outcomes.find((o) => o.golden.id === id)!;

/** Expected ids for a positive golden: top ∪ first, deduped, order irrelevant. */
function expectedIds(g: GoldenQuery): string[] {
  return [...new Set([...(g.top ?? []), ...(g.first ? [g.first] : [])])];
}

// ——— individual conditions (the failure message names the golden) ———

for (const g of GOLDEN.filter((g) => g.negative)) {
  test(`[${g.class}] ${g.id} abstains: "${g.query}" returns zero results`, () => {
    expect(outcomeFor(g.id).ids).toEqual([]);
  });
}

for (const g of GOLDEN.filter((g) => g.first || g.absent?.length)) {
  test(`[${g.class}] ${g.id} hard conditions: "${g.query}"`, () => {
    const { ids } = outcomeFor(g.id);
    if (g.first) expect(ids[0]).toBe(g.first);
    for (const absent of g.absent ?? []) expect(ids).not.toContain(absent);
  });
}

// ——— aggregate gates ———

interface Metrics {
  recallAtK: number;
  mrr: number;
  negativePass: number;
  perClass: Map<GoldenClass, { found: number; expected: number }>;
  misses: string[];
}

function computeMetrics(): Metrics {
  const positives = outcomes.filter((o) => expectedIds(o.golden).length > 0);
  const perClass = new Map<GoldenClass, { found: number; expected: number }>();
  const misses: string[] = [];
  let found = 0;
  let expected = 0;
  const reciprocalRanks: number[] = [];

  for (const { golden, ids } of positives) {
    const expectedFor = expectedIds(golden);
    const cls = perClass.get(golden.class) ?? { found: 0, expected: 0 };
    perClass.set(golden.class, cls);
    let bestRank = -1;
    for (const id of expectedFor) {
      const rank = ids.indexOf(id);
      expected++;
      cls.expected++;
      if (rank >= 0 && rank < RECALL_K) {
        found++;
        cls.found++;
      } else {
        misses.push(
          `${golden.id}: "${golden.query}" — expected ${id} in top ${RECALL_K}, got [${ids.join(', ') || '∅'}]`,
        );
      }
      if (rank >= 0 && (bestRank < 0 || rank < bestRank)) bestRank = rank;
    }
    reciprocalRanks.push(bestRank >= 0 ? 1 / (bestRank + 1) : 0);
  }

  const negatives = outcomes.filter((o) => o.golden.negative);
  const negativePass = negatives.filter((o) => o.ids.length === 0).length / negatives.length;

  return {
    recallAtK: found / expected,
    mrr: reciprocalRanks.reduce((a, b) => a + b, 0) / reciprocalRanks.length,
    negativePass,
    perClass,
    misses,
  };
}

test(`aggregate gates (${EVAL_V}): recall@${RECALL_K}, MRR, negative abstention`, () => {
  const m = computeMetrics();

  // The report is the tuning artifact: when a gate fails this is what you read.
  const lines = [
    `\n——— search eval ${EVAL_V} ———`,
    ...[...m.perClass.entries()].map(([cls, c]) => `  ${cls.padEnd(17)} recall@${RECALL_K} ${c.found}/${c.expected}`),
    `  ${'OVERALL'.padEnd(17)} recall@${RECALL_K} ${m.recallAtK.toFixed(3)} (gate ≥ ${GATES.recallAtK})`,
    `  ${''.padEnd(17)} MRR ${m.mrr.toFixed(3)} (gate ≥ ${GATES.mrr})`,
    `  ${''.padEnd(17)} negatives ${(m.negativePass * 100).toFixed(0)}% abstain (gate = ${GATES.negatives * 100}%)`,
    ...(m.misses.length > 0 ? ['  misses:', ...m.misses.map((s) => `    ${s}`)] : []),
  ];
  console.log(lines.join('\n'));

  expect(m.recallAtK).toBeGreaterThanOrEqual(GATES.recallAtK);
  expect(m.mrr).toBeGreaterThanOrEqual(GATES.mrr);
  expect(m.negativePass).toBe(GATES.negatives);
});
