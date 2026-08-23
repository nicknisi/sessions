// Sessions-owned (forked from tokenmaxing's parser — no longer byte-comparable with upstream).
// Local divergences from the vendored original, in emit order below:
//   - nested subagent transcripts (`<project>/<ts>_<parentSession>/<dispatch>/run-N/*.jsonl`)
//     are attributed to the PARENT session and tagged as subagent dispatches, mirroring
//     how claude-code.ts treats `<session>/subagents/` — their tokens were always
//     counted (the walk recurses), but as phantom independent sessions;
//   - compaction / branch_summary entries that carry `usage` are counted (Pi ≥0.83
//     writes the summarization LLM spend there), attributed to the session's current
//     provider/model since the entry does not store one;
//   - all-zero-usage assistant turns (aborted/error) are skipped, matching Pi's own
//     compaction accounting, so no-op turns don't inflate message/hour counts;
//   - assistant messages emit a dedupKey from `message.responseId`, so /fork and
//     /clone copies of the same API response are counted once (mirrors claude-code.ts);
//   - `cacheWrite1h` is carried so the 1h cache-creation premium prices correctly;
//   - a recorded cost is trusted only when > 0: a $0 total for real tokens means Pi
//     had no rate for the model, and passing it through would short-circuit
//     computeCost and its unpriced-model warning (same split as opencode.ts).
import { z } from 'zod';

import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';
import { walkJsonl, type WalkOptions } from './walk.ts';
import { dedupeEvents } from './claude-code.ts';

const piSessionLineSchema = z.object({
  type: z.literal('session'),
  id: z.string(),
  cwd: z.string().optional(),
});
const piUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cacheWrite1h: z.number().optional(),
  cost: z.object({ total: z.number().optional() }).optional(),
});
const piMessageLineSchema = z.object({
  type: z.literal('message'),
  timestamp: z.string(),
  // Current Pi nests provider/model/usage inside `message`; older logs put them at the top level.
  message: z
    .object({
      role: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      usage: piUsageSchema.optional(),
      responseId: z.string().optional(),
    })
    .optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: piUsageSchema.optional(),
});
const piModelChangeLineSchema = z.object({
  type: z.literal('model_change'),
  provider: z.string().optional(),
  modelId: z.string().optional(),
});
// CompactionEntry / BranchSummaryEntry: `usage` is the LLM spend of generating the
// summary — "included in session token and cost totals" per Pi's session-format doc.
const piSummaryLineSchema = z.object({
  type: z.enum(['compaction', 'branch_summary']),
  timestamp: z.string(),
  usage: piUsageSchema.optional(),
});

type PiSessionLine = z.infer<typeof piSessionLineSchema>;
type PiUsage = z.infer<typeof piUsageSchema>;

/** The agent type used for Pi subagent runs. Pi does not record the dispatched
 *  agent's name in the transcript path, so every dispatch shares this label. */
export const PI_SUBAGENT_TYPE = 'subagent';

// Pi writes dispatched subagent transcripts to
// `<project>/<ts>_<parentSessionId>/<dispatchHash>/run-<n>/<file>.jsonl`.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SUBAGENT_RUN = new RegExp(
  `[/\\\\][^/\\\\]*_(${UUID})[/\\\\]([^/\\\\]+)[/\\\\](run-\\d+)[/\\\\][^/\\\\]+\\.jsonl$`,
  'i',
);

const totalTokens = (u: PiUsage): number => (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
// The schema already proved total is a number when present; a $0 total for real
// tokens means Pi had no rate for the model (see the header note).
const recordedCost = (u: PiUsage): number | undefined =>
  u.cost?.total !== undefined && u.cost.total > 0 ? u.cost.total : undefined;

function toEvent(opts: {
  provider: string;
  model: string;
  timestamp: string;
  sessionId: string;
  projectPath?: string;
  usage: PiUsage;
  dedupKey?: string;
  agent?: { id: string; type: string };
}): UsageEvent {
  const { usage } = opts;
  const cost = recordedCost(usage);
  const event: UsageEvent = {
    tool: 'pi',
    provider: opts.provider,
    model: opts.model,
    timestamp: opts.timestamp,
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cacheWrite1h: usage.cacheWrite1h ?? 0,
    },
  };
  if (opts.dedupKey) event.dedupKey = opts.dedupKey;
  if (opts.agent) event.agent = opts.agent;
  if (cost !== undefined) event.costUSD = cost;
  return event;
}

