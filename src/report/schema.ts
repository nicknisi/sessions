// Sessions-owned usage report schema — the public contract for `sessions report`.
// Independent of tokenmaxing's gist shape: no weeklyHighlights, no PR fields.
// The internal aggregation (vendored from tokenmaxing) is mapped down to this
// via `toUsageReport`. Generic breakdown/daily shapes are reused from the
// aggregation types since they carry no tokenmaxing-specific concerns.
import type {
  TokenmaxingData,
  ToolBreakdown,
  ProviderBreakdown,
  ModelBreakdown,
  ProjectBreakdown,
  DailyEntry,
  ModelRef,
  ToolId,
} from './types.ts';

export type { ToolBreakdown, ProviderBreakdown, ModelBreakdown, ProjectBreakdown, DailyEntry, ModelRef, ToolId };

export interface UsageSummary {
  totalCostUSD: number;
  totalTokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  currentStreakDays: number;
  longestStreakDays: number;
  peakHourLocal: number;
  favoriteModel: ModelRef;
}

export interface UsageWeek {
  weekEnding: string; // YYYY-MM-DD local Sunday
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
  byTool: Partial<Record<ToolId, { tokens: number; costUSD: number }>>;
}

export interface UsageInsights {
  weekly: UsageWeek[]; // dense: every week from first→last active week
  hourCounts: number[]; // length 24, by local hour
  weekdayCounts: number[]; // length 7, 0 = Sunday
}

// A logged model that had tokens but no pricing match. Surfaced loudly
// (CLI stderr + this JSON field + HTML notice) — never a silent $0.
export interface PricingWarning {
  model: string;
  tokens: number;
}

export interface UsageReport {
  generator: 'sessions';
  // Kept at 1: `warnings` is an additive field, so this remains non-breaking.
  version: 1;
  generatedAt: string; // ISO UTC
  period: { from: string; to: string };
  summary: UsageSummary;
  byTool: ToolBreakdown[];
  byProvider: ProviderBreakdown[];
  byModel: ModelBreakdown[];
  byProject: ProjectBreakdown[];
  daily: DailyEntry[];
  insights: UsageInsights;
  warnings: PricingWarning[]; // unpriced models with tokens; [] when all priced
}

// Map the internal aggregation result to the sessions-owned public schema,
// dropping tokenmaxing/website-specific fields (weeklyHighlights + per-week PR counts).
export function toUsageReport(data: TokenmaxingData): UsageReport {
  return {
    generator: 'sessions',
    version: 1,
    generatedAt: data.generatedAt,
    period: data.period,
    summary: data.summary,
    byTool: data.byTool,
    byProvider: data.byProvider,
    byModel: data.byModel,
    byProject: data.byProject,
    daily: data.daily,
    insights: {
      weekly: data.insights.weekly.map((w) => ({
        weekEnding: w.weekEnding,
        tokens: w.tokens,
        costUSD: w.costUSD,
        sessions: w.sessions,
        messages: w.messages,
        byTool: w.byTool,
      })),
      hourCounts: data.insights.hourCounts,
      weekdayCounts: data.insights.weekdayCounts,
    },
    // Kept pure: runReport overwrites this with drainPricingWarnings() after
    // aggregation. toUsageReport itself prices nothing, so it starts empty.
    warnings: [],
  };
}
