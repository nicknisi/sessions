import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { JsonObject } from './extract-util';
import * as cache from './cache';

// searchSessions end to end over Korean, Japanese and Chinese sessions. The point of
// every case is a query the primary `porter unicode61` index cannot answer on its own:
// it keeps an unspaced run of Han/Kana/Hangul as a single token.

const j = (o: JsonObject): string => JSON.stringify(o);
const user = (text: string, t: string): JsonObject => ({
  type: 'user',
  timestamp: t,
  message: { role: 'user', content: [{ type: 'text', text }] },
  promptSource: 'typed',
});
const asst = (text: string, t: string): JsonObject => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const edit = (file_path: string, t: string): JsonObject => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] },
});
const at = (minute: number): string => `2026-07-01T10:${String(minute).padStart(2, '0')}:00Z`;

let tmp: string;

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  delete process.env.SESSIONS_PI_EXTRA_DIRS; // a developer's own extra Pi folders must not leak in
  process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1'; // dead port: keep the semantic lane off a local Ollama
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
  // The vault keeps a session served after its live file is deleted (by design); the
  // prune test below needs the file's disappearance to mean the session is gone.
  process.env.SESSIONS_ARCHIVE = '0';
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive');
  process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';
}

function sessionPath(id: string): string {
  return join(tmp, 'claude', 'proj', `${id}.jsonl`);
}

function writeSession(id: string, records: JsonObject[]): void {
  mkdirSync(join(tmp, 'claude', 'proj'), { recursive: true });
  writeFileSync(sessionPath(id), records.map((r) => j({ ...r, cwd: '/repo/app' })).join('\n'));
}

async function found(query: string): Promise<string[]> {
  const results = await cache.searchSessions(query, {});
  return results.map((r) => r.sessionId).sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cjk-'));
  setEnv();
  writeSession('ko', [
    user('오늘은 React에서 세션 검색을 pnpm으로 설치했다', at(0)),
    asst('데이터베이스 마이그레이션 오류를 고쳤다', at(1)),
  ]);
  writeSession('ja', [user('Reactを使って全文検索機能を作る', at(0)), asst('セッション管理を実装した', at(1))]);
  writeSession('zh', [user('数据库迁移失败，请重试', at(0)), asst('会话搜索测试已经通过', at(1))]);
  writeSession('en', [user('refactoring the cache layer', at(0))]);
  // Only the file NAME is Korean: nothing in any message, so only the session-level
  // paths column can answer for it.
  writeSession('path', [user('update the docs', at(0)), edit('/repo/문서/세션관리.md', at(1))]);
  cache.closeDb();
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  delete process.env.SESSIONS_ARCHIVE; // set by setEnv; later files in this process rely on the default
  rmSync(tmp, { recursive: true, force: true });
});

describe('searchSessions over CJK text', () => {
  test('a Korean stem finds the inflected word and localizes the hit to its message', async () => {
    const results = await cache.searchSessions('검색', {});
    expect(results.map((r) => r.sessionId)).toEqual(['ko']);
    const hit = results[0]?.messageHits?.[0];
    expect(hit?.index).toBe(0);
    expect(hit?.role).toBe('user');
    expect(hit?.snippet).toContain('검색');
  });

  test('a Latin word glued to CJK particles is found', async () => {
    expect(await found('React')).toEqual(['ja', 'ko']);
  });

  test('Japanese and Chinese words are found inside unspaced sentences', async () => {
    expect(await found('検索')).toEqual(['ja']);
    expect(await found('搜索')).toEqual(['zh']);
    expect(await found('迁移')).toEqual(['zh']);
  });

  test('an assistant-side hit is found as well as a user-side one', async () => {
    expect(await found('마이그레이션')).toEqual(['ko']);
  });

  test('a session is findable by the CJK name of a file it edited', async () => {
    const results = await cache.searchSessions('세션관리', {});
    expect(results.map((r) => r.sessionId)).toEqual(['path']);
  });

  test('a one-character query reaches the end of a word', async () => {
    expect(await found('션')).toEqual(['ko', 'path']);
  });

  test('a query with no match abstains', async () => {
    expect(await found('없는말')).toEqual([]);
  });

  test('CJK and English terms combine with OR recall', async () => {
    expect(await found('검색 refactor')).toEqual(['en', 'ko']);
  });
});

describe('index maintenance', () => {
  function cjkRows(table: 'message_cjk_fts' | 'session_cjk_fts', id: string): number {
    const db = new Database(cache.getDbPath(), { readonly: true });
    try {
      const row = db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE file_path = ?`)
        .get(sessionPath(id));
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  }

  test('a session with no CJK text adds nothing to the CJK tables', async () => {
    await found('anything'); // refresh
    expect(cjkRows('message_cjk_fts', 'en')).toBe(0);
    expect(cjkRows('session_cjk_fts', 'en')).toBe(0);
    expect(cjkRows('message_cjk_fts', 'ko')).toBeGreaterThan(0);
  });

  test('a rewritten session drops its old CJK terms and a deleted one leaves none', async () => {
    writeSession('life', [user('임시검색어가 들어간 문장', at(0))]);
    expect(await found('임시검색어')).toEqual(['life']);

    writeSession('life', [user('교체된문장만 남았다 그리고 더 길어졌다', at(0))]);
    utimesSync(sessionPath('life'), new Date(), new Date(Date.now() + 5_000));
    expect(await found('임시검색어')).toEqual([]);
    expect(await found('교체된문장')).toEqual(['life']);

    unlinkSync(sessionPath('life'));
    expect(await found('교체된문장')).toEqual([]);
    expect(cjkRows('message_cjk_fts', 'life')).toBe(0);
  });
});
