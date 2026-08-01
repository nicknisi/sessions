// Sessions-owned report facets: dimensions the vendored tokenmaxing aggregation
// does not model. Computed from the same UsageEvent[] the aggregation consumes,
// so nothing here can drift from the headline totals — but kept in a separate
// module so aggregate.ts / types.ts stay byte-comparable with upstream.
//
// Each facet answers a question the base report cannot:
//   - cache:       how much of the token volume is replayed context, and how well
//                  the prompt cache is working (a falling hit rate means thrash).
//   - subagents:   which dispatched agent types are spending the money, and what
//                  a single dispatch of each one costs.
//   - sessions:    which pieces of work were expensive, and the shape of the
//                  distribution behind them.
//   - modelWeekly: how the split across models is moving, which a single total
//                  per model cannot show.
//   - burn:        pace against the period, and against the period before it.
import type { UsageEvent } from './parsers/types.ts';
import type { ToolId } from './types.ts';
import { computeCost, find, findFamily } from './pricing.ts';
import { localDate, weekEnding } from './parsers/util.ts';
import { resolveProject } from './project.ts';

export interface CacheStats {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** cacheRead / (cacheRead + input + cacheWrite) — the share of prompt context
   *  served from cache rather than re-sent. 0 when there is no input at all. */
  hitRate: number;
  /** What the cacheRead tokens would have cost at full input rates, minus what
   *  they actually cost. Never negative. */
  savedUSD: number;
}

export interface SubagentTypeBreakdown {
  agentType: string;
  tokens: number;
  costUSD: number;
  dispatches: number;
  messages: number;
  /** costUSD / dispatches. What one invocation of this agent type costs, which is
   *  the number that changes which agent you reach for. */
  costPerDispatchUSD: number;
}

export interface SubagentDispatch {
  agentId: string;
  agentType: string;
  project: string;
  date: string; // YYYY-MM-DD local, first message
  tokens: number;
  costUSD: number;
  messages: number;
}

export interface SubagentReport {
  costUSD: number;
  tokens: number;
  dispatches: number;
  /** Subagent cost as a fraction (0..1) of total cost in the period. */
  shareOfCost: number;
  byType: SubagentTypeBreakdown[]; // cost desc
  /** Most expensive individual dispatches, cost desc. Capped — see TOP_DISPATCHES. */
  topDispatches: SubagentDispatch[];
  /** Total dispatches before the topDispatches cap, so a truncated list is visible as truncated. */
  totalDispatches: number;
}

export interface SessionCost {
  tool: ToolId;
  sessionId: string;
  project: string;
  /** The branch the session spent the most on, or null when the tool logs none. */
  branch: string | null;
  date: string; // YYYY-MM-DD local, first message
  tokens: number;
  costUSD: number;
  messages: number;
  /** How much of this session's cost was spent by subagents it dispatched. */
  subagentCostUSD: number;
  /** Custom title or opening prompt, from the search index. Null when the index
   *  has nothing for this session — see ./session-intent.ts. */
  intent: string | null;
}

/** The shape of session spend, across every session in the period rather than the
 *  handful the table shows. A high max next to a low median means a few outliers
 *  carry the bill; a median near the mean means the cost is spread. */
export interface SessionDistribution {
  count: number;
  medianUSD: number;
  p90USD: number;
  maxUSD: number;
  meanUSD: number;
}

/** One week's cost split by model. Weeks are dense between the first and last
 *  active week so the series can be drawn without gaps. */
export interface ModelWeek {
  weekEnding: string; // YYYY-MM-DD local Sunday
  totalUSD: number;
  byModel: Record<string, number>; // model id → cost
}

