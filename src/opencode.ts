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
//
// OpenCode also writes a newer `session_v2`/`session_message` schema to the same
// DB; reads below prefer the v2 row when an id exists in both and fall back to
// legacy otherwise.

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

/** Whether a table exists: pre-v2 installs lack `session_v2`, and the legacy tables
 *  will eventually be dropped — neither schema is assumed. */
function tableExists(d: Database, name: string): boolean {
  try {
    return (
      d.query<{ 1: number }, [string]>(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !=
      null
    );
  } catch {
    return false;
  }
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
    const ids = new Set<string>();
    for (const table of ['session_v2', 'session']) {
      if (!tableExists(d, table)) continue;
      const rows = d.query<{ id: string }, []>(`SELECT id FROM ${table} WHERE parent_id IS NULL`).all();
      for (const r of rows) ids.add(r.id);
    }
    return [...ids].map((id) => ({ path: opencodeFilePath(id), tool: 'opencode' }));
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
    if (tableExists(d, 'session_v2')) {
      // Part rows are counted too: appending one to an assistant turn adds no session_message row.
      const parts = tableExists(d, 'session_part')
        ? ' + (SELECT COUNT(*) FROM session_part WHERE session_id = ?1)'
        : '';
      const v2 = d
        .query<{ time_updated: number; c: number }, [string]>(
          `SELECT time_updated, (SELECT COUNT(*) FROM session_message WHERE session_id = ?1)${parts} AS c FROM session_v2 WHERE id = ?1`,
        )
        .get(id);
      if (v2) return { mtimeMs: v2.time_updated, size: v2.c };
    }
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

  let session: { directory: string; title: string; time_created: number } | null | undefined;
  let fromV2 = false;
  try {
    if (tableExists(d, 'session_v2')) {
      const v2row = d
        .query<{ directory: string; title: string; time_created: number }, [string]>(
          'SELECT directory, title, time_created FROM session_v2 WHERE id = ?',
        )
        .get(id);
      if (v2row) {
        session = v2row;
        fromV2 = true;
      }
    }
    if (!session && tableExists(d, 'session')) {
      session = d
        .query<{ directory: string; title: string; time_created: number }, [string]>(
          'SELECT directory, title, time_created FROM session WHERE id = ?',
        )
        .get(id);
    }
  } catch {
    return [];
  }
  if (!session) return [];

  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'session', cwd: session.directory, timestamp: isoTime(session.time_created) }));
  // Skip OpenCode's auto-generated "New session - <date>" placeholder; a real,
  // summarized title becomes a custom-title (reused by display/context as the intent).
  if (session.title && !session.title.startsWith('New session')) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: session.title }));
  }

  const messages = fromV2
    ? readV2Messages(d, id, session.time_created)
    : readLegacyMessages(d, id, session.time_created);
  for (const m of messages)
    lines.push(
      JSON.stringify({ type: 'message', timestamp: m.timestamp, message: { role: m.role, content: m.content } }),
    );

  return lines;
}

/**
 * Serialize an OpenCode session to the normalized JSONL text the vault archives.
 *
 * OpenCode sessions are SQLite rows with no per-session file, so an export of the
 * already-materialized `readOpencodeSession` lines[] is the rawest form that exists
 * to preserve. The output is byte-identical to what the live materializer emits, so
 * a vault copy re-parses through session-io/parser as tool `opencode` — no second
 * normalization scheme. Empty string when the session is gone (nothing to archive).
 */
export function serializeOpencodeSession(filePath: string): string {
  return readOpencodeSession(filePath).join('\n');
}

/** Genuine user text across a session's subagent (child) sessions, for parent-session search recall.
 *  Children come from both schemas with the same per-session v2 preference as reads, so a
 *  parent finds children on either side of the migration without double-counting shared ones. */
export function collectOpencodeSubagentText(filePath: string): string {
  const d = db();
  if (!d) return '';
  const id = sessionIdFromPath(filePath);
  try {
    const texts: string[] = [];
    const hasV2 = tableExists(d, 'session_v2');
    if (hasV2) {
      const rows = d
        .query<{ text: string | null }, [string]>(
          `SELECT json_extract(data, '$.text') AS text FROM session_message
           WHERE session_id IN (SELECT id FROM session_v2 WHERE parent_id = ?) AND type = 'user'`,
        )
        .all(id);
      for (const r of rows) if (r.text !== null && r.text.length > 0) texts.push(r.text);
    }
    if (tableExists(d, 'session')) {
      const rows = d
        .query<{ text: string | null }, [string]>(
          `SELECT json_extract(p.data, '$.text') AS text
           FROM part p JOIN message m ON m.id = p.message_id
           WHERE p.session_id IN (SELECT id FROM session WHERE parent_id = ?)
             ${hasV2 ? 'AND p.session_id NOT IN (SELECT id FROM session_v2)' : ''}
             AND json_extract(p.data, '$.type') = 'text'
             AND json_extract(m.data, '$.role') = 'user'`,
        )
        .all(id);
      for (const r of rows) if (r.text !== null && r.text.length > 0) texts.push(r.text);
    }
    return texts.join('\n');
  } catch {
    return '';
  }
}

