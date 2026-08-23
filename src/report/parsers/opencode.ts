// Sessions-owned parser (OpenCode is not part of the upstream tokenmaxing contract).
// OpenCode keeps sessions in one SQLite DB rather than per-session JSONL files, so
// this reads the DB directly instead of using walkJsonl. One UsageEvent per assistant
// message; OpenCode pre-computes `cost` for some providers (Anthropic) but reports 0
// for others (OpenAI), so we trust its cost when positive and otherwise leave costUSD
// unset for the downstream pricing engine — the same split Pi vs Claude/Codex make.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { z } from 'zod';

import type { UsageEvent } from './types.ts';

// Message rows come from OpenCode's own DB; per-field catch keeps a malformed
// optional field from discarding an otherwise usable row.
const opencodeMessageSchema = z.object({
  role: z.string().optional(),
  modelID: z.string().optional().catch(undefined),
  providerID: z.string().optional().catch(undefined),
  cost: z.number().optional().catch(undefined),
  time: z.object({ created: z.number().optional(), completed: z.number().optional() }).optional().catch(undefined),
  path: z.object({ cwd: z.string().optional() }).optional().catch(undefined),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      reasoning: z.number().optional(),
      cache: z.object({ read: z.number().optional(), write: z.number().optional() }).optional(),
    })
    .optional()
    .catch(undefined),
});

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
      if (created === undefined) continue;

      const event: UsageEvent = {
        tool: 'opencode',
        provider: providerID,
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
      if (msg.cost !== undefined && msg.cost > 0) event.costUSD = msg.cost;
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
function tryParse(text: string): z.infer<typeof opencodeMessageSchema> | null {
  try {
    const parsed = opencodeMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
