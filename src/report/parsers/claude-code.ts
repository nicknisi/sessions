// Sessions-owned (forked from tokenmaxing's parser). Dedupes usage by (message.id, requestId)
// so the same API response — copied across resumed/forked session files — is counted once, matching ccusage.
//
// Subagent attribution: Claude Code writes dispatched agents to
// `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, and those transcripts
// carry the parent's sessionId. Their tokens were always counted (the walk
// recurses), but nothing said which agent spent them. The agent TYPE lives in two
// places, neither complete on its own, so both are consulted:
//   1. the sibling `agent-<agentId>.meta.json` (covers ~77% of dispatches here);
//   2. the parent transcript's `toolUseResult` on the user record that closes the
//      Task/Agent tool call, which carries agentId + agentType.
// A file therefore cannot name its own dispatches on its own — a subagent
// transcript is usually read before the parent record that names it. Parsing is
// split accordingly: parseFile() extracts what one file knows, and
// resolveAgentTypes() names the dispatches once every file has been seen. The
// event cache relies on that split, since it parses files one at a time.
import { z } from 'zod';

import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';
import { walkJsonl, type WalkOptions } from './walk.ts';

const claudeAssistantLineSchema = z.object({
  type: z.literal('assistant'),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  requestId: z.string().optional(),
  gitBranch: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().optional(),
  data: z.object({ agentId: z.string().optional() }).optional(),
  message: z
    .object({
      id: z.string().optional(),
      model: z.string().optional(),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
          speed: z.enum(['standard', 'fast']).optional().catch(undefined),
          cache_creation: z
            .object({
              ephemeral_5m_input_tokens: z.number().optional(),
              ephemeral_1h_input_tokens: z.number().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
type ClaudeAssistantLine = z.infer<typeof claudeAssistantLineSchema>;

const claudeUserLineSchema = z.object({
  type: z.literal('user'),
  toolUseResult: z.object({ agentId: z.string().optional(), agentType: z.string().optional() }).optional(),
});

const SUBAGENT_PATH = /[/\\]subagents[/\\]/;
// `agent-<id>.jsonl` — the id in the filename is the dispatch id, and is the only
// source when a transcript's records omit `agentId`.
const AGENT_FILENAME = /[/\\]agent-([^/\\]+)\.jsonl$/;
// Auto-compaction runs as a subagent with no parent dispatch record and no meta
// file, so it can only ever be named by its id prefix.
const AUTOCOMPACT_PREFIX = 'acompact-';

export const UNKNOWN_AGENT_TYPE = 'unknown';

/** A dispatch name plus how much to trust it. `strong` marks a name read from the
 *  dispatch's own meta.json, which beats a name read from a parent transcript no
 *  matter which file the walk reaches first. */
export interface AgentName {
  type: string;
  strong: boolean;
}

/** What one transcript file yields on its own. `agentTypes` is what this file
 *  revealed about dispatch naming, which may belong to events in other files. */
export interface ParsedFile {
  /** Events whose `agent.type` is still a placeholder — resolveAgentTypes fills it. */
  events: UsageEvent[];
  agentTypes: Record<string, AgentName>;
}

/** Fold one file's names into the running map. A strong name always wins; a weak
 *  one only fills a gap. Order-independent, which the cache depends on: files come
 *  back in whatever order the database returns them. */
export function mergeAgentNames(into: Record<string, AgentName>, from: Record<string, AgentName>): void {
  for (const [id, name] of Object.entries(from)) {
    const cur = into[id];
    if (!cur || (name.strong && !cur.strong)) into[id] = name;
  }
}

function recordAgentId(line: ClaudeAssistantLine): string | undefined {
  return line.agentId ?? line.data?.agentId;
}

// Read the agentType out of the `agent-<id>.meta.json` written next to a subagent
// transcript. Missing or malformed metadata is not an error — the parent-record
// map is the fallback.
const agentMetaSchema = z.object({ agentType: z.string().min(1) });

async function readAgentMeta(jsonlPath: string): Promise<string | undefined> {
  try {
    const meta = agentMetaSchema.safeParse(await Bun.file(jsonlPath.replace(/\.jsonl$/, '.meta.json')).json());
    return meta.success ? meta.data.agentType : undefined;
  } catch {
    return undefined;
  }
}

/** Parse one transcript. Self-contained: no cross-file state, so the result is
 *  cacheable against the file's mtime. */
export async function parseClaudeCodeFile(path: string): Promise<ParsedFile> {
  const events: UsageEvent[] = [];
  const agentTypes: Record<string, AgentName> = {};

  const inSubagentDir = SUBAGENT_PATH.test(path);
  const fileAgentId = inSubagentDir ? AGENT_FILENAME.exec(path)?.[1] : undefined;
  if (fileAgentId) {
    const metaType = await readAgentMeta(path);
    // Written by the dispatcher itself, so it outranks the parent record, which
    // is absent on an interrupted run and stale on a replayed one.
    if (metaType) agentTypes[fileAgentId] = { type: metaType, strong: true };
  }

  for await (const line of readJsonlLines(path)) {
    const userLine = claudeUserLineSchema.safeParse(line);
    if (userLine.success) {
      const r = userLine.data.toolUseResult;
      if (r?.agentId && r.agentType && !agentTypes[r.agentId])
        agentTypes[r.agentId] = { type: r.agentType, strong: false };
      continue;
    }
    const assistantLine = claudeAssistantLineSchema.safeParse(line);
    if (!assistantLine.success) continue;
    const assistant = assistantLine.data;
    const u = assistant.message?.usage;
    const model = assistant.message?.model;
    const ts = assistant.timestamp;
    const sid = assistant.sessionId;
    if (!u || !model || !ts || !sid) continue;
    // A subagent message is one that says so (agentId / isSidechain) or one that
    // lives in a subagents/ transcript. The record's own id wins over the
    // filename so a transcript holding more than one dispatch stays correct.
    const agentId = recordAgentId(assistant) ?? (assistant.isSidechain || inSubagentDir ? fileAgentId : undefined);
    const id = assistant.message?.id;
    const event: UsageEvent = {
      tool: 'claude-code',
      provider: 'anthropic',
      model,
      timestamp: ts,
      sessionId: sid,
      projectPath: assistant.cwd,
      tokens: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
    };
    if (assistant.gitBranch) event.branch = assistant.gitBranch;
    if (u.speed) event.speed = u.speed;
    // The same API response is rewritten into every resumed/forked session
    // file; this key lets the merge count it once. Absent when the record has
    // no message id, in which case it cannot be deduped.
    if (id) event.dedupKey = `${id}|${assistant.requestId ?? ''}`;
    if (agentId) event.agent = { id: agentId, type: UNKNOWN_AGENT_TYPE };
    events.push(event);
  }

  return { events, agentTypes };
}

/** Name every dispatch, now that every file's contribution to the map is known.
 *  Mutates in place — the events are freshly built by the caller. */
export function resolveAgentTypes(events: UsageEvent[], agentTypes: Record<string, AgentName>): void {
  for (const e of events) {
    if (!e.agent) continue;
    e.agent.type = e.agent.id.startsWith(AUTOCOMPACT_PREFIX)
      ? 'auto-compact'
      : (agentTypes[e.agent.id]?.type ?? UNKNOWN_AGENT_TYPE);
  }
}

/** Drop repeats of the same API response, keeping its most complete usage record. */
export function dedupeEvents(events: UsageEvent[]): UsageEvent[] {
  const positions = new Map<string, number>();
  const out: UsageEvent[] = [];
  const volume = (e: UsageEvent) => e.tokens.input + e.tokens.output + e.tokens.cacheRead + e.tokens.cacheWrite;
  for (const e of events) {
    if (!e.dedupKey) {
      out.push(e);
      continue;
    }
    const position = positions.get(e.dedupKey);
    if (position === undefined) {
      positions.set(e.dedupKey, out.length);
      out.push(e);
      continue;
    }
    const current = out[position]!;
    if (
      volume(e) > volume(current) ||
      (volume(e) === volume(current) && (e.costUSD ?? 0) > (current.costUSD ?? 0)) ||
      (volume(e) === volume(current) && e.speed === 'fast' && current.speed !== 'fast')
    ) {
      out[position] = e;
    }
  }
  return out;
}

export async function parseClaudeCode(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  const all: UsageEvent[] = [];
  const agentTypes: Record<string, AgentName> = {};
  for await (const path of walkJsonl(root, opts)) {
    const parsed = await parseClaudeCodeFile(path);
    all.push(...parsed.events);
    mergeAgentNames(agentTypes, parsed.agentTypes);
  }
  const events = dedupeEvents(all);
  resolveAgentTypes(events, agentTypes);
  return events;
}
