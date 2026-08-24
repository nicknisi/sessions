import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// The CLI calls process.exit, so it is exercised as a subprocess: `bun index.ts why …`
// run in the fixture repo with hermetic SESSIONS_* env, asserting stdout and exit codes.

const INDEX = join(import.meta.dir, '..', '..', 'index.ts');

let tmp: string;
let repo: string;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...env } });
  return new TextDecoder().decode(r.stdout).trim();
}

function whyEnv() {
  return {
    ...process.env,
    SESSIONS_CACHE_DIR: join(tmp, 'cache'),
    SESSIONS_CLAUDE_DIR: join(tmp, 'claude'),
    SESSIONS_PI_DIR: join(tmp, 'pi'),
    SESSIONS_CODEX_DIR: join(tmp, 'codex'),
    SESSIONS_OPENCODE_DB: join(tmp, 'opencode.db'),
    SESSIONS_ARCHIVE_DIR: join(tmp, 'archive'),
    SESSIONS_REFRESH_INTERVAL_MS: '0',
    NO_COLOR: '1',
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[]): CliResult {
  const r = Bun.spawnSync([process.execPath, INDEX, 'why', ...args], { cwd, env: whyEnv() });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'why-cli-'));
  const gitDir = join(tmp, 'repo');
  mkdirSync(gitDir, { recursive: true });
  git(gitDir, ['init', '-q', '-b', 'main']);
  git(gitDir, ['config', 'user.email', 'test@example.com']);
  git(gitDir, ['config', 'user.name', 'Test']);
  const abs = join(gitDir, 'src/x.ts');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n');
  git(gitDir, ['add', '-A']);
  git(gitDir, ['commit', '-m', 'seed x'], {
    GIT_AUTHOR_DATE: '2026-06-15T12:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-06-15T12:00:00+00:00',
  });
  repo = git(gitDir, ['rev-parse', '--show-toplevel']);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('--json emits the structured evidence with the resolved commit', () => {
  const { code, stdout } = runCli(repo, ['src/x.ts', '--json']);
  expect(code).toBe(0);
  const evidence = JSON.parse(stdout);
  expect(evidence.commit.subject).toBe('seed x');
  expect(Array.isArray(evidence.sessions)).toBe(true);
});

test('human rendering prints the commit header', () => {
  const { code, stdout } = runCli(repo, ['src/x.ts']);
  expect(code).toBe(0);
  expect(stdout).toContain('seed x');
});

test('a non-git cwd exits 1 with a clean error', () => {
  const bare = mkdtempSync(join(tmpdir(), 'why-cli-nogit-'));
  try {
    const { code, stderr } = runCli(bare, ['src/x.ts']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('git');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('an unknown path in the repo exits 1', () => {
  const { code } = runCli(repo, ['src/does-not-exist.ts']);
  expect(code).toBe(1);
});

test('no target exits 1', () => {
  const { code } = runCli(repo, []);
  expect(code).toBe(1);
});
