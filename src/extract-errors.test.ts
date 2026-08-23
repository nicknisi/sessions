import { test, expect } from 'bun:test';
import { extractErrors } from './extract-errors';
import type { JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

test('claude: tool_result is_error flags an errored session', () => {
  const lines = [
    j({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'command not found' }],
      },
    }),
  ];
  const r = extractErrors(lines, 'claude');
  expect(r.errored).toBe(true);
  expect(r.count).toBe(1);
  expect(r.messages[0]).toContain('command not found');
});

test('claude: a clean session is not errored', () => {
  const lines = [
    j({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
    }),
  ];
  expect(extractErrors(lines, 'claude')).toEqual({ errored: false, count: 0, messages: [] });
});

test('codex: non-zero exit_code is an error', () => {
  const lines = [
    j({ type: 'event_msg', payload: { type: 'exec_command_end', command: 'x', exit_code: 1, stderr: 'boom' } }),
  ];
  expect(extractErrors(lines, 'codex').errored).toBe(true);
});

test('pi: toolResult isError is an error', () => {
  const lines = [
    j({
      type: 'message',
      message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'nope' }] },
    }),
  ];
  const r = extractErrors(lines, 'pi');
  expect(r.errored).toBe(true);
  expect(r.messages[0]).toContain('nope');
});

test('opencode: a tool block with state.status=error is an error', () => {
  const lines = [
    j({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool',
            tool: 'bash',
            state: { status: 'error', input: { command: 'x' }, error: 'permission denied' },
          },
          { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/ok.ts' } } },
        ],
      },
    }),
  ];
  const r = extractErrors(lines, 'opencode');
  expect(r.errored).toBe(true);
  expect(r.count).toBe(1);
  expect(r.messages[0]).toContain('permission denied');
});

test('opencode: falls back to a "<tool> error" label when state.error is absent', () => {
  const lines = [
    j({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'tool', tool: 'edit', state: { status: 'error' } }] },
    }),
  ];
  expect(extractErrors(lines, 'opencode').messages[0]).toBe('edit error');
});
