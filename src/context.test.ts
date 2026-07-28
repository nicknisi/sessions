import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RepoInfo } from './repo';
import type { ContextPrimer } from './types';

// Point the index at hermetic temp dirs. cache.ts now resolves SESSIONS_* lazily,
// and a beforeEach re-asserts these on the shared module instance before each test.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-ctx-')));
const claudeDir = join(fixtureRoot, 'claude');
const piDir = join(fixtureRoot, 'pi');
const codexDir = join(fixtureRoot, 'codex');
const cacheDir = join(fixtureRoot, 'cache');
const memoryDb = join(fixtureRoot, 'memory.db'); // written only by the lesson tests below
const opencodeDb = join(fixtureRoot, 'opencode.db'); // absent → no OpenCode sessions leak in
for (const d of [claudeDir, piDir, codexDir, cacheDir]) mkdirSync(d, { recursive: true });

process.env.SESSIONS_CLAUDE_DIR = claudeDir;
process.env.SESSIONS_PI_DIR = piDir;
process.env.SESSIONS_CODEX_DIR = codexDir;
process.env.SESSIONS_CACHE_DIR = cacheDir;
process.env.SESSIONS_MEMORY_DB = memoryDb;
process.env.SESSIONS_OPENCODE_DB = opencodeDb;
// Sessions are written between queries and the next query has to see them, so opt out of
// both freshness short-circuits: the in-process timer and the on-disk refresh marker a
// prior query (or a spawned child, which inherits this) left behind.
process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';

const cache = await import('./cache');

beforeEach(() => {
  // The cache module instance is shared across test files in one `bun test` run, so
  // re-assert this fixture's env and drop any connection another file opened. Each
  // query below then reopens against this fixture's index.db — order-independent.
  process.env.SESSIONS_CLAUDE_DIR = claudeDir;
  process.env.SESSIONS_PI_DIR = piDir;
  process.env.SESSIONS_CODEX_DIR = codexDir;
  process.env.SESSIONS_CACHE_DIR = cacheDir;
  process.env.SESSIONS_MEMORY_DB = memoryDb;
  process.env.SESSIONS_OPENCODE_DB = opencodeDb;
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the fixture dir
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
});

let seq = 0;

/**
 * Write a Claude session JSONL into the fixture, encoded under a project dir
 * named after the cwd (matching Claude's `~/.claude/projects/<slug>/<id>.jsonl`).
 */
function writeClaudeSession(opts: {
  cwd: string;
  firstPrompt: string;
  edits?: string[];
  closingUser?: string;
  closingAssistant?: string;
  createdAt?: string;
  gitBranch?: string;
}): string {
  const slug = opts.cwd.replaceAll('/', '-');
  const projDir = join(claudeDir, slug);
  mkdirSync(projDir, { recursive: true });
  const id = `sess-${seq++}`;
  const ts = opts.createdAt ?? '2026-06-19T10:00:00.000Z';
  const lines: string[] = [];
  const gb = opts.gitBranch ? { gitBranch: opts.gitBranch } : {};
  lines.push(
    JSON.stringify({ type: 'user', cwd: opts.cwd, timestamp: ts, ...gb, message: { content: opts.firstPrompt } }),
  );
  for (const f of opts.edits ?? []) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        cwd: opts.cwd,
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] },
      }),
    );
  }
  if (opts.closingUser) {
    lines.push(JSON.stringify({ type: 'user', cwd: opts.cwd, timestamp: ts, message: { content: opts.closingUser } }));
  }
  if (opts.closingAssistant) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        cwd: opts.cwd,
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'text', text: opts.closingAssistant }] },
      }),
    );
  }
  writeFileSync(join(projDir, `${id}.jsonl`), lines.join('\n'));
  return id;
}

function fakeRepo(container: string, branches: Record<string, string>, currentWorktree?: string): RepoInfo {
  return {
    gitCommonDir: join(container, '.bare'),
    container,
    currentWorktree: currentWorktree ?? container,
    branches: new Map(Object.entries(branches)),
    remote: '',
  };
}

