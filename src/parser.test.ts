import { describe, test, expect } from 'bun:test';
import {
  customTitle,
  extractMessages,
  firstTimestamp,
  messageCount,
  firstPrompt,
  getSessionMessages,
  lastTimestamp,
  contentMatches,
  findMatchContext,
  getCwdFromSession,
  sessionBranch,
  closingMessages,
  extractSessionMetadata,
  summarizeMessages,
} from './parser';
import { buildPiTree } from './pi-tree';

function jsonl(...objs: Record<string, unknown>[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

describe('extractSessionMetadata', () => {
  test('matches the individual Claude metadata helpers in one pass', () => {
    const lines = jsonl(
      {
        type: 'user',
        cwd: '/repo',
        timestamp: '2026-03-15T10:00:00Z',
        gitBranch: 'main',
        message: { content: 'hello' },
      },
      { type: 'custom-title', customTitle: 'First title', timestamp: 'not-a-date' },
      {
        type: 'assistant',
        cwd: '/repo',
        timestamp: '2026-03-17T10:00:00Z',
        gitBranch: 'feature',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      { type: 'custom-title', customTitle: 'Final title' },
    );

    expect(extractSessionMetadata(lines, 'claude')).toEqual({
      cwd: getCwdFromSession(lines, 'claude'),
      customTitle: customTitle(lines),
      date: lastTimestamp(lines),
      createdAt: firstTimestamp(lines),
      // No standalone helper to compare against: startedAt is the same instant as
      // createdAt with the time kept, and only this one-pass extractor produces it.
      startedAt: '2026-03-15T10:00:00Z',
      messageCount: messageCount(lines),
      branch: sessionBranch(lines, 'claude'),
    });
  });

  test('startedAt keeps the clock createdAt truncates away', () => {
    const lines = jsonl(
      { type: 'user', cwd: '/repo', timestamp: '2026-06-02T21:47:13.500Z', message: { content: 'late night' } },
      { type: 'assistant', cwd: '/repo', timestamp: '2026-06-03T01:02:03Z', message: { content: 'yes' } },
    );
    const meta = extractSessionMetadata(lines, 'claude');
    expect(meta.createdAt).toBe('2026-06-02');
    expect(meta.startedAt).toBe('2026-06-02T21:47:13.500Z');
  });

  test('startedAt is empty when no line carries a timestamp', () => {
    const lines = jsonl({ type: 'user', cwd: '/repo', message: { content: 'undated' } });
    expect(extractSessionMetadata(lines, 'claude').startedAt).toBe('');
  });

  test('counts Codex response_item messages, excluding developer framing', () => {
    // The counting loop had the same envelope gap extractMessages did, so every Codex
    // row indexed with message_count 0 even after its messages became extractable.
    const lines = jsonl(
      { type: 'session_meta', timestamp: '2026-04-01T09:00:00Z', payload: { cwd: '/repo' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# AGENTS.md' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    );
    // Two: the user turn and the assistant turn. Not the developer line, not the tool
    // call, and not the event_msg echo of the assistant text.
    expect(extractSessionMetadata(lines, 'codex').messageCount).toBe(2);
  });

  test('Codex message_count agrees with the number of extracted messages', () => {
    // These are separate loops over the same lines and they drifted apart before. For
    // Codex they should now report the same figure on the same input.
    const lines = jsonl(
      { type: 'session_meta', timestamp: '2026-04-01T09:00:00Z', payload: { cwd: '/repo' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] },
      },
    );
    expect(extractSessionMetadata(lines, 'codex').messageCount).toBe(extractMessages(lines).length);
  });

  test('extracts Codex cwd and starting branch from session_meta', () => {
    const lines = jsonl(
      {
        type: 'session_meta',
        timestamp: '2026-04-01T09:00:00Z',
        payload: { cwd: '/codex-repo', git: { branch: 'perf/index' } },
      },
      {
        type: 'message',
        timestamp: '2026-04-02T09:00:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
      },
    );

    expect(extractSessionMetadata(lines, 'codex')).toMatchObject({
      cwd: '/codex-repo',
      date: '2026-04-02',
      createdAt: '2026-04-01',
      messageCount: 1,
      branch: 'perf/index',
    });
  });

  // Regression guard for the one input shape where the old date helper disagreed:
  // it searched only the final 200 lines and, finding nothing dated there, fell
  // back to the FIRST timestamp — reporting a session's start as its end. Both
  // implementations must now report the last dated line regardless of tail length.
  test('reports the last dated line even when the final 200+ lines carry no timestamp', () => {
    const lines = [
      ...jsonl(
        { type: 'user', cwd: '/repo', timestamp: '2026-01-01T10:00:00Z', message: { content: 'start' } },
        { type: 'assistant', cwd: '/repo', timestamp: '2026-05-05T10:00:00Z', message: { content: 'end' } },
      ),
      ...Array.from({ length: 205 }, () => JSON.stringify({ type: 'summary', summary: 'undated tail' })),
    ];

    expect(extractSessionMetadata(lines, 'claude').date).toBe('2026-05-05');
    expect(extractSessionMetadata(lines, 'claude').date).toBe(lastTimestamp(lines));
    expect(extractSessionMetadata(lines, 'claude').createdAt).toBe(firstTimestamp(lines));
  });
});

test('summarizeMessages reuses extracted messages without changing prompt or closing semantics', () => {
  const lines = jsonl(
    {
      type: 'user',
      promptSource: 'typed',
      message: { content: '<system-reminder>noise</system-reminder> build the index' },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    {
      type: 'user',
      promptSource: null,
      message: { content: 'Base directory for this skill: /tmp/skill\ninjected body' },
    },
    { type: 'user', promptSource: 'typed', message: { content: 'is it done?' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'yes, it is done' }] } },
  );

  const summary = summarizeMessages(extractMessages(lines));
  expect(summary.firstPrompt).toBe(firstPrompt(lines, 'claude'));
  expect({ user: summary.closingUser, assistant: summary.closingAssistant }).toEqual(closingMessages(lines));
});

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
  test('returns the last timestamp from the lines', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T12:00:00Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-02T08:00:00Z' }),
    ];
    expect(lastTimestamp(lines)).toBe('2026-01-02');
  });

  test('returns ? for no timestamps', () => {
    expect(lastTimestamp([JSON.stringify({ type: 'user' })])).toBe('?');
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

describe('extractMessages', () => {
  // A typed turn, an assistant turn, a skill-injection turn (heuristic path — no
  // promptSource), a promptSource-null turn (tool-result/injected style), and a
  // closing assistant turn. Indices must be sequential over all five.
  const mixed = jsonl(
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'refactor the parser' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } },
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Base directory for this skill: /x\n\nSkill body here.' }] },
    },
    {
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: [{ type: 'text', text: 'injected tool payload' }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  );

  test('numbering parity: indices, roles, and texts match getSessionMessages element-for-element', () => {
    const extracted = extractMessages(mixed);
    const legacy = getSessionMessages(mixed);
    expect(extracted.length).toBe(legacy.length);
    for (let i = 0; i < extracted.length; i++) {
      expect(extracted[i]!.index).toBe(legacy[i]!.index);
      expect(extracted[i]!.role).toBe(legacy[i]!.role);
      expect(extracted[i]!.text).toBe(legacy[i]!.text);
    }
  });

  test('genuine flags: typed true, skill-injection and promptSource-null false, assistant always true', () => {
    expect(extractMessages(mixed).map((m) => m.genuine)).toEqual([true, true, false, false, true]);
  });

  test('non-genuine turns still consume indices (skipped-but-counted numbering)', () => {
    const msgs = extractMessages(mixed);
    expect(msgs.map((m) => m.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test('empty input yields no messages', () => {
    expect(extractMessages([])).toEqual([]);
  });

  test('single user-only session: one genuine message at index 0', () => {
    const lines = jsonl({ type: 'user', message: { content: [{ type: 'text', text: 'just this' }] } });
    const msgs = extractMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', index: 0, genuine: true });
  });

  test('non-genuine first turn still takes index 0; the real prompt gets index 1', () => {
    const lines = jsonl(
      { type: 'user', promptSource: null, message: { content: [{ type: 'text', text: 'injected opener' }] } },
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'the real ask' }] } },
    );
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => [m.index, m.genuine])).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  test('empty-text rows are excluded from numbering, matching getSessionMessages', () => {
    const lines = jsonl(
      { type: 'user', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'real question' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
    );
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => m.index)).toEqual([0, 1]);
    expect(msgs.map((m) => m.index)).toEqual(getSessionMessages(lines).map((m) => m.index));
  });

  test('compaction summaries are not genuine (auto-generated context carryover)', () => {
    const lines = jsonl({
      type: 'user',
      isCompactSummary: true,
      message: { content: [{ type: 'text', text: 'This session is being continued from a previous conversation…' }] },
    });
    const msgs = extractMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.genuine).toBe(false);
  });

  test('tag-wrapped agent/harness injections are stripped, not counted as user turns', () => {
    const lines = jsonl(
      {
        type: 'user',
        message: {
          content: [{ type: 'text', text: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }],
        },
      },
      { type: 'user', message: { content: [{ type: 'text', text: '<bash-input>git status</bash-input>' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '<bash-stdout>on branch main</bash-stdout>' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '<teammate-message>ping</teammate-message>' }] } },
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'the real ask' }] } },
    );
    const msgs = extractMessages(lines);
    // Only the genuine typed turn survives as a user message; the injections are
    // emptied by stripInjected and so never get a row.
    expect(msgs.map((m) => m.text)).toEqual(['the real ask']);
    expect(msgs[0]!.genuine).toBe(true);
  });

  test('injection tags with attributes are still stripped', () => {
    const lines = jsonl(
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '<teammate-message teammate_id="reviewer" color="blue">ping</teammate-message>' },
          ],
        },
      },
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'the real ask' }] } },
    );
    expect(extractMessages(lines).map((m) => m.text)).toEqual(['the real ask']);
  });

  test('inline injections are stripped but the human text around them survives', () => {
    const lines = jsonl({
      type: 'user',
      promptSource: 'typed',
      message: { content: [{ type: 'text', text: 'fix this <bash-stdout>err</bash-stdout> please' }] },
    });
    const msgs = extractMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text.replace(/\s+/g, ' ').trim()).toBe('fix this please');
    expect(msgs[0]!.genuine).toBe(true);
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

describe('firstPrompt genuine-turn intent', () => {
  test('skips a skill-injection first turn and returns the first real prompt', () => {
    const lines = jsonl(
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'Base directory for this skill: /x\n\n# Defuddle\nUse it.' }] },
      },
      { type: 'user', message: { content: [{ type: 'text', text: 'Refactor the parser' }] } },
    );
    expect(firstPrompt(lines, 'claude')).toBe('Refactor the parser');
  });

  test('respects promptSource: ignores a non-typed turn, takes the typed one', () => {
    const lines = jsonl(
      { type: 'user', promptSource: null, message: { content: [{ type: 'text', text: 'injected junk' }] } },
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'the real ask' }] } },
    );
    expect(firstPrompt(lines, 'claude')).toBe('the real ask');
  });
});

