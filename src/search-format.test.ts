// src/search-format.test.ts
import { test, expect } from 'bun:test';
import { buildResumeCommand, formatResult } from './search-format';
import type { SessionResult } from './types';

test('buildResumeCommand: claude resumes, pi/codex cd only', () => {
  expect(buildResumeCommand('claude', '/r', 'abc')).toBe('cd /r && claude --resume abc');
  expect(buildResumeCommand('pi', '/r', 'abc')).toBe('cd /r');
  expect(buildResumeCommand('codex', '/r', 'abc')).toBe('cd /r');
});

test('formatResult: shapes a SessionResult for callers, including resumeCommand', () => {
  const r: SessionResult = {
    date: '2026-06-01',
    createdAt: '2026-06-01',
    cwd: '/r',
    tool: 'claude',
    sessionId: 'abc',
    displayText: 'snip',
    customTitle: 'Title',
    messageCount: 5,
    filePath: '/f.jsonl',
    exists: true,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
  };
  expect(formatResult(r)).toEqual({
    sessionId: 'abc',
    tool: 'claude',
    date: '2026-06-01',
    createdAt: '2026-06-01',
    project: '/r',
    title: 'Title',
    snippet: 'snip',
    messageCount: 5,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
    exists: true,
    filePath: '/f.jsonl',
    resumeCommand: 'cd /r && claude --resume abc',
  });
});
