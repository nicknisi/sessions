// Where sessions keeps durable, non-cache state on disk.
//
// This is deliberately a neutral module rather than part of src/memory/store.ts:
// the installer (src/setup.ts) and the memory store both own things inside the data
// dir, and having the installer import a path from a feature module inverts the
// dependency and drags bun:sqlite into the setup/uninstall path. Path resolution
// living beside its consumers is the same shape as getCacheDir/getDbPath in
// src/cache.ts — this file is that, for the durable directory.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';

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
 * Where Pi keeps its own session transcripts. Session consumers (index, scanner,
 * report, preview) go through getPiSessionRoots below, which adds Riker's job dirs;
 * this single-dir form stays for src/memory/sources.ts, which derives Pi's config
 * siblings from it.
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

/**
 * Riker's home: the coding-worker supervisor keeps one dir per job under `jobs/` and
 * its job table in `jobs.db`. Order: SESSIONS_RIKER_DIR (this project's override, the
 * same shape as SESSIONS_PI_DIR beating Pi's own vars) → RIKER_HOME (Riker's own) →
 * ~/.riker. Built on getHome() so SESSIONS_HOME sandboxes it; resolved lazily like
 * everything above.
 */
export function getRikerHome(): string {
  return process.env.SESSIONS_RIKER_DIR || process.env.RIKER_HOME || join(getHome(), '.riker');
}

/** Riker sessions are indexed by default; SESSIONS_RIKER=0 turns discovery off. */
export function rikerEnabled(): boolean {
  return process.env.SESSIONS_RIKER !== '0';
}

/** The job number when `filePath` is a Riker worker transcript (`<rikerHome>/jobs/<n>/session/*.jsonl`), else 0. */
export function rikerJobFromPath(filePath: string): number {
  const jobs = join(getRikerHome(), 'jobs') + '/';
  if (!filePath.startsWith(jobs)) return 0;
  const m = /^(\d+)\/session\/[^/]+\.jsonl$/.exec(filePath.slice(jobs.length));
  return m ? Number(m[1]) : 0;
}

/**
 * One directory of Pi-format session transcripts. `pi` is Pi's own tree (one slug
 * dir per project, transcripts inside); `riker` is one Riker job's flat `session/` dir.
 */
export interface PiSessionRoot {
  dir: string;
  origin: 'pi' | 'riker';
}

/**
 * Every place Pi-format transcripts live: Pi's own tree plus, unless SESSIONS_RIKER=0,
 * each Riker job's `session/` dir. Only `session/` — a job dir's `log.jsonl` and
 * `proof/` are Riker's own records, not transcripts. The one resolver behind the index,
 * the no-index scanner, the usage report, and preview, so all four see the same set.
 * (Riker's brain views under `<rikerHome>/sessions` are rebuilt copies and stay out.)
 */
export function getPiSessionRoots(): PiSessionRoot[] {
  const roots: PiSessionRoot[] = [{ dir: getPiSessionsDir(), origin: 'pi' }];
  if (!rikerEnabled()) return roots;
  const jobs = join(getRikerHome(), 'jobs');
  let ids: string[];
  try {
    ids = readdirSync(jobs);
  } catch {
    return roots; // no Riker here
  }
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    const dir = join(jobs, id, 'session');
    if (existsSync(dir)) roots.push({ dir, origin: 'riker' });
  }
  return roots;
}
