// The remote embedder suite: the openai and tei clients (wire format, response
// reordering, config matrix, failure cooldown, query-time timeout) plus one
// end-to-end fusion test that drives searchSessions through a real in-process
// OpenAI-compatible server. Nothing here touches the network beyond 127.0.0.1.

import { test, expect, describe, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type * as CacheModule from '../cache';
import { cosine, abstentionThreshold } from './fuse';
import {
  detectEmbedder,
  embedQuery,
  clearEmbedderForTests,
  setEmbedderClockForTests,
  setEmbedderForTests,
  OpenAIEmbedder,
  TeiEmbedder,
} from './embed';

// ——— fake servers and fetch stubs ———

interface FakeServer {
  port: number;
  stop: () => void;
}

/** A real HTTP server on a random loopback port. The handler sees the raw body so
 *  each test can assert the exact wire format. */
function startServer(handle: (req: Request, body: string) => Response | Promise<Response>): FakeServer {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => handle(req, await req.text()),
  });
  const port = server.port;
  if (port === undefined) throw new Error('fake server did not bind a port');
  return { port, stop: () => server.stop(true) };
}

function json<T>(value: T): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A fetch stub that honors the AbortController signal the way a real fetch does,
 *  so the timeout path is exercised without a socket. */
function hungFetch(): typeof fetch {
  const handler = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return Object.assign(handler, { preconnect: (): void => {} });
}

// ——— env hygiene: every test starts from the developer's real environment ———

const GUARDED_ENV = [
  'SESSIONS_EMBED_PROVIDER',
  'SESSIONS_EMBED_URL',
  'SESSIONS_EMBED_MODEL',
  'SESSIONS_EMBED_API_KEY',
  'SESSIONS_EMBED_THRESHOLD',
  'OPENAI_API_KEY',
  'SESSIONS_OLLAMA_URL',
];

let savedEnv: Map<string, string | undefined>;
const pendingRestores: Array<() => void> = [];

beforeEach(() => {
  savedEnv = new Map(GUARDED_ENV.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const restore of pendingRestores.splice(0)) restore();
  clearEmbedderForTests();
  setEmbedderClockForTests(null);
});

/** Stub stderr for the duration of one test; the returned array fills as the code
 *  under test writes, and restore() is registered for the shared afterEach. */
function captureStderr(): string[] {
  const warnings: string[] = [];
  const real = process.stderr.write;
  const sink = (chunk: string | Uint8Array, cb?: () => void): boolean => {
    warnings.push(String(chunk));
    cb?.();
    return true;
  };
  // SAFETY: the stub implements only the (chunk, cb) overload the warnings use.
  process.stderr.write = sink as typeof process.stderr.write;
  pendingRestores.push(() => {
    process.stderr.write = real;
  });
  return warnings;
}

// ——— openai wire format ———

