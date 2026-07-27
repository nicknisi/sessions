// Retrieval quality harness: index the synthetic corpus in `__fixtures__`, run every
// query in queries.ts, and report recall@5 and payload size per query class. The ranking
// constants in cache.ts (the `RANKING` record — bm25 column weights, the user-hit boost,
// short-message damping, the finalRank sum) are hand-tuned and otherwise have no
// regression signal — this is that signal. Run it standalone with `bun run eval`;
// eval.test.ts asserts the recorded baseline against ./floors, and mutation.test.ts
// reverts each constant in turn and asserts one of those floors breaks.
//
// Fixtures live at __fixtures__/<tool>/<project-dir>/<session-id>.jsonl in the shapes
// each tool actually writes, so the whole indexing path runs unmodified. The filename
// is the session id queries.ts refers to. Adding or editing one changes every number
// below, so re-record: `bun run eval > docs/eval-baseline.md`.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchSessions, grepSessions, refreshIndex, closeDb } from '../cache';
import { formatResult } from '../search-format';
import type { SessionResult } from '../types';
import { HARNESS_ONLY_TERM, NOISE_ONLY_TERM, QUERIES, type EvalQuery, type QueryClass } from './queries';

export const CORPUS_DIR = join(import.meta.dir, '__fixtures__');
/** Transcripts in the corpus. Asserted, so a fixture that stops parsing is loud. */
export const CORPUS_SIZE = 30;

/** The k in recall@k — and the page a caller pays for, so payload is measured here too. */
export const K = 5;
/** Fetched beyond k purely to report how far off a miss was. */
const WINDOW = 10;

export const CLASSES: QueryClass[] = [
  'exact-error-string',
  'file-path',
  'command',
  'multi-word-natural-language',
  'scoped',
  'negative',
];

export interface QueryOutcome {
  id: string;
  class: QueryClass;
  query: string;
  expect: string[];
  /** Top-k session ids, best first. */
  returned: string[];
  /** 1-based rank of each expected id within the fetched window; null when absent. */
  ranks: (number | null)[];
  /** Share of expected ids inside the top k. Always 1 for the negative class (nothing to find). */
  recall: number;
  /** Share of expected ids at rank 1. recall@5 saturates on a corpus this size; this does not. */
  recallAt1: number;
  /** 1/rank of the best-placed expected id, 0 if none was found. The rank-sensitive metric. */
  reciprocalRank: number;
  /** Ids a filter should have excluded but that came back anyway. */
  leaks: string[];
  /** Serialized chars of the top-k payload the caller receives. */
  chars: number;
}

export interface ClassReport {
  class: QueryClass;
  queries: number;
  recallAt5: number;
  recallAt1: number;
  mrr: number;
  medianChars: number;
  maxChars: number;
  medianTokens: number;
  maxTokens: number;
}

export interface EvalReport {
  outcomes: QueryOutcome[];
  classes: ClassReport[];
  /** Sessions the index actually holds — the corpus sanity check. */
  indexed: number;
  /** Hits for HARNESS_ONLY_TERM. Must be 0; see the constant's doc comment. */
  harnessOnlyHits: number;
  /** Search hits for NOISE_ONLY_TERM. Must be 0; see the constant's doc comment. */
  noiseOnlyHits: number;
  /** Grep hits for the same term. Must NOT be 0 — that is what makes the line above a
   *  read-path filter rather than a hole in the index. */
  noiseGrepHits: number;
}

