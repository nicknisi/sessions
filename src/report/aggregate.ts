// VENDORED VERBATIM from tokenmaxing/src/aggregate.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
import type {
  TokenmaxingData,
  ToolBreakdown,
  ProviderBreakdown,
  ModelBreakdown,
  ProjectBreakdown,
  DailyEntry,
  WeeklyHighlight,
  PullRequest,
  ToolId,
  ModelRef,
  ToolDailySlot,
  ProviderDailySlot,
  ModelDailySlot,
  ProjectDailySlot,
  Insights,
  InsightsWeek,
} from './types.ts';
import type { UsageEvent } from './parsers/types.ts';
import { computeCost } from './pricing.ts';
import { localDate, localHour, weekEnding } from './parsers/util.ts';
import { resolveProject } from './project.ts';

const TOOL_LABEL: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  pi: 'Pi',
  codex: 'Codex',
};
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  baseten: 'Baseten',
};

export interface AggregateInput {
  events: UsageEvent[];
  prs: PullRequest[];
  now: string;
  tz: string;
  exclude: Set<string>; // basenames (existing — keep name for tests)
  excludePrefixes?: string[]; // optional prefix matches
  include?: Set<string>; // allowlist basenames; if absent or empty, no allowlist
  includePrefixes?: string[]; // allowlist prefixes
  priorDaily: DailyEntry[]; // pass [] when no merge desired (e.g. --reset)
  priorWeeklyHighlights?: WeeklyHighlight[];
}

