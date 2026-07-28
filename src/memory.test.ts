import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvenance } from './provenance';
// Type-only, so it is erased and the module is still first loaded by the dynamic
// import below — after SESSIONS_MEMORY_DB points at this fixture.
import type { RememberInput, RememberResult } from './memory';

// The lesson store gets its own hermetic file. SESSIONS_MEMORY_DB exists for exactly
// this reason — without it every test here (and the primer) would read the machine's
// real lessons.
const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-memory-'));
const dbPath = join(fixtureRoot, 'memory.db');
process.env.SESSIONS_MEMORY_DB = dbPath;

const mem = await import('./memory');

const REPO = '/repo/alpha';
const REMOTE = 'github.com/nicknisi/alpha';

const NO_SOURCE: SessionProvenance = {
  sessionId: null,
  transcript: null,
  toolUseId: null,
  provenance: 'none',
  verified: false,
  tool: '',
};

const HOOK_SOURCE: SessionProvenance = {
  sessionId: '11772ef1-6b80-46ec-9f32-97cd785efa1f',
  transcript: '/transcripts/11772ef1.jsonl',
  toolUseId: 'toolu_01LRwx',
  provenance: 'hook',
  verified: true,
  tool: 'claude',
};

function save(lesson: string, over: Partial<RememberInput> = {}): RememberResult {
  return mem.rememberLesson({
    lesson,
    container: REPO,
    remote: REMOTE,
    source: NO_SOURCE,
    ...over,
  });
}

beforeEach(() => {
  process.env.SESSIONS_MEMORY_DB = dbPath;
  mem.closeMemoryDb();
  for (const f of readdirSync(fixtureRoot)) unlinkSync(join(fixtureRoot, f));
});

afterAll(() => {
  mem.closeMemoryDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the store is not conjured by reading', () => {
  test('no memory.db means no lessons and no file left behind', () => {
    expect(existsSync(dbPath)).toBe(false);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5)).toEqual(mem.NO_LESSONS);
    expect(mem.countLessons()).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('a write creates it at the current schema version', () => {
    expect(save('Bound lesson length at write, not at read.').outcome).toBe('saved');
    expect(existsSync(dbPath)).toBe(true);
    mem.closeMemoryDb();
    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION,
    );
    db.close();
  });
});

describe('write-time bounds', () => {
  test('an over-length lesson is rejected with an instruction to compress, not truncated', () => {
    const res = save('x'.repeat(mem.LESSON_MAX_CHARS + 1));
    expect(res.outcome).toBe('rejected');
    expect(res.message).toContain('compress');
    expect(mem.countLessons()).toBe(0);
  });

  test('an over-length detail is rejected', () => {
    const res = save('A short lesson.', { detail: 'y'.repeat(mem.DETAIL_MAX_CHARS + 1) });
    expect(res.outcome).toBe('rejected');
    expect(mem.countLessons()).toBe(0);
  });

  test('repo scope outside a git repo is rejected, pointing at global scope', () => {
    const res = mem.rememberLesson({ lesson: 'Something true.', source: NO_SOURCE });
    expect(res.outcome).toBe('rejected');
    expect(res.message).toContain('global');
  });

  test('a lesson at exactly the limit is accepted', () => {
    expect(save('z'.repeat(mem.LESSON_MAX_CHARS)).outcome).toBe('saved');
  });
});

describe('idempotency', () => {
  test('an exact re-save bumps last_seen_at and inserts nothing', () => {
    const first = save('Release-please only bumps package.json, so plugin manifests go stale.', {
      now: '2026-07-01T00:00:00.000Z',
    });
    const again = save('  Release-please only bumps package.json, so plugin manifests go stale.  ', {
      now: '2026-07-20T00:00:00.000Z',
    });

    expect(again.outcome).toBe('known');
    expect(again.id).toBe(first.id!);
    expect(mem.countLessons()).toBe(1);

    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.created_at).toBe('2026-07-01T00:00:00.000Z');
    expect(row.last_seen_at).toBe('2026-07-20T00:00:00.000Z');
  });

  test('punctuation and case do not create a second row', () => {
    save('Bound lesson length at write, not at read.');
    const again = save('bound lesson length at write not at read');
    expect(again.outcome).toBe('known');
    expect(mem.countLessons()).toBe(1);
  });

  test('the same sentence in a different repo is a different lesson', () => {
    save('Bound lesson length at write, not at read.');
    const other = save('Bound lesson length at write, not at read.', { container: '/repo/beta', remote: '' });
    expect(other.outcome).toBe('saved');
    expect(mem.countLessons()).toBe(2);
  });
});

