import { readFileSync, statSync } from 'node:fs';
import { type Tool } from './types';
import { isOpencodePath, readOpencodeSession, opencodeStat } from './opencode';

// Generic session IO: every consumer (indexer, scanner, digest, MCP) reads a
// session as JSONL-style `lines[]` through here. JSONL tools read their file
// directly; OpenCode sessions — synthetic dbPath/sessionId paths with no real
// file — are reconstructed from the SQLite DB by src/opencode.ts.

/**
 * Read any session into `lines[]`. `tool` is optional: when omitted (call sites
 * that only carry a file_path, e.g. the MCP tools) OpenCode is detected from the
 * path shape.
 */
export function readSessionLines(filePath: string, tool?: Tool): string[] {
  if (tool === 'opencode' || (tool === undefined && isOpencodePath(filePath))) {
    return readOpencodeSession(filePath);
  }
  try {
    return readFileSync(filePath, 'utf-8').trimEnd().split('\n');
  } catch {
    return [];
  }
}

/** Cache-invalidation signal for a session: filesystem stat for JSONL tools, DB metadata for OpenCode. */
export function statSession(filePath: string, tool: Tool): { mtimeMs: number; size: number } | null {
  if (tool === 'opencode') return opencodeStat(filePath);
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
