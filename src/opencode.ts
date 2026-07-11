import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { type Tool } from './types';

// OpenCode stores sessions in a single SQLite database (it migrated off the old
// file-per-session `storage/` layout). Everything else in this codebase reads one
// JSONL file per session into `lines: string[]`; this module bridges that gap by
// synthesizing an equivalent `lines[]` from the DB's session/message/part tables,
// so the parser and extractors treat OpenCode like any other tool. Env override
// keeps tests hermetic (they point at a temp fixture DB), matching SESSIONS_*_DIR.

/** Absolute path to the OpenCode SQLite DB, honoring SESSIONS_OPENCODE_DB. I.e. ~/.local/share/opencode/opencode.db */
export function getOpencodeDbPath(): string {
  return process.env.SESSIONS_OPENCODE_DB || join(homedir(), '.local/share/opencode/opencode.db');
}

/** Synthetic file_path for a session: join(dbPath, sessionId) so dirname===dbPath and basename===sessionId. */
export function opencodeFilePath(sessionId: string): string {
  return join(getOpencodeDbPath(), sessionId);
}

/** Whether a stored file_path denotes an OpenCode session (its parent dir is the DB file). */
export function isOpencodePath(filePath: string): boolean {
  return dirname(filePath) === getOpencodeDbPath();
}

/** The `ses_…` id embedded in a synthetic OpenCode file_path. I.e. basename of join(dbPath, id). */
export function sessionIdFromPath(filePath: string): string {
  return basename(filePath);
}

let _conn: { path: string; db: Database } | null = null;

/** Cached read-only DB handle for the current db path, or null if the DB is absent/unreadable. */
function db(): Database | null {
  const path = getOpencodeDbPath();
  if (_conn && _conn.path === path) return _conn.db;
  closeOpencodeDb();
  if (!existsSync(path)) return null;
  try {
    // Read-only so we never contend with a running OpenCode's write lock (WAL mode).
    const opened = new Database(path, { readonly: true });
    opened.run('PRAGMA busy_timeout=5000');
    _conn = { path, db: opened };
    return opened;
  } catch {
    return null;
  }
}

/** Close and drop the cached DB handle so the next call reopens against getOpencodeDbPath(). Idempotent. */
export function closeOpencodeDb(): void {
  try {
    _conn?.db.close();
  } catch {}
  _conn = null;
}

/** Top-level sessions (subagents fold into their parent), as synthetic file_paths for discovery. */
export function discoverOpencodeSessions(): { path: string; tool: Tool }[] {
  const d = db();
  if (!d) return [];
  try {
    const rows = d.query<{ id: string }, []>('SELECT id FROM session WHERE parent_id IS NULL').all();
    return rows.map((r) => ({ path: opencodeFilePath(r.id), tool: 'opencode' as Tool }));
  } catch {
    return [];
  }
}

/** Cache-invalidation signal for a session: time_updated as mtime, message count as size. */
export function opencodeStat(filePath: string): { mtimeMs: number; size: number } | null {
  const d = db();
  if (!d) return null;
  const id = sessionIdFromPath(filePath);
  try {
    const row = d
      .query<{ time_updated: number; c: number }, [string, string]>(
        'SELECT time_updated, (SELECT COUNT(*) FROM message WHERE session_id = ?) AS c FROM session WHERE id = ?',
      )
      .get(id, id);
    return row ? { mtimeMs: row.time_updated, size: row.c } : null;
  } catch {
    return null;
  }
}

/**
 * Reconstruct a session as JSONL-style `lines[]` the shared parser understands: a
 * `session` line carrying the cwd, an optional `custom-title` line, then one
 * `message` line per turn whose `message.content[]` mixes text, thinking, tool,
 * and patch blocks (the generic `type:'message'` shape pi/codex already parse).
 */
