import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSessions, getActivityDigest, getSessionMetrics, getContextPrimer } from './cache';
import { formatResult } from './search-format';
import { getSessionMessages } from './parser';
import { buildSessionDigest } from './digest';
import { resolveRepo } from './repo';
import { readSessionLines } from './session-io';
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
      'Prefer bounded calls: get_session_digest over paging full transcripts.',
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
  return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
}

server.tool(
  'search_sessions',
  'Search across all past AI coding sessions from Claude Code, Codex, Pi, and OpenCode. Use proactively when the user references prior work ("didn\'t we already", "last time", "that thing we tried"), when a why-question isn\'t answered by code or git history, or before re-solving a problem that may have been solved in an earlier session. Returns matching sessions with snippets, the files/commands involved, an errored flag, and a ready-to-run resume command. Each result includes messageHits — the specific matching messages (index, role, snippet); pass a hit\'s index as the offset to get_session_messages to jump straight to the matched exchange. To answer "which sessions touched this file?", pass files (with no query) — results come back newest-first.',
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

// Exported, testable seam like runSearchSessions: the get_session_messages tool
// delegates here so the search-hit → offset alignment can be integration-tested
// without MCP plumbing. Pagination runs over getSessionMessages, whose numbering
// is identical to the msg_index search hits carry (both derive from extractMessages).
export async function runGetSessionMessages(args: {
  filePath: string;
  offset?: number;
  limit?: number;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;

  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return { content: [{ type: 'text' as const, text: `Could not read session: ${args.filePath}` }], isError: true };
  }
  const allMessages = getSessionMessages(lines);
  const page = allMessages.slice(offset, offset + limit);

  const result = {
    total: allMessages.length,
    offset,
    returned: page.length,
    messages: page.map((m) => ({ role: m.role, text: m.text })),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

server.tool(
  'get_session_messages',
  'Retrieve messages from a specific session. Returns user and assistant messages in order, paginated. Pass a messageHits[].index from search_sessions as the offset to start at the matched message.',
  {
    filePath: z.string().describe('The session filePath from search_sessions results'),
    offset: z
      .number()
      .optional()
      .default(0)
      .describe('Message index to start from (default 0). messageHits[].index values from search_sessions align 1:1.'),
    limit: z.number().optional().default(20).describe('Max messages to return (default 20)'),
  },
  async ({ filePath, offset, limit }) => runGetSessionMessages({ filePath, offset, limit }),
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

  const digest = buildSessionDigest(lines);
  return { content: [{ type: 'text' as const, text: JSON.stringify(digest, null, 2) }] };
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
      content: [{ type: 'text' as const, text: JSON.stringify(digest, null, 2) }],
    };
  },
);

server.tool(
  'get_session_metrics',
  'Get usage metrics for AI coding sessions within a date range. Returns tool breakdown, project breakdown, daily activity counts, and active hours heatmap.',
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
      content: [{ type: 'text' as const, text: JSON.stringify(metrics, null, 2) }],
    };
  },
);

server.tool(
  'get_context_primer',
  'Get a repo-scoped context primer (recent sessions in detail + older headlines) for re-injecting prior work into a new session. Use when starting substantive work in a repo that likely has session history — especially resuming after a break or when the user asks "where did we leave off" / "catch me up". Synthesize the JSON into prose.',
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
    return { content: [{ type: 'text' as const, text: JSON.stringify(primer, null, 2) }] };
  },
);

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
