// The semantic lane's suite. Fusion correctness is pure ranking logic, so it runs
// against an INJECTABLE FAKE EMBEDDER (a deterministic vocabulary→vector map) — no
// Ollama, green in CI. Coverage: cosine/RRF/top-K math, the probe matrix via a
// stubbed fetch, embed fail-open, the paraphrase golden (fused finds what lexical
// misses), absence identity, the abstention guard, and staleness/model re-embed.

import { test, expect, describe, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { cosine, topKSimilar, fuseRRF, type VectorRow } from './fuse';
import {
  detectEmbedder,
  embedQuery,
  setEmbedderForTests,
  clearEmbedderForTests,
  OllamaEmbedder,
  type Embedder,
} from './embed';

// The probe/embed tests only drive fetch's `() => Promise<Response>` arity; the real
// signature's request arguments are never read by these stubs.
function stubFetch(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: (): void => {} });
}

// ——— fake embedder: a tiny concept map. Words in the same concept share a
// dimension, so paraphrases ("flaky" ≈ "intermittent") land cosine-close. Unknown
// tokens contribute nothing, so an unrelated query embeds to the zero vector. ———
const CONCEPT = new Map<string, number>([
  ['flaky', 0],
  ['flakiness', 0],
  ['intermittent', 0],
  ['unreliable', 0],
  ['test', 1],
  ['tests', 1],
  ['testing', 1],
  ['ci', 1],
  ['failure', 1],
  ['failures', 1],
  ['failing', 1],
  ['auth', 2],
  ['authentication', 2],
  ['login', 2],
  ['jwt', 2],
  ['docker', 3],
  ['container', 3],
  ['containers', 3],
  ['compose', 3],
  ['pagination', 4],
  ['handlers', 4],
  ['cursor', 4],
  ['paginate', 4],
]);
const FAKE_DIM = 5;
function fakeVector(text: string): number[] {
  const v = Array.from<number>({ length: FAKE_DIM }).fill(0);
  for (const tok of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const d = CONCEPT.get(tok);
    if (d !== undefined) v[d]! += 1;
  }
  return v;
}
function fakeEmbedder(id = 'fake:test'): Embedder {
  return { id, embed: async (texts) => texts.map(fakeVector) };
}

// ——— pure math ———

describe('fuse math', () => {
  test('cosine: identical direction = 1, orthogonal = 0, length mismatch = 0', () => {
    expect(cosine(Float32Array.from([1, 2, 0]), Float32Array.from([2, 4, 0]))).toBeCloseTo(1, 5);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2]))).toBe(0);
  });

  test('topKSimilar: highest first, skips mismatched dim', () => {
    const rows: VectorRow[] = [
      { filePath: 'a', model: 'm', dim: 2, vec: Float32Array.from([1, 0]) },
      { filePath: 'b', model: 'm', dim: 2, vec: Float32Array.from([1, 1]) },
      { filePath: 'c', model: 'm', dim: 3, vec: Float32Array.from([1, 0, 0]) }, // wrong dim
    ];
    const out = topKSimilar(Float32Array.from([1, 0]), rows, 5);
    expect(out.map((o) => o.filePath)).toEqual(['a', 'b']);
    expect(out[0]!.sim).toBeCloseTo(1, 5);
  });

  test('fuseRRF: a doc in both lists outranks one in a single list', () => {
    const scores = fuseRRF(['x', 'y'], ['y', 'z']);
    expect(scores.get('y')!).toBeGreaterThan(scores.get('x')!);
    expect(scores.get('y')!).toBeGreaterThan(scores.get('z')!);
  });
});

// ——— probe matrix + fail-open (stubbed fetch) ———

describe('detectEmbedder probe matrix', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearEmbedderForTests();
  });

  test('server down → null', async () => {
    globalThis.fetch = stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
  });

  test('server up, model not pulled → null', async () => {
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }] }), {
          status: 200,
        }),
    );
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
  });

  test('server up, model present (bare and :latest) → embedder', async () => {
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), {
          status: 200,
        }),
    );
    clearEmbedderForTests();
    const e = await detectEmbedder();
    expect(e?.id).toBe('ollama:nomic-embed-text');
  });

  test('probe cached per process: a second call does not re-fetch', async () => {
    let calls = 0;
    globalThis.fetch = stubFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }), { status: 200 });
    });
    clearEmbedderForTests();
    await detectEmbedder();
    await detectEmbedder();
    expect(calls).toBe(1);
  });
});