describe('openai embedder', () => {
  test('posts model, input and encoding_format with a Bearer key, and reorders by index', async () => {
    const seen: string[] = [];
    let received: string | undefined;
    const server = startServer((req, body) => {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get('authorization')}`);
      received = body;
      // Deliberately out of order: the client must sort by `index`, not trust order.
      return json({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      });
    });
    try {
      const embedder = new OpenAIEmbedder('m', `http://127.0.0.1:${server.port}/v1`, 'secret');
      expect(embedder.id).toBe('openai:m');
      expect(await embedder.embed(['first', 'second'])).toEqual([
        [1, 1],
        [9, 9],
      ]);
      expect(seen).toEqual(['POST /v1/embeddings Bearer secret']);
      expect(JSON.parse(received!)).toEqual({ model: 'm', input: ['first', 'second'], encoding_format: 'float' });
    } finally {
      server.stop();
    }
  });

  test('omits the Authorization header when no key is configured', async () => {
    let auth: string | null = 'unset';
    const server = startServer((req) => {
      auth = req.headers.get('authorization');
      return json({ data: [{ index: 0, embedding: [1] }] });
    });
    try {
      await new OpenAIEmbedder('m', `http://127.0.0.1:${server.port}/v1`, undefined).embed(['x']);
      expect(auth).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('rejects a non-200, a count mismatch, an empty vector, and a duplicate index', async () => {
    const withStatus = startServer(() => new Response('nope', { status: 500 }));
    const mismatched = startServer(() => json({ data: [{ index: 0, embedding: [1] }] }));
    const empty = startServer(() => json({ data: [{ index: 0, embedding: [] }] }));
    const duplicated = startServer(() =>
      json({
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [2] },
        ],
      }),
    );
    const openai = (port: number): OpenAIEmbedder => new OpenAIEmbedder('m', `http://127.0.0.1:${port}/v1`, 'k');
    try {
      await expect(openai(withStatus.port).embed(['a'])).rejects.toThrow(/http 500/);
      await expect(openai(mismatched.port).embed(['a', 'b'])).rejects.toThrow(/malformed/);
      await expect(openai(empty.port).embed(['a'])).rejects.toThrow(/empty embedding/);
      await expect(openai(duplicated.port).embed(['a', 'b'])).rejects.toThrow(/malformed/);
    } finally {
      for (const server of [withStatus, mismatched, empty, duplicated]) server.stop();
    }
  });
});

// ——— tei wire format ———

describe('tei embedder', () => {
  test('posts inputs with truncate and reads a bare array of vectors', async () => {
    let received: string | undefined;
    const authHeaders: Array<string | null> = [];
    const server = startServer((req, body) => {
      received = body;
      authHeaders.push(req.headers.get('authorization'));
      return json([
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });
    try {
      const embedder = new TeiEmbedder('intfloat/multilingual-e5-small', `http://127.0.0.1:${server.port}`, 'tei-key');
      expect(embedder.id).toBe('tei:intfloat/multilingual-e5-small');
      expect(await embedder.embed(['가', '나'])).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ]);
      expect(JSON.parse(received!)).toEqual({ inputs: ['가', '나'], truncate: true });
      expect(authHeaders).toEqual(['Bearer tei-key']);
    } finally {
      server.stop();
    }
  });

  test('rejects a non-200 and a count mismatch', async () => {
    const bad = startServer(() => new Response('boom', { status: 503 }));
    const short = startServer(() => json([[1]]));
    try {
      await expect(new TeiEmbedder('m', `http://127.0.0.1:${bad.port}`, undefined).embed(['a'])).rejects.toThrow(
        /http 503/,
      );
      await expect(new TeiEmbedder('m', `http://127.0.0.1:${short.port}`, undefined).embed(['a', 'b'])).rejects.toThrow(
        /malformed/,
      );
    } finally {
      bad.stop();
      short.stop();
    }
  });
});

// ——— provider configuration matrix ———

describe('detectEmbedder provider matrix', () => {
  test('an unknown provider disables the lane and warns exactly once', async () => {
    const warnings = captureStderr();
    process.env.SESSIONS_EMBED_PROVIDER = 'cohere';
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull(); // warnOnce: the same message is not repeated
    expect(warnings.filter((w) => w.includes('cohere'))).toHaveLength(1);
  });

  test('an invalid URL disables the lane and warns', async () => {
    const warnings = captureStderr();
    process.env.SESSIONS_EMBED_PROVIDER = 'openai';
    process.env.SESSIONS_EMBED_URL = 'ftp://example.com';
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
    expect(warnings.filter((w) => w.includes('not a valid http(s) URL'))).toHaveLength(1);
  });

  test('the default OpenAI endpoint needs a key; OPENAI_API_KEY stands in', async () => {
    const warnings = captureStderr();
    process.env.SESSIONS_EMBED_PROVIDER = 'openai';
    delete process.env.SESSIONS_EMBED_URL;
    delete process.env.SESSIONS_EMBED_API_KEY;
    delete process.env.OPENAI_API_KEY;
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
    expect(warnings.filter((w) => w.includes('needs an API key'))).toHaveLength(1);

    process.env.OPENAI_API_KEY = 'sk-from-env';
    clearEmbedderForTests();
    const embedder = await detectEmbedder();
    expect(embedder?.id).toBe('openai:text-embedding-3-small');
  });

  test('a custom URL needs no key and never borrows OPENAI_API_KEY', async () => {
    let auth: string | null = 'unset';
    const server = startServer((req) => {
      auth = req.headers.get('authorization');
      return json({ data: [{ index: 0, embedding: [1] }] });
    });
    const warnings = captureStderr();
    try {
      process.env.SESSIONS_EMBED_PROVIDER = 'openai';
      process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${server.port}/v1`;
      process.env.SESSIONS_EMBED_MODEL = 'local-model';
      delete process.env.SESSIONS_EMBED_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-must-not-leak';
      clearEmbedderForTests();
      const embedder = await detectEmbedder();
      expect(embedder?.id).toBe('openai:local-model');
      expect(warnings).toEqual([]);
      // Detection for openai is config-only: no request until the first embed.
      expect(auth).toBe('unset');
      await embedder!.embed(['x']);
      expect(auth).toBeNull(); // no Bearer: the borrowed key is not sent to a custom host
    } finally {
      server.stop();
    }
  });

  test('tei probe: down, 5xx and malformed all degrade to null; /info names the model', async () => {
    process.env.SESSIONS_EMBED_PROVIDER = 'tei';

    // Down: a dead loopback port.
    process.env.SESSIONS_EMBED_URL = 'http://127.0.0.1:1';
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();

    const boom = startServer(() => new Response('down', { status: 503 }));
    process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${boom.port}`;
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
    boom.stop();

    const junk = startServer(() => json({ nope: true }));
    process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${junk.port}`;
    clearEmbedderForTests();
    expect(await detectEmbedder()).toBeNull();
    junk.stop();

    let infoCalls = 0;
    const ok = startServer(() => {
      infoCalls++;
      return json({ model_id: 'BAAI/bge-small-en-v1.5' });
    });
    process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${ok.port}`;
    clearEmbedderForTests();
    const embedder = await detectEmbedder();
    expect(embedder?.id).toBe('tei:BAAI/bge-small-en-v1.5');
    await detectEmbedder();
    expect(infoCalls).toBe(1); // probe cached per process
    ok.stop();
  });
});

// ——— failure cooldown and query-time timeout ———

describe('remote failure handling', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a failed embed trips a cooldown; further calls skip the network until it elapses', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        calls++;
        throw new Error('ECONNREFUSED');
      },
      { preconnect: (): void => {} },
    );
    let now = 1_000_000;
    setEmbedderClockForTests(() => now);
    const embedder = new OpenAIEmbedder('m', 'http://127.0.0.1:9/v1', 'k');

    await expect(embedder.embed(['a'])).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(1);

    // Still cooling down: throws without touching the network.
    await expect(embedder.embed(['a'])).rejects.toThrow(/cooling down/);
    expect(calls).toBe(1);

    now += 61_000; // past FAILURE_COOLDOWN_MS
    await expect(embedder.embed(['a'])).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(2);
  });

  test('the query path gives up faster than the indexing timeout', async () => {
    globalThis.fetch = hungFetch();
    const embedder = new OpenAIEmbedder('m', 'http://127.0.0.1:9/v1', 'k');
    const started = Date.now();
    // Null is a fine outcome; the point is that it resolves at all, well inside the
    // 10 s indexing timeout, so an interactive search is never stalled.
    expect(await embedQuery(embedder, 'flaky tests')).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ——— threshold override ———

describe('abstention threshold', () => {
  test('reads SESSIONS_EMBED_THRESHOLD only when it is a number inside (0, 1)', () => {
    expect(abstentionThreshold({})).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '0.7' })).toBe(0.7);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '0.86' })).toBe(0.86);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '' })).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: 'abc' })).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '0' })).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '1' })).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '-0.2' })).toBe(0.45);
    expect(abstentionThreshold({ SESSIONS_EMBED_THRESHOLD: '1.5' })).toBe(0.45);
  });
});

