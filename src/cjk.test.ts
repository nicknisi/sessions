import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cjkIndexText, cjkQuery, cjkSnippet, hasCjk } from './cjk';

// These tests index through a real FTS5 table with the production tokenizer rather
// than asserting on the token strings, so they pin what a user can find, not how.
function indexOf(docs: Record<string, string>): Database {
  const db = new Database(':memory:');
  db.run("CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, cjk, tokenize = 'porter unicode61')");
  const insert = db.query('INSERT INTO t (id, cjk) VALUES (?, ?)');
  for (const [id, text] of Object.entries(docs)) {
    const cjk = cjkIndexText(text);
    if (cjk !== '') insert.run(id, cjk);
  }
  return db;
}

function hits(db: Database, terms: string[]): string[] {
  const match = cjkQuery(terms);
  if (match === '') return [];
  return db
    .query<{ id: string }, [string]>('SELECT id FROM t WHERE t MATCH ? ORDER BY id')
    .all(match)
    .map((r) => r.id);
}

const DOCS = {
  ko: '오늘은 React에서 세션 검색을 pnpm으로 설치했다',
  ja: 'Reactを使って全文検索機能を作る',
  kana: 'セッション管理',
  zh: '数据库迁移失败，会话搜索测试',
  // macOS hands out decomposed Hangul in file names; people type it composed.
  mac: '세션관리'.normalize('NFD'),
} satisfies Record<string, string>;

describe('what the CJK lane can find', () => {
  const db = indexOf(DOCS);

  const cases: Array<[string, string[], string[]]> = [
    ['an inflected Korean word, by its stem', ['검색'], ['ko']],
    ['the inflected form itself', ['검색을'], ['ko']],
    ['a two-character Chinese word inside a sentence', ['搜索'], ['zh']],
    ['a Japanese compound by its tail', ['検索'], ['ja']],
    ['the whole Japanese compound', ['全文検索'], ['ja']],
    ['a Latin word glued to Korean and Japanese particles', ['React'], ['ja', 'ko']],
    ['a Latin word glued to a Korean particle', ['pnpm'], ['ko']],
    ['Katakana, which has no spaces either', ['セッション'], ['kana']],
    ['half-width Katakana as the same word', ['ｾｯｼｮﾝ'], ['kana']],
    ['decomposed Hangul from a file name', ['세션관리'], ['mac']],
    ['a one-character query, as a prefix of any word it begins', ['검'], ['ko']],
    ['a one-character query reaching a word-final character', ['션'], ['ko', 'mac']],
    ['any term of several, across scripts', ['검색', '搜索'], ['ko', 'zh']],
    ['a pair of characters that is not in any document', ['없는말'], []],
    ['the right characters in the wrong order', ['색검'], []],
  ];

  for (const [name, terms, expected] of cases) {
    test(name, () => {
      expect(hits(db, terms)).toEqual(expected);
    });
  }

  test('text with no CJK produces nothing to index', () => {
    expect(cjkIndexText('refactoring the cache layer')).toBe('');
    expect(hasCjk('refactoring the cache layer')).toBe(false);
  });

  test('FTS5 syntax in a query is inert, so a CJK term never throws', () => {
    const hostile: Array<[string, string[]]> = [
      ['검색*', ['ko']],
      ['검색(', ['ko']],
      ['"검색"', ['ko']],
      ['^검색', ['ko']],
      ['col:검색', ['ko']],
      ['NEAR/3 검색', ['ko']],
      ['AND', []],
    ];
    for (const [term, expected] of hostile) expect(hits(db, [term])).toEqual(expected);
    expect(hits(db, ['검색', 'OR'])).toEqual(['ko']);
  });
});

describe('cjkSnippet', () => {
  test('centers on the first query term and marks both truncated ends', () => {
    const text = `${'가'.repeat(300)} 검색 결과 ${'나'.repeat(300)}`;
    const snippet = cjkSnippet(text, ['검색']);
    expect(snippet).toContain('검색');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(150);
  });

  test('falls back to the start of the text when no term appears verbatim', () => {
    expect(cjkSnippet('세션 검색', ['ｾｯｼｮﾝ'])).toBe('세션 검색');
  });

  test('never splits a surrogate pair at either cut', () => {
    // Han extension B characters are two UTF-16 units each.
    const text = `${'𠮷'.repeat(80)}検索${'𠮷'.repeat(80)}`;
    const snippet = cjkSnippet(text, ['検索']);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(snippet).toContain('検索');
    expect(loneSurrogate.test(snippet)).toBe(false);
  });
});
