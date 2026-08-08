// The golden fixture: the queries search ranking is held to, the gates they must
// pass, and the version that ties them to the corpus. Discipline in docs/EVAL.md.
//
// Classes:
//  - lexical          concrete cues: error strings, paths, commands, identifiers
//  - natural-language the LLM/MCP caller's long OR-recall queries
//  - ranking          two sessions share the term; the ORDER is the expectation
//  - filter           tool/project/errored/files narrowing (pass/fail, not metric)
//  - negative         no lexical overlap with the corpus; must return ZERO results
//                     (a lexical engine's abstention: no signal, no answer)

import type { SearchOptions } from '../cache';

export const EVAL_V = 'golden-v1';

/** Recall is measured at this depth, matching the MCP caller's typical ask. */
export const RECALL_K = 5;

/** Hard gates. recall/mrr are floors across the positive goldens; negatives is a
 *  pass rate and must stay perfect — a regression there means noise ranked. */
export const GATES = { recallAtK: 0.9, mrr: 0.7, negatives: 1.0 } as const;

export type GoldenClass = 'lexical' | 'natural-language' | 'ranking' | 'filter' | 'negative';

export interface GoldenQuery {
  id: string;
  class: GoldenClass;
  query: string;
  opts?: SearchOptions;
  /** Sessions that must appear in the top RECALL_K results (recall numerator). */
  top?: string[];
  /** Session that must be the #1 result — asserted individually, not just metric. */
  first?: string;
  /** Sessions that must not appear in the results at all. */
  absent?: string[];
  /** The query must return zero results. */
  negative?: boolean;
  /** Why this golden exists — the fixture's memory of what it guards. */
  note?: string;
}

export const GOLDEN: GoldenQuery[] = [
  // ——— lexical ———
  { id: 'error-string', class: 'lexical', query: 'ECONNREFUSED', top: ['docker-dev'], first: 'docker-dev' },
  { id: 'error-token', class: 'lexical', query: 'invalid_redirect_uri', top: ['auth-oauth'], first: 'auth-oauth' },
  { id: 'error-code', class: 'lexical', query: 'ERESOLVE', top: ['react-upgrade'], first: 'react-upgrade' },
  {
    id: 'shared-path',
    class: 'lexical',
    query: 'middleware.ts',
    top: ['auth-jwt', 'auth-oauth'],
    note: 'Both auth sessions reference the file (edit vs read); order deliberately unpinned.',
  },
  { id: 'command-phrase', class: 'lexical', query: 'docker compose up', top: ['docker-dev'], first: 'docker-dev' },
  { id: 'filename', class: 'lexical', query: 'vitest.config', top: ['flaky-test'], first: 'flaky-test' },
  { id: 'command-flag', class: 'lexical', query: 'react@19', top: ['react-upgrade'], first: 'react-upgrade' },
  { id: 'other-lang-command', class: 'lexical', query: 'go test', top: ['golang-api'], first: 'golang-api' },
  { id: 'migration-file', class: 'lexical', query: '0042_orders.sql', top: ['db-migration'], first: 'db-migration' },
  {
    id: 'user-turn-term',
    class: 'lexical',
    query: 'memoize',
    top: ['perf-planner'],
    first: 'perf-planner',
    note: 'Term lives only in a genuine user turn — exercises message_fts recall.',
  },

  // ——— natural language (LLM/MCP caller shape) ———
  {
    id: 'nl-containers',
    class: 'natural-language',
    query: 'set up containers for local development',
    top: ['docker-dev'],
    first: 'docker-dev',
  },
  {
    id: 'nl-hang',
    class: 'natural-language',
    query: 'why does the test hang in ci',
    top: ['flaky-test'],
    first: 'flaky-test',
    note: 'OR-recall: common terms (the/test) match widely; rare terms (hang/ci) must dominate.',
  },
  {
    id: 'nl-deps',
    class: 'natural-language',
    query: 'upgrade dependencies',
    top: ['react-upgrade'],
    first: 'react-upgrade',
  },
  {
    id: 'nl-pagination',
    class: 'natural-language',
    query: 'add pagination handlers',
    top: ['golang-api'],
    first: 'golang-api',
  },
  {
    id: 'nl-cross-tool',
    class: 'natural-language',
    query: 'rename cli flag',
    top: ['pi-flag'],
    first: 'pi-flag',
    note: 'A pi session must be findable through the same engine.',
  },

  // ——— ranking (order is the expectation) ———
  {
    id: 'rank-auth',
    class: 'ranking',
    query: 'auth middleware',
    top: ['auth-jwt', 'auth-oauth'],
    first: 'auth-jwt',
    note: 'Headline + command + edit beats a read-only mention of the same path.',
  },
  {
    id: 'rank-column-weights',
    class: 'ranking',
    query: 'cache',
    top: ['rank-tune', 'perf-planner'],
    first: 'rank-tune',
    note: 'A paths-column hit (weight 5.0) must outrank a thinking-only hit (weight 0.5).',
  },

  // ——— filter ———
  {
    id: 'filter-errored',
    class: 'filter',
    query: '',
    opts: { errored: true },
    top: ['docker-dev', 'auth-oauth', 'db-migration', 'react-upgrade'],
    absent: ['chatter', 'css-navbar'],
  },
  {
    id: 'filter-files',
    class: 'filter',
    query: '',
    opts: { files: ['src/logger.ts'] },
    top: ['logging'],
    absent: ['auth-jwt', 'rank-tune'],
  },
  {
    id: 'filter-project',
    class: 'filter',
    query: 'middleware',
    opts: { project: '/repo/authapi' },
    top: ['auth-jwt', 'auth-oauth'],
    absent: ['rank-tune'],
    note: 'rank-tune also matches the term but lives in /repo/sessions.',
  },
  { id: 'filter-tool-pi', class: 'filter', query: 'rename', opts: { tool: 'pi' }, top: ['pi-flag'] },
  {
    id: 'filter-tool-claude',
    class: 'filter',
    query: 'rename',
    opts: { tool: 'claude' },
    negative: true,
    note: 'The only rename session is pi; a claude-scoped query must come back empty.',
  },

  // ——— negative (must abstain: zero results) ———
  { id: 'neg-infra', class: 'negative', query: 'kubernetes pod autoscaling', negative: true },
  { id: 'neg-lang', class: 'negative', query: 'borrow checker lifetime', negative: true },
  { id: 'neg-gibberish', class: 'negative', query: 'zxqwv plugh', negative: true },
];