describe('indexed-columns', () => {
  test('files_touched round-trips through JSON and closing_assistant is captured', async () => {
    const cwd = join(fixtureRoot, 'proj-a');
    writeClaudeSession({
      cwd,
      firstPrompt: 'build the thing',
      edits: ['/proj-a/x.ts', '/proj-a/y.ts'],
      closingUser: 'is it done?',
      closingAssistant: 'Yes, both files are updated and tests pass.',
      createdAt: '2026-06-19T09:00:00.000Z',
    });

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), {});
    expect(primer.isEmpty).toBe(false);
    expect(primer.recent).toHaveLength(1);
    const s = primer.recent[0]!;
    expect(s.files).toEqual(['/proj-a/x.ts', '/proj-a/y.ts']);
    expect(s.closing.assistant).toBe('Yes, both files are updated and tests pass.');
    expect(s.closing.user).toBe('is it done?');
    expect(s.intent).toBe('build the thing');
  });
});

// Note: these fixtures are 1-message sessions, so all are trivia. The detail
// tier is drawn via the significance fallback (no substantive sessions), and
// since equal significance makes blended score monotonic in recency, the order
// collapses back to created_at DESC — which is what these assertions expect.
describe('two-tier', () => {
  test('with 12 sessions and limit 10, recent has 10 and headlines has 2', async () => {
    const cwd = join(fixtureRoot, 'proj-tier');
    for (let i = 0; i < 12; i++) {
      const day = String(10 + i).padStart(2, '0');
      writeClaudeSession({ cwd, firstPrompt: `task ${i}`, createdAt: `2026-06-${day}T10:00:00.000Z` });
    }
    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { limit: 10 });
    expect(primer.recent).toHaveLength(10);
    expect(primer.headlines).toHaveLength(2);
    // Most recent first (created_at DESC).
    expect(primer.recent[0]!.intent).toBe('task 11');
  });
});

describe('worktree aggregation', () => {
  test('aggregates sessions across worktrees with branch labels and excludes a -v2 sibling', async () => {
    const container = join(fixtureRoot, 'dotfiles');
    const mainWt = join(container, 'wt', 'main');
    const featureWt = join(container, 'wt', 'feature');
    const sibling = join(fixtureRoot, 'dotfiles-v2');

    writeClaudeSession({ cwd: mainWt, firstPrompt: 'on main', createdAt: '2026-06-18T10:00:00.000Z' });
    writeClaudeSession({ cwd: featureWt, firstPrompt: 'on feature', createdAt: '2026-06-19T10:00:00.000Z' });
    writeClaudeSession({ cwd: sibling, firstPrompt: 'on v2 sibling', createdAt: '2026-06-19T11:00:00.000Z' });

    const repo = fakeRepo(container, { [mainWt]: 'main', [featureWt]: 'feature' });
    const primer = await cache.getContextPrimer(repo, {});

    const intents = primer.recent.map((s) => s.intent);
    expect(intents).toContain('on main');
    expect(intents).toContain('on feature');
    expect(intents).not.toContain('on v2 sibling'); // boundary-aware: sibling excluded

    const featureSession = primer.recent.find((s) => s.intent === 'on feature')!;
    expect(featureSession.branch).toBe('feature');
    const mainSession = primer.recent.find((s) => s.intent === 'on main')!;
    expect(mainSession.branch).toBe('main');
  });

  test('worktreeOnly narrows to the current worktree', async () => {
    const container = join(fixtureRoot, 'narrow');
    const mainWt = join(container, 'wt', 'main');
    const featureWt = join(container, 'wt', 'feature');
    writeClaudeSession({ cwd: mainWt, firstPrompt: 'narrow main', createdAt: '2026-06-18T10:00:00.000Z' });
    writeClaudeSession({ cwd: featureWt, firstPrompt: 'narrow feature', createdAt: '2026-06-19T10:00:00.000Z' });

    const repo = fakeRepo(container, { [mainWt]: 'main', [featureWt]: 'feature' }, featureWt);
    const primer = await cache.getContextPrimer(repo, { worktreeOnly: true });
    const intents = primer.recent.map((s) => s.intent);
    expect(intents).toEqual(['narrow feature']);
  });
});

