import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assistantTurn, closeDatabases, makeTmp, setMemoryEnv, userTurn, writeSession } from './memory/fixtures';
import { resolveRepo } from './repo';
import { getArchiveDir, loadManifest } from './vault/archive';

// The resource surface is pure protocol: `resources/list` accepts no parameters and
// `resources/read` has no run* seam, so an in-memory Client over createServer() is the only
// thing that exercises either one. The one seam that does exist — listRepoSessions({ cwd }) —
// is asserted directly for the two facts the protocol cannot carry: the untruncated repo
// count (the SDK rebuilds the list result as `{ resources }` and drops everything else) and
// the behavior of a cwd that is not inside a git repo.

let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');

/**
 * `resources/read` contents are a text-or-blob union, so `.text` needs narrowing. Every
 * resource this server serves is text; asserting that here means a blob-shaped regression
 * fails loudly instead of stringifying to "undefined" and slipping past a toContain.
 */
function textOf(content: { text: string } | { blob: string }): string {
  if (!('text' in content)) throw new Error('expected a text resource, got a blob');
  return content.text;
}

/** Container of the repo the list is scoped to. 60 indexed sessions — above the cap. */
let mainRepo: string;
/** Exactly MAX_LISTED_RESOURCES sessions: the boundary where the cap and the total meet. */
let edgeRepo: string;
/** Three sessions — below the cap, so no truncation note may appear. */
let smallRepo: string;
/** A `…-v2` SIBLING of mainRepo. Its sessions must never appear in mainRepo's list: the
 *  scope predicate is `cwd = root OR cwd GLOB root/*`, and a plain prefix match would
 *  wrongly swallow this path. */
let siblingDir: string;
/** Not a git repo at all. */
let nonGitDir: string;
/** Main worktree of a NORMAL (non-bare) repo with a linked worktree added beside it. */
let wtMain: string;
/** `git worktree add ../wt-repo-feature` — a SIBLING of wtMain, which is where git puts a
 *  linked worktree of a normal repo, and the case a container prefix cannot reach. */
let wtLinked: string;
/** Same path prefix as wtMain, not a worktree of it. The control for the test above. */
let wtDecoy: string;

const REPO_SESSIONS = 60;
const EDGE_SESSIONS = 50;
const SMALL_SESSIONS = 3;

/** Uppercase ids are ~10% of a real index, and a non-special URI scheme keeps an opaque
 *  host's case. This id is the tripwire if URL handling ever starts normalizing. */
const UPPERCASE_ID = 'ses_45c70be5bffeoAZtXepTvHBhY5';
const UNREADABLE_ID = 'gone-from-disk-but-still-indexed';

/** Realistic 36-char ids (UUID-shaped, as Claude Code writes them): the serialized-size
 *  budget below is meaningless against 12-char fixture ids. */
function repoSessionId(i: number): string {
  return `0e02b2c3-d479-4372-a567-${String(i).padStart(12, '0')}`;
}

function otherId(prefix: string, i: number): string {
  return `${prefix}-d479-4372-a567-${String(i).padStart(12, '0')}`;
}

/** One distinct calendar day per session. The index stores `created_at` as a DATE, so
 *  same-day sessions tie under `ORDER BY created_at DESC` and "newest first" would be
 *  unassertable. */
function dayIso(i: number): string {
  return new Date(Date.UTC(2026, 2, 1) + i * 86_400_000).toISOString();
}

/** Longer than the 100 chars the indexer keeps, so every entry name exercises truncation.
 *  The index leads so the first 60 chars stay unique per session. */
function longPrompt(i: number): string {
  return `Session ${i}: trace the retry backoff through the scheduler, the queue worker, and the dead-letter path`;
}

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

/** A real repo, because resolveRepo shells out to git — there is no stub seam under it. */
function initRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  const r = Bun.spawnSync(['git', '-C', path, 'init', '-q', '-b', 'main'], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git init failed: ${new TextDecoder().decode(r.stderr)}`);
  return path;
}

function git(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(r.stderr)}`);
}

