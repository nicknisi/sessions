import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  opencodeFilePath,
  isOpencodePath,
  sessionIdFromPath,
  discoverOpencodeSessions,
  opencodeStat,
  readOpencodeSession,
  collectOpencodeSubagentText,
  closeOpencodeDb,
} from './opencode';
import { readSessionLines } from './session-io';
import { getCwdFromSession, firstPrompt, customTitle, messageCount } from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import type { JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
let dbPath: string;

// A minimal OpenCode DB with the exact columns src/opencode.ts and the report parser read.
function buildFixtureDb(path: string): void {
  const db = new Database(path);
  db.run(
    'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)',
  );
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');

  const session = db.query(
    'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const message = db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  const part = db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');

  // Parent session: a real (non-placeholder) title, a user turn, and an assistant turn
  // whose parts cover every synthesized block type.
  session.run('ses_parent', 'p1', null, '/repo/app', 'Refactor the router', 1000, 2000);
  message.run('msg_u1', 'ses_parent', 1100, j({ role: 'user', time: { created: 1100 } }));
  part.run('prt_u1', 'msg_u1', 'ses_parent', 1100, j({ type: 'text', text: 'please refactor the router lazerhawk' }));
  message.run(
    'msg_a1',
    'ses_parent',
    1500,
    j({
      role: 'assistant',
      time: { created: 1500 },
      modelID: 'claude-opus-4-6',
      providerID: 'anthropic',
      cost: 0.05,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 30 } },
    }),
  );
  part.run('prt_a1', 'msg_a1', 'ses_parent', 1500, j({ type: 'reasoning', text: 'thinking about zorptastic' }));
  part.run('prt_a2', 'msg_a1', 'ses_parent', 1501, j({ type: 'text', text: 'Done refactoring' }));
  part.run(
    'prt_a3',
    'msg_a1',
    'ses_parent',
    1502,
    j({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' } } }),
  );
  part.run(
    'prt_a4',
    'msg_a1',
    'ses_parent',
    1503,
    j({ type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/repo/app/router.ts' } } }),
  );
  part.run(
    'prt_a5',
    'msg_a1',
    'ses_parent',
    1504,
    j({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/repo/app/old.ts' } } }),
  );
  part.run('prt_a6', 'msg_a1', 'ses_parent', 1505, j({ type: 'patch', files: ['/repo/app/router.ts'] }));
  part.run(
    'prt_a7',
    'msg_a1',
    'ses_parent',
    1506,
    j({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'x' }, error: 'boom quux' } }),
  );

  // Subagent (child) session — folds into the parent for recall, never listed on its own.
  session.run('ses_child', 'p1', 'ses_parent', '/repo/app', 'Explore (@explore subagent)', 1200, 1400);
  message.run('msg_u2', 'ses_child', 1200, j({ role: 'user', time: { created: 1200 } }));
  part.run('prt_u2', 'msg_u2', 'ses_child', 1200, j({ type: 'text', text: 'subagent secret term wibbleflorp' }));

  // Placeholder-title session — the auto "New session -" title must be dropped.
  session.run('ses_plain', 'p2', null, '/repo/other', 'New session - 2026-07-11T00:00:00.000Z', 3000, 3500);
  message.run('msg_u3', 'ses_plain', 3000, j({ role: 'user', time: { created: 3000 } }));
  part.run('prt_u3', 'msg_u3', 'ses_plain', 3000, j({ type: 'text', text: 'hello there' }));

  db.close();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-oc-'));
  dbPath = join(tmp, 'opencode.db');
  buildFixtureDb(dbPath);
  process.env.SESSIONS_OPENCODE_DB = dbPath;
  closeOpencodeDb();
});

afterAll(() => {
  closeOpencodeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('opencode module', () => {
  test('path helpers round-trip and detect OpenCode paths', () => {
    const p = opencodeFilePath('ses_parent');
    expect(sessionIdFromPath(p)).toBe('ses_parent');
    expect(isOpencodePath(p)).toBe(true);
    expect(isOpencodePath('/home/x/.claude/projects/p/abc.jsonl')).toBe(false);
  });

  test('discovers only top-level sessions (subagents fold into the parent)', () => {
    const ids = discoverOpencodeSessions()
      .map((s) => sessionIdFromPath(s.path))
      .sort();
    expect(ids).toEqual(['ses_parent', 'ses_plain']);
  });

  test('stat reports time_updated as mtime and message count as size', () => {
    expect(opencodeStat(opencodeFilePath('ses_parent'))).toEqual({ mtimeMs: 2000, size: 2 });
    expect(opencodeStat(opencodeFilePath('ses_missing'))).toBeNull();
  });

  test('synthesizes lines the shared parser understands', () => {
    const lines = readSessionLines(opencodeFilePath('ses_parent'));
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/app');
    expect(firstPrompt(lines, 'opencode')).toBe('please refactor the router lazerhawk');
    expect(customTitle(lines)).toBe('Refactor the router');
    expect(messageCount(lines)).toBe(2); // one user + one assistant
  });

  test('drops the auto-generated "New session -" placeholder title', () => {
    const lines = readSessionLines(opencodeFilePath('ses_plain'), 'opencode');
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/other');
    expect(customTitle(lines)).toBe('');
  });

  test('extractors read the synthesized OpenCode blocks', () => {
    const lines = readOpencodeSession(opencodeFilePath('ses_parent'));
    expect(extractFiles(lines, 'opencode')).toEqual(['/repo/app/router.ts']);
    expect(extractFilesRead(lines, 'opencode')).toEqual(['/repo/app/old.ts']);
    expect(extractCommands(lines, 'opencode')).toEqual(['bun test', 'x']); // a failed command still ran
    expect(extractThinking(lines, 'opencode')).toBe('thinking about zorptastic');
    const errors = extractErrors(lines, 'opencode');
    expect(errors.errored).toBe(true);
    expect(errors.messages[0]).toBe('boom quux');
  });

  test('collects subagent user text for parent-session recall', () => {
    expect(collectOpencodeSubagentText(opencodeFilePath('ses_parent'))).toBe('subagent secret term wibbleflorp');
    expect(collectOpencodeSubagentText(opencodeFilePath('ses_plain'))).toBe('');
  });

  test('a deleted DB stops being discoverable despite a cached handle', () => {
    // Long-running-process scenario (e.g. the MCP server): the handle is opened,
    // then the DB file is deleted out from under it — sessions must vanish, not
    // keep being served off the open inode.
    const copyPath = join(tmp, 'opencode-copy.db');
    copyFileSync(dbPath, copyPath);
    process.env.SESSIONS_OPENCODE_DB = copyPath;
    closeOpencodeDb();
    expect(discoverOpencodeSessions()).toHaveLength(2); // handle now open + cached
    rmSync(copyPath);
    expect(discoverOpencodeSessions()).toEqual([]);
    process.env.SESSIONS_OPENCODE_DB = dbPath;
    closeOpencodeDb();
  });
});

describe('opencode cache integration', () => {
  let cache: typeof import('./cache');

  beforeAll(async () => {
    // Point every source at hermetic locations; only OpenCode has a (fixture) DB.
    process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
    process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
    process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
    process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
    process.env.SESSIONS_OPENCODE_DB = dbPath;
    process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive'); // hermetic vault; keep off the real ~/.local/share
    for (const d of ['cache', 'claude', 'pi', 'codex']) mkdirSync(join(tmp, d), { recursive: true });
    cache = await import('./cache');
    cache.closeDb();
  });

  afterAll(() => cache.closeDb());

  test('indexes OpenCode sessions and builds a resume command', async () => {
    const results = await cache.searchSessions('lazerhawk');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool: 'opencode',
      cwd: '/repo/app',
      sessionId: 'ses_parent',
      customTitle: 'Refactor the router',
      errored: true,
    });
    expect(results[0]!.files).toEqual(['/repo/app/router.ts', '/repo/app/old.ts']);
    const { buildResumeCommand } = await import('./search-format');
    expect(buildResumeCommand('opencode', results[0]!.cwd, results[0]!.sessionId)).toBe(
      'cd "/repo/app" && opencode --session ses_parent',
    );
  });

  test('subagent text makes the parent findable, without listing the subagent', async () => {
    const results = await cache.searchSessions('wibbleflorp');
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('ses_parent');
  });

  test('lists top-level sessions when filtered to the opencode tool', async () => {
    const results = await cache.searchSessions('', { tool: 'opencode', limit: 100 });
    expect(results.map((r) => r.sessionId).sort()).toEqual(['ses_parent', 'ses_plain']);
  });
});

describe('opencode report parser', () => {
  test('emits one usage event per assistant message with tokens + pre-computed cost', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    const events = await parseOpencode(dbPath);
    expect(events).toHaveLength(1); // only ses_parent's assistant turn carries tokens
    expect(events[0]).toMatchObject({
      tool: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      sessionId: 'ses_parent',
      projectPath: '/repo/app',
      // reasoning tokens fold into output (50 + 10)
      tokens: { input: 100, output: 60, cacheRead: 200, cacheWrite: 30 },
      costUSD: 0.05,
    });
  });

  test('returns [] for a missing DB', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    expect(await parseOpencode(join(tmp, 'nope.db'))).toEqual([]);
  });
});
