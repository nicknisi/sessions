import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyPersistedStates, parseMineArgs, runShards, UsageError } from './cli';
import { buildRecord } from './record';
import { setState } from './store';
import type { ShardRecord } from './types';
import { closeDatabases, makeTmp, setShardEnv, userTurn, writeSession } from './fixtures';

const FACT = 'Always run the whole test suite before you tell me a change is finished';

let tmp: string;
let repo: string;

beforeAll(() => {
  tmp = makeTmp('shards-cli');
  setShardEnv(tmp);
  repo = join(tmp, 'repo');
  writeSession(tmp, 'work', repo, [userTurn(FACT, '2026-06-01T10:00:00Z')]);
  closeDatabases();
});

beforeEach(() => {
  setShardEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the CLI with both streams captured, so a test can assert on the batch. */
async function capture(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const sink =
    (into: string[]) =>
    (chunk: unknown, cb?: unknown): boolean => {
      into.push(String(chunk));
      if (typeof cb === 'function') (cb as () => void)();
      return true;
    };
  process.stdout.write = sink(out) as typeof process.stdout.write;
  process.stderr.write = sink(err) as typeof process.stderr.write;
  try {
    await runShards(argv);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

describe('parseMineArgs', () => {
  test('defaults to the current repo with no flags', () => {
    expect(parseMineArgs([])).toEqual({ all: false, help: false });
  });

  test('--repo takes the next argument', () => {
    expect(parseMineArgs(['--repo', '/repos/app'])).toEqual({ all: false, help: false, repo: '/repos/app' });
  });

  test('--repo with no value is a usage error', () => {
    expect(() => parseMineArgs(['--repo'])).toThrow(UsageError);
    expect(() => parseMineArgs(['--repo'])).toThrow('--repo requires a path');
  });

  test('--all and --repo are mutually exclusive', () => {
    expect(() => parseMineArgs(['--all', '--repo', '/repos/app'])).toThrow('--all and --repo are mutually exclusive');
  });

  test('--json is accepted and changes nothing — the batch is always JSON', () => {
    expect(parseMineArgs(['--json', '--all'])).toEqual({ all: true, help: false });
  });

  test('an unknown option is a usage error, not a silently ignored flag', () => {
    expect(() => parseMineArgs(['--nope'])).toThrow('unknown option: --nope');
    expect(() => parseMineArgs(['mine'])).toThrow('unknown option: mine');
  });

  test('--help short-circuits, including over a later bad flag', () => {
    expect(parseMineArgs(['--help']).help).toBe(true);
    expect(parseMineArgs(['-h']).help).toBe(true);
    expect(parseMineArgs(['--help', '--nope']).help).toBe(true);
  });
});

describe('applyPersistedStates', () => {
  const mined = buildRecord({
    text: FACT,
    scope: { type: 'repo', key: '/repos/app' },
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });

  test('a stored decision wins over the freshly mined candidate state', () => {
    const merged = applyPersistedStates(
      [mined],
      new Map([[mined.id, { state: 'snoozed', snoozedUntil: '2026-09-01' }]]),
    );
    expect(merged[0]!.state).toBe('snoozed');
    expect(merged[0]!.snoozedUntil).toBe('2026-09-01');
  });

  test('an unstored record passes through untouched, field order included', () => {
    const merged = applyPersistedStates([mined], new Map());
    expect(JSON.stringify(merged[0])).toBe(JSON.stringify(mined));
  });

  test('field order survives the overlay, which the determinism check compares', () => {
    const merged = applyPersistedStates([mined], new Map([[mined.id, { state: 'rejected', snoozedUntil: null }]]));
    expect(Object.keys(merged[0] as object)).toEqual(Object.keys(mined as object));
  });
});

describe('shards mine', () => {
  test('an empty corpus prints an empty batch and returns, rather than erroring', async () => {
    const { stdout } = await capture(['mine', '--repo', join(tmp, 'no-such-repo')]);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test('the stdout batch carries the persisted state, not a fresh candidate', async () => {
    // The pipe is the Phase 2 interface. upsertCandidates keeps a rejection in the
    // table; if the batch still said "candidate" the user would re-triage the same
    // rejected shard on every run.
    const first = JSON.parse((await capture(['mine', '--repo', repo])).stdout) as ShardRecord[];
    const mined = first.find((r) => r.text === FACT);
    expect(mined).toBeDefined();
    expect(mined!.state).toBe('candidate');

    setState(mined!.id, 'rejected');

    const second = JSON.parse((await capture(['mine', '--repo', repo])).stdout) as ShardRecord[];
    expect(second.find((r) => r.id === mined!.id)!.state).toBe('rejected');
  });
});
