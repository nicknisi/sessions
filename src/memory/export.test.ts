import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMemory } from './cli';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import { fromPortable, merge, PortableFormatError, toPortable, toRecord } from './portable';
import { buildRecord, fingerprint, normalizeText } from './record';
import { getMemoryDb, listMemories, upsertCandidates } from './store';
import { MEMORY_SCHEMA_VERSION, type PortableMemory, type MemoryBundle, type MemoryRecord } from './types';

// The transport seam in test form. Three properties carry the phase:
//
//  - PRIVACY is a hard constraint, not a preference: only approved records leave, and
//    nothing about this machine's filesystem does. The assertions are over the whole
//    serialized bundle rather than one field, because the failure mode is a key nobody
//    thought to check.
//  - ROUND-TRIP fidelity: a writer with no reader proves nothing, so every export is
//    read back.
//  - PURITY of `merge`: shuffling the input must not change the output, which is what
//    lets a future transport concatenate sets in any arrival order and just call it.
//
// The dates are literals throughout — `exportedAt` is injected, so nothing here is
// green only until UTC midnight.

// A username and a project name, in the field the spec's own field list would have
// exported: this is the leak that stripping `evidence.sessions` alone would not catch.
const LOCAL_CONTAINER = '/Users/testuser/Developer/secret-project';
const LOCAL_SESSION = '/Users/testuser/.claude/projects/secret-project/a.jsonl';

const APPROVED_TEXT = 'Always run the full test suite before you tell me a change is finished';
const CANDIDATE_TEXT = 'Never bump the lockfile in the same commit as a feature change';
const REJECTED_TEXT = 'Always keep the changelog entry in the same commit as the change';
const SNOOZED_TEXT = 'Prefer the repo script over invoking the underlying tool directly';

function record(text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    ...buildRecord({
      text,
      scope: { type: 'repo', key: LOCAL_CONTAINER },
      author: 'dev@example.com',
      sessions: [LOCAL_SESSION],
      dates: ['2026-01-05', '2026-02-10'],
      distinctPhrasings: 3,
    }),
    ...over,
  };
}

const APPROVED = record(APPROVED_TEXT, { state: 'approved' });
const CANDIDATE = record(CANDIDATE_TEXT);
const REJECTED = record(REJECTED_TEXT, { state: 'rejected' });
const SNOOZED = record(SNOOZED_TEXT, { state: 'snoozed', snoozedUntil: '2026-03-15' });
const ALL_STATES = [APPROVED, CANDIDATE, REJECTED, SNOOZED];

function portable(text: string, over: Partial<Omit<PortableMemory, 'id' | 'text'>> = {}): PortableMemory {
  const normalized = normalizeText(text);
  return {
    v: MEMORY_SCHEMA_VERSION,
    id: fingerprint(normalized),
    text: normalized,
    kind: 'instruction',
    scope: { type: 'repo', key: '' },
    author: 'dev@example.com',
    evidence: { distinctPhrasings: 1, firstSeen: '2026-01-01', lastSeen: '2026-01-01' },
    ...over,
  };
}

