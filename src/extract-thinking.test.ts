import { test, expect } from 'bun:test';
import { extractThinking } from './extract-thinking';

const j = (o: unknown): string => JSON.stringify(o);

test('claude: collects thinking block text', () => {
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'consider memoization' },
          { type: 'text', text: 'done' },
        ],
      },
    }),
  ];
  expect(extractThinking(lines, 'claude')).toBe('consider memoization');
});

test('pi: collects thinking from assistant content', () => {
  const lines = [
    j({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pi reasoning' }] } }),
  ];
  expect(extractThinking(lines, 'pi')).toBe('pi reasoning');
});

test('codex: reasoning is encrypted, returns empty', () => {
  const lines = [j({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'xxxx' } })];
  expect(extractThinking(lines, 'codex')).toBe('');
});
