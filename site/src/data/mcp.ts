/**
 * Editorial judgement about the MCP surface: how the ten tools group, what
 * order they read in, and one plain line each.
 *
 * The names and titles are NOT here — those are read from src/mcp.ts at build
 * time. This file only says what a person should understand, and `mcpGroups()`
 * joins the two so that:
 *
 *   - a tool that ships with no entry here fails the build
 *   - an entry naming a tool that no longer ships fails the build
 *
 * That is the whole point. A hand-maintained list of tool names would be right
 * today and wrong in two releases, and there would be nothing to catch it.
 */
import { readMcpTools, type McpTool } from '../lib/mcp-tools';

interface Entry {
  name: string;
  /** One line, for a person skimming — not the model-facing description. */
  blurb: string;
}

interface Group {
  label: string;
  /** What this group of tools is for, in the recall flow. */
  lede: string;
  entries: Entry[];
}

const GROUPS: Group[] = [
  {
    label: 'Find it',
    lede: 'Two ways in, and the difference matters: one ranks, one is exhaustive.',
    entries: [
      {
        name: 'search_sessions',
        blurb:
          'Ranked search across every session, message-granular. Returns the matching messages, not just the sessions — and a ready-to-run resume command. Top-k, so it is fast and not exhaustive. Pi sessions carry their /tree branch count and /fork parentage, so abandoned lines show before you open one.',
      },
      {
        name: 'grep_sessions',
        blurb:
          'Every message matching a literal string or regex, with a true total. This is the one for "how many times did I say that" — ranked search would quietly miss some.',
      },
    ],
  },
  {
    label: 'Read it',
    lede: 'Expand only the part that matters. Neither of these pages a full transcript.',
    entries: [
      {
        name: 'get_session_digest',
        blurb:
          'One session\'s whole arc in a single bounded call, around 2k tokens: every real turn you took, paired with the reply that closed it. Long sessions elide the middle, never the ends.',
      },
      {
        name: 'get_session_messages',
        blurb:
          'The exact exchange a search matched — pass the hit index straight through as the offset. Ask for tool calls too and you see what the agent actually did, which the prose usually leaves out. Pi branch and fork markers ride along, so an abandoned line is visible in the reading.',
      },
    ],
  },
  {
    label: 'Know where you are',
    lede: 'The two calls worth making before writing any code in a repo you have been away from.',
    entries: [
      {
        name: 'get_context_primer',
        blurb:
          'Where you left off here: recent sessions in detail, older ones as headlines, the branch you were on, and the last thing each one said.',
      },
      {
        name: 'get_memory',
        blurb:
          'The standing instructions you have already given — build conventions, tooling constraints, rules you should not have to restate. Scoped to this repo, its project group, and your cross-repo workflow rules.',
      },
    ],
  },
  {
    label: 'Know what your agents know',
    lede: 'Memory lives in every harness, not just this one. These two read the others — never write.',
    entries: [
      {
        name: 'get_memory_sources',
        blurb:
          'Every memory store your coding agents keep, inventoried — pi-hermes, Claude Code, Codex — with entry counts and when each was last touched. The "what does each agent know about me?" answer.',
      },
      {
        name: 'review_agent_memories',
        blurb:
          "The contents of those stores, with provenance and a flag where they overlap what sessions already holds. For auditing what another harness learned, spotting conflicts between agents, or previewing what `memory import --from` would bring in.",
      },
    ],
  },
  {
    label: 'Account for it',
    lede: 'Time-scoped rather than topic-scoped, for recaps and for knowing where the money went.',
    entries: [
      {
        name: 'get_activity_digest',
        blurb: 'A date range grouped by day and project. This is what a weekly summary or a standup is built from.',
      },
      {
        name: 'get_session_metrics',
        blurb: 'Tool and project breakdown, daily activity, and the hours you are actually working.',
      },
    ],
  },
];

export interface JoinedTool extends McpTool, Entry {}
export interface JoinedGroup {
  label: string;
  lede: string;
  tools: JoinedTool[];
}

/** Join the authored copy onto the shipped tool list, failing loudly on drift. */
export function mcpGroups(): { groups: JoinedGroup[]; total: number } {
  const shipped = readMcpTools();
  const byName = new Map(shipped.map((tool) => [tool.name, tool]));
  const claimed = new Set<string>();

  const groups = GROUPS.map((group) => ({
    label: group.label,
    lede: group.lede,
    tools: group.entries.map((entry) => {
      const tool = byName.get(entry.name);
      if (!tool) {
        throw new Error(
          `site/src/data/mcp.ts describes an MCP tool "${entry.name}" that src/mcp.ts no longer registers. ` +
            `Shipped tools: ${shipped.map((t) => t.name).join(', ')}`,
        );
      }
      claimed.add(entry.name);
      return { ...tool, ...entry };
    }),
  }));

  const undocumented = shipped.filter((tool) => !claimed.has(tool.name));
  if (undocumented.length > 0) {
    throw new Error(
      `src/mcp.ts registers ${undocumented.map((t) => t.name).join(', ')}, which the site does not describe. ` +
        'Add an entry to site/src/data/mcp.ts — the page states a tool count in prose, so a silent omission would make it wrong.',
    );
  }

  return { groups, total: shipped.length };
}