describe('embed fail-open', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('embedQuery returns null when embed throws', async () => {
    const throwing: Embedder = {
      id: 'x',
      embed: async () => {
        throw new Error('boom');
      },
    };
    expect(await embedQuery(throwing, 'hello')).toBeNull();
  });

  test('OllamaEmbedder.embed throws on non-200', async () => {
    globalThis.fetch = stubFetch(async () => new Response('nope', { status: 500 }));
    const e = new OllamaEmbedder('nomic-embed-text', 'http://localhost:11434');
    await expect(e.embed(['a'])).rejects.toThrow();
  });

  test('OllamaEmbedder.embed throws on a count mismatch', async () => {
    globalThis.fetch = stubFetch(
      async () => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 }),
    );
    const e = new OllamaEmbedder('nomic-embed-text', 'http://localhost:11434');
    await expect(e.embed(['a', 'b'])).rejects.toThrow();
  });
});

// ——— fusion against a seeded corpus + fake embedder ———

interface UserRecord {
  type: 'user';
  timestamp: string;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  promptSource: 'typed';
}
const j = (o: UserRecord & { cwd: string }): string => JSON.stringify(o);
const user = (text: string, t: string): UserRecord => ({
  type: 'user',
  timestamp: t,
  message: { role: 'user', content: [{ type: 'text', text }] },
  promptSource: 'typed',
});
const at = (day: number): string => `2026-07-${String(day).padStart(2, '0')}T10:00:00Z`;

interface Sess {
  id: string;
  text: string;
}
// Deliberately NO overlap between the "flaky tests" query and the intermittent
// session's lexical text — that's what makes lexical miss and semantic earn its keep.
const PARAPHRASE_CORPUS: Sess[] = [
  { id: 'intermittent', text: 'the ci keeps breaking at random with intermittent failures' },
  { id: 'docker', text: 'set up docker containers with compose for local dev' },
  { id: 'auth', text: 'add jwt authentication and login handling' },
  { id: 'pagination', text: 'add pagination to the handlers with a cursor' },
];

let tmp: string;
let cache: typeof import('../cache');

function writeCorpus(sessions: Sess[]): void {
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    const cwd = '/repo/app';
    const lines = [user(s.text, at(1))].map((r) => j({ ...r, cwd })).join('\n');
    writeFileSync(join(dir, `${s.id}.jsonl`), lines);
  }
}

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

function vectorRows(): Array<{ file_path: string; model: string; dim: number }> {
  const db = new Database(cache.getDbPath(), { readonly: true });
  const rows = db
    .query<{ file_path: string; model: string; dim: number }, []>('SELECT file_path, model, dim FROM session_vectors')
    .all();
  db.close();
  return rows;
}