/**
 * A normal repo plus a real linked worktree, created the way a person does it.
 *
 * Real git rather than a hand-built RepoInfo, because the whole defect lived in the gap
 * between what `git worktree list` reports and what `--show-toplevel` returns: a fake would
 * have encoded the assumption under test. `--allow-empty` because `worktree add` needs a
 * HEAD commit and the tree's contents are irrelevant here.
 */
function initRepoWithLinkedWorktree(main: string, linked: string): void {
  initRepo(main);
  git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature']);
}

function seed(id: string, cwd: string, day: number, prompt: string, reply: string): string {
  return writeSession(tmp, id, cwd, [userTurn(prompt, dayIso(day)), assistantTurn(reply, dayIso(day))]);
}

async function connect(): Promise<Client> {
  const server = mcp.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sessions-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/**
 * Run something with the process cwd pinned. This is not test scaffolding for its own sake:
 * `resources/list` takes no parameters, so the production scope really is process.cwd(), and
 * during `bun test` that is the sessions repo itself. Without pinning, the protocol-level
 * list and no-repo cases would assert against the developer's own session history.
 */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

beforeAll(async () => {
  tmp = makeTmp('mcp-resources');
  setMemoryEnv(tmp);

  const repos = join(tmp, 'repos');
  mkdirSync(repos, { recursive: true });
  mainRepo = initRepo(join(repos, 'live'));
  edgeRepo = initRepo(join(repos, 'edge'));
  smallRepo = initRepo(join(repos, 'small'));
  siblingDir = join(repos, 'live-v2');
  nonGitDir = join(tmp, 'plain');
  mkdirSync(siblingDir, { recursive: true });
  mkdirSync(nonGitDir, { recursive: true });

  wtMain = join(repos, 'wt-repo');
  wtLinked = join(repos, 'wt-repo-feature');
  wtDecoy = join(repos, 'wt-repo-v2');
  initRepoWithLinkedWorktree(wtMain, wtLinked);
  mkdirSync(wtDecoy, { recursive: true });
  seed(otherId('wtmain00', 0), wtMain, 1, 'work on the main worktree', 'main');
  seed(otherId('wtlink00', 0), wtLinked, 2, 'work on the linked worktree', 'linked');
  seed(otherId('wtdecoy0', 0), wtDecoy, 3, 'work in the v2 decoy', 'decoy');

  // 59 in the repo root plus one in a subdirectory — a descendant cwd must count as the
  // same repo, and making it the newest puts it at the head of the list.
  for (let i = 0; i < REPO_SESSIONS - 1; i++) {
    seed(repoSessionId(i), mainRepo, i, longPrompt(i), `worked on session ${i}`);
  }
  const nested = join(mainRepo, 'src');
  mkdirSync(nested, { recursive: true });
  seed(repoSessionId(REPO_SESSIONS - 1), nested, REPO_SESSIONS - 1, longPrompt(REPO_SESSIONS - 1), 'newest');

  for (let i = 0; i < EDGE_SESSIONS; i++) {
    seed(otherId('edge0000', i), edgeRepo, i, longPrompt(i), 'edge');
  }
  for (let i = 0; i < SMALL_SESSIONS; i++) {
    seed(otherId('small000', i), smallRepo, i, longPrompt(i), 'small');
  }
  // Sessions on the sibling path. Reachable by id through the template, never by list.
  for (let i = 0; i < 3; i++) {
    seed(otherId('siblin00', i), siblingDir, i, longPrompt(i), 'sibling');
  }
  seed(UPPERCASE_ID, siblingDir, 5, 'why is the retry test flaky', 'the mangowurzel guard was inverted');
  seed(UNREADABLE_ID, siblingDir, 6, 'this transcript will vanish', 'indexed while it still existed');

  mcp = await import('./mcp');
  cache = await import('./cache');
});

beforeEach(() => {
  // cache.ts is one shared module instance across a `bun test` run: re-assert this fixture's
  // env and drop the handle another file opened, so the first query below reindexes against
  // this temp tree regardless of file order.
  setMemoryEnv(tmp);
  closeDatabases();
});

afterAll(() => {
  closeDatabases(); // release the handle before the fixture tree goes away
  rmSync(tmp, { recursive: true, force: true });
});

const SIBLING_URIS = [0, 1, 2].map((i) => `sessions://${otherId('siblin00', i)}`);

describe('resources template', () => {
  test('resources/templates/list advertises sessions://{sessionId} — one variable, no enumeration', async () => {
    const client = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resourceTemplates).toHaveLength(1);
    const t = resourceTemplates[0]!;
    expect(t.uriTemplate).toBe('sessions://{sessionId}');
    expect(t.name).toBe('session');
    expect(t.mimeType).toBe('text/markdown');
    expect(t.description!.length).toBeGreaterThan(20);
    // Deliberately no title: this same metadata object is spread onto all 50 list entries,
    // where one constant title would be both misleading and 1,400 chars of budget.
    expect(t.title).toBeUndefined();
    // The template addresses every indexed session, including the ones the repo-scoped
    // list never mentions — that split is the whole point of advertising a template.
    expect(t.uriTemplate).not.toContain('{tool}');
    await client.close();
  });

  test('resources/read returns the addressed session digest as markdown, uppercase id intact', async () => {
    const client = await connect();
    const res = await client.readResource({ uri: `sessions://${UPPERCASE_ID}` });

    expect(res.contents).toHaveLength(1);
    const c = res.contents[0]!;
    expect(c.uri).toBe(`sessions://${UPPERCASE_ID}`); // a non-special scheme keeps the case
    expect(c.mimeType).toBe('text/markdown');
    const text = textOf(c);
    expect(text).toContain(`# Session digest: ${UPPERCASE_ID}.jsonl`);
    expect(text).toContain('why is the retry test flaky');
    expect(text).toContain('mangowurzel');
    // The bounded projection, never the raw transcript: a read must not be able to flood
    // the context this whole surface is about protecting.
    expect(text.length).toBeLessThan(9000);
    await client.close();
  });

  test('resources/read of a session outside the listed repo still resolves — the template is not repo-scoped', async () => {
    const client = await connect();
    // This id lives on the sibling path that the repo-scoped list deliberately excludes.
    const res = await client.readResource({ uri: SIBLING_URIS[0]! });
    expect(textOf(res.contents[0]!)).toContain('# Session digest:');
    await client.close();
  });

  test('resources/read on an unknown id rejects with InvalidParams rather than serving empty content', async () => {
    const client = await connect();
    // Resources are the opposite of tools here: tools/call returns isError, resources/read
    // rejects. Substring, not equality — the SDK double-prefixes the error message.
    await expect(client.readResource({ uri: 'sessions://does-not-exist' })).rejects.toThrow(
      /Unknown session: does-not-exist/,
    );
    await client.close();
  });

  test('resources template read of an indexed-but-unreadable transcript returns a note, not a rejection', async () => {
    const priorInterval = process.env.SESSIONS_REFRESH_INTERVAL_MS;
    const path = join(tmp, 'claude', 'proj', `${UNREADABLE_ID}.jsonl`);
    const contents = await Bun.file(path).text();
    // Freeze the freshness window so the read below reuses the row indexed while the file
    // still existed. Without this the read's own ensureIndexFresh would rescan, drop the
    // row, and the assertion would land on "unknown id" — a different branch entirely.
    process.env.SESSIONS_REFRESH_INTERVAL_MS = '600000';
    try {
      await mcp.listRepoSessions({ cwd: mainRepo }); // forces the scan, stamps the window
      // The scan also archived this transcript into the vault, which is a durable read
      // fallback — so to reach the genuinely-unreadable branch both copies must be gone.
      const vaultCopy = loadManifest(getArchiveDir())[path]?.vaultPath;
      rmSync(path);
      if (vaultCopy) rmSync(vaultCopy, { force: true });
      const client = await connect();
      const res = await client.readResource({ uri: `sessions://${UNREADABLE_ID}` });
      const text = textOf(res.contents[0]!);
      expect(text).toContain('could not be read');
      expect(text).toContain(UNREADABLE_ID);
      await client.close();
    } finally {
      writeFileSync(path, contents);
      if (priorInterval === undefined) delete process.env.SESSIONS_REFRESH_INTERVAL_MS;
      else process.env.SESSIONS_REFRESH_INTERVAL_MS = priorInterval;
    }
  });
});