export async function parsePi(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root, opts)) events.push(...(await parsePiFile(path)));
  // Fork/clone copies the same responses into a new file, so dedup is cross-file.
  // The cached path (extract.ts) runs its own dedupeEvents over all tools; this
  // covers the direct path the same way parseClaudeCode covers its own.
  return dedupeEvents(events);
}

/** Parse one session file. Self-contained (the session record is inside it), so
 *  the result is cacheable against the file's mtime. */
export async function parsePiFile(path: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const run = SUBAGENT_RUN.exec(path);
  // A subagent run is billed to the parent session so per-session facets group it
  // under the work that dispatched it, and tagged so the subagents facet sees it.
  const parentSessionId = run?.[1];
  const agent = run ? { id: `${run[2]}/${run[3]}`, type: PI_SUBAGENT_TYPE } : undefined;
  {
    let session: PiSessionLine | null = null;
    // Compaction/branch_summary entries do not store the model that generated the
    // summary, so track the session's current provider/model while scanning.
    let curProvider: string | undefined;
    let curModel: string | undefined;
    for await (const line of readJsonlLines(path)) {
      const sessionLine = piSessionLineSchema.safeParse(line);
      if (sessionLine.success) {
        session = sessionLine.data;
        continue;
      }
      const modelChange = piModelChangeLineSchema.safeParse(line);
      if (modelChange.success) {
        if (modelChange.data.provider) curProvider = modelChange.data.provider;
        if (modelChange.data.modelId) curModel = modelChange.data.modelId;
        continue;
      }
      const summary = piSummaryLineSchema.safeParse(line);
      if (summary.success) {
        const usage = summary.data.usage;
        if (!usage || !curProvider || !curModel || !session) continue;
        if (totalTokens(usage) === 0 && recordedCost(usage) === undefined) continue;
        events.push(
          toEvent({
            provider: curProvider,
            model: curModel,
            timestamp: summary.data.timestamp,
            sessionId: parentSessionId ?? session.id,
            projectPath: session.cwd,
            usage,
            // Fork/clone copies these entries verbatim (new entry id, same content),
            // so the stable identity is the entry's own timestamp + usage signature.
            dedupKey: `pi|${summary.data.type}|${summary.data.timestamp}|${totalTokens(usage)}|${usage.cost?.total ?? ''}`,
            agent,
          }),
        );
        continue;
      }
      const message = piMessageLineSchema.safeParse(line);
      if (!message.success) continue;
      const msg = message.data;
      if (msg.message?.role !== 'assistant') continue;
      // Pi moved provider/model/usage from the top level into `message`.
      // Prefer the nested location; fall back to legacy top-level fields.
      const provider = msg.message?.provider ?? msg.provider;
      const model = msg.message?.model ?? msg.model;
      const usage = msg.message?.usage ?? msg.usage;
      if (!usage || !provider || !model || !session) continue;
      curProvider = provider;
      curModel = model;
      // Aborted/error turns log all-zero usage (and $0); Pi's own accounting skips
      // them, and counting them would inflate message/hour stats for free no-ops.
      if (totalTokens(usage) === 0 && recordedCost(usage) === undefined) continue;
      // One key per API response; the tool prefix keeps Pi keys from ever
      // colliding with claude-code's `${message.id}|${requestId}` keys.
      const responseId = msg.message?.responseId;
      events.push(
        toEvent({
          provider,
          model,
          timestamp: msg.timestamp,
          sessionId: parentSessionId ?? session.id,
          projectPath: session.cwd,
          usage,
          dedupKey: responseId ? `pi|${responseId}` : undefined,
          agent,
        }),
      );
    }
  }
  return events;
}
