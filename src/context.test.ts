import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoInfo } from './repo';
import type { ContextPrimer } from './types';

// Point the index at hermetic temp dirs. cache.ts now resolves SESSIONS_* lazily,
// and a beforeEach re-asserts these on the shared module instance before each test.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-ctx-')));
const claudeDir = join(fixtureRoot, 'claude');
const piDir = join(fixtureRoot, 'pi');
const codexDir = join(fixtureRoot, 'codex');
const cacheDir = join(fixtureRoot, 'cache');
const archiveDir = join(fixtureRoot, 'archive'); // hermetic vault; keep off the real ~/.local/share
const opencodeDb = join(fixtureRoot, 'opencode.db'); // absent → no OpenCode sessions leak in
for (const d of [claudeDir, piDir, codexDir, cacheDir]) mkdirSync(d, { recursive: true });

process.env.SESSIONS_CLAUDE_DIR = claudeDir;
process.env.SESSIONS_PI_DIR = piDir;
process.env.SESSIONS_CODEX_DIR = codexDir;
process.env.SESSIONS_CACHE_DIR = cacheDir;
process.env.SESSIONS_OPENCODE_DB = opencodeDb;
process.env.SESSIONS_ARCHIVE_DIR = archiveDir;

const cache = await import('./cache');

beforeEach(() => {
  // The cache module instance is shared across test files in one `bun test` run, so
  // re-assert this fixture's env and drop any connection another file opened. Each
  // query below then reopens against this fixture's index.db — order-independent.
  process.env.SESSIONS_CLAUDE_DIR = claudeDir;
  process.env.SESSIONS_PI_DIR = piDir;
  process.env.SESSIONS_CODEX_DIR = codexDir;
  process.env.SESSIONS_CACHE_DIR = cacheDir;
  process.env.SESSIONS_OPENCODE_DB = opencodeDb;
  process.env.SESSIONS_ARCHIVE_DIR = archiveDir;
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the fixture dir
  rmSync(fixtureRoot, { recursive: true, force: true });
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

  // The tests above use the BARE layout, where every worktree lives under the container and
  // one prefix covers them all. A NORMAL repo is the case that container-and-descendants
  // silently gets wrong: `git worktree add ../feature` puts the worktree BESIDE the main
  // one, and `container` falls back to `--show-toplevel`, which is whichever worktree the
  // caller is standing in — so aggregation returned only the current worktree from either
  // side while advertising that it spanned them.
  describe('normal repo, sibling worktrees', () => {
    const mainWt = join(fixtureRoot, 'normal-repo');
    const linkedWt = join(fixtureRoot, 'normal-repo-feature');
    /** Same path prefix as the main worktree, NOT a worktree of it. Only a prefix rule could
     *  ever match this, which is why it stays in the fixture. */
    const decoy = join(fixtureRoot, 'normal-repo-v2');
    const worktrees = { [mainWt]: 'main', [linkedWt]: 'feature' };

    // Seeded once, in the describe body: three tests read the same three sessions, and a
    // beforeEach would write a fresh copy of each before every one of them.
    writeClaudeSession({ cwd: mainWt, firstPrompt: 'on the main worktree', createdAt: '2026-06-18T10:00:00.000Z' });
    writeClaudeSession({ cwd: linkedWt, firstPrompt: 'on the linked worktree', createdAt: '2026-06-19T10:00:00.000Z' });
    writeClaudeSession({ cwd: decoy, firstPrompt: 'on the v2 decoy', createdAt: '2026-06-20T10:00:00.000Z' });

    test('aggregates from the main worktree', async () => {
      const primer = await cache.getContextPrimer(fakeRepo(mainWt, worktrees, mainWt), {});
      const intents = primer.recent.map((s) => s.intent);
      expect(intents).toContain('on the main worktree');
      expect(intents).toContain('on the linked worktree');
      expect(intents).not.toContain('on the v2 decoy');
    });

    test('aggregates from the linked worktree, where the container resolves to the linked path', async () => {
      // What resolveRepo really returns from inside a linked worktree: container ===
      // currentWorktree === the linked path, which has the main worktree nowhere under it.
      const primer = await cache.getContextPrimer(fakeRepo(linkedWt, worktrees, linkedWt), {});
      const intents = primer.recent.map((s) => s.intent);
      expect(intents).toContain('on the linked worktree');
      expect(intents).toContain('on the main worktree');
      expect(intents).not.toContain('on the v2 decoy');
    });

    test('worktreeOnly still narrows to one sibling', async () => {
      const primer = await cache.getContextPrimer(fakeRepo(linkedWt, worktrees, linkedWt), { worktreeOnly: true });
      expect(primer.recent.map((s) => s.intent)).toEqual(['on the linked worktree']);
    });
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

describe('files cap', () => {
  test('a 40-file session is capped in the primer while fileCount reports the true total', async () => {
    const cwd = join(fixtureRoot, 'proj-filecap');
    const edits = Array.from({ length: 40 }, (_, i) => `${cwd}/src/feature-${i}/index.ts`);
    writeClaudeSession({ cwd, firstPrompt: 'touch everything', edits, createdAt: '2026-06-21T10:00:00.000Z' });

    const primer = await cache.getContextPrimer(fakeRepo(cwd, {}), {});
    const s = primer.recent[0]!;
    expect(s.files).toHaveLength(10); // MAX_FILES from search-format
    expect(s.fileCount).toBe(40);
    // Cap, not sample: the kept paths are the head of the indexed list.
    expect(s.files[0]).toBe(edits[0]);
  });

  test('the primer renderer counts hidden files from fileCount, not the capped array', () => {
    const primer: ContextPrimer = {
      repoLabel: 'r',
      toolFilter: '',
      isEmpty: false,
      recent: [
        {
          sessionId: 's',
          tool: 'claude',
          branch: 'main',
          date: '2026-06-21',
          messageCount: 40,
          intent: 'touch everything',
          files: Array.from({ length: 10 }, (_, i) => `/r/f${i}.ts`), // already capped upstream
          fileCount: 40,
          opening: 'touch everything',
          closing: { user: '', assistant: '' },
        },
      ],
      headlines: [],
      memory: [],
      memoryTotal: 0,
    };
    // 5 shown of 40 touched, not 5 of the 10 that survived the cap.
    expect(ctx.renderMarkdown(primer, false)).toContain('(+35 more)');
    // --full shows every file it was given and still admits the producer truncated.
    expect(ctx.renderMarkdown(primer, true)).toContain('(+30 more)');
  });
});

describe('cli', () => {
  test('renderMarkdown produces two-tier headings, intent, files, and earlier bullets', () => {
    const primer: ContextPrimer = {
      repoLabel: 'myrepo',
      toolFilter: '',
      isEmpty: false,
      recent: [
        {
          sessionId: 's1',
          tool: 'claude',
          branch: 'main',
          date: '2026-06-19',
          messageCount: 8,
          intent: 'wire up the renderer',
          files: ['/a/x.ts', '/a/y.ts'],
          fileCount: 2,
          opening: 'wire up the renderer',
          closing: { user: 'is it done?', assistant: 'yes, tests pass' },
        },
      ],
      headlines: [{ date: '2026-06-10', tool: 'codex', branch: 'main', intent: 'earlier task' }],
      memory: [],
      memoryTotal: 0,
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
      recent: [],
      headlines: [],
      memory: [],
      memoryTotal: 0,
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
      recent: [
        {
          sessionId: 's',
          tool: 'pi',
          branch: 'feat',
          date: '2026-06-19',
          messageCount: 3,
          intent: 'short title',
          files,
          fileCount: files.length,
          opening: 'a much longer verbatim opening prompt that differs from the title',
          closing: { user: '', assistant: '' },
        },
      ],
      headlines: [],
      memory: [],
      memoryTotal: 0,
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
    // SAFETY: mockImplementation's overloads reject the throwing stub's signature; the
    // cast is the test's way to replace process.exit with a throw.
    const exitSpy = spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as never);
    // SAFETY: same overload escape for stderr.write, which the stub silences.
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
    // SAFETY: json is JSON.stringify(primer) — a same-process round-trip of the object above.
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