describe('resources bounded list', () => {
  test('the cap is 50 — the enumeration budget is a constant, not a caller argument', () => {
    expect(mcp.MAX_LISTED_RESOURCES).toBe(50);
  });

  test('60 repo sessions yield 50 entries newest-first with an accurate untruncated total', async () => {
    const { resources, totalInRepo } = await mcp.listRepoSessions({ cwd: mainRepo });

    expect(resources).toHaveLength(50);
    expect(totalInRepo).toBe(REPO_SESSIONS);
    // Newest first, and the newest session's cwd is a SUBDIRECTORY of the repo — a
    // descendant scopes to the same repo.
    expect(resources[0]!.uri).toBe(`sessions://${repoSessionId(REPO_SESSIONS - 1)}`);
    // The 10 oldest fall off the end rather than the 10 newest.
    expect(resources.at(-1)!.uri).toBe(`sessions://${repoSessionId(REPO_SESSIONS - 50)}`);
    expect(new Set(resources.map((r) => r.uri)).size).toBe(50); // no id served twice
  });

  test('a truncated list says so: the untruncated count rides an entry description', async () => {
    const { resources } = await mcp.listRepoSessions({ cwd: mainRepo });
    // The count cannot ride the protocol — the SDK drops every top-level field but
    // `resources` — so a client that only ever sees the list still learns it is partial.
    expect(resources[0]!.description).toContain(`showing 50 of ${REPO_SESSIONS} in this repo`);
    expect(resources[0]!.description).toMatch(/^claude · 2026-04-29/); // tool and date, not the URI
  });

  test('entry names are truncated to 60 chars, so 50 entries cannot blow the budget on size', async () => {
    const { resources } = await mcp.listRepoSessions({ cwd: mainRepo });
    for (const r of resources) {
      expect(r.name.length).toBeLessThanOrEqual(60);
    }
    // The fixture prompts are longer than that, so this really is the truncating path.
    expect(resources[0]!.name.endsWith('…')).toBe(true);
    expect(new Set(resources.map((r) => r.name)).size).toBe(50); // still distinguishable
  });

  test('resources/list over the protocol returns the same 50 entries within a measured size budget', async () => {
    const client = await connect();
    const { resources } = await withCwd(mainRepo, () => client.listResources());

    expect(resources).toHaveLength(50);
    expect(resources.every((r) => r.uri.startsWith('sessions://'))).toBe(true);

    // Measured against this fixture, not inherited from the spec. A 6,000-char list is
    // arithmetically impossible at a 50 cap: uri + name alone serialize to ~107 chars an
    // entry, and the SDK spreads the template's metadata onto every one (mcp.js:359-363).
    // This fixture is the worst case — all 50 names at the 60-char cap — and measures 9,533
    // chars (~2,400 tokens); the developer's real 134-session repo measures 8,534. Both are
    // ~16x under the ~157,000 tokens enumerating the whole index would cost, which is the
    // number the cap exists to prevent. A regression that removed the cap fails here long
    // before it fails on entry count.
    const serialized = JSON.stringify(resources).length;
    expect(serialized).toBeLessThan(10_000);

    // No per-entry `title`: the SDK spreads template metadata onto entries, so a template
    // title would render as 50 identical rows in a picker. `name` carries the intent.
    expect(resources.every((r) => r.title === undefined)).toBe(true);
    await client.close();
  });

  test('sessions from a sibling path are excluded — scoping is boundary-aware, not a prefix match', async () => {
    const { resources, totalInRepo } = await mcp.listRepoSessions({ cwd: mainRepo });
    const uris = new Set(resources.map((r) => r.uri));
    for (const sibling of SIBLING_URIS) {
      expect(uris.has(sibling)).toBe(false);
    }
    // `repos/live-v2` shares every character of `repos/live` — if it leaked in, the count
    // would climb past the sessions actually in this repo.
    expect(totalInRepo).toBe(REPO_SESSIONS);
    expect(uris.has(`sessions://${UPPERCASE_ID}`)).toBe(false);
  });

  test('a repo with exactly 50 sessions returns all 50 and claims no truncation', async () => {
    const { resources, totalInRepo } = await mcp.listRepoSessions({ cwd: edgeRepo });
    expect(resources).toHaveLength(EDGE_SESSIONS);
    expect(totalInRepo).toBe(EDGE_SESSIONS);
    // The boundary the off-by-one lives on: total === cap is complete, so no "showing" note.
    expect(resources[0]!.description).not.toContain('showing');
  });

  test('a repo under the cap returns everything it has, still with no truncation note', async () => {
    const { resources, totalInRepo } = await mcp.listRepoSessions({ cwd: smallRepo });
    expect(resources).toHaveLength(SMALL_SESSIONS);
    expect(totalInRepo).toBe(SMALL_SESSIONS);
    expect(resources.some((r) => r.description.includes('showing'))).toBe(false);
  });

  test('the underlying query bounds itself in SQL rather than selecting every row', async () => {
    // Bounded in SQL, not sliced in JS: a client may poll resources/list every turn, and
    // reading thousands of rows to hand back 50 is the cost this surface exists to avoid.
    const repo = resolveRepo(mainRepo)!;
    const two = await cache.recentSessionsForRepo(repo, 2);
    expect(two.rows).toHaveLength(2);
    expect(two.totalCount).toBe(REPO_SESSIONS); // the total ignores the limit
    const over = await cache.recentSessionsForRepo(repo, REPO_SESSIONS + 1);
    expect(over.rows).toHaveLength(REPO_SESSIONS);
  });
});

