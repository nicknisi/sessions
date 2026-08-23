import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError, type CallToolResult, type GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { basename } from 'node:path';
import {
  searchSessions,
  grepSessions,
  getActivityDigest,
  getSessionMetrics,
  getContextPrimer,
  recentSessionsForRepo,
  resolveSessionFile,
} from './cache';
import { formatResult, buildResumeCommand } from './search-format';
import { getSessionMessages, type PiForkMarker } from './parser';
import { asJsonObject, asJsonString, type JsonValue } from './extract-util';
import { buildSessionDigest, clip, renderDigestMarkdown } from './digest';
import { resolveRepo } from './repo';
import { readSessionLines } from './session-io';
import { activeMemoryFor, withheldMemoryFor } from './memory/retrieve';
import { fingerprint } from './memory/record';
import { collectAgentMemory, similarStoredIds, splitByScan, type SourceAgent } from './memory/sources';
import { runRecurrence } from './memory/report';
import { listMemories } from './memory/store';
import { matchTopic, TOPIC_THRESHOLD } from './memory/topic';
import { ALWAYS_ON_MAX_CHARS, ALWAYS_ON_MAX_ENTRIES } from './memory/triage';
import { PLUGIN_FILES } from './plugin-files';
import { type ContextPrimer, type Tool } from './types';
import { version } from '../package.json';
import {
  GetActivityDigestOutput,
  GetContextPrimerOutput,
  GetMemoryOutput,
  GetMemoryRecurrenceOutput,
  GetMemorySourcesOutput,
  GetSessionDigestOutput,
  GetSessionMessagesOutput,
  GetSessionMetricsOutput,
  GrepSessionsOutput,
  ReviewAgentMemoriesOutput,
  SearchSessionsOutput,
} from './mcp-schemas';

const INSTRUCTIONS =
  'Searchable history of every past AI coding session (Claude Code, Codex, Pi, OpenCode) on this machine — the conversations behind the commits. Decisions, rationale, abandoned approaches, and unfinished threads live here, not in git. ' +
  'Use proactively, without being asked, when: the user references prior work ("last time", "didn\'t we already", "that approach we tried", "why did we do it this way"); work resumes on a repo after a gap (call get_context_primer before starting); a why-question isn\'t answered by the code or git history; or a bug/task smells like something solved before (search_sessions first, re-derive second). ' +
  'Two ways to find things: search_sessions ranks the most relevant sessions for a topic (top-k, not exhaustive); grep_sessions finds every message matching a literal string or regex (exhaustive — use it for "every time", counts, or exact-pattern needs). ' +
  'Prefer bounded calls: get_session_digest over paging full transcripts. ' +
  'Memory are the other half: short standing instructions and durable facts this user has already established (build conventions, tooling constraints, preferences). Call get_memory when starting work in a repo and treat what it returns as binding. ' +
  'Two read-only windows into what OTHER agents remember: get_memory_sources inventories every agent memory store on this machine (pi-hermes, Claude Code, Codex), and review_agent_memories reads their contents with provenance — use them to audit what another harness knows, to spot redundancy against get_memory, or before porting conventions between agents. get_memory_recurrence reports what recurs against that store — approved memories still being violated, untriaged repeats, and fuzzy paraphrase pairs awaiting triage confirmation.';

/**
 * Correct for all 11 tools: every one reads the local index and mutates nothing.
 * get_memory included — it reads stored memory, it does not record it. The two
 * agent-source tools read other harnesses' stores but only ever open them readonly.
 * get_memory_recurrence MINES — real work, an index read per call — but writes
 * nothing: no candidate upsert, no watermark advance (src/memory/report.ts).
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * Hard ceilings on every caller-supplied page size. A DEFAULT is not a bound: an agent
 * that passes `limit: 100000` gets the whole index back, and `limit: -1` is worse than
 * unbounded — SQLite treats a negative LIMIT as "no limit at all", so the one number that
 * looks like it must return nothing returns everything. Either one reproduces the payload
 * blowup the projections in this file exist to prevent, and neither is a hypothetical: the
 * caller is a model reading a `describe()` string.
 *
 * The ceilings live at the tool boundary rather than in cache.ts because they are budgets
 * for a model's context, not facts about the query. `sessions search` passes 1,000 for an
 * interactive fzf list and is right to (src/cli.ts) — a human scrolling a terminal has no
 * context window to blow.
 */
export const MAX_SEARCH_RESULTS = 50;
export const MAX_GREP_HITS = 200;
export const MAX_MESSAGES_PER_PAGE = 100;
export const MAX_PRIMER_RECENT = 25;

/**
 * A bounded page-size input: integer, at least 1, at most `max`, defaulting to `def`.
 *
 * `.int()` is not pedantry either — `limit: 2.5` reaches SQLite as a float and the row
 * count becomes an implementation detail of value coercion.
 */