describe('branch', () => {
  test('the indexed branch (from logs) wins over the worktree-derived label', async () => {
    const cwd = join(fixtureRoot, 'proj-branch');
    writeClaudeSession({ cwd, firstPrompt: 'do work', gitBranch: 'report-redesign' });
    // fakeRepo maps cwd -> 'feat/current' — what the buggy branchLabel would return.
    const primer = await cache.getContextPrimer(fakeRepo(cwd, { [cwd]: 'feat/current' }), {});
    expect(primer.recent[0]!.branch).toBe('report-redesign');
  });

  test('falls back to branchLabel when the session carries no branch', async () => {
    const cwd = join(fixtureRoot, 'proj-nobranch');
    writeClaudeSession({ cwd, firstPrompt: 'do work' });
    const primer = await cache.getContextPrimer(fakeRepo(cwd, { [cwd]: 'mapped-branch' }), {});
    expect(primer.recent[0]!.branch).toBe('mapped-branch');
  });
});

describe('significance', () => {
  test('a trivial session is demoted out of the detail tier into headlines', async () => {
    const cwd = join(fixtureRoot, 'proj-sig');
    // Trivial and most recent: 1 message, no edits, no artifact.
    writeClaudeSession({ cwd, firstPrompt: 'you here?', createdAt: '2026-06-23T10:00:00.000Z' });
    // Substantive but older: real edits + a PR URL in the closing.
    writeClaudeSession({
      cwd,
      firstPrompt: 'build the report redesign',
      edits: [`${cwd}/a.ts`, `${cwd}/b.ts`, `${cwd}/c.ts`],
      closingUser: 'commit and PR it',
      closingAssistant: 'PR is up: https://github.com/x/y/pull/16',
      createdAt: '2026-06-20T10:00:00.000Z',
    });

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), {});
    const recentIntents = primer.recent.map((s) => s.intent);
    const headlineIntents = primer.headlines.map((h) => h.intent);

    expect(recentIntents).toContain('build the report redesign'); // substantive leads the detail tier
    expect(recentIntents).not.toContain('you here?'); // trivia kept out despite being newest
    expect(headlineIntents).toContain('you here?'); // demoted, not dropped
  });
});

describe('empty-state', () => {
  test('a repo with no sessions yields isEmpty true and empty tiers', async () => {
    const empty = join(fixtureRoot, 'no-sessions-here');
    const primer = await cache.getContextPrimer(fakeRepo(empty, {}), {});
    expect(primer.isEmpty).toBe(true);
    expect(primer.recent).toEqual([]);
    expect(primer.headlines).toEqual([]);
    expect(primer.repoLabel).toBe('no-sessions-here');
  });
});

