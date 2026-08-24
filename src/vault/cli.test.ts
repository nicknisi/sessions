import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFile, saveManifest, type Manifest } from './archive';
import { statusReport, inspectReport } from './cli';

let tmp: string;
let dir: string;
let livePath: string;
let gonePath: string;

function writeSource(name: string, content: string): string {
  const sdir = join(tmp, 'src');
  mkdirSync(sdir, { recursive: true });
  const path = join(sdir, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-vault-cli-'));
  dir = join(tmp, 'archive');

  const manifest: Manifest = {};
  livePath = writeSource('live.jsonl', 'live-bytes');
  gonePath = writeSource('gone.jsonl', 'gone-bytes');
  archiveFile(
    { path: livePath, tool: 'claude' },
    { cwd: '/repo/live', sessionId: 'liveid' },
    { mtime: 1, size: 10 },
    manifest,
    dir,
  );
  archiveFile(
    { path: gonePath, tool: 'pi' },
    { cwd: '/repo/gone', sessionId: 'goneid' },
    { mtime: 2, size: 10 },
    manifest,
    dir,
  );
  saveManifest(dir, manifest);

  // Make the second session vault-only by deleting its live source.
  rmSync(gonePath);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('statusReport', () => {
  test('empty vault reports zero sessions', () => {
    const report = statusReport(join(tmp, 'empty'));
    expect(report).toContain('0 archived sessions');
    expect(report).toContain('vault-only (source gone): 0');
  });

  test('counts per tool, total bytes, and vault-only sessions', () => {
    const report = statusReport(dir);
    expect(report).toContain('2 archived sessions');
    expect(report).toContain('claude: 1');
    expect(report).toContain('pi: 1');
    // One source was deleted → exactly one vault-only session.
    expect(report).toContain('vault-only (source gone): 1');
  });
});

describe('inspectReport', () => {
  test('finds a session by its original path and reports live + archived', () => {
    const { text, found } = inspectReport(dir, livePath);
    expect(found).toBe(true);
    expect(text).toContain('sessionId:  liveid');
    expect(text).toContain('cwd:        /repo/live');
    expect(text).toContain('live + archived');
  });

  test('finds a session by its session id and reports source gone', () => {
    const { text, found } = inspectReport(dir, 'goneid');
    expect(found).toBe(true);
    expect(text).toContain('path:       ' + gonePath);
    expect(text).toContain('archived (source gone)');
  });

  test('an unknown target is not found (drives a non-zero exit)', () => {
    const { text, found } = inspectReport(dir, 'no-such-id');
    expect(found).toBe(false);
    expect(text).toContain('no archived session');
  });
});
