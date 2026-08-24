// The transcript vault: an append-only, user-owned archive of session transcripts.
//
// The index (src/cache.ts) is a disposable cache over mortal files — it prunes rows
// when source files vanish and drops every table on a SCHEMA_VERSION bump. Vendors
// garbage-collect transcripts on a rolling schedule (Claude Code after 30 days), so
// history is lost regardless of the index. The vault is the durable copy: during
// every refresh, each parseable transcript is copied here raw, and the vault then
// becomes a discovery source so a session whose source file is gone stays indexed,
// searchable, and readable from its vault copy under its ORIGINAL file_path.
//
// One directory per tool, one file per archived transcript, one manifest mapping the
// original file_path to its metadata. OpenCode is the one deliberate exception to
// raw-bytes: its sessions are SQLite rows with no file, so a normalized JSONL export
// (the same shape the live materializer emits) is the rawest form there is to keep.

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type Tool } from '../types';
import { getArchiveDir } from '../paths';
import { serializeOpencodeSession } from '../opencode';

export { getArchiveDir };

export interface VaultEntry {
  tool: Tool;
  cwd: string;
  sessionId: string;
  mtime: number; // source mtime at archive time
  size: number; // source size at archive time
  archivedAt: string; // ISO
  vaultPath: string; // absolute path of the copy
}

/** original file_path → its vault entry. */
export type Manifest = Record<string, VaultEntry>;

/** The manifest lives beside the per-tool copy dirs, one per vault. */
export function getManifestPath(dir: string): string {
  return join(dir, 'manifest.json');
}

/**
 * Encode an original file_path into a single vault filename: `/` → `-`, same lossy
 * trick Claude Code uses for its project dirs. The manifest stores the absolute
 * vaultPath, so nothing ever decodes this back — it only needs to be stable.
 */
function encodePath(originalPath: string): string {
  const base = originalPath.replace(/\//g, '-').replace(/^-+/, '');
  return base.endsWith('.jsonl') ? base : base + '.jsonl';
}

/**
 * Read the manifest. Missing file → {}, malformed/wrong-shape → {} — never throws,
 * same read discipline as src/memory/groups.ts. A corrupt manifest is treated as
 * empty and rebuilt by the refresh backfill pass; the vault copies themselves are
 * untouched by the manifest being unreadable.
 */
const vaultEntrySchema = z.object({
  tool: z.enum(['claude', 'pi', 'codex', 'opencode']),
  cwd: z.string(),
  sessionId: z.string(),
  mtime: z.number(),
  size: z.number(),
  archivedAt: z.string(),
  vaultPath: z.string(),
});

const manifestFileSchema = z.record(z.string(), z.unknown());

export function loadManifest(dir: string): Manifest {
  const path = getManifestPath(dir);
  if (!existsSync(path)) return {};
  let parsed: z.infer<typeof manifestFileSchema>;
  try {
    const file = manifestFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    if (!file.success) return {};
    parsed = file.data;
  } catch {
    return {};
  }
  const entries: Array<[string, VaultEntry]> = [];
  for (const [key, value] of Object.entries(parsed)) {
    const entry = vaultEntrySchema.safeParse(value);
    if (entry.success) entries.push([key, entry.data]);
  }
  return Object.fromEntries(entries);
}

/**
 * Write the manifest atomically: a full write to a sibling tmp file then a rename,
 * so a crash mid-write can never leave a half-written manifest (rename is atomic on
 * the same filesystem). There is no shared atomic-write helper in this codebase, so
 * this owns the tmp+rename itself.
 */
export function saveManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  const path = getManifestPath(dir);
  const tmp = path + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, path);
}

/**
 * Copy one transcript into the vault, mutating `manifest` in place. Returns true when
 * it wrote (or overwrote) a copy, false when it skipped an unchanged one.
 *
 * Latest-snapshot: overwrite when the stored mtime/size differ from the source's,
 * skip when identical — mirroring the index's own change detection. The manifest is
 * saved once per refresh by the caller (never per file), so this only mutates the
 * in-memory map.
 *
 * OpenCode is serialized from its DB rows; every other tool is a raw byte copy.
 * A file that is itself inside the vault is never archived (self-copy guard).
 */
export function archiveFile(
  entry: { path: string; tool: Tool },
  parsed: { cwd: string; sessionId: string },
  stat: { mtime: number; size: number },
  manifest: Manifest,
  dir: string = getArchiveDir(),
): boolean {
  if (entry.path.startsWith(dir)) return false; // never archive a vault file into itself

  const existing = manifest[entry.path];
  if (existing && existing.mtime === stat.mtime && existing.size === stat.size) return false;

  const toolDir = join(dir, entry.tool);
  const vaultPath = join(toolDir, encodePath(entry.path));
  mkdirSync(toolDir, { recursive: true });
  if (entry.tool === 'opencode') {
    writeFileSync(vaultPath, serializeOpencodeSession(entry.path));
  } else {
    copyFileSync(entry.path, vaultPath);
  }

  manifest[entry.path] = {
    tool: entry.tool,
    cwd: parsed.cwd,
    sessionId: parsed.sessionId,
    mtime: stat.mtime,
    size: stat.size,
    archivedAt: new Date().toISOString(),
    vaultPath,
  };
  return true;
}

/**
 * Manifest entries whose vault copy still exists on disk, as discovery candidates.
 * An entry whose vaultPath was deleted is skipped: with both the source and the
 * vault copy gone, the index row is genuinely prunable.
 */
export function listArchived(dir: string): Array<{ path: string; tool: Tool; vaultPath: string }> {
  const manifest = loadManifest(dir);
  const out: Array<{ path: string; tool: Tool; vaultPath: string }> = [];
  for (const [path, entry] of Object.entries(manifest)) {
    if (existsSync(entry.vaultPath)) out.push({ path, tool: entry.tool, vaultPath: entry.vaultPath });
  }
  return out;
}

/** The byte size of a vault copy, or 0 when it is unreadable (used by `vault status`). */
export function vaultFileSize(vaultPath: string): number {
  try {
    return statSync(vaultPath).size;
  } catch {
    return 0;
  }
}
