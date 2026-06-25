// Sessions-owned pricing engine (formerly vendored from tokenmaxing).
//
// Prices each usage event per-token, mirroring LiteLLM's `*_cost_per_token`
// fields exactly. A logged model id is resolved through `find()`:
//   exact key → normalized/fuzzy substring (version-boundary protected).
// The map layers an embedded, build-time LiteLLM snapshot under a small,
// hand-maintained `BUILTIN_OVERRIDES` table for models LiteLLM lags on.
//
// Matching rules mirror ccusage `rust/crates/ccusage/src/pricing.rs`
// (`normalized_pricing_key`, `pricing_key_matches`, `find_entry`). Any model
// that has tokens but no price match is recorded in a drainable warning
// collector and surfaced loudly — never silently zeroed.

import { PRICING as GENERATED_PRICING } from './pricing-data.generated.ts';

export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number; // default: inputPerToken * 0.1
  cacheWritePerToken?: number; // default: inputPerToken * 1.25
  inputPerTokenAbove200k?: number;
  outputPerTokenAbove200k?: number;
  cacheReadPerTokenAbove200k?: number;
  cacheWritePerTokenAbove200k?: number;
}

export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingWarning {
  model: string;
  tokens: number;
}

// ---------------------------------------------------------------------------
// BUILTIN_OVERRIDES — verified rates only (no invented numbers).
//
// Sources:
//   - ccusage `put_builtin_pricing` (rust/crates/ccusage/src/pricing.rs)
//   - ccusage embedded models.dev snapshot (models-dev-pricing.json) for
//     `claude-fable-5` (per-MTok there → divided to per-token here).
// Models the LiteLLM snapshot tends to lag on (newest releases). The embedded
// snapshot is the base; these fill or override entries it lacks.
// ---------------------------------------------------------------------------
export const BUILTIN_OVERRIDES: Record<string, ModelPricing> = {
  // Anthropic — Claude (ccusage put_builtin_pricing)
  'claude-opus-4-8': {
    inputPerToken: 5e-6,
    outputPerToken: 25e-6,
    cacheWritePerToken: 6.25e-6,
    cacheReadPerToken: 0.5e-6,
  },
  'claude-opus-4-7': {
    inputPerToken: 5e-6,
    outputPerToken: 25e-6,
    cacheWritePerToken: 6.25e-6,
    cacheReadPerToken: 0.5e-6,
  },
  'claude-opus-4-6': {
    inputPerToken: 5e-6,
    outputPerToken: 25e-6,
    cacheWritePerToken: 6.25e-6,
    cacheReadPerToken: 0.5e-6,
  },
  'claude-opus-4-5': {
    inputPerToken: 5e-6,
    outputPerToken: 25e-6,
    cacheWritePerToken: 6.25e-6,
    cacheReadPerToken: 0.5e-6,
  },
  // Legacy Opus 4 — kept so the version-boundary rule has a distinct, cheaper
  // target (claude-opus-4 must never resolve to the 4-8 rate).
  'claude-opus-4': {
    inputPerToken: 15e-6,
    outputPerToken: 75e-6,
    cacheWritePerToken: 18.75e-6,
    cacheReadPerToken: 1.5e-6,
  },
  'claude-sonnet-4-6': {
    inputPerToken: 3e-6,
    outputPerToken: 15e-6,
    cacheWritePerToken: 3.75e-6,
    cacheReadPerToken: 0.3e-6,
  },
  'claude-haiku-4-5': {
    inputPerToken: 1e-6,
    outputPerToken: 5e-6,
    cacheWritePerToken: 1.25e-6,
    cacheReadPerToken: 0.1e-6,
  },
  // claude-fable-5 (ccusage embedded models.dev snapshot; per-MTok → per-token)
  'claude-fable-5': {
    inputPerToken: 10e-6,
    outputPerToken: 50e-6,
    cacheWritePerToken: 12.5e-6,
    cacheReadPerToken: 1e-6,
  },

  // OpenAI — Codex / GPT (ccusage put_builtin_pricing)
  'gpt-5.5': {
    inputPerToken: 5e-6,
    outputPerToken: 30e-6,
    cacheWritePerToken: 5e-6,
    cacheReadPerToken: 0.5e-6,
  },
  'gpt-5.4': {
    inputPerToken: 2.5e-6,
    outputPerToken: 15e-6,
    cacheWritePerToken: 2.5e-6,
    cacheReadPerToken: 0.25e-6,
  },
};

