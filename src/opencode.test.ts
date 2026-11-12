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
// OpenCode writes two schemas to the same DB; the fixture mirrors ses_parent/ses_child
// into the v2 tables (as the real migration does) and keeps ses_plain legacy-only so
// both the v2-preferred path and the legacy fallback are exercised. includeV2=false
// emulates an older install with no v2 tables.
function buildFixtureDb(path: string, includeV2 = true): void {
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

  if (includeV2) {
    db.run(
      'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)',
    );
    db.run(
      'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)',
    );
    const sessionV2 = db.query(
      'INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const turn = db.query(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
    );

    // ses_parent mirrored into v2 (same turns, newer time_updated) — v2 must win over the frozen legacy copy.
    sessionV2.run('ses_parent', 'p1', null, '/repo/app', 'Refactor the router', 1000, 2500);
    turn.run(
      'sm_u1',
      'ses_parent',
      'user',
      1,
      1100,
      j({ text: 'please refactor the router lazerhawk', time: { created: 1100 } }),
    );
    turn.run(
      'sm_a1',
      'ses_parent',
      'assistant',
      2,
      1500,
      j({
        agent: 'build',
        model: { id: 'claude-opus-4-6', providerID: 'anthropic', variant: 'default' },
        cost: 0.05,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 30 } },
        time: { created: 1500, completed: 1600 },
        content: [
          { type: 'reasoning', text: 'thinking about zorptastic' },
          { type: 'text', text: 'Done refactoring' },
          { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'bun test' } } },
          { type: 'tool', name: 'edit', state: { status: 'completed', input: { filePath: '/repo/app/router.ts' } } },
          { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: '/repo/app/old.ts' } } },
          // v2 errors are `{ type, message }` objects (legacy parts carry a plain string).
          {
            type: 'tool',
            name: 'bash',
            state: { status: 'error', input: { command: 'x' }, error: { type: 'unknown', message: 'boom quux' } },
          },
        ],
      }),
    );
    // Bookkeeping rows v2 also stores — not turns, must never become messages.
    turn.run('sm_c1', 'ses_parent', 'compaction', 3, 1700, j({ text: 'compacted history lazerhawk' }));
    turn.run('sm_s1', 'ses_parent', 'system', 4, 1800, j({ text: 'system notice' }));

    // Migrated subagent — parent recall must find it through v2.
    sessionV2.run('ses_child', 'p1', 'ses_parent', '/repo/app', 'Explore (@explore subagent)', 1200, 1400);
    turn.run(
      'sm_u2',
      'ses_child',
      'user',
      1,
      1200,
      j({ text: 'subagent secret term wibbleflorp', time: { created: 1200 } }),
    );

    // A legacy-only subagent of a migrated parent — recall must still find it.
    session.run('ses_oldchild', 'p1', 'ses_parent', '/repo/app', 'Old subagent', 1300, 1300);
    message.run('msg_u5', 'ses_oldchild', 1300, j({ role: 'user', time: { created: 1300 } }));
    part.run('prt_u5', 'msg_u5', 'ses_oldchild', 1300, j({ type: 'text', text: 'legacy child term snorkelbat' }));

    // v2-only session — invisible to the legacy schema entirely.
    sessionV2.run('ses_fresh', 'p3', null, '/repo/fresh', 'Fresh v2 session', 4000, 4500);
    turn.run(
      'sm_u4',
      'ses_fresh',
      'user',
      1,
      4100,
      j({ text: 'a v2-only session about grousewalker', time: { created: 4100 } }),
    );
    turn.run(
      'sm_a2',
      'ses_fresh',
      'assistant',
      2,
      4200,
      j({
        model: { id: 'claude-opus-4-6', providerID: 'anthropic' },
        cost: 0.02,
        tokens: { input: 20, output: 10, reasoning: 5, cache: { read: 0, write: 0 } },
        time: { created: 4200, completed: 4300 },
        // Written with `experimental.part_rows`: inline content is empty, the parts live in session_part.
        content: [],
      }),
    );
    db.run(
      'CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, data TEXT, PRIMARY KEY (message_id, ordinal))',
    );
    const sessionPart = db.query(
      'INSERT INTO session_part (message_id, session_id, ordinal, type, data) VALUES (?, ?, ?, ?, ?)',
    );
    // Inserted out of order: reads must follow ordinal.
    sessionPart.run(
      'sm_a2',
      'ses_fresh',
      1,
      'tool',
      j({ type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'bun run quillfeather' } } }),
    );
    sessionPart.run(
      'sm_a2',
      'ses_fresh',
      0,
      'text',
      j({ type: 'text', text: 'grousewalker handled via quillfeather' }),
    );
  }

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

  test('discovers top-level sessions from both schemas, deduping shared ids (subagents fold into the parent)', () => {
    const ids = discoverOpencodeSessions()
      .map((s) => sessionIdFromPath(s.path))
      .sort();
    expect(ids).toEqual(['ses_fresh', 'ses_parent', 'ses_plain']);
  });

  test('stat prefers the v2 row for shared ids and serves v2-only ids', () => {
    expect(opencodeStat(opencodeFilePath('ses_parent'))).toEqual({ mtimeMs: 2500, size: 4 }); // newer v2 time_updated; v2 rows include bookkeeping
    expect(opencodeStat(opencodeFilePath('ses_fresh'))).toEqual({ mtimeMs: 4500, size: 4 }); // 2 message rows + 2 part rows
    expect(opencodeStat(opencodeFilePath('ses_plain'))).toEqual({ mtimeMs: 3500, size: 1 }); // legacy-only id
    expect(opencodeStat(opencodeFilePath('ses_missing'))).toBeNull();
  });

  test('a DB with no v2 tables (older OpenCode) reads the legacy schema', () => {
    const legacyPath = join(tmp, 'opencode-legacy.db');
    buildFixtureDb(legacyPath, false);
    process.env.SESSIONS_OPENCODE_DB = legacyPath;
    closeOpencodeDb();
    try {
      expect(
        discoverOpencodeSessions()
          .map((s) => sessionIdFromPath(s.path))
          .sort(),
      ).toEqual(['ses_parent', 'ses_plain']);
      expect(opencodeStat(opencodeFilePath('ses_parent'))).toEqual({ mtimeMs: 2000, size: 2 }); // legacy time_updated + legacy count
      const lines = readSessionLines(opencodeFilePath('ses_parent'));
      expect(firstPrompt(lines, 'opencode')).toBe('please refactor the router lazerhawk');
      expect(extractCommands(lines, 'opencode')).toEqual(['bun test', 'x']);
    } finally {
      process.env.SESSIONS_OPENCODE_DB = dbPath;
      closeOpencodeDb();
    }
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

  test('reads assistant content from session_part rows in ordinal order', () => {
    const lines = readOpencodeSession(opencodeFilePath('ses_fresh'));
    expect(messageCount(lines)).toBe(2);
    const assistant = JSON.parse(lines.at(-1)!).message;
    expect(assistant.content).toEqual([
      { type: 'text', text: 'grousewalker handled via quillfeather' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun run quillfeather' } } },
    ]);
    expect(extractCommands(lines, 'opencode')).toEqual(['bun run quillfeather']);
  });

  test('collects subagent user text for parent-session recall', () => {
    // ses_child is in both schemas (counted once, from v2); ses_oldchild only in legacy.
    expect(collectOpencodeSubagentText(opencodeFilePath('ses_parent'))).toBe(
      'subagent secret term wibbleflorp\nlegacy child term snorkelbat',
    );
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
    expect(discoverOpencodeSessions()).toHaveLength(3); // handle now open + cached (both schemas)
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
    delete process.env.SESSIONS_PI_EXTRA_DIRS; // a developer's own extra Pi folders must not leak in
    process.env.SESSIONS_OLLAMA_URL = 'http://127.0.0.1:1'; // dead port: keep the semantic lane off a local Ollama
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
    expect(buildResumeCommand(results[0]!)).toBe("cd '/repo/app' && opencode --session ses_parent");
  });

  test('subagent text makes the parent findable, without listing the subagent', async () => {
    const results = await cache.searchSessions('wibbleflorp');
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('ses_parent');
  });

  test('lists top-level sessions when filtered to the opencode tool', async () => {
    const results = await cache.searchSessions('', { tool: 'opencode', limit: 100 });
    expect(results.map((r) => r.sessionId).sort()).toEqual(['ses_fresh', 'ses_parent', 'ses_plain']);
  });

  test('a v2-only session is searchable, and the v2 copy wins for shared ids', async () => {
    const results = await cache.searchSessions('grousewalker');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool: 'opencode',
      sessionId: 'ses_fresh',
      cwd: '/repo/fresh',
      customTitle: 'Fresh v2 session',
    });
    // ses_plain exists only in the legacy tables — the fallback still indexes it.
    const legacyOnly = await cache.searchSessions('hello there');
    expect(legacyOnly).toHaveLength(1);
    expect(legacyOnly[0]!.sessionId).toBe('ses_plain');
  });
});

describe('opencode report parser', () => {
  test('emits one usage event per assistant message, preferring v2 rows and nesting model under `model`', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    const events = await parseOpencode(dbPath);
    expect(events).toHaveLength(2); // ses_parent + ses_fresh; the frozen legacy copy of ses_parent is excluded
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
    expect(events[1]).toMatchObject({ sessionId: 'ses_fresh', projectPath: '/repo/fresh', costUSD: 0.02 });
  });

  test('returns [] for a missing DB', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    expect(await parseOpencode(join(tmp, 'nope.db'))).toEqual([]);
  });

  test('a DB with no v2 tables reports from the legacy schema (flat model fields)', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    const legacyPath = join(tmp, 'opencode-legacy-report.db');
    buildFixtureDb(legacyPath, false);
    const events = await parseOpencode(legacyPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 'ses_parent',
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      costUSD: 0.05,
    });
  });
});
