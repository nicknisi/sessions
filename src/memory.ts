import { Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertNotRealStore, getMemoryDbPath } from './paths';
import type { SessionProvenance } from './provenance';
import type { ContextLesson, Provenance } from './types';

/**
 * The lesson store. Deliberately its own database, outside the cache.
 *
 * Every row in index.db is a reproducible projection of a transcript and is dropped
 * on a schema bump, a `--clear-cache`, or corruption. A lesson is an assertion
 * somebody made once; nothing regenerates it. The two must never share a file, a
 * lifecycle, or a recovery strategy — see the migration ladder below, which never
 * drops a table, and getMemoryDb, which quarantines corruption instead of deleting it.
 */

export type Scope = 'repo' | 'global';
/**
 * Every row here was put there by a person. `sessions distill` prints its candidates
 * and writes none of them, so there is no machine-authored state to quarantine — which
 * is what lets `needs_review` mean exactly one thing: two claims disagree, arbitrate.
 */
export type LessonStatus = 'active' | 'needs_review' | 'superseded' | 'retired';

/** Bounded at write, not at read: the read budget stays honest and the verbose entries never land. */
export const LESSON_MAX_CHARS = 280;
export const DETAIL_MAX_CHARS = 600;

// Primer budgets. Lessons are hand-curated and few, so these are row counts, not a
// ranking function. They live here rather than in context.ts because cache.ts needs
// the default too and importing context.ts there would be a cycle.
export const LESSON_LIMIT = 5;
export const LESSON_HOOK_LIMIT = 3;

/**
 * Near-duplicate bands, as token-set Jaccard over normalized lesson text. Guesses,
 * pinned by the hand-labelled pair corpus in memory.test.ts so tuning them is a data
 * change with a regression signal rather than a vibe.
 */
export const SAME_LESSON_JACCARD = 0.85;
export const REVIEW_JACCARD = 0.55;

export interface LessonRow {
  id: number;
  content_hash: string;
  lesson: string;
  detail: string;
  scope: Scope;
  repo_container: string;
  repo_remote: string;
  files: string;
  tool: string;
  source_session: string | null;
  source_transcript: string | null;
  source_tool_use_id: string | null;
  provenance: Provenance;
  source_verified: number;
  status: LessonStatus;
  review_group: number | null;
  supersedes_id: number | null;
  superseded_by: number | null;
  created_at: string;
  last_seen_at: string;
}

interface Migration {
  to: number;
  up: (db: Database) => void;
}