// The thresholds are guesses. This corpus is what turns tuning them into a data
// change: every pair is hand-labelled, and the assertions below say what each label
// must do at the shipped constants.
type Label = 'same' | 'conflict' | 'distinct';
const PAIRS: [string, string, Label][] = [
  [
    'stdio MCP servers need an explicit exit on stdin end or close',
    'stdio MCP servers need explicit exit on stdin end/close',
    'same',
  ],
  ['Bound lesson length at write, not at read.', 'bound lesson length at write — not at read', 'same'],
  [
    'The CLI entrypoint is the root index.ts, not src/ — grep the root before calling code dead.',
    'The CLI entrypoint is the root index.ts (not src/); grep the root before calling code dead',
    'same',
  ],
  [
    'Release-please only bumps package.json, so plugin manifests go stale.',
    'release-please only bumps package.json so the plugin manifests go stale',
    'same',
  ],
  [
    'The lesson store lives outside the cache directory.',
    'The lesson store lives inside the cache directory.',
    'conflict',
  ],
  [
    'Index rebuilds are triggered by a SCHEMA_VERSION bump.',
    'Index rebuilds are triggered by a SCHEMA_VERSION bump or an mtime change.',
    'conflict',
  ],
  [
    'Run the migration ladder before opening the database.',
    'Run the migration ladder after opening the database read-only.',
    'conflict',
  ],
  [
    'Session ids for Codex come from the rollout filename.',
    'Session ids for Codex come from the session_meta payload, not the rollout filename.',
    'conflict',
  ],
  [
    'The primer surfaces lessons before recent sessions.',
    'The primer surfaces recent sessions before earlier headlines.',
    'distinct',
  ],
  ['Bound lesson length at write, not at read.', 'stdio MCP servers need an explicit exit on stdin end', 'distinct'],
  [
    'Never delete a database that cannot be rebuilt from the transcripts.',
    'Prefer container matching over remote matching when scoping a repo.',
    'distinct',
  ],
  [
    'Codex passes session identity in _meta on every tool call.',
    'Claude Code passes a tool_use id in _meta but never a session id.',
    'distinct',
  ],
  [
    'Tests must set SESSIONS_MEMORY_DB so the primer never reads real lessons.',
    'Tests must set SESSIONS_CACHE_DIR so the index never reads the real cache.',
    'distinct',
  ],
  [
    'grep_sessions is exhaustive; search_sessions is top-k.',
    'get_session_digest is bounded; get_session_messages is not.',
    'distinct',
  ],
];

describe('jaccard thresholds', () => {
  test('every reworded pair reads as the same lesson', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'same') continue;
      expect(mem.jaccard(a, b)).toBeGreaterThanOrEqual(mem.SAME_LESSON_JACCARD);
    }
  });

  test('every conflicting pair lands in the review band', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'conflict') continue;
      const j = mem.jaccard(a, b);
      expect(j).toBeGreaterThanOrEqual(mem.REVIEW_JACCARD);
      expect(j).toBeLessThan(mem.SAME_LESSON_JACCARD);
    }
  });

  test('no distinct pair is ever mistaken for the same lesson', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'distinct') continue;
      expect(mem.jaccard(a, b)).toBeLessThan(mem.SAME_LESSON_JACCARD);
    }
  });

  test('at most one distinct pair is over-flagged into review', () => {
    // The band buys recall on purpose: a missed conflict serves two contradictory
    // lessons as fact, while an over-flag costs one keep-both keystroke. One pair in
    // this corpus (two true statements about primer ordering) pays that cost.
    const overFlagged = PAIRS.filter(
      ([a, b, label]) => label === 'distinct' && mem.jaccard(a, b) >= mem.REVIEW_JACCARD,
    );
    expect(overFlagged.length).toBeLessThanOrEqual(1);
  });

  // Set similarity is blind to word order, so a claim and its reversal score a
  // perfect 1.0. sameStatement is the guard, and these are the pairs that prove it
  // is load-bearing rather than decorative.
  const REVERSALS: [string, string][] = [
    ['The retry budget is per-endpoint, not per-account.', 'The retry budget is per-account, not per-endpoint.'],
    ['Bound lesson length at write, not at read.', 'Bound lesson length at read, not at write.'],
    ['Prefer the container key over the remote key.', 'Prefer the remote key over the container key.'],
  ];

  test('a reversed claim scores as identical and is still not the same statement', () => {
    for (const [a, b] of REVERSALS) {
      expect(mem.jaccard(a, b)).toBe(1);
      expect(mem.sameStatement(a, b)).toBe(false);
    }
  });

  test('a genuine reword is the same statement', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'same') continue;
      expect(mem.sameStatement(a, b)).toBe(true);
    }
  });

  test('jaccard is symmetric and self-identical', () => {
    const [a, b] = PAIRS[4]!;
    expect(mem.jaccard(a, b)).toBeCloseTo(mem.jaccard(b, a), 10);
    expect(mem.jaccard(a, a)).toBe(1);
  });
});

