import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDrift, parseContinueArgs, renderBrief, type Drift, type FileDrift } from './continue';
import { resolveRepo } from './repo';
import { HandoffDriftOutput } from './mcp-schemas';
import type { HandoffSessionRow } from './cache';

let dir: string;

/** `date` sets both author and committer time; `committed` overrides the committer time alone. */
function git(args: string[], date?: string, committed?: string): void {
  // Hermetic: the developer's own config (commit signing, hooks) must not touch the fixture.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: committed ?? date } : undefined;
  Object.assign(env, dates);
  const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

function commit(files: Record<string, string>, msg: string, date: string, committed?: string): void {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], date, committed);
}

// The session ran 10:00–11:00 on 2026-06-01, editing a, b, c, f (and a file outside the repo)
// and reading d, a, e.
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
  files_touched: JSON.stringify(
    ['a.ts', 'b.ts', 'c.ts', 'f.ts', '/elsewhere/x.ts'].map((f) => (f[0] === '/' ? f : join(dir, f))),
  ),
  files_read: JSON.stringify(['d.ts', 'a.ts', 'e.ts'].map((f) => join(dir, f))),
  ...over,
});

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-continue-')));
  git(['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'pkg'));
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'pkg/g', 'h', 's', 'é', 'q"x'];
  commit(Object.fromEntries(files.map((f) => [`${f}.ts`, '1'])), 'base', '2026-05-30T00:00:00Z');
  const baseSha = Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
  commit({ 'e.ts': '2' }, 'tweak a dependency', '2026-06-01T11:15:00Z'); // after the end, inside the slack
  commit({ 'a.ts': '2' }, 'land the parser fix', '2026-06-01T11:30:00Z'); // inside the 2h slack
  commit({ 'f.ts': '2' }, 'cherry-pick an old fix', '2026-05-20T00:00:00Z', '2026-06-02T08:00:00Z');
  commit({ 'b.ts': '2', 'd.ts': '2' }, 'later refactor', '2026-06-03T09:00:00Z');
  commit({ 'b.ts': '3' }, 'b again', '2026-06-04T09:00:00Z');
  commit({ 'b.ts': '4' }, 'b once more', '2026-06-05T09:00:00Z');
  commit({ 'b.ts': '5' }, 'b finally', '2026-06-06T09:00:00Z');
  commit({ 'pkg/g.ts': '2' }, 'touch the package', '2026-06-06T10:00:00Z');
  commit({ 'é.ts': '2', 'q"x.ts': '2' }, 'touch names git quotes', '2026-06-06T11:00:00Z');
  // A topic branch written before the session, merged after it: only the merge is in the walk.
  git(['checkout', '-q', '-b', 'topic', baseSha]);
  commit({ 'h.ts': '2' }, 'topic work', '2026-05-30T12:00:00Z');
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'merge topic', 'topic'], '2026-06-07T09:00:00Z');
  writeFileSync(join(dir, 'a.ts'), '3'); // uncommitted
  unlinkSync(join(dir, 'c.ts')); // deleted, uncommitted
  // Staged, then undone in the working tree: `git diff HEAD` alone would miss it.
  writeFileSync(join(dir, 's.ts'), 'staged');
  git(['add', 's.ts']);
  writeFileSync(join(dir, 's.ts'), '1');
}, 30_000); // ~30 git spawns: generous for a loaded CI box

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const driftFor = (over: Partial<HandoffSessionRow> = {}): Drift => computeDrift(resolveRepo(dir)!, row(over))!;
const touched = (...files: string[]): string => JSON.stringify(files.map((f) => join(dir, f)));

test('computeDrift: landed work, later commits, uncommitted edits, deletions', () => {
  const drift = driftFor();
  expect(HandoffDriftOutput.parse(drift)).toEqual(drift);

  expect(drift.commitsSince).toBe(9); // everything after 11:00 except its own landing
  expect(drift.landed.map((c) => c.subject)).toEqual(['land the parser fix']);
  expect(drift.editedTotal).toBe(4); // /elsewhere/x.ts is outside the repo
  const byPath = Object.fromEntries(drift.edited.map((f) => [f.path, f]));
  expect(byPath['a.ts']).toMatchObject({ dirty: true, deleted: false, commitsSinceTotal: 0 }); // its own landing isn't drift
  expect(byPath['c.ts']).toMatchObject({ dirty: true, deleted: true });
  // Read files count any later commit, even one inside the landing slack; edited a.ts isn't repeated.
  expect(drift.readChanged).toEqual(['d.ts', 'e.ts']);
});

test('computeDrift: per-file commit lists are capped with a true total', () => {
  const b = driftFor().edited.find((f) => f.path === 'b.ts')!;
  expect(b.commitsSinceTotal).toBe(4);
  expect(b.commitsSince.map((c) => c.subject)).toEqual(['b finally', 'b once more', 'b again']);
});