// An ordered ALTER/backfill ladder. index.db drops and rebuilds on a version
// mismatch, which is correct there and catastrophic here — no step may ever DROP.
const MIGRATIONS: Migration[] = [
  {
    to: 1,
    up(db) {
      db.run(`
        CREATE TABLE lessons (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          content_hash       TEXT NOT NULL UNIQUE,
          lesson             TEXT NOT NULL,
          detail             TEXT NOT NULL DEFAULT '',
          scope              TEXT NOT NULL,
          repo_container     TEXT NOT NULL DEFAULT '',
          repo_remote        TEXT NOT NULL DEFAULT '',
          files              TEXT NOT NULL DEFAULT '[]',
          tool               TEXT NOT NULL DEFAULT '',
          source_session     TEXT,
          source_transcript  TEXT,
          source_tool_use_id TEXT,
          provenance         TEXT NOT NULL,
          source_verified    INTEGER NOT NULL DEFAULT 0,
          -- Deliberately unconstrained: LessonStatus is enforced in TypeScript, and a
          -- CHECK here would make every new status a rebuild of the one table nothing
          -- can regenerate (SQLite cannot alter a CHECK in place). Adding or removing a
          -- status therefore needs no DDL — only a version bump when an older build
          -- would mis-render what it finds.
          status             TEXT NOT NULL DEFAULT 'active',
          review_group       INTEGER,
          supersedes_id      INTEGER REFERENCES lessons(id),
          superseded_by      INTEGER REFERENCES lessons(id),
          created_at         TEXT NOT NULL,
          last_seen_at       TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX lessons_scope ON lessons(status, scope, repo_container)');
      db.run('CREATE INDEX lessons_remote ON lessons(status, repo_remote)');
      // Shortlist index for near-duplicate detection. Synced by hand (delete by id,
      // re-insert) the same way session_fts is in cache.ts.
      db.run(`
        CREATE VIRTUAL TABLE lessons_fts USING fts5(
          id UNINDEXED,
          lesson,
          detail,
          tokenize = 'porter unicode61'
        )
      `);
    },
  },
  {
    to: 2,
    // Historical, and kept forever: this bump shipped alongside a `proposed` status that
    // has since been removed, and stores in the wild are already at v2. It carries no DDL
    // — `status` never had a CHECK to extend (see the column comment above) — so the step
    // is a no-op by design. Deleting it would renumber the ladder and make every existing
    // store look like it came from a newer build than it did.
    up() {},
  },
  {
    to: 3,
    // `proposed` was removed, but stores written before that still hold those rows — and
    // both guards that made them safe went with it. `shortlist` no longer excludes them,
    // so each one is a live near-duplicate candidate: a genuine save whose wording
    // overlaps a machine guess nobody read would be quarantined as a conflict against it.
    // And `saveLesson` no longer displaces an exact-hash collision, so re-saving that
    // text answers "already known — lesson #N" pointing at a row nothing ever serves.
    //
    // Retire them and drop their shortlist entries: exactly what rejecting one used to
    // do, applied once. Nothing is deleted — a retired row stays readable, stays in
    // `sessions lessons`, stays in the export, and keeps its content_hash. And a
    // proposal is the one thing in this store that was always re-derivable, so if the
    // claim was any good `sessions distill` finds it again.
    up(db) {
      db.run("DELETE FROM lessons_fts WHERE id IN (SELECT id FROM lessons WHERE status = 'proposed')");
      db.run("UPDATE lessons SET status = 'retired' WHERE status = 'proposed'");
    },
  },
];

export const MEMORY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.to;

const TOO_NEW = 'memory.db was written by a newer sessions';

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

/** Walk the ladder from the file's version to the ladder's last step. Exported so a test can drive a synthetic v2. */
export function applyMigrations(db: Database, ladder: Migration[] = MIGRATIONS): number {
  const from = userVersion(db);
  const target = ladder[ladder.length - 1]!.to;
  if (from > target) throw new Error(`${TOO_NEW} (file v${from}, this build v${target})`);
  for (const m of ladder) {
    if (m.to <= from) continue;
    // IMMEDIATE, with the version re-read under the write lock. Two sessions opening a
    // brand-new store at the same moment both read version 0 out here, and a step is a
    // CREATE TABLE — the second one to arrive must see the first one's commit and skip,
    // not fail the open with "table lessons already exists".
    db.transaction(() => {
      if (userVersion(db) >= m.to) return;
      m.up(db);
      db.run(`PRAGMA user_version = ${m.to}`);
    }).immediate();
  }
  return target;
}

let _db: Database | null = null;
// The path the open handle belongs to. Compared on every call so a changed
// SESSIONS_MEMORY_DB reopens instead of silently serving the previous file — which
// is what a test that forgets to close would otherwise get.
let _dbPath = '';
let _readonly = false;

function openAt(path: string): Database {
  const db = new Database(path);
  db.run('PRAGMA busy_timeout=5000');
  // No WAL. This file is small, written rarely, and is the thing a user backs up,
  // exports, or copies to another machine — a single file at rest is worth more here
  // than the write concurrency index.db needs.
  db.run('PRAGMA journal_mode=DELETE');
  db.run('PRAGMA synchronous=FULL');
  db.run('PRAGMA foreign_keys=ON');
  return db;
}

// Same detection as cache.ts, opposite response: there it means "delete and rebuild",
// here it means "get out of the way and keep the bytes".
function isCorruption(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database');
}

function quarantine(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.corrupt-${stamp}`;
  renameSync(path, dest);
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    try {
      renameSync(path + sidecar, dest + sidecar);
    } catch {}
  }
  return dest;
}

/**
 * Corrupt stores set aside beside the live one.
 *
 * quarantine() keeps every byte, but a rename nobody is told about reads exactly like
 * "you never saved anything". Reported by every surface that would otherwise show an
 * empty store, and it keeps being reported until the file is recovered or deleted —
 * whatever gets written next diverges from it with no merge path.
 */
export function quarantinedStores(): string[] {
  const path = getMemoryDbPath();
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && !/-(wal|shm|journal)$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Open the store. `create` is false by default so a read never conjures a database —
 * a machine that has never saved a lesson has no memory.db, and the primer must be a
 * clean no-op there rather than leaving an empty file behind. Corruption is held to
 * the same contract: the bytes are set aside and the reader is told there is nothing,
 * never handed a fresh empty file to start writing a second store into.
 */
export function getMemoryDb(opts: { create?: boolean } = {}): Database | null {
  const path = getMemoryDbPath();
  // Before the existsSync/mkdirSync below, not inside openAt: a refused open must not
  // get as far as creating ~/.local/share/sessions on the way to being refused.
  assertNotRealStore(path, 'memory');
  if (_db && _dbPath === path) return _db;
  if (_db) closeMemoryDb();
  if (!existsSync(path) && !opts.create) return null;
  mkdirSync(dirname(path), { recursive: true });

  let db: Database;
  try {
    db = openAt(path);
  } catch (e) {
    if (!isCorruption(e)) throw e;
    quarantine(path);
    if (!opts.create) return null;
    db = openAt(path);
  }

  if (userVersion(db) > MEMORY_SCHEMA_VERSION) {
    // Older binary, newer file (a downgrade, or a synced home dir). Serve reads,
    // refuse writes — do not "repair" a schema this build does not understand.
    db.close();
    db = new Database(path, { readonly: true });
    _readonly = true;
  } else {
    try {
      applyMigrations(db);
    } catch (e) {
      db.close();
      if (!isCorruption(e)) throw e;
      quarantine(path);
      if (!opts.create) return null;
      db = openAt(path);
      applyMigrations(db);
    }
  }

  _db = db;
  _dbPath = path;
  return db;
}

export function closeMemoryDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
  _dbPath = '';
  _readonly = false;
}

/** True when the file on disk is newer than this build, so writes are refused. */
export function isReadOnly(): boolean {
  return _readonly;
}

// Punctuation and case carry no meaning for identity here: "Bound at write!" and
// "bound at write" are the same lesson.
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(lesson: string, scope: Scope, repoKey: string): string {
  const h = new Bun.CryptoHasher('sha256');
  // \0 as the field separator: it cannot occur in a lesson, a scope, or a repo
  // path, so no combination of the three can collide with another.
  h.update(`${normalizeText(lesson)}\0${scope}\0${repoKey}`);
  return h.digest('hex');
}

// Grammatical filler only. Negations (not/no/never/cannot/without) are deliberately
// kept: they are the whole difference between a lesson and its opposite, and the
// labelled corpus in memory.test.ts is what says whether this list is doing its job.
const STOPWORDS = new Set(
  (
    'the a an and or of to in on at is are was were be been it its that this these those as by for with from but if ' +
    'then than so do does did you your we our i my me us they them their he she his her will would can could should ' +
    'when while into over under up down out about per via also just only very more most some any all each other such own too'
  ).split(' '),
);

function contentWords(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function similarityTokens(s: string): Set<string> {
  return new Set(contentWords(s));
}

/**
 * The same content words in the same order — a rewording, not a different claim.
 *
 * A token set cannot see arrangement, and arrangement is where a negation flips: "the
 * budget is per-endpoint, not per-account" and "the budget is per-account, not
 * per-endpoint" are a perfect 1.0 against each other. Calling that a duplicate would
 * throw away the correction and keep serving the stale one — the conflict failure in
 * its worst form, because nothing is flagged and nobody is told. So identical order is
 * what "already known" requires; anything else goes to review.
 */
export function sameStatement(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * Token-set Jaccard over content words. Cheap, symmetric, and explainable to a human.
 *
 * Stopwords come out first because with them in, a same-lesson reword measures 0.833
 * — under the 0.85 "same" threshold — purely on dropped articles, while unrelated
 * lessons float up on shared filler. Content words separate the labelled corpus; raw
 * tokens do not.
 */
export function jaccard(a: string, b: string): number {
  const A = similarityTokens(a);
  const B = similarityTokens(b);
  if (A.size === 0 || B.size === 0) return A.size === B.size ? 1 : 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/** OR-joined quoted tokens. Every token is alphanumeric after normalization, so nothing needs escaping. */
function ftsQuery(text: string): string {
  const tokens = [
    ...new Set(
      normalizeText(text)
        .split(' ')
        .filter((t) => t.length > 2),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 20);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export interface RepoLessons {
  lessons: ContextLesson[];
  /** Rows quarantined as conflicting. Surfaced as a count, never as content. */
  flagged: number;
  /** Active in-scope rows, so a capped primer can say how many it left out. */
  total: number;
  /** Corrupt stores moved aside. Non-empty means lessons are missing, not absent. */
  quarantined: string[];
}

export const NO_LESSONS: RepoLessons = { lessons: [], flagged: 0, total: 0, quarantined: [] };

function toContextLesson(r: LessonRow): ContextLesson {
  return {
    id: r.id,
    lesson: r.lesson,
    detail: r.detail,
    scope: r.scope,
    provenance: r.provenance,
    verified: r.source_verified === 1,
    sessionId: r.source_session,
    savedAt: r.created_at,
  };
}

// A repo lesson matches on the container (which already collapses worktrees) or on
// the normalized origin remote, which is the only key that survives moving the
// checkout. Global lessons match everywhere.
const SCOPE_PREDICATE = `(
  (scope = 'repo' AND (repo_container = ? OR (repo_remote <> '' AND repo_remote = ?)))
  OR scope = 'global'
)`;

/**
 * Lessons for one repo, repo scope before global, newest first within each tier.
 *
 * No scoring function: sessions get one because there are hundreds and most are
 * trivial, lessons are few and hand-curated. A ranker here would be a second tuning
 * surface with no regression signal, and it would quietly absorb the junk-drawer
 * signal that `total > limit` is supposed to make loud.
 */
export function readLessonsForRepo(container: string, remote: string, limit: number): RepoLessons {
  try {
    const db = getMemoryDb();
    // Looked up after the open, because the open is what moves a corrupt file aside.
    // An empty store and a store that was just quarantined are indistinguishable to a
    // reader who is not told which one this is.
    const quarantined = quarantinedStores();
    if (!db) return { ...NO_LESSONS, quarantined };

    const rows = db
      .query<LessonRow, [string, string, number]>(
        `SELECT * FROM lessons
         WHERE status = 'active' AND ${SCOPE_PREDICATE}
         ORDER BY (scope = 'repo') DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(container, remote, limit);

    const total =
      db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM lessons WHERE status = 'active' AND ${SCOPE_PREDICATE}`,
        )
        .get(container, remote)?.n ?? 0;

    const flagged =
      db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM lessons WHERE status = 'needs_review' AND ${SCOPE_PREDICATE}`,
        )
        .get(container, remote)?.n ?? 0;

    return { lessons: rows.map(toContextLesson), flagged, total, quarantined };
  } catch {
    // The primer must never fail because of the lesson store.
    return { ...NO_LESSONS, quarantined: quarantinedStores() };
  }
}

export interface RememberInput {
  lesson: string;
  detail?: string;
  scope?: Scope;
  /** resolveRepo().container — already worktree-collapsed. */
  container?: string;
  /** Normalized origin remote, so the lesson survives a moved checkout. */
  remote?: string;
  files?: string[];
  /** Explicit correction of an existing lesson. The only non-human path to supersession besides review. */
  supersedes?: number;
  source: SessionProvenance;
  now?: string;
}

export type RememberOutcome = 'saved' | 'known' | 'conflict' | 'rejected';

export interface RememberResult {
  outcome: RememberOutcome;
  id?: number;
  status?: LessonStatus;
  provenance?: Provenance;
  verified?: boolean;
  reviewGroup?: number;
  /** The rows this save implicates, with the status each ended up in. */
  conflicts?: { id: number; lesson: string; status: LessonStatus }[];
  message: string;
}

function reject(message: string): RememberResult {
  return { outcome: 'rejected', message };
}

/**
 * "Already known" is misleading when the matched row is out of service — an agent
 * would read it as "this is on file and being used". Say which it is: a retirement or
 * a supersession is a decision someone made, and re-saving the text does not undo it.
 */
function statusNote(row: LessonRow): string {
  switch (row.status) {
    case 'active':
      return '';
    case 'retired':
      return ' Note: that lesson was retired and is not served — do not re-save it, raise it with the user instead.';
    case 'superseded':
      return ` Note: that lesson was superseded by #${row.superseded_by} and is not served.`;
    case 'needs_review':
      return ' Note: that lesson is flagged as conflicting and is withheld until a human resolves it.';
  }
}

/** Nothing was inserted. `target` is a supersedes that therefore never ran, and is said out loud. */
function knownResult(row: LessonRow, why: string, target: LessonRow | null): RememberResult {
  const dropped = target ? ` The supersedes of #${target.id} was not applied — nothing was retired.` : '';
  return {
    outcome: 'known',
    id: row.id,
    status: row.status,
    provenance: row.provenance,
    verified: row.source_verified === 1,
    message: `${why}${statusNote(row)}${dropped}`,
  };
}

// Bun raises a SQLiteError whose code is the reliable part; the message is the fallback
// for anything that arrives as a plain Error.
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  return (e instanceof Error ? e.message : String(e)).includes('UNIQUE constraint failed');
}

function insertFts(db: Database, id: number, lesson: string, detail: string): void {
  db.run('DELETE FROM lessons_fts WHERE id = ?', [id]);
  db.run('INSERT INTO lessons_fts (id, lesson, detail) VALUES (?, ?, ?)', [id, lesson, detail]);
}

/**
 * Rows in the same scope bucket that share indexed tokens with `lesson`.
 *
 * Every status but `superseded` is a candidate. Scanning only the active
 * rows is how a rewording walks around a retirement, and how a third phrasing of a
 * contested claim gets served as fact while its two rivals sit withheld in review.
 * Superseded rows are excluded because whatever replaced them is live and matches in
 * their place.
 *
 * Ordered so the in-service rows come first — a same-statement match should be
 * recognized as the row that is actually being served, not as a retired ancestor.
 */
function shortlist(db: Database, lesson: string, scope: Scope, container: string): LessonRow[] {
  const match = ftsQuery(lesson);
  if (!match) return [];
  const bucket = scope === 'global' ? "l.scope = 'global'" : "l.scope = 'repo' AND l.repo_container = ?";
  const params: (string | number)[] = scope === 'global' ? [match] : [match, container];
  try {
    return db
      .query<LessonRow, any[]>(
        `SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.id
         WHERE lessons_fts MATCH ? AND l.status NOT IN ('superseded') AND ${bucket}
         ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END, l.id`,
      )
      .all(...params);
  } catch {
    return [];
  }
}

/**
 * Save a lesson, or say why it was not saved.
 *
 * Every outcome but `rejected` committed something — a new row, a superseded incumbent,
 * or a bumped last_seen_at — so every one of them earns a fresh backup. A rejection
 * never reached the store and leaves the snapshot exactly where it was.
 */
export function rememberLesson(input: RememberInput): RememberResult {
  const result = saveLesson(input);
  if (result.outcome !== 'rejected') snapshotAfterWrite();
  return result;
}

/**
 * Four things keep this from becoming a junk drawer, in order of how much work they
 * do: the length bounds above, exact-content idempotency, near-duplicate quarantine,
 * and making the pressure visible in the primer.
 */
function saveLesson(input: RememberInput): RememberResult {
  const lesson = input.lesson.trim();
  const detail = (input.detail ?? '').trim();
  const scope: Scope = input.scope ?? 'repo';
  const container = input.container ?? '';
  const remote = input.remote ?? '';

  if (!lesson) return reject('lesson is empty.');
  if (lesson.length > LESSON_MAX_CHARS) {
    return reject(
      `lesson is ${lesson.length} chars, over the ${LESSON_MAX_CHARS} limit — compress it to one transferable sentence and move the specifics into detail.`,
    );
  }
  if (detail.length > DETAIL_MAX_CHARS) {
    return reject(
      `detail is ${detail.length} chars, over the ${DETAIL_MAX_CHARS} limit — keep the file, root cause, and fix; drop the narrative.`,
    );
  }
  if (scope === 'repo' && !container) {
    return reject('scope "repo" needs a git repo — run from inside one, or save this as scope "global".');
  }

  const db = getMemoryDb({ create: true });
  if (!db) return reject('could not open the lesson store.');
  if (_readonly) {
    return reject(
      `${getMemoryDbPath()} was written by a newer sessions build; upgrade before saving so its schema is not rewritten by an older one.`,
    );
  }

  const now = input.now ?? new Date().toISOString();
  const repoKey = scope === 'global' ? '' : container;
  const hash = contentHash(lesson, scope, repoKey);

  // Resolved first: a supersedes pointing at nothing is the actionable problem, and it
  // must be refused before any other outcome buries it.
  let target: LessonRow | null = null;
  if (input.supersedes !== undefined) {
    target = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(input.supersedes);
    if (!target) return reject(`no lesson #${input.supersedes} to supersede.`);
    if (target.superseded_by !== null) {
      return reject(`lesson #${input.supersedes} was already superseded by #${target.superseded_by}.`);
    }
  }

  // Exact re-save: the highest-volume junk source is the same agent saving the same
  // lesson every session. Bump the recurrence signal, insert nothing.
  const existing = db.query<LessonRow, [string]>('SELECT * FROM lessons WHERE content_hash = ?').get(hash);
  if (existing) {
    db.run('UPDATE lessons SET last_seen_at = ? WHERE id = ?', [now, existing.id]);
    return knownResult(existing, `already known — lesson #${existing.id}, last seen bumped. Nothing inserted.`, target);
  }

  // The near-duplicate scan runs on the supersedes path too. A stated relationship is
  // not a checked one, and skipping the scan made `supersedes` an unreviewed kill
  // switch: any id, hallucinated or off by one, retired a lesson outright. The target
  // is held out of the scan because replacing it is the whole point.
  const candidates = shortlist(db, lesson, scope, container).filter((r) => r.id !== target?.id);
  let same: LessonRow | null = null;
  const band: LessonRow[] = [];
  for (const row of candidates) {
    const j = jaccard(lesson, row.lesson);
    if (j < REVIEW_JACCARD) continue;
    if (j >= SAME_LESSON_JACCARD && sameStatement(lesson, row.lesson)) {
      same = row;
      break;
    }
    // Everything else that overlaps this much is contested, including a perfect
    // token-set match whose words are rearranged.
    band.push(row);
  }

  // Same lesson worded differently — treat it as a recurrence, not a new row.
  if (same) {
    db.run('UPDATE lessons SET last_seen_at = ? WHERE id = ?', [now, same.id]);
    return knownResult(
      same,
      `already known — lesson #${same.id} says the same thing ("${same.lesson}"). Last seen bumped, nothing inserted.`,
      target,
    );
  }

  // Two ways a row can be implicated. `contested` rows go out of service with the
  // newcomer and are what the review decides between; `context` rows are shown beside
  // the group and left exactly as they are — a retirement and a mis-aimed supersedes
  // are both decisions this save has no standing to overturn on its own.
  const contested = band.filter((r) => r.status !== 'retired');
  const context = band.filter((r) => r.status === 'retired');
  let misaimed: LessonRow | null = null;
  let supersedeNow = false;
  if (target) {
    if (jaccard(lesson, target.lesson) < REVIEW_JACCARD) {
      misaimed = target;
      context.push(target);
    } else if (contested.length > 0 || context.length > 0) {
      // Related, but contested by something else too — one decision, not two, and the
      // supersession waits for it rather than emptying the shelf in the meantime.
      contested.push(target);
    } else {
      supersedeNow = true;
    }
  }

  const conflict = contested.length > 0 || context.length > 0;
  const status: LessonStatus = conflict ? 'needs_review' : 'active';
  const src = input.source;

  const insert = db.transaction(() => {
    db.run(
      `INSERT INTO lessons (content_hash, lesson, detail, scope, repo_container, repo_remote, files, tool,
                            source_session, source_transcript, source_tool_use_id, provenance, source_verified,
                            status, supersedes_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        lesson,
        detail,
        scope,
        scope === 'global' ? '' : container,
        scope === 'global' ? '' : remote,
        JSON.stringify(input.files ?? []),
        src.tool,
        src.sessionId,
        src.transcript,
        src.toolUseId,
        src.provenance,
        src.verified ? 1 : 0,
        status,
        supersedeNow ? target!.id : null,
        now,
        now,
      ],
    );
    const newId = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
    insertFts(db, newId, lesson, detail);

    if (supersedeNow) {
      db.run("UPDATE lessons SET status = 'superseded', superseded_by = ? WHERE id = ?", [newId, target!.id]);
    }

    let group = newId;
    if (conflict) {
      // Join the group the contested rows already sit in instead of opening a rival
      // one. A third phrasing of the same argument is one decision; two groups would
      // let the human resolve half of it and put the other half back into service.
      const open = [...new Set(contested.map((r) => r.review_group).filter((g): g is number => g !== null))];
      if (open.length > 0) {
        group = Math.min(...open);
        for (const g of open) {
          if (g !== group) db.run('UPDATE lessons SET review_group = ? WHERE review_group = ?', [group, g]);
        }
      }
      // Flag BOTH sides. Quarantining only the newcomer would keep serving the
      // possibly-stale incumbent as fact while the correction sits invisible —
      // the exact inversion of what a conflict should do.
      db.run("UPDATE lessons SET status = 'needs_review', review_group = ? WHERE id = ?", [group, newId]);
      for (const row of contested) {
        db.run("UPDATE lessons SET status = 'needs_review', review_group = ? WHERE id = ?", [group, row.id]);
      }
      // Context rows keep any group they are already in: a row that is itself pending
      // belongs to the argument it was flagged for, and moving it here would split that
      // group and hand this decision a row that is not about this claim.
      for (const row of context) {
        if (row.review_group === null) db.run('UPDATE lessons SET review_group = ? WHERE id = ?', [group, row.id]);
      }
    }
    return { id: newId, group };
  });

  let id: number;
  let group: number;
  try {
    ({ id, group } = insert());
  } catch (e) {
    // Two sessions saving the same lesson at once: the SELECT above missed and the
    // UNIQUE index caught it. The row the other writer landed is the answer, so this
    // is the known path arriving the hard way — not an error for the agent to see.
    if (!isUniqueViolation(e)) throw e;
    const raced = db.query<LessonRow, [string]>('SELECT * FROM lessons WHERE content_hash = ?').get(hash);
    if (!raced) throw e;
    db.run('UPDATE lessons SET last_seen_at = ? WHERE id = ?', [now, raced.id]);
    return knownResult(
      raced,
      `already known — lesson #${raced.id} was saved concurrently by another session. Nothing inserted.`,
      target,
    );
  }

  if (conflict) {
    const quote = (r: LessonRow) => `#${r.id} "${r.lesson}"`;
    const overlaps = [
      ...contested.map((r) => `${quote(r)} (now also flagged)`),
      ...context.filter((r) => r.id !== misaimed?.id).map((r) => `${quote(r)} (retired, left as it is)`),
    ];
    const bits: string[] = [];
    if (overlaps.length > 0) {
      bits.push(
        `it overlaps ${overlaps.length === 1 ? 'an existing lesson' : `${overlaps.length} existing lessons`}: ${overlaps.join('; ')}`,
      );
    }
    if (misaimed) {
      bits.push(`it claims to supersede ${quote(misaimed)}, which says nothing the same — so nothing was retired`);
    }
    return {
      outcome: 'conflict',
      id,
      status: 'needs_review',
      provenance: src.provenance,
      verified: src.verified,
      reviewGroup: group,
      conflicts: [
        ...contested.map((r) => ({ id: r.id, lesson: r.lesson, status: 'needs_review' as LessonStatus })),
        ...context.map((r) => ({ id: r.id, lesson: r.lesson, status: r.status })),
      ],
      message:
        `saved #${id} as needs_review — ${bits.join(', and ')}. ` +
        'Nothing in the group is served in the primer until a human picks. ' +
        'Raise the conflict with the user, or run `sessions lessons review`.',
    };
  }

  const note = supersedeNow ? ` It supersedes #${target!.id}.` : '';
  const took = '';
  return {
    outcome: 'saved',
    id,
    status,
    provenance: src.provenance,
    verified: src.verified,
    message: `saved lesson #${id} (${scope} scope, provenance ${src.provenance}${src.verified ? ', verified' : ''}).${note}${took}`,
  };
}

export interface ListOptions {
  container?: string;
  remote?: string;
  all?: boolean;
  status?: LessonStatus;
}

export function listLessons(opts: ListOptions = {}): LessonRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.all) {
    conditions.push(SCOPE_PREDICATE);
    params.push(opts.container ?? '', opts.remote ?? '');
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .query<LessonRow, any[]>(`SELECT * FROM lessons ${where} ORDER BY (scope = 'repo') DESC, created_at DESC, id DESC`)
    .all(...params);
}

/**
 * Rows a purge would destroy for good — every row counts now that nothing in the store
 * is machine-generated. `sessions distill` prints its candidates and writes none of them,
 * so anything here was put there by a human and nothing can regenerate it.
 */
export function countLessons(): number {
  const db = getMemoryDb();
  if (!db) return 0;
  try {
    return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n ?? 0;
  } catch {
    return 0;
  }
}

export interface ReviewGroup {
  group: number;
  rows: LessonRow[];
}

export function reviewGroups(): ReviewGroup[] {
  const db = getMemoryDb();
  if (!db) return [];
  // Every row in a group that has something pending, including the ones that are only
  // there as context — a retired lesson the newcomer overlaps, or a supersedes target
  // it does not match. They explain the conflict; they are never re-decided by it.
  const rows = db
    .query<LessonRow, []>(
      `SELECT * FROM lessons WHERE review_group IN
         (SELECT review_group FROM lessons WHERE status = 'needs_review' AND review_group IS NOT NULL)
       ORDER BY review_group, id`,
    )
    .all();
  const groups = new Map<number, LessonRow[]>();
  for (const r of rows) {
    const g = r.review_group!;
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

export type ReviewChoice = 'new' | 'old' | 'both';

/**
 * Resolve one review group. Nothing is edited in place and nothing is merged: the
 * losing row is marked superseded or retired and stays readable.
 */
export function resolveReview(group: number, choice: ReviewChoice, now = new Date().toISOString()): number {
  const db = getMemoryDb();
  if (!db || _readonly) return 0;
  const all = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE review_group = ? ORDER BY id').all(group);
  const rows = all.filter((r) => r.status === 'needs_review');
  if (rows.length === 0) return 0;

  // The newcomer is whichever pending row is newest, so it is the last one by id —
  // the group key itself may be older than that once two groups have merged.
  const winner = rows[rows.length - 1]!;
  const losers = rows.slice(0, -1);

  db.transaction(() => {
    // Context rows were never in the decision; they only lose their group marker.
    for (const r of all) {
      if (r.status !== 'needs_review') db.run('UPDATE lessons SET review_group = NULL WHERE id = ?', [r.id]);
    }
    if (choice === 'both') {
      for (const r of rows) db.run("UPDATE lessons SET status = 'active', review_group = NULL WHERE id = ?", [r.id]);
      return;
    }
    if (choice === 'new') {
      db.run("UPDATE lessons SET status = 'active', review_group = NULL, last_seen_at = ? WHERE id = ?", [
        now,
        winner.id,
      ]);
      for (const r of losers) {
        db.run("UPDATE lessons SET status = 'superseded', review_group = NULL, superseded_by = ? WHERE id = ?", [
          winner.id,
          r.id,
        ]);
      }
      // One column, possibly several losers: point it at the oldest so the chain leads
      // back to the original claim. Writing it per loser kept only the last one.
      if (losers[0]) db.run('UPDATE lessons SET supersedes_id = ? WHERE id = ?', [losers[0].id, winner.id]);
      return;
    }
    // keep-old: the newcomer is retired, the incumbents go back to active.
    db.run("UPDATE lessons SET status = 'retired', review_group = NULL WHERE id = ?", [winner.id]);
    for (const r of losers) db.run("UPDATE lessons SET status = 'active', review_group = NULL WHERE id = ?", [r.id]);
  })();

  snapshotAfterWrite();
  return rows.length;
}

/** Take a lesson out of service by hand. Marked, never removed — the text stays readable. */
export function retireLesson(id: number): boolean {
  const db = getMemoryDb();
  if (!db || _readonly) return false;
  db.run("UPDATE lessons SET status = 'retired' WHERE id = ? AND status IN ('active', 'needs_review')", [id]);
  const retired = (db.query<{ n: number }, []>('SELECT changes() AS n').get()?.n ?? 0) > 0;
  if (retired) snapshotAfterWrite();
  return retired;
}

/** Rows whose session is unknown but whose tool_use id is traceable in the transcripts. */
export function deferredLessons(): LessonRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  return db
    .query<LessonRow, []>(
      "SELECT * FROM lessons WHERE provenance = 'deferred' AND source_tool_use_id IS NOT NULL ORDER BY id",
    )
    .all();
}

/** Back-fill a deferred row from an audit hit. 'recovered' records that it was traced, not stated. */
export function recoverLesson(id: number, sessionId: string, transcript: string): void {
  const db = getMemoryDb();
  if (!db || _readonly) return;
  db.run(
    `UPDATE lessons SET source_session = ?, source_transcript = ?, provenance = 'recovered', source_verified = 1
     WHERE id = ? AND provenance = 'deferred'`,
    [sessionId, transcript, id],
  );
}

export interface ExportedLesson {
  id: number;
  lesson: string;
  detail: string;
  scope: Scope;
  repo: { container: string; remote: string };
  files: string[];
  tool: string;
  source: {
    session: string | null;
    transcript: string | null;
    toolUseId: string | null;
    provenance: Provenance;
    verified: boolean;
  };
  status: LessonStatus;
  supersedes: number | null;
  supersededBy: number | null;
  createdAt: string;
  lastSeenAt: string;
}

/** Portable form of the whole store — the reason uninstall can honestly leave the file alone. */
export function exportLessons(): ExportedLesson[] {
  const db = getMemoryDb();
  if (!db) return [];
  const rows = db.query<LessonRow, []>('SELECT * FROM lessons ORDER BY id').all();
  return rows.map((r) => ({
    id: r.id,
    lesson: r.lesson,
    detail: r.detail,
    scope: r.scope,
    repo: { container: r.repo_container, remote: r.repo_remote },
    files: parseFiles(r.files),
    tool: r.tool,
    source: {
      session: r.source_session,
      transcript: r.source_transcript,
      toolUseId: r.source_tool_use_id,
      provenance: r.provenance,
      verified: r.source_verified === 1,
    },
    status: r.status,
    supersedes: r.supersedes_id,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}

export function parseFiles(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Backup, on every committed write.
 *
 * The store is the one thing here that nothing regenerates, and until now a single
 * `rm` took it with no second copy anywhere. Two artifacts land beside it: a
 * `VACUUM INTO` snapshot (restore is a file rename) and `lessons.jsonl` (the
 * human-readable half — derived, and deliberately not a restore path, since
 * exportLessons() drops content_hash and review_group).
 *
 * Nothing in here may fail a lesson write. A backup that can lose you the thing it
 * was backing up is worse than no backup.
 */

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

function snapshotPath(): string {
  return `${getMemoryDbPath()}.snapshot`;
}
function generationPath(): string {
  return `${getMemoryDbPath()}.snapshot.gen`;
}
function lockPath(): string {
  return `${getMemoryDbPath()}.snapshot.lock`;
}
function exportPath(): string {
  return join(dirname(getMemoryDbPath()), 'lessons.jsonl');
}

/**
 * How far along the store a given snapshot is, so the newest one always wins the
 * rename. Rename is atomic but not ordered: two processes can each produce a
 * perfectly consistent snapshot and the older one can still land last.
 *
 * `PRAGMA data_version` cannot do this job, despite reading like it was made for it.
 * SQLite does not increment it for changes committed on the *querying* connection, so
 * the writer that just committed reads a counter that does not include its own write —
 * exactly the comparison this needs. Derived from the rows instead.
 */
interface Generation {
  lastSeen: string;
  maxId: number;
  count: number;
}

const GENERATION_ZERO: Generation = { lastSeen: '', maxId: 0, count: 0 };

function generationOf(db: Database): Generation {
  const row = db
    .query<{ last: string | null; max_id: number | null; n: number }, []>(
      'SELECT MAX(last_seen_at) AS last, MAX(id) AS max_id, COUNT(*) AS n FROM lessons',
    )
    .get();
  return { lastSeen: row?.last ?? '', maxId: row?.max_id ?? 0, count: row?.n ?? 0 };
}

/** Negative when `a` is behind `b`. last_seen_at is ISO-8601, which sorts lexicographically. */
function compareGenerations(a: Generation, b: Generation): number {
  if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? -1 : 1;
  if (a.maxId !== b.maxId) return a.maxId - b.maxId;
  return a.count - b.count;
}

function readSnapshotGeneration(): Generation {
  try {
    const raw = JSON.parse(readFileSync(generationPath(), 'utf8')) as Partial<Generation>;
    return {
      lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : '',
      maxId: typeof raw.maxId === 'number' ? raw.maxId : 0,
      count: typeof raw.count === 'number' ? raw.count : 0,
    };
  } catch {
    // Absent or unreadable reads as "no snapshot yet", so the first writer wins rather
    // than every writer refusing to land one.
    return GENERATION_ZERO;
  }
}

function writeSnapshotGeneration(gen: Generation): void {
  writeFileAtomic(generationPath(), JSON.stringify(gen));
}

/** tmp + rename, the same shape as src/report/pricing-cache.ts. The tmp name carries the
 *  pid because concurrent writers would otherwise share one and rename each other's file. */
function writeFileAtomic(target: string, body: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/**
 * Remove a lock whose owner is gone, and only then.
 *
 * `process.kill(pid, 0)` throwing ESRCH is the confirmation; EPERM means the process is
 * alive under another user and the lock is legitimately held. A lock file whose contents
 * do not parse as a pid is only reaped once it is old enough to be clearly abandoned.
 */
function reapStaleLock(path: string): boolean {
  let owner = 0;
  try {
    owner = Number(readFileSync(path, 'utf8').trim());
  } catch {
    return false;
  }
  if (Number.isInteger(owner) && owner > 0) {
    try {
      process.kill(owner, 0);
      return false; // alive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  } else {
    try {
      if (Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS) return false;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-process mutex around the snapshot rename.
 *
 * `openSync(path, 'wx')` is the atomic primitive — an exclusive create that reports
 * EEXIST. (`mkdirSync` cannot serve: every call in this repo passes `{recursive: true}`,
 * which never reports EEXIST at all.) A lock *file* rather than a directory, because
 * fixture teardown elsewhere clears a directory with a per-entry `unlinkSync`, and that
 * throws on a directory.
 *
 * Returns false when the lock could not be taken inside the wait window. That is a safe
 * outcome, not an error: whoever holds it is landing a snapshot at least as new as ours.
 */
function withSnapshotLock(fn: () => void): boolean {
  const path = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch {
      if (Date.now() >= deadline) return false;
      if (!reapStaleLock(path)) Bun.sleepSync(5);
      continue;
    }
    try {
      writeFileSync(fd, String(process.pid));
      fn();
    } finally {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(path);
      } catch {}
    }
    return true;
  }
}

/** One JSON object per lesson, rewritten in full on every save. Not a restore path — see
 *  ExportedLesson, which is a projection, not the row. */
function writeExport(): void {
  const body = exportLessons()
    .map((l) => JSON.stringify(l))
    .join('\n');
  writeFileAtomic(exportPath(), body.length > 0 ? `${body}\n` : '');
}

/** Every file the snapshot machinery can leave beside the store, including a `.snap.<pid>`
 *  a killed process never got to rename away. */
function snapshotArtifacts(): string[] {
  const path = getMemoryDbPath();
  const files = [snapshotPath(), generationPath(), lockPath(), exportPath()];
  const strayPrefix = `${basename(path)}.snap.`;
  try {
    for (const f of readdirSync(dirname(path))) {
      if (f.startsWith(strayPrefix)) files.push(join(dirname(path), f));
    }
  } catch {}
  return files;
}

/**
 * Snapshot after a committed write. Never throws into the caller: a failed backup must
 * not fail the lesson that triggered it.
 */
function snapshotAfterWrite(): void {
  const db = getMemoryDb();
  if (!db || _readonly) return;
  const tmp = `${getMemoryDbPath()}.snap.${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    // VACUUM INTO, not copyFileSync: it runs inside a read transaction, so the output is
    // a consistent database even with another process mid-write. A raw byte copy is not.
    db.run('VACUUM INTO ?', [tmp]);

    // The generation is read back out of the snapshot itself rather than off the live
    // handle, so it describes exactly the rows that landed in this file — not rows some
    // other writer committed in the meantime.
    const snap = new Database(tmp, { readonly: true });
    let gen: Generation;
    try {
      gen = generationOf(snap);
    } finally {
      snap.close();
    }

    withSnapshotLock(() => {
      if (compareGenerations(gen, readSnapshotGeneration()) >= 0) {
        renameSync(tmp, snapshotPath());
        writeSnapshotGeneration(gen);
        // Under the same gate, so a writer that is behind cannot roll the export back
        // either. It is regenerated from the live rows, which are never older than the
        // snapshot that just landed.
        writeExport();
      }
    });
    // Gone already if the rename landed; still here if we lost the ordering check or the
    // lock, and a stray full copy of the store is not something to leave lying around.
    rmSync(tmp, { force: true });
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    process.stderr.write(`warning: lesson snapshot failed (the lesson was saved): ${err}\n`);
  }
}

/** Delete the store outright. Only ever reached through an explicit, confirmed `--purge-lessons`. */
export function purgeLessons(): boolean {
  closeMemoryDb();
  const path = getMemoryDbPath();
  let removed = false;
  // The snapshot and the plaintext export are complete copies of the same lessons. A
  // purge the user was told costs them everything has to take those too, or it lies.
  for (const f of [path, path + '-wal', path + '-shm', path + '-journal', ...snapshotArtifacts()]) {
    try {
      unlinkSync(f);
      if (f === path) removed = true;
    } catch {}
  }
  return removed;
}
