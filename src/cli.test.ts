// src/cli.test.ts
import { test, expect, describe } from 'bun:test';
import { parseArgs, toSearchOptions } from './cli';
import { formatLine, formatLineage } from './display';
import type { SessionResult } from './types';

test('parseArgs: --errored sets the flag; query and tool still parse', () => {
  const a = parseArgs(['--errored', '--tool', 'claude', 'rate limit']);
  expect(a.errored).toBe(true);
  expect(a.toolFilter).toBe('claude');
  expect(a.searchQuery).toBe('rate limit');
});

test('toSearchOptions: maps CLI args + repoRoot to a SearchOptions call', () => {
  const a = parseArgs(['--errored', '--here', 'auth']);
  const { query, opts } = toSearchOptions(a, '/repo');
  expect(query).toBe('auth');
  expect(opts.errored).toBe(true);
  expect(opts.project).toBe('/repo');
  expect(opts.tool).toBe('');
  expect(opts.limit).toBeGreaterThan(0);
});

test('parseArgs: --file is repeatable and maps through toSearchOptions', () => {
  const a = parseArgs(['--file', 'src/auth.ts', '--file', 'docs/plan.md']);
  expect(a.files).toEqual(['src/auth.ts', 'docs/plan.md']);
  const { opts } = toSearchOptions(a, '');
  expect(opts.files).toEqual(['src/auth.ts', 'docs/plan.md']);
});

// ——— fork badge / lineage (pi first-class phase 2) — additive ———

const piResult: SessionResult = {
  date: '2026-08-04',
  createdAt: '2026-08-04',
  cwd: '/repo',
  tool: 'pi',
  sessionId: 'abc',
  displayText: 'investigate the flaky tree navigation',
  customTitle: '',
  messageCount: 8,
  filePath: '/f.jsonl',
  exists: true,
  files: [],
  commands: [],
  errored: false,
  branches: 0,
  forkedFrom: '',
};

describe('formatLine fork badge', () => {
  test('branches 0: no badge', () => {
    expect(formatLine(piResult, 120)).not.toContain('⑂');
  });

  test('branches 1 and 24: badge renders the count before the prompt', () => {
    expect(formatLine({ ...piResult, branches: 1 }, 120)).toContain('⑂1');
    expect(formatLine({ ...piResult, branches: 24 }, 120)).toContain('⑂24');
  });

  test('60-col terminal: badge survives, the prompt truncates first', () => {
    const line = formatLine(
      { ...piResult, branches: 3, displayText: 'a prompt long enough to be truncated at sixty columns for sure' },
      60,
    );
    // Field 7 of the TSV is the display string (field 6 is the untruncated prompt,
    // consumed positionally by index.ts — its rawness is load-bearing). filePath
    // now leads as field 1 so fzf --preview can reference {1}.
    const display = line.split('\t')[6]!;
    expect(display).toContain('⑂3');
    expect(display).toContain('…'); // the prompt absorbed the truncation, not the badge
    expect(display).not.toContain('sixty columns for sure');
  });
});

describe('formatLineage', () => {
  test('no lineage: empty string (caller skips the line)', () => {
    expect(formatLineage(piResult)).toBe('');
  });

  test('forkedFrom: basename only, never the raw absolute path', () => {
    const line = formatLineage({
      ...piResult,
      forkedFrom: '/Users/dev/.pi/agent/sessions/--repo--/parent-file.jsonl',
    });
    expect(line).toBe('Forked from parent-file.jsonl');
    expect(line).not.toContain('/Users/dev');
  });

  test('in-file forks: singular and plural', () => {
    expect(formatLineage({ ...piResult, branches: 1 })).toBe('1 in-file fork');
    expect(formatLineage({ ...piResult, branches: 24 })).toBe('24 in-file forks');
  });

  test('both: parent then fork count', () => {
    const line = formatLineage({ ...piResult, branches: 2, forkedFrom: '/p/parent.jsonl' });
    expect(line).toBe('Forked from parent.jsonl · 2 in-file forks');
  });
});
