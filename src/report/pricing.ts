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

import { z } from 'zod';

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
  cacheWrite: number; // total cache-creation tokens (5m + 1h)
  cacheWrite1h?: number; // subset of cacheWrite billed at the 1h rate (input×2)
}

export interface PricingWarning {
  model: string;
  tokens: number;
  /** Set when the model had no price of its own and was billed at a same-family
   *  rate instead. Absent means the tokens were genuinely counted as $0. */
  pricedAs?: string;
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
/** Per-model pricing keyed by normalized model id. */
export interface PricingMap {
  [model: string]: ModelPricing;
}

export const BUILTIN_OVERRIDES: PricingMap = {
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
// snapshot lacks. A runtime live fetch (Phase 2) is merged over the top via
// mergeRuntimePricing — live wins over snapshot + overrides.
const baseMap = (): PricingMap => ({ ...GENERATED_PRICING, ...BUILTIN_OVERRIDES });
const PRICING_MAP: PricingMap = baseMap();

// Overlay runtime-fetched records onto the in-memory map (live wins). Mutates the
// shared map in place since find()/computeCost read the module singleton.
export function mergeRuntimePricing(records: PricingMap): void {
  Object.assign(PRICING_MAP, records);
  findCache.clear();
  familyCache.clear();
}

// Restore the map to the embedded snapshot + overrides, dropping any runtime
// layer. Tests call this in beforeEach so a merged fetch never leaks across cases.
export function resetPricing(): void {
  for (const key of Object.keys(PRICING_MAP)) delete PRICING_MAP[key];
  Object.assign(PRICING_MAP, baseMap());
  findCache.clear();
  familyCache.clear();
}

// ---------------------------------------------------------------------------
// LiteLLM parsing — shared with the build-time generator (and Phase 2).
// LiteLLM fields are already per single token, so they map across directly.
// Cache defaults are applied lazily in computeCost, not here, so the snapshot
// stays a near-direct copy of LiteLLM.
// ---------------------------------------------------------------------------
// zod v4 numbers are finite by default, matching the old isFiniteNumber gate.
// Input/output rates are required (skip specs/embeddings/etc.); every other
// field degrades to absent when malformed.
const liteLLMEntrySchema = z.object({
  input_cost_per_token: z.number(),
  output_cost_per_token: z.number(),
  cache_creation_input_token_cost: z.number().optional().catch(undefined),
  cache_read_input_token_cost: z.number().optional().catch(undefined),
  input_cost_per_token_above_200k_tokens: z.number().optional().catch(undefined),
  output_cost_per_token_above_200k_tokens: z.number().optional().catch(undefined),
  cache_creation_input_token_cost_above_200k_tokens: z.number().optional().catch(undefined),
  cache_read_input_token_cost_above_200k_tokens: z.number().optional().catch(undefined),
});
const liteLLMFileSchema = z.record(z.string(), z.unknown());

export function parseLiteLLMPricing(json: string): PricingMap {
  let raw: z.infer<typeof liteLLMFileSchema>;
  try {
    raw = liteLLMFileSchema.parse(JSON.parse(json));
  } catch {
    return {};
  }

  const out: PricingMap = {};
  for (const [model, value] of Object.entries(raw)) {
    const entry = liteLLMEntrySchema.safeParse(value);
    if (!entry.success) continue;
    const e = entry.data;

    const pricing: ModelPricing = {
      inputPerToken: e.input_cost_per_token,
      outputPerToken: e.output_cost_per_token,
    };
    if (e.cache_read_input_token_cost !== undefined) pricing.cacheReadPerToken = e.cache_read_input_token_cost;
    if (e.cache_creation_input_token_cost !== undefined) pricing.cacheWritePerToken = e.cache_creation_input_token_cost;
    if (e.input_cost_per_token_above_200k_tokens !== undefined)
      pricing.inputPerTokenAbove200k = e.input_cost_per_token_above_200k_tokens;
    if (e.output_cost_per_token_above_200k_tokens !== undefined)
      pricing.outputPerTokenAbove200k = e.output_cost_per_token_above_200k_tokens;
    if (e.cache_read_input_token_cost_above_200k_tokens !== undefined)
      pricing.cacheReadPerTokenAbove200k = e.cache_read_input_token_cost_above_200k_tokens;
    if (e.cache_creation_input_token_cost_above_200k_tokens !== undefined)
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

// find() walks the whole pricing map on a miss, and a report prices every event
// (several times over, once facets are computed), so memoize per model id.
// Both caches are cleared whenever the map changes.
const findCache = new Map<string, ModelPricing | undefined>();
const familyCache = new Map<string, FamilyMatch | undefined>();

export function find(modelId: string): ModelPricing | undefined {
  if (findCache.has(modelId)) return findCache.get(modelId);
  const found = findUncached(modelId);
  findCache.set(modelId, found);
  return found;
}

function findUncached(modelId: string): ModelPricing | undefined {
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
// Family fallback.
//
// A model that ships before the price map catches up (a fresh `claude-opus-5`,
// say) otherwise costs $0, which silently understates the headline number by
// however much of the period ran on it. Bill it at the newest rate in its own
// family instead, and keep the warning — flagged with what it was priced as, so
// an estimate never passes for a quote.
//
// Candidates come from BUILTIN_OVERRIDES, not the full LiteLLM map: those keys
// are hand-maintained, unprefixed, and one per released version, so "newest
// opus" resolves cleanly instead of colliding with `bedrock/…` aliases. Stems
// are listed explicitly so a loose one (`gpt`) can never swallow an unrelated
// family (`gpt-4o` must not be priced as `gpt-5.5`).
// ---------------------------------------------------------------------------
interface FamilyMatch {
  key: string;
  pricing: ModelPricing;
}

const FAMILY_STEMS = ['claude-fable', 'claude-opus', 'claude-sonnet', 'claude-haiku', 'gpt-5'];

// Families Pi reaches through OpenRouter (`moonshotai/kimi-k3`, `z-ai/glm-5.2`).
// Their released versions live in the LiteLLM snapshot under provider-prefixed
// keys (`openrouter/moonshotai/kimi-k2.5`), not in BUILTIN_OVERRIDES, so these
// stems draw candidates from the full map instead. The stem must sit at a
// path-segment boundary (start or right after `/`) so a stem like `glm-` can
// never match inside an unrelated id.
const PREFIXED_FAMILY_STEMS = ['kimi-k', 'glm-'];

// Index of `stem` in `normalizedKey` where it begins a path segment, or -1.
function stemIndexAtBoundary(normalizedKey: string, stem: string): number {
  let from = 0;
  for (;;) {
    const idx = normalizedKey.indexOf(stem, from);
    if (idx < 0) return -1;
    if (idx === 0 || normalizedKey[idx - 1] === '/') return idx;
    from = idx + 1;
  }
}

// Trailing numeric segments after the stem, as numbers: `claude-opus-4-8` → [4,8].
function versionSegments(rest: string): number[] {
  const out: number[] = [];
  for (const part of rest.split('-')) {
    if (part.length === 0) continue;
    if (!/^[0-9]+$/.test(part)) break;
    out.push(Number(part));
  }
  return out;
}

// Later version wins; on a shared prefix the more specific one does ([4,8] > [4]).
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function findFamilyUncached(modelId: string): FamilyMatch | undefined {
  const normalized = normalizedPricingKey(modelId);
  const stem = FAMILY_STEMS.find((s) => normalized.includes(s));
  if (stem) return newestInFamily(stem, Object.keys(BUILTIN_OVERRIDES));
  const prefixed = PREFIXED_FAMILY_STEMS.find((s) => stemIndexAtBoundary(normalized, s) >= 0);
  if (prefixed) return newestInFamily(prefixed, Object.keys(PRICING_MAP));
  return undefined;
}

function newestInFamily(stem: string, candidates: string[]): FamilyMatch | undefined {
  let best: { key: string; version: number[] } | undefined;
  for (const key of candidates) {
    const nk = normalizedPricingKey(key);
    const idx = stemIndexAtBoundary(nk, stem);
    if (idx < 0) continue;
    const version = versionSegments(nk.slice(idx + stem.length));
    // Later version wins; on a version tie the lexicographically smaller key does,
    // so the winner is deterministic rather than map-order (mirrors findUncached).
    if (
      !best ||
      compareVersions(version, best.version) > 0 ||
      (compareVersions(version, best.version) === 0 && key < best.key)
    ) {
      best = { key, version };
    }
  }
  // Resolve through the live map so a runtime price for the winning key is used
  // rather than the frozen override it was selected by.
  if (!best) return undefined;
  return { key: best.key, pricing: PRICING_MAP[best.key] ?? BUILTIN_OVERRIDES[best.key]! };
}

export function findFamily(modelId: string): FamilyMatch | undefined {
  if (familyCache.has(modelId)) return familyCache.get(modelId);
  const found = findFamilyUncached(modelId);
  familyCache.set(modelId, found);
  return found;
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

// computeCost pushes one entry per unpriced EVENT; consumers want one line per
// model. Merge here (summing tokens, first-seen order) so stderr never reads
// "67 model(s) had no pricing" followed by the same two ids 67 times.
export function drainPricingWarnings(): PricingWarning[] {
  const raw = warnings;
  warnings = [];
  const byModel = new Map<string, PricingWarning>();
  for (const w of raw) {
    const cur = byModel.get(w.model);
    if (cur) cur.tokens += w.tokens;
    else byModel.set(w.model, { ...w });
  }
  return [...byModel.values()];
}

export function resetPricingWarnings(): void {
  warnings = [];
}

export function computeCost(modelId: string, usage: UsageCounts): number {
  const p = find(modelId);
  if (p) return priceWith(p, usage);

  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const family = findFamily(modelId);
  if (!family) {
    if (total > 0) warnings.push({ model: modelId, tokens: total });
    return 0;
  }
  if (total > 0) warnings.push({ model: modelId, tokens: total, pricedAs: family.key });
  return priceWith(family.pricing, usage);
}

function priceWith(p: ModelPricing, usage: UsageCounts): number {
  const cacheRead = p.cacheReadPerToken ?? p.inputPerToken * 0.1;
  const cacheWrite = p.cacheWritePerToken ?? p.inputPerToken * 1.25;
  // 1h cache-creation is billed at input × 2 (ccusage CACHE_CREATE_1H_INPUT_MULTIPLIER);
  // the remainder (5m / default) uses the standard cache_create rate.
  const write1h = usage.cacheWrite1h ?? 0;
  const write5m = Math.max(0, usage.cacheWrite - write1h);
  const write1hAbove = p.inputPerTokenAbove200k !== undefined ? p.inputPerTokenAbove200k * 2 : undefined;
  return (
    tiered(usage.input, p.inputPerToken, p.inputPerTokenAbove200k) +
    tiered(usage.output, p.outputPerToken, p.outputPerTokenAbove200k) +
    tiered(usage.cacheRead, cacheRead, p.cacheReadPerTokenAbove200k) +
    tiered(write5m, cacheWrite, p.cacheWritePerTokenAbove200k) +
    tiered(write1h, p.inputPerToken * 2, write1hAbove)
  );
}
