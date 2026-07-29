import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPersistedStates,
  assertActionAcceptsFlags,
  parseExportArgs,
  parseImportArgs,
  parseMineArgs,
  parseTriageArgs,
  runShards,
  UsageError,
} from './cli';
import { buildRecord } from './record';
import { listShards, setAlwaysOn, setScope, setState, upsertCandidates } from './store';
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

  test('the stdout batch carries the persisted state, and a rejection leaves it entirely', async () => {
    // The pipe is the Phase 2 interface, so it has to carry the same truth the table
    // does: an approved shard reports `approved`, and a rejected one is dropped
    // rather than re-presented as a fresh candidate on every run. The row itself
    // survives — durability.test.ts asserts that a rejected shard keeps receiving
    // evidence refreshes — so only the batch narrows.
    const first = JSON.parse((await capture(['mine', '--repo', repo])).stdout) as ShardRecord[];
    const mined = first.find((r) => r.text === FACT);
    expect(mined).toBeDefined();
    expect(mined!.state).toBe('candidate');

    setState(mined!.id, 'approved');
    const second = JSON.parse((await capture(['mine', '--repo', repo])).stdout) as ShardRecord[];
    expect(second.find((r) => r.id === mined!.id)!.state).toBe('approved');

    setState(mined!.id, 'rejected');
    const third = JSON.parse((await capture(['mine', '--repo', repo])).stdout) as ShardRecord[];
    expect(third.find((r) => r.id === mined!.id)).toBeUndefined();
    expect(listShards().find((r) => r.id === mined!.id)!.state).toBe('rejected');
  });
});

describe('parseTriageArgs', () => {
  test('takes exactly one positional shard id', () => {
    expect(parseTriageArgs(['sha256:abc'])).toEqual({ help: false, id: 'sha256:abc' });
  });

  test('a second positional is a usage error, not a silently ignored argument', () => {
    expect(() => parseTriageArgs(['sha256:abc', 'sha256:def'])).toThrow(UsageError);
    expect(() => parseTriageArgs(['sha256:abc', 'sha256:def'])).toThrow('expected exactly one shard id');
  });

  test('an unrecognized flag is rejected', () => {
    expect(() => parseTriageArgs(['--all'])).toThrow('unknown option: --all');
  });

  test('--always-on parses alongside the id', () => {
    expect(parseTriageArgs(['sha256:abc', '--always-on'])).toEqual({
      help: false,
      id: 'sha256:abc',
      alwaysOn: true,
    });
    // Order-independent: the flag may lead.
    expect(parseTriageArgs(['--always-on', 'sha256:abc']).id).toBe('sha256:abc');
  });

  test('--scope accepts group:<name> and nothing else', () => {
    expect(parseTriageArgs(['sha256:abc', '--scope', 'group:authkit'])).toEqual({
      help: false,
      id: 'sha256:abc',
      scope: { type: 'group', key: 'authkit' },
    });
    // repo and workflow are DERIVED from evidence; a flag must not be able to widen
    // one repo's convention into a rule for every repo.
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'workflow'])).toThrow('only accepts group:<name>');
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'group:'])).toThrow('only accepts group:<name>');
    expect(() => parseTriageArgs(['sha256:abc', '--scope'])).toThrow('--scope requires a value');
  });

  test('the id is still capped at one, with the flags interleaved', () => {
    expect(() => parseTriageArgs(['--always-on', 'sha256:abc', 'sha256:def'])).toThrow('expected exactly one shard id');
  });

  test('--help short-circuits, including over a later bad argument', () => {
    expect(parseTriageArgs(['--help']).help).toBe(true);
    expect(parseTriageArgs(['-h']).help).toBe(true);
    expect(parseTriageArgs(['-h', 'sha256:abc']).help).toBe(true);
  });

  test('no id parses cleanly — the runner, not the parser, reports the omission', () => {
    expect(parseTriageArgs([])).toEqual({ help: false });
  });
});

