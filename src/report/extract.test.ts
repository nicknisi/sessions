import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherEvents } from './extract.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
mkdirSync(join(claudeDir, 'proj'), { recursive: true });
writeFileSync(
  join(claudeDir, 'proj', 'a.jsonl'),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: '2026-06-01T14:30:00Z',
    message: {
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 10000,
      },
    },
  }) + '\n',
);

const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };

describe('gatherEvents', () => {
  test('parses claude events and skips missing tool dirs', async () => {
    const events = await gatherEvents(roots);
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.tool).toBe('claude-code');
    expect(e.provider).toBe('anthropic');
    expect(e.tokens.input).toBe(1000);
    expect(e.tokens.cacheWrite).toBe(200);
    expect(e.tokens.cacheRead).toBe(10000);
    expect(e.projectPath).toContain('sessions');
  });

  test('honors the tools filter', async () => {
    const events = await gatherEvents(roots, new Set(['pi']));
    expect(events.length).toBe(0);
  });
});
