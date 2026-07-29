// The write-back half of the shard pipeline: state transitions, snooze date math,
// and the resurface predicate.
//
// Phase 1 narrows and persists; the `/shards` skill judges. This module is the seam
// between them — three thin writes over store.ts's `setState` plus the pure logic
// that decides whether a dismissed candidate is allowed back into the batch. No LLM
// call and no clock read happen here: `todayIso` is injected everywhere, following
// the `nowMs` precedent in src/significance.ts:1-4, so a date-boundary test is
// deterministic instead of green until the 31st of a month.

import { getPersistedStates, listShards, setAlwaysOn, setScope, setState } from './store';
import type { ShardRecord, ShardScope } from './types';

/** How long a snooze suppresses a candidate. Exported so tuning is a one-line change. */
export const SNOOZE_DAYS = 30;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 'YYYY-MM-DD' `SNOOZE_DAYS` after `todayIso`. `todayIso` is injected so tests need
 * no clock.
 *
 * `Date.parse('YYYY-MM-DD')` is UTC midnight per the ECMAScript spec, and
 * `toISOString()` renders in UTC, so the value round-trips without timezone drift —
 * the same idiom src/wrapped/compute.ts:352-353 uses. Never `toLocaleDateString`.
 *
 * A malformed input would otherwise become `NaN` and make `toISOString()` throw a
 * bare `RangeError: Invalid time value`, so the shape is checked up front and the
 * offending string is named.
 */
