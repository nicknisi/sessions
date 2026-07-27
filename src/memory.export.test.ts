import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvenance } from './provenance';
import type { ExportedLesson, LessonRow, RememberInput, RememberResult } from './memory';

/**
 * The store is the one thing here nothing can regenerate, and until the snapshot landed a
 * single `rm` took it with no second copy anywhere.
 *
 * What is being checked is not "a file appeared" but the four properties that make the
 * file worth having: it is a valid database, restoring it gives back the *relationships*
 * and not just the text, the newest write is the one that survives a race, and a backup
 * that fails cannot take the lesson down with it.
 */

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-export-'));
const dbPath = join(fixtureRoot, 'memory.db');
const snapshotPath = `${dbPath}.snapshot`;
const generationPath = `${dbPath}.snapshot.gen`;
const exportPath = join(fixtureRoot, 'lessons.jsonl');
process.env.SESSIONS_MEMORY_DB = dbPath;

const mem = await import('./memory');

const REPO = '/repo/alpha';
const REMOTE = 'github.com/nicknisi/alpha';
const NO_SOURCE: SessionProvenance = {
  sessionId: null,
  transcript: null,
  toolUseId: null,
  provenance: 'none',
  verified: false,
  tool: '',
};

function save(lesson: string, over: Partial<RememberInput> = {}): RememberResult {
  return mem.rememberLesson({ lesson, container: REPO, remote: REMOTE, source: NO_SOURCE, ...over });
}

/** Rows keyed by id, with only the columns a restore has to bring back intact. */
function shape(rows: LessonRow[]): Record<number, unknown> {
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        lesson: r.lesson,
        detail: r.detail,
        status: r.status,
        review_group: r.review_group,
        supersedes_id: r.supersedes_id,
        superseded_by: r.superseded_by,
        content_hash: r.content_hash,
        last_seen_at: r.last_seen_at,
      },
    ]),
  );
}

beforeEach(() => {
  process.env.SESSIONS_MEMORY_DB = dbPath;
  mem.closeMemoryDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
});

afterAll(() => {
  mem.closeMemoryDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('every committed write leaves a restorable copy beside the store', () => {
  test('a snapshot and a plaintext export appear on the first save', () => {
    const res = save('The snapshot rides along with the write that produced it.');
    expect(res.outcome).toBe('saved');

    expect(existsSync(snapshotPath)).toBe(true);
    expect(existsSync(exportPath)).toBe(true);

    const lines = readFileSync(exportPath, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!) as ExportedLesson).lesson).toBe(
      'The snapshot rides along with the write that produced it.',
    );
  });

  test('restoring the snapshot brings back supersedes chains and review groups, not just text', () => {
    // A superseded pair…
    const first = save('Lessons live outside the cache so a wipe cannot take them.');
    const second = save('Lessons live outside the cache so no wipe can take them.', { supersedes: first.id });
    // …and a contested pair, which is the only way a review_group gets written.
    save('The refresh marker is advisory and never coordinates a walk.');
    const contested = save('The refresh marker coordinates a walk and is never advisory.');

    expect(second.outcome).toBe('saved');
    expect(contested.outcome).toBe('conflict');

    const before = shape(mem.listLessons({ all: true }));
    expect(Object.keys(before).length).toBe(4);

    // Restore is a file replacement. That is the whole reason the snapshot is a database
    // and the export is not: ExportedLesson drops content_hash and review_group.
    mem.closeMemoryDb();
    rmSync(dbPath, { force: true });
    copyFileSync(snapshotPath, dbPath);

    expect(shape(mem.listLessons({ all: true }))).toEqual(before);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).flagged).toBe(2);
  });

  test('the snapshot is a consistent database, not a copy of a file mid-write', () => {
    save('VACUUM INTO takes a read transaction; copyFileSync takes whatever is on disk.');
    const snap = new Database(snapshotPath, { readonly: true });
    try {
      expect(snap.query<{ v: string }, []>('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' } as never);
      expect(snap.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n).toBe(1);
    } finally {
      snap.close();
    }
  });

  test('a resolved review and a hand retirement refresh the copy too', () => {
    save('Bun reads the lock file before the manifest.');
    const conflict = save('Bun reads the manifest before the lock file.');
    expect(conflict.outcome).toBe('conflict');

    mem.resolveReview(conflict.reviewGroup!, 'new');
    const lines = () =>
      readFileSync(exportPath, 'utf8')
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as ExportedLesson);
    expect(lines().find((l) => l.id === conflict.id)!.status).toBe('active');

    mem.retireLesson(conflict.id!);
    expect(lines().find((l) => l.id === conflict.id)!.status).toBe('retired');
  });
});