function pageSize(def: number, max: number, description: string) {
  return z.number().int().min(1).max(max).optional().default(def).describe(description);
}

/**
 * What every tool handler returns. `structuredContent` is not optional in practice: each
 * tool declares an `outputSchema`, and the SDK rejects any non-`isError` result that
 * omits it — including the empty-result sentinels, which is why every sentinel below
 * carries a payload. Only the `isError` paths may leave it out.
 */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  // The SDK owns this contract (a string-keyed record of unknown); payloads are
  // JSON objects built inline, and each tool's outputSchema does the real validation.
  structuredContent?: CallToolResult['structuredContent'];
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
function toolResult(payload: NonNullable<CallToolResult['structuredContent']>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * A successful empty result: keep the human sentence — it tells a model something the
 * payload does not — and attach a conforming empty payload so output validation passes.
 * Never solve an empty result with `isError`; that bypasses validation rather than
 * satisfying it, and these calls did succeed.
 */
function sentinel(text: string, payload: NonNullable<CallToolResult['structuredContent']>): ToolResult {
  // Built directly rather than spreading toolResult(): that would JSON.stringify the
  // payload only for the sentence below to throw the string away.
  return { content: [{ type: 'text' as const, text }], structuredContent: payload };
}

/** An unrecoverable call. `isError` results are exempt from output validation. */
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** One memory row in the review_agent_memories payload (schema-derived). */
type ReviewedMemoryPayload = z.infer<typeof ReviewAgentMemoriesOutput>['memories'][number];
/** One message row in the get_session_messages payload (schema-derived). */
type SessionMessagePayload = z.infer<typeof GetSessionMessagesOutput>['messages'][number];

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
  const cwd = args.cwd ?? process.cwd();
  const memory = activeMemoryFor(cwd, args.topic);
  // A projection, not the record: ids, evidence arrays, and session paths are triage
  // concerns and would spend the agent's context on nothing it can act on. Deliberately
  // no `score` and no `alwaysOn` either — a relevance number invites the agent to
  // second-guess the filter, and "this is a standing constraint" is already carried by
  // the ordering, which puts always-on memory first.
  const formatted = memory.map((s) => ({ text: s.text, kind: s.kind, scope: s.scope.type }));
  const payload: z.infer<typeof GetMemoryOutput> = { results: formatted, count: formatted.length };

  // Approved rows the scan gate refused to serve (src/memory/retrieve.ts). Ids and a
  // count, never the text — the text is the payload the withholding exists to stop.
  // Reported rather than silent because an approved row is a human decision, and the
  // only person who can resolve the conflict is the one this note asks the agent to tell.
  const withheld = withheldMemoryFor(cwd);
  if (withheld.length > 0) {
    payload.withheld = {
      count: withheld.length,
      ids: withheld.map((r) => r.id),
      note:
        'These approved memories were withheld: their text matches secret or prompt-injection ' +
        'patterns. Tell the user — each can be dismissed with `sessions memory reject <id>` or ' +
        'restored as a clean rephrasing with `sessions memory approve <id> --as "<text>"`.',
    };
  }

  // The always-on budget's serve-side backstop. `approve --always-on` refuses new
  // grants past the cap (src/memory/triage.ts), but a store written before the cap
  // existed — or hand-edited — can arrive over it. Everything is still SERVED:
  // truncating a standing constraint is exactly the silent suppression alwaysOn
  // exists to prevent. Over-budget is stated instead, so the set gets trimmed by a
  // decision rather than by a filter.
  const alwaysOn = memory.filter((m) => m.alwaysOn);
  const alwaysOnChars = alwaysOn.reduce((n, m) => n + m.text.length, 0);
  if (alwaysOn.length > ALWAYS_ON_MAX_ENTRIES || alwaysOnChars > ALWAYS_ON_MAX_CHARS) {
    payload.alwaysOnBudget =
      `The always-on set is over its budget (${alwaysOn.length}/${ALWAYS_ON_MAX_ENTRIES} entries, ` +
      `${alwaysOnChars}/${ALWAYS_ON_MAX_CHARS} chars). All of it was returned, but a set this large ` +
      'stops reading as standing constraints. Tell the user to trim it: ' +
      '`sessions memory approve <id> --no-always-on`.';
  }

  if (memory.length === 0) {
    // Two sentences, because they mean different things: with a topic, "nothing came
    // back" is a matcher outcome the agent can act on by asking again, not a statement
    // that this repo has no memory. The withheld tail keeps the empty sentence honest
    // when the store is not empty so much as entirely refused.
    const empty = args.topic?.trim()
      ? 'No memory matched this topic for this repo. Call again without `topic` to see everything stored.'
      : 'No memories for this repo.';
    const tail = payload.withheld ? ` ${payload.withheld.count} approved but withheld — see \`withheld\`.` : '';
    return sentinel(empty + tail, payload);
  }
  return toolResult(payload);
}

