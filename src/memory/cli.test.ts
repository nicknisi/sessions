import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPersistedStates,
  assertActionAcceptsFlags,
  canonicalizeScope,
  parseExportArgs,
  parseImportArgs,
  parseMineArgs,
  parsePendingArgs,
  parseTriageArgs,
  pendingBatch,
  PENDING_PREVIEW,
  runMemory,
  UsageError,
  type PendingBatch,
} from './cli';
import { buildRecord } from './record';
import { getMemoryDb, listMemories, setAlwaysOn, setScope, setState, upsertCandidates } from './store';
import type { MemoryRecord } from './types';
import { captureStreams, closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './fixtures';

const FACT = 'Always run the whole test suite before you tell me a change is finished';

let tmp: string;
let repo: string;

beforeAll(() => {
  tmp = makeTmp('memory-cli');
  setMemoryEnv(tmp);
  repo = join(tmp, 'repo');
  writeSession(tmp, 'work', repo, [userTurn(FACT, '2026-06-01T10:00:00Z')]);
  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the CLI with both streams captured, so a test can assert on the batch. */
function capture(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  return captureStreams(() => runMemory(argv));
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

  test('--json selects the machine seam; prose is what a human gets by default', () => {
    expect(parseMineArgs(['--json', '--all'])).toEqual({ all: true, help: false, json: true });
    // Absent rather than false, so the bare-parse shape stays bare.
    expect(parseMineArgs(['--all'])).toEqual({ all: true, help: false });
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

describe('memory mine', () => {
  test('an empty corpus prints an empty batch and returns, rather than erroring', async () => {
    const { stdout } = await capture(['mine', '--repo', join(tmp, 'no-such-repo'), '--json']);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test('the stdout batch carries the persisted state, and a rejection leaves it entirely', async () => {
    // The pipe is the Phase 2 interface, so it has to carry the same truth the table
    // does: an approved memory reports `approved`, and a rejected one is dropped
    // rather than re-presented as a fresh candidate on every run. The row itself
    // survives — durability.test.ts asserts that a rejected memory keeps receiving
    // evidence refreshes — so only the batch narrows.
    const first = JSON.parse((await capture(['mine', '--repo', repo, '--json'])).stdout) as MemoryRecord[];
    const mined = first.find((r) => r.text === FACT);
    expect(mined).toBeDefined();
    expect(mined!.state).toBe('candidate');

    setState(mined!.id, 'approved');
    const second = JSON.parse((await capture(['mine', '--repo', repo, '--json'])).stdout) as MemoryRecord[];
    expect(second.find((r) => r.id === mined!.id)!.state).toBe('approved');

    setState(mined!.id, 'rejected');
    const third = JSON.parse((await capture(['mine', '--repo', repo, '--json'])).stdout) as MemoryRecord[];
    expect(third.find((r) => r.id === mined!.id)).toBeUndefined();
    expect(listMemories().find((r) => r.id === mined!.id)!.state).toBe('rejected');
  });
});

describe('memory pending', () => {
  function candidate(n: number): MemoryRecord {
    return buildRecord({
      text: `Always run the number ${n} verification step before you cut a release`,
      scope: { type: 'repo', key: '/repos/app' },
      author: 'dev@example.com',
      sessions: ['/s/a.jsonl'],
      dates: ['2026-06-01'],
      distinctPhrasings: 1,
    });
  }

  beforeEach(() => {
    getMemoryDb().run('DELETE FROM memory');
  });

  test('--json selects the machine seam; anything else is a usage error', () => {
    expect(parsePendingArgs([])).toEqual({ help: false });
    expect(parsePendingArgs(['--json'])).toEqual({ help: false, json: true });
    expect(parsePendingArgs(['-h']).help).toBe(true);
    expect(() => parsePendingArgs(['--all'])).toThrow('unknown option: --all');
    // No positional either — `pending` takes no id.
    expect(() => parsePendingArgs(['sha256:abc'])).toThrow('unknown option: sha256:abc');
  });

  test('an empty store reports zero rather than erroring — the skill parses this', async () => {
    const { stdout } = await capture(['pending', '--json']);
    expect(JSON.parse(stdout)).toEqual({ count: 0, preview: [] });
  });

  test('the count is the true total and the preview is capped, which is the whole point', async () => {
    const all = Array.from({ length: PENDING_PREVIEW + 2 }, (_, i) => candidate(i));
    upsertCandidates(all);
    const batch = JSON.parse((await capture(['pending', '--json'])).stdout) as PendingBatch;
    expect(batch.count).toBe(PENDING_PREVIEW + 2);
    expect(batch.preview).toHaveLength(PENDING_PREVIEW);
    expect(batch.count).not.toBe(batch.preview.length);
  });

  test('only untriaged candidates count — approved and rejected rows are not a backlog', async () => {
    const [pendingOne, approved, rejected] = [candidate(1), candidate(2), candidate(3)];
    upsertCandidates([pendingOne!, approved!, rejected!]);
    setState(approved!.id, 'approved');
    setState(rejected!.id, 'rejected');
    const batch = JSON.parse((await capture(['pending', '--json'])).stdout) as PendingBatch;
    expect(batch.count).toBe(1);
    expect(batch.preview[0]!.id).toBe(pendingOne!.id);
  });

  test('the preview keeps listMemories order and carries nothing but id and text', () => {
    // listMemories is already ORDER BY id — arbitrary but stable. The projection must not
    // re-sort (which would invent a second ordering) and must not leak evidence into a
    // payload a skill pastes into a summary.
    const records = [candidate(1), candidate(2), candidate(3)];
    expect(pendingBatch(records).preview).toEqual(records.map((r) => ({ id: r.id, text: r.text })));
  });
});

describe('parseTriageArgs', () => {
  test('takes exactly one positional memory id', () => {
    expect(parseTriageArgs(['sha256:abc'])).toEqual({ help: false, id: 'sha256:abc' });
  });

  test('a second positional is a usage error, not a silently ignored argument', () => {
    expect(() => parseTriageArgs(['sha256:abc', 'sha256:def'])).toThrow(UsageError);
    expect(() => parseTriageArgs(['sha256:abc', 'sha256:def'])).toThrow('expected exactly one memory id');
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

  test('--scope accepts group:<name>', () => {
    expect(parseTriageArgs(['sha256:abc', '--scope', 'group:authkit'])).toEqual({
      help: false,
      id: 'sha256:abc',
      scope: { type: 'group', key: 'authkit' },
    });
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'group:'])).toThrow('requires a group name');
    expect(() => parseTriageArgs(['sha256:abc', '--scope'])).toThrow('--scope requires a value');
  });

  test('--scope accepts repo:<path>, carrying the raw path for the runner to resolve', () => {
    // Raw here on purpose: resolving shells out to git, and this parser is a pure function
    // of argv. `canonicalizeScope` turns it into a container key.
    expect(parseTriageArgs(['sha256:abc', '--scope', 'repo:.']).scope).toEqual({ type: 'repo', key: '.' });
    expect(parseTriageArgs(['sha256:abc', '--scope', 'repo:/repos/app']).scope).toEqual({
      type: 'repo',
      key: '/repos/app',
    });
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'repo:'])).toThrow('requires a path');
  });

  test('--scope still refuses workflow, the one direction that widens', () => {
    // Widening is the asymmetric hazard: a typo that turns one repo's convention into a
    // rule for every repo is invisible, while a wrong repo path just means the memory is
    // not returned there. Narrowing is also CHECKED — canonicalizeScope resolves the path.
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'workflow'])).toThrow(
      'only accepts group:<name> or repo:<path>',
    );
    expect(() => parseTriageArgs(['sha256:abc', '--scope', 'workflow:'])).toThrow('only accepts');
    expect(() => parseTriageArgs(['sha256:abc', '--scope', '/repos/app'])).toThrow('only accepts');
  });

  test('canonicalizeScope resolves a repo path to its container and fails loudly otherwise', () => {
    const fake = (container: string) => () => ({
      gitCommonDir: join(container, '.git'),
      container,
      currentWorktree: container,
      branches: new Map<string, string>(),
    });

    // The key retrieval compares against is the CONTAINER, derived exactly the way the mine
    // derives it — `containerFor` reads `<main>/.git` back to `<main>`, so a subdirectory
    // and a linked worktree of one repo both land on the same key.
    expect(canonicalizeScope({ type: 'repo', key: '.' }, fake('/repos/app'))).toEqual({
      type: 'repo',
      key: '/repos/app',
    });
    // A group scope is untouched — no path, nothing to resolve.
    expect(canonicalizeScope({ type: 'group', key: 'authkit' }, fake('/repos/app'))).toEqual({
      type: 'group',
      key: 'authkit',
    });

    // Not a repo: a raw-path fallback would store a key that can never match any cwd and
    // report success, which is the silent dead end this flag exists to remove.
    expect(() => canonicalizeScope({ type: 'repo', key: '.' }, () => null)).toThrow('not inside a git repository');
    expect(() => canonicalizeScope({ type: 'repo', key: 'no/such/dir/here' }, fake('/x'))).toThrow('no such directory');
  });

  test('the id is still capped at one, with the flags interleaved', () => {
    expect(() => parseTriageArgs(['--always-on', 'sha256:abc', 'sha256:def'])).toThrow(
      'expected exactly one memory id',
    );
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

describe('memory approve flags end to end', () => {
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
    const stored = listMemories().find((r) => r.id === SEEDED.id)!;
    expect(stored.state).toBe('approved');
    expect(stored.alwaysOn).toBe(true);
    expect(stored.scope).toEqual({ type: 'group', key: 'authkit' });
  });

  test('a plain approve leaves both alone', async () => {
    await capture(['approve', SEEDED.id]);
    const stored = listMemories().find((r) => r.id === SEEDED.id)!;
    expect(stored.alwaysOn).toBe(false);
    expect(stored.scope).toEqual({ type: 'repo', key: '/repos/app' });
  });

  test('a second approve without the flag does not clear it', async () => {
    // Set-only on purpose: omission is not a decision, and silently clearing a standing
    // constraint reintroduces exactly the invisible suppression the flag prevents.
    await capture(['approve', SEEDED.id, '--always-on']);
    await capture(['approve', SEEDED.id]);
    expect(listMemories().find((r) => r.id === SEEDED.id)!.alwaysOn).toBe(true);
  });

  test('reject and snooze refuse the approve-only flags by name, not as "unknown option"', () => {
    // Driven through the exported check rather than runMemory: the dispatcher converts
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

  test('a second positional names a bundle path, not a memory id', () => {
    // Reusing parseTriageArgs would emit "expected exactly one memory id" here.
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