describe('shards approve flags end to end', () => {
  // Seeded directly rather than mined: the mine describe above deliberately leaves a
  // rejected row behind, and a test that depends on a sibling's leftovers is a test
  // that breaks when the file is reordered.
  const SEEDED = buildRecord({
    text: 'Always import the SDK from the workspace root, never the package path',
    scope: { type: 'repo', key: '/repos/app' },
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });

  beforeEach(() => {
    upsertCandidates([SEEDED]);
    setState(SEEDED.id, 'candidate');
    setAlwaysOn(SEEDED.id, false);
    setScope(SEEDED.id, SEEDED.scope);
  });

  test('--always-on persists the flag; --scope persists a group', async () => {
    await capture(['approve', SEEDED.id, '--always-on', '--scope', 'group:authkit']);
    const stored = listShards().find((r) => r.id === SEEDED.id)!;
    expect(stored.state).toBe('approved');
    expect(stored.alwaysOn).toBe(true);
    expect(stored.scope).toEqual({ type: 'group', key: 'authkit' });
  });

  test('a plain approve leaves both alone', async () => {
    await capture(['approve', SEEDED.id]);
    const stored = listShards().find((r) => r.id === SEEDED.id)!;
    expect(stored.alwaysOn).toBe(false);
    expect(stored.scope).toEqual({ type: 'repo', key: '/repos/app' });
  });

  test('a second approve without the flag does not clear it', async () => {
    // Set-only on purpose: omission is not a decision, and silently clearing a standing
    // constraint reintroduces exactly the invisible suppression the flag prevents.
    await capture(['approve', SEEDED.id, '--always-on']);
    await capture(['approve', SEEDED.id]);
    expect(listShards().find((r) => r.id === SEEDED.id)!.alwaysOn).toBe(true);
  });

  test('reject and snooze refuse the approve-only flags by name, not as "unknown option"', () => {
    // Driven through the exported check rather than runShards: the dispatcher converts
    // a UsageError to die(), which calls process.exit and would take the runner with it.
    expect(() => assertActionAcceptsFlags('reject', { help: false, alwaysOn: true })).toThrow(
      'reject does not take --always-on',
    );
    expect(() => assertActionAcceptsFlags('snooze', { help: false, scope: { type: 'group', key: 'authkit' } })).toThrow(
      'snooze does not take --scope',
    );
    expect(() => assertActionAcceptsFlags('approve', { help: false, alwaysOn: true })).not.toThrow();
  });
});

describe('parseExportArgs', () => {
  test('defaults to stdout, which is what makes the bundle pipeable', () => {
    expect(parseExportArgs([])).toEqual({ help: false });
  });

  test('--out takes the next argument', () => {
    expect(parseExportArgs(['--out', '/tmp/b.json'])).toEqual({ help: false, out: '/tmp/b.json' });
  });

  test('--out with no value is a usage error, matching src/context.ts', () => {
    expect(() => parseExportArgs(['--out'])).toThrow(UsageError);
    expect(() => parseExportArgs(['--out'])).toThrow('--out requires a path');
  });

  test('export takes no positional — a bare word is an unknown option', () => {
    expect(() => parseExportArgs(['bundle.json'])).toThrow('unknown option: bundle.json');
  });

  test('--help short-circuits, including over a later bad flag', () => {
    expect(parseExportArgs(['--help']).help).toBe(true);
    expect(parseExportArgs(['-h']).help).toBe(true);
    expect(parseExportArgs(['--help', '--nope']).help).toBe(true);
  });
});

describe('parseImportArgs', () => {
  test('takes exactly one positional bundle path', () => {
    expect(parseImportArgs(['/tmp/b.json'])).toEqual({ help: false, path: '/tmp/b.json' });
  });

  test('a second positional names a bundle path, not a shard id', () => {
    // Reusing parseTriageArgs would emit "expected exactly one shard id" here.
    expect(() => parseImportArgs(['a.json', 'b.json'])).toThrow('expected exactly one bundle path');
  });

  test('flags are rejected — import takes none', () => {
    expect(() => parseImportArgs(['--out', 'x'])).toThrow('unknown option: --out');
  });

  test('--help short-circuits, and no path parses cleanly for the runner to report', () => {
    expect(parseImportArgs(['-h', 'a.json']).help).toBe(true);
    expect(parseImportArgs([])).toEqual({ help: false });
  });
});
