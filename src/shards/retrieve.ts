// Retrieval: the shards that belong in an agent's context for a given cwd and topic.
//
// This is a pure read over the durable store — it never writes a shard and never
// writes anything into the user's repo. The out-of-band promise of the design is
// enforced here by omission: the only thing this module knows how to do is SELECT.

import { cwdUnder } from '../repo';
import { groupsFor, loadGroupConfig } from './groups';
import { createContainerResolver } from './mine';
import { listShards } from './store';
import { matchTopic, TOPIC_THRESHOLD } from './topic';
import type { ShardRecord } from './types';

/**
 * Approved, non-snoozed shards for `cwd`, optionally narrowed to `topic`:
 *  - repo-scoped shards whose container equals or is a path-prefix of `cwd`
 *  - group-scoped shards whose group's configured globs cover the container
 *  - all workflow-scoped shards
 *
 * Ordering, in precedence order and written out in `rank` below:
 *  1. always-on shards first — they are standing constraints, and an agent that
 *     truncates should truncate the conditional tail, not the invariants.
 *  2. then by scope breadth: workflow, group, repo. Cross-repo standing rules frame
 *     the group ones, which frame the repo-specific ones.
 *  3. then by score descending when a topic was given.
 *  4. then by id, which is the order `listShards` already returns.
 *
 * With no topic and no group shards this is exactly the Phase 3 order, byte for byte —
 * the scoring pass is skipped entirely rather than run with a score that happens to
 * tie. No existing caller is narrowed by this phase.
 *
 * NOTE that the always-on flag bypasses the MATCHER only. A rejected, snoozed, or
 * candidate shard is filtered out before any of this runs, and an always-on repo shard
 * belonging to a different container is still not returned. "Always" means "regardless
 * of the topic", not "unconditionally".
 *
 * Synchronous on purpose: `getShardsDb()`, `resolveRepo`, and `loadGroupConfig` are all
 * sync, so the caller gets a plain array and the MCP seam stays a one-liner.
 *
 * Repo matching happens in TypeScript rather than SQL. The natural SQL form is
 * `? GLOB (scope_key || '/*')`, which puts a stored *column* in the pattern
 * position — and `globPrefix` (src/repo.ts:78-81), the helper that exists to escape
 * GLOB's `*?[` metacharacters, only works on a value. A repo living at a path
 * containing `[` would silently match nothing, which is the exact silent-empty
 * failure this predicate is here to prevent. `cwdUnder` (src/repo.ts:73-75) has
 * identical boundary semantics with no escaping hazard, and the approved set is
 * a handful of rows, so scanning it costs nothing.
 */
export function activeShardsFor(cwd: string, topic?: string): ShardRecord[] {
  // ORDER BY id already (src/shards/store.ts), so a stable partition below
  // preserves id order within each group for free.
  const approved = listShards({ state: 'approved' });
  if (approved.length === 0) return [];

  // One resolver, one git resolution per call. `resolveRepo` shells out three
  // times, and this sits on the hot path of every agent task start.
  const container = createContainerResolver()(cwd);

  // Lazy, and memoized for this call only. A store with no group-scoped shards — which
  // is every store until a human assigns one — never touches the filesystem for a
  // config file it has no use for.
  let memberOf: string[] | null = null;
  const groups = (): string[] => (memberOf ??= groupsFor(container, loadGroupConfig()));

  const workflow: ShardRecord[] = [];
  const group: ShardRecord[] = [];
  const repo: ShardRecord[] = [];
  for (const shard of approved) {
    if (shard.scope.type === 'workflow') {
      workflow.push(shard);
      continue;
    }
    // A repo shard with an empty key would match every cwd under any prefix rule
    // (`''` is a prefix of everything), leaking one repo's conventions everywhere. A
    // group shard with an empty key is the same hazard one step removed: it names no
    // group, so it can only ever match by accident. Unreachable from mine() today,
    // reachable from an imported or hand-seeded row.
    if (!shard.scope.key) continue;
    if (shard.scope.type === 'group') {
      // A group name that appears in no config is inert, silently. That is the
      // documented cost of a config file nothing writes for you — see the groups.json
      // section of the README.
      if (groups().includes(shard.scope.key)) group.push(shard);
      continue;
    }
    // Both directions: the container is what a linked worktree resolves to (a
    // SIBLING path, so a raw-cwd prefix would never match the main worktree's
    // shard), while the raw cwd is the backstop for a scope_key that was stored
    // from a non-git cwd and so never had a container.
    if (cwdUnder(container, shard.scope.key) || cwdUnder(cwd, shard.scope.key)) repo.push(shard);
  }

  const visible = [...workflow, ...group, ...repo];
  // An absent or content-free topic disables filtering entirely and returns the full
  // active set — the Phase 3 behavior, preserved exactly. The short-circuit is before
  // any scoring so there is no path on which a rounding difference could reorder it.
  if (!topic || !topic.trim()) return visible;

  const alwaysOn: ShardRecord[] = [];
  // Decorated with the visible-order index rather than sorted in place: `visible` is
  // already correct on every key but score, so the index IS the tiebreak, and a bare
  // `.sort()` over four keys is where a comparator stops being readable.
  const scored: { shard: ShardRecord; score: number; order: number }[] = [];
  visible.forEach((shard, order) => {
    if (shard.alwaysOn) {
      alwaysOn.push(shard);
      return;
    }
    const score = matchTopic(shard.text, topic);
    if (score >= TOPIC_THRESHOLD) scored.push({ shard, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  return [...alwaysOn, ...scored.map((s) => s.shard)];
}
