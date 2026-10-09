// Riker's job table, read for session provenance. Riker (the coding-worker supervisor)
// owns `<rikerHome>/jobs.db`; sessions only ever reads four columns of it, through a
// read-only handle, once per index refresh. A missing, locked, or unfamiliar database
// is never an error — the sessions index with what git already told us.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRikerHome } from './paths';

export interface RikerJob {
  /** The checkout the job came from (Riker's `repo` column). */
  repo: string;
  branch: string;
  prUrl: string;
}

export function getRikerJobsDbPath(): string {
  return join(getRikerHome(), 'jobs.db');
}

/** Riker's jobs.db, read-only. Never written, never migrated: it is Riker's, not ours. */
export function openRikerJobsDb(path: string = getRikerJobsDbPath()): Database {
  return new Database(path, { readonly: true });
}

/** repo/branch/pr_url for `ids`, in one query. Empty when jobs.db is absent, locked, or not Riker's shape. */
export function readRikerJobs(ids: number[]): Map<number, RikerJob> {
  const jobs = new Map<number, RikerJob>();
  const path = getRikerJobsDbPath();
  if (ids.length === 0 || !existsSync(path)) return jobs;
  let db: Database | null = null;
  try {
    db = openRikerJobsDb(path);
    const rows = db
      .query<{ id: number; repo: string | null; branch: string | null; pr_url: string | null }, number[]>(
        `SELECT id, repo, branch, pr_url FROM jobs WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids);
    for (const r of rows) jobs.set(r.id, { repo: r.repo ?? '', branch: r.branch ?? '', prUrl: r.pr_url ?? '' });
  } catch {
    // Locked mid-write, mid-migration, or not Riker's schema: provenance waits for a later refresh.
  } finally {
    db?.close();
  }
  return jobs;
}