export interface BurnStats {
  periodDays: number;
  elapsedDays: number;
  spentUSD: number;
  dailyMeanUSD: number;
  /** Straight-line projection to the end of the period. Equals spentUSD once the
   *  period has finished. */
  projectedUSD: number;
  inProgress: boolean;
  /** Cost of the equally long window immediately before this one, or null when
   *  none was gathered (an all-time report has nothing before it). */
  priorPeriodUSD: number | null;
  /** (spent - prior) / prior. Null when there is no prior, or it was zero. */
  changePct: number | null;
}

export interface ReportFacets {
  cache: CacheStats;
  subagents: SubagentReport;
  /** Most expensive sessions, cost desc. Capped — see TOP_SESSIONS. */
  topSessions: SessionCost[];
  /** Sessions in the period before the cap, so a truncated list reads as truncated. */
  totalSessions: number;
  sessionDistribution: SessionDistribution;
  modelWeekly: ModelWeek[];
  /** Models present in the period, cost desc — the draw order for the series. */
  modelOrder: string[];
}

export const TOP_DISPATCHES = 20;
export const TOP_SESSIONS = 15;

// Same convention as aggregate.ts: cache reads are replayed context, not new work.
const billableTokens = (t: UsageEvent['tokens']) => t.input + t.output + t.cacheWrite;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function cacheStats(events: UsageEvent[]): CacheStats {
  let input = 0,
    output = 0,
    write = 0,
    read = 0,
    saved = 0;
  for (const e of events) {
    input += e.tokens.input;
    output += e.tokens.output;
    write += e.tokens.cacheWrite;
    read += e.tokens.cacheRead;
    // Gated on a pricing hit so an unpriced model doesn't push two more warnings
    // per event into the collector for a number we'd end up reporting as 0. A
    // family estimate counts as a hit: computeCost prices it (at the family rate),
    // so gating it out would understate savings for models like Pi's kimi-k3.
    if (e.tokens.cacheRead > 0 && (find(e.model) || findFamily(e.model))) {
      // Price the same tokens twice — once as cache reads, once as fresh input —
      // through the real pricing path, so tiering and per-model rates apply.
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const asRead = computeCost(e.model, { ...zero, cacheRead: e.tokens.cacheRead });
      const asInput = computeCost(e.model, { ...zero, input: e.tokens.cacheRead });
      saved += Math.max(0, asInput - asRead);
    }
  }
  const promptTotal = read + input + write;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: write,
    cacheReadTokens: read,
    hitRate: promptTotal > 0 ? round4(read / promptTotal) : 0,
    savedUSD: round2(saved),
  };
}

function subagentReport(events: UsageEvent[], costOf: (e: UsageEvent) => number, tz: string): SubagentReport {
  interface TypeSlot {
    tokens: number;
    cost: number;
    messages: number;
    dispatches: Set<string>;
  }
  interface DispatchSlot {
    agentType: string;
    project: string;
    date: string;
    tokens: number;
    cost: number;
    messages: number;
  }
  const byType = new Map<string, TypeSlot>();
  const dispatches = new Map<string, DispatchSlot>();
  let totalCost = 0,
    subCost = 0,
    subTokens = 0;

  for (const e of events) {
    const cost = costOf(e);
    totalCost += cost;
    if (!e.agent) continue;
    const tokens = billableTokens(e.tokens);
    subCost += cost;
    subTokens += tokens;

    let t = byType.get(e.agent.type);
    if (!t) {
      t = { tokens: 0, cost: 0, messages: 0, dispatches: new Set() };
      byType.set(e.agent.type, t);
    }
    t.tokens += tokens;
    t.cost += cost;
    t.messages++;
    t.dispatches.add(e.agent.id);

    let d = dispatches.get(e.agent.id);
    if (!d) {
      d = {
        agentType: e.agent.type,
        project: resolveProject(e.projectPath),
        date: localDate(e.timestamp, tz),
        tokens: 0,
        cost: 0,
        messages: 0,
      };
      dispatches.set(e.agent.id, d);
    }
    d.tokens += tokens;
    d.cost += cost;
    d.messages++;
    // A dispatch is dated by its first message, whatever order events arrive in.
    const day = localDate(e.timestamp, tz);
    if (day < d.date) d.date = day;
  }

  const top = [...dispatches.entries()]
    .map(([agentId, d]) => ({
      agentId,
      agentType: d.agentType,
      project: d.project,
      date: d.date,
      tokens: d.tokens,
      costUSD: round2(d.cost),
      messages: d.messages,
    }))
    .sort((a, b) => b.costUSD - a.costUSD || a.agentId.localeCompare(b.agentId));

  return {
    costUSD: round2(subCost),
    tokens: subTokens,
    dispatches: dispatches.size,
    shareOfCost: totalCost > 0 ? round4(subCost / totalCost) : 0,
    byType: [...byType.entries()]
      .map(([agentType, v]) => ({
        agentType,
        tokens: v.tokens,
        costUSD: round2(v.cost),
        dispatches: v.dispatches.size,
        messages: v.messages,
        costPerDispatchUSD: round2(v.cost / Math.max(1, v.dispatches.size)),
      }))
      .sort((a, b) => b.costUSD - a.costUSD || a.agentType.localeCompare(b.agentType)),
    topDispatches: top.slice(0, TOP_DISPATCHES),
    totalDispatches: top.length,
  };
}

