import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSessions, grepSessions, getActivityDigest, getSessionMetrics, getContextPrimer } from './cache';
import { formatResult, buildResumeCommand } from './search-format';
import { getSessionMessages } from './parser';
import { buildSessionDigest } from './digest';
import { resolveRepo } from './repo';
import { readSessionLines } from './session-io';
import { activeMemoryFor } from './memory/retrieve';
import { type ContextPrimer, type Tool } from './types';
import { version } from '../package.json';
import {
  GetActivityDigestOutput,
  GetContextPrimerOutput,
  GetMemoryOutput,
  GetSessionDigestOutput,
  GetSessionMessagesOutput,
  GetSessionMetricsOutput,
  GrepSessionsOutput,
  SearchSessionsOutput,
} from './mcp-schemas';

const INSTRUCTIONS =
  'Searchable history of every past AI coding session (Claude Code, Codex, Pi, OpenCode) on this machine — the conversations behind the commits. Decisions, rationale, abandoned approaches, and unfinished threads live here, not in git. ' +
  'Use proactively, without being asked, when: the user references prior work ("last time", "didn\'t we already", "that approach we tried", "why did we do it this way"); work resumes on a repo after a gap (call get_context_primer before starting); a why-question isn\'t answered by the code or git history; or a bug/task smells like something solved before (search_sessions first, re-derive second). ' +
  'Two ways to find things: search_sessions ranks the most relevant sessions for a topic (top-k, not exhaustive); grep_sessions finds every message matching a literal string or regex (exhaustive — use it for "every time", counts, or exact-pattern needs). ' +
  'Prefer bounded calls: get_session_digest over paging full transcripts. ' +
  'Memory are the other half: short standing instructions and durable facts this user has already established (build conventions, tooling constraints, preferences). Call get_memory when starting work in a repo and treat what it returns as binding.';

/**
 * Correct for all 8 tools: every one reads the local index and mutates nothing.
 * get_memory included — it reads stored memory, it does not record it.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * What every tool handler returns. `structuredContent` is not optional in practice: each
 * tool declares an `outputSchema`, and the SDK rejects any non-`isError` result that
 * omits it — including the empty-result sentinels, which is why every sentinel below
 * carries a payload. Only the `isError` paths may leave it out.
 */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * A populated result: the compact JSON text block plus the same object as
 * `structuredContent`, which is what `outputSchema` validates.
 *
 * Both ship. Claude Code's normalizer drops `type:'text'` blocks whenever
 * `structuredContent` is present, so the duplicate costs local pipe bytes and zero
 * model-context tokens — while still rendering on a client that ignores structured output.
 */
function toolResult(payload: object): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    // The SDK types structuredContent as a string-keyed record. These payloads are plain
    // JSON-serializable objects, but TypeScript gives `interface` types no implicit index
    // signature, so the widening must be explicit. The real check is the outputSchema.
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * A successful empty result: keep the human sentence — it tells a model something the
 * payload does not — and attach a conforming empty payload so output validation passes.
 * Never solve an empty result with `isError`; that bypasses validation rather than
 * satisfying it, and these calls did succeed.
 */
function sentinel(text: string, payload: object): ToolResult {
  // Built directly rather than spreading toolResult(): that would JSON.stringify the
  // payload only for the sentence below to throw the string away.
  return { content: [{ type: 'text' as const, text }], structuredContent: payload as Record<string, unknown> };
}

/** An unrecoverable call. `isError` results are exempt from output validation. */
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// Exported, testable seam: the search_sessions tool delegates to this so its behavior
// (errored filter, per-result metadata, resumeCommand) can be unit-tested without MCP.
export async function runSearchSessions(args: {
  query?: string;
  tool?: Tool;
  project?: string;
  errored?: boolean;
  files?: string[];
  limit?: number;
}): Promise<ToolResult> {
  const results = await searchSessions(args.query ?? '', {
    tool: args.tool ?? '',
    project: args.project ?? '',
    errored: args.errored,
    files: args.files,
    limit: args.limit ?? 20,
  });

  const formatted = results.map(formatResult);
  // An object envelope, not the bare array: structuredContent must be a JSON object.
  const payload = { results: formatted, count: formatted.length };
  if (formatted.length === 0) return sentinel('No sessions found.', payload);
  return toolResult(payload);
}

