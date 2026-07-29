// The v1 memory record: a portable, self-contained document describing one
// durable fact a user has told an agent. Everything here is deterministic —
// no field requires a judgment call, so a record can be rebuilt byte-identically
// from the same transcripts on any machine.
//
// Two fields exist in Phase 1 despite having no consumer until Phase 4:
// `id` (content-addressed) and `author`. Both are unrepairable retroactively —
// an id assigned later would not match one assigned now, and the author of a
// backfilled record cannot be recovered once the machine changes hands.

/** Bumped only when the on-disk memory shape changes. A mismatch migrates; it never drops. */
export const MEMORY_SCHEMA_VERSION = 1;

export type MemoryKind = 'instruction' | 'information';
/**
 * `merged` is not a triage verdict. It marks a record whose text was judged a
 * paraphrase of another record's, so its evidence now lives on that canonical row
 * and it must never be emitted, exported, or retrieved on its own. See `mergeInto`
 * in src/memory/triage.ts for why the state exists at all.
 */
export type MemoryState = 'candidate' | 'approved' | 'rejected' | 'snoozed' | 'merged';

export interface MemoryScope {
  /**
   * 'repo' — confined to one repo container; 'group' — a named set of containers a
   * human declared related; 'workflow' — spans unrelated containers.
   *
   * 'group' is the one tier that cannot be derived. Phase 1's spread heuristic
   * (src/memory/mine.ts:151-156) can tell "seen in one container" from "seen in
   * several", but not "these four repos share a convention" from "this is universal" —
   * that needs a grouping the index does not have, which is why groups are assigned at
   * triage and resolved against configured path globs (src/memory/groups.ts).
   */
  type: 'repo' | 'group' | 'workflow';
  /**
   * Repo container path for 'repo'; the group NAME for 'group'; empty string for
   * 'workflow'. The group key is the only scope key that is not a local path, which is
   * why it is the only one that survives export (src/memory/portable.ts:83-99).
   */
  key: string;
}

export interface MemoryEvidence {
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

export interface MemoryRecord {
  v: number;
  /** `sha256:<hex>` over the normalized text — stable across runs and machines. */
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  /** git user.email, or 'unknown' when git is unavailable. */
  author: string;
  evidence: MemoryEvidence;
  state: MemoryState;
  /** 'YYYY-MM-DD' or null. */
  snoozedUntil: string | null;
  /**
   * Bypass topic matching: an always-on memory is returned for every topic.
   *
   * It bypasses ONLY the matcher. State and scope still apply — an always-on memory
   * that is rejected, snoozed, or scoped to a repo you are not in is still not
   * returned (src/memory/retrieve.ts). "Always" means "regardless of what you said
   * you were about to work on", not "unconditionally".
   *
   * This is the safety valve for topic-conditional retrieval: a topic string that
   * happens to share no words with a standing constraint would otherwise suppress it,
   * and the failure is silent — the agent simply never sees the rule.
   */
  alwaysOn: boolean;
  /**
   * The canonical record this one was merged into, or null when it stands alone.
   *
   * Set together with `state: 'merged'` and never on its own. It exists so a merge is
   * auditable and reversible rather than a silent deletion: the absorbed row keeps its
   * own text and id, which is what lets a future re-mine recognize the phrasing as
   * already accounted for instead of proposing it again.
   */
  mergedInto: string | null;
}

/**
 * A memory as it crosses the process boundary — no local paths, no raw prompts.
 *
 * Four fields of `MemoryRecord` are deliberately absent, and each omission is a
 * privacy or a correctness decision rather than a size one (see src/memory/portable.ts):
 *  - `state` / `snoozedUntil`: your triage decisions about your own attention. A
 *    recipient imports the fact, not your opinion of it, and triages for themselves.
 *  - `alwaysOn`: the same category. Whether a fact is important enough to bypass your
 *    topic matcher is a judgment about YOUR attention budget, and it arrives as a
 *    candidate anyway — nothing imported can reach an agent until you approve it.
 *  - `evidence.sessions`: local filesystem paths, which disclose directory structure
 *    and project names and mean nothing on another machine.
 * `scope.key` is declared here because the shape is part of the format. It is blanked
 * on export for `repo` — an absolute container path — but PRESERVED for `group`, where
 * the key is a human-chosen name that carries the entire meaning and discloses nothing
 * about this machine's directory layout.
 */
export interface PortableMemory {
  v: number;
  /** `sha256:<hex>` — content-addressed, so identity survives transport. */
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  author: string;
  /** Local session paths deliberately omitted. */
  evidence: {
    distinctPhrasings: number;
    firstSeen: string;
    lastSeen: string;
  };
}

/** The file envelope. Versioned so a reader can reject drift instead of guessing. */
export interface MemoryBundle {
  v: number;
  /** 'YYYY-MM-DD'. Injected by the caller, never read from the clock here. */
  exportedAt: string;
  /** Sorted by id, so two exports of the same set are byte-identical. */
  memories: PortableMemory[];
}
