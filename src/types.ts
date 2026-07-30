export type Tool = 'claude' | 'pi' | 'codex' | 'opencode';

/** A search match localized to one message inside a session. */
export interface MessageHit {
  /** Message index within the session — feeds get_session_messages(offset) directly. */
  index: number;
  role: 'user' | 'assistant';
  snippet: string;
}

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
  files: string[];
  commands: string[];
  errored: boolean;
  /** Top message-level matches (≤3, best first). Empty for metadata-only matches;
   *  absent from the no-index scanner fallback, which cannot localize hits. */
  messageHits?: MessageHit[];
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
  errored: boolean;
  /** --file values (repeatable): substring path filters, AND-composed. */
  files: string[];
}

export interface ContextSession {
  sessionId: string;
  tool: Tool;
  branch: string;
  date: string;
  messageCount: number;
  intent: string; // first_prompt
  /** Parsed files_touched, capped at MAX_FILES — fileCount carries the true total. */
  files: string[];
  /** Total files touched before truncation, so a capped list never reads as complete. */
  fileCount: number;
  opening: string; // first_prompt (verbatim opener)
  closing: { user: string; assistant: string };
}

export interface ContextHeadline {
  date: string;
  tool: Tool;
  branch: string;
  intent: string;
}

/** An approved memory as the primer carries it — the claim and enough to weigh it. */
export interface PrimerMemory {
  text: string;
  kind: string;
  scope: string;
  /** A standing constraint: carried first, and never withheld by the cap. */
  alwaysOn: boolean;
}

export interface ContextPrimer {
  repoLabel: string; // basename(container)
  toolFilter: Tool | '';
  recent: ContextSession[];
  headlines: ContextHeadline[];
  /**
   * Approved memories for this repo, always-on first, capped at PRIMER_MEMORY_LIMIT.
   *
   * The primer is the only guaranteed delivery: `get_memory` is topic-conditional and
   * an agent has to choose to call it, which is the same "only fires when the model
   * decides to" failure that left the previous lesson store at one row for months.
   */
  memory: PrimerMemory[];
  /** Approved and in scope, so a capped primer can say how many it left out. */
  memoryTotal: number;
  isEmpty: boolean;
}