interface EnrichedEvent {
  e: UsageEvent;
  cost: number;
  date: string;
  hour: number;
  basename: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
// Excludes cache_read (replayed prior context — mostly free reuse, not "new work").
// cache_creation (cacheWrite) IS counted because those are new tokens written to cache.
const totalTokens = (t: UsageEvent['tokens']) => t.input + t.output + t.cacheWrite;

function enrich(events: UsageEvent[], tz: string): EnrichedEvent[] {
  return events.map((e) => ({
    e,
    cost: e.costUSD ?? computeCost(e.model, e.tokens),
    date: localDate(e.timestamp, tz),
    hour: localHour(e.timestamp, tz),
    basename: resolveProject(e.projectPath),
  }));
}

// Build a fresh-from-events DailyEntry for every active local date.
function buildFreshDaily(enriched: EnrichedEvent[]): DailyEntry[] {
  type DaySlot = {
    date: string;
    tokens: number;
    cost: number;
    sessions: Set<string>;
    messages: number;
    hourCounts: number[];
    byTool: Map<ToolId, { tokens: number; cost: number; sessions: Set<string>; messages: number }>;
    byProvider: Map<string, { tokens: number; cost: number }>;
    byModel: Map<
      string,
      {
        ref: { tool: ToolId; provider: string; id: string };
        tokens: number;
        cost: number;
        sessions: Set<string>;
        messages: number;
      }
    >;
    byProject: Map<string, { tokens: number; cost: number; sessions: Set<string> }>;
  };
  const days = new Map<string, DaySlot>();
  for (const x of enriched) {
    let d = days.get(x.date);
    if (!d) {
      d = {
        date: x.date,
        tokens: 0,
        cost: 0,
        sessions: new Set(),
        messages: 0,
        hourCounts: new Array<number>(24).fill(0),
        byTool: new Map(),
        byProvider: new Map(),
        byModel: new Map(),
        byProject: new Map(),
      };
      days.set(x.date, d);
    }
    const tt = totalTokens(x.e.tokens);
    const sessKey = `${x.e.tool}|${x.e.sessionId}`;

    d.tokens += tt;
    d.cost += x.cost;
    d.sessions.add(sessKey);
    d.messages++;
    d.hourCounts[x.hour]! += 1;

    // byTool
    let tSlot = d.byTool.get(x.e.tool);
    if (!tSlot) {
      tSlot = { tokens: 0, cost: 0, sessions: new Set(), messages: 0 };
      d.byTool.set(x.e.tool, tSlot);
    }
    tSlot.tokens += tt;
    tSlot.cost += x.cost;
    tSlot.sessions.add(sessKey);
    tSlot.messages++;

    // byProvider
    let pSlot = d.byProvider.get(x.e.provider);
    if (!pSlot) {
      pSlot = { tokens: 0, cost: 0 };
      d.byProvider.set(x.e.provider, pSlot);
    }
    pSlot.tokens += tt;
    pSlot.cost += x.cost;

    // byModel
    const mKey = `${x.e.tool}|${x.e.provider}|${x.e.model}`;
    let mSlot = d.byModel.get(mKey);
    if (!mSlot) {
      mSlot = {
        ref: { tool: x.e.tool, provider: x.e.provider, id: x.e.model },
        tokens: 0,
        cost: 0,
        sessions: new Set(),
        messages: 0,
      };
      d.byModel.set(mKey, mSlot);
    }
    mSlot.tokens += tt;
    mSlot.cost += x.cost;
    mSlot.sessions.add(sessKey);
    mSlot.messages++;

    // byProject
    let prSlot = d.byProject.get(x.basename);
    if (!prSlot) {
      prSlot = { tokens: 0, cost: 0, sessions: new Set() };
      d.byProject.set(x.basename, prSlot);
    }
    prSlot.tokens += tt;
    prSlot.cost += x.cost;
    prSlot.sessions.add(sessKey);
  }

  const out: DailyEntry[] = [];
  for (const d of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const byToolObj: Partial<Record<ToolId, ToolDailySlot>> = {};
    for (const [k, v] of d.byTool)
      byToolObj[k] = { tokens: v.tokens, costUSD: round2(v.cost), sessions: v.sessions.size, messages: v.messages };

    const byProviderObj: Record<string, ProviderDailySlot> = {};
    for (const [k, v] of d.byProvider) byProviderObj[k] = { tokens: v.tokens, costUSD: round2(v.cost) };

    const byModelArr: ModelDailySlot[] = [...d.byModel.values()]
      .map((v) => ({
        ...v.ref,
        tokens: v.tokens,
        costUSD: round2(v.cost),
        sessions: v.sessions.size,
        messages: v.messages,
      }))
      .sort((a, b) => b.costUSD - a.costUSD);

    const byProjectObj: Record<string, ProjectDailySlot> = {};
    for (const [k, v] of d.byProject)
      byProjectObj[k] = { tokens: v.tokens, costUSD: round2(v.cost), sessions: v.sessions.size };

    out.push({
      date: d.date,
      tokens: d.tokens,
      costUSD: round2(d.cost),
      sessions: d.sessions.size,
      messages: d.messages,
      hourCounts: d.hourCounts,
      byTool: byToolObj,
      byProvider: byProviderObj,
      byModel: byModelArr,
      byProject: byProjectObj,
    });
  }
  return out;
}

// Merge by date — fresh wins on collision.
export function mergeDaily(prior: DailyEntry[], fresh: DailyEntry[]): DailyEntry[] {
  const m = new Map<string, DailyEntry>();
  for (const d of prior) m.set(d.date, d);
  for (const d of fresh) m.set(d.date, d);
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Re-derive top-level views by summing daily entries.
function deriveTopLevel(daily: DailyEntry[]) {
  const byToolMap = new Map<ToolId, { tokens: number; costUSD: number; sessions: number; messages: number }>();
  const byProviderMap = new Map<string, { tokens: number; costUSD: number }>();
  const byModelMap = new Map<
    string,
    { tool: ToolId; provider: string; id: string; tokens: number; costUSD: number; sessions: number; messages: number }
  >();
  const byProjectMap = new Map<string, { tokens: number; costUSD: number; sessions: number }>();
  const hourCounts = new Array<number>(24).fill(0);
  let totalTokens = 0,
    totalCost = 0,
    totalMessages = 0,
    totalSessions = 0;

  for (const d of daily) {
    totalTokens += d.tokens;
    totalCost += d.costUSD;
    totalMessages += d.messages;
    totalSessions += d.sessions; // sum-across-days approximation; cross-midnight sessions counted twice
    for (let h = 0; h < 24; h++) hourCounts[h]! += d.hourCounts[h] ?? 0;

    for (const [k, v] of Object.entries(d.byTool) as [ToolId, ToolDailySlot][]) {
      const slot = byToolMap.get(k) ?? { tokens: 0, costUSD: 0, sessions: 0, messages: 0 };
      slot.tokens += v.tokens;
      slot.costUSD += v.costUSD;
      slot.sessions += v.sessions;
      slot.messages += v.messages;
      byToolMap.set(k, slot);
    }
    for (const [k, v] of Object.entries(d.byProvider)) {
      const slot = byProviderMap.get(k) ?? { tokens: 0, costUSD: 0 };
      slot.tokens += v.tokens;
      slot.costUSD += v.costUSD;
      byProviderMap.set(k, slot);
    }
    for (const m of d.byModel) {
      const k = `${m.tool}|${m.provider}|${m.id}`;
      const slot = byModelMap.get(k) ?? {
        tool: m.tool,
        provider: m.provider,
        id: m.id,
        tokens: 0,
        costUSD: 0,
        sessions: 0,
        messages: 0,
      };
      slot.tokens += m.tokens;
      slot.costUSD += m.costUSD;
      slot.sessions += m.sessions;
      slot.messages += m.messages;
      byModelMap.set(k, slot);
    }
    for (const [k, v] of Object.entries(d.byProject)) {
      const slot = byProjectMap.get(k) ?? { tokens: 0, costUSD: 0, sessions: 0 };
      slot.tokens += v.tokens;
      slot.costUSD += v.costUSD;
      slot.sessions += v.sessions;
      byProjectMap.set(k, slot);
    }
  }

  const byTool: ToolBreakdown[] = [...byToolMap.entries()]
    .map(([id, v]) => ({
      id,
      label: TOOL_LABEL[id] ?? id,
      tokens: v.tokens,
      costUSD: round2(v.costUSD),
      sessions: v.sessions,
      messages: v.messages,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const byProvider: ProviderBreakdown[] = [...byProviderMap.entries()]
    .map(([id, v]) => ({ id, label: PROVIDER_LABEL[id] ?? id, tokens: v.tokens, costUSD: round2(v.costUSD) }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const byModel: ModelBreakdown[] = [...byModelMap.values()]
    .map((v) => ({
      tool: v.tool,
      provider: v.provider,
      id: v.id,
      label: v.id,
      tokens: v.tokens,
      costUSD: round2(v.costUSD),
      sessions: v.sessions,
      messages: v.messages,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const byProject: ProjectBreakdown[] = [...byProjectMap.entries()]
    .map(([label, v]) => ({ label, tokens: v.tokens, costUSD: round2(v.costUSD), sessions: v.sessions }))
    .sort((a, b) => b.costUSD - a.costUSD);

  return {
    byTool,
    byProvider,
    byModel,
    byProject,
    hourCounts,
    totalTokens,
    totalCost: round2(totalCost),
    totalMessages,
    totalSessions,
  };
}

function computeStreaks(activeDates: Set<string>, todayLocal: string): { current: number; longest: number } {
  if (activeDates.size === 0) return { current: 0, longest: 0 };
  const sorted = [...activeDates].sort();
  let longest = 1,
    run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]! + 'T00:00:00Z');
    const cur = new Date(sorted[i]! + 'T00:00:00Z');
    const diff = Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  let current = 0;
  if (activeDates.has(todayLocal)) {
    const cursor = new Date(todayLocal + 'T00:00:00Z');
    while (activeDates.has(cursor.toISOString().slice(0, 10))) {
      current++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }
  return { current, longest };
}

function peakHourFromHistogram(hours: number[]): number {
  let best = 0,
    bestCount = -1;
  for (let h = 0; h < 24; h++) {
    const c = hours[h] ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = h;
    }
  }
  return best;
}

function favoriteModelFromTopLevel(byModel: ModelBreakdown[]): ModelRef {
  if (byModel.length === 0) {
    return { tool: 'claude-code', provider: 'anthropic', id: 'unknown', label: 'Unknown' };
  }
  // Sort by messages desc, tie-break lex by tool|provider|id (deterministic regardless of input order)
  const sorted = [...byModel].sort((a, b) => {
    if (b.messages !== a.messages) return b.messages - a.messages;
    return `${a.tool}|${a.provider}|${a.id}`.localeCompare(`${b.tool}|${b.provider}|${b.id}`);
  });
  const m = sorted[0]!;
  return { tool: m.tool, provider: m.provider, id: m.id, label: m.label };
}

// Advance a YYYY-MM-DD week-ending (local Sunday) by `n` weeks, staying on Sunday.
function addWeeks(weekEndingYmd: string, n: number): string {
  const [y, m, d] = weekEndingYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n * 7);
  return dt.toISOString().slice(0, 10);
}

// Build the weekly trend series + activity profiles from merged daily + PRs.
// Week range is defined by daily activity; PRs only contribute to weeks inside
// that range (consistent with the page period). Weekly array is dense.
export function computeInsights(daily: DailyEntry[], prs: PullRequest[], tz: string, hourCounts: number[]): Insights {
  interface WeekSlot {
    tokens: number;
    costUSD: number;
    sessions: number;
    messages: number;
    byTool: Map<ToolId, { tokens: number; costUSD: number }>;
    prsMerged: number;
    additions: number;
    deletions: number;
  }
  const newSlot = (): WeekSlot => ({
    tokens: 0,
    costUSD: 0,
    sessions: 0,
    messages: 0,
    byTool: new Map(),
    prsMerged: 0,
    additions: 0,
    deletions: 0,
  });

  const weeks = new Map<string, WeekSlot>();
  const weekdayCounts = new Array<number>(7).fill(0);

  // 1. Accumulate per-week activity from daily entries.
  for (const d of daily) {
    const wk = weekEnding(d.date);
    let s = weeks.get(wk);
    if (!s) {
      s = newSlot();
      weeks.set(wk, s);
    }
    s.tokens += d.tokens;
    s.costUSD += d.costUSD;
    s.sessions += d.sessions;
    s.messages += d.messages;
    for (const [k, v] of Object.entries(d.byTool) as [ToolId, ToolDailySlot][]) {
      const t = s.byTool.get(k) ?? { tokens: 0, costUSD: 0 };
      t.tokens += v.tokens;
      t.costUSD += v.costUSD;
      s.byTool.set(k, t);
    }
    weekdayCounts[new Date(d.date + 'T00:00:00Z').getUTCDay()]! += d.messages;
  }

  // 2. Dense-fill missing weeks between first and last active week.
  const present = [...weeks.keys()].sort();
  if (present.length > 0) {
    const first = present[0]!;
    const last = present[present.length - 1]!;
    for (let wk = first; wk <= last; wk = addWeeks(wk, 1)) {
      if (!weeks.has(wk)) weeks.set(wk, newSlot());
    }
  }

  // 3. Fold in merged PRs — only weeks already in range get counted.
  for (const pr of prs) {
    if (pr.state !== 'merged' || !pr.mergedAt) continue;
    const wk = weekEnding(localDate(pr.mergedAt, tz));
    const s = weeks.get(wk);
    if (!s) continue;
    s.prsMerged += 1;
    s.additions += pr.additions;
    s.deletions += pr.deletions;
  }

  // 4. Emit sorted dense array.
  const weekly: InsightsWeek[] = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekEnding, s]) => {
      const byTool: Partial<Record<ToolId, { tokens: number; costUSD: number }>> = {};
      for (const [k, v] of s.byTool) byTool[k] = { tokens: v.tokens, costUSD: round2(v.costUSD) };
      return {
        weekEnding,
        tokens: s.tokens,
        costUSD: round2(s.costUSD),
        sessions: s.sessions,
        messages: s.messages,
        byTool,
        prsMerged: s.prsMerged,
        additions: s.additions,
        deletions: s.deletions,
      };
    });

  return { weekly, hourCounts: hourCounts.slice(), weekdayCounts };
}

export function aggregate(input: AggregateInput): TokenmaxingData {
  const { tz, priorDaily, prs, now } = input;
  const includeBase = input.include ?? new Set<string>();
  const includePref = input.includePrefixes ?? [];
  const hasAllowlist = includeBase.size > 0 || includePref.length > 0;
  const isAllowed = (label: string) => {
    if (!hasAllowlist) return true;
    return includeBase.has(label) || includePref.some((p) => label.startsWith(p));
  };

  const excludeBase = input.exclude;
  const excludePref = input.excludePrefixes ?? [];
  const isExcluded = (label: string) => excludeBase.has(label) || excludePref.some((p) => label.startsWith(p));

  const isKept = (label: string) => isAllowed(label) && !isExcluded(label);

  // 1. Filter events down to kept basenames
  const filtered = input.events.filter((e) => isKept(resolveProject(e.projectPath)));

  // 2. Build fresh daily entries from current local events
  const enriched = enrich(filtered, tz);
  const freshDaily = buildFreshDaily(enriched);

  // 3. Merge with prior gist daily (fresh wins on date collision)
  //    Apply the same exclusion to prior data so removing from exclude.json
  //    isn't required to drop a basename from already-published days.
  const filteredPrior = priorDaily.map((d) => {
    const byTool = { ...d.byTool };
    const byProvider = { ...d.byProvider };
    const byModel = d.byModel.slice();
    const byProject: Record<string, ProjectDailySlot> = {};
    let droppedTokens = 0,
      droppedCost = 0,
      droppedSessions = 0;
    for (const [k, v] of Object.entries(d.byProject)) {
      if (!isKept(k)) {
        droppedTokens += v.tokens;
        droppedCost += v.costUSD;
        droppedSessions += v.sessions;
      } else {
        byProject[k] = v;
      }
    }
    return {
      ...d,
      tokens: d.tokens - droppedTokens,
      costUSD: round2(d.costUSD - droppedCost),
      sessions: d.sessions - droppedSessions,
      byTool,
      byProvider,
      byModel,
      byProject,
    };
  });
  const merged = mergeDaily(filteredPrior, freshDaily);

  // 4. Re-derive top-level breakdowns + summary stats from merged daily
  const top = deriveTopLevel(merged);

  const activeDates = new Set(merged.map((d) => d.date));
  const todayLocal = localDate(now, tz);
  const { current, longest } = computeStreaks(activeDates, todayLocal);
  const dates = [...activeDates].sort();

  // 5. Weekly highlights — always fresh from current PR data, no merge
  const weekMap = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const ts = pr.mergedAt ?? pr.createdAt;
    const localDay = localDate(ts, tz);
    const wk = weekEnding(localDay);
    const arr = weekMap.get(wk) ?? [];
    arr.push(pr);
    weekMap.set(wk, arr);
  }
  const weeklyHighlights: WeeklyHighlight[] = [...weekMap.entries()]
    .map(([weekEnding, list]) => ({
      weekEnding,
      pullRequests: [...list].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)),
      summary: null,
    }))
    .sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));

  // Carry forward existing summaries from prior gist data
  const priorSummaries = new Map<string, string>();
  for (const w of input.priorWeeklyHighlights ?? []) {
    if (w.summary) priorSummaries.set(w.weekEnding, w.summary);
  }
  const weeklyHighlightsFinal = weeklyHighlights.map((w) => ({
    ...w,
    summary: priorSummaries.get(w.weekEnding) ?? w.summary,
  }));

  const period = { from: dates[0] ?? todayLocal, to: todayLocal };
  const weeklyHighlightsFiltered = weeklyHighlightsFinal.filter((w) => w.weekEnding >= period.from);

  return {
    schemaVersion: 2,
    generatedAt: now,
    period,
    summary: {
      totalCostUSD: top.totalCost,
      totalTokens: top.totalTokens,
      sessions: top.totalSessions,
      messages: top.totalMessages,
      activeDays: activeDates.size,
      currentStreakDays: current,
      longestStreakDays: longest,
      peakHourLocal: peakHourFromHistogram(top.hourCounts),
      favoriteModel: favoriteModelFromTopLevel(top.byModel),
    },
    byTool: top.byTool,
    byProvider: top.byProvider,
    byModel: top.byModel,
    byProject: top.byProject,
    daily: merged,
    weeklyHighlights: weeklyHighlightsFiltered,
    insights: computeInsights(merged, prs, tz, top.hourCounts),
  };
}
