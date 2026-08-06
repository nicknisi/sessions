// The write-back half of the memory pipeline: state transitions, snooze date math,
// and the resurface predicate.
//
// Phase 1 narrows and persists; the `/memory` skill judges. This module is the seam
// between them — three thin writes over store.ts's `setState` plus the pure logic
// that decides whether a dismissed candidate is allowed back into the batch. No LLM
// call and no clock read happen here: `todayIso` is injected everywhere, following
// the `nowMs` precedent in src/significance.ts:1-4, so a date-boundary test is
// deterministic instead of green until the 31st of a month.

import {
  getPersistedStates,
  listMemories,
  setAlwaysOn,
  setMerged,
  setScope,
  setState,
  updateEvidence,
  upsertCandidates,
} from './store';
import { buildRecord } from './record';
import { ContentScanError, describeFindings, scanMemoryText } from './scan';
import type { MemoryEvidence, MemoryRecord, MemoryScope } from './types';

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
 * Should a snoozed memory reappear? True only when BOTH hold:
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
 * WHERE THE SECOND CONDITION GETS ITS EVIDENCE. `mine()` hardcodes
 * `distinctPhrasings = 1` per record and always will: an id is a hash of that record's
 * own normalized text, so a new wording is a new row rather than a bigger count. The
 * count grows in exactly one place — `mergeInto` below, when the triage skill folds
 * paraphrases into a canonical record — and that is also where this predicate is
 * evaluated, because a merge is the moment new evidence actually arrives.
 *
 * `dropSuppressed` still calls this during a mine. That call is correct but inert by
 * construction: the fresh record it passes always carries 1, so a mine alone never
 * resurfaces anything. Keeping it costs nothing and keeps the batch filter honest if a
 * future mine ever does produce merged evidence.
 */
export function shouldResurface(record: MemoryRecord, freshPhrasings: number, todayIso: string): boolean {
  if (record.state !== 'snoozed') return false;
  const until = record.snoozedUntil;
  if (!until) return false;
  if (todayIso < until) return false;
  return freshPhrasings > record.evidence.distinctPhrasings;
}

/**
 * The always-on budget: a hard cap on how many standing constraints exist and how
 * many characters they spend, enforced when `--always-on` is granted and never when
 * it is kept. The cap is what makes the flag's promise credible — always-on rows are
 * served first and unconditionally, so a set that grows without bound degrades into
 * the ambient noise it exists to cut through, and the agent reading them stops
 * treating any of them as special. Sized like hermes' standing-instruction budget
 * (20 entries / 2,000 chars), which the numbers are borrowed from; exported so tuning
 * is a one-line change, like SNOOZE_DAYS above.
 */
export const ALWAYS_ON_MAX_ENTRIES = 20;
export const ALWAYS_ON_MAX_CHARS = 2000;

/**
 * Thrown when `--always-on` would exceed the budget. A class rather than a bare
 * Error so src/memory/cli.ts can `die()` cleanly on a refusal the user caused
 * without also swallowing programmer errors.
 */
export class AlwaysOnBudgetError extends Error {}

/**
 * Refuse an `--always-on` grant that would blow the budget.
 *
 * `id` is excluded from the standing set so re-approving an already-always-on row is
 * idempotent at the cap rather than refused for colliding with itself — its slot
 * transfers to the text it will now carry. The count is over APPROVED rows only:
 * a rejected or merged row's flag is inert (retrieval filters on state first), so
 * charging it against the budget would refuse grants for rows no agent ever sees.
 */
function assertAlwaysOnBudget(newText: string, id: string, all: MemoryRecord[]): void {
  const standing = all.filter((r) => r.state === 'approved' && r.alwaysOn && r.id !== id);
  const chars = standing.reduce((n, r) => n + r.text.length, 0);
  if (standing.length + 1 <= ALWAYS_ON_MAX_ENTRIES && chars + newText.length <= ALWAYS_ON_MAX_CHARS) return;
  throw new AlwaysOnBudgetError(
    `--always-on refused: the always-on set is at its budget ` +
      `(${standing.length}/${ALWAYS_ON_MAX_ENTRIES} entries, ${chars}/${ALWAYS_ON_MAX_CHARS} chars). ` +
      `The cap is what keeps standing constraints few enough to always be read. ` +
      `Free a slot first: sessions memory approve <id> --no-always-on`,
  );
}