describe('semantic fusion', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sessions-sem-'));
    setEnv();
    mkdirSync(join(tmp, 'claude'), { recursive: true });
    writeCorpus(PARAPHRASE_CORPUS);
    cache = await import('../cache');
    cache.closeDb();
  });

  afterEach(() => {
    clearEmbedderForTests();
  });

  afterAll(() => {
    cache.closeDb();
    clearEmbedderForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('index-time embed populates a vector per session when an embedder is present', async () => {
    setEmbedderForTests(fakeEmbedder());
    cache.closeDb();
    await cache.refreshIndex();
    const rows = vectorRows();
    expect(rows.length).toBe(PARAPHRASE_CORPUS.length);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['fake:test']));
    expect(rows.every((r) => r.dim === FAKE_DIM)).toBe(true);
  });

  test('paraphrase: "flaky tests" is a MISS lexical-only but a HIT when fused', async () => {
    // Lexical-only: no embedder → the semantic lane is skipped, "flaky tests"
    // shares no term with the intermittent session, so it is absent.
    setEmbedderForTests(null);
    cache.closeDb();
    const lexical = await cache.searchSessions('flaky tests');
    expect(lexical.map((r) => r.sessionId)).not.toContain('intermittent');

    // Fused: the fake embedder makes flaky≈intermittent, so the session surfaces.
    setEmbedderForTests(fakeEmbedder());
    cache.closeDb();
    const fused = await cache.searchSessions('flaky tests');
    expect(fused[0]?.sessionId).toBe('intermittent');
  });

  test('abstention: a zero-lexical, zero-semantic query returns nothing', async () => {
    setEmbedderForTests(fakeEmbedder());
    cache.closeDb();
    const out = await cache.searchSessions('kubernetes autoscaling pods');
    expect(out).toEqual([]);
  });

  test('a strong lexical hit keeps rank 1 after fusion', async () => {
    setEmbedderForTests(fakeEmbedder());
    cache.closeDb();
    const out = await cache.searchSessions('docker containers');
    expect(out[0]?.sessionId).toBe('docker');
  });

  test('model drift: swapping the embedder id re-embeds every session', async () => {
    setEmbedderForTests(fakeEmbedder('fake:test'));
    cache.closeDb();
    await cache.refreshIndex();
    expect(new Set(vectorRows().map((r) => r.model))).toEqual(new Set(['fake:test']));

    setEmbedderForTests(fakeEmbedder('fake:test-2'));
    cache.closeDb();
    await cache.refreshIndex();
    const rows = vectorRows();
    expect(rows.length).toBe(PARAPHRASE_CORPUS.length); // upsert, not duplicated
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['fake:test-2']));
  });

  test('staleness: appending to a transcript re-embeds only that session', async () => {
    setEmbedderForTests(fakeEmbedder());
    cache.closeDb();
    await cache.refreshIndex();
    const before = new Database(cache.getDbPath(), { readonly: true })
      .query<{ mtime: number }, [string]>('SELECT mtime FROM session_vectors WHERE file_path LIKE ?')
      .get('%docker.jsonl');
    expect(before).not.toBeNull();

    // Grow the transcript so mtime/size change; the vector must be recomputed.
    const path = join(tmp, 'claude', 'proj', 'docker.jsonl');
    appendFileSync(path, '\n' + j({ ...user('also fix the compose ports', at(2)), cwd: '/repo/app' }));
    cache.closeDb();
    await cache.refreshIndex();
    const vecDb = new Database(cache.getDbPath(), { readonly: true });
    const after = vecDb
      .query<{ mtime: number; size: number }, [string]>(
        'SELECT mtime, size FROM session_vectors WHERE file_path LIKE ?',
      )
      .get('%docker.jsonl');
    const row = vecDb
      .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM sessions WHERE file_path LIKE ?')
      .get('%docker.jsonl');
    vecDb.close();
    expect(after!.mtime).toBe(row!.mtime); // vector mtime tracks the (new) source mtime
    expect(after!.size).toBe(row!.size);
  });
});

// ——— absence identity: with no embedder, the eval corpus ranks exactly as the
// lexical engine always has (a representative slice of the golden expectations). ———

describe('absence identity (no embedder ⇒ lexical behavior)', () => {
  let etmp: string;
  let ecache: typeof import('../cache');

  beforeAll(async () => {
    etmp = mkdtempSync(join(tmpdir(), 'sessions-sem-abs-'));
    process.env.SESSIONS_CACHE_DIR = join(etmp, 'cache');
    process.env.SESSIONS_CLAUDE_DIR = join(etmp, 'claude');
    process.env.SESSIONS_PI_DIR = join(etmp, 'pi');
    process.env.SESSIONS_CODEX_DIR = join(etmp, 'codex');
    process.env.SESSIONS_OPENCODE_DB = join(etmp, 'opencode.db');
    process.env.SESSIONS_ARCHIVE_DIR = join(etmp, 'archive');
    process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
    mkdirSync(join(etmp, 'claude'), { recursive: true });
    mkdirSync(join(etmp, 'pi'), { recursive: true });
    const { seedEvalCorpus } = await import('../eval/corpus');
    seedEvalCorpus({ claudeDir: join(etmp, 'claude'), piDir: join(etmp, 'pi') });
    ecache = await import('../cache');
    setEmbedderForTests(null); // force the absent path even if a dev has Ollama running
    ecache.closeDb();
    await ecache.refreshIndex();
  });

  afterAll(() => {
    ecache.closeDb();
    clearEmbedderForTests();
    rmSync(etmp, { recursive: true, force: true });
  });

  test('lexical goldens rank as before, and negatives still abstain', async () => {
    const docker = await ecache.searchSessions('ECONNREFUSED');
    expect(docker[0]?.sessionId).toBe('docker-dev');

    const auth = await ecache.searchSessions('auth middleware');
    expect(auth[0]?.sessionId).toBe('auth-jwt');

    const neg = await ecache.searchSessions('kubernetes pod autoscaling');
    expect(neg).toEqual([]);

    // No embedder ⇒ no vectors were ever written.
    const db = new Database(ecache.getDbPath(), { readonly: true });
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM session_vectors').get();
    db.close();
    expect(count!.n).toBe(0);
  });
});