function sessionCosts(
  events: UsageEvent[],
  costOf: (e: UsageEvent) => number,
  tz: string,
): { top: SessionCost[]; total: number; allCosts: number[] } {
  interface Slot {
    tool: ToolId;
    sessionId: string;
    project: string;
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    subagentCost: number;
    /** branch → cost, so the reported branch is where the money went rather than
     *  whichever one happened to be checked out first. */
    branches: Map<string, number>;
  }
  const slots = new Map<string, Slot>();
  for (const e of events) {
    const key = `${e.tool}|${e.sessionId}`;
    const day = localDate(e.timestamp, tz);
    let s = slots.get(key);
    if (!s) {
      s = {
        tool: e.tool,
        sessionId: e.sessionId,
        project: resolveProject(e.projectPath),
        date: day,
        tokens: 0,
        cost: 0,
        messages: 0,
        subagentCost: 0,
        branches: new Map(),
      };
      slots.set(key, s);
    }
    const cost = costOf(e);
    s.tokens += billableTokens(e.tokens);
    s.cost += cost;
    s.messages++;
    if (e.agent) s.subagentCost += cost;
    if (day < s.date) s.date = day;
    if (e.branch) s.branches.set(e.branch, (s.branches.get(e.branch) ?? 0) + cost);
  }

  const all = [...slots.values()]
    .map((s) => {
      let branch: string | null = null;
      let best = -1;
      for (const [name, cost] of s.branches) {
        if (cost > best || (cost === best && branch !== null && name < branch)) {
          best = cost;
          branch = name;
        }
      }
      return {
        tool: s.tool,
        sessionId: s.sessionId,
        project: s.project,
        branch,
        date: s.date,
        tokens: s.tokens,
        costUSD: round2(s.cost),
        messages: s.messages,
        subagentCostUSD: round2(s.subagentCost),
        intent: null,
      };
    })
    .sort((a, b) => b.costUSD - a.costUSD || a.sessionId.localeCompare(b.sessionId));

  return { top: all.slice(0, TOP_SESSIONS), total: all.length, allCosts: all.map((x) => x.costUSD) };
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function distribution(costs: number[]): SessionDistribution {
  const sorted = [...costs].sort((a, b) => a - b);
  const sum = sorted.reduce((t, c) => t + c, 0);
  return {
    count: sorted.length,
    medianUSD: round2(percentile(sorted, 50)),
    p90USD: round2(percentile(sorted, 90)),
    maxUSD: round2(sorted[sorted.length - 1] ?? 0),
    meanUSD: round2(sorted.length > 0 ? sum / sorted.length : 0),
  };
}

/** Advance a YYYY-MM-DD local Sunday by n weeks, staying on Sunday. */
function addWeeks(weekEndingYmd: string, n: number): string {
  const [y, m, d] = weekEndingYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n * 7);
  return dt.toISOString().slice(0, 10);
}