test('computeDrift: a cherry-pick of older work after the session counts as a change', () => {
  const f = driftFor().edited.find((x) => x.path === 'f.ts')!;
  expect(f.commitsSince.map((c) => c.subject)).toEqual(['cherry-pick an old fix']);
});

test('computeDrift: relative tool paths resolve against the session cwd, not the repo root', () => {
  const drift = driftFor({ cwd: join(dir, 'pkg'), files_touched: JSON.stringify(['g.ts']), files_read: '[]' });
  expect(drift.edited).toMatchObject([{ path: 'pkg/g.ts', commitsSinceTotal: 1, deleted: false }]);
});

test('computeDrift: a session whose work never landed has no landed commits', () => {
  expect(driftFor({ files_touched: touched('b.ts') }).landed).toEqual([]);
});

test('computeDrift: no usable timestamps means no drift, rather than a crash', () => {
  expect(computeDrift(resolveRepo(dir)!, row({ started_at: '', ended_at: '', date: '?' }))).toBeNull();
});

test('computeDrift: a deleted worktree session in a subdirectory still maps onto this checkout', () => {
  const gone = '/gone-worktree/pkg';
  const drift = driftFor({ cwd: gone, files_touched: JSON.stringify([`${gone}/g.ts`]), files_read: '[]' });
  expect(drift.edited).toMatchObject([{ path: 'pkg/g.ts', commitsSinceTotal: 1, deleted: false }]);
});

test('computeDrift: names git quotes (non-ASCII, embedded quotes) still match their commits', () => {
  const drift = driftFor({ files_touched: touched('é.ts', 'q"x.ts'), files_read: '[]' });
  expect(drift.edited.map((f) => [f.path, f.commitsSinceTotal])).toEqual([
    ['é.ts', 1],
    ['q"x.ts', 1],
  ]);
});

test('computeDrift: a merge after the session counts for the files it brought in', () => {
  const [h] = driftFor({ files_touched: touched('h.ts'), files_read: '[]' }).edited;
  expect(h!.commitsSince.map((c) => c.subject)).toEqual(['merge topic']);
});

test('computeDrift: a staged change counts as uncommitted even when the working tree undid it', () => {
  const [st] = driftFor({ files_touched: touched('s.ts'), files_read: '[]' }).edited;
  expect(st).toMatchObject({ dirty: true, deleted: false });
});

test('computeDrift: a concrete read target that is gone counts as changed; search patterns never do', () => {
  const reads = [join(dir, 'gone.ts'), 'buildResumeCommand', join(dir, '**/*.ts')];
  const drift = driftFor({ files_touched: '[]', files_read: JSON.stringify(reads) });
  expect(drift.readChanged).toEqual(['gone.ts']);
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

const commitRef = (sha: string, subject: string, at: string) => ({ sha, subject, authoredAt: at, committedAt: at });
const fileDrift = (path: string, over: Partial<FileDrift> = {}): FileDrift => ({
  path,
  commitsSince: [],
  commitsSinceTotal: 0,
  dirty: false,
  deleted: false,
  ...over,
});
const baseDrift = (over: Partial<Drift> = {}): Drift => ({
  commitsSince: 1,
  capped: false,
  edited: [],
  editedTotal: 0,
  readChanged: [],
  readChangedTotal: 0,
  landed: [],
  landedTotal: 0,
  ...over,
});

test('renderBrief: carries the arc, the drift, the memory, and the stale-file warning', () => {
  const later = commitRef('abc1234', 'later refactor', '2026-06-03T09:00:00Z');
  const drift = baseDrift({
    edited: [
      fileDrift('b.ts', { commitsSince: [later], commitsSinceTotal: 4 }),
      fileDrift('c.ts', { dirty: true, deleted: true }),
      fileDrift('e.ts'),
    ],
    editedTotal: 3,
    readChanged: ['d.ts'],
    readChangedTotal: 3,
    landed: [commitRef('def5678', 'land the parser fix', '2026-06-01T11:30:00Z')],
    landedTotal: 1,
  });
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
  expect(md).toContain('- `b.ts`: changed by abc1234 "later refactor" (39h ago) and 3 more');
  expect(md).toContain('- `c.ts`: deleted; uncommitted changes now');
  expect(md).toContain('- `e.ts`: unchanged since');
  expect(md).toContain('Files it read that have changed since: `d.ts` and 2 more.');
  expect(md).toContain('may be stale');
  expect(md).toContain('- Use bun, never npm.');
  expect(md).toContain('…and 2 more (call get_memory)');
});

test('renderBrief: a capped history walk hedges "unchanged" and "never landed"', () => {
  const md = renderBrief({
    row: row(),
    digest,
    drift: baseDrift({ capped: true, edited: [fileDrift('e.ts')], editedTotal: 1 }),
    memory: noMemory,
    now,
  });
  expect(md).toContain('1+ commit');
  expect(md).toContain('- `e.ts`: no change in the last 500 commits (older history not checked)');
  expect(md).toContain('soon after in the last 500 commits (older history not checked)');
  expect(md).not.toContain('unchanged since');
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
