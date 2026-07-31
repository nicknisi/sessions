/**
 * The MCP tool surface, read out of src/mcp.ts at build time.
 *
 * The page says "eight tools" in prose and lists them by name. Both of those
 * are claims about code that changes, so neither is retyped here: the names and
 * the titles come from the `server.registerTool(...)` calls themselves, and the
 * join in src/data/mcp.ts throws when the authored list and the shipped list
 * stop agreeing.
 *
 * Only the name and the title are derived. The tool DESCRIPTIONS in mcp.ts are
 * written for a model deciding whether to call the tool — several hundred words
 * of "use this proactively when…" — which is the wrong register for a person
 * skimming a page. The one-line human summary is editorial and lives in
 * src/data/mcp.ts, next to the ordering.
 */
import { readRepoFile } from './repo';

export interface McpTool {
  /** The wire name, e.g. `search_sessions`. */
  name: string;
  /** The `title` field, written for a human already: "Search past AI coding sessions". */
  title: string;
}

/**
 * Matches:
 *   server.registerTool(
 *     'search_sessions',
 *     {
 *       title: 'Search past AI coding sessions',
 *
 * Deliberately strict about the shape rather than clever about parsing. A
 * refactor that moves the registrations somewhere else should break this
 * loudly at build time, not quietly render a short list.
 */
const REGISTRATION = /server\.registerTool\(\s*'([a-z_]+)',\s*\{\s*title:\s*'((?:[^'\\]|\\.)*)'/g;

export function readMcpTools(): McpTool[] {
  const source = readRepoFile('src', 'mcp.ts');
  const tools: McpTool[] = [];

  for (const match of source.matchAll(REGISTRATION)) {
    tools.push({ name: match[1]!, title: match[2]!.replace(/\\'/g, "'") });
  }

  if (tools.length === 0) {
    throw new Error(
      'found no server.registerTool() calls in src/mcp.ts. The MCP section of the ' +
        'site is generated from them, so this is a build failure rather than an empty list.',
    );
  }

  const names = new Set(tools.map((t) => t.name));
  if (names.size !== tools.length) {
    throw new Error('src/mcp.ts registers the same tool name twice');
  }

  return tools;
}