describe('near-duplicates flag both rows', () => {
  const A = 'The lesson store lives outside the cache directory.';
  const B = 'The lesson store lives inside the cache directory.';

  test('a conflicting save quarantines the incumbent as well as the newcomer', () => {
    const first = save(A);
    const second = save(B);

    expect(second.outcome).toBe('conflict');
    expect(second.conflicts).toEqual([{ id: first.id!, lesson: A, status: 'needs_review' }]);

    const rows = mem.listLessons({ container: REPO, remote: REMOTE });
    expect(rows.map((r) => r.status)).toEqual(['needs_review', 'needs_review']);
    expect(new Set(rows.map((r) => r.review_group))).toEqual(new Set([second.id!]));
  });

  test('neither conflicting row is served, and the count is', () => {
    save(A);
    save(B);
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons).toEqual([]);
    expect(read.flagged).toBe(2);
    expect(read.total).toBe(0);
  });

  test('nothing is merged or overwritten — the incumbent text is byte-identical', () => {
    const first = save(A);
    save(B);
    const incumbent = mem.listLessons({ container: REPO, remote: REMOTE }).find((r) => r.id === first.id)!;
    expect(incumbent.lesson).toBe(A);
  });

  test('a same-lesson reword bumps the incumbent instead of flagging', () => {
    const first = save('stdio MCP servers need an explicit exit on stdin end or close');
    const again = save('stdio MCP servers need explicit exit on stdin end/close');
    expect(again.outcome).toBe('known');
    expect(again.id).toBe(first.id!);
    expect(mem.countLessons()).toBe(1);
  });

  test('a reversed claim is flagged as a conflict, not swallowed as a duplicate', () => {
    const first = save('The retry budget is per-endpoint, not per-account.');
    const reversed = save('The retry budget is per-account, not per-endpoint.');

    expect(reversed.outcome).toBe('conflict');
    expect(reversed.conflicts).toEqual([
      { id: first.id!, lesson: 'The retry budget is per-endpoint, not per-account.', status: 'needs_review' },
    ]);
    expect(mem.countLessons()).toBe(2);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).flagged).toBe(2);
  });

  test('a lesson in another repo never conflicts with this one', () => {
    save(A);
    const other = save(B, { container: '/repo/beta', remote: '' });
    expect(other.outcome).toBe('saved');
    expect(other.status).toBe('active');
  });
});

/**
 * The reword-and-resave loop. The tool description forbids it, and until the shortlist
 * looked past `active` rows nothing enforced it: a third phrasing of a contested claim
 * was served as fact directly above the line saying two lessons were withheld.
 */
describe('a rewording cannot walk around the review', () => {
  const A = 'The lesson store lives outside the cache directory.';
  const B = 'The lesson store lives inside the cache directory.';
  const C = 'The lesson store lives within the cache directory tree.';

  test('a third phrasing joins the pending group instead of going live', () => {
    const first = save(A);
    const second = save(B);
    const third = save(C);

    expect(third.outcome).toBe('conflict');
    expect(third.status).toBe('needs_review');
    expect(third.reviewGroup).toBe(second.reviewGroup!);

    const groups = mem.reviewGroups();
    expect(groups.length).toBe(1);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual([first.id!, second.id!, third.id!]);

    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons).toEqual([]);
    expect(read.flagged).toBe(3);
  });

  test('one resolution decides every phrasing, because they are one group', () => {
    save(A);
    save(B);
    const third = save(C);
    expect(mem.resolveReview(third.reviewGroup!, 'new')).toBe(3);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.lesson)).toEqual([C]);
  });

  test('two pending groups merge when one lesson overlaps both', () => {
    // Constructed to sit either side of the band: the two pairs are 0.429 apart, so
    // they open separate groups, and the newcomer is 0.667 from all four. Leaving the
    // groups apart would let a human resolve one and put its rivals back into service
    // while the same argument is still open in the other.
    const a1 = save('The primer budget caps lessons and headlines.');
    const a2 = save('The primer budget caps lessons and files.');
    const b1 = save('The primer budget caps commands and errors.');
    const b2 = save('The primer budget caps commands and thinking.');
    expect(mem.reviewGroups().length).toBe(2);

    const bridge = save('The primer budget caps lessons and commands.');
    expect(bridge.outcome).toBe('conflict');

    const groups = mem.reviewGroups();
    expect(groups.length).toBe(1);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual([a1.id!, a2.id!, b1.id!, b2.id!, bridge.id!]);
  });
});

/**
 * Retirement is a human decision. The content hash catches an exact re-save, but only
 * a shortlist that sees retired rows catches the rewording that walks around it.
 */
