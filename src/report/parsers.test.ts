import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCode } from './parsers/claude-code.ts';
import { parseCodex } from './parsers/codex.ts';
import { parsePi } from './parsers/pi.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-parsers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

function claudeLine(opts: {
  id?: string;
  requestId?: string;
  input?: number;
  output?: number;
  speed?: 'standard' | 'fast';
}): string {
  const usage: JsonObject = {
    input_tokens: opts.input ?? 1000,
    output_tokens: opts.output ?? 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 10000,
  };
  if (opts.speed) usage.speed = opts.speed;
  const message: JsonObject = { model: 'claude-opus-4-8', usage };
  if (opts.id !== undefined) message.id = opts.id;
  const line: JsonObject = {
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: '2026-06-01T14:30:00Z',
    message,
  };
  if (opts.requestId !== undefined) line.requestId = opts.requestId;
  return JSON.stringify(line) + '\n';
}

describe('parseClaudeCode dedup', () => {
  test('dedupes identical (message.id, requestId) across files', async () => {
    const root = join(tmp, 'claude-dup');
    mkdirSync(join(root, 'proj'), { recursive: true });
    // Same API response copied into two session files (resume/fork scenario).
    writeFileSync(join(root, 'proj', 'a.jsonl'), claudeLine({ id: 'msg_1', requestId: 'req_1' }));
    writeFileSync(join(root, 'proj', 'b.jsonl'), claudeLine({ id: 'msg_1', requestId: 'req_1' }));
    const events = await parseClaudeCode(root);
    expect(events.length).toBe(1);
  });

  test('keeps the complete usage from streamed records sharing one response id', async () => {
    const root = join(tmp, 'claude-streamed');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      claudeLine({ id: 'msg_stream', requestId: 'req_stream', output: 5, speed: 'fast' }) +
        claudeLine({ id: 'msg_stream', requestId: 'req_stream', output: 500, speed: 'fast' }),
    );
    const events = await parseClaudeCode(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens.output).toBe(500);
    expect(events[0]!.speed).toBe('fast');
  });

  test('keeps distinct message.id events', async () => {
    const root = join(tmp, 'claude-distinct');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      claudeLine({ id: 'msg_1', requestId: 'req_1' }) + claudeLine({ id: 'msg_2', requestId: 'req_1' }),
    );
    const events = await parseClaudeCode(root);
    expect(events.length).toBe(2);
  });

  test('counts lines missing message.id (cannot dedupe)', async () => {
    const root = join(tmp, 'claude-noid');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), claudeLine({}) + claudeLine({}));
    const events = await parseClaudeCode(root);
    expect(events.length).toBe(2);
  });
});

describe('parseClaudeCode 1h cache split', () => {
  test('extracts ephemeral_1h_input_tokens as cacheWrite1h (cacheWrite stays total)', async () => {
    const root = join(tmp, 'claude-1h');
    mkdirSync(root, { recursive: true });
    const line =
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        cwd: '/x',
        timestamp: '2026-06-01T14:30:00Z',
        requestId: 'req_9',
        message: {
          id: 'msg_9',
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
          },
        },
      }) + '\n';
    writeFileSync(join(root, 'a.jsonl'), line);
    const events = await parseClaudeCode(root);
    expect(events[0]!.tokens.cacheWrite).toBe(1000);
    expect(events[0]!.tokens.cacheWrite1h).toBe(700);
  });
});

// A subagent transcript as Claude Code writes it: under <session>/subagents/,
// named agent-<agentId>.jsonl, with isSidechain + agentId on every record and the
// PARENT's sessionId (the dispatch is not a session of its own).
function subagentFile(root: string, sessionId: string, agentId: string, opts: { metaType?: string } = {}): void {
  const dir = join(root, 'proj', sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const line =
    JSON.stringify({
      type: 'assistant',
      sessionId,
      agentId,
      isSidechain: true,
      cwd: '/Users/x/Developer/sessions',
      gitBranch: 'feat/thing',
      timestamp: '2026-06-01T14:35:00Z',
      requestId: `req_${agentId}`,
      message: {
        id: `msg_${agentId}`,
        model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 900 },
      },
    }) + '\n';
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), line);
  if (opts.metaType) {
    writeFileSync(
      join(dir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: opts.metaType, description: 'a dispatch' }),
    );
  }
}