// ——— helpers ———

/** One turn as the shared `type:'message'` line wants it, before JSON serialization. */
interface RawMessage {
  role: 'user' | 'assistant';
  timestamp: string;
  content: JsonObject[];
}

/** v2 turns: one `session_message` row per message. Only `user`/`assistant` rows are
 *  transcript turns; v2 also stores bookkeeping rows (system, compaction, synthetic, idle,
 *  skill, agent/model/location-switched, shell) that are skipped here. User rows carry plain
 *  `$.text`. Assistant content is `$.content[]` inline, or, once OpenCode writes part rows
 *  (`experimental.part_rows`), `session_part` rows by ordinal with an empty inline `content`. */
function readV2Messages(d: Database, id: string, fallbackTime: number): RawMessage[] {
  const rows = d
    .query<{ id: string; type: string; time_created: number; data: string }, [string]>(
      'SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created ASC, seq ASC',
    )
    .all(id);
  const partsByMessage = v2PartsBySession(d, id);
  const out: RawMessage[] = [];
  for (const r of rows) {
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const md = tryParse(r.data);
    if (!md) continue;
    const ts = isoTime(asJsonNumber(asJsonObject(md.time)?.created) ?? r.time_created ?? fallbackTime);
    if (r.type === 'user') {
      const text = asJsonString(md.text);
      if (text?.trim()) out.push({ role: 'user', timestamp: ts, content: [{ type: 'text', text }] });
    } else {
      // SAFETY: the Array.isArray guard narrows `content` to an array of JSON values,
      // which is the JsonObject[] shape buildContent reads.
      const inline = Array.isArray(md.content) ? (md.content as JsonObject[]) : [];
      const content = buildContent(partsByMessage.get(r.id) ?? inline);
      if (content.length > 0) out.push({ role: 'assistant', timestamp: ts, content });
    }
  }
  return out;
}

/** A v2 session's `session_part` rows grouped by message id, in ordinal order (empty when the table is absent).
 *  The row's `type` column wins over the JSON, as OpenCode's own reader does. */
function v2PartsBySession(d: Database, sessionId: string): Map<string, JsonObject[]> {
  const byMessage = new Map<string, JsonObject[]>();
  if (!tableExists(d, 'session_part')) return byMessage;
  const rows = d
    .query<{ message_id: string; type: string; data: string }, [string]>(
      'SELECT message_id, type, data FROM session_part WHERE session_id = ? ORDER BY message_id ASC, ordinal ASC',
    )
    .all(sessionId);
  for (const r of rows) {
    const pd = tryParse(r.data);
    if (!pd) continue;
    const list = byMessage.get(r.message_id);
    if (list) list.push({ ...pd, type: r.type });
    else byMessage.set(r.message_id, [{ ...pd, type: r.type }]);
  }
  return byMessage;
}

/** Legacy turns: `message` rows joined with their `part` rows. */
function readLegacyMessages(d: Database, id: string, fallbackTime: number): RawMessage[] {
  const messages = d
    .query<{ id: string; data: string }, [string]>(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(id);
  const partsByMessage = partsBySession(d, id);
  const out: RawMessage[] = [];
  for (const m of messages) {
    const md = tryParse(m.data);
    const role = md?.role === 'assistant' ? 'assistant' : 'user';
    const ts = isoTime(asJsonNumber(asJsonObject(md?.time)?.created) ?? fallbackTime);
    const content = buildContent(partsByMessage.get(m.id) ?? []);
    if (content.length === 0) continue; // e.g. a synthetic/empty turn with no renderable parts
    out.push({ role, timestamp: ts, content });
  }
  return out;
}

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

/** Map message content blocks to content blocks: text→text, reasoning→thinking, tool→tool, patch→patch.
 *  v2 names the tool in `name`, legacy parts in `tool`. */
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
        const name = asJsonString(p.tool) ?? asJsonString(p.name);
        if (name !== undefined) block.tool = name;
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
