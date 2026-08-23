import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { assertActionAcceptsFlags, parseTriageArgs, UsageError } from './cli';
import { buildRecord } from './record';
import { listMemories, setAlwaysOn, setState, upsertCandidates } from './store';
import { ALWAYS_ON_MAX_CHARS, ALWAYS_ON_MAX_ENTRIES, AlwaysOnBudgetError, approve } from './triage';
import type { MemoryRecord, MemoryScope } from './types';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';

// The always-on budget is what makes the flag's promise credible: always-on rows are
// served first and unconditionally, so a set that can grow without bound degrades into
// exactly the ambient noise it exists to cut through. These tests pin the three
// properties the cap needs to be usable: it refuses at the boundary (not one past it),
// re-confirming an existing grant is not a collision with itself, and --no-always-on
// is a real release valve rather than documentation.

const WORKFLOW: MemoryScope = { type: 'workflow', key: '' };

function record(text: string): MemoryRecord {
  return buildRecord({
    text,
    scope: WORKFLOW,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

/** Seed one candidate row and return its id. */
function seed(text: string): string {
  const r = record(text);
  upsertCandidates([r]);
  return r.id;
}

// A FRESH store per test: unlike most memory suites, every case here is a statement
// about the exact size of the standing set, so shared rows would couple the tests.
// Every tmp is tracked so afterAll removes them all, not just the last one.
const tmps: string[] = [];

beforeEach(() => {
  const tmp = makeTmp('memory-always-on');
  tmps.push(tmp);
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  for (const tmp of tmps) rmSync(tmp, { recursive: true, force: true });
});

describe('the entry cap', () => {
  test('grants up to the cap succeed; the grant past it is refused and names the valve', () => {
    const ids = Array.from({ length: ALWAYS_ON_MAX_ENTRIES + 1 }, (_, i) =>
      seed(`Always run check number ${i} before pushing to the remote`),
    );
    for (const id of ids.slice(0, ALWAYS_ON_MAX_ENTRIES)) approve(id, { alwaysOn: true });

    const over = ids[ALWAYS_ON_MAX_ENTRIES]!;
    expect(() => approve(over, { alwaysOn: true })).toThrow(AlwaysOnBudgetError);
    expect(() => approve(over, { alwaysOn: true })).toThrow(/--no-always-on/);
    expect(() => approve(over, { alwaysOn: true })).toThrow(new RegExp(`${ALWAYS_ON_MAX_ENTRIES} entries`));

    // The refusal recorded nothing: not the approval, not the flag.
    const row = listMemories().find((r) => r.id === over)!;
    expect({ state: row.state, alwaysOn: row.alwaysOn }).toEqual({ state: 'candidate', alwaysOn: false });
  });

  test('a plain approve is never budgeted — the cap gates the flag, not the memory', () => {
    for (let i = 0; i < ALWAYS_ON_MAX_ENTRIES; i++) {
      approve(seed(`Always run check number ${i} before pushing to the remote`), { alwaysOn: true });
    }
    const id = seed('Always update the changelog before tagging a release');
    expect(approve(id)).toBe(id);
    expect(listMemories().find((r) => r.id === id)?.state).toBe('approved');
  });

  test('re-approving an already-always-on row at the cap is idempotent, not a collision', () => {
    const ids = Array.from({ length: ALWAYS_ON_MAX_ENTRIES }, (_, i) =>
      seed(`Always run check number ${i} before pushing to the remote`),
    );
    for (const id of ids) approve(id, { alwaysOn: true });
    // Its slot transfers to itself; refusing here would make the cap a ratchet that
    // punishes re-confirmation, which is the opposite of what confirmation means.
    expect(approve(ids[0]!, { alwaysOn: true })).toBe(ids[0]!);
  });

  test('--no-always-on frees a slot a new grant can then take', () => {
    const ids = Array.from({ length: ALWAYS_ON_MAX_ENTRIES }, (_, i) =>
      seed(`Always run check number ${i} before pushing to the remote`),
    );
    for (const id of ids) approve(id, { alwaysOn: true });

    const blocked = seed('Never force push to a shared branch without asking first');
    expect(() => approve(blocked, { alwaysOn: true })).toThrow(AlwaysOnBudgetError);

    approve(ids[0]!, { alwaysOn: false });
    expect(listMemories().find((r) => r.id === ids[0])?.alwaysOn).toBe(false);
    expect(approve(blocked, { alwaysOn: true })).toBe(blocked);
  });
});

describe('the char cap', () => {
  test('a grant that fits the entry cap but blows the char budget is refused', () => {
    // Four long standing rows leave less headroom than the fifth needs; entries stay
    // far under the entry cap, so the refusal can only come from chars.
    const chunk = Math.floor(ALWAYS_ON_MAX_CHARS / 5) + 50;
    for (let i = 0; i < 4; i++) {
      const id = seed(`Always mirror rule number ${i} ` + 'x'.repeat(chunk));
      approve(id, { alwaysOn: true });
    }
    const fifth = seed('Always mirror rule number four ' + 'x'.repeat(chunk));
    expect(() => approve(fifth, { alwaysOn: true })).toThrow(AlwaysOnBudgetError);
    expect(() => approve(fifth, { alwaysOn: true })).toThrow(new RegExp(`${ALWAYS_ON_MAX_CHARS} chars`));
  });
});

describe('the flags', () => {
  test('--no-always-on parses to an explicit false, not an absence', () => {
    expect(parseTriageArgs(['abc', '--no-always-on']).alwaysOn).toBe(false);
    expect(parseTriageArgs(['abc']).alwaysOn).toBeUndefined();
  });

  test('contradictory flags are an error, not last-one-wins', () => {
    expect(() => parseTriageArgs(['abc', '--always-on', '--no-always-on'])).toThrow(UsageError);
    expect(() => parseTriageArgs(['abc', '--no-always-on', '--always-on'])).toThrow(/contradictory/);
    // Repeating one flag states one intent; only opposition is ambiguous.
    expect(parseTriageArgs(['abc', '--no-always-on', '--no-always-on']).alwaysOn).toBe(false);
  });

  test('--no-always-on is refused on reject and snooze like --always-on is', () => {
    const args = parseTriageArgs(['abc', '--no-always-on']);
    expect(() => assertActionAcceptsFlags('reject', args)).toThrow(UsageError);
    expect(() => assertActionAcceptsFlags('snooze', args)).toThrow(/--no-always-on/);
    expect(() => assertActionAcceptsFlags('approve', args)).not.toThrow();
  });
});

describe('the serve-side backstop', () => {
  test('an over-budget set (hand-edited past the gate) is served in full and stated loudly', async () => {
    // setAlwaysOn directly — the write approve() would refuse, standing in for a
    // hand-edited memory.db or a store written before the cap existed.
    for (let i = 0; i < ALWAYS_ON_MAX_ENTRIES + 1; i++) {
      const id = seed(`Always run check number ${i} before pushing to the remote`);
      setState(id, 'approved');
      setAlwaysOn(id, true);
    }

    const mcp = await import('../mcp');
    const result = await mcp.runGetMemory({ cwd: '/repos/anywhere' });
    // SAFETY: structuredContent is the get_memory payload contract the test asserts.
    const payload = result.structuredContent as { results: unknown[]; count: number; alwaysOnBudget?: string };
    // Served in FULL: truncating a standing constraint is the exact silent
    // suppression the flag exists to prevent. The note is the correction path.
    expect(payload.count).toBe(ALWAYS_ON_MAX_ENTRIES + 1);
    expect(payload.alwaysOnBudget).toContain('--no-always-on');
  });

  test('a set within budget carries no note', async () => {
    const id = seed('Never commit directly to main on any repo');
    approve(id, { alwaysOn: true });
    const mcp = await import('../mcp');
    const result = await mcp.runGetMemory({ cwd: '/repos/anywhere' });
    // SAFETY: structuredContent is the get_memory payload contract the test asserts.
    expect((result.structuredContent as { alwaysOnBudget?: string }).alwaysOnBudget).toBeUndefined();
  });
});
