/**
 * Recency-weighted significance scoring for the context primer's recent tier.
 * Pure and deterministic — `nowMs` is injected so tests need no clock.
 */

export interface ScorableSession {
  messageCount: number;
  filesTouchedCount: number;
  closingText: string; // closing_user + ' ' + closing_assistant
  createdAt: string; // 'YYYY-MM-DD' or '?'
}

// Tunable knobs — the deliberate magic numbers.
export const HALF_LIFE_DAYS = 7; // recency decay half-life
export const FILES_WEIGHT = 0.5; // per edited file, capped
export const FILES_CAP = 10; // max files counted
export const ARTIFACT_BONUS = 2; // shipped a PR/commit
const LARGE_AGE_DAYS = 36_500; // ~100y: undated rows decay to ~0 (sink)

// A concrete artifact only: a PR/MR URL or a backticked/parenthesized commit
// SHA. "I'll open a PR" (intent) does NOT match; "…/pull/16" and `0f459d3` do.
const ARTIFACT_RE = /\/(?:pull|merge_requests)\/\d+|`[0-9a-f]{7,40}`|\([0-9a-f]{7,40}\)/i;

export function hasArtifact(closingText: string): boolean {
  return ARTIFACT_RE.test(closingText);
}

/** Recency-independent substance: log-damped message volume + capped edits + artifact bonus. */
export function significanceScore(s: ScorableSession): number {
  return (
    Math.log2(s.messageCount + 1) +
    FILES_WEIGHT * Math.min(s.filesTouchedCount, FILES_CAP) +
    (hasArtifact(s.closingText) ? ARTIFACT_BONUS : 0)
  );
}

/** Too thin to earn a detail-tier slot: barely any messages, no edits, no artifact. */
export function isTrivia(s: ScorableSession): boolean {
  return s.messageCount <= 2 && s.filesTouchedCount === 0 && !hasArtifact(s.closingText);
}

/** significance × exponential recency decay (half-life `HALF_LIFE_DAYS`). */
export function blendedScore(s: ScorableSession, nowMs: number): number {
  const parsed = Date.parse(s.createdAt);
  const ageDays = Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 86_400_000) : LARGE_AGE_DAYS;
  return significanceScore(s) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}
