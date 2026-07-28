export type Tool = 'claude' | 'pi' | 'codex' | 'opencode';

/**
 * How a lesson's session id was established, most trustworthy first. See
 * src/provenance.ts for the ladder that produces it.
 *
 * `distilled` is the odd one out and does not come from that ladder: `sessions distill`
 * picked the transcript itself, so the session is known exactly — but the claim is a
 * model's reading of that transcript rather than something anyone stated in it. It gets
 * its own value so it can never be mistaken for `recovered`, which means a lesson an
 * agent wrote was traced back to its conversation after the fact.
 */
export type Provenance = 'meta' | 'hook' | 'env' | 'deferred' | 'recovered' | 'distilled' | 'none';

/** A saved lesson as the primer serves it. */
export interface ContextLesson {
  id: number;
  lesson: string;
  detail: string;
  scope: 'repo' | 'global';
  provenance: Provenance;
  /** False means unauditable — you cannot open the conversation this came from. */
  verified: boolean;
  sessionId: string | null;
  savedAt: string;
}

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
  /** Saved lessons for this repo, repo scope before global. Assertions, not history. */
  lessons: ContextLesson[];
  /** Lessons quarantined as conflicting. A count only — a contested belief is never served as fact. */
  lessonsFlagged: number;
  /** Active in-scope lessons, so a capped list can say how many it left out. */
  lessonsTotal: number;
  /** Corrupt lesson stores moved aside. Non-empty means lessons are missing, not absent. */
  lessonsQuarantined: string[];
  isEmpty: boolean;
}
