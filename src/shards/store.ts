// The durable shard store: a second SQLite database, deliberately NOT index.db.
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
import { getDataDir, getShardsDbPath } from '../paths';
import {
  SHARD_SCHEMA_VERSION,
  type ShardEvidence,
  type ShardKind,
  type ShardRecord,
  type ShardScope,
  type ShardState,
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
    CREATE TABLE IF NOT EXISTS shards (
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

  // Phase 5's additive column, for a table that already exists.
  //
  // The guard is `PRAGMA table_info`, NOT the `user_version` gate below, and that is
  // load-bearing rather than belt-and-braces. Every store written by Phase 1 already
  // reports user_version = 1, so an ALTER placed inside `if (current < VERSION)` would
  // run on fresh databases only — and every listShards() against an existing store
  // would then fail with `no such column: always_on`. Asking the table what columns it
  // has is the only question whose answer does not depend on a version number that was
  // stamped before the column existed. It also makes repeat opens (and
  // src/shards/durability.test.ts's user_version = 0 reopen, which runs against a table
  // that ALREADY has the column) a no-op instead of `duplicate column name`.
  //
  // SHARD_SCHEMA_VERSION deliberately stays 1: it is stamped into every record
  // (src/shards/record.ts:101) and is a z.literal in the wire schema
  // (src/shards/portable.ts:120,134), so bumping it would make every Phase 4 bundle
  // unimportable in exchange for nothing — the column is additive with a default, so
  // old and new rows read identically.
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(shards)').all();
  if (!columns.some((c) => c.name === 'always_on')) {
    db.run('ALTER TABLE shards ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0');
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_shards_state ON shards(state)');
  db.run('CREATE INDEX IF NOT EXISTS idx_shards_scope ON shards(scope_type, scope_key)');
  db.run('CREATE INDEX IF NOT EXISTS idx_shards_always_on ON shards(always_on)');

  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  const current = row?.user_version ?? 0;
  if (current < SHARD_SCHEMA_VERSION) {
    // v0 -> v1 is "the table did not exist", which CREATE TABLE IF NOT EXISTS above
    // already handled. Future bumps add their ALTER TABLE steps here, guarded on
    // `current` — but prefer the table_info shape above for a plain column add, for
    // the reason spelled out there.
    db.run(`PRAGMA user_version = ${SHARD_SCHEMA_VERSION}`);
  }
}

/** Idempotent; creates the data dir if absent. Never deletes on schema mismatch. */
export function getShardsDb(): Database {
  if (_db) return _db;
  mkdirSync(getDataDir(), { recursive: true });
  const db = new Database(getShardsDbPath());
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');
  migrate(db);
  _db = db;
  return _db;
}

/**
 * Close and drop the cached connection so the next getShardsDb() reopens against
 * the current getShardsDbPath(). Mirrors closeDb() (src/cache.ts:94-105): idempotent,
 * never throws, and the seam a hermetic test uses to release the handle before it
 * deletes its temp dir.
 */
export function closeShardsDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
}

interface ShardRow {
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
}

const EMPTY_EVIDENCE: ShardEvidence = { distinctPhrasings: 0, sessions: [], firstSeen: '', lastSeen: '' };

function rowToRecord(row: ShardRow): ShardRecord {
  let evidence: ShardEvidence;
  try {
    evidence = JSON.parse(row.evidence) as ShardEvidence;
  } catch {
    // A record whose evidence blob is unreadable is still a record the user
    // triaged. Degrade the evidence, never drop the row.
    evidence = EMPTY_EVIDENCE;
  }
  return {
    v: row.v,
    id: row.id,
    text: row.text,
    kind: row.kind as ShardKind,
    scope: { type: row.scope_type as ShardScope['type'], key: row.scope_key },
    author: row.author,
    evidence,
    state: row.state as ShardState,
    snoozedUntil: row.snoozed_until,
    // `=== 1`, never a bare truthy cast: SQLite hands back a number, and leaking a
    // number into a `boolean` field would serialize as 0/1 and break the byte-identical
    // JSON comparisons the determinism criterion rests on.
    alwaysOn: row.always_on === 1,
  };
}

/**
 * Insert new candidates and refresh the evidence of ones already stored.
 *
 * `state`, `snoozed_until`, and `always_on` are deliberately absent from the ON CONFLICT
 * update, and so are the two scope columns: a re-mine sees the same corrective turns
 * forever, so overwriting state would resurrect every rejected candidate and the user
 * would re-triage it on every run. `always_on` is the same hazard one level worse —
 * `buildRecord` defaults it to false (src/shards/record.ts:110), so including it here
 * would silently clear a standing constraint on the next `shards mine`, which is
 * exactly the invisible-suppression failure the flag exists to prevent. Scope columns
 * are excluded for the third variant: `deriveScope` only ever produces repo/workflow,
 * so a triage-assigned `group` scope would be reverted by the next mine.
 */
export function upsertCandidates(records: ShardRecord[]): void {
  if (records.length === 0) return;
  const db = getShardsDb();
  const now = new Date().toISOString();
  const stmt = db.query(`
    INSERT INTO shards (id, v, text, kind, scope_type, scope_key, author, evidence, state, snoozed_until, always_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence, updated_at = excluded.updated_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of records) {
      stmt.run(
        r.id,
        r.v,
        r.text,
        r.kind,
        r.scope.type,
        r.scope.key,
        r.author,
        JSON.stringify(r.evidence),
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

export interface ShardFilter {
  state?: ShardState;
  scope?: ShardScope;
}

/** Stored shards, ordered by id so callers get a stable batch without re-sorting. */
export function listShards(filter: ShardFilter = {}): ShardRecord[] {
  const db = getShardsDb();
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
    .query<ShardRow, any[]>(
      // Explicit column list, not SELECT * — a column forgotten here arrives as
      // `undefined` at runtime and typecheck says nothing.
      `SELECT id, v, text, kind, scope_type, scope_key, author, evidence, state, snoozed_until, always_on
       FROM shards ${where} ORDER BY id`,
    )
    .all(...params);
  return rows.map(rowToRecord);
}

export interface PersistedState {
  state: ShardState;
  snoozedUntil: string | null;
}

/**
 * Persisted triage state for the given ids; ids with no stored row are absent.
 *
 * The store — not a fresh mine — is the authority on state. `mine()` builds records
 * from transcripts, so every record it returns says `candidate`; emitting that
 * straight to stdout would re-present an already-rejected shard to the triage
 * consumer on every run. `upsertCandidates` protects the table (state is excluded
 * from the ON CONFLICT update); this is what protects the pipe.
 *
 * Ids are chunked because SQLite caps host parameters per statement (999 by default).
 */
export function getPersistedStates(ids: string[]): Map<string, PersistedState> {
  const out = new Map<string, PersistedState>();
  if (ids.length === 0) return out;
  const db = getShardsDb();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string; state: string; snoozed_until: string | null }, string[]>(
        `SELECT id, state, snoozed_until FROM shards WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk);
    for (const row of rows) out.set(row.id, { state: row.state as ShardState, snoozedUntil: row.snoozed_until });
  }
  return out;
}