describe('a retirement cannot be paraphrased around', () => {
  const OUT = 'The lesson store lives outside the cache directory.';

  test('a reworded retired lesson is recognized, not re-admitted as a fresh row', () => {
    const saved = save('stdio MCP servers need an explicit exit on stdin end or close');
    mem.retireLesson(saved.id!);

    const again = save('stdio MCP servers need explicit exit on stdin end/close');
    expect(again.outcome).toBe('known');
    expect(again.id).toBe(saved.id!);
    expect(again.status).toBe('retired');
    expect(again.message).toContain('was retired and is not served');
    expect(mem.countLessons()).toBe(1);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
  });

  test('an overlapping claim is withheld, and the retired row is left exactly as it is', () => {
    const saved = save(OUT);
    mem.retireLesson(saved.id!);

    const res = save('The lesson store lives inside the cache directory.');
    expect(res.outcome).toBe('conflict');
    expect(res.conflicts).toEqual([{ id: saved.id!, lesson: OUT, status: 'retired' }]);
    expect(mem.listLessons({ all: true }).find((r) => r.id === saved.id)!.status).toBe('retired');
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
  });

  test('the retired row rides the review as context and is never revived by it', () => {
    const saved = save(OUT);
    mem.retireLesson(saved.id!);
    const res = save('The lesson store lives inside the cache directory.');

    expect(mem.reviewGroups()[0]!.rows.map((r) => r.status)).toEqual(['retired', 'needs_review']);

    // Only the pending row is decided; the retirement is not up for a vote.
    expect(mem.resolveReview(res.reviewGroup!, 'new')).toBe(1);
    const row = mem.listLessons({ all: true }).find((r) => r.id === saved.id)!;
    expect(row.status).toBe('retired');
    expect(row.review_group).toBeNull();
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.id)).toEqual([res.id!]);
  });
});

describe('review resolution', () => {
  const A = 'Index rebuilds are triggered by a SCHEMA_VERSION bump.';
  const B = 'Index rebuilds are triggered by a SCHEMA_VERSION bump or an mtime change.';

  test('keep-new supersedes the incumbent and never deletes it', () => {
    const first = save(A);
    const second = save(B);
    expect(mem.resolveReview(second.reviewGroup!, 'new')).toBe(2);

    const rows = mem.listLessons({ container: REPO, remote: REMOTE, all: true });
    const oldRow = rows.find((r) => r.id === first.id)!;
    const newRow = rows.find((r) => r.id === second.id)!;
    expect(oldRow.status).toBe('superseded');
    expect(oldRow.superseded_by).toBe(newRow.id);
    expect(newRow.status).toBe('active');
    expect(newRow.supersedes_id).toBe(oldRow.id);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.lesson)).toEqual([B]);
  });

  test('keep-old retires the newcomer and restores the incumbent', () => {
    save(A);
    const second = save(B);
    mem.resolveReview(second.reviewGroup!, 'old');
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.lesson)).toEqual([A]);
  });

  test('keep-both reactivates every row in the group', () => {
    save(A);
    const second = save(B);
    mem.resolveReview(second.reviewGroup!, 'both');
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.length).toBe(2);
    expect(read.flagged).toBe(0);
  });

  test('reviewGroups lists the pending conflicts and empties once resolved', () => {
    save(A);
    const second = save(B);
    expect(mem.reviewGroups().map((g) => g.rows.length)).toEqual([2]);
    mem.resolveReview(second.reviewGroup!, 'both');
    expect(mem.reviewGroups()).toEqual([]);
  });

  test('keep-new with several losers records the oldest as its lineage, not the last', () => {
    const first = save('The lesson store lives outside the cache directory.');
    const second = save('The lesson store lives inside the cache directory.');
    const third = save('The lesson store lives within the cache directory tree.');
    mem.resolveReview(third.reviewGroup!, 'new');

    const rows = mem.listLessons({ all: true });
    // One column, three rows: it points at the original claim, and every loser still
    // names the winner, so no row in the chain is unreachable.
    expect(rows.find((r) => r.id === third.id)!.supersedes_id).toBe(first.id!);
    expect(rows.find((r) => r.id === first.id)!.superseded_by).toBe(third.id!);
    expect(rows.find((r) => r.id === second.id)!.superseded_by).toBe(third.id!);
  });
});

/**
 * Two agent windows closing on the same finding at the same second. The hash SELECT
 * and the INSERT are not one atomic step, so the losers used to die on the UNIQUE
 * index and hand the agent a raw SQLITE_CONSTRAINT instead of "already known".
 *
 * Real processes, not a simulated race: the bug needs two separate SQLite connections,
 * each of which genuinely missed the other's row before writing.
 */