// ——— end-to-end fusion through a real (fake-vocabulary) HTTP embedder ———

// A 4-dimensional concept map: texts about the same concept land on the same axis,
// so "flaky tests" is cosine-close to the intermittent-CI session and orthogonal to
// the others. Mirrors the deterministic fake embedder in semantic.test.ts but goes
// over HTTP so the real client, detection, and fusion paths are all exercised.
const AXIS: Map<string, number> = new Map([
  ['flaky', 0],
  ['flakiness', 0],
  ['intermittent', 0],
  ['random', 0],
  ['test', 1],
  ['tests', 1],
  ['testing', 1],
  ['ci', 1],
  ['failures', 1],
  ['failure', 1],
  ['docker', 2],
  ['container', 2],
  ['containers', 2],
  ['compose', 2],
  ['invoice', 3],
  ['pdf', 3],
  ['export', 3],
]);
const AXES = 4;

function axisVector(text: string): number[] {
  const vec = Array.from<number>({ length: AXES }).fill(0);
  for (const token of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const axis = AXIS.get(token);
    if (axis !== undefined) vec[axis]! += 1;
  }
  return vec;
}

interface CorpusSession {
  id: string;
  text: string;
}

const E2E_CORPUS: CorpusSession[] = [
  { id: 'intermittent', text: 'the ci keeps breaking at random with intermittent failures' },
  { id: 'docker', text: 'set up docker containers with compose for local dev' },
  { id: 'invoice', text: 'the invoice pdf export is missing a total row' },
];

interface UserRecord {
  type: 'user';
  timestamp: string;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  promptSource: 'typed';
}

let e2eTmp: string;
let e2eCache: typeof CacheModule;

function seedCorpus(dir: string, corpus: CorpusSession[]): void {
  const projectDir = join(dir, 'claude', 'proj');
  mkdirSync(projectDir, { recursive: true });
  for (const session of corpus) {
    const record: UserRecord & { cwd: string } = {
      type: 'user',
      timestamp: '2026-07-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: session.text }] },
      promptSource: 'typed',
      cwd: '/repo/app',
    };
    writeFileSync(join(projectDir, `${session.id}.jsonl`), JSON.stringify(record));
  }
}

