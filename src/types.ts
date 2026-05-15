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

export interface CliArgs {
  toolFilter: Tool | '';
  searchQuery: string;
  scopeHere: boolean;
}
