import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSessions, getActivityDigest, getSessionMetrics } from './cache';
import { getSessionMessages } from './parser';
import { type SessionResult } from './types';

const server = new McpServer({
  name: 'sessions',
  version: '1.2.0',
});

server.tool(
  'search_sessions',
  'Search across AI coding sessions from Claude Code, Codex, and Pi. Returns matching sessions with snippets.',
  {
    query: z.string().optional().describe('Text to search for in user messages. Omit to list recent sessions.'),
    tool: z.enum(['claude', 'codex', 'pi']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
    limit: z.number().optional().default(20).describe('Max results to return (default 20)'),
  },
  async ({ query, tool, project, limit }) => {
    const results = await searchSessions(query ?? '', tool ?? '', project ?? '', limit);

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No sessions found.' }] };
    }

    const formatted = results.map((r: SessionResult) => ({
      sessionId: r.sessionId,
      tool: r.tool,
      date: r.date,
      createdAt: r.createdAt,
      project: r.cwd,
      title: r.customTitle || null,
      snippet: r.displayText,
      messageCount: r.messageCount,
      exists: r.exists,
      filePath: r.filePath,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
    };
  },
);

server.tool(
  'get_session_messages',
  'Retrieve messages from a specific session. Returns user and assistant messages in order, paginated.',
  {
    filePath: z.string().describe('Path to the session JSONL file (from search_sessions results)'),
    offset: z.number().optional().default(0).describe('Message index to start from (default 0)'),
    limit: z.number().optional().default(20).describe('Max messages to return (default 20)'),
  },
  async ({ filePath, offset, limit }) => {
    let raw: string;
    try {
      raw = await Bun.file(filePath).text();
    } catch {
      return { content: [{ type: 'text' as const, text: `Could not read file: ${filePath}` }], isError: true };
    }

    const lines = raw.trimEnd().split('\n');
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
  },
);

server.tool(
  'get_activity_digest',
  'Get a compact digest of AI coding sessions within a date range, grouped by day and project. Returns topics and file paths — use get_session_messages to drill into specific sessions for full detail.',
  {
    startDate: z.string().describe('Start date inclusive (YYYY-MM-DD). Example: "2026-05-07"'),
    endDate: z.string().describe('End date inclusive (YYYY-MM-DD). Example: "2026-05-14"'),
    tool: z.enum(['claude', 'codex', 'pi']).optional().describe('Filter to a specific tool'),
    project: z.string().optional().describe('Filter to sessions from this project directory path'),
  },
  async ({ startDate, endDate, tool, project }) => {
    const digest = await getActivityDigest(startDate, endDate, tool ?? '', project ?? '');

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
    tool: z.enum(['claude', 'codex', 'pi']).optional().describe('Filter to a specific tool'),
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

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
