// The impure half of the recurrence report: scope resolution, the mine, and the
// store read that src/memory/recurrence.ts deliberately does not do (its header
// purity contract keeps that module reproducible-from-inputs). Both
// `sessions memory report` (src/memory/cli.ts) and the get_memory_recurrence MCP
// tool (src/mcp.ts) run through runRecurrence, so the two surfaces can never
// drift on what "this repo" means or on what the JSON holds — the scope-drift
// failure mode the phase-3 spec's failure table names.

import { existsSync } from 'node:fs';
import { getMemoryDbPath } from '../paths';
import { resolveRepo } from '../repo';
import { createContainerResolver, mine } from './mine';
import { classifyRecurrence, type RecurrenceReport } from './recurrence';
import { listMemories } from './store';
import { dropSuppressed, suppressedMemories } from './triage';
import { lastMinedAt } from './watermark';

/** The report JSON: the classification plus the envelope the CLI's `--json` emits. */
export interface RecurrenceEnvelope extends RecurrenceReport {
  generatedAt: string;
  lastMinedAt: string | null;
}

export interface ReportScope {
  /** Resolved repo container to mine, or undefined for every repo in the index. */
  repo?: string;
  /** True when scoping fell back to all repos because the target is not a git repo. */
  outsideRepo: boolean;
}

/**
 * Resolve `{ repo?, all? }` to a mine scope.
 *
 * Extracted when the MCP tool became the third consumer of this block: runMine had
 * it inline and runReport carried a deliberate copy with a comment refusing to
 * share for two call sites. Three surfaces disagreeing about "this repo" is the
 * drift that comment was betting against, so the bet is cashed in here.
 *
 * An explicit `repo` is containerized unconditionally — a path that is not a git
 * repo still scopes to itself (createContainerResolver's raw-cwd fallback). A
 * defaulted cwd that is not a repo reports across everything and says so via
 * `outsideRepo`, matching the CLI's stderr note.
 */
export function resolveReportScope(opts: { repo?: string; all?: boolean; cwd?: string }): ReportScope {
  if (opts.all) return { outsideRepo: false };
  const target = opts.repo ?? opts.cwd ?? process.cwd();
  if (opts.repo || resolveRepo(target)) {
    return { repo: createContainerResolver()(target), outsideRepo: false };
  }
  return { outsideRepo: true };
}

/**
 * Run the whole report pipeline: resolve the scope, mine fresh clusters, classify
 * them against the store, wrap in the envelope. Read-only like the CLI's report —
 * no upsert, no watermark advance — but not free: every call pays for an index
 * read, because recurrence is defined against fresh evidence.
 *
 * Returns null when there is no memory store. Checked by PATH because
 * getMemoryDb() would CREATE the file as a side effect of asking (store.ts), and
 * the MCP read-only provenance guard's byte-compare cannot see a newly created
 * empty db. An absent store is an empty report, not an error — each caller renders
 * its own friendly form of that (CLI stderr note, MCP sentinel).
 */
export async function runRecurrence(opts: {
  repo?: string;
  all?: boolean;
  since?: string;
  /** 'YYYY-MM-DD'; passed in because the no-clock-read rule extends to this module. */
  today: string;
  /** Called once the scope is resolved, before the mine — the CLI's progress lines. */
  onScope?: (scope: ReportScope) => void;
}): Promise<{ scope: ReportScope; report: RecurrenceEnvelope } | null> {
  if (!existsSync(getMemoryDbPath())) return null;
  const scope = resolveReportScope(opts);
  opts.onScope?.(scope);
  const mined = await mine({ repo: scope.repo });
  // Suppressed rows stay out of the report exactly as they stay out of the triage
  // batch — this is the write-through the phase-3 spec's failure table names: the
  // skill's fuzzy-pair deny is a `snooze` (SKILL.md step 2), and without this filter
  // a denied pair would be re-asked on every report run. The report never upserts,
  // so the live store contents ARE the pre-upsert snapshot dropSuppressed's
  // contract asks for, and shouldResurface's inert-in-mine second condition
  // (triage.ts:76-79) is inert here for the same reason.
  const clusters = dropSuppressed(mined, suppressedMemories(), opts.today);
  const report = classifyRecurrence(clusters, listMemories(), { since: opts.since });
  return { scope, report: { generatedAt: opts.today, lastMinedAt: lastMinedAt(), ...report } };
}
