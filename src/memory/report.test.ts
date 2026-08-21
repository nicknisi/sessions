import { describe, test, expect, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReportScope } from './report';
import { makeTmp } from './fixtures';

// The phase-3 spec's scope-drift mitigation, asserted directly: the CLI and the
// get_memory_recurrence MCP tool share resolveReportScope, so this matrix — repo /
// all / defaulted-cwd, inside and outside a git repo — is the parity both surfaces
// are held to. mcp-read-only.test.ts proves the tool is read-only and
// schema-conformant; this file proves the scoping both callers inherit.

// Isolate from the user's global git config, matching scope.test.ts.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  const sh = (args: string[]): void => {
    const r = Bun.spawnSync(['git', '-C', path, '-c', 'commit.gpgsign=false', ...args], { env: GIT_ENV });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
  };
  sh(['init', '-q', '-b', 'main']);
  writeFileSync(join(path, 'a.txt'), 'hi\n');
  sh(['add', 'a.txt']);
  sh(['commit', '-q', '-m', 'init']);
}

const tmp = makeTmp('memory-report');
const repo = join(tmp, 'repos', 'app');
const notARepo = join(tmp, 'elsewhere');
initRepo(repo);
mkdirSync(notARepo, { recursive: true });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveReportScope', () => {
  test('all: true reports across everything and overrides any repo', () => {
    expect(resolveReportScope({ all: true })).toEqual({ outsideRepo: false });
    expect(resolveReportScope({ all: true, repo })).toEqual({ outsideRepo: false });
  });

  test('an explicit repo is containerized: a subdirectory scopes to its repo', () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    expect(resolveReportScope({ repo: sub })).toEqual({ repo, outsideRepo: false });
  });

  test('an explicit repo that is not a git repo scopes to itself', () => {
    expect(resolveReportScope({ repo: notARepo })).toEqual({ repo: notARepo, outsideRepo: false });
  });

  test('a defaulted cwd inside a git repo scopes to the repo container', () => {
    expect(resolveReportScope({ cwd: repo })).toEqual({ repo, outsideRepo: false });
  });

  test('a defaulted cwd outside any git repo falls back to all repos and says so', () => {
    expect(resolveReportScope({ cwd: notARepo })).toEqual({ outsideRepo: true });
  });
});