/** The two judgments a human can attach to an approval that no derivation can produce. */
export interface ApproveOptions {
  /**
   * `true` grants topic-matching bypass, `false` explicitly revokes it, and absent
   * leaves it alone. See MemoryRecord.alwaysOn. The tri-state preserves the set-only
   * principle — omission is not a decision — while giving the budget refusal a
   * release valve: an explicit `--no-always-on` IS a decision.
   */
  alwaysOn?: boolean;
  /** Override the derived scope. Only `group` is assignable — repo/workflow stay derived. */
  scope?: MemoryScope;
  /**
   * Canonical phrasing to store in place of the mined utterance.
   *
   * A mined candidate is a verbatim user turn, which is what the miner can see and is
   * routinely not what the fact IS: two of the first three memories approved on this
   * machine were questions ("describe what it means to distill…"), stored as `kind:
   * 'instruction'` and served to every future agent as binding. The triage skill already
   * writes a clean statement of the fact — it just had nowhere to put it, because an id
   * is a hash of its own text and `approve` took only an id. This is that field.
   */
  as?: string;
}

/**
 * Keep a candidate as a durable memory. Clears any snooze — `setState`'s default.
 *
 * Options apply only when stated: `approve(id)` after `approve(id, { alwaysOn: true })`
 * leaves the flag alone rather than clearing it. Omission is not a decision, and the
 * failure modes are asymmetric — a stale always-on costs some context on tasks it does
 * not apply to, while silently clearing one reintroduces exactly the invisible
 * suppression the flag exists to prevent, at the moment the user thought they were
 * re-confirming the memory. Clearing requires the explicit `alwaysOn: false`
 * (`--no-always-on`), which exists so the budget refusal above has a release valve.
 *
 * This is also the write gate on what an approval puts in front of every future
 * agent: the text that will be served — the `--as` rephrasing when given, the stored
 * row otherwise — must scan clean (src/memory/scan.ts). The mine and import gates
 * make a flagged CANDIDATE rare, but rows written before the gates existed, or by a
 * hand edit of memory.db, reach this moment unscanned; refusing here beats
 * withholding later, because the refusal reaches the human who can fix it.
 */
export function approve(id: string, options: ApproveOptions = {}): string {
  const all = listMemories();
  // An unknown id falls through unscanned on purpose: `setState` is a bare UPDATE
  // and `isKnownMemory` is the caller's check — a second existence error here would
  // shadow the CLI's, which names the id.
  const text = options.as ?? all.find((r) => r.id === id)?.text;
  if (text !== undefined) {
    const findings = scanMemoryText(text);
    if (findings.length > 0) {
      const source = options.as === undefined ? 'its text' : 'the --as phrasing';
      throw new ContentScanError(
        `refusing to approve ${id}: ${source} matches ${describeFindings(findings)}. ` +
          `Reject it (sessions memory reject ${id}) or approve a clean rephrasing ` +
          `(sessions memory approve ${id} --as "<text>").`,
        findings,
      );
    }
  }
  // Before recanonicalize: a refusal must not leave a half-approved rewrite behind
  // (the rewrite path writes a new row and re-points merged members at it).
  if (options.alwaysOn) assertAlwaysOnBudget(text ?? '', id, all);
  const target = options.as === undefined ? id : recanonicalize(id, options.as);
  setState(target, 'approved');
  if (options.alwaysOn) setAlwaysOn(target, true);
  else if (options.alwaysOn === false) setAlwaysOn(target, false);
  if (options.scope) setScope(target, options.scope);
  return target;
}

