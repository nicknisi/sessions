import { describe, test, expect } from 'bun:test';
import {
  customTitle,
  firstTimestamp,
  messageCount,
  firstPrompt,
  getSessionMessages,
  lastTimestamp,
  contentMatches,
  findMatchContext,
  getCwdFromSession,
  sessionBranch,
} from './parser';

function jsonl(...objs: Record<string, unknown>[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

describe('customTitle', () => {
  test('returns empty string when no custom-title row exists', () => {
    const lines = jsonl({ type: 'user', message: { content: 'hello' } });
    expect(customTitle(lines)).toBe('');
  });

  test('returns the title from a custom-title row', () => {
    const lines = jsonl(
      { type: 'user', message: { content: 'hello' }, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'custom-title', customTitle: 'My Session', sessionId: 'abc', timestamp: '2026-01-01T00:01:00Z' },
    );
    expect(customTitle(lines)).toBe('My Session');
  });

  test('uses the last custom-title if renamed multiple times', () => {
    const lines = jsonl(
      { type: 'custom-title', customTitle: 'First Name' },
      { type: 'custom-title', customTitle: 'Second Name' },
      { type: 'custom-title', customTitle: 'Final Name' },
    );
    expect(customTitle(lines)).toBe('Final Name');
  });
});

describe('firstTimestamp', () => {
  test('returns the first timestamp found', () => {
    const lines = jsonl(
      { type: 'user', timestamp: '2026-03-15T10:00:00Z' },
      { type: 'assistant', timestamp: '2026-03-15T10:01:00Z' },
    );
    expect(firstTimestamp(lines)).toBe('2026-03-15');
  });

  test('returns ? when no timestamp exists', () => {
    const lines = jsonl({ type: 'user', message: { content: 'hi' } });
    expect(firstTimestamp(lines)).toBe('?');
  });

  test('skips non-date timestamps', () => {
    const lines = jsonl({ type: 'user', timestamp: 'not-a-date' }, { type: 'user', timestamp: '2026-05-01T12:00:00Z' });
    expect(firstTimestamp(lines)).toBe('2026-05-01');
  });
});

describe('messageCount', () => {
  test('counts user and assistant messages', () => {
    const lines = jsonl(
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { content: 'hello' } },
      { type: 'user', message: { role: 'user', content: 'bye' } },
      { type: 'assistant', message: { content: 'goodbye' } },
    );
    expect(messageCount(lines)).toBe(4);
  });

  test('ignores system and other row types', () => {
    const lines = jsonl(
      { type: 'system' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'custom-title', customTitle: 'test' },
      { type: 'tag', tag: 'v1' },
    );
    expect(messageCount(lines)).toBe(1);
  });

  test('counts pi/codex style message rows', () => {
    const lines = jsonl(
      { type: 'message', message: { role: 'user', content: 'q' } },
      { type: 'message', message: { role: 'assistant', content: 'a' } },
    );
    expect(messageCount(lines)).toBe(2);
  });

  test('returns 0 for empty lines', () => {
    expect(messageCount([])).toBe(0);
  });
});

describe('firstPrompt', () => {
  test('extracts first user prompt for claude sessions', () => {
    const lines = jsonl(
      { type: 'system', cwd: '/tmp' },
      { type: 'user', message: { content: [{ type: 'text', text: 'Refactor auth middleware' }] } },
    );
    expect(firstPrompt(lines, 'claude')).toBe('Refactor auth middleware');
  });

  test('strips system-reminder tags from prompt', () => {
    const lines = jsonl({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Do the thing <system-reminder>ignore this</system-reminder>' }] },
    });
    expect(firstPrompt(lines, 'claude')).toBe('Do the thing');
  });

  test('extracts first user prompt for pi sessions', () => {
    const lines = jsonl(
      { type: 'session', cwd: '/tmp' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Help me debug' }] } },
    );
    expect(firstPrompt(lines, 'pi')).toBe('Help me debug');
  });

  test('extracts first user prompt for codex sessions', () => {
    const lines = jsonl(
      { type: 'session_meta', payload: { cwd: '/tmp' } },
      { type: 'message', message: { role: 'user', content: [{ type: 'input_text', text: 'Add tests' }] } },
    );
    expect(firstPrompt(lines, 'codex')).toBe('Add tests');
  });

  test('truncates long prompts to 100 chars', () => {
    const longText = 'A'.repeat(200);
    const lines = jsonl({ type: 'user', message: { content: [{ type: 'text', text: longText }] } });
    expect(firstPrompt(lines, 'claude').length).toBeLessThanOrEqual(100);
  });

  test('returns empty for no user messages', () => {
    const lines = jsonl({ type: 'system', cwd: '/tmp' });
    expect(firstPrompt(lines, 'claude')).toBe('');
  });
});

describe('lastTimestamp', () => {
  test('returns the last timestamp from content', () => {
    const content = [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T12:00:00Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-02T08:00:00Z' }),
    ].join('\n');
    expect(lastTimestamp(content)).toBe('2026-01-02');
  });

  test('returns ? for no timestamps', () => {
    const content = JSON.stringify({ type: 'user' });
    expect(lastTimestamp(content)).toBe('?');
  });
});

describe('getCwdFromSession', () => {
  test('extracts cwd from claude session', () => {
    const lines = jsonl({ type: 'user', cwd: '/Users/me/project' });
    expect(getCwdFromSession(lines, 'claude')).toBe('/Users/me/project');
  });

  test('extracts cwd from pi session', () => {
    const lines = jsonl({ type: 'session', cwd: '/Users/me/project' });
    expect(getCwdFromSession(lines, 'pi')).toBe('/Users/me/project');
  });

  test('extracts cwd from codex session', () => {
    const lines = jsonl({ type: 'session_meta', payload: { cwd: '/Users/me/project' } });
    expect(getCwdFromSession(lines, 'codex')).toBe('/Users/me/project');
  });

  test('returns empty string when no cwd found', () => {
    const lines = jsonl({ type: 'user', message: { content: 'hi' } });
    expect(getCwdFromSession(lines, 'claude')).toBe('');
  });
});

describe('getSessionMessages', () => {
  test('extracts user and assistant messages in order', () => {
    const lines = jsonl(
      { type: 'user', message: { content: [{ type: 'text', text: 'What is 2+2?' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The answer is 4.' }] } },
    );
    const msgs = getSessionMessages(lines);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.text).toContain('2+2');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.text).toContain('4');
  });

  test('skips rows with empty text', () => {
    const lines = jsonl(
      { type: 'user', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'real question' }] } },
    );
    const msgs = getSessionMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('real question');
  });

  test('handles pi/codex message format', () => {
    const lines = jsonl(
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'message', message: { role: 'assistant', content: 'hi there' } },
    );
    const msgs = getSessionMessages(lines);
    expect(msgs).toHaveLength(2);
  });
});