// Embedded snapshot is the base; BUILTIN_OVERRIDES fills/overrides entries the
// snapshot lacks. (Phase 2 will merge a live fetch over the top — live wins.)
const PRICING_MAP: Record<string, ModelPricing> = { ...GENERATED_PRICING, ...BUILTIN_OVERRIDES };

// ---------------------------------------------------------------------------
// LiteLLM parsing — shared with the build-time generator (and Phase 2).
// LiteLLM fields are already per single token, so they map across directly.
// Cache defaults are applied lazily in computeCost, not here, so the snapshot
// stays a near-direct copy of LiteLLM.
// ---------------------------------------------------------------------------
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseLiteLLMPricing(json: string): Record<string, ModelPricing> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object') return {};

  const out: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const e = value as LiteLLMEntry;
    // Require both input and output per-token rates; skip specs/embeddings/etc.
    if (!isFiniteNumber(e.input_cost_per_token) || !isFiniteNumber(e.output_cost_per_token)) continue;

    const pricing: ModelPricing = {
      inputPerToken: e.input_cost_per_token,
      outputPerToken: e.output_cost_per_token,
    };
    if (isFiniteNumber(e.cache_read_input_token_cost)) pricing.cacheReadPerToken = e.cache_read_input_token_cost;
    if (isFiniteNumber(e.cache_creation_input_token_cost))
      pricing.cacheWritePerToken = e.cache_creation_input_token_cost;
    if (isFiniteNumber(e.input_cost_per_token_above_200k_tokens))
      pricing.inputPerTokenAbove200k = e.input_cost_per_token_above_200k_tokens;
    if (isFiniteNumber(e.output_cost_per_token_above_200k_tokens))
      pricing.outputPerTokenAbove200k = e.output_cost_per_token_above_200k_tokens;
    if (isFiniteNumber(e.cache_read_input_token_cost_above_200k_tokens))
      pricing.cacheReadPerTokenAbove200k = e.cache_read_input_token_cost_above_200k_tokens;
    if (isFiniteNumber(e.cache_creation_input_token_cost_above_200k_tokens))
      pricing.cacheWritePerTokenAbove200k = e.cache_creation_input_token_cost_above_200k_tokens;

    out[model] = pricing;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model-name matching (mirrors ccusage pricing.rs).
// ---------------------------------------------------------------------------
const MODEL_DATE_SUFFIX_DIGITS = 8;

// Normalize known separator variants: `.`/`@` → `-`, lowercase.
function normalizedPricingKey(value: string): string {
  return value.replace(/[.@]/g, '-').toLowerCase();
}

const isBoundary = (ch: string | undefined): boolean => ch === undefined || !/[a-z0-9]/i.test(ch);

// True when the suffix immediately following a key match begins a *numeric*
// model-version bump (e.g. key `claude-opus-4` + suffix `-8`), which must block
// the match — UNLESS the run is exactly an 8-digit date suffix (`-20251101`).
function suffixStartsWithNumericModelVersion(key: string, suffix: string): boolean {
  const lastKeyChar = key[key.length - 1];
  if (lastKeyChar === undefined || !/[0-9]/.test(lastKeyChar)) return false;
  const sep = suffix[0];
  if (sep !== '-' && sep !== '.') return false;

  const rest = suffix.slice(1);
  let digitLen = 0;
  while (digitLen < rest.length && /[0-9]/.test(rest[digitLen]!)) digitLen++;
  if (digitLen === 0) return false;

  const afterDigits = rest[digitLen];
  // An 8-digit run followed by a boundary/end is a date alias — allow it.
  return !(digitLen === MODEL_DATE_SUFFIX_DIGITS && isBoundary(afterDigits));
}

