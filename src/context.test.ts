import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoInfo } from './repo';
import type { ContextPrimer } from './types';

// Point the index at hermetic temp dirs BEFORE importing the cache module, since
// it captures these paths in module constants at import time.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-ctx-')));
const claudeDir = join(fixtureRoot, 'claude');
const piDir = join(fixtureRoot, 'pi');
const codexDir = join(fixtureRoot, 'codex');
const cacheDir = join(fixtureRoot, 'cache');
for (const d of [claudeDir, piDir, codexDir, cacheDir]) mkdirSync(d, { recursive: true });

process.env.SESSIONS_CLAUDE_DIR = claudeDir;
process.env.SESSIONS_PI_DIR = piDir;
process.env.SESSIONS_CODEX_DIR = codexDir;
process.env.SESSIONS_CACHE_DIR = cacheDir;

const cache = await import('./cache');

afterAll(() => {
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
}): string {
  const slug = opts.cwd.replaceAll('/', '-');
  const projDir = join(claudeDir, slug);
  mkdirSync(projDir, { recursive: true });
  const id = `sess-${seq++}`;
  const ts = opts.createdAt ?? '2026-06-19T10:00:00.000Z';
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'user', cwd: opts.cwd, timestamp: ts, message: { content: opts.firstPrompt } }));
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

const ctx = await import('./context');

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
