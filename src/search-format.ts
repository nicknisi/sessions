// src/search-format.ts
import type { SessionResult, Tool } from './types';

/** The exact resume affordance both the CLI (clipboard) and the MCP (returned field) use. */
export function buildResumeCommand(tool: Tool, cwd: string, sessionId: string): string {
  if (tool === 'claude') return `cd ${cwd} && claude --resume ${sessionId}`;
  return `cd ${cwd}`; // pi, codex: no direct session resume
}

export interface FormattedResult {
  sessionId: string;
  tool: Tool;
  date: string;
  createdAt: string;
  project: string;
  title: string | null;
  snippet: string;
  messageCount: number;
  files: string[];
  commands: string[];
  errored: boolean;
  exists: boolean;
  filePath: string;
  resumeCommand: string;
}

/** Single source of truth for the search-result payload shared across surfaces. */
export function formatResult(r: SessionResult): FormattedResult {
  return {
    sessionId: r.sessionId,
    tool: r.tool,
    date: r.date,
    createdAt: r.createdAt,
    project: r.cwd,
    title: r.customTitle || null,
    snippet: r.displayText,
    messageCount: r.messageCount,
    files: r.files,
    commands: r.commands,
    errored: r.errored,
    exists: r.exists,
    filePath: r.filePath,
    resumeCommand: buildResumeCommand(r.tool, r.cwd, r.sessionId),
  };
}