// The parent-side record that closes an Agent/Task tool call and names the type.
function dispatchRecord(agentId: string, agentType: string): string {
  return (
    JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-06-01T14:36:00Z',
      toolUseResult: { agentId, agentType, status: 'completed', totalTokens: 160 },
    }) + '\n'
  );
}

describe('parseClaudeCode subagent attribution', () => {
  test('types a dispatch from its sibling meta.json', async () => {
    const root = join(tmp, 'claude-sub-meta');
    subagentFile(root, 's1', 'a1', { metaType: 'Explore' });
    const events = await parseClaudeCode(root);
    expect(events.length).toBe(1);
    expect(events[0]!.agent).toEqual({ id: 'a1', type: 'Explore' });
  });

  test("falls back to the parent's toolUseResult when meta.json is missing", async () => {
    const root = join(tmp, 'claude-sub-parent');
    subagentFile(root, 's1', 'a2');
    writeFileSync(join(root, 'proj', 'parent.jsonl'), dispatchRecord('a2', 'general-purpose'));
    const events = await parseClaudeCode(root);
    expect(events[0]!.agent).toEqual({ id: 'a2', type: 'general-purpose' });
  });

  test('meta.json wins over the parent record', async () => {
    const root = join(tmp, 'claude-sub-precedence');
    subagentFile(root, 's1', 'a3', { metaType: 'Explore' });
    writeFileSync(join(root, 'proj', 'parent.jsonl'), dispatchRecord('a3', 'stale-type'));
    const events = await parseClaudeCode(root);
    expect(events[0]!.agent!.type).toBe('Explore');
  });

  test('names auto-compaction rather than leaving it unknown', async () => {
    const root = join(tmp, 'claude-sub-compact');
    subagentFile(root, 's1', 'acompact-xyz');
    const events = await parseClaudeCode(root);
    expect(events[0]!.agent!.type).toBe('auto-compact');
  });

  test('an untypeable dispatch still counts, as unknown', async () => {
    const root = join(tmp, 'claude-sub-unknown');
    subagentFile(root, 's1', 'a4');
    const events = await parseClaudeCode(root);
    expect(events[0]!.agent).toEqual({ id: 'a4', type: 'unknown' });
  });

  test('main-loop messages carry no agent, and branch is captured', async () => {
    const root = join(tmp, 'claude-mainloop');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        cwd: '/x',
        gitBranch: 'main',
        timestamp: '2026-06-01T14:30:00Z',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } },
      }) + '\n',
    );
    const events = await parseClaudeCode(root);
    expect(events[0]!.agent).toBeUndefined();
    expect(events[0]!.branch).toBe('main');
  });

  test('user records never become usage events', async () => {
    const root = join(tmp, 'claude-user-only');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), dispatchRecord('a9', 'Explore'));
    expect(await parseClaudeCode(root)).toEqual([]);
  });
});

function codexLines(usage: Record<string, number>): string {
  return (
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-01T10:00:00Z', payload: { id: 'sess1', cwd: '/x' } }) +
    '\n' +
    JSON.stringify({ type: 'turn_context', timestamp: '2026-06-01T10:00:01Z', payload: { model: 'gpt-5.5' } }) +
    '\n' +
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-01T10:00:02Z',
      payload: { type: 'token_count', info: { last_token_usage: usage } },
    }) +
    '\n'
  );
}

describe('parseCodex accounting', () => {
  test('excludes cached tokens from input (input_tokens is cache-inclusive)', async () => {
    const root = join(tmp, 'codex-input');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      codexLines({ input_tokens: 1000, output_tokens: 100, reasoning_output_tokens: 30, cached_input_tokens: 600 }),
    );
    const events = await parseCodex(root);
    expect(events.length).toBe(1);
    expect(events[0]!.tokens.input).toBe(400); // 1000 - 600 cached
    expect(events[0]!.tokens.cacheRead).toBe(600);
  });

  test('does not double-count reasoning in output (output_tokens already includes it)', async () => {
    const root = join(tmp, 'codex-output');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      codexLines({ input_tokens: 1000, output_tokens: 100, reasoning_output_tokens: 30, cached_input_tokens: 0 }),
    );
    const events = await parseCodex(root);
    expect(events[0]!.tokens.output).toBe(100); // not 130
  });
});

