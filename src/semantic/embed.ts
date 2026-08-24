// The optional semantic lane's embedder — Ollama treated exactly like fzf: an
// external tool that upgrades recall when present and is silently absent
// otherwise. Modeled on src/wrapped/roast.ts: detection returns null when the
// capability is missing, an injectable seam (setEmbedderForTests) keeps the tests
// off the real tool, hard AbortController timeouts bound every call, and the
// callers wrap embed() fail-open so a failure never surfaces to the user.
//
// Only localhost is ever contacted (SESSIONS_OLLAMA_URL default
// http://localhost:11434); nothing leaves the machine. `fetch` is built into Bun,
// so this adds no runtime dependency.

import { z } from 'zod';

export interface Embedder {
  /** Stored in session_vectors.model; vectors from a different id are recomputed. */
  id: string;
  /** Batched: one output vector per input text, same order. */
  embed(texts: string[]): Promise<number[][]>;
}

const OLLAMA_URL = (): string => process.env.SESSIONS_OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = (): string => process.env.SESSIONS_OLLAMA_MODEL ?? 'nomic-embed-text';

const embedResponseSchema = z.object({ embeddings: z.array(z.array(z.number())) });
const tagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string().optional() })).default([]),
});

// # ponytail: fixed timeouts; tune only against a logged real miss, per EVAL.md
// discipline. The probe is on the hot path (every process re-probes once), so it
// must be short; a cold model load can legitimately cost seconds on first embed.
const PROBE_TIMEOUT_MS = 250;
const EMBED_TIMEOUT_MS = 10_000;

/** `nomic-embed-text` matches a listed `nomic-embed-text` or `nomic-embed-text:latest`
 *  (and an explicitly-tagged request matches its exact listing). */
function modelMatches(listed: string, want: string): boolean {
  return listed === want || listed.startsWith(want + ':') || want.startsWith(listed + ':');
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

/** The available embedder, or null (server down, unreachable, or model not pulled —
 *  all of which are the first-class "lexical only" path). Cached per process. */
export function detectEmbedder(): Promise<Embedder | null> {
  if (_hasOverride) return Promise.resolve(_override);
  if (!_probe) _probe = probeOllama();
  return _probe;
}

/** Query-time embed of a single text, silently returning null on any failure so
 *  the caller falls back to lexical-only for that query. Never throws. */
export async function embedQuery(embedder: Embedder, text: string): Promise<Float32Array | null> {
  try {
    const [vec] = await embedder.embed([text]);
    return vec && vec.length > 0 ? Float32Array.from(vec) : null;
  } catch {
    return null;
  }
}
