// The transport seam: a versioned wire format, its reader, and a pure merge over
// record sets contributed by any number of authors.
//
// This module deliberately implements NO transport. `sessions` never opens a socket
// and never gains a sync service; it emits a plain file, so whatever a team already
// has — a hidden git ref, a private repo, a shared drive, `scp` — becomes a viable
// carrier. Picking a transport before real multi-author records exist would fix the
// wrong shape.
//
// The seam ships COMPLETE, with its reader. A serializer with no reader proves
// nothing about round-trip fidelity: you cannot know a format survives the boundary
// until something reads it back.
//
// Everything here is pure, the clock included — `exportedAt` is injected, following
// the `todayIso` discipline documented at src/shards/cli.ts:54-58 and the `nowMs`
// precedent at src/significance.ts:1-4. That is what makes "two exports of an
// unchanged store are byte-identical" a test rather than a coin flip across midnight.
//
// Privacy is a hard constraint on export, not a preference, and it is enforced in
// exactly one place (`toPortable`). Nothing else in this file may add a field.

import { z } from 'zod';
import { MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from './mine';
import { buildRecord, fingerprint, normalizeText } from './record';
import {
  SHARD_SCHEMA_VERSION,
  type PortableShard,
  type ShardBundle,
  type ShardKind,
  type ShardRecord,
  type ShardScope,
} from './types';

/** 'YYYY-MM-DD'. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The exact form `fingerprint` (src/shards/record.ts:34-38) produces. */
const SHARD_ID = /^sha256:[0-9a-f]{64}$/;

/** Stable id ordering. `.sort()` on objects would compare "[object Object]". */
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A bundle that is not a bundle. Its own class rather than a bare `Error` so the CLI
 * can convert exactly this into a one-line usage error and let a genuine programmer
 * error keep its stack (src/shards/cli.ts converts only `UsageError`, and index.ts
 * has no handler at all — an unwrapped throw reaches the user as a stack trace).
 */
export class PortableFormatError extends Error {}

/**
 * Project stored records onto the wire format.
 *
 * Three filters, in order of how badly each would fail:
 *
 * 1. `state === 'approved'` EXACTLY — never `!== 'rejected'`, which would also ship
 *    candidates and snoozed rows. Candidates are unreviewed model output; publishing
 *    them would present raw pattern matches as facts the user endorsed.
 * 2. `evidence.sessions` is dropped. Local paths disclose directory structure and
 *    project names, and are meaningless to a recipient.
 * 3. `scope.key` is BLANKED for `repo`, which the spec's field list does not say. It is
 *    an absolute container path — `/Users/<name>/Developer/<project>` — so exporting it
 *    leaks exactly what stripping `sessions` was meant to prevent. Phase 3 already
 *    made this call at the other boundary: src/mcp.ts projects `scope.type` and
 *    drops the key. Nothing is lost by blanking it, because a foreign absolute path
 *    can never match locally anyway (`cwdUnder`, src/repo.ts:73-75), and a repo-scoped
 *    shard with an empty key is explicitly skipped on retrieval
 *    (src/shards/retrieve.ts) rather than matching every cwd.
 *
 *    A `group` key is the exception, and is PRESERVED. It is a human-chosen name, not a
 *    path: it discloses nothing about this machine's directory layout, and blanking it
 *    would strip the only thing that distinguishes one group from another — the shard
 *    would arrive scoped to a group with no name and be permanently inert. `alwaysOn`
 *    is not carried at all, for the same reason `state` is not: see types.ts.
 *
 *    A group name that means nothing to the recipient is the known cost. Their
 *    groups.json has no such group, `groupsFor` returns nothing for it, and the shard
 *    stays dormant until they configure one — the same shape as an unmatched repo key,
 *    and preferable to silently widening someone else's grouping to `workflow`.
 *
 * `v` is stamped at the current version rather than copied from each row: the
 * projection IS the current format by construction. A future migration must bring
 * rows forward before they can be exported, which is the loud behavior.
 */
export function toPortable(records: ShardRecord[], exportedAt: string): ShardBundle {
  if (!ISO_DATE.test(exportedAt)) {
    // Caught here rather than at the reader: a bundle its own `fromPortable` would
    // reject is worse than no bundle, and this is the only unvalidated input.
    throw new RangeError(`toPortable expects a YYYY-MM-DD date, got: ${JSON.stringify(exportedAt)}`);
  }
  const shards: PortableShard[] = records
    .filter((r) => r.state === 'approved')
    .map((r) => ({
      v: SHARD_SCHEMA_VERSION,
      id: r.id,
      text: r.text,
      kind: r.kind,
      scope: { type: r.scope.type, key: r.scope.type === 'group' ? r.scope.key : '' },
      author: r.author,
      evidence: {
        distinctPhrasings: r.evidence.distinctPhrasings,
        firstSeen: r.evidence.firstSeen,
        lastSeen: r.evidence.lastSeen,
      },
    }))
    .sort(byId);
  return { v: SHARD_SCHEMA_VERSION, exportedAt, shards };
}

/**
 * `''` is a legal date here: src/shards/record.ts:84-85 yields an empty range when a
 * record's contributing sessions were all undated, and dropping such a record on
 * import would be a silent data loss for a shape the local pipeline itself produces.
 */
const dateSchema = z.union([z.string().regex(ISO_DATE), z.literal('')]);

/**
 * `strictObject`, not `object`: zod's default silently STRIPS unknown keys (verified
 * against the installed 4.4.3), so a bundle carrying a field this version does not
 * understand would import as if it had never had it. Pre-1.0 exports are explicitly
 * disposable, and a loud failure beats a silently mangled import.
 *
 * The text band is the one `mine()` enforces locally. Without it, import is the one
 * unbounded path into the store — and an approved shard is injected into every agent
 * task through `get_shards` (src/mcp.ts:54-73), so an oversized one is a context tax
 * on every future task, not a one-off.
 */
const portableShardSchema = z.strictObject({
  v: z.literal(SHARD_SCHEMA_VERSION),
  id: z.string().regex(SHARD_ID),
  text: z.string().min(MIN_TEXT_LENGTH).max(MAX_TEXT_LENGTH),
  kind: z.enum(['instruction', 'information']),
  // Every member of ShardScope['type'], restated. Widening the TypeScript union does
  // NOT widen this runtime enum and typecheck flags nothing — leaving 'group' out here
  // would produce bundles that `fromPortable` rejects with `scope.type: invalid`, i.e.
  // an export your own reader cannot read.
  scope: z.strictObject({ type: z.enum(['repo', 'group', 'workflow']), key: z.string() }),
  author: z.string().min(1),
  evidence: z.strictObject({
    distinctPhrasings: z.number().int().nonnegative(),
    firstSeen: dateSchema,
    lastSeen: dateSchema,
  }),
});

const bundleSchema = z.strictObject({
  v: z.literal(SHARD_SCHEMA_VERSION),
  exportedAt: dateSchema,
  shards: z.array(portableShardSchema),
});

/** One line naming the first offending field. A raw ZodError message is a multi-line JSON dump. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognized shape';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Validate a parsed bundle and hand back its shards. Throws `PortableFormatError`.
 *
 * Two layers, because the schema alone is not enough. `id` is the merge key and the
 * store's primary key, and an incoming bundle is by definition from another machine:
 * a peer (or a truncated file) can present an `id` that does not match its `text`.
 * That would fragment merge clusters and leave the store disagreeing with
 * `fingerprint(normalizeText(text))` forever, so identity is RECOMPUTED rather than
 * trusted. This is cheap — one sha256 per shard — and it is the whole value of a
 * content-addressed id.
 */
export function fromPortable(bundle: unknown): PortableShard[] {
  const parsed = bundleSchema.safeParse(bundle);
  if (!parsed.success) throw new PortableFormatError(firstIssue(parsed.error));
  for (const shard of parsed.data.shards) {
    const derived = fingerprint(normalizeText(shard.text));
    if (derived !== shard.id) {
      throw new PortableFormatError(`shard id does not match its text (expected ${derived}, got ${shard.id})`);
    }
  }
  return parsed.data.shards;
}

/** One content-addressed fact, with every author who independently produced it. */
export interface MergedShard {
  id: string;
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  /** Every author who independently produced this shard. Sorted, deduplicated. */
  authors: string[];
  /** Summed across authors — retained for display, never used as the quorum signal. */
  totalPhrasings: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Sorted and deduplicated. One author contributing five records appears once —
 * otherwise a single verbose contributor manufactures a quorum, the exact failure
 * that made raw volume counting unusable.
 *
 * Dedupe folds case; the retained spelling is the first in plain lexicographic order,
 * so the result does not depend on arrival order. Git identities are effectively
 * case-insensitive in practice, and counting `Dev@x.com` and `dev@x.com` as two
 * authors would inflate a quorum by exactly the amount the metric exists to prevent.
 */
function distinctAuthors(authors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const author of [...authors].sort()) {
    const key = author.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(author);
  }
  return out;
}

/**
 * Widen on any disagreement. A repo/workflow conflict widens because, by the Phase 1
 * derivation rule (src/shards/mine.ts:151-156), a fact two people hit in unrelated
 * containers is a fact about how they work rather than about a codebase. Two DIFFERENT
 * repo keys widen for the same reason — the spec does not name that case, but "same
 * fact, different repos" is precisely what `workflow` means.
 *
 * Two different GROUP names widen for the third variant of the same reason: a group is
 * one person's declared grouping of their own repos, and two people who grouped a fact
 * differently have agreed only that it is not about a single codebase.
 *
 * The widened key is `''`, matching `deriveScope` (src/shards/mine.ts:152). Keeping
 * either author's key would be a path from someone else's machine.
 */
function widenScope(scopes: ShardScope[]): ShardScope {
  const first = scopes[0];
  if (!first) return { type: 'workflow', key: '' };
  for (const scope of scopes) {
    if (scope.type !== first.type || scope.key !== first.key) return { type: 'workflow', key: '' };
  }
  return { type: first.type, key: first.key };
}

/**
 * Union a date range. 'YYYY-MM-DD' sorts lexicographically in calendar order, so this
 * is string min/max — never `Date` parsing, which reintroduces timezone drift.
 *
 * `''` (an undated record, src/shards/record.ts:84-85) is skipped rather than compared:
 * the empty string sorts before every real date and would otherwise always win `min`,
 * erasing a known firstSeen because one contributor happened to have no dates.
 */
function unionDates(dates: string[], pick: 'min' | 'max'): string {
  let best = '';
  for (const date of dates) {
    if (!date) continue;
    if (!best || (pick === 'min' ? date < best : date > best)) best = date;
  }
  return best;
}

function mergeGroup(id: string, group: PortableShard[]): MergedShard {
  // Two authors can share an id while differing in `text` case: `fingerprint` folds
  // case but the stored text preserves it (src/shards/record.ts:19-27). Same for a
  // `kind` disagreement. Neither is resolvable mechanically — which spelling is
  // "right" is a triage judgment — so both take the lexicographic minimum purely to
  // guarantee the one property that IS mechanical: input order cannot change output.
  const texts = group.map((s) => s.text).sort();
  const kinds = group.map((s) => s.kind).sort();
  return {
    id,
    text: texts[0]!,
    kind: kinds[0]!,
    scope: widenScope(group.map((s) => s.scope)),
    authors: distinctAuthors(group.map((s) => s.author)),
    totalPhrasings: group.reduce((sum, s) => sum + s.evidence.distinctPhrasings, 0),
    firstSeen: unionDates(
      group.map((s) => s.evidence.firstSeen),
      'min',
    ),
    lastSeen: unionDates(
      group.map((s) => s.evidence.lastSeen),
      'max',
    ),
  };
}

/**
 * Cluster portable shards by content-addressed identity.
 *
 * Pure: no I/O, no clock, no randomness, and input order must not affect output —
 * that property is the whole point, because it lets a caller concatenate sets from
 * any transport in any arrival order and just call this. It is used even when the set
 * contains only your own records, which is what makes a future transport a
 * concat-then-call rather than a rewrite.
 *
 * The merge key is `id`, so two authors who phrase a fact identically merge
 * automatically and two who paraphrase do not. That is a KNOWN LIMIT, not an
 * oversight: five authors saying one thing five ways score 1 each rather than 5.
 * Clustering paraphrases is an LLM judgment and belongs to the `/shards` triage skill,
 * run over the merged set — a Phase 6 dependency, and only worth solving if
 * multi-author data ever actually arrives.
 */
export function merge(shards: PortableShard[]): MergedShard[] {
  const groups = new Map<string, PortableShard[]>();
  for (const shard of shards) {
    const group = groups.get(shard.id);
    if (group) group.push(shard);
    else groups.set(shard.id, [shard]);
  }
  const merged: MergedShard[] = [];
  for (const [id, group] of groups) merged.push(mergeGroup(id, group));
  // Map iteration is insertion-ordered, i.e. arrival-ordered. Sorting is what makes
  // the purity assertion hold and keeps a diff-based transport's history clean.
  return merged.sort(byId);
}

/**
 * Turn a merged shard into a local record ready for `upsertCandidates`.
 *
 * `state` is always `candidate` and `snoozedUntil` always null (`buildRecord`'s
 * defaults). Importing is not consent: the recipient triages with `/shards` like any
 * other candidate, and nothing imported can reach an agent until they approve it
 * locally (`activeShardsFor` filters to `approved`).
 *
 * `alwaysOn` comes from the LOCAL row or is false. It is not on the wire, and a bundle
 * could not set it even if it were: bypassing your topic matcher is a claim on your
 * attention, and no other author gets to make it for you.
 *
 * `local` is the row already in the store, and passing it is NOT optional politeness.
 * `upsertCandidates`'s ON CONFLICT overwrites `evidence` wholesale
 * (src/shards/store.ts:139), and the wire format carries no `sessions` — so importing
 * a bundle without merging first would replace a local row's real session paths with
 * `[]`. That is the difference between "import your own export is a no-op" and "import
 * your own export destroys your evidence".
 *
 * `distinctPhrasings` takes the MAX rather than the sum, because import is not
 * transactional: re-importing the same bundle must not inflate the count. That count
 * is the baseline `shouldResurface` compares against (src/shards/triage.ts:65-71), so
 * an inflating value would permanently suppress a snoozed shard.
 *
 * The local row's `scope`, `kind`, and `author` win when there is one. The store keeps
 * a single `author` column and its ON CONFLICT does not update it, so multi-author
 * accumulation lives ONLY in `merge()` over an in-memory bundle set — `quorum` is a
 * function of the bundles you hold, never of this database. A future reader looking
 * for an `authors` column will not find one, by design.
 */
export function toRecord(shard: MergedShard, local?: ShardRecord): ShardRecord {
  return buildRecord({
    text: shard.text,
    kind: local?.kind ?? shard.kind,
    scope: local?.scope ?? shard.scope,
    author: local?.author ?? shard.authors[0] ?? 'unknown',
    sessions: local?.evidence.sessions ?? [],
    dates: [local?.evidence.firstSeen ?? '', local?.evidence.lastSeen ?? '', shard.firstSeen, shard.lastSeen],
    distinctPhrasings: Math.max(local?.evidence.distinctPhrasings ?? 0, shard.totalPhrasings),
    alwaysOn: local?.alwaysOn ?? false,
  });
}