export function readOpencodeSession(filePath: string): string[] {
  const d = db();
  if (!d) return [];
  const id = sessionIdFromPath(filePath);

  const session = d
    .query<{ directory: string; title: string; time_created: number }, [string]>(
      'SELECT directory, title, time_created FROM session WHERE id = ?',
    )
    .get(id);
  if (!session) return [];

  const lines: string[] = [];
  lines.push(
    JSON.stringify({ type: 'session', directory: session.directory, timestamp: isoTime(session.time_created) }),
  );
  // Skip OpenCode's auto-generated "New session - <date>" placeholder; a real,
  // summarized title becomes a custom-title (reused by display/context as the intent).
  if (session.title && !session.title.startsWith('New session')) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: session.title }));
  }

  const messages = d
    .query<{ id: string; data: string }, [string]>(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(id);
  const partsByMessage = partsBySession(d, id);

  for (const m of messages) {
    const md = tryParse(m.data);
    const role = md?.role === 'assistant' ? 'assistant' : 'user';
    const ts = isoTime((md?.time as { created?: number } | undefined)?.created ?? session.time_created);
    const content = buildContent(partsByMessage.get(m.id) ?? []);
    if (content.length === 0) continue; // e.g. a synthetic/empty turn with no renderable parts
    lines.push(JSON.stringify({ type: 'message', timestamp: ts, message: { role, content } }));
  }

  return lines;
}

/** Genuine user text across a session's subagent (child) sessions, for parent-session search recall. */
export function collectOpencodeSubagentText(filePath: string): string {
  const d = db();
  if (!d) return '';
  const id = sessionIdFromPath(filePath);
  try {
    const rows = d
      .query<{ text: string }, [string]>(
        `SELECT json_extract(p.data, '$.text') AS text
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id IN (SELECT id FROM session WHERE parent_id = ?)
           AND json_extract(p.data, '$.type') = 'text'
           AND json_extract(m.data, '$.role') = 'user'`,
      )
      .all(id);
    return rows
      .map((r) => r.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Read any session into `lines[]`, routing OpenCode (no real file) through the DB
 * and every other tool through its JSONL file. `tool` is optional: when omitted
 * (call sites that only carry a file_path) OpenCode is detected from the path.
 */
export function readSessionLines(filePath: string, tool?: Tool): string[] {
  if (tool === 'opencode' || (tool === undefined && isOpencodePath(filePath))) {
    return readOpencodeSession(filePath);
  }
  try {
    return readFileSync(filePath, 'utf-8').trimEnd().split('\n');
  } catch {
    return [];
  }
}

// ——— helpers ———

/** All parts of a session grouped by message id, preserving stable chronological order. */
function partsBySession(d: Database, sessionId: string): Map<string, unknown[]> {
  const byMessage = new Map<string, unknown[]>();
  const rows = d
    .query<{ message_id: string; data: string }, [string]>(
      'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(sessionId);
  for (const r of rows) {
    const parsed = tryParse(r.data);
    if (!parsed) continue;
    const list = byMessage.get(r.message_id) ?? [];
    list.push(parsed);
    byMessage.set(r.message_id, list);
  }
  return byMessage;
}

/** Map OpenCode message parts to content blocks: text→text, reasoning→thinking, tool→tool, patch→patch. */
function buildContent(parts: unknown[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    switch (p.type) {
      case 'text':
        if (typeof p.text === 'string' && p.text.trim()) blocks.push({ type: 'text', text: p.text });
        break;
      case 'reasoning':
        if (typeof p.text === 'string' && p.text.trim()) blocks.push({ type: 'thinking', thinking: p.text });
        break;
      case 'tool':
        // Faithful to the source `state` (input/output/status/error) so the extractors read one shape.
        blocks.push({ type: 'tool', tool: p.tool, state: p.state });
        break;
      case 'patch':
        if (Array.isArray(p.files)) blocks.push({ type: 'patch', files: p.files });
        break;
    }
  }
  return blocks;
}

/** Epoch-ms → ISO-8601, or '' for a missing/invalid time (parser skips '' timestamps). */
function isoTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

/** JSON.parse that yields a record or null instead of throwing on malformed rows. */
function tryParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