describe('closingMessages user side', () => {
  test('closing.user is the last genuine typed turn, not a trailing skill load', () => {
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'commit and PR it' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'PR is up: https://x/pull/16' }] } },
      {
        type: 'user',
        promptSource: null,
        message: { content: [{ type: 'text', text: 'Base directory for this skill: /y' }] },
      },
    );
    expect(closingMessages(lines).user).toBe('commit and PR it');
  });

  test('old logs (no promptSource): heuristic still drops a skill-injection turn', () => {
    const lines = jsonl(
      { type: 'user', message: { content: [{ type: 'text', text: 'fix the bug' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'Base directory for this skill: /z' }] } },
    );
    expect(closingMessages(lines).user).toBe('fix the bug');
  });
});

describe('closingMessages assistant side', () => {
  test('strips ★ Insight fence markers but keeps the body and outcome', () => {
    const assistantText = [
      'Done. Shipped it.',
      '',
      '★ Insight ─────────────────────────────────────',
      'The index is the moat.',
      '─────────────────────────────────────────────────',
    ].join('\n');
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'ship it' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } },
    );
    const a = closingMessages(lines).assistant;
    expect(a).toContain('Done. Shipped it.');
    expect(a).toContain('The index is the moat.');
    expect(a).not.toContain('★');
    expect(a).not.toMatch(/─{5,}/);
  });

  test('keeps a genuine markdown rule and a bare "Insight" line (no false-positive strip)', () => {
    const assistantText = ['Two options:', '-----', 'Insight', 'pick the first.'].join('\n');
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'advise' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } },
    );
    const a = closingMessages(lines).assistant;
    expect(a).toContain('-----'); // ASCII rule is not the box-drawing fence
    expect(a).toContain('Insight'); // bare heading, no ★ marker
    expect(a).toContain('pick the first.');
  });
});