describe('concurrent writers', () => {
  const WRITER = join(import.meta.dir, '__fixtures__', 'concurrent-remember.ts');
  const LESSON = 'Two sessions can reach the same conclusion in the same second.';

  test('ten processes saving one lesson land one row, and none of them crash', async () => {
    // The store already exists, so what races is only the save: the content_hash miss
    // followed by the INSERT that meets the UNIQUE index the other writer just filled.
    save('An unrelated lesson that creates the store first.');
    mem.closeMemoryDb();

    const gate = join(fixtureRoot, 'go');
    const procs = Array.from({ length: 10 }, () =>
      Bun.spawn([process.execPath, 'run', WRITER, LESSON, gate], {
        env: { ...process.env, SESSIONS_MEMORY_DB: dbPath },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    // Every process is up and spinning on the gate before any of them may write.
    await Bun.sleep(300);
    writeFileSync(gate, '');

    const results = await Promise.all(
      procs.map(async (p) => ({
        code: await p.exited,
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
      })),
    );

    for (const r of results) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });

    const outcomes = results.map((r) => JSON.parse(r.out).outcome);
    expect(outcomes.filter((o) => o === 'saved').length).toBe(1);
    expect(outcomes.filter((o) => o === 'known').length).toBe(9);

    mem.closeMemoryDb(); // the writes belong to the children; reopen the file
    expect(mem.countLessons()).toBe(2);
    expect(mem.listLessons({ all: true }).filter((r) => r.lesson === LESSON).length).toBe(1);
  });
});

/**
 * Corruption is the one failure that must not be quiet. The bytes are kept — but a
 * rename nobody mentions reads exactly like "you never saved anything", and a read
 * that then creates a fresh file starts a second store the first one can never merge
 * back into.
 */
describe('a corrupt store is loud, and a read never replaces it', () => {
  const GARBAGE = 'this is not a sqlite database at all';

  function corruptFiles(): string[] {
    return readdirSync(fixtureRoot).filter((f) => f.includes('.corrupt-'));
  }

  test('a read sets the bytes aside and conjures nothing in their place', () => {
    writeFileSync(dbPath, GARBAGE);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);

    expect(existsSync(dbPath)).toBe(false);
    expect(corruptFiles().length).toBe(1);
    expect(readFileSync(join(fixtureRoot, corruptFiles()[0]!), 'utf-8')).toBe(GARBAGE);
  });

  test('the read says what happened instead of reporting an empty store', () => {
    writeFileSync(dbPath, GARBAGE);
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.quarantined.length).toBe(1);
    expect(read.quarantined[0]).toContain('memory.db.corrupt-');
  });

  test('the notice outlives the process that made it, and the store that replaced it', () => {
    writeFileSync(dbPath, GARBAGE);
    expect(save('A lesson written after the corruption.').outcome).toBe('saved');
    mem.closeMemoryDb();

    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.length).toBe(1);
    // Read off the directory, not off a flag in memory: the divergence between the two
    // files has no merge path, so it is reported until one of them is dealt with.
    expect(read.quarantined.length).toBe(1);
  });

  test('a healthy store reports no quarantine', () => {
    save('An ordinary lesson in an ordinary store.');
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).quarantined).toEqual([]);
  });
});

describe('retiring by hand', () => {
  test('a retired lesson leaves the primer but stays readable', () => {
    const saved = save('A lesson that should not have been saved.');
    expect(mem.retireLesson(saved.id!)).toBe(true);

    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
    const row = mem.listLessons({ all: true })[0]!;
    expect(row.status).toBe('retired');
    expect(row.lesson).toBe('A lesson that should not have been saved.');
  });

  test('retiring an unknown or already-retired lesson reports no change', () => {
    const saved = save('A lesson that should not have been saved.');
    expect(mem.retireLesson(999)).toBe(false);
    expect(mem.retireLesson(saved.id!)).toBe(true);
    expect(mem.retireLesson(saved.id!)).toBe(false);
  });

  test('a retired lesson does not block re-saving the same text later', () => {
    const saved = save('A lesson that should not have been saved.');
    mem.retireLesson(saved.id!);
    // The content hash is still taken, so this is recognized rather than duplicated —
    // and the retirement holds, which the caller is told rather than left to assume.
    const again = save('A lesson that should not have been saved.');
    expect(again.outcome).toBe('known');
    expect(again.status).toBe('retired');
    expect(again.message).toContain('was retired and is not served');
    expect(mem.countLessons()).toBe(1);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
  });
});

describe('explicit supersession', () => {
  test('supersedes retires the old row and skips the review band', () => {
    const first = save('The lesson store lives outside the cache directory.');
    const second = save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(second.outcome).toBe('saved');
    expect(second.status).toBe('active');

    const rows = mem.listLessons({ all: true });
    expect(rows.find((r) => r.id === first.id)!.status).toBe('superseded');
    expect(rows.find((r) => r.id === second.id)!.supersedes_id).toBe(first.id!);
  });

  test('superseding an unknown or already-superseded lesson is refused', () => {
    expect(save('A new claim.', { supersedes: 999 }).outcome).toBe('rejected');
    const first = save('The lesson store lives outside the cache directory.');
    save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(save('A third position entirely.', { supersedes: first.id }).outcome).toBe('rejected');
  });
});

/**
 * A stated relationship is not a checked one. Skipping the scan made `supersedes` a
 * kill switch nobody reviewed: any id, hallucinated or off by one, took a lesson out
 * of service, and the default listing did not show that it had happened.
 */