function setCacheEnv(root: string): void {
  process.env.SESSIONS_CACHE_DIR = join(root, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(root, 'claude');
  process.env.SESSIONS_PI_DIR = join(root, 'pi');
  delete process.env.SESSIONS_PI_EXTRA_DIRS;
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1'; // dead port: never reach a local Ollama
  process.env.SESSIONS_CODEX_DIR = join(root, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(root, 'opencode.db');
  process.env.SESSIONS_ARCHIVE_DIR = join(root, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

function vectorModels(): Array<{ model: string; dim: number }> {
  const db = new Database(e2eCache.getDbPath(), { readonly: true });
  const rows = db.query<{ model: string; dim: number }, []>('SELECT model, dim FROM session_vectors').all();
  db.close();
  return rows;
}

describe('remote semantic fusion (end to end)', () => {
  const servers: FakeServer[] = [];

  beforeAll(async () => {
    e2eTmp = mkdtempSync(join(tmpdir(), 'sessions-remote-'));
    mkdirSync(join(e2eTmp, 'claude'), { recursive: true });
    seedCorpus(e2eTmp, E2E_CORPUS);
    setCacheEnv(e2eTmp);
    // Dynamic on purpose: the cache module resolves its paths from the env at first
    // load, so it must stay unimported until setCacheEnv() has run.
    e2eCache = await import('../cache');
    e2eCache.closeDb();
  });

  afterAll(() => {
    for (const server of servers) server.stop();
    e2eCache.closeDb();
    clearEmbedderForTests();
    rmSync(e2eTmp, { recursive: true, force: true });
  });

  test('absence: no provider env leaves lexical results untouched', async () => {
    delete process.env.SESSIONS_EMBED_PROVIDER;
    setEmbedderForTests(null); // the forced-absence path, whatever the developer's shell holds
    e2eCache.closeDb();
    await e2eCache.refreshIndex();
    const lexical = await e2eCache.searchSessions('flaky tests');
    expect(lexical).toEqual([]); // no shared term: lexical alone cannot find it
    expect(vectorModels()).toEqual([]); // and nothing was embedded
  });

  test('a remote embedder indexes vectors and fuses a paraphrase hit', async () => {
    const server = startServer((_req, body) => {
      const parsed: { input: string[] } = JSON.parse(body);
      return json({ data: parsed.input.map((text, index) => ({ index, embedding: axisVector(text) })) });
    });
    servers.push(server);

    process.env.SESSIONS_EMBED_PROVIDER = 'openai';
    process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.SESSIONS_EMBED_MODEL = 'fake-embed-small';
    delete process.env.SESSIONS_EMBED_API_KEY;
    clearEmbedderForTests();
    e2eCache.closeDb();
    await e2eCache.refreshIndex();

    expect(vectorModels()).toEqual(E2E_CORPUS.map(() => ({ model: 'openai:fake-embed-small', dim: AXES })));
    const fused = await e2eCache.searchSessions('flaky tests');
    expect(fused[0]?.sessionId).toBe('intermittent');
  });

  test('a swapped model re-embeds, and a remote provider yielding no hits stays byte-identical', async () => {
    // Baseline as the absent lane sees it.
    setEmbedderForTests(null);
    e2eCache.closeDb();
    await e2eCache.refreshIndex();
    const lexical = JSON.stringify(await e2eCache.searchSessions('docker containers'));
    expect(lexical).toContain('docker');

    // A provider returning the zero vector: every similarity is 0, below the
    // threshold, so the lane contributes nothing and the lexical ordering stands.
    const zeros = startServer((_req, body) => {
      const parsed: { input: string[] } = JSON.parse(body);
      const zero = Array.from<number>({ length: AXES }).fill(0);
      return json({ data: parsed.input.map((_text, index) => ({ index, embedding: zero })) });
    });
    servers.push(zeros);

    process.env.SESSIONS_EMBED_PROVIDER = 'openai';
    process.env.SESSIONS_EMBED_URL = `http://127.0.0.1:${zeros.port}/v1`;
    process.env.SESSIONS_EMBED_MODEL = 'fake-zero'; // a new id forces a re-embed
    clearEmbedderForTests();
    e2eCache.closeDb();
    await e2eCache.refreshIndex();

    expect(new Set(vectorModels().map((row) => row.model))).toEqual(new Set(['openai:fake-zero']));
    expect(JSON.stringify(await e2eCache.searchSessions('docker containers'))).toBe(lexical);
  });

  test('the fake embedding behaves as the fusion math expects', () => {
    const flaky = Float32Array.from(axisVector('flaky tests'));
    const intermittent = Float32Array.from(axisVector('intermittent ci failures'));
    const invoice = Float32Array.from(axisVector('invoice pdf export'));
    expect(cosine(flaky, intermittent)).toBeGreaterThan(0.9);
    expect(cosine(flaky, invoice)).toBe(0);
  });
});
