// VENDORED VERBATIM from tokenmaxing/src/types.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
// Types match the public data contract in
// nicknisi.com/docs/superpowers/specs/2026-04-28-tokenmaxing-design.md §4

export type ToolId = 'claude-code' | 'pi' | 'codex';
export type KnownProviderId = 'anthropic' | 'openai' | 'baseten';
export type ProviderId = KnownProviderId | (string & {});

export interface ModelRef {
  tool: ToolId;
  provider: ProviderId;
  id: string;
  label: string;
}

export interface ToolBreakdown {
  id: ToolId;
  label: string;
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
}

export interface ProviderBreakdown {
  id: ProviderId;
  label: string;
  tokens: number;
  costUSD: number;
}

export interface ModelBreakdown extends ModelRef {
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
}

export interface ProjectBreakdown {
  label: string;
  tokens: number;
  costUSD: number;
  sessions: number;
}

export interface ToolDailySlot {
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
}

export interface ProviderDailySlot {
  tokens: number;
  costUSD: number;
}

export interface ModelDailySlot {
  tool: ToolId;
  provider: ProviderId;
  id: string;
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
}

export interface ProjectDailySlot {
  tokens: number;
  costUSD: number;
  sessions: number;
}

export interface DailyEntry {
  date: string; // YYYY-MM-DD local
  tokens: number;
  costUSD: number;
  sessions: number;
  messages: number;
  hourCounts: number[]; // length 24, message counts by local hour
  byTool: Partial<Record<ToolId, ToolDailySlot>>;
  byProvider: Record<string, ProviderDailySlot>;
  byModel: ModelDailySlot[];
  byProject: Record<string, ProjectDailySlot>;
}

export interface PullRequest {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  additions: number;
  deletions: number;
  createdAt: string; // ISO UTC
  mergedAt: string | null;
}

export interface WeeklyHighlight {
  weekEnding: string; // YYYY-MM-DD local Sunday
  pullRequests: PullRequest[];
  summary: string | null;
}

export interface InsightsWeek {
  weekEnding: string; // YYYY-MM-DD local Sunday — same keys as WeeklyHighlight
  tokens: number;
  costUSD: number;
  sessions: number; // sum-of-daily approximation (cross-midnight counted twice)
  messages: number;
  byTool: Partial<Record<ToolId, { tokens: number; costUSD: number }>>;
  prsMerged: number; // PRs whose mergedAt falls in this week
  additions: number; // summed over those merged PRs
  deletions: number;
}

export interface Insights {
  weekly: InsightsWeek[]; // dense: every week from first→last active week, zero-filled
  hourCounts: number[]; // length 24, message counts by local hour
  weekdayCounts: number[]; // length 7, message counts by local weekday, 0 = Sunday
}

export interface TokenmaxingData {
  schemaVersion: 2;
  generatedAt: string; // ISO UTC
  period: { from: string; to: string };
  summary: {
    totalCostUSD: number;
    totalTokens: number;
    sessions: number;
    messages: number;
    activeDays: number;
    currentStreakDays: number;
    longestStreakDays: number;
    peakHourLocal: number;
    favoriteModel: ModelRef;
  };
  byTool: ToolBreakdown[];
  byProvider: ProviderBreakdown[];
  byModel: ModelBreakdown[];
  byProject: ProjectBreakdown[];
  daily: DailyEntry[];
  weeklyHighlights: WeeklyHighlight[];
  insights: Insights;
}
