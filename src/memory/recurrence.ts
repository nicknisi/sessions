// Recurrence matching: compare freshly mined corrective clusters against the memory
// store and classify what recurs. Phase 2 of docs/ideation/memory-recurrence/.
//
// This module is PURE and imports no store, no index, no clock — same constraint
// src/memory/topic.ts:1-8 ships under, and for the same reason: recurrence.test.ts
// drives it with hand-built records and no tmpdir harness, and the report's output
// must be byte-reproducible from the same inputs (the no-LLM invariant the contract
// asserts). Callers pass dates; nothing here reads one.
//
// Tokenizer decision: the spec offered a new `tokenize` export from record.ts "if
// normalization tokenization isn't already reusable". It IS reusable — topic.ts's
// `tokenize` (lowercase, unicode61-shaped split, function-word stopwords, suffix
// stem) already matches the index's token shape and imports nothing, so this file
// reuses it rather than shipping a third subtly-different tokenizer next to
// topic.ts:126 and sources.ts's inline split. Exact matching, the other half, goes
// through record.ts's `fingerprint` so a recurrence pair and a content-addressed id
// see the same text shape.

import { fingerprint } from './record';
import { tokenize } from './topic';
import type { MemoryRecord } from './types';

/**
 * >= asserts a match: the cluster IS the approved memory, and post-`lastSeen`
 * evidence becomes a violation. 0.7 over stemmed Jaccard is deliberately high —
 * the worst output this feature can produce is a false violation pairing ("don't
 * commit" ~ "don't push"), which reports a working memory as failing. Under-reporting
 * is the cheap direction: a missed paraphrase still shows up in the mine's candidate
 * batch, while a false pairing erodes trust in the whole report.
 */
export const SIMILARITY_ASSERT = 0.7;

/**
 * >= emits a fuzzy candidate: a possible paraphrase of an approved memory, routed to
 * the triage skill for confirmation rather than asserted. The band boundary is where
 * assertion stops — paraphrase judgment is the skill's job by contract, not because
 * the binary cannot compute a number between 0.45 and 0.7.
 */
export const SIMILARITY_FUZZY = 0.45;

/**
 * Below this many tokens on EITHER side, similarity is not computed at all (exact
 * equality still asserts). Same floor sources.ts:736-739 applies, for the same
 * reason: two-token corrections share vocabulary, not meaning — "don't commit" and
 * "don't push" tokenize to singletons after stopword removal, and any overlap score
 * over sets that small is noise dressed as signal.
 */
export const MIN_SIMILARITY_TOKENS = 3;

/** A repeat needs >=2 distinct sessions AND >=2 distinct dates — both, not either. */
export const REPEAT_MIN_SESSIONS = 2;

/** A cluster/member pair with its score. `similarity` is 1 for an exact match. */
export interface RecurrenceMatch {
  memory: MemoryRecord;
  cluster: MemoryRecord;
  similarity: number;
  /** Cluster sessions — the re-occurrence evidence. */
  sessions: string[];
  /** Cluster `evidence.lastSeen`; the evidence carries no per-session dates. */
  latestDate: string;
}

/** An approved memory still being re-corrected after the store last saw it. */
export interface RecurrenceViolation extends RecurrenceMatch {}

/** A correction repeated across sessions that no approved memory covers. */
export interface RecurrenceRepeat {
  cluster: MemoryRecord;
  sessions: string[];
  firstDate: string;
  latestDate: string;
  /** Set when the repeat matches a `candidate` memory — a repeat the store already
   *  knows about but nobody has triaged. NOT a violation: only approved memories
   *  carry a verdict to violate. */
  candidateId?: string;
}

/** A possible paraphrase of an approved memory, below the assert threshold. */
export interface RecurrenceFuzzy extends RecurrenceMatch {}

/** One violation row compared against the previous snapshot (snapshots.ts). */
export interface RecurrenceTrend {
  /** The violated memory's content-addressed id — stable across re-mines. */
  id: string;
  /** Current violation count: the session count the VIOLATIONS row prints. */
  violations: number;
  /** The previous snapshot's count for this id, or null on first sighting. */
  previous: number | null;
  /** `violations − previous`; null when previous is null (renders `(new)`). */
  delta: number | null;
}

export interface RecurrenceReport {
  violations: RecurrenceViolation[];
  repeats: RecurrenceRepeat[];
  fuzzy: RecurrenceFuzzy[];
  /**
   * classifyRecurrence emits this EMPTY on purpose: reading the previous
   * snapshot is I/O, and this module's purity contract (header) refuses it.
   * report.ts fills it via snapshots.ts after classifying.
   */
  trend: RecurrenceTrend[];
}

export interface RecurrenceOptions {
  /**
   * Drop clusters whose evidence ends before this 'YYYY-MM-DD' date. The spec lists
   * `--since` without defining it; scoped here to cluster evidence dates (the only
   * dates a report run controls) rather than to memory dates, which would hide
   * violations against old memories — exactly the ones the report exists to surface.
   */
  since?: string;
}

/**
 * Jaccard similarity `|A ∩ B| / |A ∪ B|` over token sets, in [0, 1].
 *
 * Returns 0 when either set is empty. 0/0 is NaN, and `NaN >= SIMILARITY_FUZZY` is
 * false, so two stopword-only texts would silently never pair — the right answer,
 * but by accident. The explicit guard makes it the right answer on purpose (the
 * abstention pattern topic.ts:142-148 documents).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits++;
  }
  return hits / (a.size + b.size - hits);
}

/**
 * Exact normalized-text equality, via the content-addressed id: two texts pair
 * exactly iff their fingerprints match (record.ts:31-35). Exact always asserts,
 * regardless of token overlap or the token floor.
 */