describe('tool-call extraction (include_tools support)', () => {
  test('a pure-tool-use assistant line folds into the current turn head, no new index', () => {
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'do the thing' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } }] },
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] } },
    );
    const msgs = extractMessages(lines);
    // Two indexed messages only — the two pure-tool lines added no rows.
    expect(msgs.map((m) => m.index)).toEqual([0, 1]);
    expect(msgs[1]!.tools.map((t) => t.name)).toEqual(['Edit', 'Bash']);
    expect(msgs[1]!.tools[1]!.summary).toBe('bun test');
  });

  test('tool_use sharing a line with text attaches to that same message', () => {
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'go' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading it.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.ts' } },
          ],
        },
      },
    );
    const msgs = extractMessages(lines);
    expect(msgs[1]!.text).toContain('Reading it.');
    expect(msgs[1]!.tools).toEqual([{ name: 'Read', summary: '/x/y.ts' }]);
  });

  test('assistant tool with no prior assistant text folds into the user turn (still no new index)', () => {
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'deploy' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl apply' } }] },
      },
    );
    const msgs = extractMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.tools).toEqual([{ name: 'Bash', summary: 'kubectl apply' }]);
  });

  test('a tool_result user line does not reset the turn or absorb tools', () => {
    const lines = jsonl(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] } },
    );
    const msgs = extractMessages(lines);
    // The tool_result line produced no message; Grep folds back into the assistant turn.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.tools.map((t) => t.name)).toEqual(['Grep']);
    expect(msgs[0]!.tools[0]!.summary).toBe('TODO');
  });

  test('adding tools does not perturb the dense numbering getSessionMessages depends on', () => {
    const lines = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } },
    );
    const extracted = extractMessages(lines);
    const legacy = getSessionMessages(lines);
    expect(extracted.map((m) => m.index)).toEqual([0, 1]);
    expect(legacy.map((m) => m.index)).toEqual([0, 1]);
    expect(legacy[0]!.tools.map((t) => t.name)).toEqual(['Bash']); // folded onto the user turn
  });

  test('summary prefers command over other fields and truncates long values', () => {
    const long = 'x'.repeat(200);
    const lines = jsonl({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'run' },
          { type: 'tool_use', name: 'Bash', input: { command: long, description: 'ignored' } },
        ],
      },
    });
    const t = extractMessages(lines)[0]!.tools[0]!;
    expect(t.summary.endsWith('…')).toBe(true);
    expect(t.summary.length).toBe(121); // 120 chars + ellipsis
  });
});