export function snoozeUntil(todayIso: string): string {
  const parsed = Date.parse(todayIso);
  if (!ISO_DATE.test(todayIso) || Number.isNaN(parsed)) {
    throw new RangeError(`snoozeUntil expects a YYYY-MM-DD date, got: ${JSON.stringify(todayIso)}`);
  }
  return new Date(parsed + SNOOZE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Should a snoozed shard reappear? True only when BOTH hold:
 *  - today >= snoozedUntil, and
 *  - the fresh mine found more distinct phrasings than the record had when snoozed.
 *
 * The second condition is what makes continued repetition evidence the dismissal was
 * wrong. Without it snooze degrades into a 30-day delay: every dismissed candidate
 * returns on schedule and the user re-triages the same list forever.
 *
 * Both date strings are 'YYYY-MM-DD', which sorts lexicographically in calendar
 * order — comparing them as strings avoids parsing to `Date` and the timezone bugs
 * that come with it. Equality counts as expired.
 *
 * A `snoozed` row with no `snoozedUntil` is not reachable through `snooze()` below,
 * but a hand-edited store or a Phase 4 import could produce one; it must not
 * resurface by accident, so the null is an explicit guard rather than a `>=` against
 * `'null'`.
 *
 * KNOWN LIMIT — read this before trusting the second condition. `mine()` hardcodes
 * `distinctPhrasings = 1` per cluster (see the comment above that literal in
 * src/shards/mine.ts) because paraphrase clustering happens in the agent's context and
 * has no write-back path, so `freshPhrasings` is 1 for every record the real pipeline
 * produces and `1 > 1` is false: this condition CANNOT fire outside a test, and a
 * snoozed candidate therefore stays hidden indefinitely rather than for 30 days.
 *
 * Phase 6 was the phase this was deferred to and it did not close the gap; the
 * departure is recorded as an amendment and an Open Item in
 * docs/ideation/context-shards/spec-phase-6.md, and the user-facing copy in README.md,
 * src/cli.ts, src/shards/cli.ts and plugin/skills/shards/SKILL.md says so plainly. The
 * predicate itself stays as written — it is correct the moment merged evidence reaches
 * the store, and weakening it would turn snooze into a 30-day delay, which is the
 * failure mode the second condition exists to prevent.
 */
export function shouldResurface(record: ShardRecord, freshPhrasings: number, todayIso: string): boolean {
  if (record.state !== 'snoozed') return false;
  const until = record.snoozedUntil;
  if (!until) return false;
  if (todayIso < until) return false;
  return freshPhrasings > record.evidence.distinctPhrasings;
}

/** The two judgments a human can attach to an approval that no derivation can produce. */
export interface ApproveOptions {
  /** Bypass topic matching from now on. See ShardRecord.alwaysOn. */
  alwaysOn?: boolean;
  /** Override the derived scope. Only `group` is assignable — repo/workflow stay derived. */
  scope?: ShardScope;
}

/**
 * Keep a candidate as a durable shard. Clears any snooze — `setState`'s default.
 *
 * Both options are SET-ONLY: `approve(id)` after `approve(id, { alwaysOn: true })`
 * leaves the flag alone rather than clearing it. Omission is not a decision, and the
 * failure modes are asymmetric — a stale always-on costs some context on tasks it does
 * not apply to, while silently clearing one reintroduces exactly the invisible
 * suppression the flag exists to prevent, at the moment the user thought they were
 * re-confirming the shard. There is no CLI way to clear it yet; that is a deliberate
 * gap, not an oversight.
 */
export function approve(id: string, options: ApproveOptions = {}): void {
  setState(id, 'approved');
  if (options.alwaysOn) setAlwaysOn(id, true);
  if (options.scope) setScope(id, options.scope);
}

/**
 * Dismiss a candidate. Terminal for re-mining (it never re-enters the batch) but not
 * for the user: `approve` over a rejected row is an unconditional UPDATE, so
 * changing your mind through the CLI works.
 */
export function reject(id: string): void {
  setState(id, 'rejected');
}

/** Suppress a candidate for `SNOOZE_DAYS`, recording the expiry the batch filter reads. */
export function snooze(id: string, todayIso: string): void {
  setState(id, 'snoozed', snoozeUntil(todayIso));
}

/** True when the store holds a row for `id` — `setState` is a bare UPDATE and would
 *  otherwise report success for a typo'd id. */
export function isKnownShard(id: string): boolean {
  return getPersistedStates([id]).has(id);
}

/**
 * The rows that can suppress a freshly mined candidate, keyed by id.
 *
 * Read this BEFORE `upsertCandidates`. Its ON CONFLICT clause refreshes
 * `evidence` (src/shards/store.ts:139), which overwrites the very
 * `distinctPhrasings` baseline `shouldResurface` compares the fresh count against.
 * `getPersistedStates` cannot serve here — it projects state and snoozedUntil only,
 * with no evidence — so this goes through `listShards`, whose state filter is
 * index-backed (idx_shards_state).
 */
export function suppressedShards(): Map<string, ShardRecord> {
  const out = new Map<string, ShardRecord>();
  for (const state of ['rejected', 'snoozed'] as const) {
    for (const record of listShards({ state })) out.set(record.id, record);
  }
  return out;
}

/**
 * Remove candidates the user has already dismissed from an emitted batch.
 *
 * This runs in the CLI over the mined batch rather than inside `mine()`. Three
 * reasons, all load-bearing: `runMine` calls `upsertCandidates` *after* `mine()`, so
 * filtering upstream would starve a rejected row of the evidence refresh
 * src/shards/durability.test.ts:120-137 asserts; `mine()` is a pure narrowing pass
 * five other test files depend on (one asserts an exact record count); and the store
 * — not a fresh mine — is the authority on state, which is a CLI-layer invariant
 * already documented above `applyPersistedStates`.
 *
 * `stored` must be the PRE-upsert snapshot (see `suppressedShards`).
 */
export function dropSuppressed(
  records: ShardRecord[],
  stored: Map<string, ShardRecord>,
  todayIso: string,
): ShardRecord[] {
  return records.filter((record) => {
    const prior = stored.get(record.id);
    if (!prior) return true;
    if (prior.state === 'rejected') return false;
    if (prior.state === 'snoozed') return shouldResurface(prior, record.evidence.distinctPhrasings, todayIso);
    return true;
  });
}
