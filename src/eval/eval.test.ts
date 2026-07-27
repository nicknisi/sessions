// The retrieval-quality ratchet. Thresholds are what the harness MEASURES today, not
// what we want — the job is to make a regression visible, so any drop fails here and
// any gain is recorded by re-running `bun run eval > docs/eval-baseline.md`. Payload
// ceilings sit beside the recall floors so a recall gain has to show its token cost.
// The numbers themselves live in ./floors, shared with src/eval/mutation.test.ts, which
// reverts each tuned ranking constant and asserts the corpus notices.
import { test, expect, beforeAll } from 'bun:test';
import { runEval, CLASSES, CORPUS_SIZE, K, type EvalReport } from './run';
import { RECALL_FLOOR, PAYLOAD_CEILING, EPSILON } from './floors';
import { QUERIES } from './queries';

// What the OR-join returns for queries nothing in the corpus answers. Three of five come
// back with a full page of irrelevant sessions; the two that abstain do so only because
// every one of their terms is absent from the index — which makes this an exact equality
// that any new fixture can break by introducing one of those terms. Recorded, not
// desired: this is the input to an abstention design, so a change here is a decision,
// not a bug.
const NEGATIVE_RESULTS: Record<string, number> = {
  'neg-kubernetes': 0,
  'neg-swiftui': 5,
  'neg-knife': 5,
  'neg-elasticsearch': 5,
  'neg-nonce': 0,
};

let report: EvalReport;

beforeAll(async () => {
  report = await runEval();
});

test('corpus integrity: every fixture transcript is indexed', () => {
  // Without this a fixture that stops parsing would quietly shrink the corpus and the
  // recall numbers below would measure something else entirely.
  expect(report.indexed).toBe(CORPUS_SIZE);
});

test('corpus integrity: harness noise rows are not searchable', () => {
  expect(report.harnessOnlyHits).toBe(0);
});

test('corpus integrity: denylisted harness rows are filtered out of search, not out of the index', () => {
  // s03 carries the banners verbatim, the user-role ones written the way Claude writes
  // them (no promptSource, so they pass the genuine-turn gate). Dropping the read-path
  // denylist in searchSessions makes the first line 1; dropping the rows at insert time
  // instead — which is what this branch first did — makes the second line 0 and quietly
  // breaks grep_sessions' exhaustiveness contract.
  expect(report.noiseOnlyHits).toBe(0);
  expect(report.noiseGrepHits).toBeGreaterThan(0);
});

test.each(Object.keys(RECALL_FLOOR) as (keyof typeof RECALL_FLOOR)[])('recall ratchet: %s', (cls) => {
  const measured = report.classes.find((c) => c.class === cls)!;
  const floor = RECALL_FLOOR[cls];
  expect(measured.queries).toBe(QUERIES.filter((q) => q.class === cls).length);
  expect(measured.recallAt5).toBeGreaterThanOrEqual(floor.recallAt5 - EPSILON);
  expect(measured.recallAt1).toBeGreaterThanOrEqual(floor.recallAt1 - EPSILON);
  expect(measured.mrr).toBeGreaterThanOrEqual(floor.mrr - EPSILON);
});

test.each(CLASSES)('payload ceiling: %s', (cls) => {
  const measured = report.classes.find((c) => c.class === cls)!;
  // A recall gain that costs tokens fails here until the new number is committed —
  // which is the point: the cost lands in the same diff as the gain.
  expect(measured.maxChars).toBeLessThanOrEqual(PAYLOAD_CEILING[cls]);
});

test('scoped queries do not leak past a project or tool filter', () => {
  const leaked = report.outcomes.filter((o) => o.leaks.length > 0);
  expect(leaked.map((o) => `${o.id}: ${o.leaks.join(', ')}`)).toEqual([]);
});

test('characterization: negative queries return junk today', () => {
  const measured = Object.fromEntries(
    report.outcomes.filter((o) => o.class === 'negative').map((o) => [o.id, o.returned.length]),
  );
  expect(measured).toEqual(NEGATIVE_RESULTS);
});

test('characterization: a negative query costs the caller a full page of tokens', () => {
  const swiftui = report.outcomes.find((o) => o.id === 'neg-swiftui')!;
  expect(swiftui.returned.length).toBe(K); // a full page
  expect(swiftui.chars).toBeGreaterThan(4_000); // ~1k tokens spent to answer nothing
});
