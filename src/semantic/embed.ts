// The optional semantic lane's embedder — an external service treated exactly like
// fzf: it upgrades recall when present and is silently absent otherwise. Modeled on
// src/wrapped/roast.ts: detection returns null when the capability is missing, an
// injectable seam (setEmbedderForTests) keeps the tests off the real service, hard
// AbortController timeouts bound every call, and the callers wrap embed() fail-open
// so a failure never surfaces to the user.
//
// The default is Ollama on localhost (SESSIONS_OLLAMA_URL, nothing leaves the
// machine). Setting SESSIONS_EMBED_PROVIDER to `openai` or `tei` opts into a remote
// endpoint: the session text and the query text are then sent to the configured
// URL. No provider is ever selected implicitly. `fetch` is built into Bun, so this
// adds no runtime dependency.

import { z } from 'zod';

/** Tunables for one embed call. Only remote providers honor them today. */
export interface EmbedOptions {
  /** Network timeout for this call in ms; defaults to the embedder's own default. */
  timeoutMs?: number;
}

export interface Embedder {
  /** Stored in session_vectors.model; vectors from a different id are recomputed. */
  id: string;
  /** Batched: one output vector per input text, same order. */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

const OLLAMA_URL = (): string => process.env.SESSIONS_OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = (): string => process.env.SESSIONS_OLLAMA_MODEL ?? 'nomic-embed-text';

const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
const TEI_DEFAULT_URL = 'http://localhost:8080';

const embedResponseSchema = z.object({ embeddings: z.array(z.array(z.number())) });
const tagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string().optional() })).default([]),
});
const openAiResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});
const teiEmbedResponseSchema = z.array(z.array(z.number()));
const teiInfoSchema = z.object({ model_id: z.string().min(1) });

// # ponytail: fixed timeouts; tune only against a logged real miss, per EVAL.md
// discipline. The probe is on the hot path (every process re-probes once), so it
// must be short; a cold model load can legitimately cost seconds on first embed.
const PROBE_TIMEOUT_MS = 250;
const EMBED_TIMEOUT_MS = 10_000;
// # ponytail: fixed constant. A remote query that has not answered in a couple of
// seconds is not worth blocking an interactive search — the callers fail open to
// lexical-only for that query — while indexing batches keep the longer timeout
// above to absorb a cold model load.
const QUERY_EMBED_TIMEOUT_MS = 2_500;
// # ponytail: fixed constant. After one failed remote embed the embedder throws
// immediately for this long, so a dead endpoint cannot stall every search of a
// long-lived MCP server; the callers already treat a throw as "absent" (embedQuery
// returns null, embedMissingVectors warns once and abandons).
const FAILURE_COOLDOWN_MS = 60_000;

/** `nomic-embed-text` matches a listed `nomic-embed-text` or `nomic-embed-text:latest`
 *  (and an explicitly-tagged request matches its exact listing). */
function modelMatches(listed: string, want: string): boolean {
  return listed === want || listed.startsWith(want + ':') || want.startsWith(listed + ':');
}

/** An env var's value, with the empty string treated as unset (matching how a
 *  `VAR=` line in a shell profile reads to the user). */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

const _warned = new Set<string>();

/** One stderr warning per distinct message per process: a misconfigured provider
 *  is worth saying once, not once per search. */
function warnOnce(message: string): void {
  if (_warned.has(message)) return;
  _warned.add(message);
  process.stderr.write(`sessions: ${message}\n`);
}

/** The base URL when it parses as http(s) — normalized without a trailing slash —
 *  else null after one warning. Rejecting anything else keeps a typo from silently
 *  becoming a request to an unrelated scheme. */
function parseHttpBaseUrl(raw: string, label: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    warnOnce(`${label} "${raw}" is not a valid http(s) URL; semantic lane disabled`);
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    warnOnce(`${label} "${raw}" is not a valid http(s) URL; semantic lane disabled`);
    return null;
  }
  return raw.replace(/\/+$/, '');
}

let _clock: () => number = Date.now;

/** Test seam: swap the clock the failure cooldown reads, or pass null to restore
 *  the wall clock. */