// A Pi session file: `{type:'session'}` header plus entries. Assistant messages
// nest provider/model/usage (and responseId) inside `message`, current format.
function piSession(id: string, entries: string[], cwd = '/Users/x/Developer/sessions'): string {
  const header = JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-06-01T10:00:00Z', cwd });
  return [header, ...entries].join('\n') + '\n';
}

function piAssistant(opts: {
  responseId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cost?: number;
  stopReason?: string;
  model?: string;
  provider?: string;
  timestamp?: string;
}): string {
  const usage: JsonObject = {
    input: opts.input ?? 100,
    output: opts.output ?? 50,
    cacheRead: opts.cacheRead ?? 0,
    cacheWrite: opts.cacheWrite ?? 0,
  };
  if (opts.cacheWrite1h !== undefined) usage.cacheWrite1h = opts.cacheWrite1h;
  if (opts.cost !== undefined) usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost };
  const message: JsonObject = {
    role: 'assistant',
    provider: opts.provider ?? 'anthropic',
    model: opts.model ?? 'claude-opus-4-8',
    usage,
    stopReason: opts.stopReason ?? 'stop',
  };
  if (opts.responseId !== undefined) message.responseId = opts.responseId;
  return JSON.stringify({
    type: 'message',
    id: Math.random().toString(36).slice(2, 10),
    timestamp: opts.timestamp ?? '2026-06-01T10:00:05Z',
    message,
  });
}

describe('parsePi dedup', () => {
  test('dedupes the same responseId across files (fork/clone copies)', async () => {
    const root = join(tmp, 'pi-dup');
    mkdirSync(join(root, '--proj--'), { recursive: true });
    const turn = piAssistant({ responseId: 'resp_1', cost: 0.5 });
    // fork/clone rewrites the same response into a new file with a NEW session id.
    writeFileSync(join(root, '--proj--', 'a.jsonl'), piSession('s-parent', [turn]));
    writeFileSync(join(root, '--proj--', 'b.jsonl'), piSession('s-fork', [turn]));
    const events = await parsePi(root);
    expect(events.length).toBe(1);
  });

  test('keeps distinct responseIds', async () => {
    const root = join(tmp, 'pi-distinct');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      piSession('s1', [
        piAssistant({ responseId: 'resp_1', cost: 0.1 }),
        piAssistant({ responseId: 'resp_2', cost: 0.2 }),
      ]),
    );
    const events = await parsePi(root);
    expect(events.length).toBe(2);
  });

  test('counts messages missing responseId (cannot dedupe)', async () => {
    const root = join(tmp, 'pi-norid');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [piAssistant({ cost: 0.1 }), piAssistant({ cost: 0.1 })]));
    const events = await parsePi(root);
    expect(events.length).toBe(2);
    expect(events[0]!.dedupKey).toBeUndefined();
  });

  test('pi dedup keys are tool-prefixed so they can never collide with claude-code keys', async () => {
    const root = join(tmp, 'pi-prefix');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [piAssistant({ responseId: 'resp_9', cost: 0.1 })]));
    const events = await parsePi(root);
    expect(events[0]!.dedupKey).toBe('pi|resp_9');
  });
});

describe('parsePi cost handling', () => {
  test('trusts a positive recorded cost', async () => {
    const root = join(tmp, 'pi-cost-pos');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [piAssistant({ responseId: 'r1', cost: 0.42 })]));
    const events = await parsePi(root);
    expect(events[0]!.costUSD).toBe(0.42);
  });

  test('a recorded $0 cost with real tokens falls through to the pricing engine', async () => {
    // Pi logs cost.total = 0 when it has no rate for a model; trusting it would
    // silently bill the tokens at $0 and mute the unpriced-model warning.
    const root = join(tmp, 'pi-cost-zero');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [piAssistant({ responseId: 'r1', cost: 0, input: 500 })]));
    const events = await parsePi(root);
    expect(events.length).toBe(1);
    expect(events[0]!.costUSD).toBeUndefined();
  });

  test('a missing cost leaves costUSD unset for downstream pricing', async () => {
    const root = join(tmp, 'pi-cost-missing');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [piAssistant({ responseId: 'r1' })]));
    const events = await parsePi(root);
    expect(events[0]!.costUSD).toBeUndefined();
  });

  test('carries cacheWrite1h so the 1h premium can be priced downstream', async () => {
    const root = join(tmp, 'pi-1h');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      piSession('s1', [piAssistant({ responseId: 'r1', cacheWrite: 1000, cacheWrite1h: 700, cost: 0.2 })]),
    );
    const events = await parsePi(root);
    expect(events[0]!.tokens.cacheWrite).toBe(1000);
    expect(events[0]!.tokens.cacheWrite1h).toBe(700);
  });
});

