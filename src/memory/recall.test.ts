// The G1 gate: run the mine over a corpus built from corrections-golden.json and
// assert >=90% recall on `correction` entries and ZERO candidates from `not` entries.
//
// This is an extraction gate, not a ranking gate — it lives in src/memory/ rather
// than src/eval/ because the eval harness ranks sessions while this measures
// candidate extraction (docs/ideation/memory-recurrence/spec-phase-1.md).
//
// Each entry becomes its own session with a single typed user turn followed by an
// assistant turn, so the interruption pass can never fire inside this corpus: recall
// here measures the VOCABULARY (CORRECTIVE_TERMS), and the band/question filters are
// exercised by the `not` half. mine.test.ts covers the interruption join separately.

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mine } from './mine';
import { normalizeText } from './record';
import { assistantTurn, closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

interface GoldenEntry {
  text: string;
  label: 'correction' | 'not';
  source: string;
}

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'corrections-golden.json'), 'utf8')) as {
  _comment: string;
  entries: GoldenEntry[];
};

const CORRECTIONS = GOLDEN.entries.filter((e) => e.label === 'correction');
const NOTS = GOLDEN.entries.filter((e) => e.label === 'not');

/** The gate the contract fixes: at least 90% of labeled corrections are mined. */
const RECALL_FLOOR = 0.9;

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-recall');
  setMemoryEnv(tmp);

  for (const [i, entry] of GOLDEN.entries.entries()) {
    writeSession(tmp, `entry-${i}`, '/repoRecall', [
      userTurn(entry.text, '2026-06-01T10:00:00Z'),
      assistantTurn('Understood, making that change now.', '2026-06-01T10:00:30Z'),
    ]);
  }

  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases(); // the next query reopens against our env
});

afterAll(() => {
  closeDatabases(); // release handles before deleting the temp tree
  rmSync(tmp, { recursive: true, force: true });
});

describe('corrections golden set', () => {
  test('the set is large enough to carry a gate (unlike fixtures/golden-set.json)', () => {
    expect(CORRECTIONS.length).toBeGreaterThanOrEqual(40);
    expect(NOTS.length).toBeGreaterThanOrEqual(40);
  });

  test(`recall on corrections is at least ${RECALL_FLOOR}`, async () => {
    const records = await mine({});
    const mined = new Set(records.map((r) => r.text));
    const missed = CORRECTIONS.filter((e) => !mined.has(normalizeText(e.text)));
    const recall = (CORRECTIONS.length - missed.length) / CORRECTIONS.length;
    // List the misses so a tuning regression names its victims instead of a number.
    expect(missed.map((e) => e.text)).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });

  test('zero candidates come from not entries', async () => {
    // The precision half of the gate. A `not` entry that becomes a candidate means
    // a term is matching complaints or requests rather than corrections — the term
    // goes, not the label (labels change only with a recorded reason).
    const records = await mine({});
    const mined = new Set(records.map((r) => r.text));
    const leaked = NOTS.filter((e) => mined.has(normalizeText(e.text)));
    expect(leaked.map((e) => e.text)).toEqual([]);
  });
});
