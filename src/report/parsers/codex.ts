// Sessions-owned (forked from tokenmaxing's parser). Codex's input_tokens are cache-inclusive and
// output_tokens already include reasoning; correct both so totals reflect actual billing (and match ccusage).
import { z } from 'zod';

import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';
import { walkJsonl, type WalkOptions } from './walk.ts';

const codexEnvelopeSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.unknown().optional(),
});

const sessionMetaPayloadSchema = z.object({
  id: z.string(),
  cwd: z.string().optional(),
});
const turnContextPayloadSchema = z.object({ model: z.string() });
const tokenCountPayloadSchema = z.object({
  type: z.literal('token_count'),
  info: z
    .object({
      last_token_usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          reasoning_output_tokens: z.number().optional(),
          cached_input_tokens: z.number().optional(),
        })
        .optional(),
    })
    .nullable(),
});

export async function parseCodex(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root, opts)) events.push(...(await parseCodexFile(path)));
  return events;
}

/** Parse one rollout file. Self-contained (session meta and model are declared
 *  inside it), so the result is cacheable against the file's mtime. */
export async function parseCodexFile(path: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  {
    let meta: z.infer<typeof sessionMetaPayloadSchema> | null = null;
    let model: string | null = null;
    for await (const line of readJsonlLines(path)) {
      const envelope = codexEnvelopeSchema.safeParse(line);
      if (!envelope.success) continue;
      const { payload } = envelope.data;
      if (envelope.data.type === 'session_meta') {
        const sessionMeta = sessionMetaPayloadSchema.safeParse(payload);
        if (sessionMeta.success) meta = sessionMeta.data;
        continue;
      }
      if (envelope.data.type === 'turn_context') {
        const turnContext = turnContextPayloadSchema.safeParse(payload);
        if (turnContext.success) model = turnContext.data.model;
        continue;
      }
      if (envelope.data.type !== 'event_msg') continue;
      const tokenCount = tokenCountPayloadSchema.safeParse(payload);
      if (!tokenCount.success) continue;
      const info = tokenCount.data.info;
      if (!info?.last_token_usage) continue;
      if (!meta || !model) continue;
      const u = info.last_token_usage;
      events.push({
        tool: 'codex',
        provider: 'openai',
        model,
        timestamp: envelope.data.timestamp,
        sessionId: meta.id,
        projectPath: meta.cwd,
        tokens: {
          // input_tokens is inclusive of cached_input_tokens; subtract so cache reads aren't double-counted.
          input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
          // output_tokens already includes reasoning_output_tokens; don't add it again.
          output: u.output_tokens ?? 0,
          cacheRead: u.cached_input_tokens ?? 0,
          cacheWrite: 0,
        },
      });
    }
  }
  return events;
}