describe('supersedes is checked, not obeyed', () => {
  const STORE = 'The lesson store lives outside the cache directory.';
  const UNRELATED = 'Worktrees collapse to one container key, so a branch lesson applies on main.';

  test('an id naming something unrelated retires nothing and goes to review', () => {
    const first = save(STORE);
    const res = save(UNRELATED, { supersedes: first.id });

    expect(res.outcome).toBe('conflict');
    expect(res.status).toBe('needs_review');
    expect(res.message).toContain('nothing was retired');
    expect(res.conflicts).toEqual([{ id: first.id!, lesson: STORE, status: 'active' }]);

    const rows = mem.listLessons({ all: true });
    expect(rows.find((r) => r.id === first.id)!.status).toBe('active');
    expect(rows.find((r) => r.id === res.id)!.supersedes_id).toBeNull();
    // Only the unchecked claim is withheld — the lesson it aimed at is still served.
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.id)).toEqual([first.id!]);
  });

  test('resolving that review leaves the mis-named target alone either way', () => {
    const first = save(STORE);
    const res = save(UNRELATED, { supersedes: first.id });
    expect(mem.resolveReview(res.reviewGroup!, 'new')).toBe(1);

    const rows = mem.listLessons({ all: true });
    expect(rows.find((r) => r.id === first.id)!.status).toBe('active');
    expect(rows.find((r) => r.id === first.id)!.review_group).toBeNull();
    expect(rows.find((r) => r.id === res.id)!.status).toBe('active');
  });

  test('a correction that also contests a third lesson waits for the human', () => {
    const first = save('Index rebuilds are triggered by a SCHEMA_VERSION bump.');
    const third = save('Index rebuilds are triggered by an mtime change.');
    expect(third.outcome).toBe('saved');

    const res = save('Index rebuilds are triggered by a SCHEMA_VERSION bump or an mtime change.', {
      supersedes: first.id,
    });
    expect(res.outcome).toBe('conflict');

    // Nothing is retired ahead of the decision: superseding the target while the
    // replacement is itself withheld would empty the shelf and serve nothing.
    const rows = mem.listLessons({ all: true });
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.status === 'needs_review')).toBe(true);
    expect(rows.find((r) => r.id === first.id)!.superseded_by).toBeNull();

    // Keeping the correction is what finally performs the supersession.
    expect(mem.resolveReview(res.reviewGroup!, 'new')).toBe(3);
    const after = mem.listLessons({ all: true });
    expect(after.find((r) => r.id === first.id)!.superseded_by).toBe(res.id!);
    expect(after.find((r) => r.id === third.id)!.superseded_by).toBe(res.id!);
  });

  test('a mis-aimed id does not drag its target out of the review it is already in', () => {
    const a = save('The lesson store lives outside the cache directory.');
    const b = save('The lesson store lives inside the cache directory.');
    expect(b.outcome).toBe('conflict');

    // #a is pending in its own argument. Naming it here must not move it into this one.
    const res = save('Timezone bucketing happens once, in the report pipeline.', { supersedes: a.id });
    expect(res.outcome).toBe('conflict');

    const groups = mem.reviewGroups();
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.group === b.reviewGroup)!.rows.map((r) => r.id)).toEqual([a.id!, b.id!]);
    expect(groups.find((g) => g.group === res.reviewGroup)!.rows.map((r) => r.id)).toEqual([res.id!]);
  });

  test('a supersedes dropped by an already-known lesson is said out loud', () => {
    const first = save(STORE);
    const other = save('Timezone bucketing happens once, in the report pipeline.');
    const again = save('Timezone bucketing happens once, in the report pipeline.', { supersedes: first.id });

    expect(again.outcome).toBe('known');
    expect(again.id).toBe(other.id!);
    expect(again.message).toContain(`The supersedes of #${first.id} was not applied`);
    expect(mem.listLessons({ all: true }).find((r) => r.id === first.id)!.status).toBe('active');
  });
});

// Seven lessons with nothing in common — the fill for limit/ordering tests. Anything
// less varied gets quarantined as a near-duplicate before the assertion runs.
const UNRELATED = [
  'Worktrees collapse to one container key, so a branch lesson applies on main.',
  'Timezone bucketing happens once, in the report pipeline.',
  'Trajectory export drops reasoning blocks the format cannot carry.',
  'The fzf picker reads from stderr so stdout stays pipeable.',
  'Pricing data is fetched at build time and embedded.',
  'OpenCode keeps every conversation in one SQLite file.',
  'A junk scope in the corpus means an automated probe, not real work.',
];

