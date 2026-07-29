import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mine } from './mine';
import { buildRecord } from './record';
import { listShards, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setShardEnv, userTurn, writeSession } from './fixtures';

// Shards are out-of-band by design: the alternative considered and rejected was
// promoting them into a repo's AGENTS.md via pull request, which would expose tool
// usage and put churn in repos the user may not control. Nothing the shard code does
// may write into a repo working tree — not the mine, not the store, not triage.

const FACT = 'Always run the test suite before you tell me a change is finished';

let tmp: string;
let repo: string;
let originalCwd: string;

/** path -> content, for every file in the tree. Compares presence AND bytes. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const full = join(root, rel);
    if (statSync(full).isDirectory()) continue;
    out.set(rel, readFileSync(full, 'utf-8'));
  }
  return out;
}

beforeAll(() => {
  tmp = makeTmp('shards-no-writes');
  setShardEnv(tmp);
  repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');

  writeSession(tmp, 'work', repo, [userTurn(FACT, '2026-06-01T10:00:00Z')]);

  originalCwd = process.cwd();
  closeDatabases();
});

beforeEach(() => {
  setShardEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  process.chdir(originalCwd);
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('no shard operation writes into the cwd tree', () => {
  test('mine, upsert, and triage leave the working tree byte-unchanged', async () => {
    process.chdir(repo);
    const before = snapshot(repo);

    const records = await mine({});
    expect(records.length).toBeGreaterThan(0);
    upsertCandidates(records);
    setState(records[0]!.id, 'rejected');
    upsertCandidates([
      buildRecord({
        text: FACT,
        scope: { type: 'repo', key: repo },
        author: 'dev@example.com',
        sessions: [join(tmp, 'claude', 'proj', 'work.jsonl')],
        dates: ['2026-06-01'],
        distinctPhrasings: 1,
      }),
    ]);
    expect(listShards().length).toBeGreaterThan(0);

    process.chdir(originalCwd);
    const after = snapshot(repo);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of before) expect(after.get(path)).toBe(content);
  });
});