describe('parsePi zero-usage turns', () => {
  test('skips aborted/error turns with all-zero usage and $0 cost', async () => {
    const root = join(tmp, 'pi-zero');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      piSession('s1', [
        piAssistant({ responseId: 'r1', input: 0, output: 0, cost: 0, stopReason: 'aborted' }),
        piAssistant({ responseId: 'r2', cost: 0.1 }),
      ]),
    );
    const events = await parsePi(root);
    expect(events.length).toBe(1);
    expect(events[0]!.dedupKey).toBe('pi|r2');
  });
});

describe('parsePi compaction and branch_summary usage', () => {
  const compaction = (usage?: JsonObject): string => {
    const rec: JsonObject = {
      type: 'compaction',
      id: 'c1',
      parentId: 'p1',
      timestamp: '2026-06-01T10:10:00Z',
      summary: 'earlier work…',
      tokensBefore: 50000,
    };
    if (usage) rec.usage = usage;
    return JSON.stringify(rec);
  };

  test('counts summary usage, attributed to the current provider/model', async () => {
    const root = join(tmp, 'pi-compaction');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'a.jsonl'),
      piSession('s1', [
        piAssistant({ responseId: 'r1', cost: 0.1, model: 'claude-opus-4-8' }),
        compaction({ input: 120000, output: 900, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } }),
      ]),
    );
    const events = await parsePi(root);
    expect(events.length).toBe(2);
    const summary = events[1]!;
    expect(summary.model).toBe('claude-opus-4-8');
    expect(summary.provider).toBe('anthropic');
    expect(summary.tokens.input).toBe(120000);
    expect(summary.costUSD).toBe(0.75);
  });

  test('a model_change entry retargets summary attribution', async () => {
    const root = join(tmp, 'pi-compaction-model-change');
    mkdirSync(root, { recursive: true });
    const modelChange = JSON.stringify({
      type: 'model_change',
      id: 'mc1',
      parentId: null,
      timestamp: '2026-06-01T10:09:00Z',
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k3',
    });
    writeFileSync(
      join(root, 'a.jsonl'),
      piSession('s1', [
        modelChange,
        compaction({ input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }),
      ]),
    );
    const events = await parsePi(root);
    expect(events.length).toBe(1);
    expect(events[0]!.provider).toBe('openrouter');
    expect(events[0]!.model).toBe('moonshotai/kimi-k3');
  });

  test('legacy compactions without usage still emit nothing', async () => {
    const root = join(tmp, 'pi-compaction-legacy');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), piSession('s1', [compaction()]));
    expect(await parsePi(root)).toEqual([]);
  });
});

describe('parsePi subagent runs', () => {
  const PARENT = '019fbd40-44c8-7e38-8dab-28f8f12801ee';

  test('attributes a nested run-N transcript to the parent session and tags it', async () => {
    const root = join(tmp, 'pi-subagent');
    const runDir = join(root, '--proj--', `2026-06-01T10-00-00-000Z_${PARENT}`, '5c46dd16', 'run-0');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'session.jsonl'),
      piSession('inner-session-id', [piAssistant({ responseId: 'r1', cost: 0.3 })]),
    );
    const events = await parsePi(root);
    expect(events.length).toBe(1);
    expect(events[0]!.sessionId).toBe(PARENT);
    expect(events[0]!.agent).toEqual({ id: '5c46dd16/run-0', type: 'subagent' });
  });

  test('a top-level session is not tagged', async () => {
    const root = join(tmp, 'pi-toplevel');
    mkdirSync(join(root, '--proj--'), { recursive: true });
    writeFileSync(
      join(root, '--proj--', `2026-06-01T10-00-00-000Z_${PARENT}.jsonl`),
      piSession(PARENT, [piAssistant({ responseId: 'r1', cost: 0.3 })]),
    );
    const events = await parsePi(root);
    expect(events[0]!.sessionId).toBe(PARENT);
    expect(events[0]!.agent).toBeUndefined();
  });
});
