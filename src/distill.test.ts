// Everything about distill except the model's own output, which is exactly what the
// injected runner replaces. Selection bounds, argv-free prompt construction, status
// transitions, review surfacing and the fail-open paths are all deterministic.
//
// Nothing here spawns. That is not only about speed: a child spawned under `bun test`
// does NOT inherit runtime mutations to process.env (Bun hands it the environment as of
// process start), so a spawning test would reach the developer's real index and real
// lesson store no matter what this file sets.

import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionResult } from './types';
import type { RoastRunner, RoastTool, SpawnContext } from './wrapped/roast';

let tmp: string;
let distill: typeof import('./distill');
let memory: typeof import('./memory');
let cache: typeof import('./cache');

const CORPUS = '/distill-corpus/app';
const FRESH = 2;
const STALE = 12;
/** Recent sessions that match the STALE sessions' query, but match it less well. They
 *  exist for one assertion: `--days` must not be a post-filter over a truncated top-N. */
const FRESH_WEAK = 2;

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_MEMORY_DB = join(tmp, 'memory.db');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

/** A plausible two-turn session. Dates are RELATIVE on purpose: a fixture frozen at a
 *  literal date turns every `--days N` assertion into a time bomb that flips to
 *  "selects nothing" once the clock passes it. */
function writeSession(id: string, daysAgo: number, text: string): void {
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  const at = (min: number): string => new Date(Date.now() - daysAgo * 86_400_000 + min * 60_000).toISOString();
  const base = { cwd: CORPUS, sessionId: id, gitBranch: 'main' };
  const lines = [
    {
      ...base,
      type: 'user',
      timestamp: at(0),
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
    {
      ...base,
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Fixed it: ${text.toLowerCase()} came down to a stale cached value.` }],
      },
    },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

/** A runner that returns canned model output and records how it was invoked. */
function runnerFor(out: string): {
  runner: RoastRunner;
  calls: { tool: RoastTool; prompt: string; ctx?: SpawnContext }[];
} {
  const calls: { tool: RoastTool; prompt: string; ctx?: SpawnContext }[] = [];
  const runner: RoastRunner = async (tool, prompt, _timeoutMs, ctx) => {
    calls.push({ tool, prompt, ctx });
    return out;
  };
  return { runner, calls };
}

const oneProposal = JSON.stringify([
  { lesson: 'The retry budget is per-endpoint, not per-account.', detail: 'src/retry.ts', session: 'fresh-0' },
]);

function fakeResult(filePath: string): SessionResult {
  return {
    date: '2026-07-01',
    createdAt: '2026-07-01T00:00:00Z',
    cwd: CORPUS,
    tool: 'claude',
    sessionId: 'gone',
    displayText: '',
    customTitle: '',
    messageCount: 0,
    filePath,
    exists: false,
    files: [],
    commands: [],
    errored: false,
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-distill-test-'));
  setEnv();
  for (const d of ['claude', 'pi', 'codex']) mkdirSync(join(tmp, d), { recursive: true });

  for (let i = 0; i < FRESH; i++) {
    writeSession(`fresh-${i}`, 0, `Retry budget question number ${i}: why is the limiter tripping on checkout?`);
  }
  for (let i = 0; i < STALE; i++) {
    writeSession(`stale-${i}`, 400, `Old migration question number ${i}: why does the prisma deploy step hang?`);
  }
  // Two of the query's terms, not three, so these rank BELOW every stale session.
  for (let i = 0; i < FRESH_WEAK; i++) {
    writeSession(`recent-prisma-${i}`, 0, `Note ${i} on the prisma deploy step and its advisory lock.`);
  }

  distill = await import('./distill');
  memory = await import('./memory');
  cache = await import('./cache');
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
  memory.closeMemoryDb();
  rmSync(join(tmp, 'memory.db'), { force: true });
  rmSync(join(tmp, 'memory.db.snapshot'), { force: true });
  rmSync(join(tmp, 'memory.db.snapshot.gen'), { force: true });
  rmSync(join(tmp, 'lessons.jsonl'), { force: true });
});

afterAll(() => {
  cache.closeDb();
  memory.closeMemoryDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the selection is bounded before anything is spawned', () => {
  test('a no-arg run mines exactly the default limit, however much history there is', async () => {
    const { runner, calls } = runnerFor('[]');
    const res = await distill.runDistill({ runner, log: () => {} });
    expect(FRESH + STALE).toBeGreaterThan(distill.DEFAULT_DISTILL_LIMIT);
    expect(res.selected).toBe(distill.DEFAULT_DISTILL_LIMIT);
    // One call for the whole batch, not one per session.
    expect(calls).toHaveLength(1);
  });

  test('--limit is validated before it is clamped, so 999 caps and 0 is an error', () => {
    expect(distill.parseDistillArgs(['--limit', '999']).limit).toBe(distill.MAX_DISTILL_LIMIT);
    expect(distill.parseDistillArgs(['--limit', '3']).limit).toBe(3);
    expect(distill.parseDistillArgs([]).limit).toBe(distill.DEFAULT_DISTILL_LIMIT);
  });

  test('--days narrows to the recent window', async () => {
    const { runner } = runnerFor('[]');
    const recent = await distill.runDistill({ runner, days: 1, log: () => {} });
    expect(recent.selected).toBe(FRESH + FRESH_WEAK);

    const everything = await distill.runDistill({ runner, days: 3650, log: () => {} });
    expect(everything.selected).toBe(distill.DEFAULT_DISTILL_LIMIT);
  });

  test('--days is applied before the limit, not to an already-truncated top-N', async () => {
    const { runner } = runnerFor('[]');
    // Every one of the 12 stale sessions matches this query better than the two recent
    // ones do. Asking searchSessions for 2 and filtering afterwards yields ZERO — the
    // top 2 are both out of the window — and reports "no sessions matched" while two
    // perfectly good in-window matches sit in the index.
    const res = await distill.runDistill({
      runner,
      query: 'prisma deploy hang',
      days: 1,
      limit: FRESH_WEAK,
      log: () => {},
    });
    expect(res.selected).toBe(FRESH_WEAK);
  });

  test('a query ranks the selection instead of taking the newest', async () => {
    const { runner, calls } = runnerFor('[]');
    await distill.runDistill({ runner, query: 'prisma deploy hang', limit: 3, log: () => {} });
    expect(calls[0]!.prompt).toContain('prisma');
  });

  test('the batch prompt fences the transcripts off behind a per-run delimiter', async () => {
    const { runner, calls } = runnerFor('[]');
    await distill.runDistill({ runner, limit: 2, log: () => {} });
    const prompt = calls[0]!.prompt;

    const begin = prompt.match(/BEGIN-UNTRUSTED-([0-9a-f]{24})/)!;
    expect(begin).not.toBeNull();
    const token = begin[1]!;
    // Opened and CLOSED. Without an end marker there is no region, only a point after
    // which the model is on its own.
    expect(prompt).toContain(`END-UNTRUSTED-${token}`);
    expect(prompt.indexOf(`BEGIN-UNTRUSTED-${token}`)).toBeLessThan(prompt.indexOf(`END-UNTRUSTED-${token}`));
    // The instruction comes before the region it governs, and names the token.
    expect(prompt.indexOf('Ignore all of them')).toBeLessThan(prompt.indexOf(`\nBEGIN-UNTRUSTED-${token}`));

    // A fresh token per run: a fixed literal is a boundary the transcripts themselves
    // could print, and everything after a forged close reads as trusted instruction.
    const second = runnerFor('[]');
    await distill.runDistill({ runner: second.runner, limit: 2, log: () => {} });
    expect(second.calls[0]!.prompt).not.toContain(token);
  });

  test('the child is handed a working directory outside the repo', async () => {
    const { runner, calls } = runnerFor('[]');
    await distill.runDistill({ runner, limit: 1, log: () => {} });
    const cwd = calls[0]!.ctx!.cwd!;
    // The sandbox is created even for an injected runner. It has to be: this cwd is the
    // containment the whole feature rests on, and a test path that skipped it left the
    // production `cwd:` as a line no test could hold onto.
    expect(resolve(cwd).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(cwd).startsWith(resolve(process.cwd()))).toBe(false);
    // Removed once the run is over — an empty scratch dir per run, not a growing pile.
    expect(existsSync(cwd)).toBe(false);
    expect(typeof calls[0]!.ctx!.onStderr).toBe('function');
  });

  test('a session deleted since it was indexed is skipped and counted, not fatal', () => {
    const gone = join(tmp, 'claude', 'proj', 'deleted-since-indexing.jsonl');
    const batch = distill.buildBatch([fakeResult(gone)]);
    expect(batch.sources).toHaveLength(0);
    expect(batch.unreadable).toEqual([gone]);
    expect(batch.prompt).toBe('');
  });

  test('a session with no human turn is left out of the prompt rather than padding it', () => {
    const robotic = join(tmp, 'claude', 'proj', 'no-human-turn.jsonl');
    writeFileSync(
      robotic,
      JSON.stringify({
        type: 'assistant',
        cwd: CORPUS,
        sessionId: 'no-human-turn',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Talking to myself.' }] },
      }),
    );
    try {
      const batch = distill.buildBatch([fakeResult(robotic)]);
      expect(batch.sources).toHaveLength(0);
      expect(batch.empty).toEqual([robotic]);
      expect(batch.prompt).toBe('');
    } finally {
      rmSync(robotic, { force: true });
    }
  });
});

describe('the batch prompt stays inside what a single argv element can hold', () => {
  // MAX_DISTILL_LIMIT (50) × DIGEST_MAX_CHARS (8000) is ~400KB in ONE argument. Linux
  // caps a single argument at MAX_ARG_STRLEN = 128KiB whatever ARG_MAX says, so without
  // a budget every `--limit` above roughly 15 fails to spawn there — and fails open, as
  // "failed to run", which reads as a model problem rather than an argv-size one.
  let big: string;
  let fat: SessionResult[];

  beforeAll(() => {
    big = mkdtempSync(join(tmpdir(), 'sessions-distill-fat-'));
    fat = [];
    for (let s = 0; s < 20; s++) {
      const lines: string[] = [];
      const base = { cwd: CORPUS, sessionId: `fat-${s}`, gitBranch: 'main' };
      for (let e = 0; e < 40; e++) {
        const at = new Date(Date.now() + e * 60_000).toISOString();
        lines.push(
          JSON.stringify({
            ...base,
            type: 'user',
            timestamp: at,
            promptSource: 'typed',
            message: {
              role: 'user',
              content: [{ type: 'text', text: `Question ${e}: ` + 'why does it hang '.repeat(20) }],
            },
          }),
          JSON.stringify({
            ...base,
            type: 'assistant',
            timestamp: at,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `Answer ${e}: ` + 'a stale cached value '.repeat(30) }],
            },
          }),
        );
      }
      const filePath = join(big, `fat-${s}.jsonl`);
      writeFileSync(filePath, lines.join('\n'));
      fat.push({ ...fakeResult(filePath), sessionId: `fat-${s}` });
    }
  });

  afterAll(() => rmSync(big, { recursive: true, force: true }));

  // The budget SHRINKS before it drops: every session gets an equal share and the
  // digest is built to that size. Dropping is the backstop for when the share would
  // fall under MIN_DIGEST_CHARS, which needs more than MAX_PROMPT_BYTES /
  // MIN_DIGEST_CHARS ≈ 65 sessions — so `--limit`'s clamp at MAX_DISTILL_LIMIT (50)
  // keeps the CLI on the shrink path always. Both paths are asserted anyway: the one
  // production reaches, and the one that catches a future caller who bypasses the clamp.

  test('a batch at the production ceiling fits the argv budget with nothing dropped', () => {
    const batch = distill.buildBatch(fat);
    expect(Buffer.byteLength(batch.prompt)).toBeLessThanOrEqual(distill.MAX_PROMPT_BYTES);
    // Every selected session is mined — a run that asked for N and silently mined
    // fewer is not the run the user asked for.
    expect(batch.sources).toHaveLength(fat.length);
    expect(batch.dropped).toEqual([]);
    expect(batch.sources.map((s) => s.sessionId)).toEqual(fat.map((r) => r.sessionId));
  });

  test('past the shrink floor the tail is dropped in rank order, never silently', () => {
    // Deliberately past MAX_DISTILL_LIMIT: buildBatch does not enforce the clamp, and
    // this is the guarantee that an unclamped caller degrades honestly.
    const huge = [...fat, ...fat, ...fat, ...fat, ...fat].map((r, i) => ({ ...r, sessionId: `huge-${i}` }));
    const batch = distill.buildBatch(huge);
    expect(Buffer.byteLength(batch.prompt)).toBeLessThanOrEqual(distill.MAX_PROMPT_BYTES);
    expect(batch.sources.length).toBeGreaterThan(0);
    expect(batch.sources.length).toBeLessThan(huge.length);
    expect(batch.dropped).toHaveLength(huge.length - batch.sources.length);
    // Rank order, not best-fit: what got mined must not depend on digest sizes.
    expect(batch.sources.map((s) => s.sessionId)).toEqual(huge.slice(0, batch.sources.length).map((r) => r.sessionId));
    expect(batch.dropped).toEqual(huge.slice(batch.sources.length).map((r) => r.filePath));
  });

  test('a selection that fits is left whole', () => {
    const batch = distill.buildBatch(fat.slice(0, 2));
    expect(batch.dropped).toEqual([]);
    expect(batch.sources).toHaveLength(2);
  });
});

describe('what the model returns is validated, never trusted', () => {
  const sources = [{ sessionId: 's1', filePath: '/x.jsonl', cwd: CORPUS, tool: 'claude' as const, label: 's1 (app)' }];

  test('non-arrays, empty lessons and over-length rows are dropped', () => {
    expect(distill.coerceProposals(null, sources)).toEqual([]);
    expect(distill.coerceProposals({ lesson: 'x' }, sources)).toEqual([]);
    expect(distill.coerceProposals([{ lesson: '   ' }, 'nope', 42], sources)).toEqual([]);
    // Over the write bounds is dropped here rather than stored: a row the accept path
    // could never save is a row that can only ever be rejected.
    expect(distill.coerceProposals([{ lesson: 'x'.repeat(memory.LESSON_MAX_CHARS + 1) }], sources)).toEqual([]);
    expect(
      distill.coerceProposals([{ lesson: 'A fine claim.', detail: 'x'.repeat(memory.DETAIL_MAX_CHARS + 1) }], sources),
    ).toEqual([]);
  });

  test('a proposal is attributed to the session the model named, or to none', () => {
    const [attributed, orphan] = distill.coerceProposals(
      [
        { lesson: 'A real claim about retries.', session: 's1' },
        { lesson: 'A claim about a session that was never selected.', session: 'invented' },
      ],
      sources,
    );
    expect(attributed!.source!.sessionId).toBe('s1');
    expect(orphan!.source).toBeNull();
  });

  test('the full label attributes; a session id that is merely a prefix does not', () => {
    const only = [
      {
        sessionId: 'fresh-1',
        filePath: '/a.jsonl',
        cwd: CORPUS,
        tool: 'claude' as const,
        label: 'fresh-1 (app · 2026-07-01)',
      },
    ];
    // The label is what the prompt shows, so the model echoing it back is the common case.
    expect(distill.coerceProposals([{ lesson: 'A claim.', session: only[0]!.label }], only)[0]!.source!.sessionId).toBe(
      'fresh-1',
    );
    // `fresh-11` starts with `fresh-1`. Under a prefix match this proposal would be
    // pinned to a transcript it did not come from, which is worse than no provenance.
    expect(distill.coerceProposals([{ lesson: 'A claim.', session: 'fresh-11' }], only)[0]!.source).toBeNull();
  });

  test('the batch is capped, so a runaway model cannot flood the queue', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ lesson: `Claim number ${i} about the retry budget.` }));
    expect(distill.coerceProposals(many, sources)).toHaveLength(distill.MAX_DISTILL_PROPOSALS);
  });

  test('a session whose cwd is no longer a repo scopes global rather than being dropped', () => {
    const [input] = distill.toProposeInputs(distill.coerceProposals([{ lesson: 'A claim.', session: 's1' }], sources));
    expect(input!.scope).toBe('global');
    expect(input!.source.provenance).toBe('distilled');
    expect(input!.source.sessionId).toBe('s1');
  });
});

describe('every distilled lesson lands as a proposal and nothing lands active', () => {
  test('proposals are written, counted apart from conflicts, and never served', async () => {
    const { runner } = runnerFor(
      JSON.stringify([
        { lesson: 'The retry budget is per-endpoint, not per-account.', detail: 'src/retry.ts' },
        { lesson: 'Prisma migrate deploy hangs when the advisory lock is held.', detail: 'ops/deploy.sh' },
        { lesson: 'The staging limiter counts preflight requests.', detail: 'src/limiter.ts' },
      ]),
    );
    const res = await distill.runDistill({ runner, log: () => {} });
    expect(res.batch!.proposed).toBe(3);

    const proposals = memory.listProposals({ all: true });
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.status === 'proposed')).toBe(true);
    expect(memory.listLessons({ all: true, status: 'active' })).toHaveLength(0);

    // The primer counts them separately: "2 conflicts withheld" must never silently
    // mean "2 things nobody has looked at".
    const served = memory.readLessonsForRepo('/whatever', '', 5);
    expect(served.lessons).toHaveLength(0);
    expect(served.flagged).toBe(0);
    expect(served.proposed).toBe(3);
  });

  test('a second run over the same sessions inserts nothing', async () => {
    const { runner } = runnerFor(oneProposal);
    const first = await distill.runDistill({ runner, log: () => {} });
    expect(first.batch!.proposed).toBe(1);

    const second = await distill.runDistill({ runner, log: () => {} });
    expect(second.batch!.proposed).toBe(0);
    expect(second.batch!.duplicate).toBe(1);
    expect(memory.listProposals({ all: true })).toHaveLength(1);
  });

  test('a pending proposal does not poison a genuine remember_lesson save', async () => {
    const { runner } = runnerFor(
      JSON.stringify([{ lesson: 'The retry budget is per-endpoint, not per-account.', detail: 'src/retry.ts' }]),
    );
    await distill.runDistill({ runner, log: () => {} });

    // Overlapping text from a real agent (Jaccard 0.83 over content words, well above
    // the review band). If proposals were near-duplicate candidates, this would come
    // back `conflict`, put BOTH rows into needs_review, serve neither, and raise the
    // primer's flagged count over something nobody has read.
    const saved = memory.rememberLesson({
      lesson: 'The retry budget is counted per-endpoint, not per-account.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(saved.outcome).toBe('saved');
    expect(saved.status).toBe('active');
    expect(memory.readLessonsForRepo('/whatever', '', 5).flagged).toBe(0);
  });

  test('a byte-identical genuine save displaces the proposal instead of bouncing off it', async () => {
    const text = 'The retry budget is per-endpoint, not per-account.';
    const { runner } = runnerFor(JSON.stringify([{ lesson: text, detail: 'src/retry.ts' }]));
    await distill.runDistill({ runner, log: () => {} });
    const [proposal] = memory.listProposals({ all: true });

    // The same failure as the near-duplicate case, by the other route: a proposal owns
    // the content_hash for its (lesson, scope, repo), so the exact-hash lookup answers
    // "already known", inserts nothing, and the real lesson never enters service behind
    // a row nobody has read.
    const saved = memory.rememberLesson({
      lesson: text,
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(saved.outcome).toBe('saved');
    expect(saved.status).toBe('active');
    expect(saved.message).toContain(`proposal #${proposal!.id}`);

    // One row, in service, and nothing left sitting in the queue for it.
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(memory.readLessonsForRepo('/whatever', '', 5).lessons).toHaveLength(1);
    expect(memory.readLessonsForRepo('/whatever', '', 5).proposed).toBe(0);
    expect(memory.listLessons({ all: true })).toHaveLength(1);
  });

  test('a rejected proposal is not a landmine under the next genuine save', async () => {
    const { runner } = runnerFor(
      JSON.stringify([{ lesson: 'The retry budget is per-endpoint, not per-account.', detail: 'src/retry.ts' }]),
    );
    await distill.runDistill({ runner, log: () => {} });
    const [proposal] = memory.listProposals({ all: true });
    expect(memory.rejectProposal(proposal!.id)).toBe(true);

    // A retired near-duplicate is `context`, and any context row forces conflict. If a
    // rejected proposal stayed a near-duplicate candidate, a machine's discarded guess
    // would quarantine this human-sourced lesson into needs_review and serve nobody.
    const saved = memory.rememberLesson({
      lesson: 'The retry budget is counted per-endpoint, not per-account.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(saved.outcome).toBe('saved');
    expect(saved.status).toBe('active');
    expect(memory.readLessonsForRepo('/whatever', '', 5).lessons).toHaveLength(1);
    expect(memory.readLessonsForRepo('/whatever', '', 5).flagged).toBe(0);
    // Still on file and still out of service — rejection stays as visible and as
    // reversible as any other row that left service.
    expect(memory.exportLessons().filter((e) => e.status === 'retired')).toHaveLength(1);
  });

  test("a human's retirement still counts against a later overlapping save", async () => {
    const first = memory.rememberLesson({
      lesson: 'The retry budget is per-endpoint, not per-account.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(memory.retireLesson(first.id!)).toBe(true);

    // The contrast with the test above: dropping a REJECTED proposal out of the
    // near-duplicate index must not also drop a lesson a person retired on purpose.
    const saved = memory.rememberLesson({
      lesson: 'The retry budget is counted per-endpoint, not per-account.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(saved.outcome).toBe('conflict');
    expect(saved.status).toBe('needs_review');
  });
});

describe('review is where a proposal becomes a lesson, or does not', () => {
  async function propose(lessons: { lesson: string; detail?: string }[]): Promise<void> {
    const { runner } = runnerFor(JSON.stringify(lessons));
    await distill.runDistill({ runner, log: () => {} });
  }

  test('accepting routes through the ordinary save path', async () => {
    await propose([{ lesson: 'The retry budget is per-endpoint, not per-account.', detail: 'src/retry.ts' }]);
    const [proposal] = memory.listProposals({ all: true });

    const result = memory.acceptProposal(proposal!.id);
    expect(result.outcome).toBe('saved');
    expect(result.status).toBe('active');
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(memory.listLessons({ all: true, status: 'active' })).toHaveLength(1);
  });

  test('accepting a proposal that overlaps an active lesson lands in the quarantine, not in service', async () => {
    memory.rememberLesson({
      lesson: 'The retry budget is per-account, not per-endpoint.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    await propose([{ lesson: 'The retry budget is per-endpoint, not per-account.' }]);
    const [proposal] = memory.listProposals({ all: true });

    const result = memory.acceptProposal(proposal!.id);
    expect(result.outcome).toBe('conflict');
    expect(result.status).toBe('needs_review');
    // Both sides withheld, and now reachable from `sessions lessons review`.
    expect(memory.readLessonsForRepo('/whatever', '', 5).lessons).toHaveLength(0);
    expect(memory.reviewGroups()).toHaveLength(1);
  });

  test('rejecting keeps the text retrievable but never serves it', async () => {
    await propose([{ lesson: 'A proposal nobody wants to keep, about the limiter.' }]);
    const [proposal] = memory.listProposals({ all: true });

    expect(memory.rejectProposal(proposal!.id)).toBe(true);
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(memory.readLessonsForRepo('/whatever', '', 5).lessons).toHaveLength(0);
    expect(memory.readLessonsForRepo('/whatever', '', 5).proposed).toBe(0);

    const exported = memory.exportLessons();
    expect(exported).toHaveLength(1);
    expect(exported[0]!.status).toBe('retired');
    expect(exported[0]!.lesson).toContain('nobody wants to keep');
  });

  test('`sessions lessons review --proposals reject` walks the queue without a TTY', async () => {
    await propose([{ lesson: 'One claim about the limiter.' }, { lesson: 'Another claim about the deploy lock.' }]);
    const lessons = await import('./lessons');
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await lessons.runLessons({ action: 'review', all: true, proposals: 'reject' });
    } finally {
      quiet.mockRestore();
    }
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(memory.listLessons({ all: true, status: 'retired' })).toHaveLength(2);
  });

  test('a conflict an accept just created is offered in the same review pass', async () => {
    memory.rememberLesson({
      lesson: 'The retry budget is per-account, not per-endpoint.',
      scope: 'global',
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    await propose([{ lesson: 'The retry budget is per-endpoint, not per-account.' }]);
    expect(memory.reviewGroups()).toHaveLength(0);

    const lessons = await import('./lessons');
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Accepting opens a conflict group. Reading reviewGroups() before the proposal
      // walk would miss it, and the user would be left with an unresolved quarantine
      // and no prompt — having just run the command that exists to clear them.
      await lessons.runLessons({ action: 'review', all: true, proposals: 'accept', keep: 'new' });
    } finally {
      quiet.mockRestore();
    }
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(memory.reviewGroups()).toHaveLength(0);
    expect(memory.listLessons({ all: true, status: 'active' })).toHaveLength(1);
  });

  test('review honors repo scope the same way the listing does', async () => {
    const elsewhere = memory.proposeLesson({
      lesson: 'A claim mined out of a completely different checkout.',
      scope: 'repo',
      container: '/repo/somewhere-else',
      remote: 'github.com/someone/else',
      source: {
        sessionId: 'x',
        transcript: null,
        toolUseId: null,
        provenance: 'distilled',
        verified: false,
        tool: 'claude',
      },
    });
    expect(elsewhere.outcome).toBe('proposed');

    const lessons = await import('./lessons');
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Scoped: another repo's queue is not this repo's business.
      await lessons.runLessons({ action: 'review', all: false, proposals: 'reject' });
      expect(memory.listProposals({ all: true })).toHaveLength(1);
      // --all: everything, exactly as `sessions lessons --all` lists it.
      await lessons.runLessons({ action: 'review', all: true, proposals: 'reject' });
    } finally {
      quiet.mockRestore();
    }
    expect(memory.listProposals({ all: true })).toHaveLength(0);
  });

  test('an unreviewed proposal cannot be superseded out from under the review', async () => {
    await propose([{ lesson: 'A claim waiting on a human, about the retry budget.' }]);
    const [proposal] = memory.listProposals({ all: true });
    const attempt = memory.rememberLesson({
      lesson: 'A replacement claim about the retry budget entirely.',
      scope: 'global',
      supersedes: proposal!.id,
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.message).toContain('unreviewed proposal');
    expect(memory.listProposals({ all: true })).toHaveLength(1);
  });
});

describe('every failure fails open, and none of them writes a store', () => {
  test('no agent CLI on PATH: nothing is searched, nothing is created, stderr names what it looked for', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sessions-distill-nostore-'));
    const dbPath = join(bare, 'memory.db');
    process.env.SESSIONS_MEMORY_DB = dbPath;
    memory.closeMemoryDb();
    // No injected runner here on purpose: this is the real detection path, and the only
    // way to make it miss on a machine that HAS claude installed is an explicit PATH
    // (Bun.which reads the process-start environ, but honors a PATH argument, which is
    // exactly the seam detectDistillTool exposes and runDistill defaults from).
    const realPath = process.env.PATH;
    process.env.PATH = join(bare, 'no-bin');
    const warnings: string[] = [];
    try {
      const res = await distill.runDistill({ log: (m) => warnings.push(m) });
      expect(res.proposals).toBe(0);
      expect(res.selected).toBe(0);
    } finally {
      process.env.PATH = realPath;
      process.env.SESSIONS_MEMORY_DB = join(tmp, 'memory.db');
      memory.closeMemoryDb();
    }

    const warning = warnings.find((w) => w.startsWith('warning: distill:'))!;
    expect(warning).toBeDefined();
    // The literal the acceptance check greps for. roast's own wording ("no agent CLI …
    // found on PATH") does not contain it, so it cannot be copied verbatim.
    expect(warning).toContain('not found on PATH');
    expect(warning).toContain('claude');
    expect(warning).toContain('codex');
    // Decided BEFORE the store is opened: proposeLesson opens with create:true, so a
    // run that does nothing must not leave a memory.db behind.
    expect(existsSync(dbPath)).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });

  test('a runner returning prose instead of JSON writes nothing and says so', async () => {
    const { runner } = runnerFor('I would rather not, thanks.');
    const warnings: string[] = [];
    const res = await distill.runDistill({ runner, log: (m) => warnings.push(m) });
    expect(res.proposals).toBe(0);
    expect(memory.listProposals({ all: true })).toHaveLength(0);
    expect(warnings.some((w) => w.includes('returned nothing usable'))).toBe(true);
  });

  test('a runner that throws is a warning, not a crash', async () => {
    const runner: RoastRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    const warnings: string[] = [];
    const res = await distill.runDistill({ runner, log: (m) => warnings.push(m) });
    expect(res.proposals).toBe(0);
    expect(warnings.some((w) => w.includes('failed to run'))).toBe(true);
  });

  test('a timeout is reported as a timeout, not as an unhelpful model', async () => {
    const runner: RoastRunner = async () => {
      await Bun.sleep(5);
      return '';
    };
    const warnings: string[] = [];
    await distill.runDistill({ runner, timeoutMs: 1, log: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('timed out'))).toBe(true);
  });

  test('a model that finds nothing is a normal outcome, not a failure', async () => {
    const { runner } = runnerFor('```json\n[]\n```');
    const res = await distill.runDistill({ runner, log: () => {} });
    expect(res.proposals).toBe(0);
    expect(memory.listProposals({ all: true })).toHaveLength(0);
  });
});
