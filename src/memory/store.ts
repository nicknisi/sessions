// The durable memory store: a second SQLite database, deliberately NOT index.db.
//
// index.db is disposable by design — `--clear-cache` unlinks it (index.ts:17-21),
// `sessions cleanup` unlinks it (index.ts:28-34), and getDb's corruption self-heal
// deletes and rebuilds it on a user_version mismatch (src/cache.ts:216-222). Every
// one of those is safe there because the index is re-derivable from transcripts.
// Approve / reject / snooze are human judgments that no re-mine can reconstruct, so
// they live in a database this tool never deletes: a schema bump MIGRATES, and the
// installer's uninstall path is scoped to the subdirectories it created (see the
// OWNED_INSTALL_PATHS comment in src/setup.ts).

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { getDataDir, getMemoryDbPath } from '../paths';
import { unionEvidence } from './record';
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryState,
} from './types';

let _db: Database | null = null;

/**
 * Bring the store to the current schema. Unlike src/cache.ts:118-125 this never
 * drops a table: a user's rejections are unrecoverable, so a future version bump
 * adds columns here and leaves the rows alone. A database written by a NEWER
 * sessions is left untouched rather than downgraded.
 */
function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory (
      id            TEXT PRIMARY KEY,
      v             INTEGER NOT NULL,
      text          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      scope_type    TEXT NOT NULL,
      scope_key     TEXT NOT NULL DEFAULT '',
      author        TEXT NOT NULL,
      evidence      TEXT NOT NULL,
      state         TEXT NOT NULL,
      snoozed_until TEXT,
      always_on     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  // Phase 6's incremental-mine watermark (src/memory/watermark.ts).
  //
  // A whole new table needs no `PRAGMA table_info` guard and no `user_version` bump:
  // IF NOT EXISTS is already idempotent, and the column guard below exists only
  // because ALTER TABLE is not. It sits here, beside the table it is a sibling of,
  // rather than inside the version gate — every store written before this phase
  // already reports user_version = 1, so a gated CREATE would never run on them.
  //
  // `mtime` is REAL, matching src/cache.ts:129-130. The value is `stat.mtimeMs`, which
  // carries sub-millisecond precision (1785329334744.8967 on a real transcript); an
  // INTEGER column would truncate it, the `===` comparison in `changedSessions` would
  // never match, and every file would look changed forever.
  db.run(`
    CREATE TABLE IF NOT EXISTS mine_watermark (
      file_path TEXT PRIMARY KEY,
      mtime     REAL NOT NULL,
      size      INTEGER NOT NULL,
      mined_at  TEXT NOT NULL
    )
  `);

  // Phase 5's additive column, for a table that already exists.
  //
  // The guard is `PRAGMA table_info`, NOT the `user_version` gate below, and that is
  // load-bearing rather than belt-and-braces. Every store written by Phase 1 already
  // reports user_version = 1, so an ALTER placed inside `if (current < VERSION)` would
  // run on fresh databases only — and every listMemories() against an existing store
  // would then fail with `no such column: always_on`. Asking the table what columns it
  // has is the only question whose answer does not depend on a version number that was
  // stamped before the column existed. It also makes repeat opens (and
  // src/memory/durability.test.ts's user_version = 0 reopen, which runs against a table
  // that ALREADY has the column) a no-op instead of `duplicate column name`.
  //
  // MEMORY_SCHEMA_VERSION deliberately stays 1: it is stamped into every record
  // (src/memory/record.ts:101) and is a z.literal in the wire schema
  // (src/memory/portable.ts:120,134), so bumping it would make every Phase 4 bundle
  // unimportable in exchange for nothing — the column is additive with a default, so
  // old and new rows read identically.
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(memory)').all();
  if (!columns.some((c) => c.name === 'always_on')) {
    db.run('ALTER TABLE memory ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0');
  }
  // Cluster write-back's column, added the same additive way and for the same reason:
  // a store written before merging existed reports user_version = 1 already, so a
  // version-gated ALTER would never reach it. Nullable with no default — a row that
  // was never merged has no canonical, and '' would be a second way to spell null.
  if (!columns.some((c) => c.name === 'merged_into')) {
    db.run('ALTER TABLE memory ADD COLUMN merged_into TEXT');
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_memory_state ON memory(state)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope_type, scope_key)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_always_on ON memory(always_on)');

  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  const current = row?.user_version ?? 0;
  if (current < MEMORY_SCHEMA_VERSION) {
    // v0 -> v1 is "the table did not exist", which CREATE TABLE IF NOT EXISTS above
    // already handled. Future bumps add their ALTER TABLE steps here, guarded on
    // `current` — but prefer the table_info shape above for a plain column add, for
    // the reason spelled out there.
    db.run(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
  }
}

/** Idempotent; creates the data dir if absent. Never deletes on schema mismatch. */
export function getMemoryDb(): Database {
  if (_db) return _db;
  mkdirSync(getDataDir(), { recursive: true });
  const db = new Database(getMemoryDbPath());
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');
  migrate(db);
  _db = db;
  return _db;
}

/**
 * Close and drop the cached connection so the next getMemoryDb() reopens against
 * the current getMemoryDbPath(). Mirrors closeDb() (src/cache.ts:94-105): idempotent,
 * never throws, and the seam a hermetic test uses to release the handle before it
 * deletes its temp dir.
 */
export function closeMemoryDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
}