/**
 * Replace a record's text with the phrasing the skill judged canonical, and return the
 * id that now carries the fact.
 *
 * The rewrite is a NEW row, because an id is a hash of its own normalized text and
 * rewriting in place would leave every reference — merged members, an export bundle
 * another author already holds — pointing at a hash that no longer describes its
 * content. So the original becomes a member of the rewrite, through the same
 * `merged_into` edge a clustering merge uses, and its evidence carries over.
 *
 * Evidence transfers VERBATIM rather than through `mergeInto`'s union. The union counts
 * distinct texts across the cluster, and the canonical rewrite is not a phrasing the
 * user ever used — folding it in would add one to `distinctPhrasings`, inflating the
 * exact signal `shouldResurface` and the cross-author quorum rest on, for a sentence an
 * agent wrote. The fact has the support it always had; only the wording improved.
 */
function recanonicalize(id: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('--as needs a non-empty phrasing');

  const all = listMemories();
  const original = all.find((r) => r.id === id);
  if (!original) throw new Error(`unknown memory id: ${id}`);

  const rewritten = buildRecord({
    text: trimmed,
    kind: original.kind,
    scope: original.scope,
    author: original.author,
    sessions: original.evidence.sessions,
    dates: [original.evidence.firstSeen, original.evidence.lastSeen].filter((d) => d !== ''),
    distinctPhrasings: original.evidence.distinctPhrasings,
  });
  // Normalization collapsed the rewrite onto the text it replaces — approve in place
  // rather than merging a row into itself.
  if (rewritten.id === id) return id;

  // Replacing an existing key's value leaves insertion order intact, which buildRecord's
  // determinism contract depends on.
  upsertCandidates([{ ...rewritten, evidence: original.evidence }]);
  // Members of the old canonical follow the fact, not the wording it used to have.
  for (const member of all) {
    if (member.mergedInto === id) setMerged(member.id, rewritten.id);
  }
  setMerged(id, rewritten.id);
  return rewritten.id;
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
export function isKnownMemory(id: string): boolean {
  return getPersistedStates([id]).has(id);
}

/** What a merge did, so the CLI can report it and a test can assert the resurface. */
export interface MergeResult {
  canonicalId: string;
  /** Ids actually absorbed — already-merged and self-referential members are skipped. */
  absorbed: string[];
  /** `distinctPhrasings` after the union. */
  distinctPhrasings: number;
  /** The canonical was snoozed, its evidence grew, and its date had passed. */
  resurfaced: boolean;
}

/**
 * Fold paraphrases into one canonical record.
 *
 * THIS IS WHAT MAKES `shouldResurface` REACHABLE. A record's id is a hash of its own
 * normalized text, so a new wording is always a new row and a fresh mine can never
 * raise any record's `distinctPhrasings` above 1 on its own. Recognizing that two
 * wordings assert the same fact is an LLM judgment that happens in the `/memory`
 * triage skill — and before this function existed that judgment had nowhere to go, so
 * the count never moved and the resurface condition was dead code.
 *
 * The union is the evidence of every phrasing: distinct texts counted, session paths
 * unioned, date range widened. `distinctPhrasings` therefore means what its name says
 * — how many different ways the user has expressed this fact — which is also the
 * signal `quorum` reads once a second author's records arrive.
 *
 * Resurface is evaluated HERE rather than during a mine, because this is the moment
 * new evidence actually arrives. A snoozed canonical whose date has passed and whose
 * phrasing count just grew returns to `candidate`: the user kept saying it in new
 * words, which is exactly the evidence the dismissal was wrong.
 *
 * A `rejected` canonical is never resurrected. Rejection is terminal for the mining
 * pipeline (`dropSuppressed`), and a merge is a clustering statement, not a verdict —
 * silently reviving a rejected fact because a paraphrase turned up would make reject
 * unreliable, which is worse than making it slightly too sticky.
 */
export function mergeInto(canonicalId: string, memberIds: string[], todayIso: string): MergeResult {
  const all = listMemories();
  const canonical = all.find((r) => r.id === canonicalId);
  if (!canonical) throw new Error(`unknown memory id: ${canonicalId}`);

  const byId = new Map(all.map((r) => [r.id, r]));
  const members: MemoryRecord[] = [];
  for (const id of memberIds) {
    // Self-merge and re-merge are no-ops rather than errors: the skill re-proposes a
    // cluster after a partial failure, and a merge that throws halfway is worse than
    // one that converges.
    if (id === canonicalId) continue;
    const member = byId.get(id);
    if (!member) throw new Error(`unknown memory id: ${id}`);
    if (member.state === 'merged') continue;
    members.push(member);
  }

  // Recompute over the WHOLE cluster — every row already pointing at this canonical,
  // plus the new members — never over the new members alone. Evidence is derived, not
  // accumulated: a second merge that saw only its own arguments would overwrite the
  // count the first one established and silently walk `distinctPhrasings` back down.
  const cluster = [canonical, ...all.filter((r) => r.mergedInto === canonicalId), ...members];

  // Distinct TEXTS, not row count: two rows could carry the same normalized text only
  // through a caller bug, and double-counting would inflate the very signal the
  // resurface decision rests on.
  const texts = new Set<string>(cluster.map((r) => r.text));
  const sessions = [...new Set(cluster.flatMap((r) => r.evidence.sessions))].sort();
  const dates = cluster
    .flatMap((r) => [r.evidence.firstSeen, r.evidence.lastSeen])
    .filter((d) => d !== '')
    .sort();

  const evidence: MemoryEvidence = {
    distinctPhrasings: texts.size,
    sessions,
    firstSeen: dates[0] ?? '',
    lastSeen: dates[dates.length - 1] ?? '',
  };

  const resurfaced = canonical.state === 'snoozed' && shouldResurface(canonical, evidence.distinctPhrasings, todayIso);

  updateEvidence(canonicalId, evidence);
  for (const member of members) setMerged(member.id, canonicalId);
  if (resurfaced) setState(canonicalId, 'candidate', null);

  return {
    canonicalId,
    absorbed: members.map((m) => m.id),
    distinctPhrasings: evidence.distinctPhrasings,
    resurfaced,
  };
}

/**
 * The rows that can suppress a freshly mined candidate, keyed by id.
 *
 * Read this BEFORE `upsertCandidates`, which refreshes `evidence` (src/memory/store.ts).
 * That write is a union now, so it can no longer walk the `distinctPhrasings` baseline
 * `shouldResurface` compares against back down — but the ordering stays, because
 * "the snapshot the filter reads predates the write" is a property worth keeping true
 * rather than one worth re-deriving from the union rules on every future change.
 * `getPersistedStates` cannot serve here — it projects state and snoozedUntil only,
 * with no evidence — so this goes through `listMemories`, whose state filter is
 * index-backed (idx_memory_state).
 */
export function suppressedMemories(): Map<string, MemoryRecord> {
  const out = new Map<string, MemoryRecord>();
  // `merged` belongs here even though it is not a verdict: the row's evidence now lives
  // on its canonical, so re-emitting it would present the same fact twice and invite the
  // user to triage a phrasing they already clustered.
  for (const state of ['rejected', 'snoozed', 'merged'] as const) {
    for (const record of listMemories({ state })) out.set(record.id, record);
  }
  return out;
}

/**
 * Remove candidates the user has already dismissed from an emitted batch.
 *
 * This runs in the CLI over the mined batch rather than inside `mine()`. Three
 * reasons, all load-bearing: `runMine` calls `upsertCandidates` *after* `mine()`, so
 * filtering upstream would starve a rejected row of the evidence refresh
 * src/memory/durability.test.ts:120-137 asserts; `mine()` is a pure narrowing pass
 * five other test files depend on (one asserts an exact record count); and the store
 * — not a fresh mine — is the authority on state, which is a CLI-layer invariant
 * already documented above `applyPersistedStates`.
 *
 * `stored` must be the PRE-upsert snapshot (see `suppressedMemories`).
 */
export function dropSuppressed(
  records: MemoryRecord[],
  stored: Map<string, MemoryRecord>,
  todayIso: string,
): MemoryRecord[] {
  return records.filter((record) => {
    const prior = stored.get(record.id);
    if (!prior) return true;
    if (prior.state === 'rejected') return false;
    // Absorbed into a canonical record; its fact is already represented.
    if (prior.state === 'merged') return false;
    if (prior.state === 'snoozed') return shouldResurface(prior, record.evidence.distinctPhrasings, todayIso);
    return true;
  });
}
