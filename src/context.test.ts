import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoInfo } from './repo';

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
