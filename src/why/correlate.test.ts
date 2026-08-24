import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { JsonObject, JsonValue } from '../extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
let repo: string; // the resolved toplevel (realpath) — sessions cwd must match this
let correlate: typeof import('./correlate');
let cache: typeof import('../cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0'; // re-index on every query
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...env } });
  return new TextDecoder().decode(r.stdout).trim();
}

/** Commit `relPath` = `content` with a pinned author/committer time; returns the sha. */
function commit(gitDir: string, relPath: string, content: string, dateIso: string, subject: string): string {
  const abs = join(gitDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(gitDir, ['add', '-A']);
  git(gitDir, ['commit', '-m', subject], { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso });
  return git(gitDir, ['rev-parse', 'HEAD']);
}

// —— session fixtures (cwd = the resolved repo toplevel) ——

function writeClaude(id: string, records: JsonObject[]): string {
  const dir = join(process.env.SESSIONS_CLAUDE_DIR!, 'proj');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, records.map(j).join('\n'));
  return p;
}

function writePi(id: string, records: JsonObject[]): string {
  const dir = join(process.env.SESSIONS_PI_DIR!, 'proj');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, records.map(j).join('\n'));
  return p;
}

function writeCodex(id: string, records: JsonObject[]): string {
  const dir = join(process.env.SESSIONS_CODEX_DIR!, '2026', '06');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, records.map(j).join('\n'));
  return p;
}

/** A Claude session that edited `absFiles` between start and end. */
function claudeSession(start: string, end: string, absFiles: string[], text: string): JsonObject[] {
  return [
    { type: 'user', cwd: repo, timestamp: start, gitBranch: 'main', message: { role: 'user', content: text } },
    ...absFiles.map((f) => ({
      type: 'assistant',
      cwd: repo,
      timestamp: start,
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] },
    })),
    {
      type: 'assistant',
      cwd: repo,
      timestamp: end,
      message: { role: 'assistant', content: [{ type: 'text', text: `${text} done` }] },
    },
  ];
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'why-'));
  setEnv();
  const gitDir = join(tmp, 'repo');
  mkdirSync(gitDir, { recursive: true });
  git(gitDir, ['init', '-q', '-b', 'main']);
  git(gitDir, ['config', 'user.email', 'test@example.com']);
  git(gitDir, ['config', 'user.name', 'Test']);
  git(gitDir, ['config', 'commit.gpgsign', 'false']);
  repo = git(gitDir, ['rev-parse', '--show-toplevel']); // realpath toplevel

  // Three commits: target.ts (v1 then v2), and other.ts. Author times pinned.
  commit(gitDir, 'src/target.ts', 'export const a = 1;\n', '2026-06-10T09:00:00+00:00', 'add target');
  commit(gitDir, 'src/other.ts', 'export const b = 2;\n', '2026-06-15T11:00:00+00:00', 'add other');
  commit(
    gitDir,
    'src/target.ts',
    'export const a = 1;\nexport const c = 3;\n',
    '2026-06-15T12:00:00+00:00',
    'extend target',
  );

  // Claude session: edited target.ts (absolute path) inside the window of the last
  // target commit (12:00). Commit lands 30 min after session end → files+time.
  writeClaude(
    'cl1',
    claudeSession(
      '2026-06-15T10:00:00.000Z',
      '2026-06-15T11:30:00.000Z',
      [join(repo, 'src/target.ts')],
      'extend target',
    ),
  );

  // Codex session: repo-RELATIVE apply_patch to the same file, same window → the
  // absolute-vs-relative normalization must still intersect.
  const patch = ['*** Begin Patch', '*** Update File: src/target.ts', '@@', '+x', '*** End Patch'].join('\n');
  writeCodex('cx1', [
    { type: 'session_meta', timestamp: '2026-06-15T10:05:00.000Z', payload: { cwd: repo, git: { branch: 'main' } } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch target' }] },
    },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'patched target file' }] },
      timestamp: '2026-06-15T11:00:00.000Z',
    },
  ]);

  // Pi session: disjoint file (other.ts) in the same window → time-only.
  writePi('pi1', [
    { type: 'session', id: 'pi1', cwd: repo, timestamp: '2026-06-15T10:10:00.000Z' },
    {
      type: 'message',
      id: 'u1',
      parentId: 'pi1',
      timestamp: '2026-06-15T10:10:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'touch other' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-06-15T10:40:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'edit_1', name: 'edit', arguments: { path: join(repo, 'src/other.ts') } }],
      },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      timestamp: '2026-06-15T11:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'edited other file' }] },
    },
  ]);

  // Pi session: edited the COMMITTED file (target.ts) in the same window → files+time.
  // Regression guard for the extract-files no-op: before Pi extraction landed this reached
  // only time-only because files_touched was empty for every Pi session.
  writePi('pi2', [
    { type: 'session', id: 'pi2', cwd: repo, timestamp: '2026-06-15T10:15:00.000Z' },
    {
      type: 'message',
      id: 'u1',
      parentId: 'pi2',
      timestamp: '2026-06-15T10:15:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'extend target' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-06-15T10:45:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'edit_1', name: 'edit', arguments: { path: join(repo, 'src/target.ts') } }],
      },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      timestamp: '2026-06-15T11:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'edited target file' }] },
    },
  ]);

  // A session well outside the window (days earlier) → excluded entirely.
  writeClaude(
    'old',
    claudeSession('2026-06-01T09:00:00.000Z', '2026-06-01T09:30:00.000Z', [join(repo, 'src/target.ts')], 'old work'),
  );

  correlate = require('./correlate');
  cache = require('../cache');
});

