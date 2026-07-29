// Retrieval: the shards that belong in an agent's context for a given cwd.
//
// This is a pure read over the durable store — it never writes a shard and never
// writes anything into the user's repo. The out-of-band promise of the design is
// enforced here by omission: the only thing this module knows how to do is SELECT.
//
// Ranking, topic matching, and always-on flags are deliberately absent. Phase 5
// adds them; building a matcher before there is shard volume to tune it against
// would be tuning against nothing.

import { cwdUnder } from '../repo';
import { createContainerResolver } from './mine';
import { listShards } from './store';
import type { ShardRecord } from './types';

/**
 * Approved, non-snoozed shards for `cwd`:
 *  - repo-scoped shards whose container equals or is a path-prefix of `cwd`
 *  - all workflow-scoped shards
 * Sorted deterministically: workflow shards first, then repo shards, each by id.
 *
 * Synchronous on purpose: `getShardsDb()` and `resolveRepo` are both sync, so the
 * caller gets a plain array and the MCP seam stays a one-liner.
 *
 * Matching happens in TypeScript rather than SQL. The natural SQL form is
 * `? GLOB (scope_key || '/*')`, which puts a stored *column* in the pattern
 * position — and `globPrefix` (src/repo.ts:78-81), the helper that exists to escape
 * GLOB's `*?[` metacharacters, only works on a value. A repo living at a path
 * containing `[` would silently match nothing, which is the exact silent-empty
 * failure this predicate is here to prevent. `cwdUnder` (src/repo.ts:73-75) has
 * identical boundary semantics with no escaping hazard, and the approved set is
 * a handful of rows, so scanning it costs nothing.
 */
export function activeShardsFor(cwd: string): ShardRecord[] {
  // ORDER BY id already (src/shards/store.ts:190), so a stable partition below
  // preserves id order within each group for free.
  const approved = listShards({ state: 'approved' });
  if (approved.length === 0) return [];

  // One resolver, one git resolution per call. `resolveRepo` shells out three
  // times, and this sits on the hot path of every agent task start.
  const container = createContainerResolver()(cwd);

  const workflow: ShardRecord[] = [];
  const repo: ShardRecord[] = [];
  for (const shard of approved) {
    if (shard.scope.type === 'workflow') {
      workflow.push(shard);
      continue;
    }
    // A repo shard with an empty key would match every cwd under any prefix rule
    // (`''` is a prefix of everything), leaking one repo's conventions everywhere.
    // Unreachable from mine() today, reachable from an imported or hand-seeded row.
    if (!shard.scope.key) continue;
    // Both directions: the container is what a linked worktree resolves to (a
    // SIBLING path, so a raw-cwd prefix would never match the main worktree's
    // shard), while the raw cwd is the backstop for a scope_key that was stored
    // from a non-git cwd and so never had a container.
    if (cwdUnder(container, shard.scope.key) || cwdUnder(cwd, shard.scope.key)) repo.push(shard);
  }

  // Workflow first: cross-repo standing rules frame the repo-specific ones.
  return [...workflow, ...repo];
}