describe('scope and retrieval', () => {
  test('repo lessons come before global ones, newest first inside each tier', () => {
    save('Repo lesson one about the alpha indexer.', { now: '2026-07-01T00:00:00.000Z' });
    save('Repo lesson two about alpha queue draining.', { now: '2026-07-02T00:00:00.000Z' });
    save('A global truth about stdio transports everywhere.', { scope: 'global', now: '2026-07-03T00:00:00.000Z' });

    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.map((l) => l.scope)).toEqual(['repo', 'repo', 'global']);
    expect(read.lessons[0]!.lesson).toContain('queue draining');
  });

  test('global lessons reach a repo that has none of its own', () => {
    save('A global truth about stdio transports everywhere.', { scope: 'global' });
    const read = mem.readLessonsForRepo('/repo/unrelated', '', 5);
    expect(read.lessons.map((l) => l.scope)).toEqual(['global']);
  });

  test('another repo never sees this one repo-scoped lessons', () => {
    save('Repo lesson one about the alpha indexer.');
    expect(mem.readLessonsForRepo('/repo/beta', 'github.com/nicknisi/beta', 5).lessons).toEqual([]);
  });

  test('the remote matches a moved checkout the container no longer names', () => {
    save('Repo lesson one about the alpha indexer.');
    const moved = mem.readLessonsForRepo('/elsewhere/alpha', REMOTE, 5);
    expect(moved.lessons.length).toBe(1);
  });

  test('total counts what the limit left out, so the primer can say +N more', () => {
    UNRELATED.forEach((l, i) => save(l, { now: `2026-07-0${i + 1}T00:00:00.000Z` }));
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.length).toBe(5);
    expect(read.total).toBe(UNRELATED.length);
  });

  test('a global lesson never displaces a repo one when the limit bites', () => {
    save('A global truth about stdio transports everywhere.', { scope: 'global', now: '2026-07-09T00:00:00.000Z' });
    UNRELATED.slice(0, 5).forEach((l, i) => save(l, { now: `2026-07-0${i + 1}T00:00:00.000Z` }));
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.every((l) => l.scope === 'repo')).toBe(true);
  });

  test('superseded and retired rows are not served', () => {
    const first = save('The lesson store lives outside the cache directory.');
    save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.id)).not.toContain(first.id);
  });
});

describe('provenance is carried, never invented', () => {
  test('a verified hook source is stored whole', () => {
    const res = save('A lesson with real provenance.', { source: HOOK_SOURCE });
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(res.provenance).toBe('hook');
    expect(row.source_session).toBe(HOOK_SOURCE.sessionId);
    expect(row.source_transcript).toBe(HOOK_SOURCE.transcript);
    expect(row.source_verified).toBe(1);
  });

  test("an unresolvable source stores nulls and says 'none'", () => {
    save('A lesson with no provenance at all.');
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.source_session).toBeNull();
    expect(row.source_transcript).toBeNull();
    expect(row.source_tool_use_id).toBeNull();
    expect(row.provenance).toBe('none');
    expect(row.source_verified).toBe(0);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons[0]!.verified).toBe(false);
  });

  test('a deferred row is recoverable and promotes to recovered', () => {
    save('A lesson saved with only a tool-use id.', {
      source: {
        sessionId: null,
        transcript: null,
        toolUseId: 'toolu_01Deferred',
        provenance: 'deferred',
        verified: false,
        tool: 'claude',
      },
    });
    const pending = mem.deferredLessons();
    expect(pending.map((r) => r.source_tool_use_id)).toEqual(['toolu_01Deferred']);

    mem.recoverLesson(pending[0]!.id, 'sess-abc', '/transcripts/sess-abc.jsonl');
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.provenance).toBe('recovered');
    expect(row.source_session).toBe('sess-abc');
    expect(row.source_verified).toBe(1);
    expect(mem.deferredLessons()).toEqual([]);
  });
});

describe('export', () => {
  test('every row round-trips through export, including quarantined ones', () => {
    save('The lesson store lives outside the cache directory.', { source: HOOK_SOURCE, files: ['src/memory.ts'] });
    save('The lesson store lives inside the cache directory.');

    const exported = mem.exportLessons();
    expect(exported.length).toBe(2);
    expect(exported[0]!.files).toEqual(['src/memory.ts']);
    expect(exported[0]!.source.provenance).toBe('hook');
    expect(exported.every((e) => e.status === 'needs_review')).toBe(true);
    // Portable on its own: no ids into another table, no columns that need the mirror.
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });
});