afterAll(() => {
  cache.closeDb();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
});

describe('why — file form', () => {
  test('resolves the most recent commit and ranks files+time above time-only', async () => {
    setEnv();
    cache.closeDb();
    const out = await correlate.why('src/target.ts', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit?.subject).toBe('extend target');
    // target-touching sessions (claude abs + codex repo-relative) are files+time.
    const byTool = new Map(out.evidence.sessions.map((s) => [s.tool, s]));
    expect(byTool.get('claude')?.confidence).toBe('files+time');
    expect(byTool.get('claude')?.overlappingFiles).toContain('src/target.ts');
    expect(byTool.get('codex')?.confidence).toBe('files+time'); // repo-relative intersects
    expect(byTool.get('codex')?.overlappingFiles).toContain('src/target.ts');
    // the disjoint pi session is time-only, ranked below the two file matches.
    expect(byTool.get('pi')?.confidence).toBe('time-only');
    const filesTimeFirst = out.evidence.sessions.findIndex((s) => s.confidence === 'time-only');
    expect(out.evidence.sessions.slice(0, filesTimeFirst).every((s) => s.confidence === 'files+time')).toBe(true);
    // the days-earlier session is excluded from the window.
    expect(out.evidence.sessions.every((s) => s.headline !== 'old work')).toBe(true);
  });

  test('a Pi session that edited the committed file correlates files+time (regression for the no-op)', async () => {
    setEnv();
    cache.closeDb();
    const out = await correlate.why('src/target.ts', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    const pi2 = out.evidence.sessions.find((s) => s.sessionId === 'pi2');
    expect(pi2).toBeDefined();
    expect(pi2!.tool).toBe('pi');
    expect(pi2!.confidence).toBe('files+time');
    expect(pi2!.overlappingFiles).toContain('src/target.ts');
  });

  test('file:line resolves via git blame to the line-owning commit', async () => {
    setEnv();
    cache.closeDb();
    // line 2 of target.ts was added by "extend target".
    const out = await correlate.why('src/target.ts:2', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit?.subject).toBe('extend target');
  });
});

describe('why — commit form', () => {
  test('a sha resolves to that commit and its sessions', async () => {
    setEnv();
    cache.closeDb();
    const sha = git(join(tmp, 'repo'), ['rev-parse', 'HEAD']);
    const out = await correlate.why(sha, repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit?.sha).toBe(sha);
    expect(out.evidence.sessions.length).toBeGreaterThan(0);
  });

  test('HEAD~n resolves to the commit form (not a literal text search)', async () => {
    setEnv();
    cache.closeDb();
    // HEAD is "extend target", HEAD~1 "add other", HEAD~2 "add target".
    const out = await correlate.why('HEAD~2', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit?.subject).toBe('add target');
  });

  test('a hex string that is not a commit degrades to the query form', async () => {
    setEnv();
    cache.closeDb();
    // git cat-file rejects it, so it is not a commit target; it has no slash or
    // extension, so it is not a path either — it falls through to a free-text query.
    const out = await correlate.why('deadbeefdeadbeef', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit).toBeNull();
  });
});

describe('why — query form', () => {
  test('free text searches this repo with a null commit', async () => {
    setEnv();
    cache.closeDb();
    const out = await correlate.why('target', repo);
    expect(out.kind).toBe('evidence');
    if (out.kind !== 'evidence') return;
    expect(out.evidence.commit).toBeNull();
  });
});

describe('why — window slack', () => {
  test('a commit 90 min after session end is included; 3 h after is excluded', async () => {
    setEnv();
    cache.closeDb();
    const gitDir = join(tmp, 'repo');
    // session ended 11:30. The 12:00 commit (30 min) already included above; assert the
    // fallback boundary directly against the stored window via the candidate query.
    const info = require('../repo').resolveRepo(repo);
    const rows = await cache.candidateSessionsForRepoWindow(info, '2026-06-14', '2026-06-16');
    const cl1 = rows.find((r: { session_id: string }) => r.session_id === 'cl1');
    expect(cl1).toBeDefined();
    const endMs = new Date(cl1!.ended_at).getTime();
    const commitAt90 = endMs + 90 * 60 * 1000;
    const commitAt3h = endMs + 3 * 60 * 60 * 1000;
    const slack = correlate.SLACK_AFTER_MS;
    expect(commitAt90 <= endMs + slack).toBe(true);
    expect(commitAt3h <= endMs + slack).toBe(false);
    void gitDir;
  });
});

describe('why — errors and latency', () => {
  test('a non-git cwd is a clean error for a file target', async () => {
    setEnv();
    cache.closeDb();
    const bare = mkdtempSync(join(tmpdir(), 'nogit-'));
    try {
      const out = await correlate.why('src/target.ts', bare);
      expect(out.kind).toBe('error');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('correlation completes well under the 5s ceiling', async () => {
    setEnv();
    cache.closeDb();
    const started = Date.now();
    await correlate.why('src/target.ts', repo);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