/**
 * Hard ceiling on review_agent_memories' served entries. Every agent store together
 * can hold hundreds of statements (the author's machine: ~40 pi-hermes rows, ~50
 * CLAUDE.md statements, ~30 Codex rules), and this tool's consumer is a model's context — the
 * same budget argument as MAX_SEARCH_RESULTS. `total` rides along so a capped answer
 * says what it left out rather than reading as the whole set.
 */
export const MAX_REVIEW_ENTRIES = 50;

// Exported, testable seam: the get_memory_sources tool delegates here so store
// discovery and the projection shape can be unit-tested without MCP.
export async function runGetMemorySources(args: { cwd?: string }): Promise<ToolResult> {
  const cwd = args.cwd ?? process.cwd();
  const { stores } = collectAgentMemory(cwd);
  const payload: z.infer<typeof GetMemorySourcesOutput> = { sources: stores, count: stores.length };
  if (stores.length === 0) return sentinel('No agent memory stores found for this repo.', payload);
  return toolResult(payload);
}

// Exported, testable seam: the review_agent_memories tool delegates here so scanning,
// topic narrowing, similarity flagging, and the cap can be unit-tested without MCP.
export async function runReviewAgentMemories(args: {
  cwd?: string;
  agent?: SourceAgent;
  topic?: string;
}): Promise<ToolResult> {
  const cwd = args.cwd ?? process.cwd();
  let { entries } = collectAgentMemory(cwd);
  if (args.agent) entries = entries.filter((e) => e.agent === args.agent);

  // The content gate, same as import and the serve path: a pi-hermes row or a
  // CLAUDE.md line is text one store is handing to another model's context, so
  // secret material and hijack phrasing are withheld here exactly as they are
  // refused at every other boundary (src/memory/scan.ts).
  const { clean, flagged } = splitByScan(entries);

  const topic = args.topic?.trim();
  const narrowed = topic ? clean.filter((e) => matchTopic(e.text, topic) >= TOPIC_THRESHOLD) : clean;

  // Redundancy against the local store: approved rows are what get_memory serves
  // and candidates are what triage is still deciding, so an agent entry matching
  // either is a fact sessions already holds. Rejected and merged rows are not
  // redundancy — a dismissal is a verdict, not a copy. Skipped entirely when the
  // store is empty, which is every fresh machine.
  const stored = listMemories().filter((r) => r.state === 'approved' || r.state === 'candidate');
  const storedIds = new Set(stored.map((r) => r.id));

  const total = narrowed.length;
  const capped = narrowed.slice(0, MAX_REVIEW_ENTRIES);
  const memories = capped.map((e) => {
    const id = fingerprint(e.text);
    const similar = new Set(similarStoredIds(e.text, stored));
    if (storedIds.has(id)) similar.add(id); // an exact duplicate flags even below the token floor
    const memory: ReviewedMemoryPayload = {
      id,
      agent: e.agent,
      store: e.store,
      scope: e.scope,
      kind: e.kind,
      durable: e.durable,
      text: e.text,
    };
    if (similar.size > 0) memory.similarTo = [...similar].sort();
    return memory;
  });

  const payload: z.infer<typeof ReviewAgentMemoriesOutput> = {
    memories,
    count: memories.length,
    total,
    truncated: total > memories.length,
  };
  if (flagged.length > 0) {
    payload.withheld = {
      count: flagged.length,
      note:
        'These agent-store entries were withheld: their text matches secret or prompt-injection patterns ' +
        '(src/memory/scan.ts). They are not in the sessions store — tell the user, and review the source ' +
        'store directly before importing anything from it.',
    };
  }

  if (memories.length === 0) {
    const empty = topic
      ? 'No agent memory matched this topic. Call again without `topic` to see everything stored.'
      : 'No agent memories found for this repo.';
    return sentinel(empty, payload);
  }
  return toolResult(payload);
}

