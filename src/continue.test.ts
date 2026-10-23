import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDrift, parseContinueArgs, renderBrief, type Drift } from './continue';
import { resolveRepo } from './repo';
import { HandoffDriftOutput } from './mcp-schemas';
import type { HandoffSessionRow } from './cache';

let dir: string;

function git(args: string[], date?: string): void {
  const env = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

function commit(files: Record<string, string>, msg: string, date: string): void {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], date);
}

const row = (over: Partial<HandoffSessionRow> = {}): HandoffSessionRow => ({
  file_path: '/t/s.jsonl',
  cwd: dir,
  tool: 'claude',
  session_id: 's',
  date: '2026-06-01',
  started_at: '2026-06-01T10:00:00Z',
  ended_at: '2026-06-01T11:00:00Z',
  first_prompt: 'fix the parser',
  custom_title: '',
  files_touched: JSON.stringify([join(dir, 'a.ts'), join(dir, 'b.ts'), join(dir, 'c.ts'), '/elsewhere/x.ts']),
  files_read: JSON.stringify([join(dir, 'd.ts'), join(dir, 'a.ts')]),
  ...over,
});

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-continue-')));
  git(['init', '-q', '-b', 'main']);
  commit({ 'a.ts': '1', 'b.ts': '1', 'c.ts': '1', 'd.ts': '1' }, 'base', '2026-05-30T00:00:00Z');
  commit({ 'a.ts': '2' }, 'land the parser fix', '2026-06-01T11:30:00Z'); // inside the 2h slack
  commit({ 'b.ts': '2', 'd.ts': '2' }, 'later refactor', '2026-06-03T09:00:00Z');
  writeFileSync(join(dir, 'a.ts'), '3'); // uncommitted
  unlinkSync(join(dir, 'c.ts')); // deleted, uncommitted
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('computeDrift: landed work, later commits, uncommitted edits, deletions', () => {
  const drift = computeDrift(resolveRepo(dir)!, row());
  expect(HandoffDriftOutput.parse(drift)).toEqual(drift);

  expect(drift.commitsSince).toBe(1);
  expect(drift.landed.map((c) => c.subject)).toEqual(['land the parser fix']);
  expect(drift.editedTotal).toBe(3); // /elsewhere/x.ts is outside the repo
  const byPath = Object.fromEntries(drift.edited.map((f) => [f.path, f]));
  expect(byPath['a.ts']).toMatchObject({ dirty: true, deleted: false, commitsSince: [] }); // its own landing isn't drift
  expect(byPath['b.ts']!.commitsSince.map((c) => c.subject)).toEqual(['later refactor']);
  expect(byPath['c.ts']).toMatchObject({ dirty: true, deleted: true });
  expect(drift.readChanged).toEqual(['d.ts']); // a.ts was edited, so it isn't repeated here
});

test('computeDrift: a session whose work never landed has no landed commits', () => {
  const drift = computeDrift(resolveRepo(dir)!, row({ files_touched: JSON.stringify([join(dir, 'b.ts')]) }));
  expect(drift.landed).toEqual([]);
});

const digest = {
  messageCount: 4,
  exchangeCount: 2,
  elided: 0,
  exchanges: [
    { index: 0, user: 'fix the parser', assistant: 'Fixed it.' },
    { index: 2, user: 'ship it', assistant: 'Committed.' },
  ],
};
const noMemory = { memory: [], memoryTotal: 0 };
const now = Date.parse('2026-06-05T00:00:00Z');

test('renderBrief: carries the arc, the drift, the memory, and the stale-file warning', () => {
  const drift: Drift = {
    commitsSince: 1,
    capped: false,
    edited: [
      {
        path: 'b.ts',
        commitsSince: [{ sha: 'abc1234', subject: 'later refactor', authoredAt: '2026-06-03T09:00:00Z' }],
        dirty: false,
        deleted: false,
      },
      { path: 'c.ts', commitsSince: [], dirty: true, deleted: true },
      { path: 'e.ts', commitsSince: [], dirty: false, deleted: false },
    ],
    editedTotal: 3,
    readChanged: ['d.ts'],
    landed: [{ sha: 'def5678', subject: 'land the parser fix', authoredAt: '2026-06-01T11:30:00Z' }],
  };
  const md = renderBrief({
    row: row(),
    digest,
    drift,
    memory: {
      memory: [{ text: 'Use bun, never npm.', kind: 'convention', scope: 'repo', alwaysOn: true }],
      memoryTotal: 3,
    },
    now,
  });
  expect(md).toContain('last active 4 days ago');
  expect(md).toContain('- **[2] user:** ship it');
  expect(md).toContain('Its work landed in: def5678 "land the parser fix"');
  expect(md).toContain('- `b.ts`: changed by abc1234 "later refactor" (39h ago)');
  expect(md).toContain('- `c.ts`: deleted; uncommitted changes now');
  expect(md).toContain('- `e.ts`: unchanged since');
  expect(md).toContain('Files it read that have changed since: `d.ts`.');
  expect(md).toContain('may be stale');
  expect(md).toContain('- Use bun, never npm.');
  expect(md).toContain('…and 2 more (call get_memory)');
});

test('renderBrief: outside git it says drift could not be checked', () => {
  const md = renderBrief({ row: row(), digest, drift: null, memory: noMemory, now });
  expect(md).toContain('Not a git repository here');
  expect(md).not.toContain('## Standing memory');
});

test('parseContinueArgs: target, --in, --print', () => {
  expect(parseContinueArgs([])).toEqual({ target: '', into: '', print: false });
  expect(parseContinueArgs(['abc', '--in', 'codex', '--print'])).toEqual({ target: 'abc', into: 'codex', print: true });
});
