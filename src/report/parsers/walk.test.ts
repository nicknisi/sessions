import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkJsonl, pruneThreshold, MTIME_SLACK_MS } from './walk.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-walk-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function file(root: string, name: string, mtimeMs: number): void {
  mkdirSync(root, { recursive: true });
  const p = join(root, name);
  writeFileSync(p, '{}\n');
  const secs = mtimeMs / 1000;
  utimesSync(p, secs, secs);
}

async function collect(root: string, since?: string): Promise<string[]> {
  const out: string[] = [];
  for await (const p of walkJsonl(root, { since })) out.push(p.slice(root.length + 1));
  return out.sort();
}

const day = (ymd: string) => Date.parse(ymd + 'T12:00:00Z');

describe('pruneThreshold', () => {
  test('is the period start minus the slack window', () => {
    expect(pruneThreshold('2026-06-10')).toBe(Date.parse('2026-06-10T00:00:00Z') - MTIME_SLACK_MS);
  });

  test('no bound and an unparseable bound both mean "read everything"', () => {
    expect(pruneThreshold(undefined)).toBeUndefined();
    expect(pruneThreshold('not-a-date')).toBeUndefined();
  });
});

describe('walkJsonl mtime pruning', () => {
  test('skips files last written before the window', async () => {
    const root = join(tmp, 'prune');
    file(root, 'stale.jsonl', day('2026-01-01'));
    file(root, 'fresh.jsonl', day('2026-06-15'));
    expect(await collect(root, '2026-06-10')).toEqual(['fresh.jsonl']);
  });

  test('without a bound, nothing is skipped', async () => {
    const root = join(tmp, 'nobound');
    file(root, 'stale.jsonl', day('2026-01-01'));
    file(root, 'fresh.jsonl', day('2026-06-15'));
    expect(await collect(root)).toEqual(['fresh.jsonl', 'stale.jsonl']);
  });

  test('a file inside the slack window is kept, so clock skew cannot drop data', async () => {
    const root = join(tmp, 'slack');
    // Written a day before the period start: outside the window by date, inside
    // the slack, therefore still read.
    file(root, 'edge.jsonl', day('2026-06-09'));
    expect(await collect(root, '2026-06-10')).toEqual(['edge.jsonl']);
  });

  test('pruning reaches into nested directories', async () => {
    const root = join(tmp, 'nested');
    file(join(root, 'proj', 'sess', 'subagents'), 'agent-a1.jsonl', day('2026-01-01'));
    file(join(root, 'proj', 'sess', 'subagents'), 'agent-a2.jsonl', day('2026-06-15'));
    const got = await collect(root, '2026-06-10');
    expect(got).toEqual([join('proj', 'sess', 'subagents', 'agent-a2.jsonl')]);
  });

  test('a missing root yields nothing rather than throwing', async () => {
    expect(await collect(join(tmp, 'does-not-exist'), '2026-06-10')).toEqual([]);
  });
});