// Every shape below is copied from real ~/.codex/sessions rollouts. The dispatch these
// exercise did not exist before: Codex nests messages under a `response_item` envelope,
// so all 305 rollouts on a real machine extracted to zero messages. The pre-existing
// `{type:'message', message:{…}}` tests elsewhere in this file are the PI shape, which
// occurs zero times in real Codex logs — hence the duplicate coverage rather than edits
// to those.
describe('extractMessages: Codex', () => {
  /** A Codex rollout head. Present on line 1 of all 305 real rollouts. */
  const meta = { type: 'session_meta', payload: { cwd: '/repo', git: { branch: 'main' } } };
  const userItem = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  const assistantItem = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
  /** The UI-log echo of what the human actually typed — Codex's genuineness oracle. */
  const typedEvent = (message: string) => ({ type: 'event_msg', payload: { type: 'user_message', message } });

  test('extracts user and assistant turns from the response_item envelope', () => {
    const lines = jsonl(meta, typedEvent('add a test'), userItem('add a test'), assistantItem('Done.'));
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', 'add a test'],
      ['assistant', 'Done.'],
    ]);
    expect(msgs.map((m) => m.index)).toEqual([0, 1]);
  });

  test('a user turn with a user_message twin is genuine; one without is not', () => {
    const lines = jsonl(meta, typedEvent('the real ask'), userItem('the real ask'), userItem('<user_action> tabbed'));
    expect(extractMessages(lines).map((m) => [m.text, m.genuine])).toEqual([
      ['the real ask', true],
      ['<user_action> tabbed', false],
    ]);
  });

  test('the user_message event may arrive after its twin (the join needs two passes)', () => {
    // Ordering observed in the real corpus: the UI event usually trails the model-facing
    // record, so a single forward pass would classify the turn before its oracle exists.
    const lines = jsonl(meta, userItem('ship it'), typedEvent('ship it'), assistantItem('ok'));
    expect(extractMessages(lines)[0]).toMatchObject({ text: 'ship it', genuine: true });
  });

  test('falls back to injection prefixes when the two streams never join', () => {
    // No user_message events at all — 26 of 305 real rollouts look like this. Without the
    // guard every turn would flip to genuine:false and first_prompt would go blank again.
    const lines = jsonl(meta, userItem('<environment_context> cwd=/repo'), userItem('what changed?'));
    expect(extractMessages(lines).map((m) => [m.text, m.genuine])).toEqual([
      ['<environment_context> cwd=/repo', false],
      ['what changed?', true],
    ]);
  });

  test('developer-role messages are injected framing, not turns', () => {
    const lines = jsonl(meta, {
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# AGENTS.md' }] },
    });
    expect(extractMessages(lines)).toEqual([]);
  });

  test('assistant text is read once, not doubled by its event_msg twin', () => {
    // response_item and event_msg overlap: every assistant text is duplicated in the UI
    // log. Reading both would double every Codex turn in message_fts.
    const lines = jsonl(meta, assistantItem('the answer'), {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'the answer' },
    });
    expect(extractMessages(lines).map((m) => m.text)).toEqual(['the answer']);
  });

  test('tool calls fold into the turn head and keep numbering dense', () => {
    const lines = jsonl(
      meta,
      typedEvent('fix it'),
      userItem('fix it'),
      assistantItem('Looking.'),
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"bun test"}' },
      },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' } },
    );
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => m.index)).toEqual([0, 1]);
    expect(msgs[1]!.tools).toEqual([
      { name: 'shell', summary: 'bun test' },
      { name: 'apply_patch', summary: '*** Begin Patch' },
    ]);
  });

  test('a tool call before any message buffers onto the first turn emitted', () => {
    const lines = jsonl(
      meta,
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' } },
      typedEvent('what is here?'),
      userItem('what is here?'),
    );
    const msgs = extractMessages(lines);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.tools).toEqual([{ name: 'shell', summary: 'ls' }]);
  });

  test('getSessionMessages numbering agrees with extractMessages on Codex', () => {
    const lines = jsonl(meta, typedEvent('a'), userItem('a'), assistantItem('b'), assistantItem('c'));
    expect(getSessionMessages(lines).map((m) => m.index)).toEqual(extractMessages(lines).map((m) => m.index));
  });

  test('an abandoned rollout (session_meta only) yields no messages', () => {
    // 14 of 305 real rollouts are exactly this: opened, never used.
    expect(extractMessages(jsonl(meta))).toEqual([]);
  });

  test('the sniff reads parsed types, so Claude prose about response_item is unaffected', () => {
    // This repo's own transcripts discuss the Codex envelope. Detecting on a raw substring
    // would reroute them into the Codex path and silently blank them.
    const lines = jsonl(
      {
        type: 'user',
        promptSource: 'typed',
        message: { content: [{ type: 'text', text: 'why does {"type":"response_item"} parse to nothing?' }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'session_meta is the tell.' }] } },
    );
    expect(extractMessages(lines).map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

// ——— Pi branch topology ———
// Fixture shapes mirror real ~/.pi/agent/sessions files: every line carries
// id/parentId, the session header is the root, the header-adjacent model_change has
// parentId: null, and message text lives in content arrays of {type:'text'} blocks.
const piSession = { type: 'session', id: 's1', timestamp: '2026-08-04T17:00:00.000Z', cwd: '/repo' };
const piModelChange = (id: string, parentId: string | null) => ({
  type: 'model_change',
  id,
  parentId,
  timestamp: '2026-08-04T17:00:01.000Z',
});
const piUser = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:01:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const piAssistant = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:02:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

// The canonical one-fork shape, modeled on corpus file 2026-08-04T17-05-44-093Z: a
// /tree hop back to u1 produces an abandoned exchange, then a hop back to a1 resumes
// what becomes the live conversation (two topology breaks: fork-out AND fork-back).
function oneForkLines(): string[] {
  return jsonl(
    piSession,
    piModelChange('m1', null),
    piUser('u1', 'm1', 'first question'),
    piAssistant('a1', 'u1', 'first answer'),
    piUser('u2', 'u1', 'hello world'),
    piAssistant('a2', 'u2', 'abandoned answer'),
    piUser('u3', 'a1', 'the real follow-up'),
    piAssistant('a3', 'u3', 'the live answer'),
  );
}

describe('buildPiTree', () => {
  test('returns null for Claude and Codex transcripts (no id/parentId shape)', () => {
    expect(buildPiTree(jsonl({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBeNull();
    expect(
      buildPiTree(
        jsonl(
          { type: 'session_meta', payload: { cwd: '/repo' } },
          {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
          },
        ),
      ),
    ).toBeNull();
  });

  test('unbranched pi session: every entry active, no forks', () => {
    const tree = buildPiTree(
      jsonl(piSession, piModelChange('m1', null), piUser('u1', 'm1', 'first question'), piAssistant('a1', 'u1', 'a')),
    )!;
    expect(tree).not.toBeNull();
    expect(tree.forks).toEqual([]);
    expect(tree.activeIds.size).toBe(tree.entries.length);
  });

  test('parentId: null chains to the preceding entry instead of forking', () => {
    // Every real pi file has exactly one parentId:null non-header entry — the first
    // model_change — so this convention fires on every file and must never fork.
    const tree = buildPiTree(jsonl(piSession, piModelChange('m1', null), piUser('u1', 'm1', 'hi')))!;
    expect(tree.forks).toEqual([]);
    expect(tree.activeIds.has('m1')).toBe(true);
  });

  test('one fork: the abandoned branch is excluded from the active path', () => {
    const tree = buildPiTree(oneForkLines())!;
    expect(tree.forks).toHaveLength(1);
    expect(tree.forks[0]).toMatchObject({
      fromEntryId: 'u1',
      abandonedCount: 2, // entries u2 + a2
      firstUserText: 'hello world',
      timestamp: '2026-08-04T17:01:00.000Z',
    });
    expect(tree.activeIds.has('u2')).toBe(false);
    expect(tree.activeIds.has('a2')).toBe(false);
    expect(tree.activeIds.has('a3')).toBe(true);
  });

  test('three forks rooted at different active entries', () => {
    const tree = buildPiTree(
      jsonl(
        piSession,
        piModelChange('m1', null),
        piUser('u1', 'm1', 'q1'),
        piAssistant('a1', 'u1', 'a1'),
        piUser('x1', 'u1', 'branch one'),
        piAssistant('x2', 'x1', 'branch one reply'),
        piUser('u2', 'a1', 'q2'),
        piAssistant('a2', 'u2', 'a2'),
        piUser('y1', 'a1', 'branch two'),
        piUser('z1', 'u2', 'branch three'),
        piUser('u3', 'a2', 'q3'),
        piAssistant('a3', 'u3', 'a3'),
      ),
    )!;
    expect(tree.forks).toHaveLength(3);
    expect(tree.forks.map((f) => [f.fromEntryId, f.abandonedCount, f.firstUserText])).toEqual([
      ['u1', 2, 'branch one'],
      ['a1', 1, 'branch two'],
      ['u2', 1, 'branch three'],
    ]);
    expect(tree.activeIds.has('a3')).toBe(true);
  });

  test('an abandoned branch re-entered and extended is still ONE fork', () => {
    // The 24-break corpus session's actual shape: one fork whose subtree appears as
    // disjoint runs, because /tree navigated back INTO the abandoned branch. The
    // continuation's head has an abandoned parent, so it is not a new fork.
    const tree = buildPiTree(
      jsonl(
        piSession,
        piModelChange('m1', null),
        piUser('u1', 'm1', 'q1'),
        piAssistant('a1', 'u1', 'a1'),
        piAssistant('x1', 'a1', 'abandoned 1'),
        piAssistant('x2', 'x1', 'abandoned 2'),
        piUser('u2', 'a1', 'q2'),
        piAssistant('a2', 'u2', 'a2'),
        piAssistant('x3', 'x2', 'abandoned 3'), // parent x2 is abandoned — same fork
        piUser('u3', 'a2', 'q3'),
        piAssistant('a3', 'u3', 'a3'),
      ),
    )!;
    expect(tree.forks).toHaveLength(1);
    expect(tree.forks[0]!.abandonedCount).toBe(3); // x1, x2, x3 across two disjoint runs
    expect(tree.forks[0]!.firstUserText).toBe(''); // an assistant-only branch, like the real file
  });

  test('a backlink cycle is treated as fully active, never an infinite loop', () => {
    const tree = buildPiTree(
      jsonl(
        piSession,
        piModelChange('m1', null),
        piUser('u1', 'a1', 'x'), // forward reference…
        piAssistant('a1', 'u1', 'y'), // …that closes a corrupt A↔B cycle
      ),
    )!;
    expect(tree.forks).toEqual([]);
    expect(tree.activeIds.size).toBe(tree.entries.length);
  });

  test('an unknown parentId chains to the preceding entry (defensive, not seen in corpus)', () => {
    const tree = buildPiTree(
      jsonl(piSession, piModelChange('m1', null), piUser('u1', 'm1', 'hi'), piAssistant('a1', 'gone', 'yo')),
    )!;
    expect(tree.forks).toEqual([]);
    expect(tree.activeIds.has('a1')).toBe(true);
  });
});

describe('extractMessages: pi branches', () => {
  test('unbranched pi session: no branch/fork fields at all (no-op purity)', () => {
    const lines = jsonl(
      piSession,
      piModelChange('m1', null),
      piUser('u1', 'm1', 'hi'),
      piAssistant('a1', 'u1', 'hello'),
    );
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ]);
    for (const m of msgs) {
      expect('branch' in m).toBe(false);
      expect('fork' in m).toBe(false);
    }
  });

  test('one fork: abandoned run labeled, first message carries the fork marker', () => {
    const msgs = extractMessages(oneForkLines());
    expect(msgs.map((m) => [m.role, m.text, m.branch ?? ''])).toEqual([
      ['user', 'first question', ''],
      ['assistant', 'first answer', ''],
      ['user', 'hello world', 'abandoned'],
      ['assistant', 'abandoned answer', 'abandoned'],
      ['user', 'the real follow-up', ''],
      ['assistant', 'the live answer', ''],
    ]);
    // Dense, single numbering space — abandoned messages keep their indices.
    expect(msgs.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const markers = msgs.filter((m) => m.fork);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.index).toBe(2);
    expect(markers[0]!.fork).toEqual({
      fromIndex: 0, // the fork parent u1 produced message 0
      abandonedCount: 2, // message-level: u2 + a2
      firstUserText: 'hello world',
      timestamp: '2026-08-04T17:01:00.000Z',
    });
  });

  test('fork parent is a non-message entry: fromIndex maps to the nearest preceding message', () => {
    const lines = jsonl(
      piSession,
      piModelChange('m1', null),
      piUser('u1', 'm1', 'q1'),
      piAssistant('a1', 'u1', 'a1'),
      piModelChange('m2', 'a1'), // active, but produces no message
      piUser('u2', 'm2', 'abandoned q'),
      piAssistant('a2', 'u2', 'abandoned a'),
      piUser('u3', 'm2', 'live q'),
      piAssistant('a3', 'u3', 'live a'),
    );
    const msgs = extractMessages(lines);
    const marker = msgs.find((m) => m.fork)!;
    expect(marker.index).toBe(2);
    expect(marker.fork!.fromIndex).toBe(1); // a1 — nearest active message at/before m2's line
    expect(msgs.map((m) => m.branch ?? '')).toEqual(['', '', 'abandoned', 'abandoned', '', '']);
  });

  test('one fork spanning disjoint runs gets one marker and labels every run', () => {
    // Same topology as the buildPiTree re-entry fixture: the marker lands on the
    // branch's FIRST message and abandonedCount counts messages across both runs.
    const lines = jsonl(
      piSession,
      piModelChange('m1', null),
      piUser('u1', 'm1', 'q1'),
      piAssistant('a1', 'u1', 'a1'),
      piAssistant('x1', 'a1', 'abandoned 1'),
      piAssistant('x2', 'x1', 'abandoned 2'),
      piUser('u2', 'a1', 'q2'),
      piAssistant('a2', 'u2', 'a2'),
      piAssistant('x3', 'x2', 'abandoned 3'),
      piUser('u3', 'a2', 'q3'),
      piAssistant('a3', 'u3', 'a3'),
    );
    const msgs = extractMessages(lines);
    expect(msgs.map((m) => m.branch ?? '')).toEqual(['', '', 'abandoned', 'abandoned', '', '', 'abandoned', '', '']);
    expect(msgs.filter((m) => m.fork)).toHaveLength(1);
    expect(msgs[2]!.fork!.abandonedCount).toBe(3); // x1 + x2 + x3, across the interleave
    expect(msgs[2]!.fork!.firstUserText).toBe('');
    expect(msgs.map((m) => m.index)).toEqual(msgs.map((_, i) => i)); // dense under interleaving
  });

  test('firstUserText skips injected turns and takes the first genuine one', () => {
    // Regression guard for the sessionId gap: genuineUserTurnFromLine returns null on
    // pi lines (they carry no sessionId), so the fork text must come from the shared
    // isGenuineUserTurn/extractUserText logic — or every fork would report ''.
    const lines = jsonl(
      piSession,
      piModelChange('m1', null),
      piUser('u1', 'm1', 'q1'),
      piAssistant('a1', 'u1', 'a1'),
      piUser('x1', 'a1', 'Base directory for this skill: /x\n\nskill body'),
      piUser('x2', 'x1', 'the genuine question'),
      piAssistant('x3', 'x2', 'abandoned answer'),
      piUser('u2', 'a1', 'q2'),
      piAssistant('a2', 'u2', 'a2'),
    );
    const marker = extractMessages(lines).find((m) => m.fork)!;
    expect(marker.fork!.firstUserText).toBe('the genuine question');
  });

  test('a fork whose branch holds no messages gets no marker', () => {
    // The real 2026-08-04T17-05-44 file has this: a two-entry `custom` subtree hangs
    // off the active path next to the message-bearing fork. There is no message to
    // hang a marker on, and nothing to label.
    const custom = (id: string, parentId: string) => ({
      type: 'custom',
      id,
      parentId,
      timestamp: '2026-08-04T17:03:00.000Z',
    });
    const lines = jsonl(
      piSession,
      piModelChange('m1', null),
      piUser('u1', 'm1', 'q1'),
      piAssistant('a1', 'u1', 'a1'),
      custom('c1', 'a1'), // fork head, messageless subtree
      piUser('u2', 'a1', 'q2'),
      piAssistant('a2', 'u2', 'a2'),
    );
    const msgs = extractMessages(lines);
    expect(buildPiTree(lines)!.forks).toHaveLength(1);
    expect(msgs.filter((m) => m.fork)).toHaveLength(0);
    expect(msgs.every((m) => !('branch' in m))).toBe(true);
  });

  test('getSessionMessages carries branch and fork through the projection', () => {
    const msgs = getSessionMessages(oneForkLines());
    expect(msgs[2]!.branch).toBe('abandoned');
    expect(msgs[2]!.fork).toMatchObject({ fromIndex: 0, abandonedCount: 2, firstUserText: 'hello world' });
    expect(msgs[3]!.branch).toBe('abandoned');
    expect(msgs[3]!.fork).toBeUndefined();
    expect('branch' in msgs[0]!).toBe(false);
  });
});
