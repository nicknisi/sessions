// Runtime pricing refresh: load the latest LiteLLM pricing from a disk cache,
// fetching once when the cache is stale/missing, and return compact records that
// runReport merges OVER the embedded snapshot (live wins) — current prices with
// no recompile. Any fetch/parse/IO failure degrades down the chain
// (fresh → stale cache → embedded snapshot) and never blocks the report.
//
// Mirrors ccusage's fetch/fallback semantics (fetch → on failure keep the
// embedded floor, warn only). Parsing reuses parseLiteLLMPricing so the build
// generator and this runtime path share one code path.

import { existsSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getCacheDir } from '../cache.ts';
import { parseLiteLLMPricing, type ModelPricing } from './pricing.ts';

const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 10_000;

// Resolved lazily so SESSIONS_CACHE_DIR overrides (tests) take effect at call time.
const cacheFile = (): string => join(getCacheDir(), 'litellm-pricing.json');

// Injectable so tests assert call-count without touching the network. The default
// uses global fetch with a timeout so a hung connection can never stall the report.
export type Fetcher = (url: string) => Promise<string>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`pricing fetch failed: HTTP ${res.status}`);
  return res.text();
};

function warn(msg: string): void {
  process.stderr.write(`warning: ${msg}\n`);
}

// Parse a raw LiteLLM payload, returning records only if at least one entry is
// usable; an empty result is treated as "no data" by callers.
function parseOrEmpty(raw: string): Record<string, ModelPricing> {
  const records = parseLiteLLMPricing(raw);
  return Object.keys(records).length > 0 ? records : {};
}

// Read + parse the cache file if present. Never throws; corrupt/unreadable files
// yield an empty record set (treated as a miss).
function readCache(path: string): Record<string, ModelPricing> {
  if (!existsSync(path)) return {};
  try {
    return parseOrEmpty(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function isFresh(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < TTL_MS;
  } catch {
    return false;
  }
}

// Atomic write: tmp file + rename so a concurrent report never reads a
// half-written file. A non-writable cache dir is non-fatal — warn once and let
// the caller use the fetched records in-memory for this run.
function writeCacheAtomic(path: string, raw: string): void {
  const tmp = path + '.tmp';
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(tmp, raw, 'utf8');
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    warn('could not write pricing cache; using freshly fetched prices for this run only');
  }
}

/**
 * Load runtime pricing records to merge over the embedded snapshot.
 *
 * Decision flow:
 *  - not `force` and cache fresh (mtime within TTL) and parses to ≥1 entry → return it (zero fetch).
 *  - otherwise fetch exactly once:
 *      - success + ≥1 parsed entry → atomic-write cache, return parsed.
 *      - success but empty/garbage payload → fall through to fallback.
 *      - failure → fall back to any cache on disk (even stale), else return null.
 *
 * @returns parsed records (live wins), or `null` to stay on the embedded snapshot.
 */
export async function loadRuntimePricing(
  opts: { force?: boolean; fetcher?: Fetcher } = {},
): Promise<Record<string, ModelPricing> | null> {
  const path = cacheFile();
  const fetcher = opts.fetcher ?? defaultFetcher;

  if (!opts.force && isFresh(path)) {
    const cached = readCache(path);
    if (Object.keys(cached).length > 0) return cached;
    // Fresh but unparseable → fall through and try a fetch rather than serve nothing.
  }

  let raw: string;
  try {
    raw = await fetcher(PRICING_URL);
  } catch {
    // Network failed — fall back to whatever is on disk (even stale), else nothing.
    const stale = readCache(path);
    if (Object.keys(stale).length > 0) {
      warn('could not refresh pricing; using cached prices');
      return stale;
    }
    warn('could not refresh pricing and no cache available; using embedded snapshot');
    return null;
  }

  const records = parseOrEmpty(raw);
  if (Object.keys(records).length === 0) {
    // Fetched payload was empty/garbage — fall back to disk, then embedded.
    const fallback = readCache(path);
    if (Object.keys(fallback).length > 0) {
      warn('fetched pricing was unusable; using cached prices');
      return fallback;
    }
    warn('fetched pricing was unusable; using embedded snapshot');
    return null;
  }

  writeCacheAtomic(path, raw);
  return records;
}
