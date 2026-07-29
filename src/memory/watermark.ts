// The incremental-mine watermark: a per-file record of what the last mine saw.
//
// The naive design stores one wall-clock timestamp and mines sessions newer than it.
// That is wrong here, and silently so: transcripts are APPENDED to after they are
// first indexed, so a session you started last month and resumed today still carries
// last month's `created_at`. A timestamp watermark would skip it forever and every
// durable fact in the resumed half would be lost.
//
// src/cache.ts already solved exactly this problem for the index itself: a file is
// unchanged only when BOTH its mtime and its size match what was recorded
// (src/cache.ts:327-333, and the batched form at :476-477). Reusing that pair means
// the index and the mine agree about what "changed" means, rather than holding two
// different opinions that drift.
//
// The watermark is GLOBAL, keyed by file path, while `memory mine` is scoped by
// default. The two meet in one place worth knowing about: `/weekly-summary` runs
// `memory mine --all --since-last` (plugin/skills/weekly-summary/SKILL.md), which
// examines every repo and therefore advances every repo's rows. A `--since-last` run
// inside a single repo afterwards correctly reports nothing changed — the material was
// already mined into the same store, so nothing is lost, but a reader who expects the
// watermark to be per-invocation will read it as a bug. It is not; the scoping rule is
// only "never advance a file the mine did not look at" (see `advanceWatermark`).
//
// The table lives in memory.db, not index.db: the index is disposable by design
// (--clear-cache unlinks it), and a watermark that vanished with it would re-emit the
// entire backfill on the next incremental run. Nothing prunes rows for transcripts
// that have since been deleted — that is deliberate, not a leak. `changedSessions`
// only ever reads paths that are in the CURRENT index inventory, so an orphan row is
// inert; the alternative, a delete pass joined against another database, would buy
// nothing but a second failure mode.

import { getMemoryDb } from './store';

export interface WatermarkEntry {
  filePath: string;
  /** stat.mtimeMs at last mine. A float — see the REAL column note in store.ts's migrate(). */
  mtime: number;
  /** stat.size at last mine. */
  size: number;
}

/**
 * Whole watermark inventory in one query, keyed by file path.
 *
 * One `SELECT` rather than one per candidate file, following the optimization
 * src/cache.ts:434-437 documents: the path it replaced issued a statement per
 * discovered file (~4,500 on the author's corpus) even when nothing had changed.
 */
export function readWatermark(): Map<string, WatermarkEntry> {
  const db = getMemoryDb();
  const rows = db
    .query<{ file_path: string; mtime: number; size: number }, []>(
      // Explicit column list, not SELECT * — `mined_at` is provenance for a human
      // reading the table with sqlite3 and has no reader in code.
      'SELECT file_path, mtime, size FROM mine_watermark',
    )
    .all();
  return new Map(rows.map((row) => [row.file_path, { filePath: row.file_path, mtime: row.mtime, size: row.size }]));
}

/**
 * Session file paths that are new or changed since the last mine.
 *
 * A file is unchanged only when BOTH mtime and size match — either half differing
 * means changed, exactly as src/cache.ts:476-477 decides it. A missing watermark row
 * means never mined, so it is changed by definition; that is what makes the first
 * `--since-last` run equivalent to a full backfill on a fresh install.
 *
 * Pure and total over its two inputs: no database, no clock, no throw on empty. That
 * is what lets the four-cell mtime/size matrix be exhausted in a unit test instead of
 * through a fixture corpus.
 *
 * The result is sorted. The caller binds it into a chunked `IN (...)`, and an
 * unstable order would vary the chunk boundaries run to run — which is a new way for
 * the "mining twice yields byte-identical output" property to fail.
 */
export function changedSessions(
  indexed: { filePath: string; mtime: number; size: number }[],
  watermark: Map<string, WatermarkEntry>,
): string[] {
  const changed: string[] = [];
  for (const entry of indexed) {
    const seen = watermark.get(entry.filePath);
    if (seen && seen.mtime === entry.mtime && seen.size === entry.size) continue;
    changed.push(entry.filePath);
  }
  return changed.sort();
}

/**
 * Advance the watermark. Call only AFTER candidates are persisted.
 *
 * If the mine crashes between the scan and the upsert, an already-advanced watermark
 * would mark that material as seen and it would never be mined again — silently and
 * unrecoverably. The ordering is mine -> upsert -> advance, enforced in
 * src/memory/cli.ts's `persistMine`.
 *
 * Pass only the entries that were actually IN SCOPE for this mine. `memory mine`
 * defaults to the current repo, so advancing the whole index inventory would mark
 * every changed session in every other repo as seen without ever examining it — the
 * same class of loss as advancing too early, and just as unrecoverable.
 *
 * `mined_at` is a clock read, which every other function under src/memory/ takes as
 * an argument. It is excepted here for the same reason `updated_at` is in store.ts:
 * it is row provenance for a human, never an input to a decision, so injecting it
 * would thread a date through three call sites to serve nothing.
 */
export function advanceWatermark(entries: WatermarkEntry[]): void {
  if (entries.length === 0) return;
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const stmt = db.query('INSERT OR REPLACE INTO mine_watermark (file_path, mtime, size, mined_at) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries) stmt.run(entry.filePath, entry.mtime, entry.size, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
