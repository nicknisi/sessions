import { readFileSync, statSync } from 'node:fs';
import { type Tool } from './types';
import { isOpencodePath, readOpencodeSession, opencodeStat } from './opencode';
import { getArchiveDir, getManifestPath, loadManifest, type Manifest, type VaultEntry } from './vault/archive';

// Generic session IO: every consumer (indexer, scanner, digest, MCP) reads a
// session as JSONL-style `lines[]` through here. JSONL tools read their file
// directly; OpenCode sessions — synthetic dbPath/sessionId paths with no real
// file — are reconstructed from the SQLite DB by src/opencode.ts.
//
// When a session's live source is gone (vendor GC, a deleted DB row), the read
// falls back to the transcript vault (src/vault/archive.ts): every parseable
// transcript was copied there on index, so identity, search, and message reads keep
// working under the original file_path. Reads try the live source first and only
// consult the vault when the original is missing.

// Lazy, process-lifetime cache of the vault manifest, invalidated when the manifest
// file's mtime changes. A concurrent refresh's vault write bumps that mtime, so a
// long-lived reader (the MCP server) re-reads it rather than declaring a path missing
// off a stale copy. Absent manifest → null cache and no vault fallback.
let _manifestCache: { mtimeMs: number; manifest: Manifest } | null = null;

function vaultEntry(filePath: string): VaultEntry | null {
  const manifestPath = getManifestPath(getArchiveDir());
  let mtimeMs: number;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    _manifestCache = null;
    return null;
  }
  if (!_manifestCache || _manifestCache.mtimeMs !== mtimeMs) {
    _manifestCache = { mtimeMs, manifest: loadManifest(getArchiveDir()) };
  }
  const entry = _manifestCache.manifest[filePath];
  return entry ?? null;
}

/**
 * Read any session into `lines[]`. `tool` is optional: when omitted (call sites
 * that only carry a file_path, e.g. the MCP tools) OpenCode is detected from the
 * path shape. Falls back to the vault copy when the live source is gone.
 */
export function readSessionLines(filePath: string, tool?: Tool): string[] {
  if (tool === 'opencode' || (tool === undefined && isOpencodePath(filePath))) {
    const lines = readOpencodeSession(filePath);
    if (lines.length > 0) return lines;
    // DB row (or the whole DB) is gone — fall back to the vault export below.
  } else {
    try {
      return readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    } catch {
      // Live source missing — fall back to the vault copy below.
    }
  }
  const entry = vaultEntry(filePath);
  if (entry) {
    try {
      return readFileSync(entry.vaultPath, 'utf-8').trimEnd().split('\n');
    } catch {}
  }
  return [];
}

/** Cache-invalidation signal for a session: filesystem stat for JSONL tools, DB metadata for OpenCode. */
export function statSession(filePath: string, tool: Tool): { mtimeMs: number; size: number } | null {
  if (tool === 'opencode') {
    const s = opencodeStat(filePath);
    if (s) return s;
  } else {
    try {
      const s = statSync(filePath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      // Live source missing — fall back to the vault copy below.
    }
  }
  const entry = vaultEntry(filePath);
  if (entry) {
    try {
      const s = statSync(entry.vaultPath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {}
  }
  return null;
}
