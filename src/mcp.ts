import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSessions, grepSessions, getActivityDigest, getContextPrimer } from './cache';
import { getSessionMetrics } from './report/metrics';
import { formatResult, buildResumeCommand } from './search-format';
import { getSessionMessages } from './record';
import { buildSessionDigest } from './digest';
import { resolveRepo } from './repo';
import { readSessionLines, toolForSession } from './session-io';
import { rememberLesson, LESSON_MAX_CHARS, DETAIL_MAX_CHARS, type Scope } from './memory';
import { resolveProvenance } from './provenance';
import { type Tool } from './types';

const server = new McpServer(
  {
    name: 'sessions',
    version: '1.2.0',
  },
  {
    instructions:
      'Searchable history of every past AI coding session (Claude Code, Codex, Pi, OpenCode) on this machine — the conversations behind the commits. Decisions, rationale, abandoned approaches, and unfinished threads live here, not in git. ' +
      'Use proactively, without being asked, when: the user references prior work ("last time", "didn\'t we already", "that approach we tried", "why did we do it this way"); work resumes on a repo after a gap (call get_context_primer before starting); a why-question isn\'t answered by the code or git history; or a bug/task smells like something solved before (search_sessions first, re-derive second). ' +
      'Two ways to find things: search_sessions ranks the most relevant sessions for a topic (top-k, not exhaustive); grep_sessions finds every message matching a literal string or regex (exhaustive — use it for "every time", counts, or exact-pattern needs). ' +
      'Prefer bounded calls: get_session_digest over paging full transcripts. ' +
      'Sessions are a record of what happened; lessons are assertions someone made about this repo. get_context_primer carries both — call it before starting substantive work — and remember_lesson is how a hard-won finding gets into it instead of being re-derived next session.',
  },
);

// Exported, testable seam: the search_sessions tool delegates to this so its behavior
// (errored filter, per-result metadata, resumeCommand) can be unit-tested without MCP.
export async function runSearchSessions(args: {
  query?: string;
  tool?: Tool;
  project?: string;
  errored?: boolean;
  files?: string[];
  limit?: number;
}): Promise<{ content: { type: 'text'; text: string }[] }> {
  const results = await searchSessions(args.query ?? '', {
    tool: args.tool ?? '',
    project: args.project ?? '',
    errored: args.errored,
    files: args.files,
    limit: args.limit ?? 20,
  });

  if (results.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No sessions found.' }] };
  }

  const formatted = results.map(formatResult);
  return { content: [{ type: 'text' as const, text: JSON.stringify(formatted) }] };
}

server.tool(
  'search_sessions',
  'Search across all past AI coding sessions from Claude Code, Codex, Pi, and OpenCode. Use proactively when the user references prior work ("didn\'t we already", "last time", "that thing we tried"), when a why-question isn\'t answered by code or git history, or before re-solving a problem that may have been solved in an earlier session. Results are ranked by relevance and capped (top-k) — NOT exhaustive; for every-occurrence, counts, or an exact string/regex, use grep_sessions instead. Returns matching sessions with snippets, a bounded sample of the files/commands involved (filesIndexed/commandsIndexed say how many the index holds for that session — itself capped at 50 files and 100 commands, so treat them as a floor; commands are clipped to their first line), an errored flag, and a ready-to-run resume command. Each result includes messageHits — the specific matching messages (index, role, snippet); pass a hit\'s index as the offset to get_session_messages to jump straight to the matched exchange. To answer "which sessions touched this file?", pass files (with no query) — results come back newest-first.',
  {
    query: z
      .string()
      .optional()
      .describe(
        'Text to search across session messages, commands, file paths, errors, and reasoning. Natural-language queries work — results are ranked by relevance and any term may match. Omit to list recent sessions.',
      ),
    tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
    errored: z.boolean().optional().describe('Only return sessions that hit an error'),
    files: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to sessions that touched or read these paths — pass a path suffix or full path (matching is substring; longer paths are more precise). Multiple paths must all match. With no query, results are newest-first.',
      ),
    limit: z.number().optional().default(20).describe('Max results to return (default 20)'),
  },
  async ({ query, tool, project, errored, files, limit }) =>
    runSearchSessions({ query, tool, project, errored, files, limit }),
);