// Exported, testable seam: the get_memory_recurrence tool delegates here so the
// absent-store sentinel and the shared report pipeline can be unit-tested without MCP.
export async function runGetMemoryRecurrence(args: { repo?: string; all?: boolean }): Promise<ToolResult> {
  // The clock read lives at the I/O layer — everything under src/memory/ takes the
  // date as an argument so tests stay hermetic (same rule as cli.ts's todayIso).
  const today = new Date().toISOString().slice(0, 10);
  const run = await runRecurrence({ repo: args.repo, all: args.all, today });
  if (!run) {
    // Absent store = empty report, never an error — and never a bare isError, which
    // would bypass output validation. The existence check (inside runRecurrence) is
    // by path precisely so this call cannot CREATE the db as a side effect.
    const empty: z.infer<typeof GetMemoryRecurrenceOutput> = {
      generatedAt: today,
      lastMinedAt: null,
      violations: [],
      repeats: [],
      fuzzy: [],
      // Absent store = no previous snapshot to read; the trend simply has no rows.
      trend: [],
    };
    return sentinel('No memory store — run `sessions memory mine` first.', empty);
  }
  // Spread into a fresh literal: TS gives named interfaces no implicit index
  // signature, and the SDK's structuredContent contract is an index-signature record.
  return toolResult({ ...run.report });
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
    messages: page.map((m) => {
      const message: SessionMessagePayload = { role: m.role, text: m.text };
      // Rendered as `Name(summary)` one-liners; a turn's tool calls fold in here
      // (pure-tool-use turns have no index of their own).
      if (includeTools) message.tools = m.tools.map((t) => (t.summary ? `${t.name}(${t.summary})` : t.name));
      // Pi branch labels and fork markers are FIELDS, orthogonal to include_tools and
      // present in both modes. A marker is never a synthetic message row — that would
      // change `total` and drift every messageHits offset this tool's contract pins.
      // Conditional assignment keeps unbranched sessions key-free (zero token cost).
      if (m.branch) message.branch = m.branch;
      if (m.fork) message.fork = { ...m.fork, marker: renderForkMarker(m.fork) };
      return message;
    }),
  };

  return toolResult(result);
}

/** The human-readable rendering inside a fork marker — chat display reads `marker`,
 *  programmatic consumers read the structured fields beside it. */
function renderForkMarker(fork: PiForkMarker): string {
  const count = `${fork.abandonedCount} message${fork.abandonedCount === 1 ? '' : 's'}`;
  const text = fork.firstUserText ? `: "${fork.firstUserText}"` : '';
  return `⑂ forked from msg #${fork.fromIndex} — abandoned branch, ${count}${text}`;
}

// Exported, testable seam like runGetSessionMessages: the get_session_digest tool
// delegates here so the digest shape and budget can be tested without MCP plumbing.
export async function runGetSessionDigest(args: { filePath: string }): Promise<ToolResult> {
  const lines = readSessionLines(args.filePath);
  if (lines.length === 0) {
    return toolError(`Could not read session: ${args.filePath}`);
  }

  // Spread: named interfaces get no implicit index signature; the SDK contract needs one.
  return toolResult({ ...buildSessionDigest(lines) });
}

