import { test, expect } from 'bun:test';
import { extractCommands, MAX_COMMANDS } from './extract-commands';

const j = (o: unknown): string => JSON.stringify(o);

test('claude: extracts Bash commands, ignores other tools', () => {
  const lines = [
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
    }),
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
    }),
  ];
  expect(extractCommands(lines, 'claude')).toEqual(['bun test']);
});

test('codex: dual recording (function_call + exec_command_end) yields each command once', () => {
  const lines = [
    j({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":["docker","compose","up"]}',
        call_id: 'c1',
      },
    }),
    j({ type: 'event_msg', payload: { type: 'exec_command_end', command: 'docker compose up', exit_code: 0 } }),
  ];
  expect(extractCommands(lines, 'codex')).toEqual(['docker compose up']);
});

test('pi: extracts bashExecution commands', () => {
  const lines = [
    j({
      type: 'message',
      id: '1',
      parentId: null,
      message: { role: 'bashExecution', command: 'npm run build', output: 'ok', exitCode: 0 },
    }),
  ];
  expect(extractCommands(lines, 'pi')).toEqual(['npm run build']);
});

test('dedups identical commands and caps at MAX_COMMANDS', () => {
  const dup = Array.from({ length: 3 }, () =>
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
  );
  expect(extractCommands(dup, 'claude')).toEqual(['ls']);
  const many = Array.from({ length: MAX_COMMANDS + 50 }, (_, i) =>
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `cmd${i}` } }] },
    }),
  );
  expect(extractCommands(many, 'claude').length).toBe(MAX_COMMANDS);
});