// Exported, testable seam: the grep_sessions tool delegates here so its exhaustive-match
// behavior, totals, and truncation can be unit-tested without MCP plumbing.
export async function runGrepSessions(args: {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  role?: 'user' | 'assistant';
  tool?: Tool;
  project?: string;
  after?: string;
  before?: string;
  limit?: number;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  let result;
  try {
    result = await grepSessions(args.pattern, {
      regex: args.regex,
      ignoreCase: args.ignoreCase,
      role: args.role,
      tool: args.tool ?? '',
      project: args.project ?? '',
      after: args.after,
      before: args.before,
      limit: args.limit ?? 50,
    });
  } catch (e) {
    return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }

  if (result.totalHits === 0) {
    return { content: [{ type: 'text' as const, text: 'No matching messages found.' }] };
  }

  const payload = {
    totalHits: result.totalHits,
    totalSessions: result.totalSessions,
    returnedHits: result.returnedHits,
    truncated: result.truncated,
    hits: result.hits.map((h) => ({
      tool: h.tool,
      project: h.project,
      sessionId: h.sessionId,
      filePath: h.filePath,
      date: h.date,
      role: h.role,
      msgIndex: h.msgIndex,
      snippet: h.snippet,
      resumeCommand: buildResumeCommand(h.tool, h.project, h.sessionId),
    })),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

server.tool(
  'grep_sessions',
  'Exhaustively find EVERY message across all past sessions matching a literal string or regex — use this (not search_sessions) whenever completeness or a count matters: "every time I said X", "how many times", "all sessions where…", or any exact-pattern search. Returns totalHits (uncapped count of matching messages), totalSessions, and up to `limit` hit snippets; each hit carries filePath + msgIndex to feed get_session_messages(offset) directly (add include_tools to see what the assistant did around it). truncated=true means more matched than were returned — raise limit or narrow with filters. Searches message prose (user turns + assistant text), not assistant tool-call inputs.',
  {
    pattern: z.string().min(1).describe('Literal substring by default; a JS regex when regex=true.'),
    regex: z.boolean().optional().default(false).describe('Treat pattern as a JS regular expression.'),
    ignoreCase: z.boolean().optional().default(true).describe('Case-insensitive match (default true).'),
    role: z.enum(['user', 'assistant']).optional().describe('Restrict to your turns (user) or the AI (assistant).'),
    tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to a specific tool.'),
    project: z.string().optional().describe('Filter to sessions from this project directory path.'),
    after: z.string().optional().describe('Only sessions on/after this date (YYYY-MM-DD).'),
    before: z.string().optional().describe('Only sessions on/before this date (YYYY-MM-DD).'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(50)
      .describe('Max hit snippets to return (default 50). totalHits still counts all.'),
  },
  async ({ pattern, regex, ignoreCase, role, tool, project, after, before, limit }) =>
    runGrepSessions({ pattern, regex, ignoreCase, role, tool, project, after, before, limit }),
);

// Exported, testable seam like runSearchSessions: the get_session_messages tool
// delegates here so the search-hit → offset alignment can be integration-tested
// without MCP plumbing. Pagination runs over getSessionMessages, whose numbering
// is identical to the msg_index search hits carry (both derive from parseSession).
export async function runGetSessionMessages(args: {
  filePath: string;
  offset?: number;
  limit?: number;
  includeTools?: boolean;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  const includeTools = args.includeTools ?? false;

  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return { content: [{ type: 'text' as const, text: `Could not read session: ${args.filePath}` }], isError: true };
  }
  const allMessages = getSessionMessages(lines, toolForSession(args.filePath, lines));
  const page = allMessages.slice(offset, offset + limit);

  const result = {
    total: allMessages.length,
    offset,
    returned: page.length,
    messages: page.map((m) =>
      includeTools
        ? {
            role: m.role,
            at: m.timestamp,
            text: m.text,
            // Rendered as `Name(summary)` one-liners; a turn's tool calls fold in here
            // (pure-tool-use turns have no index of their own).
            tools: m.tools.map((t) => (t.summary ? `${t.name}(${t.summary})` : t.name)),
          }
        : { role: m.role, at: m.timestamp, text: m.text },
    ),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

server.tool(
  'get_session_messages',
  'Retrieve messages from a specific session. Returns user and assistant messages in order, paginated. Pass a messageHits[].index from search_sessions (or a grep_sessions hit\'s msgIndex) as the offset to start at the matched message. Set include_tools=true to also see the tool calls the assistant made in each turn (Edit, Bash, Read, …) rendered as one-liners — use it to answer "what did the AI actually do here", which the prose alone often omits.',
  {
    filePath: z.string().describe('The session filePath from search_sessions results'),
    offset: z
      .number()
      .optional()
      .default(0)
      .describe('Message index to start from (default 0). messageHits[].index values from search_sessions align 1:1.'),
    limit: z.number().optional().default(20).describe('Max messages to return (default 20)'),
    include_tools: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include each turn's assistant tool calls as `Name(summary)` one-liners (default false)."),
  },
  async ({ filePath, offset, limit, include_tools }) =>
    runGetSessionMessages({ filePath, offset, limit, includeTools: include_tools }),
);

// Exported, testable seam like runGetSessionMessages: the get_session_digest tool
// delegates here so the digest shape and budget can be tested without MCP plumbing.
export async function runGetSessionDigest(args: {
  filePath: string;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return { content: [{ type: 'text' as const, text: `Could not read session: ${args.filePath}` }], isError: true };
  }

  const digest = buildSessionDigest(lines, toolForSession(args.filePath, lines));
  return { content: [{ type: 'text' as const, text: JSON.stringify(digest) }] };
}

server.tool(
  'get_session_digest',
  'The arc of one session in a single bounded call (~2k tokens): every genuine user turn paired with the final assistant reply of its exchange. Prefer this over paging get_session_messages when you need the whole story — opening intent, key decisions, closing state. Long sessions elide middle exchanges (elided > 0) but always keep the first and last. To expand any exchange, pass its exchanges[].index as the offset to get_session_messages. Empty exchanges means no genuine human turns — fall back to get_session_messages.',
  {
    filePath: z.string().describe('The session filePath from search_sessions results'),
  },
  async ({ filePath }) => runGetSessionDigest({ filePath }),
);

server.tool(
  'get_activity_digest',
  'Get a digest of AI coding sessions within a date range, grouped by day and project. Use for time-scoped questions — "what did I do yesterday/last week", standups, weekly recaps — where search_sessions (topic-scoped) is the wrong shape. Use "highlights" for summaries — it includes first+last user messages for substantive sessions. Use "compact" for just topics, or "full" for all user messages.',
  {
    startDate: z.string().describe('Start date inclusive (YYYY-MM-DD). Example: "2026-05-07"'),
    endDate: z.string().describe('End date inclusive (YYYY-MM-DD). Example: "2026-05-14"'),
    tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
    detail: z
      .enum(['compact', 'highlights', 'full'])
      .optional()
      .default('compact')
      .describe(
        'compact: topics + file paths only. highlights: first+last user messages for sessions with >3 messages (best for summaries). full: all user messages (large output).',
      ),
  },
  async ({ startDate, endDate, tool, project, detail }) => {
    const digest = await getActivityDigest(startDate, endDate, tool ?? '', project ?? '', detail);

    if (digest.totalSessions === 0) {
      return { content: [{ type: 'text' as const, text: 'No sessions found in that date range.' }] };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(digest) }],
    };
  },
);

server.tool(
  'get_session_metrics',
  'Get usage metrics for AI coding sessions within a date range. Returns tool breakdown, project breakdown, daily activity counts, and an activeHours heatmap of message counts by hour ("00".."23", already in the local timezone — do not shift them). Days and hours bucket by $TIMEZONE (default America/Chicago), the same as `sessions report`.',
  {
    startDate: z.string().describe('Start date inclusive (YYYY-MM-DD). Example: "2026-05-07"'),
    endDate: z.string().describe('End date inclusive (YYYY-MM-DD). Example: "2026-05-14"'),
    tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
  },
  async ({ startDate, endDate, tool, project }) => {
    const metrics = await getSessionMetrics(startDate, endDate, tool ?? '', project ?? '');

    if (metrics.totalSessions === 0) {
      return { content: [{ type: 'text' as const, text: 'No sessions found in that date range.' }] };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(metrics) }],
    };
  },
);

server.tool(
  'get_context_primer',
  'Get a repo-scoped context primer for re-injecting prior work into a new session: saved lessons for this repo, then recent sessions in detail, then older headlines. Use when starting substantive work in a repo that likely has session history — especially resuming after a break or when the user asks "where did we leave off" / "catch me up". `lessons` are assertions someone chose to keep, not transcript history: treat them as standing guidance, and note that a lesson with verified=false cannot be traced back to the conversation that produced it. lessonsFlagged counts lessons withheld because they conflict — mention it rather than guessing which is right. lessonsProposed counts machine-mined proposals from `sessions distill` that no human has accepted yet: they are never served and are NOT lessons, so report the count and do not treat them as guidance. A non-empty lessonsQuarantined means the lesson store was corrupt and was moved aside: say so and name the file, since an empty lesson list otherwise reads as "nothing was ever saved". Synthesize the JSON into prose.',
  {
    cwd: z.string().optional().describe('Repo path to scope to. Defaults to the server process cwd.'),
    limit: z.number().optional().describe('Recent-tier size (default 10).'),
    days: z.number().optional().describe('Only include sessions from the last N days.'),
    tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to one tool.'),
    worktree: z
      .boolean()
      .optional()
      .describe('Restrict to the current worktree only (default: aggregate all worktrees).'),
  },
  async ({ cwd, limit, days, tool, worktree }) => {
    const repo = resolveRepo(cwd ?? process.cwd());
    if (!repo) return { content: [{ type: 'text' as const, text: 'Not inside a git repository.' }] };
    const primer = await getContextPrimer(repo, { limit, days, tool: tool ?? '', worktreeOnly: worktree });
    if (primer.isEmpty) return { content: [{ type: 'text' as const, text: 'No past sessions found for this repo.' }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(primer) }] };
  },
);

// Exported, testable seam like the others: the remember_lesson tool delegates here so
// provenance resolution and the store's outcomes can be tested without MCP plumbing.
// `meta` is the raw request `_meta` — the only place a client's session identity ever
// comes from, and the reason the tool takes no session argument.
export function runRememberLesson(
  args: {
    lesson: string;
    detail?: string;
    scope?: Scope;
    files?: string[];
    supersedes?: number;
    cwd?: string;
  },
  meta?: Record<string, unknown>,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const repo = resolveRepo(args.cwd ?? process.cwd());
  const result = rememberLesson({
    lesson: args.lesson,
    detail: args.detail,
    scope: args.scope,
    files: args.files,
    supersedes: args.supersedes,
    container: repo?.container ?? '',
    remote: repo?.remote ?? '',
    source: resolveProvenance(meta),
  });

  const payload = {
    outcome: result.outcome,
    id: result.id,
    status: result.status,
    provenance: result.provenance,
    sourceVerified: result.verified,
    conflicts: result.conflicts,
    message: result.message,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(result.outcome === 'rejected' ? { isError: true } : {}),
  };
}

server.tool(
  'remember_lesson',
  'Save one durable lesson from this session so the next one does not re-derive it. Call it when something was learned the hard way: a root cause that took real work to find, a convention or preference the user corrected you on, an approach that looked right and was not. Do NOT call it for what the code or git history already says, for task state, or to recap what you just did — those are not lessons and they are what turns this into a junk drawer. Write `lesson` as one transferable sentence useful to someone who was not here, and put the file, root cause, and fix in `detail`; over-length input is rejected rather than truncated, so compress instead of trimming. Do not try to pass a session id — the server resolves provenance from the client itself, and anything you supplied would be a guess. Re-saving the same lesson is free and inserts nothing. If it overlaps an existing lesson, BOTH are flagged and neither is served until a human resolves it — when that comes back, raise the conflict with the user rather than rewording and saving again: a rewording joins the same review group instead of going live, and a rewording of a retired lesson is withheld too.',
  {
    lesson: z.string().min(1).describe(`The transferable principle, one sentence, max ${LESSON_MAX_CHARS} chars.`),
    detail: z.string().optional().describe(`The specifics: file, root cause, fix. Max ${DETAIL_MAX_CHARS} chars.`),
    scope: z
      .enum(['repo', 'global'])
      .optional()
      .default('repo')
      .describe('"repo" (default) for this codebase; "global" only for something true across every project.'),
    files: z.array(z.string()).optional().describe('Paths the lesson is about, if any.'),
    supersedes: z
      .number()
      .int()
      .optional()
      .describe(
        'Id of a lesson this corrects. The old one is marked superseded, never edited or deleted — and only when the two texts actually overlap; an id that names something unrelated sends this to human review rather than retiring it.',
      ),
    cwd: z.string().optional().describe('Repo path to scope to. Defaults to the server process cwd.'),
  },
  async ({ lesson, detail, scope, files, supersedes, cwd }, extra) =>
    runRememberLesson(
      { lesson, detail, scope, files, supersedes, cwd },
      extra?._meta as Record<string, unknown> | undefined,
    ),
);

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The SDK transport only listens for stdin 'data'/'error', so when the parent
  // client dies the server is never told. Under Bun's compiled binary the EOF'd
  // pipe then busy-loops the event loop at 100% CPU. Exit as soon as stdin ends.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}
