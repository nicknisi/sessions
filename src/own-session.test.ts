import { test, expect } from 'bun:test';
import { identifyOwnSession, type Caller, type OwnCandidate } from './own-session';

const start = Date.parse('2026-06-01T10:00:05Z');
const caller = (over: Partial<Caller> = {}): Caller => ({ env: {}, serverStart: start, cwd: '/r', ...over });
const live = (id: string, over: Partial<OwnCandidate> = {}): OwnCandidate => ({
  tool: 'codex',
  session_id: id,
  cwd: '/r',
  started_at: '2026-06-01T10:00:00Z',
  ended_at: '2026-06-01T10:05:00Z',
  ...over,
});

test('Claude Code env id wins, and is trusted when the client is unnamed', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'abc' };
  expect(identifyOwnSession(caller({ client: 'claude-code', env }), () => [])).toEqual({
    tool: 'claude',
    sessionId: 'abc',
  });
  expect(identifyOwnSession(caller({ env }), () => [])).toEqual({ tool: 'claude', sessionId: 'abc' });
});

test('an inherited Claude env id is ignored when another client calls', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'abc' };
  expect(identifyOwnSession(caller({ client: 'opencode', env }), () => [])).toBeNull();
});

test('fallback: the one live session of the caller tool in the server cwd', () => {
  expect(identifyOwnSession(caller({ client: 'codex-mcp-client' }), () => [live('x')])).toEqual({
    tool: 'codex',
    sessionId: 'x',
  });
});

test('fallback hides nothing when ambiguous, stale, elsewhere, or another tool', () => {
  const c = caller({ client: 'codex-mcp-client' });
  expect(identifyOwnSession(c, () => [live('x'), live('y')])).toBeNull();
  expect(identifyOwnSession(c, () => [live('x', { started_at: '2026-06-01T09:00:00Z' })])).toBeNull();
  // Opened an hour after the server: someone else's, e.g. while the caller resumed an older session.
  const later = { started_at: '2026-06-01T11:00:00Z', ended_at: '2026-06-01T11:05:00Z' };
  expect(identifyOwnSession(c, () => [live('x', later)])).toBeNull();
  expect(identifyOwnSession(c, () => [live('x', { ended_at: '2026-06-01T10:00:01Z' })])).toBeNull();
  expect(identifyOwnSession(c, () => [live('x', { cwd: '/elsewhere' })])).toBeNull();
  expect(identifyOwnSession(c, () => [live('x', { tool: 'claude' })])).toBeNull();
  expect(identifyOwnSession(caller({ client: 'mystery' }), () => [live('x')])).toBeNull();
});