interface MemoryRow {
  id: string;
  v: number;
  text: string;
  kind: string;
  scope_type: string;
  scope_key: string;
  author: string;
  evidence: string;
  state: string;
  snoozed_until: string | null;
  always_on: number;
  merged_into: string | null;
}

const EMPTY_EVIDENCE: MemoryEvidence = { distinctPhrasings: 0, sessions: [], firstSeen: '', lastSeen: '' };

/**
 * Read one stored evidence blob.
 *
 * A record whose evidence is unreadable is still a record the user triaged: degrade the
 * evidence, never drop the row. Field-by-field rather than a cast, because the cast is a
 * lie the type system cannot check — `JSON.parse` happily returns a number or null for a
 * hand-edited column, and `unionEvidence` would then throw on `.sessions` while merging.
 */
// Field-degrading on purpose: a hand-edited column loses only the field that
// fails to parse, not the whole blob. (zod numbers are finite by default.)
const evidenceSchema = z.object({
  distinctPhrasings: z.number().catch(0),
  sessions: z.array(z.string()).catch([]),
  firstSeen: z.string().catch(''),
  lastSeen: z.string().catch(''),
});

function parseEvidence(raw: string): MemoryEvidence {
  try {
    return evidenceSchema.parse(JSON.parse(raw));
  } catch {
    return EMPTY_EVIDENCE;
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const evidence = parseEvidence(row.evidence);
  // SAFETY: kind/scope_type/state are written only by upsertMemory from
  // already-typed MemoryRecord fields, so the columns hold the union members.
  return {
    v: row.v,
    id: row.id,
    text: row.text,
    kind: row.kind as MemoryKind,
    scope: { type: row.scope_type as MemoryScope['type'], key: row.scope_key },
    author: row.author,
    evidence,
    state: row.state as MemoryState,
    snoozedUntil: row.snoozed_until,
    // `=== 1`, never a bare truthy cast: SQLite hands back a number, and leaking a
    // number into a `boolean` field would serialize as 0/1 and break the byte-identical
    // JSON comparisons the determinism criterion rests on.
    alwaysOn: row.always_on === 1,
    // `?? null` rather than the raw value: a store migrated before this column existed
    // hands back undefined, and undefined would vanish from JSON.stringify while null
    // survives — the determinism comparisons are byte-for-byte over serialized records.
    mergedInto: row.merged_into ?? null,
  };
}

/**
 * Insert new candidates and refresh the evidence of ones already stored.
 *
 * `state`, `snoozed_until`, and `always_on` are deliberately absent from the ON CONFLICT
 * update, and so are the two scope columns: a re-mine sees the same corrective turns
 * forever, so overwriting state would resurrect every rejected candidate and the user
 * would re-triage it on every run. `always_on` is the same hazard one level worse —
 * `buildRecord` defaults it to false (src/memory/record.ts:110), so including it here
 * would silently clear a standing constraint on the next `memory mine`, which is
 * exactly the invisible-suppression failure the flag exists to prevent. Scope columns
 * are excluded for the third variant: `deriveScope` only ever produces repo/workflow,
 * so a triage-assigned `group` scope would be reverted by the next mine.
 *
 * `evidence` IS updated, but as a union with what is already stored — never a replace.
 * A mine builds each record from the transcripts it happened to read, which is one
 * phrasing from one session, so writing that blob wholesale would walk a canonical
 * record's clustered evidence back down to a single phrasing the next time anything
 * re-mines: `mergeInto`'s `distinctPhrasings` (the only value `shouldResurface` can ever
 * compare against) and every session path the cluster contributed. `--since-last` makes
 * the same loss reachable without any merge at all. See `unionEvidence`
 * (src/memory/record.ts) for the monotonicity rules; `updateEvidence` remains the
 * deliberate replace path, and is the only one.
 */
export function upsertCandidates(records: MemoryRecord[]): void {
  if (records.length === 0) return;
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const stmt = db.query(`
    INSERT INTO memory (id, v, text, kind, scope_type, scope_key, author, evidence, state, snoozed_until, always_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence, updated_at = excluded.updated_at
  `);
  // Read inside the transaction, not before it: BEGIN IMMEDIATE takes the write lock up
  // front, so a concurrent mine cannot land an evidence write between this SELECT and the
  // upsert that unions against it.
  const priorStmt = db.query<{ evidence: string }, [string]>('SELECT evidence FROM memory WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of records) {
      const prior = priorStmt.get(r.id);
      const evidence = prior ? unionEvidence(parseEvidence(prior.evidence), r.evidence) : r.evidence;
      stmt.run(
        r.id,
        r.v,
        r.text,
        r.kind,
        r.scope.type,
        r.scope.key,
        r.author,
        JSON.stringify(evidence),
        r.state,
        r.snoozedUntil,
        r.alwaysOn ? 1 : 0,
        now,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface MemoryFilter {
  state?: MemoryState;
  scope?: MemoryScope;
}

/** Stored memory, ordered by id so callers get a stable batch without re-sorting. */
export function listMemories(filter: MemoryFilter = {}): MemoryRecord[] {
  const db = getMemoryDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.state) {
    conditions.push('state = ?');
    params.push(filter.state);
  }
  if (filter.scope) {
    conditions.push('scope_type = ?');
    params.push(filter.scope.type);
    conditions.push('scope_key = ?');
    params.push(filter.scope.key);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .query<MemoryRow, any[]>(
      // Explicit column list, not SELECT * — a column forgotten here arrives as
      // `undefined` at runtime and typecheck says nothing.
      `SELECT id, v, text, kind, scope_type, scope_key, author, evidence, state, snoozed_until, always_on, merged_into
       FROM memory ${where} ORDER BY id`,
    )
    .all(...params);
  return rows.map(rowToRecord);
}

export interface PersistedState {
  state: MemoryState;
  snoozedUntil: string | null;
}

/**
 * Persisted triage state for the given ids; ids with no stored row are absent.
 *
 * The store — not a fresh mine — is the authority on state. `mine()` builds records
 * from transcripts, so every record it returns says `candidate`; emitting that
 * straight to stdout would re-present an already-rejected memory to the triage
 * consumer on every run. `upsertCandidates` protects the table (state is excluded
 * from the ON CONFLICT update); this is what protects the pipe.
 *
 * Ids are chunked because SQLite caps host parameters per statement (999 by default).
 */
export function getPersistedStates(ids: string[]): Map<string, PersistedState> {
  const out = new Map<string, PersistedState>();
  if (ids.length === 0) return out;
  const db = getMemoryDb();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string; state: string; snoozed_until: string | null }, string[]>(
        `SELECT id, state, snoozed_until FROM memory WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk);
    for (const row of rows) {
      // SAFETY: the state column is written only from MemoryState values by this store.
      out.set(row.id, { state: row.state as MemoryState, snoozedUntil: row.snoozed_until });
    }
  }
  return out;
}

/** Record a triage decision. `snoozedUntil` is cleared unless explicitly supplied. */
/**
 * Replace a record's evidence blob.
 *
 * Separate from `upsertCandidates` on purpose: that path refreshes evidence from a
 * fresh mine, which is always a single phrasing. This one writes evidence the agent
 * assembled by clustering paraphrases, and it is the only way `distinctPhrasings`
 * ever exceeds 1 — the thing `shouldResurface` compares against.
 */
export function updateEvidence(id: string, evidence: MemoryEvidence): void {
  const db = getMemoryDb();
  db.run('UPDATE memory SET evidence = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(evidence),
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Mark a record as absorbed into `canonicalId`.
 *
 * `snoozed_until` is cleared: a merged row is not suppressed-for-30-days, it is
 * represented elsewhere, and leaving a stale expiry on it would make the row look
 * like a snooze to any future reader of the column.
 */
export function setMerged(id: string, canonicalId: string): void {
  const db = getMemoryDb();
  db.run('UPDATE memory SET state = ?, merged_into = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?', [
    'merged',
    canonicalId,
    new Date().toISOString(),
    id,
  ]);
}

export function setState(id: string, state: MemoryState, snoozedUntil: string | null = null): void {
  const db = getMemoryDb();
  db.run('UPDATE memory SET state = ?, snoozed_until = ?, updated_at = ? WHERE id = ?', [
    state,
    snoozedUntil,
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Mark a memory as bypassing topic matching.
 *
 * A sibling of `setState` rather than a parameter on it, because the two are
 * independent axes: `--always-on` on a re-approval must not have to restate the state,
 * and a state change must not be able to clear the flag by omission. Same bare-UPDATE
 * caveat — the caller checks `isKnownMemory` first (src/memory/cli.ts).
 */
export function setAlwaysOn(id: string, alwaysOn: boolean): void {
  const db = getMemoryDb();
  db.run('UPDATE memory SET always_on = ?, updated_at = ? WHERE id = ?', [
    alwaysOn ? 1 : 0,
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Overwrite a memory's scope. The one write that contradicts a derived value.
 *
 * Phase 1 derives repo-vs-workflow from how far a paraphrase cluster spread, and that
 * derivation is correct for the two tiers it can see. It cannot see a group: "these
 * four repos share a convention" is not a fact about spread, so a human assigns it at
 * triage and this is where that assignment lands. `upsertCandidates` deliberately does
 * not touch the scope columns, so the next `memory mine` leaves it alone.
 */
export function setScope(id: string, scope: MemoryScope): void {
  const db = getMemoryDb();
  db.run('UPDATE memory SET scope_type = ?, scope_key = ?, updated_at = ? WHERE id = ?', [
    scope.type,
    scope.key,
    new Date().toISOString(),
    id,
  ]);
}