describe('the migration ladder', () => {
  test('a later version is applied over an existing file, and the row survives', () => {
    save('A lesson written by the current build.', { detail: 'root cause and fix', now: '2026-07-01T00:00:00.000Z' });
    mem.closeMemoryDb();

    // A synthetic step one past the real ladder. The already-applied step must be
    // skipped, not re-run — the ladder walks from the file's version, never from zero.
    // Both `to`s are relative to MEMORY_SCHEMA_VERSION on purpose: pinning them to 1
    // and 2 made this test go quietly green (and stop asserting anything) the moment a
    // real step 2 landed, because then both synthetic steps are behind the file.
    const current = mem.MEMORY_SCHEMA_VERSION;
    const db = new Database(dbPath);
    const applied = mem.applyMigrations(db, [
      {
        to: current,
        up: () => {
          throw new Error(`v${current} must not re-run on a v${current} file`);
        },
      },
      {
        to: current + 1,
        up: (d) => d.run("ALTER TABLE lessons ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown'"),
      },
    ]);

    expect(applied).toBe(current + 1);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(current + 1);
    const row = db.query<{ lesson: string; detail: string; confidence: string }, []>('SELECT * FROM lessons').get()!;
    expect(row.lesson).toBe('A lesson written by the current build.');
    expect(row.detail).toBe('root cause and fix');
    expect(row.confidence).toBe('unknown');
    db.close();
  });

  test('the forward migration preserves every existing row and its supersedes chain', () => {
    const first = save('The limiter counts preflight requests against the budget.');
    const second = save('The limiter does not count preflight requests against the budget.', {
      supersedes: first.id,
      detail: 'src/limiter.ts',
    });
    expect(second.outcome).toBe('saved');
    const before = mem.exportLessons();
    mem.closeMemoryDb();

    // Wind the file back to v1 to stand in for a store written before 'proposed'
    // existed. v2 is a version bump with no DDL — which is exactly why "did anything
    // move?" is the only thing worth asserting about it.
    const older = new Database(dbPath);
    older.run('PRAGMA user_version = 1');
    older.close();

    // Reopening runs the ladder.
    expect(mem.listLessons({ all: true }).length).toBe(2);
    const after = mem.exportLessons();
    expect(after).toEqual(before);
    const chain = mem.listLessons({ all: true });
    const superseded = chain.find((r) => r.id === first.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.superseded_by).toBe(second.id!);
    expect(chain.find((r) => r.id === second.id)!.supersedes_id).toBe(first.id!);

    mem.closeMemoryDb();
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION,
    );
    check.close();
  });

  // A store written before `proposed` was removed still holds those rows, and the two
  // guards that made them safe are gone with it. Left in place they are landmines: the
  // shortlist would offer them as near-duplicate candidates, so a genuine save whose
  // wording overlaps a machine guess nobody read comes back quarantined.
  test('the v3 rung retires leftover proposals and takes them out of the shortlist', () => {
    const keep = save('The staging limiter counts preflight requests against the budget.');
    expect(keep.outcome).toBe('saved');
    mem.closeMemoryDb();

    // Forge a store that still has a proposal in it, exactly as a pre-removal build left
    // one: a row with the dead status AND a live lessons_fts entry.
    const legacy = new Database(dbPath);
    legacy.run(
      `INSERT INTO lessons (content_hash, lesson, detail, scope, repo_container, repo_remote, files, tool,
                            source_session, source_transcript, source_tool_use_id, provenance, source_verified,
                            status, created_at, last_seen_at)
       VALUES ('deadbeef', ?, '', 'repo', ?, ?, '[]', 'claude', NULL, NULL, NULL, 'distilled', 0,
               'proposed', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
      ['The retry budget is counted per-endpoint and not per-account at all.', REPO, REMOTE],
    );
    const id = legacy.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
    legacy.run('INSERT INTO lessons_fts (id, lesson, detail) VALUES (?, ?, ?)', [
      id,
      'The retry budget is counted per-endpoint and not per-account at all.',
      '',
    ]);
    legacy.run('PRAGMA user_version = 2');
    legacy.close();

    // Reopening runs the ladder.
    const rows = mem.listLessons({ all: true });
    const migrated = rows.find((r) => r.id === id)!;
    expect(migrated.status).toBe('retired');
    // Kept, never deleted — still readable, still exported, still owns its content_hash.
    expect(migrated.lesson).toContain('per-endpoint');
    expect(mem.exportLessons().some((l) => l.id === id)).toBe(true);
    expect(rows.find((r) => r.id === keep.id)!.status).toBe('active');

    // The assertion the rung exists for: overlapping text from a real agent saves
    // cleanly instead of being quarantined against the retired machine guess.
    const genuine = save('The retry budget is counted per-endpoint, not per-account.');
    expect(genuine.outcome).toBe('saved');
    expect(genuine.status).toBe('active');
    expect(mem.readLessonsForRepo(REPO, REMOTE, 10).flagged).toBe(0);

    mem.closeMemoryDb();
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM lessons_fts WHERE id = ?').get(id)?.n).toBe(
      0,
    );
    expect(check.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION,
    );
    check.close();
  });

  test('a file newer than the build is served read-only, never rewritten', () => {
    save('A lesson from the future build.');
    mem.closeMemoryDb();

    const bump = new Database(dbPath);
    bump.run(`PRAGMA user_version = ${mem.MEMORY_SCHEMA_VERSION + 5}`);
    bump.close();

    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.length).toBe(1);
    expect(mem.isReadOnly()).toBe(true);

    const refused = save('A lesson an older build tried to add.');
    expect(refused.outcome).toBe('rejected');
    expect(refused.message).toContain('upgrade');

    mem.closeMemoryDb();
    const after = new Database(dbPath, { readonly: true });
    expect(after.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION + 5,
    );
    expect(after.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n).toBe(1);
    after.close();
  });

  test('a corrupt file is quarantined for recovery, not deleted', () => {
    writeFileSync(dbPath, 'this is not a sqlite database at all');
    const res = save('A lesson written after the corruption.');
    expect(res.outcome).toBe('saved');

    const quarantined = readdirSync(fixtureRoot).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(readFileSync(join(fixtureRoot, quarantined[0]!), 'utf-8')).toBe('this is not a sqlite database at all');
    expect(mem.countLessons()).toBe(1);
  });
});