/** Weekly cost per model, dense between the first and last active week so the
 *  series draws without gaps, plus the models in draw order (cost desc). */
function modelMix(
  events: UsageEvent[],
  costOf: (e: UsageEvent) => number,
  tz: string,
): { weeks: ModelWeek[]; order: string[] } {
  const weeks = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const e of events) {
    const wk = weekEnding(localDate(e.timestamp, tz));
    let slot = weeks.get(wk);
    if (!slot) {
      slot = new Map();
      weeks.set(wk, slot);
    }
    const cost = costOf(e);
    slot.set(e.model, (slot.get(e.model) ?? 0) + cost);
    totals.set(e.model, (totals.get(e.model) ?? 0) + cost);
  }

  const present = [...weeks.keys()].sort();
  if (present.length > 0) {
    for (let wk = present[0]!; wk <= present[present.length - 1]!; wk = addWeeks(wk, 1)) {
      if (!weeks.has(wk)) weeks.set(wk, new Map());
    }
  }

  const order = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);

  const out: ModelWeek[] = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, slot]) => {
      const byModel: Record<string, number> = {};
      let total = 0;
      for (const [model, cost] of slot) {
        byModel[model] = round2(cost);
        total += cost;
      }
      return { weekEnding: week, totalUSD: round2(total), byModel };
    });
  return { weeks: out, order };
}

const DAY_MS = 86_400_000;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;

/**
 * Pace against the period, and against the period immediately before it.
 *
 * The projection is a straight line from the days already elapsed, so it only
 * says anything while the period is still running; a finished period projects to
 * exactly what it cost. `prior` is null when no comparison window was gathered.
 */
export function computeBurn(
  inRange: UsageEvent[],
  prior: UsageEvent[] | null,
  period: { from: string; to: string; runsTo?: string | null },
  todayLocal: string,
): BurnStats {
  const costOf = (e: UsageEvent) => e.costUSD ?? computeCost(e.model, e.tokens);
  const spent = inRange.reduce((t, e) => t + costOf(e), 0);
  // The period's own horizon, which for `--this-month` is the end of the month
  // rather than the last day that has data. Projecting against the reported range
  // would always say "you will spend exactly what you have spent".
  const end = period.runsTo ?? period.to;
  const periodDays = Math.max(1, daysBetween(period.from, end));
  // Still running only if today falls inside the window with days left in it.
  const inProgress = todayLocal >= period.from && todayLocal < end;
  const elapsed = inProgress ? Math.max(1, daysBetween(period.from, todayLocal)) : periodDays;
  const dailyMean = spent / elapsed;
  const priorUSD = prior === null ? null : round2(prior.reduce((t, e) => t + costOf(e), 0));
  return {
    periodDays,
    elapsedDays: elapsed,
    spentUSD: round2(spent),
    dailyMeanUSD: round2(dailyMean),
    projectedUSD: round2(inProgress ? dailyMean * periodDays : spent),
    inProgress,
    priorPeriodUSD: priorUSD,
    changePct: priorUSD === null || priorUSD === 0 ? null : round4((spent - priorUSD) / priorUSD),
  };
}

export function computeFacets(events: UsageEvent[], tz: string): ReportFacets {
  const costOf = (e: UsageEvent) => e.costUSD ?? computeCost(e.model, e.tokens);
  const sessions = sessionCosts(events, costOf, tz);
  const mix = modelMix(events, costOf, tz);
  return {
    cache: cacheStats(events),
    subagents: subagentReport(events, costOf, tz),
    topSessions: sessions.top,
    totalSessions: sessions.total,
    sessionDistribution: distribution(sessions.allCosts),
    modelWeekly: mix.weeks,
    modelOrder: mix.order,
  };
}
