// Look up what a session was actually about, for the report's most-expensive-
// sessions table. A dollar figure next to a uuid says nothing; next to "migrate
// the auth middleware" it says where the money went.
//
// This reads the search index read-only and never refreshes it: the report must
// work on a machine that has never run `sessions index`, and must never pay for a
// full reindex as a side effect of asking for a cost breakdown. A missing,
// stale, or corrupt index degrades to "no intent", never to an error.
import { Database } from 'bun:sqlite';
import { getDbPath } from '../cache.ts';
import type { ToolId } from './types.ts';

// The report and the index name the same tool differently ('claude-code' is the
// usage-contract id, 'claude' is the index's).
const INDEX_TOOL = {
  'claude-code': 'claude',
  pi: 'pi',
  codex: 'codex',
  opencode: 'opencode',
} satisfies Record<ToolId, string>;

export interface SessionKey {
  tool: ToolId;
  sessionId: string;
}

interface IndexRow {
  tool: string;
  session_id: string;
  custom_title: string;
  first_prompt: string;
  message_count: number;
}

const keyOf = (tool: string, sessionId: string): string => `${tool}|${sessionId}`;

/** Collapse whitespace and clip, so a pasted wall of text stays a one-line label. */
function tidy(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Map of `${ToolId}|${sessionId}` → intent, for the keys that the index knows
 * about. Keys it doesn't know are simply absent.
 */
export function lookupIntents(keys: SessionKey[]): Map<string, string> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;

  let db: Database | undefined;
  try {
    db = new Database(getDbPath(), { readonly: true });
    // Query by session_id alone and filter tool in JS: session ids are uuids, so
    // the id set is already selective, and this keeps the SQL to one parameter list.
    const ids = [...new Set(keys.map((k) => k.sessionId))];
    const placeholders = ids.map(() => '?').join(',');
    // SAFETY: bun:sqlite returns untyped rows; the SELECT list fixes the shape.
    const rows = db
      .query(
        `SELECT tool, session_id, custom_title, first_prompt, message_count
         FROM sessions WHERE session_id IN (${placeholders})`,
      )
      .all(...ids) as IndexRow[];

    // A resumed session spans several transcript files, so one id can return
    // several rows. The longest one is the one that actually holds the session.
    const best = new Map<string, IndexRow>();
    for (const r of rows) {
      const k = keyOf(r.tool, r.session_id);
      const cur = best.get(k);
      if (!cur || r.message_count > cur.message_count) best.set(k, r);
    }

    for (const k of keys) {
      const row = best.get(keyOf(INDEX_TOOL[k.tool], k.sessionId));
      const intent = row?.custom_title || row?.first_prompt;
      if (intent) out.set(keyOf(k.tool, k.sessionId), tidy(intent));
    }
  } catch {
    // No index, wrong schema, locked file: the report is still a report.
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return out;
}
