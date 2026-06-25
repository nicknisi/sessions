import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCode } from './parsers/claude-code.ts';
import { parseCodex } from './parsers/codex.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-parsers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function claudeLine(opts: { id?: string; requestId?: string; input?: number }): string {
  const message: Record<string, unknown> = {
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: opts.input ?? 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 10000,
    },
  };
  if (opts.id !== undefined) message.id = opts.id;
  const line: Record<string, unknown> = {
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
