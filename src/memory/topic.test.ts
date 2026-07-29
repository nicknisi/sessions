import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildRecord } from './record';
import { activeMemoryFor } from './retrieve';
import { getMemoryDb, setAlwaysOn, setState, upsertCandidates } from './store';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';
import { matchTopic, TOPIC_THRESHOLD, tokenize } from './topic';
import type { MemoryRecord, MemoryScope } from './types';

// Two halves, deliberately separated.
//
// `matchTopic` is a pure function of two strings, so the first half needs no database
// at all — that is the whole reason src/memory/topic.ts imports nothing. The scoring
// failure mode is silence (a memory that does not come back raises no error anywhere),
// so every case here asserts a number rather than "it worked".
//
// The second half needs the store, and takes the same hermetic treatment as
// src/memory/mcp-memory.test.ts:95-120 — env re-asserted per test, handle dropped, table
// truncated — because store.ts is one shared module instance across a `bun test` run.

const REPO: MemoryScope = { type: 'repo', key: '/repos/app' };
const WORKFLOW: MemoryScope = { type: 'workflow', key: '' };

const KEYCHAIN_TEXT = 'API keys are stored in the keychain when available';

describe('tokenize', () => {
  test('lowercases, splits on punctuation, and drops function words', () => {
    expect([...tokenize('The API keys, and the Keychain!')].sort()).toEqual(['api', 'key', 'keychain']);
  });

  test('an apostrophe splits the way unicode61 does, leaving no orphan fragments', () => {
    // "don't" -> don + t inside FTS5 (src/memory/mine.ts:39-42). `t` is below the
    // length floor and `don` is a stopword, so neither survives as a content token.
    expect([...tokenize("don't rewrite it")]).toEqual(['rewrit']);
    expect(tokenize("don't")).toEqual(new Set());
  });

  test('a repeated word contributes one token, so it cannot inflate a denominator', () => {
    expect(tokenize('cache cache caches cached').size).toBe(1);
  });

  test('a stem is never shortened past the point of matching everything', () => {
    // Stripping -s from a two-letter word leaves one character.
    expect([...tokenize('css is os')]).toEqual(['css', 'os']);
  });
});