// Exported, testable seam: the get_memory tool delegates here so scope filtering,
// topic narrowing, the projection shape, and the empty-store sentence can be
// unit-tested without MCP.
export async function runGetMemory(args: { cwd?: string; topic?: string }): Promise<ToolResult> {
  const memory = activeMemoryFor(args.cwd ?? process.cwd(), args.topic);
  // A projection, not the record: ids, evidence arrays, and session paths are triage
  // concerns and would spend the agent's context on nothing it can act on. Deliberately
  // no `score` and no `alwaysOn` either — a relevance number invites the agent to
  // second-guess the filter, and "this is a standing constraint" is already carried by
  // the ordering, which puts always-on memory first.
  const formatted = memory.map((s) => ({ text: s.text, kind: s.kind, scope: s.scope.type }));
  const payload = { results: formatted, count: formatted.length };
  if (memory.length === 0) {
    // Two sentences, because they mean different things: with a topic, "nothing came
    // back" is a matcher outcome the agent can act on by asking again, not a statement
    // that this repo has no memory.
    const empty = args.topic?.trim()
      ? 'No memory matched this topic for this repo. Call again without `topic` to see everything stored.'
      : 'No memories for this repo.';
    return sentinel(empty, payload);
  }
  return toolResult(payload);
}

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
}): Promise<ToolResult> {
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
    return toolError(e instanceof Error ? e.message : String(e));
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

  if (result.totalHits === 0) return sentinel('No matching messages found.', payload);
  return toolResult(payload);
}

// Exported, testable seam like runSearchSessions: the get_session_messages tool
// delegates here so the search-hit → offset alignment can be integration-tested
// without MCP plumbing. Pagination runs over getSessionMessages, whose numbering
// is identical to the msg_index search hits carry (both derive from extractMessages).
export async function runGetSessionMessages(args: {
  filePath: string;
  offset?: number;
  limit?: number;
  includeTools?: boolean;
}): Promise<ToolResult> {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  const includeTools = args.includeTools ?? false;

  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return toolError(`Could not read session: ${args.filePath}`);
  }
  const allMessages = getSessionMessages(lines);
  const page = allMessages.slice(offset, offset + limit);

  const result = {
    total: allMessages.length,
    offset,
    returned: page.length,
    messages: page.map((m) =>
      includeTools
        ? {
            role: m.role,
            text: m.text,
            // Rendered as `Name(summary)` one-liners; a turn's tool calls fold in here
            // (pure-tool-use turns have no index of their own).
            tools: m.tools.map((t) => (t.summary ? `${t.name}(${t.summary})` : t.name)),
          }
        : { role: m.role, text: m.text },
    ),
  };

  return toolResult(result);
}

// Exported, testable seam like runGetSessionMessages: the get_session_digest tool
// delegates here so the digest shape and budget can be tested without MCP plumbing.
export async function runGetSessionDigest(args: { filePath: string }): Promise<ToolResult> {
  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return toolError(`Could not read session: ${args.filePath}`);
  }

  return toolResult(buildSessionDigest(lines));
}

/**
 * All 8 tool registrations. Extracted alongside createServer() so a test can drive
 * `tools/list` and `tools/call` over an in-memory transport — the only path that runs
 * the SDK's output validation. The exported `run*` seams stay the handlers' bodies, but
 * they bypass that validation, which is exactly why they cannot cover this surface.
 */
