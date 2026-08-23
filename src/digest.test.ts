import { describe, test, expect } from 'bun:test';
import { extractMessages } from './parser';
import { buildSessionDigest, renderDigestMarkdown, DIGEST_MAX_CHARS, USER_MAX, ASSISTANT_MAX } from './digest';
import type { JsonObject } from './extract-util';

function jsonl(...objs: JsonObject[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

/** A genuine (typed) user turn. */
function user(text: string): JsonObject {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, promptSource: 'typed' };
}

/** An injected user-role turn (skill body / system-injected): present promptSource, not typed. */
function injected(text: string): JsonObject {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, promptSource: null };
}

function assistant(text: string): JsonObject {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

describe('buildSessionDigest grouping', () => {
  test('pairs a user turn with its assistant reply', () => {
    const digest = buildSessionDigest(jsonl(user('fix the login bug'), assistant('done, patched auth.ts')));
    expect(digest.messageCount).toBe(2);
    expect(digest.exchangeCount).toBe(1);
    expect(digest.elided).toBe(0);
    expect(digest.exchanges).toEqual([{ index: 0, user: 'fix the login bug', assistant: 'done, patched auth.ts' }]);
  });

  test('injected turn between question and answer does not split the exchange', () => {
    const digest = buildSessionDigest(
      jsonl(
        user('what does the parser do?'),
        injected('Base directory for this skill: /skills/foo'),
        assistant('let me look'),
        assistant('it extracts messages from JSONL'),
      ),
    );
    expect(digest.exchangeCount).toBe(1);
    expect(digest.exchanges[0]).toEqual({
      index: 0,
      user: 'what does the parser do?',
      assistant: 'it extracts messages from JSONL',
    });
  });

  test('last assistant before the next genuine turn wins; injected turns never appear', () => {
    const digest = buildSessionDigest(
      jsonl(
        user('first task'),
        assistant('narration'),
        assistant('first outcome'),
        user('second task'),
        injected('tool noise'),
        assistant('second outcome'),
      ),
    );
    expect(digest.exchangeCount).toBe(2);
    expect(digest.exchanges[0]!.assistant).toBe('first outcome');
    expect(digest.exchanges[1]!.user).toBe('second task');
    expect(digest.exchanges[1]!.assistant).toBe('second outcome');
    const texts = JSON.stringify(digest);
    expect(texts).not.toContain('tool noise');
  });

  test('assistant messages before the first genuine turn belong to no exchange', () => {
    const digest = buildSessionDigest(jsonl(assistant('session preamble'), user('real question'), assistant('answer')));
    expect(digest.exchangeCount).toBe(1);
    expect(digest.exchanges[0]!.user).toBe('real question');
    expect(digest.exchanges[0]!.assistant).toBe('answer');
  });

  test('session ending mid-exchange yields an empty assistant', () => {
    const digest = buildSessionDigest(jsonl(user('done?'), assistant('yes'), user('one more thing')));
    expect(digest.exchangeCount).toBe(2);
    expect(digest.exchanges[1]).toEqual({ index: 2, user: 'one more thing', assistant: '' });
  });

  test('exchange indices are valid extractMessages offsets', () => {
    const lines = jsonl(
      injected('hook context'),
      user('alpha'),
      assistant('a1'),
      injected('skill body'),
      user('beta'),
      assistant('b1'),
    );
    const digest = buildSessionDigest(lines);
    const messages = extractMessages(lines);
    for (const ex of digest.exchanges) {
      const m = messages.find((x) => x.index === ex.index);
      expect(m).toBeDefined();
      expect(m!.role).toBe('user');
      expect(m!.genuine).toBe(true);
      expect(ex.user.startsWith(m!.text.slice(0, 20))).toBe(true);
    }
  });

  test('strips insight fences from assistant text but keeps the body', () => {
    const digest = buildSessionDigest(
      jsonl(user('explain'), assistant('★ Insight ─────\nthe body survives\n─────────────\ntrailing text')),
    );
    expect(digest.exchanges[0]!.assistant).toContain('the body survives');
    expect(digest.exchanges[0]!.assistant).toContain('trailing text');
    expect(digest.exchanges[0]!.assistant).not.toContain('★');
  });
});

describe('buildSessionDigest degenerate sessions', () => {
  test('zero genuine turns → empty exchanges, no throw', () => {
    const digest = buildSessionDigest(jsonl(injected('hook one'), injected('hook two'), assistant('unowned')));
    expect(digest.exchangeCount).toBe(0);
    expect(digest.exchanges).toEqual([]);
    expect(digest.elided).toBe(0);
    expect(digest.messageCount).toBe(3);
  });

  test('empty input → valid empty digest', () => {
    const digest = buildSessionDigest([]);
    expect(digest).toEqual({ messageCount: 0, exchangeCount: 0, exchanges: [], elided: 0 });
  });

  test('unparseable lines are skipped, not fatal', () => {
    const lines = ['not json {{{', ...jsonl(user('still works'), assistant('yep'))];
    const digest = buildSessionDigest(lines);
    expect(digest.exchangeCount).toBe(1);
    expect(digest.exchanges[0]!.user).toBe('still works');
  });
});

describe('buildSessionDigest truncation and budget', () => {
  test('giant single message is clipped to field max, not blowing the budget', () => {
    const digest = buildSessionDigest(jsonl(user('x'.repeat(10_000)), assistant('y '.repeat(5_000))));
    expect(digest.exchanges[0]!.user.length).toBeLessThanOrEqual(USER_MAX);
    expect(digest.exchanges[0]!.assistant.length).toBeLessThanOrEqual(ASSISTANT_MAX);
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  test('truncation cuts at a word boundary with an ellipsis', () => {
    const words = 'word '.repeat(200).trim();
    const digest = buildSessionDigest(jsonl(user(words), assistant(words)));
    expect(digest.exchanges[0]!.user.endsWith('…')).toBe(true);
    expect(digest.exchanges[0]!.user).not.toMatch(/wor…$/); // no mid-word cut
  });

  const sessionOf = (messages: number): string[] => {
    const rows: JsonObject[] = [];
    for (let i = 0; rows.length < messages; i++) {
      rows.push(user(`turn ${i}: ${'question detail '.repeat(8)}`));
      if (rows.length < messages) rows.push(assistant(`answer ${i}: ${'outcome detail '.repeat(12)}`));
    }
    return jsonl(...rows);
  };

  for (const size of [10, 100, 600]) {
    test(`${size}-message session serializes within budget, keeping first and last genuine turns`, () => {
      const lines = sessionOf(size);
      const digest = buildSessionDigest(lines);
      expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
      expect(digest.messageCount).toBe(size);
      expect(digest.exchanges[0]!.user).toContain('turn 0:');
      const lastTurn = Math.ceil(size / 2) - 1;
      expect(digest.exchanges[digest.exchanges.length - 1]!.user).toContain(`turn ${lastTurn}:`);
      if (size === 600) expect(digest.elided).toBeGreaterThan(0);
    });
  }

  test('elided + exchanges.length always equals exchangeCount', () => {
    const digest = buildSessionDigest(sessionOf(600));
    expect(digest.elided + digest.exchanges.length).toBe(digest.exchangeCount);
  });
});

describe('renderDigestMarkdown', () => {
  test('renders one block per exchange with the message index', () => {
    const digest = buildSessionDigest(jsonl(user('do it'), assistant('did it')));
    const md = renderDigestMarkdown(digest, 'abc.jsonl');
    expect(md).toContain('# Session digest: abc.jsonl');
    expect(md).toContain('**[0] user:** do it');
    expect(md).toContain('**assistant:** did it');
    expect(md).not.toContain('elided');
  });

  test('places an elision marker between head and tail', () => {
    const rows: JsonObject[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(user(`turn ${i}: ${'question detail '.repeat(8)}`));
      rows.push(assistant(`answer ${i}: ${'outcome detail '.repeat(12)}`));
    }
    const digest = buildSessionDigest(jsonl(...rows));
    expect(digest.elided).toBeGreaterThan(0);
    const md = renderDigestMarkdown(digest, 'big.jsonl');
    expect(md).toContain(`… ${digest.elided} exchanges elided …`);
    // Marker sits strictly between the first and last exchanges.
    const marker = md.indexOf('exchanges elided');
    expect(marker).toBeGreaterThan(md.indexOf('turn 0:'));
    expect(marker).toBeLessThan(md.indexOf('turn 299:'));
  });

  test('explains itself for sessions with no genuine turns', () => {
    const digest = buildSessionDigest(jsonl(injected('hook only')));
    const md = renderDigestMarkdown(digest, 'hooky.jsonl');
    expect(md).toContain('No genuine user turns');
  });
});
