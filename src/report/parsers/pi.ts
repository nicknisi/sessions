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
import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';
import { walkJsonl, type WalkOptions } from './walk.ts';
import { dedupeEvents } from './claude-code.ts';

interface PiSessionLine {
  type: 'session';
  id: string;
  cwd?: string;
}
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cost?: { total?: number };
}
interface PiMessageLine {
  type: 'message';
  timestamp: string;
  // Current Pi nests provider/model/usage inside `message`; older logs put them at the top level.
  message?: { role?: string; provider?: string; model?: string; usage?: PiUsage; responseId?: string };
  provider?: string;
  model?: string;
  usage?: PiUsage;
}
interface PiModelChangeLine {
  type: 'model_change';
  provider?: string;
  modelId?: string;
}
// CompactionEntry / BranchSummaryEntry: `usage` is the LLM spend of generating the
// summary — "included in session token and cost totals" per Pi's session-format doc.
interface PiSummaryLine {
  type: 'compaction' | 'branch_summary';
  timestamp: string;
  usage?: PiUsage;
}

function isSession(v: unknown): v is PiSessionLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'session';
}
function isMessage(v: unknown): v is PiMessageLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'message';
}
function isModelChange(v: unknown): v is PiModelChangeLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'model_change';
}
function isSummary(v: unknown): v is PiSummaryLine {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return t === 'compaction' || t === 'branch_summary';
}

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
const recordedCost = (u: PiUsage): number | undefined =>
  typeof u.cost?.total === 'number' && u.cost.total > 0 ? u.cost.total : undefined;

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
  return {
    tool: 'pi',
    provider: opts.provider,
    model: opts.model,
    timestamp: opts.timestamp,
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
    ...(opts.dedupKey ? { dedupKey: opts.dedupKey } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cacheWrite1h: usage.cacheWrite1h ?? 0,
    },
    ...(cost !== undefined ? { costUSD: cost } : {}),
  };
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
      if (isSession(line)) {
        session = line;
        continue;
      }
      if (isModelChange(line)) {
        if (line.provider) curProvider = line.provider;
        if (line.modelId) curModel = line.modelId;
        continue;
      }
      if (isSummary(line)) {
        const usage = line.usage;
        if (!usage || !curProvider || !curModel || !session) continue;
        if (totalTokens(usage) === 0 && recordedCost(usage) === undefined) continue;
        events.push(
          toEvent({
            provider: curProvider,
            model: curModel,
            timestamp: line.timestamp,
            sessionId: parentSessionId ?? session.id,
            projectPath: session.cwd,
            usage,
            // Fork/clone copies these entries verbatim (new entry id, same content),
            // so the stable identity is the entry's own timestamp + usage signature.
            dedupKey: `pi|${line.type}|${line.timestamp}|${totalTokens(usage)}|${usage.cost?.total ?? ''}`,
            agent,
          }),
        );
        continue;
      }
      if (!isMessage(line)) continue;
      if (line.message?.role !== 'assistant') continue;
      // Pi moved provider/model/usage from the top level into `message`.
      // Prefer the nested location; fall back to legacy top-level fields.
      const provider = line.message?.provider ?? line.provider;
      const model = line.message?.model ?? line.model;
      const usage = line.message?.usage ?? line.usage;
      if (!usage || !provider || !model || !session) continue;
      curProvider = provider;
      curModel = model;
      // Aborted/error turns log all-zero usage (and $0); Pi's own accounting skips
      // them, and counting them would inflate message/hour stats for free no-ops.
      if (totalTokens(usage) === 0 && recordedCost(usage) === undefined) continue;
      const responseId = line.message?.responseId;
      events.push(
        toEvent({
          provider,
          model,
          timestamp: line.timestamp,
          sessionId: parentSessionId ?? session.id,
          projectPath: session.cwd,
          usage,
          // One key per API response; the tool prefix keeps Pi keys from ever
          // colliding with claude-code's `${message.id}|${requestId}` keys.
          ...(responseId ? { dedupKey: `pi|${responseId}` } : {}),
          agent,
        }),
      );
    }
  }
  return events;
}