describe('contentMatches', () => {
  test('matches case-insensitively in user messages', () => {
    const lines = jsonl({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the Authentication bug' }] } });
    expect(contentMatches(lines, 'authentication')).toBe(true);
  });

  test('does not match assistant messages', () => {
    const lines = jsonl({ type: 'assistant', message: { content: [{ type: 'text', text: 'authentication fixed' }] } });
    expect(contentMatches(lines, 'authentication')).toBe(false);
  });

  test('returns false when no match', () => {
    const lines = jsonl({ type: 'user', message: { content: [{ type: 'text', text: 'hello world' }] } });
    expect(contentMatches(lines, 'foobar')).toBe(false);
  });
});

describe('findMatchContext', () => {
  test('returns snippet around match', () => {
    const lines = jsonl({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Please fix the authentication middleware in the server' }] },
    });
    const ctx = findMatchContext(lines, 'authentication');
    expect(ctx).toContain('authentication');
  });

  test('returns empty string when no match', () => {
    const lines = jsonl({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(findMatchContext(lines, 'nonexistent')).toBe('');
  });
});

describe('sessionBranch', () => {
  test('claude: returns the last non-empty gitBranch (where the session ended)', () => {
    const lines = jsonl(
      { type: 'user', gitBranch: 'main', message: { content: 'a' } },
      { type: 'assistant', gitBranch: 'main', message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'user', gitBranch: 'report-redesign', message: { content: 'c' } },
    );
    expect(sessionBranch(lines, 'claude')).toBe('report-redesign');
  });

  test('claude: empty when no line carries gitBranch', () => {
    const lines = jsonl({ type: 'user', message: { content: 'a' } });
    expect(sessionBranch(lines, 'claude')).toBe('');
  });

  test('codex: reads session_meta.payload.git.branch', () => {
    const lines = jsonl({ type: 'session_meta', payload: { cwd: '/tmp', git: { branch: 'feature/x' } } });
    expect(sessionBranch(lines, 'codex')).toBe('feature/x');
  });

  test('pi: always empty (no git metadata)', () => {
    const lines = jsonl({ type: 'session', cwd: '/tmp' });
    expect(sessionBranch(lines, 'pi')).toBe('');
  });
});