function registerTools(server: McpServer): void {
  server.registerTool(
    'get_memory',
    {
      title: 'Standing instructions for this repo',
      description:
        "Durable facts and standing instructions this user has established across past coding sessions — build conventions, architectural rules, tooling constraints, and preferences they have stated before and should not have to restate. Call this at the start of any non-trivial task in a repo, before planning or writing code, the same way you would read a README. Returns a small set of short facts scoped to this repo, to any project group it belongs to, plus the user's cross-repo workflow rules. Passing `topic` narrows the result to facts relevant to what you are about to do; the user's standing constraints are returned regardless of the topic, and always come first. These are the user's own standing instructions: treat them as binding, and follow them over your defaults. Cheap and bounded — a handful of sentences, never a transcript.",
      inputSchema: {
        cwd: z.string().optional().describe('Repo path to scope to. Defaults to the server process cwd.'),
        topic: z
          .string()
          .optional()
          .describe(
            'What you are about to work on, in a few words — e.g. "add keychain support to the CLI". ' +
              'Narrows the returned facts to those relevant to this task. Omit to get everything for this repo.',
          ),
      },
      outputSchema: GetMemoryOutput,
      annotations: READ_ONLY,
    },
    async ({ cwd, topic }) => runGetMemory({ cwd, topic }),
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Search past AI coding sessions',
      description:
        'Search across all past AI coding sessions from Claude Code, Codex, Pi, and OpenCode. Use proactively when the user references prior work ("didn\'t we already", "last time", "that thing we tried"), when a why-question isn\'t answered by code or git history, or before re-solving a problem that may have been solved in an earlier session. Results are ranked by relevance and capped (top-k) — NOT exhaustive; for every-occurrence, counts, or an exact string/regex, use grep_sessions instead. Returns matching sessions with snippets, the files/commands involved, an errored flag, and a ready-to-run resume command. Each result includes messageHits — the specific matching messages (index, role, snippet); pass a hit\'s index as the offset to get_session_messages to jump straight to the matched exchange. To answer "which sessions touched this file?", pass files (with no query) — results come back newest-first.',
      inputSchema: {
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
      outputSchema: SearchSessionsOutput,
      annotations: READ_ONLY,
    },
    async ({ query, tool, project, errored, files, limit }) =>
      runSearchSessions({ query, tool, project, errored, files, limit }),
  );

  server.registerTool(
    'grep_sessions',
    {
      title: 'Grep every past session message',
      description:
        'Exhaustively find EVERY message across all past sessions matching a literal string or regex — use this (not search_sessions) whenever completeness or a count matters: "every time I said X", "how many times", "all sessions where…", or any exact-pattern search. Returns totalHits (uncapped count of matching messages), totalSessions, and up to `limit` hit snippets; each hit carries filePath + msgIndex to feed get_session_messages(offset) directly (add include_tools to see what the assistant did around it). truncated=true means more matched than were returned — raise limit or narrow with filters. Searches message prose (user turns + assistant text), not assistant tool-call inputs.',
      inputSchema: {
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
      outputSchema: GrepSessionsOutput,
      annotations: READ_ONLY,
    },
    async ({ pattern, regex, ignoreCase, role, tool, project, after, before, limit }) =>
      runGrepSessions({ pattern, regex, ignoreCase, role, tool, project, after, before, limit }),
  );

  server.registerTool(
    'get_session_messages',
    {
      title: 'Read messages from one session',
      description:
        'Retrieve messages from a specific session. Returns user and assistant messages in order, paginated. Pass a messageHits[].index from search_sessions (or a grep_sessions hit\'s msgIndex) as the offset to start at the matched message. Set include_tools=true to also see the tool calls the assistant made in each turn (Edit, Bash, Read, …) rendered as one-liners — use it to answer "what did the AI actually do here", which the prose alone often omits.',
      inputSchema: {
        filePath: z.string().describe('The session filePath from search_sessions results'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe(
            'Message index to start from (default 0). messageHits[].index values from search_sessions align 1:1.',
          ),
        limit: z.number().optional().default(20).describe('Max messages to return (default 20)'),
        include_tools: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include each turn's assistant tool calls as `Name(summary)` one-liners (default false)."),
      },
      outputSchema: GetSessionMessagesOutput,
      annotations: READ_ONLY,
    },
    async ({ filePath, offset, limit, include_tools }) =>
      runGetSessionMessages({ filePath, offset, limit, includeTools: include_tools }),
  );

  server.registerTool(
    'get_session_digest',
    {
      title: 'Digest one session end to end',
      description:
        'The arc of one session in a single bounded call (~2k tokens): every genuine user turn paired with the final assistant reply of its exchange. Prefer this over paging get_session_messages when you need the whole story — opening intent, key decisions, closing state. Long sessions elide middle exchanges (elided > 0) but always keep the first and last. To expand any exchange, pass its exchanges[].index as the offset to get_session_messages. Empty exchanges means no genuine human turns — fall back to get_session_messages.',
      inputSchema: {
        filePath: z.string().describe('The session filePath from search_sessions results'),
      },
      outputSchema: GetSessionDigestOutput,
      annotations: READ_ONLY,
    },
    async ({ filePath }) => runGetSessionDigest({ filePath }),
  );

  server.registerTool(
    'get_activity_digest',
    {
      title: 'Digest activity over a date range',
      description:
        'Get a digest of AI coding sessions within a date range, grouped by day and project. Use for time-scoped questions — "what did I do yesterday/last week", standups, weekly recaps — where search_sessions (topic-scoped) is the wrong shape. Use "highlights" for summaries — it includes first+last user messages for substantive sessions. Use "compact" for just topics, or "full" for all user messages.',
      inputSchema: {
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
      outputSchema: GetActivityDigestOutput,
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate, tool, project, detail }) => {
      const digest = await getActivityDigest(startDate, endDate, tool ?? '', project ?? '', detail);
      // An empty digest is already schema-conforming — zero counts and empty tiers.
      if (digest.totalSessions === 0) return sentinel('No sessions found in that date range.', digest);
      return toolResult(digest);
    },
  );

  server.registerTool(
    'get_session_metrics',
    {
      title: 'Usage metrics over a date range',
      description:
        'Get usage metrics for AI coding sessions within a date range. Returns tool breakdown, project breakdown, daily activity counts, and active hours heatmap.',
      inputSchema: {
        startDate: z.string().describe('Start date inclusive (YYYY-MM-DD). Example: "2026-05-07"'),
        endDate: z.string().describe('End date inclusive (YYYY-MM-DD). Example: "2026-05-14"'),
        tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to a specific tool'),
        project: z.string().optional().describe('Filter to sessions from this project directory path'),
      },
      outputSchema: GetSessionMetricsOutput,
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate, tool, project }) => {
      const metrics = await getSessionMetrics(startDate, endDate, tool ?? '', project ?? '');
      if (metrics.totalSessions === 0) return sentinel('No sessions found in that date range.', metrics);
      return toolResult(metrics);
    },
  );

  server.registerTool(
    'get_context_primer',
    {
      title: 'Prime context for this repo',
      description:
        'Get a repo-scoped context primer (recent sessions in detail + older headlines) for re-injecting prior work into a new session. Use when starting substantive work in a repo that likely has session history — especially resuming after a break or when the user asks "where did we leave off" / "catch me up". Synthesize the JSON into prose.',
      inputSchema: {
        cwd: z.string().optional().describe('Repo path to scope to. Defaults to the server process cwd.'),
        limit: z.number().optional().describe('Recent-tier size (default 10).'),
        days: z.number().optional().describe('Only include sessions from the last N days.'),
        tool: z.enum(['claude', 'codex', 'pi', 'opencode']).optional().describe('Filter to one tool.'),
        worktree: z
          .boolean()
          .optional()
          .describe('Restrict to the current worktree only (default: aggregate all worktrees).'),
      },
      outputSchema: GetContextPrimerOutput,
      annotations: READ_ONLY,
    },
    async ({ cwd, limit, days, tool, worktree }) => {
      const repo = resolveRepo(cwd ?? process.cwd());
      if (!repo) {
        // No repo means no primer to report, so the payload is synthesized rather than
        // read. Typed as ContextPrimer so a shape change in types.ts breaks the build here.
        const none: ContextPrimer = { repoLabel: '', toolFilter: tool ?? '', recent: [], headlines: [], isEmpty: true };
        return sentinel('Not inside a git repository.', none);
      }
      const primer = await getContextPrimer(repo, { limit, days, tool: tool ?? '', worktreeOnly: worktree });
      if (primer.isEmpty) return sentinel('No past sessions found for this repo.', primer);
      return toolResult(primer);
    },
  );
}

/**
 * A factory, not an exported singleton: each caller (every test included) gets a fresh
 * server, because a shared instance would be connect()-ed more than once.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'sessions', version }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

export async function startMcpServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The SDK transport only listens for stdin 'data'/'error', so when the parent
  // client dies the server is never told. Under Bun's compiled binary the EOF'd
  // pipe then busy-loops the event loop at 100% CPU. Exit as soon as stdin ends.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}