/** chars/4, the usual rough token estimate; enough to price a recall gain. */
function tokens(chars: number): number {
  return Math.round(chars / 4);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// The payload carries absolute transcript paths, so its length would otherwise depend
// on where the repo is checked out. Swapping the corpus root for a fixed placeholder
// makes the recorded char counts comparable across machines.
function payloadChars(results: SessionResult[]): number {
  const json = JSON.stringify(results.map(formatResult));
  return json.split(CORPUS_DIR).join('/corpus').length;
}

async function runQuery(q: EvalQuery): Promise<QueryOutcome> {
  const results = await searchSessions(q.query, {
    tool: q.opts?.tool ?? '',
    project: q.opts?.project ?? '',
    limit: WINDOW,
  });
  const ids = results.map((r) => r.sessionId);
  const top = ids.slice(0, K);
  const ranks = q.expect.map((id) => {
    const i = ids.indexOf(id);
    return i === -1 ? null : i + 1;
  });
  const found = q.expect.filter((id) => top.includes(id)).length;
  const best = Math.min(...ranks.map((r) => r ?? Infinity));
  return {
    id: q.id,
    class: q.class,
    query: q.query,
    expect: q.expect,
    returned: top,
    ranks,
    // A negative query has nothing to recall; scoring it 1 keeps the class average
    // meaningful (its real signal is the returned count, recorded below).
    recall: q.expect.length === 0 ? 1 : found / q.expect.length,
    recallAt1: q.expect.length === 0 ? 1 : ranks.filter((r) => r === 1).length / q.expect.length,
    reciprocalRank: q.expect.length === 0 ? 1 : Number.isFinite(best) ? 1 / best : 0,
    leaks: (q.forbid ?? []).filter((id) => top.includes(id)),
    chars: payloadChars(results.slice(0, K)),
  };
}

function summarize(outcomes: QueryOutcome[]): ClassReport[] {
  return CLASSES.map((cls) => {
    const own = outcomes.filter((o) => o.class === cls);
    const chars = own.map((o) => o.chars);
    const maxChars = chars.length > 0 ? Math.max(...chars) : 0;
    const med = median(chars);
    const mean = (pick: (o: QueryOutcome) => number): number =>
      own.length === 0 ? 0 : own.reduce((sum, o) => sum + pick(o), 0) / own.length;
    return {
      class: cls,
      queries: own.length,
      recallAt5: mean((o) => o.recall),
      recallAt1: mean((o) => o.recallAt1),
      mrr: mean((o) => o.reciprocalRank),
      medianChars: med,
      maxChars,
      medianTokens: tokens(med),
      maxTokens: tokens(maxChars),
    };
  });
}

/**
 * Index the fixture corpus into a throwaway cache dir and score every query.
 * Points SESSIONS_* at the fixtures for the duration and restores them after, so a
 * test file that runs later in the same process is not left aimed at a deleted dir.
 */
export async function runEval(): Promise<EvalReport> {
  const keys = [
    'SESSIONS_CACHE_DIR',
    'SESSIONS_CLAUDE_DIR',
    'SESSIONS_PI_DIR',
    'SESSIONS_CODEX_DIR',
    'SESSIONS_OPENCODE_DB',
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const cacheDir = mkdtempSync(join(tmpdir(), 'sessions-eval-'));

  process.env.SESSIONS_CACHE_DIR = cacheDir;
  process.env.SESSIONS_CLAUDE_DIR = join(CORPUS_DIR, 'claude');
  process.env.SESSIONS_PI_DIR = join(CORPUS_DIR, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(cacheDir, 'absent-codex');
  process.env.SESSIONS_OPENCODE_DB = join(cacheDir, 'absent-opencode.db');
  closeDb(); // next query opens against our cache dir, not a prior test file's

  try {
    const { total } = await refreshIndex();
    const outcomes: QueryOutcome[] = [];
    for (const q of QUERIES) outcomes.push(await runQuery(q));
    // Both probes run with includeAutomated so a miss is proof about the text itself,
    // not just that its session was filtered out by cwd.
    const harness = await searchSessions(HARNESS_ONLY_TERM, { limit: WINDOW, includeAutomated: true });
    const noise = await searchSessions(NOISE_ONLY_TERM, { limit: WINDOW, includeAutomated: true });
    const noiseGrep = await grepSessions(NOISE_ONLY_TERM, { limit: WINDOW });
    return {
      outcomes,
      classes: summarize(outcomes),
      indexed: total,
      harnessOnlyHits: harness.length,
      noiseOnlyHits: noise.length,
      noiseGrepHits: noiseGrep.totalHits,
    };
  } finally {
    closeDb();
    rmSync(cacheDir, { recursive: true, force: true });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// oxfmt pads markdown tables out to the widest cell, so emit them that way — otherwise
// regenerating the baseline leaves the repo failing `bun run format:check`.
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, 3, ...rows.map((r) => r[i]!.length)));
  const row = (cells: string[]): string => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [row(headers), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(row)];
}

/** The committed baseline document, so a recall gain shows its token cost in the same diff. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('# Retrieval eval baseline');
  lines.push('');
  lines.push(
    `Measured over the ${report.indexed}-transcript synthetic corpus in \`src/eval/__fixtures__\`. ` +
      'Regenerate with `bun run eval > docs/eval-baseline.md`; the output is deterministic, so a diff here means retrieval behavior changed.',
  );
  lines.push('');
  lines.push(`Payload is the serialized top-${K} \`search_sessions\` result page, in chars (~chars/4 tokens).`);
  lines.push(
    'recall@5 saturates on a corpus this size, so recall@1 and MRR (over a 10-result window) are the ' +
      'metrics that move when the ranking constants do.',
  );
  lines.push('');
  lines.push(
    ...table(
      ['class', 'queries', 'recall@5', 'recall@1', 'MRR', 'median chars', 'max chars', 'median tokens', 'max tokens'],
      report.classes.map((c) => [
        c.class,
        String(c.queries),
        // A negative query has no answer to rank, so its recall cells would read 100%
        // and mean nothing. The class's real numbers are in its own section below.
        ...(c.class === 'negative' ? ['n/a', 'n/a', 'n/a'] : [pct(c.recallAt5), pct(c.recallAt1), c.mrr.toFixed(2)]),
        String(c.medianChars),
        String(c.maxChars),
        String(c.medianTokens),
        String(c.maxTokens),
      ]),
    ),
  );
  lines.push('');
  lines.push('## Per query');
  lines.push('');
  lines.push('`rank` is the 1-based position of the expected session; `—` means it was outside the top 10.');
  lines.push('');
  lines.push(
    ...table(
      ['id', 'class', 'rank', 'chars', 'top result'],
      report.outcomes
        .filter((o) => o.class !== 'negative')
        .map((o) => [
          o.id,
          o.class,
          o.ranks.map((r) => r ?? '—').join(', '),
          String(o.chars),
          o.returned[0] ?? '(none)',
        ]),
    ),
  );
  lines.push('');
  const misses = report.outcomes.filter((o) => o.class !== 'negative' && o.reciprocalRank < 1);
  if (misses.length > 0) {
    lines.push('## Misses');
    lines.push('');
    lines.push('Queries whose answer is not first. What beat it, and why it was allowed to:');
    lines.push('');
    for (const o of misses) {
      const q = QUERIES.find((x) => x.id === o.id)!;
      lines.push(`- **${o.id}** — beaten by \`${o.returned[0]}\`. ${q.competes}.`);
    }
    lines.push('');
  }
  lines.push('## Negative queries (characterization)');
  lines.push('');
  lines.push(
    'Nothing in the corpus answers these. The OR-join in `searchSessions` means any single ' +
      'matching term is enough to return a session, so junk comes back and the caller pays for it. ' +
      'These rows record what happens today; they are not the desired behavior.',
  );
  lines.push('');
  lines.push(
    ...table(
      ['id', 'query', 'results', 'chars', 'top result'],
      report.outcomes
        .filter((o) => o.class === 'negative')
        .map((o) => [o.id, o.query, String(o.returned.length), String(o.chars), o.returned[0] ?? '(none)']),
    ),
  );
  lines.push('');
  return lines.join('\n');
}

if (import.meta.main) {
  const report = await runEval();
  process.stdout.write(formatReport(report));
}
