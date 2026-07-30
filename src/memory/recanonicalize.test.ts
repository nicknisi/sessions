import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildRecord } from './record';
import { getMemoryDb, listMemories, upsertCandidates } from './store';
import { approve, mergeInto } from './triage';
import { activeMemoryFor } from './retrieve';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import type { MemoryRecord } from './types';

// `approve --as` — the write-back for the phrasing the triage skill judged canonical.
//
// A mined candidate is a verbatim user turn, and the miner cannot do better: it reads
// transcripts. Two of the first three memories approved on the author's own machine were
// QUESTIONS ("describe what it means to distill, accept, and reject. I don't understand
// when or why I'd use this"), stored as kind: 'instruction' and served to every later
// agent under a tool description that says to treat them as binding. The skill was
// already writing a clean statement of each fact in its report and then discarding it,
// because an id is a hash of its own text and `approve` took only an id.
//
// So the assertions here are about what a future agent RECEIVES, not about row states.

const REPO = '/repos/app';

function record(text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    ...buildRecord({
      text,
      scope: { type: 'repo', key: REPO },
      author: 'dev@example.com',
      sessions: ['/s/a.jsonl'],
      dates: ['2026-02-01'],
      distinctPhrasings: 1,
    }),
    ...over,
  };
}

/** The real shape: a question that implies a durable instruction. */
const ASKED = record("Cursor MCP config? I don't use Cursor", {
  evidence: {
    distinctPhrasings: 2,
    sessions: ['/s/a.jsonl', '/s/b.jsonl'],
    firstSeen: '2026-02-01',
    lastSeen: '2026-03-04',
  },
});
const FACT = 'Do not generate Cursor MCP config — Cursor is not used on this machine.';

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-recanonicalize');
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('approve --as stores the fact, not the utterance that implied it', () => {
  test('the canonical phrasing is what an agent receives', () => {
    upsertCandidates([ASKED]);

    const kept = approve(ASKED.id, { as: FACT });
    expect(kept).not.toBe(ASKED.id);

    // The assertion that the whole change exists for.
    const served = activeMemoryFor(REPO);
    expect(served).toHaveLength(1);
    expect(served[0]!.text).toBe(FACT);
    expect(served.some((r) => r.text.includes('?'))).toBe(false);
  });

  test('evidence transfers verbatim — the rewrite is not a phrasing the user used', () => {
    upsertCandidates([ASKED]);
    const kept = approve(ASKED.id, { as: FACT });

    const canonical = listMemories().find((r) => r.id === kept)!;
    // NOT 3. Counting the agent's sentence as a user phrasing would inflate the signal
    // `shouldResurface` and the cross-author quorum both rest on.
    expect(canonical.evidence.distinctPhrasings).toBe(2);
    expect(canonical.evidence.sessions).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
    expect(canonical.evidence.firstSeen).toBe('2026-02-01');
    expect(canonical.evidence.lastSeen).toBe('2026-03-04');
  });

  test('the original is kept as evidence, never deleted, and stops being offered', () => {
    upsertCandidates([ASKED]);
    const kept = approve(ASKED.id, { as: FACT });

    const original = listMemories().find((r) => r.id === ASKED.id)!;
    expect(original.state).toBe('merged');
    expect(original.mergedInto).toBe(kept);
    expect(original.text).toBe(ASKED.text);
    // Merged rows never re-enter a batch, so the raw question cannot be re-proposed.
    expect(listMemories({ state: 'candidate' })).toHaveLength(0);
  });

  test('members of the old canonical follow the fact, not the wording it used to have', () => {
    const para = record('no cursor here, skip its mcp file');
    upsertCandidates([ASKED, para]);
    mergeInto(ASKED.id, [para.id], '2026-03-05');

    const kept = approve(ASKED.id, { as: FACT });

    const moved = listMemories().find((r) => r.id === para.id)!;
    expect(moved.mergedInto).toBe(kept);
    expect(moved.state).toBe('merged');
  });

  test('a rewrite that normalizes onto the original approves in place', () => {
    upsertCandidates([ASKED]);
    const kept = approve(ASKED.id, { as: `  ${ASKED.text}  ` });
    expect(kept).toBe(ASKED.id);
    expect(listMemories().find((r) => r.id === ASKED.id)!.state).toBe('approved');
    // No self-merge: one row in, one row out.
    expect(listMemories()).toHaveLength(1);
  });

  test('always-on and scope land on the rewrite, not on the row that was replaced', () => {
    upsertCandidates([ASKED]);
    const kept = approve(ASKED.id, { as: FACT, alwaysOn: true });

    const canonical = listMemories().find((r) => r.id === kept)!;
    expect(canonical.alwaysOn).toBe(true);
    expect(canonical.state).toBe('approved');
    expect(listMemories().find((r) => r.id === ASKED.id)!.alwaysOn).toBe(false);
  });

  test('an empty phrasing is refused rather than storing a blank memory', () => {
    upsertCandidates([ASKED]);
    expect(() => approve(ASKED.id, { as: '   ' })).toThrow(/non-empty/);
    expect(listMemories().find((r) => r.id === ASKED.id)!.state).toBe('candidate');
  });
});