describe('toPortable', () => {
  test('exports approved records only — a candidate is unreviewed model output', () => {
    // The filter must be `=== 'approved'`, never `!== 'rejected'`: the second form
    // ships candidates and snoozed rows as if the user had endorsed them.
    const bundle = toPortable(ALL_STATES, '2026-06-01');
    expect(bundle.memories.map((s) => s.text)).toEqual([APPROVED.text]);
  });

  test('carries no local paths — session paths and the repo container both', () => {
    const bundle = toPortable(ALL_STATES, '2026-06-01');
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('"sessions"');
    expect(json).not.toContain('testuser');
    expect(json).not.toContain('secret-project');
    expect(bundle.memories[0]!.scope).toEqual({ type: 'repo', key: '' });
  });

  test('carries no triage state — a recipient imports the fact, not your opinion of it', () => {
    const json = JSON.stringify(toPortable([{ ...APPROVED, snoozedUntil: '2026-03-15' }], '2026-06-01'));
    expect(json).not.toContain('"state"');
    expect(json).not.toContain('snoozedUntil');
    expect(json).not.toContain('2026-03-15');
  });

  test('carries no alwaysOn — bypassing your matcher is a claim on your attention alone', () => {
    const json = JSON.stringify(toPortable([{ ...APPROVED, alwaysOn: true }], '2026-06-01'));
    expect(json).not.toContain('alwaysOn');
  });

  test('preserves a GROUP scope key, which is a name rather than a path', () => {
    // Blanking it would strip the only thing distinguishing one group from another and
    // land the memory permanently inert. It discloses no directory layout, so the reason
    // the repo key is blanked does not apply.
    const grouped = record(APPROVED_TEXT, { state: 'approved', scope: { type: 'group', key: 'authkit' } });
    const bundle = toPortable([grouped], '2026-06-01');
    expect(bundle.memories[0]!.scope).toEqual({ type: 'group', key: 'authkit' });
  });

  test('a group-scoped bundle round-trips through its own reader', () => {
    // Widening MemoryScope['type'] does NOT widen the zod enum, and typecheck flags
    // nothing — leaving 'group' out of the schema produces an export fromPortable
    // rejects with `scope.type: invalid`.
    const grouped = record(APPROVED_TEXT, { state: 'approved', scope: { type: 'group', key: 'authkit' } });
    const bundle = toPortable([grouped], '2026-06-01');
    const parsed = fromPortable(JSON.parse(JSON.stringify(bundle)));
    expect(parsed[0]!.scope).toEqual({ type: 'group', key: 'authkit' });
  });

  test('wraps an empty set in a well-formed envelope, not null or a bare array', () => {
    expect(toPortable([], '2026-06-01')).toEqual({ v: MEMORY_SCHEMA_VERSION, exportedAt: '2026-06-01', memories: [] });
  });

  test('two exports of an unchanged set are byte-identical, whatever the row order', () => {
    const more = [
      APPROVED,
      record('Always squash the fixup commits before you open the pull request', { state: 'approved' }),
    ];
    const first = JSON.stringify(toPortable(more, '2026-06-01'));
    const second = JSON.stringify(toPortable([...more].reverse(), '2026-06-01'));
    expect(second).toBe(first);
    // Sorted by id so a diff-based transport (a git ref, say) gets clean history.
    const ids = toPortable(more, '2026-06-01').memories.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });

  test('refuses a malformed exportedAt rather than writing a bundle its own reader rejects', () => {
    expect(() => toPortable([], 'yesterday')).toThrow(RangeError);
    expect(() => toPortable([], '2026-6-1')).toThrow('YYYY-MM-DD');
  });
});

describe('fromPortable', () => {
  const bundle = toPortable(ALL_STATES, '2026-06-01');

  test('round-trips an exported bundle back to the same memory set', () => {
    const parsed = fromPortable(JSON.parse(JSON.stringify(bundle)));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(bundle.memories));
  });

  test('throws on a version mismatch rather than best-effort parsing', () => {
    // Pre-1.0 exports are explicitly disposable; a loud failure beats a mangled import.
    expect(() => fromPortable({ ...bundle, v: 99 })).toThrow(PortableFormatError);
    expect(() => fromPortable({ ...bundle, memories: [{ ...bundle.memories[0]!, v: 99 }] })).toThrow(
      PortableFormatError,
    );
  });

  test('throws on a malformed bundle', () => {
    expect(() => fromPortable(null)).toThrow(PortableFormatError);
    expect(() => fromPortable('{}')).toThrow(PortableFormatError);
    expect(() => fromPortable([])).toThrow(PortableFormatError); // a bare array, not an envelope
    expect(() => fromPortable({ v: MEMORY_SCHEMA_VERSION, memory: [] })).toThrow(PortableFormatError); // no exportedAt
    const { author: _dropped, ...missingAuthor } = bundle.memories[0]!;
    expect(() => fromPortable({ ...bundle, memories: [missingAuthor] })).toThrow(PortableFormatError);
  });

  test('rejects an unknown key instead of silently stripping it', () => {
    // zod's default z.object() strips unknown keys with no error, which would import a
    // bundle from a future version as if the field had never been there.
    expect(() => fromPortable({ ...bundle, unexpected: true })).toThrow(PortableFormatError);
    expect(() => fromPortable({ ...bundle, memories: [{ ...bundle.memories[0]!, always: true }] })).toThrow(
      PortableFormatError,
    );
  });

  test('recomputes the content-addressed id and rejects one that does not match its text', () => {
    // The id is the merge key AND the store's primary key, and the file came from
    // another machine — trusting it lets a peer fragment clusters or collide rows.
    const forged = {
      ...bundle,
      memories: [{ ...bundle.memories[0]!, text: 'Always do something else entirely, please' }],
    };
    expect(() => fromPortable(forged)).toThrow(/does not match its text/);
    const badId = { ...bundle, memories: [{ ...bundle.memories[0]!, id: 'sha256:nothex' }] };
    expect(() => fromPortable(badId)).toThrow(PortableFormatError);
  });

  test('rejects text outside the band the local mine enforces', () => {
    // Import is otherwise the one unbounded path into the store, and an approved memory
    // is injected into every agent task through get_memory.
    const long = 'Always '.repeat(60);
    expect(() => fromPortable({ ...bundle, memories: [portable(long)] })).toThrow(PortableFormatError);
    expect(() => fromPortable({ ...bundle, memories: [portable('too short')] })).toThrow(PortableFormatError);
  });

  test('reports one line naming the offending field, not a JSON dump', () => {
    try {
      fromPortable({ ...bundle, v: 99 });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PortableFormatError);
      // SAFETY: toBeInstanceOf above establishes error is a PortableFormatError (an Error).
      const { message } = error as Error;
      expect(message.split('\n')).toHaveLength(1);
      expect(message).toContain('v');
    }
  });

  test('accepts the empty date range the local pipeline itself produces', () => {
    const undated = portable(APPROVED_TEXT, { evidence: { distinctPhrasings: 1, firstSeen: '', lastSeen: '' } });
    expect(fromPortable({ ...bundle, memories: [undated] })).toHaveLength(1);
  });
});

