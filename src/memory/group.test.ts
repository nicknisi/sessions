import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getGroupConfigPath, groupsFor, loadGroupConfig, type GroupConfig } from './groups';
import { buildRecord } from './record';
import { activeMemoryFor } from './retrieve';
import { getMemoryDb, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import type { MemoryRecord, MemoryScope } from './types';

// A group memory that resolves to nothing is invisible and silent — the agent simply
// never sees the rule, and nothing anywhere raises. So membership is asserted from both
// sides: the member paths that MUST resolve, and the near-miss paths that must not.
//
// The store half takes the same hermetic treatment as src/memory/mcp-memory.test.ts:
// store.ts is one shared module instance across a `bun test` run, so the env is
// re-asserted and the handle dropped in every beforeEach.

const AUTHKIT: MemoryScope = { type: 'group', key: 'authkit' };
const CLI_GROUP: MemoryScope = { type: 'group', key: 'workos-cli' };
// A group scope carrying no name. '' would otherwise be looked up against every
// configured group, so it is skipped for the same reason an empty repo key is.
const UNNAMED: MemoryScope = { type: 'group', key: '' };
// A group the config never mentions: inert, and silently so.
const ORPHAN: MemoryScope = { type: 'group', key: 'never-configured' };
const REPO: MemoryScope = { type: 'repo', key: '/tmp/x/authkit-nextjs' };
const WORKFLOW: MemoryScope = { type: 'workflow', key: '' };

const CONFIG: GroupConfig = {
  groups: {
    authkit: ['/tmp/x/authkit-*'],
    'workos-cli': ['/tmp/x/cli/*'],
  },
};

describe('groupsFor', () => {
  test('a container matching a glob returns the group', () => {
    expect(groupsFor('/tmp/x/authkit-nextjs', CONFIG)).toEqual(['authkit']);
  });

  test('a SUBDIRECTORY of a member returns the group', () => {
    // Bun.Glob's `*` does not cross `/`, so `/tmp/x/authkit-*` does not itself match
    // `/tmp/x/authkit-session/packages/core`. Walking the ancestors is what gives a
    // group the same boundary semantics cwdUnder gives repo scope — and the container
    // resolver hands us the raw cwd whenever the path is not in a git repo.
    expect(groupsFor('/tmp/x/authkit-session/packages/core', CONFIG)).toEqual(['authkit']);
  });

  test('a non-member returns nothing', () => {
    expect(groupsFor('/tmp/x/sessions', CONFIG)).toEqual([]);
    expect(groupsFor('/tmp/y/authkit-nextjs', CONFIG)).toEqual([]);
  });

  test('a sibling sharing a prefix but not the separator is not a member', () => {
    // The `/repos/app` vs `/repos/app-v2` boundary case, one level up: `authkit-*`
    // requires the hyphen, so `authkitten` is out.
    expect(groupsFor('/tmp/x/authkitten', CONFIG)).toEqual([]);
  });

  test('a parent of a member is not a member', () => {
    // The walk goes upward only. `/tmp/x` contains members; it is not one.
    expect(groupsFor('/tmp/x', CONFIG)).toEqual([]);
    expect(groupsFor('/', CONFIG)).toEqual([]);
  });

  test('a container in two groups returns both, sorted', () => {
    const overlapping: GroupConfig = {
      groups: { zeta: ['/tmp/x/authkit-*'], alpha: ['/tmp/x/*'] },
    };
    expect(groupsFor('/tmp/x/authkit-nextjs', overlapping)).toEqual(['alpha', 'zeta']);
  });

  test('a glob metacharacter in the CONFIG is meaningful, unlike one in a stored path', () => {
    // The inverse of src/memory/retrieve.ts: there a stored path lands in the pattern
    // position and `[` would silently match nothing; here the pattern is the user's own
    // config, so a character class is a feature.
    const classes: GroupConfig = { groups: { v: ['/tmp/x/app-v[12]'] } };
    expect(groupsFor('/tmp/x/app-v1', classes)).toEqual(['v']);
    expect(groupsFor('/tmp/x/app-v3', classes)).toEqual([]);
  });

  test('a metacharacter in the CONTAINER path is data, never interpreted', () => {
    // The path being tested is never a pattern, so `/repos/re[p]o` — the fixture
    // src/memory/mcp-memory.test.ts:23 uses to catch the SQL-GLOB hazard — matches a
    // plain wildcard and nothing weirder.
    const plain: GroupConfig = { groups: { any: ['/tmp/x/*'] } };
    expect(groupsFor('/tmp/x/re[p]o/src', plain)).toEqual(['any']);
    // And the same string in the PATTERN position is a character class, which is why
    // it does not match itself literally.
    const asPattern: GroupConfig = { groups: { cls: ['/tmp/x/re[p]o'] } };
    expect(groupsFor('/tmp/x/repo', asPattern)).toEqual(['cls']);
    expect(groupsFor('/tmp/x/re[p]o', asPattern)).toEqual([]);
  });

  test('a leading ~ expands to the home directory', () => {
    const tilde: GroupConfig = { groups: { dev: ['~/Developer/authkit-*'] } };
    expect(groupsFor(join(homedir(), 'Developer', 'authkit-nextjs'), tilde)).toEqual(['dev']);
    // Bun.Glob does no shell expansion, so an unexpanded pattern would match the
    // literal string "~/Developer/..." and nothing else.
    expect(groupsFor('~/Developer/authkit-nextjs', tilde)).toEqual([]);
  });

  test('a bare ~ is the home directory; ~user is left alone rather than guessed at', () => {
    expect(groupsFor(join(homedir(), 'anything'), { groups: { home: ['~'] } })).toEqual(['home']);
    expect(groupsFor(join(homedir(), 'x'), { groups: { other: ['~someoneelse/x'] } })).toEqual([]);
  });

  test('an empty config and an empty container match nothing', () => {
    expect(groupsFor('/tmp/x/authkit-nextjs', { groups: {} })).toEqual([]);
    expect(groupsFor('', CONFIG)).toEqual([]);
  });

  test('is pure — the same inputs give the same answer', () => {
    expect(groupsFor('/tmp/x/authkit-nextjs', CONFIG)).toEqual(groupsFor('/tmp/x/authkit-nextjs', CONFIG));
  });
});

let tmp: string;

function writeConfig(body: string): void {
  mkdirSync(join(tmp, 'data'), { recursive: true });
  writeFileSync(getGroupConfigPath(), body);
}

function removeConfig(): void {
  rmSync(getGroupConfigPath(), { force: true });
}

beforeAll(() => {
  tmp = makeTmp('memory-group');
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadGroupConfig', () => {
  beforeEach(() => {
    setMemoryEnv(tmp);
    removeConfig();
  });

  test('resolves under the data dir, never a repo', () => {
    expect(getGroupConfigPath()).toBe(join(tmp, 'data', 'groups.json'));
  });

  test('a missing file is an empty config, not an error', () => {
    expect(loadGroupConfig()).toEqual({ groups: {} });
  });

  test('a well-formed file round-trips', () => {
    writeConfig(JSON.stringify(CONFIG));
    expect(loadGroupConfig()).toEqual(CONFIG);
  });

  test('unparseable bytes degrade to an empty config', () => {
    writeConfig('{ not json at all');
    expect(loadGroupConfig()).toEqual({ groups: {} });
    writeConfig('');
    expect(loadGroupConfig()).toEqual({ groups: {} });
  });

  test('valid JSON of the wrong SHAPE degrades too — a parse guard alone catches none of these', () => {
    for (const body of [
      'null',
      '[]',
      '"authkit"',
      '{}',
      '{"groups": null}',
      '{"groups": "authkit"}',
      '{"groups": []}',
    ]) {
      writeConfig(body);
      expect(loadGroupConfig()).toEqual({ groups: {} });
    }
  });

  test('one malformed group entry is dropped without disabling the others', () => {
    // All-or-nothing would let a single typo silently turn off every group.
    writeConfig(JSON.stringify({ groups: { good: ['/tmp/x/*'], bad: 'not-an-array', alsoBad: [] } }));
    expect(loadGroupConfig()).toEqual({ groups: { good: ['/tmp/x/*'] } });
  });

  test('non-string globs inside a group are dropped', () => {
    writeConfig(JSON.stringify({ groups: { mixed: ['/tmp/x/*', 42, null] } }));
    expect(loadGroupConfig()).toEqual({ groups: { mixed: ['/tmp/x/*'] } });
  });
});

function record(text: string, scope: MemoryScope): MemoryRecord {
  return buildRecord({
    text,
    scope,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

const GROUP_MEMORY = record('Always import the SDK from the workspace root, never the package path', AUTHKIT);
const CLI_MEMORY = record('Always regenerate the command table after adding a subcommand', CLI_GROUP);
const UNNAMED_MEMORY = record('Always prefer the fast path when both are correct', UNNAMED);
const ORPHAN_MEMORY = record('Always tag the release before publishing the packages', ORPHAN);
const REPO_MEMORY = record('Always run the migrations before starting the dev server', REPO);
const WORKFLOW_MEMORY = record('Never commit directly to main on any repo', WORKFLOW);

const ALL = [GROUP_MEMORY, CLI_MEMORY, UNNAMED_MEMORY, ORPHAN_MEMORY, REPO_MEMORY, WORKFLOW_MEMORY];

function texts(records: MemoryRecord[]): string[] {
  return records.map((r) => r.text);
}

describe('activeMemoryFor with group scope', () => {
  beforeEach(() => {
    setMemoryEnv(tmp);
    closeDatabases();
    getMemoryDb().run('DELETE FROM memory');
    upsertCandidates(ALL);
    for (const r of ALL) setState(r.id, 'approved');
    writeConfig(JSON.stringify(CONFIG));
  });

  test('a group memory returns for a member container', () => {
    expect(texts(activeMemoryFor('/tmp/x/authkit-nextjs'))).toContain(GROUP_MEMORY.text);
  });

  test('a group memory returns for a member SUBDIRECTORY', () => {
    expect(texts(activeMemoryFor('/tmp/x/authkit-session/packages/core'))).toContain(GROUP_MEMORY.text);
  });

  test('a group memory does not return for a non-member', () => {
    const out = texts(activeMemoryFor('/tmp/x/sessions'));
    expect(out).not.toContain(GROUP_MEMORY.text);
    expect(out).toEqual([WORKFLOW_MEMORY.text]);
  });

  test('only the groups this container belongs to come back', () => {
    const out = texts(activeMemoryFor('/tmp/x/authkit-nextjs'));
    expect(out).toContain(GROUP_MEMORY.text);
    expect(out).not.toContain(CLI_MEMORY.text);
    expect(texts(activeMemoryFor('/tmp/x/cli/create'))).toContain(CLI_MEMORY.text);
  });

  test('a group memory with no group name matches nothing', () => {
    // '' would otherwise be compared against every configured group name.
    for (const cwd of ['/tmp/x/authkit-nextjs', '/tmp/x/cli/create', '/tmp/x/sessions']) {
      expect(texts(activeMemoryFor(cwd))).not.toContain(UNNAMED_MEMORY.text);
    }
  });

  test('a group nobody configured is inert rather than universal', () => {
    for (const cwd of ['/tmp/x/authkit-nextjs', '/tmp/x/sessions']) {
      expect(texts(activeMemoryFor(cwd))).not.toContain(ORPHAN_MEMORY.text);
    }
  });

  test('scope order is workflow, then group, then repo', () => {
    const out = activeMemoryFor('/tmp/x/authkit-nextjs');
    expect(out.map((r) => r.scope.type)).toEqual(['workflow', 'group', 'repo']);
  });

  test('a deleted groups.json degrades to repo plus workflow without throwing', () => {
    removeConfig();
    const out = texts(activeMemoryFor('/tmp/x/authkit-nextjs'));
    expect(out).toEqual([WORKFLOW_MEMORY.text, REPO_MEMORY.text]);
  });

  test('a malformed groups.json degrades the same way', () => {
    writeConfig('{ not json');
    expect(texts(activeMemoryFor('/tmp/x/authkit-nextjs'))).toEqual([WORKFLOW_MEMORY.text, REPO_MEMORY.text]);
  });

  test('group memory participate in topic filtering like any other conditional memory', () => {
    const out = texts(activeMemoryFor('/tmp/x/authkit-nextjs', 'import the SDK'));
    expect(out).toContain(GROUP_MEMORY.text);
    expect(out).not.toContain(WORKFLOW_MEMORY.text);
  });

  test('an empty store short-circuits before any config work', () => {
    getMemoryDb().run('DELETE FROM memory');
    removeConfig();
    expect(activeMemoryFor('/tmp/x/authkit-nextjs')).toEqual([]);
  });
});
