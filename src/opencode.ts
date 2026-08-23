import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { type Tool } from './types';
import { tryParse, asJsonObject, asJsonString, asJsonNumber, type JsonObject } from './extract-util';

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

/** Cached read-only DB handle for the current db path, or null if the DB is absent/unreadable.
 *  Re-checks existence even on a cache hit so a DB deleted mid-process (e.g. under a
 *  long-running MCP server) stops serving stale sessions instead of riding the open inode. */
function db(): Database | null {
  const path = getOpencodeDbPath();
  if (_conn && _conn.path === path && existsSync(path)) return _conn.db;
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

/** A discovered session as a synthetic file path (OpenCode keeps a DB, not files). */
interface DiscoveredSession {
  path: string;
  tool: Tool;
}

/** Top-level sessions (subagents fold into their parent), as synthetic file_paths for discovery. */
export function discoverOpencodeSessions(): DiscoveredSession[] {
  const d = db();
  if (!d) return [];
  try {
    const rows = d.query<{ id: string }, []>('SELECT id FROM session WHERE parent_id IS NULL').all();
    return rows.map((r) => ({ path: opencodeFilePath(r.id), tool: 'opencode' }));
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
 * Reconstruct a session as JSONL-style `lines[]` built entirely from shapes the
 * shared parser already understands: a Pi-style `session` line carrying the cwd,
 * an optional `custom-title` line, then one `message` line per turn whose
 * `message.content[]` mixes text, thinking, tool, and patch blocks (the generic
 * `type:'message'` shape pi/codex already parse).
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
  lines.push(JSON.stringify({ type: 'session', cwd: session.directory, timestamp: isoTime(session.time_created) }));
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
    const ts = isoTime(asJsonNumber(asJsonObject(md?.time)?.created) ?? session.time_created);
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
      .filter((t) => t !== null && t.length > 0)
      .join('\n');
  } catch {
    return '';
  }
}

// ——— helpers ———

/** All parts of a session grouped by message id, preserving stable chronological order. */
function partsBySession(d: Database, sessionId: string): Map<string, JsonObject[]> {
  const byMessage = new Map<string, JsonObject[]>();
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
function buildContent(parts: JsonObject[]): JsonObject[] {
  const blocks: JsonObject[] = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text': {
        const text = asJsonString(p.text);
        if (text?.trim()) blocks.push({ type: 'text', text });
        break;
      }
      case 'reasoning': {
        const text = asJsonString(p.text);
        if (text?.trim()) blocks.push({ type: 'thinking', thinking: text });
        break;
      }
      case 'tool': {
        // Faithful to the source `state` (input/output/status/error) so the extractors read one shape.
        // Keys stay ABSENT when the source lacks them (undefined would vanish in JSON,
        // null would not — and the transcript byte-compares matter).
        const block: JsonObject = { type: 'tool' };
        if (p.tool !== undefined) block.tool = p.tool;
        if (p.state !== undefined) block.state = p.state;
        blocks.push(block);
        break;
      }
      case 'patch':
        if (Array.isArray(p.files)) blocks.push({ type: 'patch', files: p.files });
        break;
    }
  }
  return blocks;
}

/** Epoch-ms → ISO-8601, or '' for a missing/invalid time (parser skips '' timestamps). */
function isoTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}