describe('matchTopic', () => {
  test('a topic sharing a content word with the memory scores above the threshold', () => {
    expect(matchTopic(KEYCHAIN_TEXT, 'add keychain support')).toBeGreaterThan(TOPIC_THRESHOLD);
  });

  test('an unrelated topic scores below the threshold', () => {
    expect(matchTopic(KEYCHAIN_TEXT, 'refactor the CSS grid')).toBeLessThan(TOPIC_THRESHOLD);
  });

  test('stemming relates serialization to serialized', () => {
    // The headline stemming case. A three-suffix stripper (-ing/-ed/-s) scores this 0:
    // neither word ends in any of them.
    expect(matchTopic('start from the serialized struct', 'serialization')).toBe(1);
  });

  test('stemming is symmetric, so an inflected pair never misses in one direction', () => {
    expect(matchTopic('the value is stored on disk', 'store')).toBe(1);
    expect(matchTopic('the value is store on disk', 'stored')).toBe(1);
    expect(matchTopic('run the migrations first', 'migrate')).toBe(1);
    expect(matchTopic('refactoring the parser', 'refactor')).toBe(1);
  });

  test('an empty or whitespace topic returns 1, disabling the filter', () => {
    expect(matchTopic(KEYCHAIN_TEXT, '')).toBe(1);
    expect(matchTopic(KEYCHAIN_TEXT, '   ')).toBe(1);
  });

  test('a topic made entirely of stopwords returns 1 rather than NaN', () => {
    // 0/0 is NaN, and `NaN >= TOPIC_THRESHOLD` is false — which would silently drop
    // every conditional memory. A matcher that cannot form an opinion must abstain.
    const score = matchTopic(KEYCHAIN_TEXT, 'the and it');
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBe(1);
  });

  test('an empty memory text scores 0 rather than NaN', () => {
    expect(matchTopic('', 'add keychain support')).toBe(0);
  });

  test('the score is bounded in [0, 1] at both ends', () => {
    expect(matchTopic(KEYCHAIN_TEXT, 'keychain keys stored available')).toBe(1);
    expect(matchTopic(KEYCHAIN_TEXT, 'kubernetes helm chart')).toBe(0);
  });

  test('is deterministic across calls', () => {
    const a = matchTopic(KEYCHAIN_TEXT, 'add keychain support to the CLI');
    const b = matchTopic(KEYCHAIN_TEXT, 'add keychain support to the CLI');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Retrieval: topic narrowing and the always-on bypass.
// ---------------------------------------------------------------------------

function record(text: string, scope: MemoryScope): MemoryRecord {
  return buildRecord({
    text,
    scope,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

const KEYCHAIN = record(KEYCHAIN_TEXT, REPO);
const MIGRATIONS = record('Always run the migrations before starting the dev server', REPO);
const CANARY = record('Canary is the mainline branch on every repo here', WORKFLOW);
const LOCKFILE = record('Never rewrite the lockfile by hand, run the installer', REPO);

let tmp: string;

beforeAll(() => {
  tmp = makeTmp('memory-topic');
  setMemoryEnv(tmp);
  closeDatabases();
});

beforeEach(() => {
  setMemoryEnv(tmp);
  closeDatabases();
  getMemoryDb().run('DELETE FROM memory');
  upsertCandidates([KEYCHAIN, MIGRATIONS, CANARY, LOCKFILE]);
  for (const r of [KEYCHAIN, MIGRATIONS, CANARY, LOCKFILE]) setState(r.id, 'approved');
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

function texts(records: MemoryRecord[]): string[] {
  return records.map((r) => r.text);
}

describe('activeMemoryFor with a topic', () => {
  test('an omitted topic returns the full active set in the Phase 3 order', () => {
    const out = activeMemoryFor('/repos/app');
    expect(out.map((r) => r.scope.type)).toEqual(['workflow', 'repo', 'repo', 'repo']);
    const repoIds = out.filter((r) => r.scope.type === 'repo').map((r) => r.id);
    expect(repoIds).toEqual([...repoIds].sort());
  });

  test('an empty-string topic is treated as no topic at all', () => {
    expect(texts(activeMemoryFor('/repos/app', ''))).toEqual(texts(activeMemoryFor('/repos/app')));
    expect(texts(activeMemoryFor('/repos/app', '   '))).toEqual(texts(activeMemoryFor('/repos/app')));
  });

  test('a topic narrows the set to matching memory', () => {
    const out = texts(activeMemoryFor('/repos/app', 'add keychain support'));
    expect(out).toContain(KEYCHAIN.text);
    expect(out).not.toContain(LOCKFILE.text);
    expect(out).not.toContain(CANARY.text);
  });

  test('matching memory rank above weakly matching ones', () => {
    // "migrations before the dev server" hits MIGRATIONS on three tokens and KEYCHAIN
    // on none.
    const out = texts(activeMemoryFor('/repos/app', 'run the migrations on the dev server'));
    expect(out[0]).toBe(MIGRATIONS.text);
    expect(out).not.toContain(KEYCHAIN.text);
  });

  test('a topic matching nothing returns an empty array, not the whole set', () => {
    expect(activeMemoryFor('/repos/app', 'kubernetes helm chart rollout')).toEqual([]);
  });

  test('two identical calls produce byte-identical output', () => {
    const first = JSON.stringify(activeMemoryFor('/repos/app', 'add keychain support'));
    const second = JSON.stringify(activeMemoryFor('/repos/app', 'add keychain support'));
    expect(second).toBe(first);
  });
});

describe('the always-on bypass', () => {
  test('an always-on memory returns for a topic it shares no words with, and sorts first', () => {
    setAlwaysOn(CANARY.id, true);
    const out = texts(activeMemoryFor('/repos/app', 'add keychain support'));
    expect(out[0]).toBe(CANARY.text);
    expect(out).toContain(KEYCHAIN.text);
  });

  test('an always-on memory sorts ahead of a matching memory of the same scope', () => {
    setAlwaysOn(LOCKFILE.id, true);
    const out = texts(activeMemoryFor('/repos/app', 'add keychain support'));
    expect(out).toEqual([LOCKFILE.text, KEYCHAIN.text]);
  });

  test('an always-on memory is the only thing left when the topic matches nothing else', () => {
    setAlwaysOn(CANARY.id, true);
    expect(texts(activeMemoryFor('/repos/app', 'kubernetes helm chart rollout'))).toEqual([CANARY.text]);
  });

  test('always-on bypasses the matcher, never the state filter', () => {
    setAlwaysOn(LOCKFILE.id, true);
    setState(LOCKFILE.id, 'rejected');
    expect(texts(activeMemoryFor('/repos/app', 'add keychain support'))).not.toContain(LOCKFILE.text);
    expect(texts(activeMemoryFor('/repos/app'))).not.toContain(LOCKFILE.text);
  });

  test('always-on bypasses the matcher, never the scope filter', () => {
    // "Always" means "regardless of the topic", not "for every repo".
    setAlwaysOn(KEYCHAIN.id, true);
    expect(texts(activeMemoryFor('/repos/other', 'add keychain support'))).not.toContain(KEYCHAIN.text);
  });

  test('the always-on flag survives a re-mine', () => {
    // upsertCandidates excludes always_on from its ON CONFLICT: buildRecord defaults it
    // to false, so including it would clear a standing constraint on every mine.
    setAlwaysOn(CANARY.id, true);
    upsertCandidates([record(CANARY.text, WORKFLOW)]);
    expect(texts(activeMemoryFor('/repos/app', 'kubernetes helm chart'))).toEqual([CANARY.text]);
  });
});
