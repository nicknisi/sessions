import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// The standing guard on the "git writes are out of scope" exclusion: every why form
// consults git read-only (log/blame/show/cat-file) and must leave the repository
// byte-identical — no hooks, no trailers, no branches, no stray objects in the index.

let tmp: string;
let repo: string;
let sha: string;
let correlate: typeof import('./correlate');
let cache: typeof import('../cache');

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...env } });
  return new TextDecoder().decode(r.stdout).trim();
}

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

function snapshot(): { status: string; head: string } {
  return {
    status: git(join(tmp, 'repo'), ['status', '--porcelain']),
    head: git(join(tmp, 'repo'), ['rev-parse', 'HEAD']),
  };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'why-norepo-'));
  setEnv();
  const gitDir = join(tmp, 'repo');
  mkdirSync(gitDir, { recursive: true });
  git(gitDir, ['init', '-q', '-b', 'main']);
  git(gitDir, ['config', 'user.email', 'test@example.com']);
  git(gitDir, ['config', 'user.name', 'Test']);
  const abs = join(gitDir, 'src/x.ts');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\nexport const y = 2;\n');
  git(gitDir, ['add', '-A']);
  git(gitDir, ['commit', '-m', 'seed'], {
    GIT_AUTHOR_DATE: '2026-06-15T12:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-06-15T12:00:00+00:00',
  });
  repo = git(gitDir, ['rev-parse', '--show-toplevel']);
  sha = git(gitDir, ['rev-parse', 'HEAD']);
  correlate = require('./correlate');
  cache = require('../cache');
});

afterAll(() => {
  cache.closeDb();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
});

test('every why form leaves porcelain status and HEAD byte-identical', async () => {
  setEnv();
  cache.closeDb();
  const before = snapshot();
  await correlate.why('src/x.ts', repo); // file
  await correlate.why('src/x.ts:2', repo); // line
  await correlate.why(sha, repo); // commit
  await correlate.why('anything at all', repo); // query
  const after = snapshot();
  expect(after.status).toBe(before.status);
  expect(after.head).toBe(before.head);
});