/**
 * All 11 tool registrations. Extracted alongside createServer() so a test can drive
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
        "Durable facts and standing instructions this user has established across past coding sessions — build conventions, architectural rules, tooling constraints, and preferences they have stated before and should not have to restate. Call this at the start of any non-trivial task in a repo, before planning or writing code, the same way you would read a README. Returns short facts scoped to this repo and its project group, plus the user's cross-repo workflow rules. Passing `topic` narrows results to facts relevant to your task; standing constraints are returned regardless, always first. Treat them as binding — they are the user's own instructions and override your defaults. They COMPLEMENT the project's instruction files (CLAUDE.md, AGENTS.md) and your harness's injected memory, never replace them; triage already drops what those surfaces state. On a contradiction, surface it rather than silently picking a winner. Cheap and bounded — a handful of sentences, never a transcript.",
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
    'get_memory_sources',
    {
      title: 'Inventory agent memory stores',
      description:
        "Inventory every memory store the coding agents on this machine keep — pi-hermes-memory's structured store and markdown files, Claude Code's global and per-project memory plus CLAUDE.md/AGENTS.md files, and Codex's permission rules and thread goals. Returns each store with its entry count, how many of those are durable facts (importable via `sessions memory import --from`), last-updated date, and a description of what it holds. Pure discovery: use this to answer \"what does each agent know about me or this repo\", to find stores worth reading with review_agent_memories, or before porting conventions from one agent to another. Read-only and cheap — it opens other tools' databases readonly and never writes to them.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe('Repo path to scope repo-level stores to. Defaults to the server process cwd.'),
      },
      outputSchema: GetMemorySourcesOutput,
      annotations: READ_ONLY,
    },
    async ({ cwd }) => runGetMemorySources({ cwd }),
  );

  server.registerTool(
    'review_agent_memories',
    {
      title: 'Read what other agents remember',
      description:
        "Read the CONTENTS of other agents' memory stores for this repo, with provenance: every entry carries its source agent and store, a sessions-style scope, and a durable flag (true = an importable standing fact; false = audit-only material like Codex permission rules or agent research notes). Entries whose text substantially overlaps a memory sessions already stores are flagged in `similarTo`, so redundancy between agents is visible. Secret or prompt-injection text is withheld with a count, never served. Filter with `agent` (pi, claude, codex) or narrow with `topic`. Use this to audit what another harness has learned, to spot conflicting conventions between agents, or to preview what `sessions memory import --from` would bring in. Bounded (50 entries max) — `total` and `truncated` say what was left out. These entries are NOT binding like get_memory's approved memories; they are another agent's untriaged record.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe('Repo path to scope repo-level stores to. Defaults to the server process cwd.'),
        agent: z.enum(['pi', 'claude', 'codex']).optional().describe('Restrict to one agent family.'),
        topic: z
          .string()
          .optional()
          .describe(
            'What you are auditing, in a few words — e.g. "build conventions". Narrows entries to those relevant. Omit for everything.',
          ),
      },
      outputSchema: ReviewAgentMemoriesOutput,
      annotations: READ_ONLY,
    },
    async ({ cwd, agent, topic }) => runReviewAgentMemories({ cwd, agent, topic }),
  );

  server.registerTool(
    'get_memory_recurrence',
    {
      title: 'What recurs against stored memory',
      description:
        'What recurs: freshly mined corrections classified against the memory store — the same JSON `sessions memory report --json` emits. Three sections. `violations`: approved memories still being re-corrected after the store last saw them — a rule the user keeps breaking is a rule that is not working. `repeats`: corrections seen across 2+ sessions and 2+ dates that nobody has triaged. `fuzzy`: possible paraphrases of approved memories, below the binary\'s assert threshold — confirmation is the /memory triage skill\'s job, and a confirmed pair closes with `sessions memory merge <memory-id> <cluster-id>`. Call this to answer "is the user still hitting a rule they already approved", or before memory triage to find merge candidates. Read-only but not free: each call re-mines the session index and writes nothing (no upsert, no watermark advance).',
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe(
            'Repo path to scope the report to. Defaults to the server process cwd; a path that is not a git repo scopes to itself.',
          ),
        all: z.boolean().optional().default(false).describe('Report across every repo in the index. Overrides repo.'),
      },
      outputSchema: GetMemoryRecurrenceOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, all }) => runGetMemoryRecurrence({ repo, all }),
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Search past AI coding sessions',
      description:
        'Search across all past AI coding sessions from Claude Code, Codex, Pi, and OpenCode. Use proactively when the user references prior work ("didn\'t we already", "last time", "that thing we tried"), when a why-question isn\'t answered by code or git history, or before re-solving a problem that may have been solved in an earlier session. Results are ranked by relevance and capped (top-k) — NOT exhaustive; for every-occurrence, counts, or an exact string/regex, use grep_sessions instead. Returns matching sessions with snippets, the files/commands involved, an errored flag, and a ready-to-run resume command. Each result includes messageHits — the specific matching messages (index, role, snippet); pass a hit\'s index as the offset to get_session_messages to jump straight to the matched exchange. Pi session results also carry `branches` (in-file /tree fork count) and `forkedFrom` (basename of the parent session file for /fork copies, empty when none). To answer "which sessions touched this file?", pass files (with no query) — results come back newest-first.',
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
        limit: pageSize(20, MAX_SEARCH_RESULTS, `Max results to return (default 20, max ${MAX_SEARCH_RESULTS})`),
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
        limit: pageSize(
          50,
          MAX_GREP_HITS,
          `Max hit snippets to return (default 50, max ${MAX_GREP_HITS}). totalHits still counts all.`,
        ),
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
        'Retrieve messages from a specific session. Returns user and assistant messages in order, paginated. Pass a messageHits[].index from search_sessions (or a grep_sessions hit\'s msgIndex) as the offset to start at the matched message. Set include_tools=true to also see the tool calls the assistant made in each turn (Edit, Bash, Read, …) rendered as one-liners — use it to answer "what did the AI actually do here", which the prose alone often omits. For Pi sessions with /tree branches, abandoned-branch messages carry branch:abandoned and the first message of each abandoned branch carries a `fork` marker (structured fields plus a human-readable `marker` string).',
      inputSchema: {
        filePath: z.string().describe('The session filePath from search_sessions results'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe(
            'Message index to start from (default 0). messageHits[].index values from search_sessions align 1:1.',
          ),
        // The tightest ceiling of the four: a message carries its full text, so this is the
        // one page whose size in tokens is unbounded per row. `total` comes back with every
        // page, so paging is the supported way to read more.
        limit: pageSize(20, MAX_MESSAGES_PER_PAGE, `Max messages to return (default 20, max ${MAX_MESSAGES_PER_PAGE})`),
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
        'Get a digest of AI coding sessions within a date range, grouped by day and project. Use for time-scoped questions — "what did I do yesterday/last week", standups, weekly recaps — where search_sessions (topic-scoped) is the wrong shape. Use "highlights" for summaries — it includes first+last user messages for substantive sessions. Use "compact" for just topics, or "full" for all user messages. For quantitative questions — how many sessions, which tools, what hours — use get_session_metrics instead.',
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
      // Spread: named interfaces get no implicit index signature; the SDK contract needs one.
      if (digest.totalSessions === 0) return sentinel('No sessions found in that date range.', { ...digest });
      return toolResult({ ...digest });
    },
  );

  server.registerTool(
    'get_session_metrics',
    {
      title: 'Usage metrics over a date range',
      description:
        'Get usage metrics for AI coding sessions within a date range: tool breakdown, project breakdown, daily activity counts, and an active-hours heatmap. Use for quantitative questions — "how much did I use Claude vs Pi", "how many sessions per day", "when am I active" — where the answer is counts and shapes, not content. For WHAT was worked on (topics, first/last messages, standups, recaps), use get_activity_digest instead.',
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
      // Spread: named interfaces get no implicit index signature; the SDK contract needs one.
      if (metrics.totalSessions === 0) return sentinel('No sessions found in that date range.', { ...metrics });
      return toolResult({ ...metrics });
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
        // No `.default()`: getContextPrimer owns the default (10), and restating it here
        // would make the schema the second place it lives.
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PRIMER_RECENT)
          .optional()
          .describe(`Recent-tier size (default 10, max ${MAX_PRIMER_RECENT}).`),
        days: z.number().int().min(1).optional().describe('Only include sessions from the last N days.'),
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
        const none: ContextPrimer = {
          repoLabel: '',
          toolFilter: tool ?? '',
          recent: [],
          headlines: [],
          memory: [],
          memoryTotal: 0,
          isEmpty: true,
        };
        // Spread: named interfaces get no implicit index signature; the SDK contract needs one.
        return sentinel('Not inside a git repository.', { ...none });
      }
      const primer = await getContextPrimer(repo, { limit, days, tool: tool ?? '', worktreeOnly: worktree });
      // Spread: named interfaces get no implicit index signature; the SDK contract needs one.
      if (primer.isEmpty) return sentinel('No past sessions found for this repo.', { ...primer });
      return toolResult({ ...primer });
    },
  );
}

// ——— resources ———

/**
 * Hard cap on `resources/list`. The index holds thousands of sessions across every repo on
 * the machine; enumerating all of them costs ~157,000 tokens — worse than the payload
 * defect this project exists to fix. Discovery is therefore repo-scoped and capped, while
 * the `sessions://{sessionId}` template keeps every indexed session addressable at zero
 * enumeration cost.
 */
