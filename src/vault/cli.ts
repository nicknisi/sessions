// Arg parsing and dispatch for the `vault` command group: `status` and `inspect`.
//
// Prose on stdout, progress/errors on stderr, non-zero exit on a bad invocation or an
// unknown inspect target — the same CLI contract as src/memory/cli.ts. The report
// builders (`statusReport`, `inspectReport`) are pure over an archive dir so they are
// testable without driving process.exit.

import { existsSync } from 'node:fs';
import { getArchiveDir, loadManifest, vaultFileSize, type Manifest, type VaultEntry } from './archive';
import { isOpencodePath, opencodeStat } from '../opencode';

/** A bad invocation. Thrown so parsing stays testable; `runVault` turns it into stderr + exit 1. */
export class UsageError extends Error {}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions vault — inspect the durable transcript archive

Every parseable transcript is copied into the vault on each index refresh, so a
session survives its source file being garbage-collected by the vendor. The vault
lives at ~/.local/share/sessions/archive (override: SESSIONS_ARCHIVE_DIR).

Usage:
  sessions vault status              Per-tool counts, total bytes, vault-only count
  sessions vault inspect <target>    Show one entry by original path or session id

<target> is either the original file_path of an archived session or its session id.
An unknown target exits non-zero.
`);
  process.exit(0);
}

/** Whether a session's live source still exists (not the vault copy). */
function liveSourcePresent(originalPath: string): boolean {
  if (isOpencodePath(originalPath)) return opencodeStat(originalPath) !== null;
  return existsSync(originalPath);
}

/** `status`: per-tool archived counts, total vault bytes, and how many are vault-only. */
export function statusReport(dir: string): string {
  const manifest = loadManifest(dir);
  const entries = Object.entries(manifest);

  const perTool = new Map<string, { count: number; bytes: number }>();
  let totalBytes = 0;
  let vaultOnly = 0;
  for (const [path, entry] of entries) {
    const bytes = vaultFileSize(entry.vaultPath);
    totalBytes += bytes;
    const t = perTool.get(entry.tool) ?? { count: 0, bytes: 0 };
    t.count++;
    t.bytes += bytes;
    perTool.set(entry.tool, t);
    if (!liveSourcePresent(path)) vaultOnly++;
  }

  const lines: string[] = [
    `vault: ${dir}`,
    `  ${entries.length} archived session${entries.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)} total`,
  ];
  for (const tool of [...perTool.keys()].sort()) {
    const t = perTool.get(tool)!;
    lines.push(`  ${tool}: ${t.count} (${formatBytes(t.bytes)})`);
  }
  lines.push(`  vault-only (source gone): ${vaultOnly}`);
  return lines.join('\n');
}

/** `inspect`: the manifest entry for a target plus whether it is live, archived, or both. */
export function inspectReport(dir: string, target: string): { text: string; found: boolean } {
  const manifest = loadManifest(dir);
  const match = resolveTarget(manifest, target);
  if (!match) {
    return { text: `vault: no archived session for "${target}" (not an archived path or session id)`, found: false };
  }
  const [path, entry] = match;
  const live = liveSourcePresent(path);
  const archived = existsSync(entry.vaultPath);
  const location =
    live && archived ? 'live + archived' : archived ? 'archived (source gone)' : 'source only (vault copy missing)';
  return {
    text: [
      `path:       ${path}`,
      `tool:       ${entry.tool}`,
      `sessionId:  ${entry.sessionId}`,
      `cwd:        ${entry.cwd}`,
      `mtime:      ${entry.mtime}`,
      `size:       ${entry.size}`,
      `archivedAt: ${entry.archivedAt}`,
      `vaultPath:  ${entry.vaultPath}`,
      `status:     ${location}`,
    ].join('\n'),
    found: true,
  };
}

/** Match a target against an original path first, then a session id. */
function resolveTarget(manifest: Manifest, target: string): [string, VaultEntry] | null {
  const direct = manifest[target];
  if (direct) return [target, direct];
  for (const [path, entry] of Object.entries(manifest)) {
    if (entry.sessionId === target) return [path, entry];
  }
  return null;
}

/** Bytes as a compact human string (B/KB/MB/GB). */
function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** Entry point: dispatch `status`/`inspect`, print, and exit non-zero on failure. */
export async function runVault(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') help();

  if (sub === 'status') {
    process.stdout.write(statusReport(getArchiveDir()) + '\n');
    return;
  }

  if (sub === 'inspect') {
    const target = argv[1];
    if (!target) die('inspect requires a path or session id');
    const { text, found } = inspectReport(getArchiveDir(), target);
    if (!found) {
      process.stderr.write(text + '\n');
      process.exit(1);
    }
    process.stdout.write(text + '\n');
    return;
  }

  die(`unknown vault subcommand: ${sub} (expected status or inspect)`);
}
