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
// Resolution happens after the whole walk, since a subagent file is usually read
// before the parent record that names it.
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

export async function parseClaudeCode(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  // The same API response is rewritten into every resumed/forked session file; dedupe by the
  // Anthropic message id + requestId (globally across files) so each response is counted once.
  const seen = new Set<string>();
  // agentId → agentType, filled from both sources as files stream past.
  const agentTypes = new Map<string, string>();
  // Parallel to `events`: the dispatch id for each event, or undefined for
  // main-loop messages. Kept out of the event itself until types resolve.
  const pendingAgentIds: (string | undefined)[] = [];

  for await (const path of walkJsonl(root, opts)) {
    const inSubagentDir = SUBAGENT_PATH.test(path);
    const fileAgentId = inSubagentDir ? AGENT_FILENAME.exec(path)?.[1] : undefined;
    if (fileAgentId) {
      const metaType = await readAgentMeta(path);
      // meta.json is authoritative when present: it is written by the dispatcher
      // itself, whereas the parent record can be absent on an interrupted run.
      if (metaType) agentTypes.set(fileAgentId, metaType);
    }

    for await (const line of readJsonlLines(path)) {
      if (isUserLine(line)) {
        const r = line.toolUseResult;
        if (r?.agentId && r.agentType && !agentTypes.has(r.agentId)) agentTypes.set(r.agentId, r.agentType);
        continue;
      }
      if (!isAssistantLine(line)) continue;
      const u = line.message?.usage;
      const model = line.message?.model;
      const ts = line.timestamp;
      const sid = line.sessionId;
      if (!u || !model || !ts || !sid) continue;
      const id = line.message?.id;
      if (id) {
        const key = `${id}|${line.requestId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // A subagent message is one that says so (agentId / isSidechain) or one that
      // lives in a subagents/ transcript. The record's own id wins over the
      // filename so a transcript holding more than one dispatch stays correct.
      const agentId = recordAgentId(line) ?? (line.isSidechain || inSubagentDir ? fileAgentId : undefined);
      events.push({
        tool: 'claude-code',
        provider: 'anthropic',
        model,
        timestamp: ts,
        sessionId: sid,
        projectPath: line.cwd,
        ...(line.gitBranch ? { branch: line.gitBranch } : {}),
        tokens: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
      });
      pendingAgentIds.push(agentId);
    }
  }

  // Resolve types now that every meta file and parent record has been seen.
  for (let i = 0; i < events.length; i++) {
    const agentId = pendingAgentIds[i];
    if (!agentId) continue;
    const type = agentId.startsWith(AUTOCOMPACT_PREFIX)
      ? 'auto-compact'
      : (agentTypes.get(agentId) ?? UNKNOWN_AGENT_TYPE);
    events[i]!.agent = { id: agentId, type };
  }

  return events;
}