/** Record a triage decision. `snoozedUntil` is cleared unless explicitly supplied. */
export function setState(id: string, state: ShardState, snoozedUntil: string | null = null): void {
  const db = getShardsDb();
  db.run('UPDATE shards SET state = ?, snoozed_until = ?, updated_at = ? WHERE id = ?', [
    state,
    snoozedUntil,
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Mark a shard as bypassing topic matching.
 *
 * A sibling of `setState` rather than a parameter on it, because the two are
 * independent axes: `--always-on` on a re-approval must not have to restate the state,
 * and a state change must not be able to clear the flag by omission. Same bare-UPDATE
 * caveat — the caller checks `isKnownShard` first (src/shards/cli.ts).
 */
export function setAlwaysOn(id: string, alwaysOn: boolean): void {
  const db = getShardsDb();
  db.run('UPDATE shards SET always_on = ?, updated_at = ? WHERE id = ?', [
    alwaysOn ? 1 : 0,
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Overwrite a shard's scope. The one write that contradicts a derived value.
 *
 * Phase 1 derives repo-vs-workflow from how far a paraphrase cluster spread, and that
 * derivation is correct for the two tiers it can see. It cannot see a group: "these
 * four repos share a convention" is not a fact about spread, so a human assigns it at
 * triage and this is where that assignment lands. `upsertCandidates` deliberately does
 * not touch the scope columns, so the next `shards mine` leaves it alone.
 */
export function setScope(id: string, scope: ShardScope): void {
  const db = getShardsDb();
  db.run('UPDATE shards SET scope_type = ?, scope_key = ?, updated_at = ? WHERE id = ?', [
    scope.type,
    scope.key,
    new Date().toISOString(),
    id,
  ]);
}