describe('searchSessions', () => {
  test('ranks by bm25 relevance, not recency — the stronger match wins even when older', async () => {
    const cwd = join(fixtureRoot, 'search-rank');
    // Older, but matches BOTH query terms (including the rare "plonkish").
    const strong = writeClaudeSession({
      cwd,
      firstPrompt: 'quokkavar plonkish',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    // Newer, but matches only the common term — under the old `ORDER BY date DESC`
    // this would have come first purely by recency.
    const weak = writeClaudeSession({ cwd, firstPrompt: 'quokkavar zzfiller', createdAt: '2026-06-20T10:00:00.000Z' });

    const results = await cache.searchSessions('quokkavar plonkish', { project: cwd, limit: 20 });
    const ids = results.map((r) => r.sessionId);
    expect(ids).toContain(strong);
    expect(ids).toContain(weak);
    expect(ids[0]).toBe(strong); // relevance beats recency
  });

  test('OR recall: a multi-word query still matches when only some terms are present', async () => {
    const cwd = join(fixtureRoot, 'search-or');
    const id = writeClaudeSession({ cwd, firstPrompt: 'fix the rate limiter on the api' });
    // Neither "yesterday" nor "afternoon" appears — the old strict-AND returned nothing.
    const results = await cache.searchSessions('rate limiter yesterday afternoon', { project: cwd, limit: 20 });
    expect(results.map((r) => r.sessionId)).toContain(id);
  });

  test('porter stemming connects inflected forms ("refactor" matches "refactoring")', async () => {
    const cwd = join(fixtureRoot, 'search-stem');
    const id = writeClaudeSession({ cwd, firstPrompt: 'refactoring the authentication layer' });
    const results = await cache.searchSessions('refactor', { project: cwd, limit: 20 });
    expect(results.map((r) => r.sessionId)).toContain(id);
  });

  test('assistant message text is searchable (a term only in the reply is found)', async () => {
    const cwd = join(fixtureRoot, 'search-asst');
    const id = writeClaudeSession({
      cwd,
      firstPrompt: 'why does the build keep failing',
      closingAssistant: 'the root cause was a quibblefrotz race in the scheduler',
    });
    const results = await cache.searchSessions('quibblefrotz', { project: cwd, limit: 20 });
    expect(results.map((r) => r.sessionId)).toContain(id);
    // and the snippet is drawn from the matching (assistant) column
    expect(results.find((r) => r.sessionId === id)!.displayText).toContain('quibblefrotz');
  });

  test('a term that appears nowhere returns no matches', async () => {
    const cwd = join(fixtureRoot, 'search-empty');
    writeClaudeSession({ cwd, firstPrompt: 'ordinary session about ordinary things' });
    const results = await cache.searchSessions('zzztotallyabsentzzz', { project: cwd, limit: 20 });
    expect(results).toHaveLength(0);
  });
});

const ctx = await import('./context');

describe('cli', () => {
  test('renderMarkdown produces two-tier headings, intent, files, and earlier bullets', () => {
    const primer: ContextPrimer = {
      repoLabel: 'myrepo',
      toolFilter: '',
      isEmpty: false,
      lessons: [],
      lessonsFlagged: 0,
      lessonsTotal: 0,
      lessonsQuarantined: [],
      recent: [
        {
          sessionId: 's1',
          tool: 'claude',
          branch: 'main',
          date: '2026-06-19',
          messageCount: 8,
          intent: 'wire up the renderer',
          files: ['/a/x.ts', '/a/y.ts'],
          opening: 'wire up the renderer',
          closing: { user: 'is it done?', assistant: 'yes, tests pass' },
        },
      ],
      headlines: [{ date: '2026-06-10', tool: 'codex', branch: 'main', intent: 'earlier task' }],
    };

    const md = ctx.renderMarkdown(primer, false);
    expect(md).toContain('## Recent');
    expect(md).toContain('## Earlier');
    expect(md).toContain('wire up the renderer'); // most-recent intent
    expect(md).toContain('/a/x.ts');
    expect(md).toContain('is it done?');
    expect(md).toContain('yes, tests pass');
    expect(md).toContain('- **2026-06-10**'); // earlier headline bullet
    expect(md).toContain('earlier task');
  });

  test('renderMarkdown on an empty primer emits the empty-state line and no tier headings', () => {
    const primer: ContextPrimer = {
      repoLabel: 'blank',
      toolFilter: '',
      isEmpty: true,
      lessons: [],
      lessonsFlagged: 0,
      lessonsTotal: 0,
      lessonsQuarantined: [],
      recent: [],
      headlines: [],
    };
    const md = ctx.renderMarkdown(primer, false);
    expect(md).toContain('No past sessions found for this repo.');
    expect(md).not.toContain('## Recent');
  });

  test('--full widens per-session detail (shows divergent opening, no file truncation)', () => {
    const files = Array.from({ length: 8 }, (_, i) => `/f/${i}.ts`);
    const primer: ContextPrimer = {
      repoLabel: 'r',
      toolFilter: '',
      isEmpty: false,
      lessons: [],
      lessonsFlagged: 0,
      lessonsTotal: 0,
      lessonsQuarantined: [],
      recent: [
        {
          sessionId: 's',
          tool: 'pi',
          branch: 'feat',
          date: '2026-06-19',
          messageCount: 3,
          intent: 'short title',
          files,
          opening: 'a much longer verbatim opening prompt that differs from the title',
          closing: { user: '', assistant: '' },
        },
      ],
      headlines: [],
    };

    const compact = ctx.renderMarkdown(primer, false);
    const full = ctx.renderMarkdown(primer, true);
    expect(compact).toContain('+3 more'); // 8 files, capped at 5
    expect(compact).not.toContain('much longer verbatim opening');
    expect(full).not.toContain('+3 more');
    expect(full).toContain('/f/7.ts');
    expect(full).toContain('much longer verbatim opening');
  });

  test('parseContextArgs parses flags', () => {
    const args = ctx.parseContextArgs(['--limit', '5', '--tool', 'codex', '--worktree', '--out', 'p.md', '--full']);
    expect(args.limit).toBe(5);
    expect(args.tool).toBe('codex');
    expect(args.worktreeOnly).toBe(true);
    expect(args.out).toBe('p.md');
    expect(args.full).toBe(true);
    expect(args.here).toBe(true);
  });

  test('parseContextArgs defaults', () => {
    const args = ctx.parseContextArgs([]);
    expect(args.limit).toBe(10);
    expect(args.tool).toBe('');
    expect(args.worktreeOnly).toBe(false);
    expect(args.full).toBe(false);
    expect(args.out).toBeUndefined();
    expect(args.days).toBeUndefined();
  });

  test('parseContextArgs rejects unknown flags via die', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as never);
    const errSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      expect(() => ctx.parseContextArgs(['--bogus'])).toThrow('exit');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('mcp', () => {
  test('the primer JSON the MCP tool serializes round-trips to the renderer-consumed shape', async () => {
    const cwd = join(fixtureRoot, 'mcp-parity');
    writeClaudeSession({
      cwd,
      firstPrompt: 'mcp parity intent',
      edits: ['/mcp-parity/a.ts'],
      closingUser: 'done?',
      closingAssistant: 'all green',
      createdAt: '2026-06-19T08:00:00.000Z',
    });

    // The MCP handler does exactly this: getContextPrimer → JSON.stringify(_, null, 2).
    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '', worktreeOnly: undefined });
    const json = JSON.stringify(primer, null, 2);
    const parsed = JSON.parse(json) as ContextPrimer;

    // Same structure the CLI renderer consumes — render it to prove parity.
    expect(parsed.isEmpty).toBe(false);
    expect(parsed.recent[0]!.intent).toBe('mcp parity intent');
    const md = ctx.renderMarkdown(parsed, false);
    expect(md).toContain('mcp parity intent');
    expect(md).toContain('/mcp-parity/a.ts');
    expect(md).toContain('all green');
  });
});

const memory = await import('./memory');

/**
 * The read half. A write path with no read path is a write-only log, which is the
 * problem this feature exists to solve — so these go end to end through
 * getContextPrimer, not through the store's own accessors.
 */
describe('lessons in the primer', () => {
  const NO_SOURCE = {
    sessionId: null,
    transcript: null,
    toolUseId: null,
    provenance: 'none' as const,
    verified: false,
    tool: '' as const,
  };

  function saveLesson(lesson: string, over: Partial<Parameters<typeof memory.rememberLesson>[0]> = {}) {
    return memory.rememberLesson({ lesson, source: NO_SOURCE, ...over });
  }

  beforeEach(() => {
    memory.closeMemoryDb();
    rmSync(memoryDb, { force: true });
  });

  test('a saved lesson reaches the primer for its repo, repo scope ahead of global', async () => {
    const cwd = join(fixtureRoot, 'lessons-basic');
    writeClaudeSession({ cwd, firstPrompt: 'some prior work' });
    saveLesson('The queue drains on shutdown, so a pending job is never lost.', {
      container: cwd,
      detail: 'src/queue.ts drain() awaits inflight',
      now: '2026-07-01T00:00:00.000Z',
    });
    saveLesson('Bun binaries busy-loop when orphaned on an EOF stdin.', {
      scope: 'global',
      now: '2026-07-02T00:00:00.000Z',
    });

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    expect(primer.lessons.map((l) => l.scope)).toEqual(['repo', 'global']);
    expect(primer.lessons[0]!.lesson).toContain('queue drains');
    expect(primer.lessonsTotal).toBe(2);
    expect(primer.lessonsFlagged).toBe(0);
  });

  test('another repo sees the global lesson and not the repo one', async () => {
    const cwd = join(fixtureRoot, 'lessons-scoped');
    const other = join(fixtureRoot, 'lessons-elsewhere');
    writeClaudeSession({ cwd, firstPrompt: 'work here' });
    writeClaudeSession({ cwd: other, firstPrompt: 'work there' });
    saveLesson('The queue drains on shutdown, so a pending job is never lost.', { container: cwd });
    saveLesson('Bun binaries busy-loop when orphaned on an EOF stdin.', { scope: 'global' });

    const primer = await cache.getContextPrimer(fakeRepo(other, {}), { tool: '' });
    expect(primer.lessons.map((l) => l.scope)).toEqual(['global']);
  });

  // Two contradictory lessons both served as fact is the highest-blast-radius
  // failure here, because the whole point of the read path is that the agent
  // trusts it. Neither is served; the count is.
  test('conflicting lessons are withheld from the primer and surfaced as a count', async () => {
    const cwd = join(fixtureRoot, 'lessons-conflict');
    writeClaudeSession({ cwd, firstPrompt: 'work with a contested lesson' });
    const A = 'The lesson store lives outside the cache directory.';
    const B = 'The lesson store lives inside the cache directory.';
    const first = saveLesson(A, { container: cwd });
    const second = saveLesson(B, { container: cwd });
    expect(second.outcome).toBe('conflict');

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    expect(primer.lessons).toEqual([]);
    expect(primer.lessonsFlagged).toBe(2);
    expect(primer.lessonsTotal).toBe(0);

    // Nothing merged, nothing overwritten: both texts are still exactly as written.
    const rows = memory.listLessons({ all: true });
    expect(rows.find((r) => r.id === first.id)!.lesson).toBe(A);
    expect(rows.find((r) => r.id === second.id)!.lesson).toBe(B);
    expect(rows.every((r) => r.status === 'needs_review')).toBe(true);
    expect(new Set(rows.map((r) => r.review_group)).size).toBe(1);

    const md = ctx.renderMarkdown(primer, false);
    expect(md).not.toContain('lesson store lives');
    expect(md).toContain('2 lessons flagged as conflicting');
  });

  test('a repo with lessons but no indexed sessions is not an empty primer', async () => {
    const cwd = join(fixtureRoot, 'lessons-only');
    saveLesson('Nothing has been indexed here yet, but this was still learned.', { container: cwd });

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    expect(primer.isEmpty).toBe(false);
    expect(primer.recent).toEqual([]);
    const md = ctx.renderMarkdown(primer, false);
    expect(md).toContain('## Lessons');
    expect(md).not.toContain('No past sessions found');
  });

  test('the Lessons section renders before Recent, marking unverified sources', async () => {
    const cwd = join(fixtureRoot, 'lessons-render');
    writeClaudeSession({ cwd, firstPrompt: 'render ordering check' });
    saveLesson('An unverified lesson still shows, but says so.', { container: cwd });
    saveLesson('A verified lesson carries no mark.', {
      container: cwd,
      source: { ...NO_SOURCE, sessionId: 'sess-1', provenance: 'hook', verified: true, tool: 'claude' },
    });

    const md = ctx.renderMarkdown(await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' }), false);
    expect(md.indexOf('## Lessons')).toBeLessThan(md.indexOf('## Recent'));
    expect(md).toMatch(/An unverified lesson still shows, but says so\..*unverified source/);
    expect(md).toMatch(/A verified lesson carries no mark\. _\(#\d+\)_/);
  });

  test('a capped list says how many it left out', async () => {
    const cwd = join(fixtureRoot, 'lessons-capped');
    writeClaudeSession({ cwd, firstPrompt: 'lots of lessons here' });
    const lessons = [
      'Worktrees collapse to one container key.',
      'Timezone bucketing happens once, in the report pipeline.',
      'Trajectory export drops reasoning blocks.',
      'The fzf picker reads from stderr.',
      'Pricing data is embedded at build time.',
      'OpenCode keeps conversations in one SQLite file.',
    ];
    lessons.forEach((l, i) => saveLesson(l, { container: cwd, now: `2026-07-0${i + 1}T00:00:00.000Z` }));

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '', lessonLimit: 3 });
    expect(primer.lessons.length).toBe(3);
    expect(primer.lessonsTotal).toBe(6);
    expect(ctx.renderMarkdown(primer, false)).toContain('+3 more');
  });

  test('the char budget drops whole lessons, never half of one', async () => {
    const cwd = join(fixtureRoot, 'lessons-budget');
    writeClaudeSession({ cwd, firstPrompt: 'budget check' });
    const long = (n: number) => `Lesson ${n} ${'w'.repeat(200)}`;
    for (let i = 0; i < 3; i++) {
      saveLesson(long(i), { container: cwd, now: `2026-07-0${i + 1}T00:00:00.000Z` });
    }

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    const md = ctx.renderMarkdown(primer, false, 250);
    const bullets = md.split('\n').filter((l) => l.startsWith('- Lesson '));
    expect(bullets.length).toBeLessThan(3);
    for (const b of bullets) expect(b).toMatch(/_\(#\d+[^)]*\)_$/); // every rendered lesson is whole
    expect(md).toContain('more — run `sessions lessons`');
  });

  // A corrupt store reads as "nothing was ever saved" on every surface unless the
  // quarantine is carried through the primer, so this goes end to end too.
  test('a quarantined store is reported by the primer instead of showing no lessons', async () => {
    const cwd = join(fixtureRoot, 'lessons-corrupt');
    writeClaudeSession({ cwd, firstPrompt: 'work over a broken store' });
    saveLesson('This lesson is about to become unreadable.', { container: cwd });
    memory.closeMemoryDb();
    writeFileSync(memoryDb, 'this is not a sqlite database at all');

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    expect(primer.lessons).toEqual([]);
    expect(primer.lessonsQuarantined.length).toBe(1);
    expect(primer.isEmpty).toBe(false);
    expect(existsSync(memoryDb)).toBe(false); // the read did not conjure a replacement

    const md = ctx.renderMarkdown(primer, false);
    expect(md).toContain('## Lessons');
    expect(md).toContain('The lesson store was corrupt and moved to');
    expect(md).toContain('.corrupt-');

    for (const f of readdirSync(dirname(memoryDb))) {
      if (f.includes('.corrupt-')) rmSync(join(dirname(memoryDb), f));
    }
  });

  test('a repo with only a quarantined store is not an empty primer', async () => {
    const cwd = join(fixtureRoot, 'lessons-corrupt-only');
    writeFileSync(memoryDb, 'this is not a sqlite database at all');

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), { tool: '' });
    expect(primer.isEmpty).toBe(false);
    expect(ctx.renderMarkdown(primer, false)).toContain('corrupt');

    for (const f of readdirSync(dirname(memoryDb))) {
      if (f.includes('.corrupt-')) rmSync(join(dirname(memoryDb), f));
    }
  });
});

/**
 * The hook now reads stdin to capture the SessionStart payload. A client that pipes
 * nothing leaves it open forever, and the hook has a 10s budget it must stay well
 * inside — so the read is raced and then abandoned.
 */
describe('the SessionStart hook stays inside its budget', () => {
  const repoRoot = join(import.meta.dir, '..');

  test('stdin that never closes still exits promptly and injects nothing', async () => {
    const notARepo = join(fixtureRoot, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });

    const started = Date.now();
    const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'index.ts'), 'context', '--hook'], {
      cwd: notARepo,
      stdin: 'pipe', // opened and never written to or closed
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SESSIONS_CLAUDE_DIR: claudeDir,
        SESSIONS_PI_DIR: piDir,
        SESSIONS_CODEX_DIR: codexDir,
        SESSIONS_CACHE_DIR: cacheDir,
        SESSIONS_MEMORY_DB: memoryDb,
        SESSIONS_OPENCODE_DB: opencodeDb,
        SESSIONS_HANDOFF_DIR: join(fixtureRoot, 'handoff'),
      },
    });

    const code = await proc.exited;
    const elapsed = Date.now() - started;

    expect(code).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('');
    expect(elapsed).toBeLessThan(5000); // HOOK_TIMEOUT_MS is 10s; this must not approach it
  }, 15000);

  test('a piped SessionStart payload becomes a handoff the MCP server can resolve', async () => {
    const handoffDir = join(fixtureRoot, 'handoff-write');
    const notARepo = join(fixtureRoot, 'not-a-repo-2');
    mkdirSync(notARepo, { recursive: true });
    const transcript = join(fixtureRoot, 'transcript.jsonl');
    writeFileSync(transcript, '{}\n');

    const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'index.ts'), 'context', '--hook'], {
      cwd: notARepo,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: '11772ef1-6b80-46ec-9f32-97cd785efa1f',
          transcript_path: transcript,
          cwd: notARepo,
          hook_event_name: 'SessionStart',
          source: 'resume',
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SESSIONS_CLAUDE_DIR: claudeDir,
        SESSIONS_PI_DIR: piDir,
        SESSIONS_CODEX_DIR: codexDir,
        SESSIONS_CACHE_DIR: cacheDir,
        SESSIONS_MEMORY_DB: memoryDb,
        SESSIONS_OPENCODE_DB: opencodeDb,
        SESSIONS_HANDOFF_DIR: handoffDir,
        // The measured `claude -c` case: the env id is stale, the payload id is real.
        CLAUDE_CODE_SESSION_ID: 'c57c50e1-0000-4000-8000-000000000000',
      },
    });
    expect(await proc.exited).toBe(0);

    process.env.SESSIONS_HANDOFF_DIR = handoffDir;
    const prov = await import('./provenance');
    // Keyed by the stale env value both processes share; carrying the real id.
    const handoff = prov.readHandoff('c57c50e1-0000-4000-8000-000000000000');
    expect(handoff?.sessionId).toBe('11772ef1-6b80-46ec-9f32-97cd785efa1f');
    expect(handoff?.transcriptPath).toBe(transcript);
    expect(handoff?.source).toBe('resume');
    delete process.env.SESSIONS_HANDOFF_DIR;
  }, 15000);

  /**
   * The standing pointer is the only thing that fires at the moment something is
   * learned. Everything else — the server instructions, the context skill — fires at
   * session start or on "catch me up", which is the wrong end of the session.
   */
  test('the standing pointer names the write tool, not only the read ones', async () => {
    const repo = join(fixtureRoot, 'hook-pointer');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', repo]);
    writeClaudeSession({ cwd: realpathSync(repo), firstPrompt: 'something worth priming' });

    const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'index.ts'), 'context', '--hook'], {
      cwd: repo,
      stdin: new TextEncoder().encode('{}'),
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        ...process.env,
        SESSIONS_CLAUDE_DIR: claudeDir,
        SESSIONS_PI_DIR: piDir,
        SESSIONS_CODEX_DIR: codexDir,
        SESSIONS_CACHE_DIR: cacheDir,
        SESSIONS_MEMORY_DB: memoryDb,
        SESSIONS_OPENCODE_DB: opencodeDb,
        SESSIONS_HANDOFF_DIR: join(fixtureRoot, 'handoff-pointer'),
      },
    });

    expect(await proc.exited).toBe(0);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain('search_sessions');
    expect(out).toContain('remember_lesson');
  }, 15000);
});