describe('merge', () => {
  const SHARED = 'Always run the full test suite before you tell me a change is finished';
  const OWN_A = 'Never rewrite a published branch without telling the other reviewers';
  const OWN_B = 'Prefer a migration over an ad-hoc script when the schema has to change';

  // Three authors, six records, one id in common — the spec's experiment.
  const INPUT: PortableMemory[] = [
    portable(SHARED, {
      author: 'ann@example.com',
      evidence: { distinctPhrasings: 2, firstSeen: '2026-02-01', lastSeen: '2026-02-20' },
    }),
    portable(SHARED, {
      author: 'bob@example.com',
      evidence: { distinctPhrasings: 1, firstSeen: '2026-01-10', lastSeen: '2026-01-30' },
    }),
    portable(SHARED, {
      author: 'cat@example.com',
      scope: { type: 'workflow', key: '' },
      evidence: { distinctPhrasings: 3, firstSeen: '2026-03-01', lastSeen: '2026-03-05' },
    }),
    portable(OWN_A, { author: 'ann@example.com' }),
    portable(OWN_B, { author: 'bob@example.com' }),
    // Same author twice on one id: five records from one person must still score 1.
    portable(OWN_A, { author: 'ANN@example.com' }),
  ];

  test('is order-independent — the property a transport depends on', () => {
    // A fixed permutation, not Math.random(): a random failure is unreproducible.
    const shuffled = [INPUT[3]!, INPUT[0]!, INPUT[5]!, INPUT[1]!, INPUT[4]!, INPUT[2]!];
    expect(JSON.stringify(merge(shuffled))).toBe(JSON.stringify(merge(INPUT)));
    expect(JSON.stringify(merge([...INPUT].reverse()))).toBe(JSON.stringify(merge(INPUT)));
  });

  test('unions authors across contributors, sorted and deduplicated', () => {
    const shared = merge(INPUT).find((m) => m.text === SHARED)!;
    expect(shared.authors).toEqual(['ann@example.com', 'bob@example.com', 'cat@example.com']);
  });

  test('counts one author once, however many records they contribute', () => {
    const own = merge(INPUT).find((m) => m.text === OWN_A)!;
    expect(own.authors).toEqual(['ANN@example.com']);
  });

  test('sums distinctPhrasings for display', () => {
    expect(merge(INPUT).find((m) => m.text === SHARED)!.totalPhrasings).toBe(6);
  });

  test('widens a repo/workflow scope conflict to workflow', () => {
    const shared = merge(INPUT).find((m) => m.text === SHARED)!;
    expect(shared.scope).toEqual({ type: 'workflow', key: '' });
  });

  test('widens two different repo keys too — same fact, different repos', () => {
    const merged = merge([
      portable(SHARED, { author: 'ann@example.com', scope: { type: 'repo', key: '/a' } }),
      portable(SHARED, { author: 'bob@example.com', scope: { type: 'repo', key: '/b' } }),
    ]);
    expect(merged[0]!.scope).toEqual({ type: 'workflow', key: '' });
  });

  test('keeps a scope every contributor agrees on', () => {
    const merged = merge([
      portable(SHARED, { author: 'ann@example.com', scope: { type: 'repo', key: '/a' } }),
      portable(SHARED, { author: 'bob@example.com', scope: { type: 'repo', key: '/a' } }),
    ]);
    expect(merged[0]!.scope).toEqual({ type: 'repo', key: '/a' });
  });

  test('keeps a group two contributors named identically, and widens two who did not', () => {
    const agreed = merge([
      portable(SHARED, { author: 'ann@example.com', scope: { type: 'group', key: 'authkit' } }),
      portable(SHARED, { author: 'bob@example.com', scope: { type: 'group', key: 'authkit' } }),
    ]);
    expect(agreed[0]!.scope).toEqual({ type: 'group', key: 'authkit' });
    const disagreed = merge([
      portable(SHARED, { author: 'ann@example.com', scope: { type: 'group', key: 'authkit' } }),
      portable(SHARED, { author: 'bob@example.com', scope: { type: 'group', key: 'billing' } }),
    ]);
    expect(disagreed[0]!.scope).toEqual({ type: 'workflow', key: '' });
  });

  test('unions the date range across contributors', () => {
    const shared = merge(INPUT).find((m) => m.text === SHARED)!;
    expect(shared.firstSeen).toBe('2026-01-10');
    expect(shared.lastSeen).toBe('2026-03-05');
  });

  test('an undated contributor does not erase a known range', () => {
    // '' sorts before every real date and would otherwise always win the min.
    const merged = merge([
      portable(SHARED, { author: 'ann@example.com', evidence: { distinctPhrasings: 1, firstSeen: '', lastSeen: '' } }),
      portable(SHARED, {
        author: 'bob@example.com',
        evidence: { distinctPhrasings: 1, firstSeen: '2026-01-10', lastSeen: '2026-01-30' },
      }),
    ]);
    expect(merged[0]!.firstSeen).toBe('2026-01-10');
    expect(merged[0]!.lastSeen).toBe('2026-01-30');
  });

  test('an empty set merges to an empty set', () => {
    expect(merge([])).toEqual([]);
  });

  test('a one-element set is the normal case, not a special case', () => {
    const merged = merge([portable(SHARED, { author: 'ann@example.com' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.authors).toEqual(['ann@example.com']);
    expect(merged[0]!.totalPhrasings).toBe(1);
  });

  test('returns clusters sorted by id', () => {
    const ids = merge(INPUT).map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('toRecord', () => {
  const incoming = merge([
    portable(APPROVED_TEXT, {
      author: 'peer@example.com',
      evidence: { distinctPhrasings: 1, firstSeen: '2026-04-01', lastSeen: '2026-04-02' },
    }),
  ])[0]!;

  test('lands an imported memory as a candidate — importing is not consent', () => {
    const built = toRecord(incoming);
    expect(built.state).toBe('candidate');
    expect(built.snoozedUntil).toBeNull();
    expect(built.id).toBe(APPROVED.id);
  });

  test('keeps the local evidence a bundle cannot carry', () => {
    // upsertCandidates overwrites `evidence` wholesale, so a record built without the
    // local row would replace real session paths with [].
    const built = toRecord(incoming, APPROVED);
    expect(built.evidence.sessions).toEqual([LOCAL_SESSION]);
    expect(built.scope.key).toBe(LOCAL_CONTAINER);
    expect(built.author).toBe('dev@example.com');
  });

  test('widens the date range rather than replacing it', () => {
    const built = toRecord(incoming, APPROVED);
    expect(built.evidence.firstSeen).toBe('2026-01-05');
    expect(built.evidence.lastSeen).toBe('2026-04-02');
  });

  test('takes the max phrasing count so re-importing the same bundle cannot inflate it', () => {
    const inflated = { ...incoming, totalPhrasings: 9 };
    expect(toRecord(incoming, APPROVED).evidence.distinctPhrasings).toBe(3);
    expect(toRecord(inflated, APPROVED).evidence.distinctPhrasings).toBe(9);
    // Idempotent: importing a second time over the now-9 row still yields 9.
    const once = toRecord(inflated, APPROVED);
    expect(toRecord(inflated, once).evidence.distinctPhrasings).toBe(9);
  });
});

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-export');
  setMemoryEnv(tmp);
  closeDatabases();
});

// Shared module instances across a `bun test` run mean another file's env leaks in
// unless both are re-asserted per test (src/memory/fixtures.ts).
beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
  upsertCandidates(ALL_STATES);
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the CLI with both streams captured, so a test can assert on the bundle. */
async function capture(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const sink =
    (into: string[]) =>
    (chunk: string | Uint8Array, cb?: () => void): boolean => {
      into.push(String(chunk));
      cb?.();
      return true;
    };
  // SAFETY: the stub implements only the (chunk, cb) overload the memory CLI uses.
  process.stdout.write = sink(out) as typeof process.stdout.write;
  // SAFETY: same stub contract as stdout above.
  process.stderr.write = sink(err) as typeof process.stderr.write;
  try {
    await runMemory(argv);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

describe('memory export', () => {
  test('prints an envelope of approved memory on stdout and nothing local in it', async () => {
    const { stdout, stderr } = await capture(['export']);
    // SAFETY: stdout is the envelope `memory export` just wrote; the test asserts its fields.
    const bundle = JSON.parse(stdout) as MemoryBundle;
    expect(bundle.v).toBe(MEMORY_SCHEMA_VERSION);
    expect(bundle.memories.map((s) => s.text)).toEqual([APPROVED.text]);
    expect(stdout).not.toContain('testuser');
    expect(stdout).not.toContain('"state"');
    expect(stderr).toContain('1 approved memory exported');
  });

  test('--out writes the file and reports it on stderr, leaving stdout empty', async () => {
    const out = join(tmp, 'bundle.json');
    const { stdout, stderr } = await capture(['export', '--out', out]);
    expect(stdout).toBe('');
    expect(stderr).toContain(`wrote ${out}`);
    // SAFETY: the file is the envelope `memory export --out` just wrote.
    expect((JSON.parse(readFileSync(out, 'utf-8')) as MemoryBundle).memories).toHaveLength(1);
  });

  test('an empty store still exports a readable envelope', async () => {
    getMemoryDb().run('DELETE FROM memory');
    const { stdout } = await capture(['export']);
    expect(fromPortable(JSON.parse(stdout))).toEqual([]);
  });
});

describe('memory import', () => {
  test('importing your own export is a no-op, evidence included', async () => {
    const out = join(tmp, 'self.json');
    await capture(['export', '--out', out]);
    const { stderr } = await capture(['import', out]);

    expect(stderr).toContain('0 imported, 1 already known');
    const stored = listMemories().find((r) => r.id === APPROVED.id)!;
    expect(stored.state).toBe('approved');
    expect(stored.evidence.sessions).toEqual([LOCAL_SESSION]);
    expect(stored.evidence.distinctPhrasings).toBe(3);
    expect(stored.scope.key).toBe(LOCAL_CONTAINER);
  });

  test('a foreign memory lands as a candidate, never as approved', async () => {
    const peer = record('Always regenerate the client after you touch the schema file', {
      state: 'approved',
      author: 'peer@example.com',
    });
    const out = join(tmp, 'peer.json');
    await Bun.write(out, JSON.stringify(toPortable([peer], '2026-06-01')));

    const { stderr } = await capture(['import', out]);
    expect(stderr).toContain('1 imported, 0 already known');
    const stored = listMemories().find((r) => r.id === peer.id)!;
    expect(stored.state).toBe('candidate');
    expect(stored.author).toBe('peer@example.com');
    // Scope arrives keyless, and retrieve.ts skips a keyless repo memory rather than
    // matching every cwd — an imported repo memory is inert until it is re-derived.
    expect(stored.scope).toEqual({ type: 'repo', key: '' });
  });

  test('an id already rejected locally stays rejected', async () => {
    const out = join(tmp, 'rejected.json');
    await Bun.write(out, JSON.stringify(toPortable([{ ...REJECTED, state: 'approved' }], '2026-06-01')));

    await capture(['import', out]);
    expect(listMemories().find((r) => r.id === REJECTED.id)!.state).toBe('rejected');
  });

  test('duplicate ids inside one bundle collapse instead of racing each other', async () => {
    const peer = portable('Always regenerate the client after you touch the schema file', {
      author: 'peer@example.com',
    });
    const out = join(tmp, 'dupes.json');
    await Bun.write(
      out,
      JSON.stringify({ v: MEMORY_SCHEMA_VERSION, exportedAt: '2026-06-01', memories: [peer, peer, peer] }),
    );

    const { stderr } = await capture(['import', out]);
    expect(stderr).toContain('1 imported');
    expect(listMemories().filter((r) => r.id === peer.id)).toHaveLength(1);
  });

  test('writes nothing to stdout — it fills the store, it does not emit a batch', async () => {
    const out = join(tmp, 'quiet.json');
    await capture(['export', '--out', out]);
    expect((await capture(['import', out])).stdout).toBe('');
  });
});
