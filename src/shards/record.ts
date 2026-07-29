// Normalization, content-addressed fingerprinting, and deterministic record
// construction. Everything in this file must be a pure function of its inputs
// (gitAuthorEmail excepted, which reads the machine's git identity once), because
// the determinism criterion asserts full-record JSON equality across two runs —
// not just id equality.

import {
  SHARD_SCHEMA_VERSION,
  type ShardEvidence,
  type ShardKind,
  type ShardRecord,
  type ShardScope,
  type ShardState,
} from './types';

/** 'YYYY-MM-DD'. The index stores '?' for an undated transcript, which must never reach a record. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Collapse every whitespace run to a single space and trim. Casing is preserved —
 * the stored `text` is what a human reads back, so "Never commit to main" must not
 * become "never commit to main". Case folding happens inside `fingerprint`, so two
 * records differing only in case still collapse to one id.
 */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Content-addressed identity: `sha256:<hex>` over the case-folded normalized text.
 * Bun.CryptoHasher is built in, so this adds no dependency to a binary that
 * deliberately ships with two.
 */
export function fingerprint(normalized: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(normalized.toLowerCase());
  return `sha256:${hasher.digest('hex')}`;
}

/**
 * The machine's git identity, or 'unknown'. A missing identity must not block
 * mining — `git config user.email` exits non-zero with empty output when no
 * global config exists, and `git` may be absent entirely. Same swallow-to-a-value
 * shape as src/repo.ts:14-22.
 */
export function gitAuthorEmail(): string {
  try {
    const result = Bun.spawnSync(['git', 'config', 'user.email']);
    if (result.exitCode !== 0) return 'unknown';
    const email = new TextDecoder().decode(result.stdout).trim();
    return email || 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface BuildRecordInput {
  /** Raw source text; normalized (and fingerprinted) here, never by the caller. */
  text: string;
  kind?: ShardKind;
  scope: ShardScope;
  author: string;
  /** Contributing session file paths, in any order — deduped and sorted here. */
  sessions: string[];
  /** 'YYYY-MM-DD' dates of the contributing sessions, in any order. */
  dates: string[];
  /** Distinct phrasings after byte-exact collapse. Always 1 in Phase 1. */
  distinctPhrasings: number;
  state?: ShardState;
  snoozedUntil?: string | null;
}

function buildEvidence(input: BuildRecordInput): ShardEvidence {
  // Sorted + deduped: unsorted arrays are the single most likely source of
  // run-to-run byte differences, and two sessions can contribute the same path
  // only through a caller bug — dedupe rather than double-count it.
  const sessions = [...new Set(input.sessions)].sort();
  // String comparison is the correct ordering for 'YYYY-MM-DD'; no Date parsing,
  // no locale formatting, nothing that varies by machine timezone.
  const dates = input.dates.filter((d) => ISO_DATE.test(d)).sort();
  return {
    distinctPhrasings: input.distinctPhrasings,
    sessions,
    firstSeen: dates[0] ?? '',
    lastSeen: dates[dates.length - 1] ?? '',
  };
}

/**
 * Assemble a shard record with a stable field order. Field order matters: the
 * determinism check is `JSON.stringify(run1) === JSON.stringify(run2)`, and
 * JSON.stringify preserves insertion order.
 *
 * `kind` defaults to 'instruction' because the mine narrows on corrective,
 * imperative language. Distinguishing an instruction from a durable piece of
 * information is a judgment call and belongs to the Phase 2 triage skill.
 */
export function buildRecord(input: BuildRecordInput): ShardRecord {
  const text = normalizeText(input.text);
  return {
    v: SHARD_SCHEMA_VERSION,
    id: fingerprint(text),
    text,
    kind: input.kind ?? 'instruction',
    scope: { type: input.scope.type, key: input.scope.key },
    author: input.author,
    evidence: buildEvidence(input),
    state: input.state ?? 'candidate',
    snoozedUntil: input.snoozedUntil ?? null,
  };
}