describe('the newest snapshot is the one that survives', () => {
  const WRITER = join(import.meta.dir, '__fixtures__', 'concurrent-remember.ts');

  test('two processes writing at once leave a snapshot holding both writes', async () => {
    save('An unrelated lesson that creates the store first.');
    mem.closeMemoryDb();

    const gate = join(fixtureRoot, 'go');
    const lessons = [
      'Bun spawns inherit the environment, which is what makes the preload enough.',
      'A rename is atomic but it is not ordered, which is what the generation check is for.',
    ];
    const procs = lessons.map((lesson) =>
      Bun.spawn([process.execPath, 'run', WRITER, lesson, gate], {
        env: { ...process.env, SESSIONS_MEMORY_DB: dbPath },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    await Bun.sleep(300);
    writeFileSync(gate, '');

    const results = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })),
    );
    for (const r of results) expect(r).toEqual({ code: 0, err: '' });

    // Whichever process committed last produced the snapshot with the most rows, and the
    // generation check is what stops the other one landing on top of it afterwards. A
    // bare atomic rename would leave this at 2 about half the time.
    const snap = new Database(snapshotPath, { readonly: true });
    try {
      const saved = snap
        .query<{ lesson: string }, []>('SELECT lesson FROM lessons')
        .all()
        .map((r) => r.lesson);
      expect(saved.length).toBe(3);
      for (const lesson of lessons) expect(saved).toContain(lesson);
    } finally {
      snap.close();
    }
  });

  test('a snapshot older than the one on disk is dropped rather than landed', () => {
    save('The first lesson, which becomes the snapshot on disk.');
    const landed = readFileSync(snapshotPath);

    // Stand in for a newer snapshot another process just landed: a generation this
    // process cannot reach, so its own (genuinely older) copy has to be discarded.
    writeFileSync(generationPath, JSON.stringify({ lastSeen: '2099-01-01T00:00:00.000Z', maxId: 999, count: 999 }));

    const res = save('A second lesson, whose snapshot is behind the recorded generation.');
    expect(res.outcome).toBe('saved');
    expect(readFileSync(snapshotPath)).toEqual(landed);
    // …and the tmp copy it produced is not left lying around beside the store.
    expect(existsSync(`${dbPath}.snap.${process.pid}`)).toBe(false);
  });
});

describe('a failed backup cannot fail the lesson that triggered it', () => {
  test('an unwritable snapshot destination still returns a saved lesson, with a warning', () => {
    save('The lesson that creates the store.');
    mem.closeMemoryDb();
    // A directory where the snapshot file has to go: the rename cannot land, and the
    // failure happens after the row is already committed.
    rmSync(snapshotPath, { force: true });
    mkdirSync(snapshotPath, { recursive: true });

    const warnings: string[] = [];
    const err = spyOn(process.stderr, 'write').mockImplementation((s) => {
      warnings.push(String(s));
      return true;
    });
    const res = save('A lesson saved while the backup is broken.');
    err.mockRestore();

    expect(res.outcome).toBe('saved');
    expect(warnings.join('')).toContain('lesson snapshot failed (the lesson was saved)');
    // The store itself is untouched by the backup failing.
    expect(mem.listLessons({ all: true }).map((r) => r.id)).toEqual([res.id!, 1]);
  });
});

describe('purging the lessons takes the copies with it', () => {
  test('--purge-lessons removes the snapshot and the plaintext export too', () => {
    save('A lesson the user is about to delete on purpose.');
    expect(existsSync(snapshotPath)).toBe(true);
    expect(existsSync(exportPath)).toBe(true);

    expect(mem.purgeLessons()).toBe(true);

    // Leaving these behind would make "N lessons that nothing can regenerate" a lie: both
    // are complete copies of exactly what the user asked to be rid of.
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(generationPath)).toBe(false);
    expect(existsSync(exportPath)).toBe(false);
  });
});
