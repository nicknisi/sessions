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

export interface DigestSession {
  sessionId: string;
  tool: Tool;
  project: string;
  title: string;
  firstPrompt: string;
  messageCount: number;
  createdAt: string;
  lastActive: string;
  filePath: string;
  userMessages: string[];
}

export interface DigestDay {
  date: string;
  sessions: DigestSession[];
}

export interface ActivityDigest {
  period: { start: string; end: string };
  totalSessions: number;
  totalMessages: number;
  tools: Record<string, number>;
  projects: string[];
  days: DigestDay[];
}

export interface CliArgs {
  toolFilter: Tool | '';
  searchQuery: string;
  scopeHere: boolean;
}
