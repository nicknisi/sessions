import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimePricing } from './pricing-cache.ts';

// Hermetic: point the cache dir at a temp dir and inject a counting fetcher so
// "fetched exactly once" is deterministic and zero network ever happens.
const tmp = mkdtempSync(join(tmpdir(), 'sessions-pricing-cache-'));
const prevCacheDir = process.env.SESSIONS_CACHE_DIR;
process.env.SESSIONS_CACHE_DIR = tmp;
const CACHE_FILE = join(tmp, 'litellm-pricing.json');

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevCacheDir === undefined) delete process.env.SESSIONS_CACHE_DIR;
  else process.env.SESSIONS_CACHE_DIR = prevCacheDir;
});

// A minimal but valid LiteLLM payload (parseLiteLLMPricing requires both
// input+output per-token rates).
const PAYLOAD = JSON.stringify({
  'claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
  'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6 },
});

function makeFetcher(body: string | (() => never)): { fn: (url: string) => Promise<string>; calls: () => number } {
  let calls = 0;
  const fn = async (_url: string): Promise<string> => {
    calls++;
    if (typeof body === 'function') return body();
    return body;
  };
  return { fn, calls: () => calls };
}

// Force a cache file's mtime into the past so it reads as stale.
function ageFile(path: string, msAgo: number): void {
  const when = new Date(Date.now() - msAgo);
  utimesSync(path, when, when);
}

beforeEach(() => {
  rmSync(CACHE_FILE, { force: true });
  rmSync(CACHE_FILE + '.tmp', { force: true });
});

describe('loadRuntimePricing', () => {
  test('missing cache + ok fetch → fetched once, cache file written, records returned', async () => {
    const f = makeFetcher(PAYLOAD);
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(f.calls()).toBe(1);
    expect(existsSync(CACHE_FILE)).toBe(true);
    expect(records).not.toBeNull();
    expect(records!['claude-opus-4-8']).toBeDefined();
    expect(records!['claude-opus-4-8']!.inputPerToken).toBe(5e-6);
    // Cache file holds the raw LiteLLM payload, not our parsed shape.
    expect(JSON.parse(readFileSync(CACHE_FILE, 'utf8'))['gpt-5.5'].input_cost_per_token).toBe(5e-6);
  });

  test('fresh cache (mtime now) → fetcher called zero times', async () => {
    writeFileSync(CACHE_FILE, PAYLOAD, 'utf8'); // mtime = now → fresh
    const f = makeFetcher(PAYLOAD);
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(f.calls()).toBe(0);
    expect(records).not.toBeNull();
    expect(records!['gpt-5.5']).toBeDefined();
  });

  test('stale cache (mtime > TTL ago) → fetcher called once', async () => {
    writeFileSync(CACHE_FILE, PAYLOAD, 'utf8');
    ageFile(CACHE_FILE, 25 * 60 * 60 * 1000); // 25h > 24h TTL
    const f = makeFetcher(PAYLOAD);
    await loadRuntimePricing({ fetcher: f.fn });
    expect(f.calls()).toBe(1);
  });

  test('fresh cache + force:true → fetcher called once (TTL ignored)', async () => {
    writeFileSync(CACHE_FILE, PAYLOAD, 'utf8'); // fresh
    const f = makeFetcher(PAYLOAD);
    await loadRuntimePricing({ force: true, fetcher: f.fn });
    expect(f.calls()).toBe(1);
  });

  test('network failure + stale cache present → stale records returned, no throw', async () => {
    writeFileSync(CACHE_FILE, PAYLOAD, 'utf8');
    ageFile(CACHE_FILE, 25 * 60 * 60 * 1000);
    const f = makeFetcher(() => {
      throw new Error('network down');
    });
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(f.calls()).toBe(1);
    expect(records).not.toBeNull();
    expect(records!['claude-opus-4-8']).toBeDefined();
  });

  test('network failure + no cache → returns null (caller stays on embedded), no throw', async () => {
    const f = makeFetcher(() => {
      throw new Error('network down');
    });
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(f.calls()).toBe(1);
    expect(records).toBeNull();
  });

  test('corrupt cache JSON (fresh) → treated as a miss, never throws', async () => {
    writeFileSync(CACHE_FILE, 'not json at all', 'utf8'); // fresh but garbage
    const f = makeFetcher(PAYLOAD);
    // Fresh-but-corrupt: parse yields nothing usable, so it fetches rather than
    // serve an empty map. Must not throw.
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(records).not.toBeNull();
    expect(records!['claude-opus-4-8']).toBeDefined();
  });

  test('corrupt cache + network failure → returns null, never throws', async () => {
    writeFileSync(CACHE_FILE, '{ broken', 'utf8');
    ageFile(CACHE_FILE, 25 * 60 * 60 * 1000);
    const f = makeFetcher(() => {
      throw new Error('network down');
    });
    const records = await loadRuntimePricing({ fetcher: f.fn });
    expect(records).toBeNull();
  });

  test('fetched payload that parses to zero usable records → returns null', async () => {
    const f = makeFetcher(JSON.stringify({ 'embedding-model': { input_cost_per_token: 1e-7 } }));
    const records = await loadRuntimePricing({ fetcher: f.fn });
    // Nothing has both input+output rates → parseLiteLLMPricing yields {} → null.
    expect(records).toBeNull();
  });

  test('does not delete a sibling index.db in the same cache dir', async () => {
    const dbPath = join(tmp, 'index.db');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(dbPath, 'fake-db', 'utf8');
    const f = makeFetcher(PAYLOAD);
    await loadRuntimePricing({ fetcher: f.fn });
    expect(existsSync(dbPath)).toBe(true);
    rmSync(dbPath, { force: true });
  });
});
