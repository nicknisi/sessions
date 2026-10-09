// Where sessions keeps durable, non-cache state on disk.
//
// This is deliberately a neutral module rather than part of src/memory/store.ts:
// the installer (src/setup.ts) and the memory store both own things inside the data
// dir, and having the installer import a path from a feature module inverts the
// dependency and drags bun:sqlite into the setup/uninstall path. Path resolution
// living beside its consumers is the same shape as getCacheDir/getDbPath in
// src/cache.ts — this file is that, for the durable directory.

import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Home root. `SESSIONS_HOME` exists so the installer can be exercised against a temp
 * dir: src/mcp-config.ts edits real client config files (~/.codex/config.toml among
 * them), and a test that writes those for real is not a test anyone can run twice.
 */
export function getHome(): string {
  return process.env.SESSIONS_HOME || homedir();
}

/**
 * The durable data directory. Honors SESSIONS_DATA_DIR and is resolved lazily —
 * never frozen at import — for the same reason as src/cache.ts:41-45: the module
 * instance is shared across a `bun test` run, so a test that mutates the env on an
 * already-imported module must still be honored.
 */
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(getHome(), '.local', 'share', 'sessions');
}

/** The memory store. Deliberately outside the cache dir — see src/memory/store.ts. */
export function getMemoryDbPath(): string {
  return join(getDataDir(), 'memory.db');
}

/**
 * The transcript vault: an append-only, user-owned archive of session transcripts.
 * Built on getDataDir() (the ~/.local/share/sessions durable-data convention that
 * `sessions uninstall` leaves alone) so it inherits SESSIONS_DATA_DIR, with
 * SESSIONS_ARCHIVE_DIR as the direct override. Resolved lazily — never frozen at
 * import — for the same test-hermeticity reason as getDataDir above.
 */
export function getArchiveDir(): string {
  return process.env.SESSIONS_ARCHIVE_DIR || join(getDataDir(), 'archive');
}

/**
 * Where Pi keeps its session transcripts. Shared, with getPiExtraDirs below, by the
 * index (src/cache.ts), the no-index scanner (src/scanner.ts), the usage report
 * (src/report/extract.ts), and preview, so all of them look at the same trees.
 *
 * Order:
 *   1. SESSIONS_PI_DIR — this project's own override (tests, unusual setups);
 *   2. PI_CODING_AGENT_SESSION_DIR — Pi's documented session-storage override;
 *   3. PI_CODING_AGENT_DIR — Pi's config-dir override (sessions live under it);
 *   4. ~/.pi/agent/sessions — Pi's default.
 * Resolved lazily (never frozen at import) for the same test-hermeticity reason
 * as getDataDir above.
 */
export function getPiSessionsDir(): string {
  if (process.env.SESSIONS_PI_DIR) return process.env.SESSIONS_PI_DIR;
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/** Transcripts in an extra Pi folder: directly inside it, or one project folder down.
 *  Two patterns, not one `{a,b}` brace glob: Bun.Glob's scan matches nothing for those. */
export const PI_EXTRA_GLOBS = ['*.jsonl', '*/*.jsonl'];

// Extra folders of Pi-format transcripts — tools that run Pi with their own session
// dir, e.g. Riker's workers (`~/.riker/jobs/*/session`). SESSIONS_PI_EXTRA_DIRS is a
// PATH-style list; a leading `~` is the home dir and `*` / `?` glob within a segment.
// Only existing directories come back — a missing folder or a glob that matches
// nothing is skipped silently. Unset means none: Pi's own dir alone, as before.
// Resolved lazily, like everything above.
export function getPiExtraDirs(): string[] {
  const dirs = new Set<string>();
  for (const raw of (process.env.SESSIONS_PI_EXTRA_DIRS ?? '').split(delimiter)) {
    const entry = raw.trim();
    if (!entry) continue;
    const path = entry === '~' || entry.startsWith('~/') ? join(getHome(), entry.slice(1)) : entry;
    for (const dir of expandDirGlob(path)) dirs.add(dir);
  }
  return [...dirs];
}

/** `path` itself, or every directory its glob matches, in sorted order. */
function expandDirGlob(path: string): string[] {
  const segments = path.split('/');
  const first = segments.findIndex((s) => /[*?]/.test(s));
  if (first < 0) return isDir(path) ? [path] : [];
  const base = segments.slice(0, first).join('/') || '/';
  try {
    const glob = new Bun.Glob(segments.slice(first).join('/'));
    return [...glob.scanSync({ cwd: base, onlyFiles: false })]
      .map((p) => join(base, p))
      .filter(isDir)
      .sort();
  } catch {
    return []; // base folder missing or unreadable
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
