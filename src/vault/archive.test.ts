import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  getArchiveDir,
  loadManifest,
  saveManifest,
  getManifestPath,
  archiveFile,
  listArchived,
  type Manifest,
} from './archive';
import { opencodeFilePath, serializeOpencodeSession, closeOpencodeDb } from '../opencode';
import { readSessionLines } from '../session-io';
import { getCwdFromSession, firstPrompt, customTitle } from '../parser';

const j = (o: unknown): string => JSON.stringify(o);

let tmp: string;
let dir: string;

function writeSource(name: string, content: string): string {
  const dir = join(tmp, 'src');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-vault-'));
  dir = join(tmp, 'archive');
  process.env.SESSIONS_ARCHIVE_DIR = dir;
});

afterAll(() => {
  closeOpencodeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('getArchiveDir', () => {
  test('honors SESSIONS_ARCHIVE_DIR', () => {
    expect(getArchiveDir()).toBe(dir);
  });
});

describe('manifest persistence', () => {
  test('missing manifest loads as empty', () => {
    expect(loadManifest(join(tmp, 'nope'))).toEqual({});
  });

  test('corrupt manifest loads as empty (self-heal, never throws)', () => {
    const badDir = join(tmp, 'corrupt');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(getManifestPath(badDir), '{ this is not json');
    expect(loadManifest(badDir)).toEqual({});
    // Wrong-shape-but-valid JSON is also rejected structurally.
    writeFileSync(getManifestPath(badDir), '["an","array"]');
    expect(loadManifest(badDir)).toEqual({});
  });

  test('saveManifest round-trips atomically and drops entries with the wrong shape', () => {
    const rtDir = join(tmp, 'roundtrip');
    const manifest: Manifest = {
      '/orig/a.jsonl': {
        tool: 'claude',
        cwd: '/repo',
        sessionId: 'a',
        mtime: 1,
        size: 2,
        archivedAt: '2026-01-01T00:00:00.000Z',
        vaultPath: '/v/a.jsonl',
      },
    };
    saveManifest(rtDir, manifest);
    expect(loadManifest(rtDir)).toEqual(manifest);
    // No leftover tmp file beside the manifest.
    expect(existsSync(getManifestPath(rtDir) + `.tmp-${process.pid}`)).toBe(false);
  });
});

describe('archiveFile', () => {
  test('copies raw bytes under an encoded filename and records the manifest entry', () => {
    const manifest: Manifest = {};
    const src = writeSource('one.jsonl', 'line1\nline2');
    const wrote = archiveFile(
      { path: src, tool: 'claude' },
      { cwd: '/repo', sessionId: 'one' },
      { mtime: 10, size: 11 },
      manifest,
      dir,
    );
    expect(wrote).toBe(true);
    const entry = manifest[src];
    expect(entry).toBeDefined();
    expect(entry!.tool).toBe('claude');
    expect(entry!.cwd).toBe('/repo');
    expect(entry!.sessionId).toBe('one');
    // Encoded filename: slashes → dashes, leading dash stripped, one .jsonl suffix.
    expect(basename(entry!.vaultPath)).not.toContain('/');
    expect(basename(entry!.vaultPath).endsWith('.jsonl')).toBe(true);
    expect(basename(entry!.vaultPath).endsWith('.jsonl.jsonl')).toBe(false);
    expect(readFileSync(entry!.vaultPath, 'utf-8')).toBe('line1\nline2');
  });

  test('skips an unchanged file (same mtime+size) without rewriting the copy', async () => {
    const manifest: Manifest = {};
    const src = writeSource('two.jsonl', 'body');
    archiveFile({ path: src, tool: 'pi' }, { cwd: '/r', sessionId: 'two' }, { mtime: 5, size: 4 }, manifest, dir);
    const vaultPath = manifest[src]!.vaultPath;
    const mtimeBefore = statSync(vaultPath).mtimeMs;
    await Bun.sleep(5);
    const wrote = archiveFile(
      { path: src, tool: 'pi' },
      { cwd: '/r', sessionId: 'two' },
      { mtime: 5, size: 4 },
      manifest,
      dir,
    );
    expect(wrote).toBe(false);
    expect(statSync(vaultPath).mtimeMs).toBe(mtimeBefore); // copy untouched
  });

  test('overwrites when the source grew (mtime/size changed)', () => {
    const manifest: Manifest = {};
    const src = writeSource('three.jsonl', 'old');
    archiveFile({ path: src, tool: 'pi' }, { cwd: '/r', sessionId: 'three' }, { mtime: 1, size: 3 }, manifest, dir);
    const vaultPath = manifest[src]!.vaultPath;
    writeFileSync(src, 'old and new');
    const wrote = archiveFile(
      { path: src, tool: 'pi' },
      { cwd: '/r', sessionId: 'three' },
      { mtime: 2, size: 11 },
      manifest,
      dir,
    );
    expect(wrote).toBe(true);
    expect(readFileSync(vaultPath, 'utf-8')).toBe('old and new');
  });

  test('never archives a file that is itself inside the vault (self-copy guard)', () => {
    const manifest: Manifest = {};
    const insideVault = join(dir, 'claude', 'already.jsonl');
    const wrote = archiveFile(
      { path: insideVault, tool: 'claude' },
      { cwd: '/r', sessionId: 'x' },
      { mtime: 1, size: 1 },
      manifest,
      dir,
    );
    expect(wrote).toBe(false);
    expect(manifest[insideVault]).toBeUndefined();
  });
});

describe('listArchived', () => {
  test('returns only entries whose vault copy still exists', () => {
    const ldir = join(tmp, 'list');
    const manifest: Manifest = {};
    const src = writeSource('four.jsonl', 'data');
    archiveFile({ path: src, tool: 'codex' }, { cwd: '/r', sessionId: 'four' }, { mtime: 1, size: 4 }, manifest, ldir);
    // A dangling entry whose copy was deleted must be excluded.
    manifest['/gone/x.jsonl'] = {
      tool: 'claude',
      cwd: '/r',
      sessionId: 'x',
      mtime: 1,
      size: 1,
      archivedAt: '2026-01-01T00:00:00.000Z',
      vaultPath: join(ldir, 'claude', 'does-not-exist.jsonl'),
    };
    saveManifest(ldir, manifest);
    const archived = listArchived(ldir);
    expect(archived.map((a) => a.path)).toEqual([src]);
    expect(archived[0]!.tool).toBe('codex');
  });
});

describe('opencode export round-trip', () => {
  let dbPath: string;

  beforeAll(() => {
    dbPath = join(tmp, 'opencode.db');
    const db = new Database(dbPath);
    db.run(
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)',
    );
    db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
    db.run(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)',
    );
    db.query(
      'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('ses_x', 'p', null, '/repo/oc', 'Fix the widget', 1000, 2000);
    db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
      'm1',
      'ses_x',
      1100,
      j({ role: 'user', time: { created: 1100 } }),
    );
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
      'p1',
      'm1',
      'ses_x',
      1100,
      j({ type: 'text', text: 'fix the vaultwidget please' }),
    );
    db.close();
    process.env.SESSIONS_OPENCODE_DB = dbPath;
    closeOpencodeDb();
  });

  test('serialized JSONL re-parses through the shared parser as tool opencode', () => {
    const synthetic = opencodeFilePath('ses_x');
    const exported = serializeOpencodeSession(synthetic);
    expect(exported.length).toBeGreaterThan(0);

    // Write it into a vault file and read it back the way a vault-only session would.
    const vaultFile = join(tmp, 'oc-export.jsonl');
    writeFileSync(vaultFile, exported);
    const lines = readFileSync(vaultFile, 'utf-8').trimEnd().split('\n');
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/oc');
    expect(firstPrompt(lines, 'opencode')).toBe('fix the vaultwidget please');
    expect(customTitle(lines)).toBe('Fix the widget');
  });

  test('archiveFile serializes opencode (does not copy the DB) and the copy re-parses', () => {
    const manifest: Manifest = {};
    const synthetic = opencodeFilePath('ses_x');
    const wrote = archiveFile(
      { path: synthetic, tool: 'opencode' },
      { cwd: '/repo/oc', sessionId: 'ses_x' },
      { mtime: 2000, size: 1 },
      manifest,
      dir,
    );
    expect(wrote).toBe(true);
    const lines = readSessionLines(manifest[synthetic]!.vaultPath, 'claude'); // read raw jsonl, not via DB
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/oc');
  });
});