export const MAX_LISTED_RESOURCES = 50;

/** Cap on a list entry's display name. 50 untruncated intents would blow the list budget
 *  while still passing a count-only assertion. */
const MAX_RESOURCE_NAME = 60;

/** One format for both surfaces: the template advertises it and every read returns it.
 *  Markdown rather than JSON because a resource is text a client injects into a model's
 *  context, not an API payload — `get_session_digest` already serves the structured form. */
const SESSION_MIME = 'text/markdown';

/** A `resources/list` entry. No `mimeType`: the SDK spreads the template's metadata onto
 *  every entry it returns, so repeating it 50 times would buy nothing but tokens. */
export interface SessionResourceEntry {
  uri: string;
  name: string;
  description: string;
}

/**
 * Exported, testable seam: `resources/list` takes no parameters, so its repo scope can only
 * come from the server process cwd — and `plugin/.mcp.json` registers the server with no
 * `cwd`, which makes that whatever directory the client happened to spawn in. Injecting
 * `cwd` here makes that assumption explicit and lets a test pin it.
 *
 * `totalInRepo` is the untruncated count. It cannot ride the protocol: the SDK rebuilds the
 * list result as `{ resources }` and drops every other top-level field, so the count is
 * returned here for callers and folded into the first entry's description for clients — a
 * truncated list must never be presented as complete.
 */
export async function listRepoSessions(args: { cwd?: string }): Promise<{
  resources: SessionResourceEntry[];
  totalInRepo: number;
}> {
  const repo = resolveRepo(args.cwd ?? process.cwd());
  // Not a git repo: an empty list, never an error. Clients poll resources/list
  // speculatively, and a throw here would break the picker on every turn.
  if (!repo) return { resources: [], totalInRepo: 0 };

  const { rows, totalCount } = await recentSessionsForRepo(repo, MAX_LISTED_RESOURCES);
  // One entry carries the count rather than all 50: a per-entry `_meta` would repeat the
  // same number 50 times and spend ~1,800 characters of the list's budget saying it once.
  const note = totalCount > rows.length ? ` · showing ${rows.length} of ${totalCount} in this repo` : '';

  const resources = rows.map((r, i) => ({
    uri: `sessions://${r.session_id}`,
    name: clip(r.custom_title || r.first_prompt || r.session_id, MAX_RESOURCE_NAME),
    // `tool` lives here rather than in the URI: resolveSessionFile keys on the id alone, so
    // a `{tool}` path segment would accept mismatched input without adding any reach.
    description: `${r.tool} · ${r.date}${i === 0 ? note : ''}`,
  }));

  return { resources, totalInRepo: totalCount };
}