function isExact(a: MemoryRecord, b: MemoryRecord): boolean {
  return a.id === b.id || fingerprint(a.text) === fingerprint(b.text);
}

/** Best similarity score of `cluster` against `memory`: 1 exact, else Jaccard or 0. */
function matchScore(cluster: MemoryRecord, memory: MemoryRecord, clusterTokens: Set<string>, memoryTokens: Set<string>): number {
  if (isExact(cluster, memory)) return 1;
  if (clusterTokens.size < MIN_SIMILARITY_TOKENS || memoryTokens.size < MIN_SIMILARITY_TOKENS) return 0;
  return jaccard(clusterTokens, memoryTokens);
}

function toMatch(memory: MemoryRecord, cluster: MemoryRecord, similarity: number): RecurrenceMatch {
  return {
    memory,
    cluster,
    similarity,
    sessions: cluster.evidence.sessions,
    latestDate: cluster.evidence.lastSeen,
  };
}

/**
 * Classify mined clusters against the memory store.
 *
 * Precedence per cluster: violation, then fuzzy, then repeat. A cluster that pairs
 * with an approved memory is accounted for by that pairing — listing it again as an
 * untriaged repeat would double-count one signal in two sections.
 *
 * Violation dating is a PROXY: the store keeps no approval timestamp, so "kept
 * happening after it was known" is approximated by `cluster.lastSeen >
 * memory.evidence.lastSeen` — a plain string comparison over day-granularity
 * 'YYYY-MM-DD' dates (record.ts:78-84). Two accepted consequences, named here per
 * the spec: a match entirely within the memory's own evidence window is mining
 * residue, not recurrence; and a same-day re-violation is invisible, because
 * "strictly after" cannot see inside a day.
 *
 * Determinism: every section is sorted by session count desc, then cluster id —
 * never by Map iteration order or input order accidentals.
 */
export function classifyRecurrence(
  clusters: MemoryRecord[],
  memories: MemoryRecord[],
  opts: RecurrenceOptions = {},
): RecurrenceReport {
  const approved = memories.filter((m) => m.state === 'approved');
  const candidates = memories.filter((m) => m.state === 'candidate');
  // Token sets are computed once per record, not once per pair.
  const memoryTokens = new Map<string, Set<string>>(memories.map((m) => [m.id, tokenize(m.text)]));

  const violations: RecurrenceViolation[] = [];
  const repeats: RecurrenceRepeat[] = [];
  const fuzzy: RecurrenceFuzzy[] = [];

  for (const cluster of clusters) {
    if (opts.since && cluster.evidence.lastSeen < opts.since) continue;
    const clusterTokens = tokenize(cluster.text);

    // Best-scoring approved memory, if any asserts.
    let bestApproved: { memory: MemoryRecord; score: number } | undefined;
    let bestFuzzy: { memory: MemoryRecord; score: number } | undefined;
    for (const memory of approved) {
      const score = matchScore(cluster, memory, clusterTokens, memoryTokens.get(memory.id)!);
      if (score >= SIMILARITY_ASSERT) {
        if (!bestApproved || score > bestApproved.score) bestApproved = { memory, score };
      } else if (score >= SIMILARITY_FUZZY) {
        if (!bestFuzzy || score > bestFuzzy.score) bestFuzzy = { memory, score };
      }
    }

    if (bestApproved) {
      // Within the memory's own evidence window this is residue, not recurrence —
      // the cluster is consumed either way and never falls through to repeats.
      if (cluster.evidence.lastSeen > bestApproved.memory.evidence.lastSeen) {
        violations.push(toMatch(bestApproved.memory, cluster, bestApproved.score));
      }
      continue;
    }
    if (bestFuzzy) {
      fuzzy.push(toMatch(bestFuzzy.memory, cluster, bestFuzzy.score));
      continue;
    }

    // Repeat: >=2 distinct sessions AND >=2 distinct dates. The mine's evidence
    // carries only firstSeen/lastSeen, so "two distinct dates" is firstSeen !==
    // lastSeen — a cluster spanning three dates and one spanning two are
    // indistinguishable here, and both clear the bar.
    const sessions = new Set(cluster.evidence.sessions);
    if (sessions.size < REPEAT_MIN_SESSIONS) continue;
    if (cluster.evidence.firstSeen === cluster.evidence.lastSeen) continue;

    let candidateId: string | undefined;
    for (const candidate of candidates) {
      const score = matchScore(cluster, candidate, clusterTokens, memoryTokens.get(candidate.id)!);
      if (score >= SIMILARITY_ASSERT) {
        candidateId = candidate.id;
        break;
      }
    }
    repeats.push({
      cluster,
      sessions: cluster.evidence.sessions,
      firstDate: cluster.evidence.firstSeen,
      latestDate: cluster.evidence.lastSeen,
      ...(candidateId ? { candidateId } : {}),
    });
  }

  const byCountThenId = <T extends { sessions: string[]; cluster: MemoryRecord }>(a: T, b: T): number =>
    b.sessions.length - a.sessions.length || a.cluster.id.localeCompare(b.cluster.id);
  violations.sort(byCountThenId);
  repeats.sort(byCountThenId);
  fuzzy.sort((a, b) => b.similarity - a.similarity || byCountThenId(a, b));

  return { violations, repeats, fuzzy, trend: [] };
}