export function setEmbedderClockForTests(clock: (() => number) | null): void {
  _clock = clock ?? Date.now;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function bearerHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`);
  return headers;
}

/** Place each `{index, embedding}` item at its declared index. Rejects duplicates,
 *  gaps, empty vectors, and a count that disagrees with the request — a provider
 *  that reorders or drops items must never silently misalign vectors and sessions. */
function reorderByIndex(
  items: Array<{ index: number; embedding: number[] }>,
  count: number,
  label: string,
): number[][] {
  const out = Array.from<number[] | undefined>({ length: count });
  for (const item of items) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= count || out[item.index] !== undefined) {
      throw new Error(`${label}: malformed response`);
    }
    if (item.embedding.length === 0) throw new Error(`${label}: empty embedding`);
    out[item.index] = item.embedding;
  }
  if (items.length !== count) throw new Error(`${label}: malformed response`);
  return out.map((vec) => vec!);
}

/** Base for the remote providers: a per-process failure cooldown shared by every
 *  call so a dead endpoint degrades to the lexical lane instead of stalling. */
abstract class RemoteEmbedder implements Embedder {
  abstract readonly id: string;
  private cooldownUntil = 0;

  /** One network request; each protocol parses its own wire format. */
  protected abstract request(texts: string[], timeoutMs: number): Promise<number[][]>;

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS;
    if (_clock() < this.cooldownUntil) {
      throw new Error(`${this.id}: cooling down after a recent failure`);
    }
    try {
      return await this.request(texts, timeoutMs);
    } catch (err) {
      this.cooldownUntil = _clock() + FAILURE_COOLDOWN_MS;
      throw err;
    }
  }
}

export class OllamaEmbedder implements Embedder {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly url: string,
  ) {
    this.id = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.url}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ollama embed: http ${res.status}`);
      const body = embedResponseSchema.safeParse(await res.json());
      if (!body.success || body.data.embeddings.length !== texts.length) {
        throw new Error('ollama embed: malformed response');
      }
      return body.data.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Any OpenAI-compatible `/embeddings` API (OpenAI, vLLM, LiteLLM, LocalAI, and
 *  TEI's own `/v1/embeddings`). Sent as configured; the key is optional because a
 *  custom URL is usually an unauthenticated local server. */
export class OpenAIEmbedder extends RemoteEmbedder {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly base: string,
    private readonly apiKey: string | undefined,
  ) {
    super();
    this.id = `openai:${model}`;
  }

  protected async request(texts: string[], timeoutMs: number): Promise<number[][]> {
    const res = await fetchWithTimeout(
      `${this.base}/embeddings`,
      {
        method: 'POST',
        headers: bearerHeaders(this.apiKey),
        body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`openai embed: http ${res.status}`);
    const body = openAiResponseSchema.safeParse(await res.json());
    if (!body.success) throw new Error('openai embed: malformed response');
    return reorderByIndex(body.data.data, texts.length, 'openai embed');
  }
}

/** Hugging Face Text Embeddings Inference. Native `/embed` takes `inputs` (not
 *  `input`) and answers with a bare array of vectors; `truncate` lets a
 *  small-context model accept an over-long session doc instead of 413-ing. */
export class TeiEmbedder extends RemoteEmbedder {
  readonly id: string;
  constructor(
    modelId: string,
    private readonly base: string,
    private readonly apiKey: string | undefined,
  ) {
    super();
    this.id = `tei:${modelId}`;
  }

  protected async request(texts: string[], timeoutMs: number): Promise<number[][]> {
    const res = await fetchWithTimeout(
      `${this.base}/embed`,
      {
        method: 'POST',
        headers: bearerHeaders(this.apiKey),
        body: JSON.stringify({ inputs: texts, truncate: true }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`tei embed: http ${res.status}`);
    const body = teiEmbedResponseSchema.safeParse(await res.json());
    if (!body.success || body.data.length !== texts.length) {
      throw new Error('tei embed: malformed response');
    }
    for (const vec of body.data) {
      if (vec.length === 0) throw new Error('tei embed: empty embedding');
    }
    return body.data;
  }
}

// Probe verdict cached per process: an index refresh and a follow-up CLI search
// share one answer, and a NEW process re-probes (the cache is deliberately never
// persisted cross-process). Tests reset it through the seam below.
let _probe: Promise<Embedder | null> | null = null;
let _hasOverride = false;
let _override: Embedder | null = null;

/** Inject a fake embedder (or force absence with null) for tests, mirroring the
 *  RoastRunner seam. Clears the cached probe so the override takes effect. */
export function setEmbedderForTests(embedder: Embedder | null): void {
  _hasOverride = true;
  _override = embedder;
  _probe = null;
}

/** Drop the test override and the cached probe, restoring real detection. */
export function clearEmbedderForTests(): void {
  _hasOverride = false;
  _override = null;
  _probe = null;
}

async function probeOllama(): Promise<Embedder | null> {
  const url = OLLAMA_URL();
  const model = OLLAMA_MODEL();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = tagsResponseSchema.safeParse(await res.json());
    const models = body.success ? body.data.models : [];
    const listed = models.some((m) => m.name !== undefined && modelMatches(m.name, model));
    // A model that isn't pulled degrades identically to an absent server.
    if (!listed) return null;
    return new OllamaEmbedder(model, url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The provider named by SESSIONS_EMBED_PROVIDER, defaulting to `ollama`. An
 *  unrecognized value disables the lane with a single warning rather than guessing. */
function resolveProvider(): 'ollama' | 'openai' | 'tei' | null {
  const raw = envValue('SESSIONS_EMBED_PROVIDER');
  if (raw === undefined || raw === 'ollama') return 'ollama';
  if (raw === 'openai' || raw === 'tei') return raw;
  warnOnce(`unknown SESSIONS_EMBED_PROVIDER value "${raw}"; semantic lane disabled`);
  return null;
}

/** openai + tei validate config up front; only tei touches the network (its /info
 *  probe, cached like Ollama's) so the model id in the embedder id is the one the
 *  server actually serves. */
function resolveOpenAi(): Embedder | null {
  const base = parseHttpBaseUrl(envValue('SESSIONS_EMBED_URL') ?? OPENAI_DEFAULT_URL, 'SESSIONS_EMBED_URL');
  if (base === null) return null;
  const model = envValue('SESSIONS_EMBED_MODEL') ?? OPENAI_DEFAULT_MODEL;
  // The fallback to OPENAI_API_KEY is scoped to the real OpenAI endpoint: for a
  // custom URL (vLLM, LiteLLM, LocalAI, TEI) the key is optional, and borrowing the
  // user's OpenAI secret to send to a third-party host would be a surprise.
  let apiKey = envValue('SESSIONS_EMBED_API_KEY');
  if (apiKey === undefined && base === OPENAI_DEFAULT_URL) apiKey = envValue('OPENAI_API_KEY');
  if (apiKey === undefined && base === OPENAI_DEFAULT_URL) {
    warnOnce(
      'openai embedder needs an API key: set SESSIONS_EMBED_API_KEY (or OPENAI_API_KEY for the default endpoint); semantic lane disabled',
    );
    return null;
  }
  return new OpenAIEmbedder(model, base, apiKey);
}

async function probeTei(): Promise<Embedder | null> {
  const base = parseHttpBaseUrl(envValue('SESSIONS_EMBED_URL') ?? TEI_DEFAULT_URL, 'SESSIONS_EMBED_URL');
  if (base === null) return null;
  const apiKey = envValue('SESSIONS_EMBED_API_KEY');
  try {
    const res = await fetchWithTimeout(`${base}/info`, { headers: bearerHeaders(apiKey) }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = teiInfoSchema.safeParse(await res.json());
    // TEI serves exactly one model, so its id (not SESSIONS_EMBED_MODEL) names the
    // space these vectors live in.
    if (!body.success) return null;
    return new TeiEmbedder(body.data.model_id, base, apiKey);
  } catch {
    return null;
  }
}

function probeConfigured(): Promise<Embedder | null> {
  const provider = resolveProvider();
  if (provider === null) return Promise.resolve(null);
  if (provider === 'ollama') return probeOllama();
  if (provider === 'openai') return Promise.resolve(resolveOpenAi());
  return probeTei();
}

/** The available embedder, or null (server down, unreachable, model not pulled, or
 *  a configuration that cannot work — all of which are the first-class "lexical
 *  only" path). Cached per process. */
export function detectEmbedder(): Promise<Embedder | null> {
  if (_hasOverride) return Promise.resolve(_override);
  if (!_probe) _probe = probeConfigured();
  return _probe;
}

/** Query-time embed of a single text, silently returning null on any failure so
 *  the caller falls back to lexical-only for that query. Never throws. */
export async function embedQuery(embedder: Embedder, text: string): Promise<Float32Array | null> {
  try {
    const [vec] = await embedder.embed([text], { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
    return vec && vec.length > 0 ? Float32Array.from(vec) : null;
  } catch {
    return null;
  }
}
