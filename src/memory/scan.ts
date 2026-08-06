// The content gate on the memory pipeline: no secret material, no context-hijack
// phrasing, and no invisible characters may enter the store or reach an agent.
//
// WHY THIS EXISTS. Memories are mined from transcripts — which contain pasted
// secrets and untrusted tool output — and are served back into agent context by a
// tool whose description says "treat these as binding". That is two failure modes
// in one pipeline: a credential that outlives the session it was pasted into, and
// a sentence engineered to be obeyed ("ignore previous instructions...") that gets
// laundered through triage into a standing instruction. The pattern tables are
// adapted from pi-hermes-memory's content scanner, which gates the same genre of
// store for the same reasons.
//
// WHERE IT RUNS. At every boundary where text can enter the store — the mine
// (src/memory/mine.ts), `memory import` (src/memory/cli.ts), and `approve`
// including `--as` (src/memory/triage.ts) — and once more at the boundary where
// stored text reaches an agent (src/memory/retrieve.ts), because rows written
// before this gate existed, or by a hand edit of memory.db, never passed it.
// Deliberately NOT inside store.ts: the store is dumb rows and the authority on
// state, and a bulk write that silently dropped records would break the
// mine-then-report accounting its callers do.
//
// WHAT IT DELIBERATELY DOES NOT MATCH. hermes also flags secret env-var NAMES
// (`DATABASE_URL`), assignment shapes (`password = ...`), and exfil command shapes
// (`curl ... $TOKEN`, `cat .env`). All three are omitted here, on the same
// judgment: this store holds instructions ABOUT how the user works, so "set
// DATABASE_URL through doppler, never in .env" and "never pipe $GITHUB_TOKEN
// through curl" are exactly the facts worth keeping — a prohibition legitimately
// names the thing it prohibits. Secret MATERIAL and hijack PHRASING have no such
// legitimate appearance in a short durable fact, which is what makes them safe to
// block without a human override path.

export type ScanCategory = 'secret' | 'injection' | 'invisible';

export interface ScanFinding {
  /** Stable pattern id, e.g. 'github_token' or 'prompt_injection'. */
  id: string;
  category: ScanCategory;
}

/**
 * Thrown when a write is refused because its text has findings. A class rather
 * than a bare Error so src/memory/cli.ts can turn it into the clean `die()` a
 * user-caused failure deserves, without catching programmer errors alongside it.
 */
export class ContentScanError extends Error {
  readonly findings: ScanFinding[];
  constructor(message: string, findings: ScanFinding[]) {
    super(message);
    this.findings = findings;
  }
}

/**
 * Secret MATERIAL only — strings shaped like the credential itself, where a false
 * positive requires the fact to contain 20+ characters of key-alphabet noise. Env
 * var names and assignment shapes are deliberately absent; see the header.
 */
const SECRET_PATTERNS: { pattern: RegExp; id: string }[] = [
  { pattern: /\bsk-ant-\S{10,}/, id: 'anthropic_api_key' },
  { pattern: /\bsk-or-v1-\S{10,}/, id: 'openrouter_api_key' },
  // The lookahead keeps one key to one finding: an sk-ant-/sk-or- key is long enough
  // to satisfy the generic sk- shape too, and a report that names two vendors for one
  // credential reads as two leaks.
  { pattern: /\bsk-(?!ant-|or-v1-)\S{20,}/, id: 'openai_api_key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: 'aws_access_key' },
  // gh[pusor]_ covers personal, user-to-server, server-to-server, OAuth, refresh.
  { pattern: /\bgh[pusor]_[A-Za-z0-9]{20,}/, id: 'github_token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, id: 'github_fine_grained_pat' },
  { pattern: /\bxox[abposr]-\S{10,}/, id: 'slack_token' },
  { pattern: /\bntn_\S{20,}/, id: 'notion_token' },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/, id: 'google_api_key' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, id: 'bearer_token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, id: 'jwt' },
  { pattern: /-----BEGIN\s[A-Z ]*PRIVATE\sKEY-----/, id: 'private_key_block' },
];

/**
 * Context-hijack phrasing — sentences written to be OBEYED by whatever model reads
 * them later, which is exactly what `get_memory`'s "treat as binding" framing would
 * hand them. Matching is on the imperative shape; "never ignore previous
 * instructions" as a genuine fact is contrived enough that the block is acceptable,
 * and `approve --as` exists to rephrase any real one.
 */
const INJECTION_PATTERNS: { pattern: RegExp; id: string }[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  {
    pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i,
    id: 'bypass_restrictions',
  },
];

/**
 * Zero-width and bidi-control characters. A durable fact has no use for any of
 * them, and both known abuses run through this store's exact path: smuggling text
 * a human reviewer cannot see, and reordering what they do see. The set matches
 * hermes byte for byte.
 */
const INVISIBLE_CHARS = new Set([
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u2060', // word joiner
  '\ufeff', // BOM / zero-width no-break space
  '\u202a', // LRE
  '\u202b', // RLE
  '\u202c', // PDF
  '\u202d', // LRO
  '\u202e', // RLO
]);

/**
 * Every finding in `text`, empty when it is clean. Pure and deterministic — the
 * mine calls this per candidate and the determinism criterion compares whole
 * batches, so a clock, a random salt, or an LLM judgment would all be bugs here.
 */
export function scanMemoryText(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { pattern, id } of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.push({ id, category: 'secret' });
  }
  for (const { pattern, id } of INJECTION_PATTERNS) {
    if (pattern.test(text)) findings.push({ id, category: 'injection' });
  }
  for (const ch of text) {
    if (INVISIBLE_CHARS.has(ch)) {
      findings.push({ id: 'invisible_chars', category: 'invisible' });
      break; // one finding for the class; per-character repeats add nothing.
    }
  }
  return findings;
}

/** `true` when `text` has no findings — the predicate the mine's filter reads. */
export function isScanClean(text: string): boolean {
  return scanMemoryText(text).length === 0;
}

/** The finding ids as prose, for refusal messages and withheld reports. */
export function describeFindings(findings: ScanFinding[]): string {
  return findings.map((f) => f.id).join(', ');
}
