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
import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';
import { walkJsonl, type WalkOptions } from './walk.ts';

interface ClaudeAssistantLine {
  type: 'assistant';
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  requestId?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  agentId?: string;
  data?: { agentId?: string };
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

interface ClaudeUserLine {
  type: 'user';
  toolUseResult?: { agentId?: string; agentType?: string };
}

function isAssistantLine(v: unknown): v is ClaudeAssistantLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'assistant';
}

function isUserLine(v: unknown): v is ClaudeUserLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'user';
}

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
async function readAgentMeta(jsonlPath: string): Promise<string | undefined> {
  try {
    const meta = (await Bun.file(jsonlPath.replace(/\.jsonl$/, '.meta.json')).json()) as unknown;
    if (!meta || typeof meta !== 'object') return undefined;
    const t = (meta as { agentType?: unknown }).agentType;
    return typeof t === 'string' && t.length > 0 ? t : undefined;
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
    if (isUserLine(line)) {
      const r = line.toolUseResult;
      if (r?.agentId && r.agentType && !agentTypes[r.agentId])
        agentTypes[r.agentId] = { type: r.agentType, strong: false };
      continue;
    }
    if (!isAssistantLine(line)) continue;
    const u = line.message?.usage;
    const model = line.message?.model;
    const ts = line.timestamp;
    const sid = line.sessionId;
    if (!u || !model || !ts || !sid) continue;
    // A subagent message is one that says so (agentId / isSidechain) or one that
    // lives in a subagents/ transcript. The record's own id wins over the
    // filename so a transcript holding more than one dispatch stays correct.
    const agentId = recordAgentId(line) ?? (line.isSidechain || inSubagentDir ? fileAgentId : undefined);
    const id = line.message?.id;
    events.push({
      tool: 'claude-code',
      provider: 'anthropic',
      model,
      timestamp: ts,
      sessionId: sid,
      projectPath: line.cwd,
      ...(line.gitBranch ? { branch: line.gitBranch } : {}),
      // The same API response is rewritten into every resumed/forked session
      // file; this key lets the merge count it once. Absent when the record has
      // no message id, in which case it cannot be deduped.
      ...(id ? { dedupKey: `${id}|${line.requestId ?? ''}` } : {}),
      ...(agentId ? { agent: { id: agentId, type: UNKNOWN_AGENT_TYPE } } : {}),
      tokens: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
    });
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

/** Drop repeats of the same API response, keeping the first occurrence. */
export function dedupeEvents(events: UsageEvent[]): UsageEvent[] {
  const seen = new Set<string>();
  const out: UsageEvent[] = [];
  for (const e of events) {
    if (e.dedupKey) {
      if (seen.has(e.dedupKey)) continue;
      seen.add(e.dedupKey);
    }
    out.push(e);
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