function suffixAllows(key: string, suffix: string): boolean {
  if (suffix.length === 0) return true;
  if (!isBoundary(suffix[0])) return false;
  return !suffixStartsWithNumericModelVersion(key, suffix);
}

// Substring match where the char before is a boundary (or start) and the suffix
// after is allowed (boundary + not a numeric version bump).
function containsPricingKey(value: string, key: string): boolean {
  if (key.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = value.indexOf(key, from);
    if (idx < 0) return false;
    const before = idx > 0 ? value[idx - 1] : undefined;
    const suffix = value.slice(idx + key.length);
    if (isBoundary(before) && suffixAllows(key, suffix)) return true;
    from = idx + 1;
  }
}

function pricingKeyMatches(candidate: string, model: string, normalizedModel: string): boolean {
  if (containsPricingKey(model, candidate) || containsPricingKey(candidate, model)) return true;
  const normalizedCandidate = normalizedPricingKey(candidate);
  return (
    containsPricingKey(normalizedModel, normalizedCandidate) || containsPricingKey(normalizedCandidate, normalizedModel)
  );
}

export function find(modelId: string): ModelPricing | undefined {
  const exact = PRICING_MAP[modelId];
  if (exact) return exact;

  const normalizedModel = normalizedPricingKey(modelId);
  let best: { key: string; pricing: ModelPricing } | undefined;
  for (const [key, pricing] of Object.entries(PRICING_MAP)) {
    if (!pricingKeyMatches(key, modelId, normalizedModel)) continue;
    // Longest key wins; on a length tie, the lexicographically smaller key wins
    // (mirrors ccusage find_entry's `len().cmp().then_with(|| right.cmp(left))`).
    if (!best || key.length > best.key.length || (key.length === best.key.length && key < best.key)) {
      best = { key, pricing };
    }
  }
  return best?.pricing;
}

// ---------------------------------------------------------------------------
// Cost formula + tiered pricing (mirrors ccusage tiered_cost).
// ---------------------------------------------------------------------------
const TIER_THRESHOLD = 200_000;

function tiered(tokens: number, base: number, above?: number): number {
  if (tokens <= 0) return 0;
  if (above !== undefined && tokens > TIER_THRESHOLD) {
    return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * above;
  }
  return tokens * base;
}

// ---------------------------------------------------------------------------
// Warning collector — drained by runReport, surfaced loudly (stderr + JSON +
// HTML). Module-level state; tests reset it via resetPricingWarnings().
// ---------------------------------------------------------------------------
let warnings: PricingWarning[] = [];

export function drainPricingWarnings(): PricingWarning[] {
  const out = warnings;
  warnings = [];
  return out;
}

export function resetPricingWarnings(): void {
  warnings = [];
}

export function computeCost(modelId: string, usage: UsageCounts): number {
  const p = find(modelId);
  if (!p) {
    const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (total > 0) warnings.push({ model: modelId, tokens: total });
    return 0;
  }
  const cacheRead = p.cacheReadPerToken ?? p.inputPerToken * 0.1;
  const cacheWrite = p.cacheWritePerToken ?? p.inputPerToken * 1.25;
  return (
    tiered(usage.input, p.inputPerToken, p.inputPerTokenAbove200k) +
    tiered(usage.output, p.outputPerToken, p.outputPerTokenAbove200k) +
    tiered(usage.cacheRead, cacheRead, p.cacheReadPerTokenAbove200k) +
    tiered(usage.cacheWrite, cacheWrite, p.cacheWritePerTokenAbove200k)
  );
}
