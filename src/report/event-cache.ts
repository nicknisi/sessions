// Incremental parse cache for `sessions report`.
//
// An unbounded report reads ~2.6 GB of transcripts and JSON-parses every line, to
// produce a few hundred thousand usage events. Almost none of that changes
// between runs: a transcript is append-only and most are finished. This stores
// each file's parsed events against its (mtime, size) and re-parses only what
// moved.
//
// Deliberately its own database rather than a table in the search index: the
// index drops and rebuilds itself on a schema bump, and a search-side change has
// no business throwing away a usage parse. Its own file means its own version.
//
// Every entry point degrades rather than fails. A missing, locked, or corrupt
// cache means "parse everything", which is exactly the old behaviour — a cache
// must never be the reason a report cannot be produced.
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { getCacheDir } from '../cache.ts';
import type { UsageEvent } from './parsers/types.ts';
import type { AgentName } from './parsers/claude-code.ts';

// Bump when the stored shape changes, so an old cache is discarded rather than
// misread. v1: per-file events blob + agent-name map.
// v2: the Pi parser changed what it emits per file (dedupKeys, subagent-run
// attribution, compaction usage, zero-usage skips) — a v1 pi parse served from
// cache would silently miss all of it, so old caches are rebuilt.
const SCHEMA_VERSION = 2;

export function getEventCachePath(): string {
  return join(getCacheDir(), 'usage.db');
}

/** What one source file contributes. `agentTypes` is empty for tools without
 *  subagent dispatches. */
export interface FileParse {
  events: UsageEvent[];
  agentTypes: Record<string, AgentName>;
}

export interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

interface Row {
  path: string;
  mtime_ms: number;
  size: number;
  events: string;
  agent_types: string;
}

export function openEventCache(): Database | null {
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    const db = new Database(getEventCachePath());
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA journal_mode = WAL');
    const version = (db.query('PRAGMA user_version').get() as { user_version: number } | null)?.user_version ?? 0;
    if (version !== SCHEMA_VERSION) {
      // A shape change makes every stored blob unreadable, so there is nothing to
      // migrate — drop and let the next run refill.
      db.run('DROP TABLE IF EXISTS files');
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS files (
      path        TEXT PRIMARY KEY,
      mtime_ms    REAL NOT NULL,
      size        INTEGER NOT NULL,
      events      TEXT NOT NULL,
      agent_types TEXT NOT NULL DEFAULT '{}'
    )`);
    return db;
  } catch {
    return null;
  }
}

/** Delete the cache file. Exported for `sessions report --rebuild-cache`. */
export function clearEventCache(): boolean {
  let removed = false;
  for (const f of [getEventCachePath(), getEventCachePath() + '-wal', getEventCachePath() + '-shm']) {
    try {
      rmSync(f);
      removed = true;
    } catch {}
  }
  return removed;
}

/** stat every candidate path, dropping any that vanished mid-walk. */
export async function statAll(paths: AsyncIterable<string>): Promise<FileStat[]> {
  const out: FileStat[] = [];
  for await (const path of paths) {
    try {
      const s = await stat(path);
      out.push({ path, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // Deleted between walk and stat. Nothing to parse, nothing to cache.
    }
  }
  return out;
}

export interface CachePlan {
  /** Files whose parse is missing or out of date. */
  stale: FileStat[];
  /** Rows still valid, keyed by path. */
  fresh: Map<string, Row>;
}

/** Split the current files into "already parsed" and "needs parsing". */
export function planRefresh(db: Database, files: FileStat[]): CachePlan {
  const known = new Map<string, Row>();
  try {
    for (const r of db.query('SELECT path, mtime_ms, size, events, agent_types FROM files').all() as Row[]) {
      known.set(r.path, r);
    }
  } catch {
    // Unreadable table: treat everything as stale.
  }
  const stale: FileStat[] = [];
  const fresh = new Map<string, Row>();
  for (const f of files) {
    const row = known.get(f.path);
    // Size guards against the case mtime cannot: a rewrite within the same
    // millisecond, or a restored file carrying its original timestamp.
    if (row && row.size === f.size && Math.abs(row.mtime_ms - f.mtimeMs) < 1) fresh.set(f.path, row);
    else stale.push(f);
  }
  return { stale, fresh };
}

/** Store one file's parse. */
export function putFile(db: Database, file: FileStat, parsed: FileParse): void {
  try {
    db.run('INSERT OR REPLACE INTO files (path, mtime_ms, size, events, agent_types) VALUES (?, ?, ?, ?, ?)', [
      file.path,
      file.mtimeMs,
      file.size,
      JSON.stringify(parsed.events),
      JSON.stringify(parsed.agentTypes),
    ]);
  } catch {
    // A failed write costs a re-parse next run, nothing more.
  }
}

/**
 * Forget files that no longer exist, so a deleted project stops being reported.
 *
 * Scoped to the roots actually enumerated this run. Without that scope,
 * `report --tool claude` — which never walks the Codex tree — would conclude
 * every Codex file had vanished and evict it, and a test pointed at a temp
 * fixture would evict the user's entire real cache.
 */
export function pruneMissing(db: Database, livePaths: Set<string>, enumeratedRoots: string[]): number {
  if (enumeratedRoots.length === 0) return 0;
  try {
    const rows = db.query('SELECT path FROM files').all() as { path: string }[];
    const gone = rows
      .filter((r) => enumeratedRoots.some((root) => r.path.startsWith(root)) && !livePaths.has(r.path))
      .map((r) => r.path);
    if (gone.length === 0) return 0;
    const del = db.prepare('DELETE FROM files WHERE path = ?');
    db.transaction(() => {
      for (const p of gone) del.run(p);
    })();
    return gone.length;
  } catch {
    return 0;
  }
}

export function decodeRow(row: Row): FileParse {
  try {
    return {
      events: JSON.parse(row.events) as UsageEvent[],
      agentTypes: JSON.parse(row.agent_types) as Record<string, AgentName>,
    };
  } catch {
    return { events: [], agentTypes: {} };
  }
}
