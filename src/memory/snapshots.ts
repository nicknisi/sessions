// Trend snapshots for the recurrence report (phase 4 of
// docs/ideation/memory-recurrence/). One JSONL line per `sessions memory report`
// run, appended — never rewritten — so the trend is an audit trail, not state.
// JSONL over a memory.db table on purpose: a file is inspectable and survives
// store schema migrations without one; the contract's whole thesis is that JSONL
// you can read beats a table you can't.
//
// Everything here is pure apart from the two I/O seams, and those take the
// directory as an argument (the caller passes `getDataDir()`) so a test points at
// a tmpdir and `setMemoryEnv` (fixtures.ts) stays the only env wiring.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecurrenceTrend, RecurrenceViolation } from './recurrence';

export const SNAPSHOT_FILENAME = 'memory-recurrence-snapshots.jsonl';

/** One appended line. `counts` keys are memory ids — content-addressed, so the
 *  identity survives re-mines where the text was edited at triage (`approve --as`). */
export interface RecurrenceSnapshot {
  v: 1;
  /** 'YYYY-MM-DD', injected by the caller (cli.ts's todayIso). */
  date: string;
  /** What the run measured: a repo container, or the literal 'all'. Compared
   *  between runs so a mixed-scope delta is called out instead of silently read. */
  scope: string;
  counts: Record<string, number>;
}

export function snapshotPath(dir: string): string {
  return join(dir, SNAPSHOT_FILENAME);
}

/** The scope label a snapshot line persists: repo container, or 'all'. */
export function scopeLabel(scope: { repo?: string }): string {
  return scope.repo ?? 'all';
}

/**
 * The counts a snapshot line persists: violation memory id -> SESSION count. It is
 * the same number the report's VIOLATIONS rows print (cli.ts renderReport), because
 * a delta computed against some other count is uninterpretable. Cluster evidence
 * carries `evidence.sessions` and no per-session dates, so sessions are the only
 * per-occurrence measure available.
 */
export function snapshotCounts(violations: RecurrenceViolation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.memory.id] = v.sessions.length;
  return counts;
}

/**
 * Read every line of the file; a missing file is an empty history, not an error
 * (first run). A corrupt line — a truncated write, or a hand-edit — is skipped with
 * a stderr warning, and the rest of the file still reads. Append-only means a bad
 * line happens at the END where the last partial write lives, so skipping it is
 * the difference between "one snapshot lost" and "the history is unreadable".
 */
export function readSnapshots(dir: string): RecurrenceSnapshot[] {
  const path = snapshotPath(dir);
  if (!existsSync(path)) return [];
  const snapshots: RecurrenceSnapshot[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RecurrenceSnapshot;
      if (typeof parsed.counts !== 'object' || parsed.counts === null) throw new Error('no counts object');
      snapshots.push(parsed);
    } catch {
      process.stderr.write(`  skipping corrupt snapshot line in ${SNAPSHOT_FILENAME}: ${line.slice(0, 60)}\n`);
    }
  }
  return snapshots;
}

/**
 * Delta the current violations against the previous snapshot. New ids get
 * `previous: null` / `delta: null` and render `(new)`. A memory absent from the
 * current violations is NOT decayed to zero silently — absence means "not in this
 * report's scope" and the row simply leaves the TREND section.
 */
export function diffSnapshots(previous: RecurrenceSnapshot | null, violations: RecurrenceViolation[]): RecurrenceTrend[] {
  return violations.map((v) => {
    const prev = previous?.counts[v.memory.id];
    return {
      id: v.memory.id,
      violations: v.sessions.length,
      previous: prev ?? null,
      delta: prev === undefined ? null : v.sessions.length - prev,
    };
  });
}

/**
 * Append one line. A write failure is a stderr warning, never a throw — a report
 * is never blocked by its audit trail (spec error table), and runReport renders
 * first and appends after so the render itself cannot be lost to a full disk.
 */
export function appendSnapshot(snapshot: RecurrenceSnapshot, dir: string): void {
  try {
    appendFileSync(snapshotPath(dir), JSON.stringify(snapshot) + '\n', 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  could not append to ${SNAPSHOT_FILENAME} (${reason}) — report rendered without snapshotting\n`);
  }
}