describe('resources across a normal repo’s worktrees', () => {
  const MAIN_URI = `sessions://${otherId('wtmain00', 0)}`;
  const LINKED_URI = `sessions://${otherId('wtlink00', 0)}`;
  const DECOY_URI = `sessions://${otherId('wtdecoy0', 0)}`;

  /** Both directions, because they fail for different reasons: from the main worktree the
   *  linked one is not a descendant, and from the linked worktree `container` resolves to the
   *  linked path, which has the main worktree nowhere under it. */
  for (const [label, cwd] of [
    ['main', () => wtMain],
    ['linked', () => wtLinked],
  ] as const) {
    test(`listing from the ${label} worktree returns both worktrees' sessions`, async () => {
      const { resources, totalInRepo } = await mcp.listRepoSessions({ cwd: cwd() });
      const uris = new Set(resources.map((r) => r.uri));
      expect(uris.has(MAIN_URI)).toBe(true);
      expect(uris.has(LINKED_URI)).toBe(true);
      // The scope is an enumeration of live worktrees, not a path prefix — so a directory
      // that merely shares the prefix is still excluded.
      expect(uris.has(DECOY_URI)).toBe(false);
      expect(totalInRepo).toBe(2);
    });
  }
});

describe('resources no repo', () => {
  test('a cwd outside any git repo yields an empty list at the seam and never throws', async () => {
    expect(await mcp.listRepoSessions({ cwd: nonGitDir })).toEqual({ resources: [], totalInRepo: 0 });
  });

  test('resources/list from a non-git cwd returns an empty list over the protocol', async () => {
    const client = await connect();
    // Clients call resources/list speculatively; an error here would break the picker on
    // every turn for anyone whose server was spawned outside a repo.
    const { resources } = await withCwd(nonGitDir, () => client.listResources());
    expect(resources).toEqual([]);
    await client.close();
  });

  test('the template stays advertised even when the list is empty', async () => {
    const client = await connect();
    const { resourceTemplates } = await withCwd(nonGitDir, () => client.listResourceTemplates());
    // Addressing survives an empty picker: every indexed session is still reachable by id.
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['sessions://{sessionId}']);
    await client.close();
  });
});
