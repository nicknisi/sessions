// src/cli.test.ts
import { test, expect } from 'bun:test';
import { parseArgs, toSearchOptions } from './cli';

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
