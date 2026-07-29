// Project groups: the scope tier between repo and workflow.
//
// `~/Developer/authkit-*` is four repos that share conventions but are not universal
// workflow rules. Phase 1's spread heuristic (src/memory/mine.ts:151-156) cannot derive
// that grouping — it can count containers, but "these four are related" is not a fact
// about spread — so groups are the one scope that needs configuration.
//
// The config lives in the data dir and NOWHERE ELSE. Writing a `.sessions/` file into a
// project would violate the out-of-band requirement outright, and this module never
// reads a repo path at all.
//
// `groupsFor` is pure (the config is injected) so a test can drive it without a fixture
// file; `loadGroupConfig` is the only I/O here.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDataDir } from '../paths';

export interface GroupConfig {
  /** Group name → path globs over repo containers. */
  groups: Record<string, string[]>;
}

/** No configured groups. The value every failure path degrades to. */
const EMPTY_CONFIG: GroupConfig = { groups: {} };

/**
 * Resolved per call, never frozen at import — same reason as src/paths.ts:14-18. A
 * hermetic test rewrites SESSIONS_DATA_DIR after this module is already loaded.
 */
export function getGroupConfigPath(): string {
  return join(getDataDir(), 'groups.json');
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * `Bun.Glob` does no shell expansion — verified: `new Bun.Glob('~/Developer/authkit-*')`
 * does not match `/Users/me/Developer/authkit-x` — so this has to happen before the
 * pattern is compiled. Only a bare `~` and a `~/` prefix expand; `~someuser` is left
 * alone rather than guessed at, because resolving another account's home requires a
 * passwd lookup and getting it wrong silently produces a group that matches nothing.
 */
function expandHome(pattern: string): string {
  if (pattern === '~') return homedir();
  if (pattern.startsWith('~/')) return join(homedir(), pattern.slice(2));
  return pattern;
}

/**
 * Every path from `container` up to the filesystem root, `container` first.
 *
 * This is what makes a glob match a member's SUBDIRECTORY. `Bun.Glob`'s `*` does not
 * cross `/` — verified: `/tmp/x/authkit-*` matches `/tmp/x/authkit-nextjs` but not
 * `/tmp/x/authkit-session/packages/core` — and `activeMemoryFor` passes whatever
 * `createContainerResolver` produced, which for a cwd outside any git repo is the raw
 * cwd, subdirectory and all. Testing the ancestors is the JS analogue of the boundary
 * semantics `cwdUnder` (src/repo.ts:73-75) already gives repo scope: a group's globs
 * describe the group's ROOTS, and being anywhere beneath one is membership.
 *
 * Bounded by construction — `dirname('/')` is `'/'`, so the walk terminates at the
 * root and a path has as many ancestors as it has segments.
 */
function selfAndAncestors(container: string): string[] {
  const out: string[] = [];
  let current = container;
  while (true) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/**
 * Groups whose globs match `container`. Empty when none match or the config is empty.
 *
 * The glob metacharacters here are the INVERSE of the situation in
 * src/memory/retrieve.ts:24-32. There, a stored repo path lands in the pattern position
 * and a `[` in it would silently match nothing, so the predicate avoids GLOB entirely.
 * Here the pattern comes from the user's own config, so `*` and `[a-z]` are meaningful
 * and escaping them would break the feature. A `[` in a *path* being tested is data and
 * is never interpreted.
 *
 * Names are sorted so a container in two groups produces the same order every call —
 * `activeMemoryFor` promises byte-identical output for identical inputs.
 */
export function groupsFor(container: string, config: GroupConfig): string[] {
  if (!container) return [];
  const candidates = selfAndAncestors(container);
  const matched: string[] = [];
  for (const [name, patterns] of Object.entries(config.groups)) {
    // An unnamed group cannot be referenced by a memory's scope key, and an empty key is
    // skipped on retrieval anyway — matching it would attach a group to every memory.
    if (!name) continue;
    const hit = patterns.some((pattern) => {
      if (!pattern) return false;
      const glob = new Bun.Glob(expandHome(pattern));
      return candidates.some((path) => glob.match(path));
    });
    if (hit) matched.push(name);
  }
  return matched.sort();
}

/** Narrow an unknown parse result to `Record<string, string[]>`, dropping what does not fit. */
function readGroups(parsed: unknown): GroupConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_CONFIG;
  const raw = (parsed as { groups?: unknown }).groups;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_CONFIG;
  const groups: Record<string, string[]> = {};
  for (const [name, patterns] of Object.entries(raw as Record<string, unknown>)) {
    // Per-entry rather than all-or-nothing: one mistyped group must not disable the
    // others, for the same reason a missing file must not disable retrieval.
    if (!Array.isArray(patterns)) continue;
    const strings = patterns.filter((p): p is string => typeof p === 'string');
    if (strings.length > 0) groups[name] = strings;
  }
  return { groups };
}

/**
 * Read `$SESSIONS_DATA_DIR/groups.json`. Missing or malformed → empty config, never throws.
 *
 * Two divergences from the settings-load precedent at src/hooks.ts:54-62, both
 * deliberate:
 *
 *  - It writes NOTHING to stderr. This runs inside `get_memory`, and the MCP server
 *    speaks JSON-RPC over stdio (src/mcp.ts connects a StdioServerTransport), so a
 *    diagnostic line is protocol corruption. Silence is the only safe failure here.
 *  - A `try/catch` around `JSON.parse` is not enough. `{"groups": "authkit"}` and
 *    `{"groups": {"a": "x"}}` are perfectly valid JSON of the wrong shape, and would
 *    have `groupsFor` iterating the characters of a string. The shape is checked
 *    structurally, not assumed.
 *
 * Re-read on every call rather than memoized. `activeMemoryFor` runs once per tool
 * invocation and only reaches this when a group-scoped memory exists, so the cost is one
 * `statSync`-shaped syscall plus a small parse — while a process-lifetime memo inside a
 * long-lived MCP server would mean editing groups.json required restarting the client,
 * and would make "deleting groups.json does not break retrieval" pass for the wrong
 * reason.
 */
export function loadGroupConfig(): GroupConfig {
  const path = getGroupConfigPath();
  if (!existsSync(path)) return EMPTY_CONFIG;
  try {
    return readGroups(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return EMPTY_CONFIG;
  }
}
