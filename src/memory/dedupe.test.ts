import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { mine } from './mine';
import { closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

// The measured failure this test exists to prevent: one eval fixture prompt appeared
// 14 times byte-identical in the real corpus. Counting raw occurrences would have
// promoted a copy-pasted clipboard artifact as the top candidate, because author
// diversity — not repetition — is what makes a repeat evidential, and solo there is
// none.
const REPEATED = 'Always regenerate the fixture snapshot before running the eval suite';
const SPACED = 'Always   regenerate the fixture snapshot\nbefore running the eval suite';

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-dedupe');
  setMemoryEnv(tmp);

  const turns = Array.from({ length: 14 }, (_, i) =>
    userTurn(REPEATED, `2026-06-01T10:${String(i).padStart(2, '0')}:00Z`),
  );
  writeSession(tmp, 'repeats', '/repoRepeat', turns);

  // A second session repeats it once more, with different whitespace.
  writeSession(tmp, 'other', '/repoRepeat', [userTurn(SPACED, '2026-06-15T10:00:00Z')]);

  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('byte-exact collapse', () => {
  test('14 identical prompts collapse to distinctPhrasings: 1', async () => {
    const records = await mine({});
    const r = records.find((x) => x.text === REPEATED);
    expect(r).toBeDefined();
    expect(r!.evidence.distinctPhrasings).toBe(1);
  });

  test('the repeated prompt yields exactly one record', async () => {
    const records = await mine({});
    expect(records.filter((x) => x.text === REPEATED)).toHaveLength(1);
  });

  test('whitespace variants land in the same cluster, never a duplicate id', async () => {
    // Whitespace variants fingerprint identically, so two clusters would mean two
    // records with the same id — a primary-key collision on the very next upsert.
    const records = await mine({});
    const ids = records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const r = records.find((x) => x.text === REPEATED)!;
    expect(r.evidence.sessions).toHaveLength(2);
  });

  test('evidence spans the full date range of the contributing sessions', async () => {
    const records = await mine({});
    const r = records.find((x) => x.text === REPEATED)!;
    expect(r.evidence.firstSeen).toBe('2026-06-01');
    expect(r.evidence.lastSeen).toBe('2026-06-15');
  });
});
