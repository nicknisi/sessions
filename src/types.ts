export type Tool = 'claude' | 'pi' | 'codex';

export interface SessionResult {
  date: string;
  createdAt: string;
  cwd: string;
  tool: Tool;
  sessionId: string;
  displayText: string;
  customTitle: string;
  messageCount: number;
  filePath: string;
  exists: boolean;
}

export interface DigestSessionDetail {
  sessionId: string;
  tool: string;
  title: string;
  messageCount: number;
  filePath: string;
  userMessages: string[];
}

export interface DigestProjectGroup {
  project: string;
  sessions: number;
  totalMessages: number;
  tools: string[];
  topics: string[];
  filePaths: string[];
  sessionDetails?: DigestSessionDetail[];
}

export interface DigestDay {
  date: string;
  sessions: number;
  projects: DigestProjectGroup[];
}

export interface ActivityDigest {
  period: { start: string; end: string };
  totalSessions: number;
  totalMessages: number;
  tools: Record<string, number>;
  projects: string[];
  days: DigestDay[];
}

export interface SessionMetrics {
  period: { start: string; end: string };
  totalSessions: number;
  totalMessages: number;
  toolBreakdown: Record<string, number>;
  projectBreakdown: { project: string; sessions: number; messages: number }[];
  dailyActivity: { date: string; sessions: number; messages: number }[];
  activeHours: Record<string, number>;
}

export interface CliArgs {
  toolFilter: Tool | '';
  searchQuery: string;
  scopeHere: boolean;
}

export interface ContextSession {
  sessionId: string;
  tool: Tool;
  branch: string;
  date: string;
  messageCount: number;
  intent: string; // first_prompt
  files: string[]; // parsed files_touched
  opening: string; // first_prompt (verbatim opener)
  closing: { user: string; assistant: string };
}

export interface ContextHeadline {
  date: string;
  tool: Tool;
  branch: string;
  intent: string;
}

export interface ContextPrimer {
  repoLabel: string; // basename(container)
  toolFilter: Tool | '';
  recent: ContextSession[];
  headlines: ContextHeadline[];
  isEmpty: boolean;
}