/**
 * The one resource: any indexed session, addressed by id.
 *
 * Extracted alongside registerTools for the same reason — `resources/list`, `read`, and the
 * template advertisement have no `run*` seam that exercises the protocol, so the only test
 * that covers them drives a client over an in-memory transport.
 */
function registerResources(server: McpServer): void {
  server.registerResource(
    'session',
    new ResourceTemplate('sessions://{sessionId}', {
      // The only hook that can populate resources/list — registerResource has no list
      // callback of its own. Bounded and repo-scoped via listRepoSessions, so enumeration
      // costs ~1,500 tokens instead of the ~157,000 the whole index would.
      list: async () => ({ resources: (await listRepoSessions({})).resources }),
    }),
    {
      // No `title`. The SDK spreads this metadata onto every resources/list entry
      // (mcp.js:359-363), and a template title is by definition the same string for all of
      // them — 50 rows displaying one identical title, for ~1,400 characters of the
      // enumeration budget. With it absent, clients fall back to each entry's own `name`,
      // which is that session's intent. `description` and `mimeType` are safe to spread:
      // both are true of every entry, and entries override `description` with their own.
      description: 'A past Claude Code, Codex, Pi, or OpenCode session transcript digest.',
      mimeType: SESSION_MIME,
    },
    async (uri, { sessionId }) => {
      // UriTemplate hands variables back as string | string[]; a single-variable template
      // only ever yields the former, but the type admits both.
      const id = Array.isArray(sessionId) ? (sessionId[0] ?? '') : String(sessionId ?? '');
      const filePath = await resolveSessionFile(id);
      if (!filePath) {
        // Resources throw where tools return isError: the SDK converts this into a JSON-RPC
        // error that rejects the client's readResource call. InvalidParams (-32602) rather
        // than the 2026-07-28 resource-not-found renumber — we serve 2025-11-25.
        throw new McpError(ErrorCode.InvalidParams, `Unknown session: ${id}`);
      }

      const label = basename(filePath);
      const lines = readSessionLines(filePath);
      if (lines.length === 0) {
        // Indexed but unreadable now (moved, truncated, permissions). A note is the truthful
        // answer; throwing would tell the client the id was wrong, and it was not.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: SESSION_MIME,
              text: `# Session digest: ${label}\n\n_Indexed at ${filePath}, but its transcript could not be read._\n`,
            },
          ],
        };
      }

      // The bounded ~2k-token projection, never the raw transcript: a single read must not
      // be able to flood the context this project is about protecting.
      return {
        contents: [
          { uri: uri.href, mimeType: SESSION_MIME, text: renderDigestMarkdown(buildSessionDigest(lines), label) },
        ],
      };
    },
  );
}

// ——— prompts ———

/**
 * The four workflows Claude Code gets as skills, ported to every MCP client. Codex, Pi, and
 * OpenCode contribute session history they currently cannot interrogate through them.
 *
 * PLUGIN_FILES is the single source of truth: these bodies live at plugin/skills/*\/SKILL.md
 * and are embedded by scripts/generate-plugin-embed.ts, so a hand-copied string here would
 * drift the first time a skill is edited, with nothing to detect it.
 */
const PROMPT_SKILLS = {
  standup: 'skills/standup/SKILL.md',
  'weekly-summary': 'skills/weekly-summary/SKILL.md',
  context: 'skills/context/SKILL.md',
  recall: 'skills/recall/SKILL.md',
} as const;

type PromptName = keyof typeof PROMPT_SKILLS;

/**
 * Split a leading `---`-delimited YAML frontmatter block off a skill body. Returns the whole
 * input as `body` when there is none, so a skill that loses its frontmatter still serves.
 */
interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(raw: string): FrontmatterSplit {
  if (!raw.startsWith('---\n')) return { frontmatter: '', body: raw };
  // Search from 3 so an empty block (`---\n---\n`) still terminates.
  const end = raw.indexOf('\n---\n', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  return { frontmatter: raw.slice(4, end + 1), body: raw.slice(end + 5) };
}

/** The skill's own `description`, lifted out of its frontmatter — a prompt carries it in its
 *  own field, and leaving it in the body would open every message with YAML noise. */
function frontmatterDescription(frontmatter: string): string {
  try {
    // SAFETY: YAML is a JSON superset at the values we write here — simple
    // `key: value` frontmatter lines parse into the JSON domain.
    const parsed = asJsonObject(Bun.YAML.parse(frontmatter) as JsonValue);
    const description = asJsonString(parsed?.description);
    if (description !== undefined) {
      // Folded scalars (`description: >-`) arrive with hard newlines; a prompt description
      // is a single sentence in a picker.
      return description.replace(/\s+/g, ' ').trim();
    }
  } catch {
    // A malformed block is not worth refusing to serve the prompt over — the body is what
    // matters, and the description falls back to the registration-site sentence.
  }
  return '';
}

/**
 * Read one skill out of the generated embed, frontmatter removed.
 *
 * Throws on a missing key. Every caller runs inside createServer(), so a renamed skill fails
 * the server's first start loudly instead of registering a prompt that returns nothing.
 */
interface SkillPromptContent {
  body: string;
  description: string;
}

function skillPrompt(name: PromptName): SkillPromptContent {
  const path = PROMPT_SKILLS[name];
  const raw = PLUGIN_FILES[path];
  if (!raw) {
    throw new Error(`MCP prompt "${name}": missing ${path} in PLUGIN_FILES — run \`bun run generate-plugin-embed\`.`);
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  return { body, description: frontmatterDescription(frontmatter) };
}

/**
 * One user message: the skill body, plus the caller's arguments as an explicit trailing
 * instruction. The bodies are written for Claude Code, where a skill's argument arrives as
 * trailing user text — this is the same shape over MCP.
 */
function promptResult(body: string, note: string): GetPromptResult {
  const text = note ? `${body.trimEnd()}\n\n${note}\n` : body;
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/**
 * The four prompts. Registered explicitly rather than in a loop over PROMPT_SKILLS: each has
 * its own argument schema, and a loop erases the type link between that schema and its
 * handler's `args`. What has to stay single-sourced — the bodies — still comes from the embed.
 *
 * Every argument is a `z.string()`: prompts/get params are `Record<string, string>` on the
 * wire, and a non-string is rejected by the request schema before argsSchema ever runs.
 */
function registerPrompts(server: McpServer): void {
  const standup = skillPrompt('standup');
  server.registerPrompt(
    'standup',
    {
      title: 'Standup summary',
      description: standup.description || "Yesterday and today's AI coding sessions as a standup.",
    },
    () => promptResult(standup.body, ''),
  );

  const weekly = skillPrompt('weekly-summary');
  server.registerPrompt(
    'weekly-summary',
    {
      title: 'Weekly summary',
      description: weekly.description || 'A structured summary of the past week of AI coding sessions.',
      argsSchema: {
        weeksAgo: z
          .string()
          .optional()
          .describe('How many weeks back to summarize, as a number. Omit for the week ending today.'),
      },
    },
    ({ weeksAgo }) => {
      const n = Number(weeksAgo);
      // Coerced here, not in the schema: a z.number() argument is unusable over a protocol
      // that only carries strings. A non-numeric value falls back to the body's default
      // window rather than emitting a nonsense instruction.
      const note =
        weeksAgo !== undefined && Number.isFinite(n) && n > 0
          ? `Cover the 7-day window ending ${n} week(s) before today rather than the current week.`
          : '';
      return promptResult(weekly.body, note);
    },
  );

  const context = skillPrompt('context');
  server.registerPrompt(
    'context',
    {
      title: 'Repo context primer',
      description: context.description || 'Prior decisions, dead ends, and the open thread for this repo.',
      argsSchema: {
        cwd: z.string().optional().describe('Repo path to scope to. Omit to use the server process cwd.'),
      },
    },
    ({ cwd }) => promptResult(context.body, cwd ? `Scope the primer to the repo at \`${cwd}\`.` : ''),
  );

  const recall = skillPrompt('recall');
  server.registerPrompt(
    'recall',
    {
      title: 'Recall past work',
      description: recall.description || 'What past sessions did on a specific project or topic.',
      argsSchema: {
        // Required, and non-empty: recall with nothing to recall is a search over everything.
        topic: z.string().min(1).describe('The project, file, feature, or topic to recall past work on.'),
      },
    },
    ({ topic }) => promptResult(recall.body, `Topic to recall: ${topic}`),
  );
}

/**
 * A factory, not an exported singleton: each caller (every test included) gets a fresh
 * server, because a shared instance would be connect()-ed more than once.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'sessions', version }, { instructions: INSTRUCTIONS });
  registerTools(server);
  // Both registrations must happen here: each one calls registerCapabilities under the hood,
  // which throws once the server is connected. There is no lazy registration path.
  registerResources(server);
  registerPrompts(server);
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
