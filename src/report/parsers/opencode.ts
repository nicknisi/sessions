// Sessions-owned parser (OpenCode is not part of the upstream tokenmaxing contract).
// OpenCode keeps sessions in one SQLite DB rather than per-session JSONL files, so
// this reads the DB directly instead of using walkJsonl. One UsageEvent per assistant
// message; OpenCode pre-computes `cost` for some providers (Anthropic) but reports 0
// for others (OpenAI), so we trust its cost when positive and otherwise leave costUSD
// unset for the downstream pricing engine — the same split Pi vs Claude/Codex make.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { UsageEvent } from './types.ts';
import type { ProviderId } from '../types.ts';

interface OpencodeMessage {
  role?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  time?: { created?: number; completed?: number };
  path?: { cwd?: string };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

export async function parseOpencode(dbPath: string): Promise<UsageEvent[]> {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.run('PRAGMA busy_timeout=5000');
  } catch {
    return [];
  }

  const events: UsageEvent[] = [];
  try {
    const rows = db
      .query<{ session_id: string; data: string; directory: string }, []>(
        `SELECT m.session_id, m.data, s.directory
         FROM message m JOIN session s ON s.id = m.session_id
         WHERE json_extract(m.data, '$.role') = 'assistant'`,
      )
      .all();

    for (const row of rows) {
      const msg = tryParse(row.data);
      if (!msg || msg.role !== 'assistant') continue;
      const { modelID, providerID, tokens } = msg;
      if (!modelID || !providerID || !tokens) continue;

      const created = msg.time?.completed ?? msg.time?.created;
      if (typeof created !== 'number') continue;

      const event: UsageEvent = {
        tool: 'opencode',
        provider: providerID as ProviderId,
        model: modelID,
        timestamp: new Date(created).toISOString(),
        sessionId: row.session_id,
        projectPath: msg.path?.cwd ?? row.directory,
        tokens: {
          input: tokens.input ?? 0,
          // Reasoning tokens are billed as completion output, so fold them in.
          output: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
          cacheRead: tokens.cache?.read ?? 0,
          cacheWrite: tokens.cache?.write ?? 0,
        },
      };
      // Trust OpenCode's own cost only when it computed one; otherwise price downstream.
      if (typeof msg.cost === 'number' && msg.cost > 0) event.costUSD = msg.cost;
      events.push(event);
    }
  } catch {
    // A schema drift or read error yields no OpenCode events rather than aborting the report.
  } finally {
    db.close();
  }
  return events;
}

/** JSON.parse a message row to a typed shape, or null on malformed/non-object data.
 *  Deliberately local (not src/extract-util's): the report/ subtree stays self-contained
 *  and types its rows. */
function tryParse(text: string): OpencodeMessage | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as OpencodeMessage) : null;
  } catch {
    return null;
  }
}
