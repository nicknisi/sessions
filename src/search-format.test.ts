// src/search-format.test.ts
import { describe, test, expect } from 'bun:test';
import { buildResumeCommand, formatResult, MAX_COMMANDS, MAX_FILES } from './search-format';
import { formatLine } from './display';
import type { SessionResult } from './types';

test('buildResumeCommand: claude resumes, pi/codex cd only', () => {
  expect(buildResumeCommand('claude', '/r', 'abc')).toBe('cd "/r" && claude --resume abc');
  expect(buildResumeCommand('pi', '/r', 'abc')).toBe('cd "/r"');
  expect(buildResumeCommand('codex', '/r', 'abc')).toBe('cd "/r"');
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
    branches: 0,
    forkedFrom: '',
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
    fileCount: 1,
    commands: ['bun test'],
    commandCount: 1,
    errored: true,
    exists: true,
    filePath: '/f.jsonl',
    resumeCommand: 'cd "/r" && claude --resume abc',
    branches: 0,
    forkedFrom: '',
  });
});

// ——— message-granularity (schema v7) tests — additive ———

const baseResult: SessionResult = {
  date: '2026-06-01',
  createdAt: '2026-06-01',
  cwd: '/r',
  tool: 'claude',
  sessionId: 'abc',
  displayText: 'the mangowurzel fix',
  customTitle: '',
  messageCount: 5,
  filePath: '/f.jsonl',
  exists: true,
  files: [],
  commands: [],
  errored: false,
  branches: 0,
  forkedFrom: '',
};

test('formatResult: passes messageHits through when present (indexed search path)', () => {
  const hits = [{ index: 4, role: 'assistant' as const, snippet: 'the mangowurzel fix' }];
  const out = formatResult({ ...baseResult, messageHits: hits });
  expect(out.messageHits).toEqual(hits);
});

test('formatResult: omits messageHits when the source result has none (scanner fallback)', () => {
  expect('messageHits' in formatResult(baseResult)).toBe(false);
});

test('formatLine: renders the top message hit index as a msg# badge beside the snippet', () => {
  const line = formatLine(
    { ...baseResult, messageHits: [{ index: 4, role: 'assistant', snippet: 'the mangowurzel fix' }] },
    120,
  );
  expect(line).toContain('msg#4');
  expect(line).toContain('the mangowurzel fix');
});

test('formatLine: no msg# badge when there are no message hits', () => {
  expect(formatLine({ ...baseResult, messageHits: [] }, 120)).not.toContain('msg#');
  expect(formatLine(baseResult, 120)).not.toContain('msg#');
});

// ——— payload diet (phase 1) tests — additive ———

/**
 * A worst-case indexed session sized from the measured distribution: 100 commands
 * (one ~4,200-char outlier, the rest ~96), 40 file paths, and the full 3 messageHits.
 *
 * The outlier sits at index 50 on purpose. It is exactly the payload MAX_COMMANDS has
 * to drop, and parking it at index 0 would let a *capped* payload keep it — which would
 * quietly weaken the budget test below.
 */
function worstCaseSession(i: number): SessionResult {
  const commands = Array.from({ length: 100 }, (_, n) =>
    n === 50
      ? `bun run scripts/migrate.ts ${'--table sessions_v7_backfill_chunk '.repeat(120)}`
      : `bun test src/module-${n}.test.ts --coverage --reporter=verbose --timeout 30000 --bail=1 # run ${i}-${n}`,
  );
  const files = Array.from({ length: 40 }, (_, n) => `/Users/dev/work/app-${i}/src/feature-${n}/index.ts`);
  return {
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    cwd: `/Users/dev/work/app-${i}`,
    tool: 'claude',
    sessionId: `session-${i}`,
    displayText: `refactored the retry pipeline and backfilled the ${i}th chunk of the sessions table`,
    customTitle: `chunk ${i} backfill`,
    messageCount: 240,
    filePath: `/Users/dev/.claude/projects/-Users-dev-work-app-${i}/session-${i}.jsonl`,
    exists: true,
    files,
    commands,
    errored: false,
    branches: 0,
    forkedFrom: '',
    messageHits: Array.from({ length: 3 }, (_, n) => ({
      index: n * 7,
      role: n % 2 === 0 ? ('assistant' as const) : ('user' as const),
      snippet: `hit ${n}: the retry pipeline backfill needed the chunk boundary recomputed before the migration could run`,
    })),
  };
}

// ~15k tokens. Measured on this fixture: 339,234 chars with uncapped arrays, 38,444 with
// the caps — so the ceiling is red on unpatched formatResult and green after, with ~21,500
// chars of headroom for future fields.
const BUDGET_CHARS = 60_000;

/**
 * The uncapped fixture must stay far enough over the ceiling that the budget assertion
 * cannot pass for the wrong reason. Without this, shrinking worstCaseSession until the
 * ceiling is unreachable turns the budget test green while removing all of its meaning —
 * the "vacuous pass" failure mode. Asserted on the raw SessionResult array, which
 * formatResult has not touched, so it is a property of the fixture rather than of the caps.
 */
const UNCAPPED_FLOOR = 300_000;

test('budget: 20 worst-case results stay under the ceiling', () => {
  const results = Array.from({ length: 20 }, (_, i) => worstCaseSession(i));
  // Guard first: a fixture that no longer blows the budget cannot prove the caps work.
  expect(JSON.stringify(results).length).toBeGreaterThan(UNCAPPED_FLOOR);
  // The enveloped shape is what search_sessions actually ships, so measure that.
  const formatted = results.map(formatResult);
  const payload = JSON.stringify({ results: formatted, count: formatted.length });
  expect(payload.length).toBeLessThan(BUDGET_CHARS);
});

describe('caps', () => {
  test('far over the cap: arrays truncate and the counts report the true totals', () => {
    const out = formatResult(worstCaseSession(0));
    expect(out.commands).toHaveLength(MAX_COMMANDS);
    expect(out.commandCount).toBe(100);
    expect(out.files).toHaveLength(MAX_FILES);
    expect(out.fileCount).toBe(40);
    // Truncation keeps the head of the array — the dropped outlier lived at index 50.
    expect(out.commands[0]).toContain('module-0.test.ts');
    expect(out.commands.join('')).not.toContain('sessions_v7_backfill_chunk');
  });

  test('exactly at the cap: nothing is dropped and the counts equal the lengths', () => {
    const commands = Array.from({ length: MAX_COMMANDS }, (_, n) => `cmd ${n}`);
    const files = Array.from({ length: MAX_FILES }, (_, n) => `/r/f${n}.ts`);
    const out = formatResult({ ...baseResult, commands, files });
    expect(out.commands).toEqual(commands);
    expect(out.commandCount).toBe(MAX_COMMANDS);
    expect(out.files).toEqual(files);
    expect(out.fileCount).toBe(MAX_FILES);
  });

  test('empty arrays stay empty arrays with zero counts, never undefined', () => {
    const out = formatResult({ ...baseResult, commands: [], files: [] });
    expect(out.commands).toEqual([]);
    expect(out.commandCount).toBe(0);
    expect(out.files).toEqual([]);
    expect(out.fileCount).toBe(0);
    // The counts are emitted unconditionally: a field that appears only when truncation
    // happened is harder for a schema to describe and for a model to rely on.
    expect(JSON.stringify(out)).toContain('"commandCount":0');
  });
});
