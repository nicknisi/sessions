// The v1 shard record: a portable, self-contained document describing one
// durable fact a user has told an agent. Everything here is deterministic —
// no field requires a judgment call, so a record can be rebuilt byte-identically
// from the same transcripts on any machine.
//
// Two fields exist in Phase 1 despite having no consumer until Phase 4:
// `id` (content-addressed) and `author`. Both are unrepairable retroactively —
// an id assigned later would not match one assigned now, and the author of a
// backfilled record cannot be recovered once the machine changes hands.

/** Bumped only when the on-disk shard shape changes. A mismatch migrates; it never drops. */
export const SHARD_SCHEMA_VERSION = 1;

export type ShardKind = 'instruction' | 'information';
export type ShardState = 'candidate' | 'approved' | 'rejected' | 'snoozed';

export interface ShardScope {
  /** 'repo' — confined to one repo container; 'workflow' — spans unrelated containers. */
  type: 'repo' | 'workflow';
  /** Repo container path for 'repo'; empty string for 'workflow'. */
  key: string;
}

export interface ShardEvidence {
  /**
   * Count of DISTINCT phrasings after byte-exact collapse — never raw occurrences.
   * The name is deliberate: an `occurrences` field would not tell a reader that 14
   * byte-identical copies of one eval fixture prompt count as 1.
   */
  distinctPhrasings: number;
  /** Session file paths the phrasings came from, sorted ascending for determinism. */
  sessions: string[];
  /** 'YYYY-MM-DD' bounds across the contributing sessions. */
  firstSeen: string;
  lastSeen: string;
}

export interface ShardRecord {
  v: number;
  /** `sha256:<hex>` over the normalized text — stable across runs and machines. */
  id: string;
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  /** git user.email, or 'unknown' when git is unavailable. */
  author: string;
  evidence: ShardEvidence;
  state: ShardState;
  /** 'YYYY-MM-DD' or null. */
  snoozedUntil: string | null;
}

/**
 * A shard as it crosses the process boundary — no local paths, no raw prompts.
 *
 * Three fields of `ShardRecord` are deliberately absent, and each omission is a
 * privacy or a correctness decision rather than a size one (see src/shards/portable.ts):
 *  - `state` / `snoozedUntil`: your triage decisions about your own attention. A
 *    recipient imports the fact, not your opinion of it, and triages for themselves.
 *  - `evidence.sessions`: local filesystem paths, which disclose directory structure
 *    and project names and mean nothing on another machine.
 * `scope.key` is declared here because the shape is part of the format, but it is
 * blanked on export for the same reason — it is an absolute container path.
 */
export interface PortableShard {
  v: number;
  /** `sha256:<hex>` — content-addressed, so identity survives transport. */
  id: string;
  text: string;
  kind: ShardKind;
  scope: ShardScope;
  author: string;
  /** Local session paths deliberately omitted. */
  evidence: {
    distinctPhrasings: number;
    firstSeen: string;
    lastSeen: string;
  };
}

/** The file envelope. Versioned so a reader can reject drift instead of guessing. */
export interface ShardBundle {
  v: number;
  /** 'YYYY-MM-DD'. Injected by the caller, never read from the clock here. */
  exportedAt: string;
  /** Sorted by id, so two exports of the same set are byte-identical. */
  shards: PortableShard[];
}
