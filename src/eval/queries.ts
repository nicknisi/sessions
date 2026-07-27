import type { Tool } from '../types';

/**
 * Retrieval shapes a caller actually issues. They fail for different reasons — an
 * exact error string is a rare-token problem, a natural-language question is a
 * many-common-tokens problem — so each class carries its own recall threshold.
 */
export type QueryClass =
  | 'exact-error-string'
  | 'file-path'
  | 'command'
  | 'multi-word-natural-language'
  | 'scoped'
  | 'negative';

export interface EvalQuery {
  id: string;
  class: QueryClass;
  query: string;
  /** Session ids (fixture basenames) that answer the query. Empty for `negative`. */
  expect: string[];
  /** Filters, for the scoped class. */
  opts?: { tool?: Tool; project?: string };
  /** Session ids the filter must exclude — the near-duplicate-project leak check. */
  forbid?: string[];
  /** Which fixtures compete for this query. A query with no competition measures nothing. */
  competes: string;
}

/**
 * A term that appears in the corpus only inside s03's injected harness rows (a
 * <task-notification>). Nothing may match it: if injected text ever reaches the
 * index, that fixture starts competing for every webhook query and stops being a
 * distractor. Probed inside the eval run, where the index is the fixture corpus.
 */
export const HARNESS_ONLY_TERM = 'investigation';

/**
 * A term that appears in the corpus only inside s03's harness-noise rows (the
 * `[Request interrupted by user]` user turn). No SEARCH result may match it: those rows
 * are indexed but denylisted on the read path, and the user-role ones are the worst
 * offenders because they also collect the 1.5× user-hit boost. `grep_sessions` still
 * reaches them, which is the other half of the probe.
 */
export const NOISE_ONLY_TERM = 'interrupted';

/**
 * Every query has a known-correct answer in `src/eval/__fixtures__`, and every
 * answer has at least one distractor sharing its vocabulary. The `competes` note
 * names the distractor so a future ranking change can be reasoned about rather
 * than just re-measured.
 */
export const QUERIES: EvalQuery[] = [
  // ——— exact-error-string: the caller pastes the message they just saw ———
  {
    id: 'err-stripe-signature',
    class: 'exact-error-string',
    query: 'Webhook signature verification failed: no signatures found matching the expected signature',
    expect: ['s01-stripe-webhook-signature'],
    competes: 's02 carries a near-identical paddle signature-verification failure',
  },
  {
    id: 'err-postgres-econnrefused',
    class: 'exact-error-string',
    query: 'connect ECONNREFUSED 127.0.0.1:5432',
    expect: ['s04-postgres-connection-refused'],
    competes: 's05 has the same error on 127.0.0.1:6379',
  },
  {
    id: 'err-subscription-typeerror',
    class: 'exact-error-string',
    query: "TypeError: Cannot read properties of undefined (reading 'subscription')",
    expect: ['s08-subscription-undefined-typeerror'],
    competes: "s09 differs only in the property name ('customer')",
  },
  {
    id: 'err-ts2345',
    class: 'exact-error-string',
    query: "error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'",
    expect: ['s13-typescript-strict-errors'],
    competes: 's04/s05/s08/s09 also store tool_result error text in context_text',
  },
  {
    id: 'err-sentry-module-not-found',
    class: 'exact-error-string',
    query: "Module not found: Can't resolve '@sentry/node'",
    expect: ['s14-sentry-module-not-found'],
    competes: "s15 has the same message for './styles/theme.css' in the same project",
  },

  // ——— file-path: the caller knows the file, not the words ———
  {
    id: 'path-stripe-webhook',
    class: 'file-path',
    query: 'src/webhooks/stripe.ts',
    expect: ['s01-stripe-webhook-signature'],
    competes: 's02 touches src/webhooks/paddle.ts; s03 mentions src/webhooks/index.ts',
  },
  {
    id: 'path-paddle-webhook',
    class: 'file-path',
    query: 'src/webhooks/paddle.ts',
    expect: ['s02-paddle-webhook-signature'],
    competes: 's01 touches src/webhooks/stripe.ts in the near-duplicate project',
  },
  {
    id: 'path-dunning-migration',
    class: 'file-path',
    query: 'migrations/0042_add_dunning_state.sql',
    expect: ['s06-dunning-queue-switch'],
    competes: 's18 writes migrations/0041_add_invoice_totals.sql',
  },
  {
    id: 'path-invoice',
    class: 'file-path',
    query: 'packages/billing/src/invoice.ts',
    expect: ['s18-invoice-rounding'],
    competes: 's06 reads packages/billing/src/dunning.ts; s09 edits src/checkout/invoice.ts',
  },
  {
    id: 'path-tailwind-config',
    class: 'file-path',
    query: 'tailwind.config.ts',
    expect: ['s15-tailwind-config-purge'],
    competes: 's14 edits next.config.ts and sentry.client.config.ts in the same project',
  },

  // ——— command: the caller remembers what was run ———
  {
    id: 'cmd-prisma-migrate-deploy',
    class: 'command',
    query: 'npx prisma migrate deploy',
    expect: ['s06-dunning-queue-switch'],
    competes: 's17 runs the same command with --schema; s04 runs prisma migrate status; s18 prisma generate',
  },
  {
    id: 'cmd-terraform-rds',
    class: 'command',
    query: 'terraform apply -target=module.rds',
    expect: ['s11-terraform-rds-apply'],
    competes: 's07 runs terraform apply -target=module.logs',
  },
  {
    id: 'cmd-docker-compose-postgres',
    class: 'command',
    query: 'docker compose up -d postgres',
    expect: ['s17-worker-postgres-split'],
    competes: 's04 runs docker compose up -d; s05 runs docker compose logs redis',
  },
  {
    id: 'cmd-bun-test-filter',
    class: 'command',
    query: 'bun test --filter billing',
    expect: ['s18-invoice-rounding'],
    competes: 's12 runs bun test --rerun-each 5; s06 runs bun test packages/billing',
  },
  {
    id: 'cmd-gh-pr-release',
    class: 'command',
    query: 'gh pr create --fill --base release',
    expect: ['s19-release-pr-automation'],
    competes: 's12 and s18 both run the plain gh pr create --fill',
  },
  {
    id: 'cmd-aws-logs-tail',
    class: 'command',
    query: 'aws logs tail /aws/lambda/roundup-sender',
    expect: ['s26-lambda-log-retention'],
    competes:
      's27 never ran the command — it weighs up running it, at length, in a thinking block, so the two sessions match in different session_fts columns (commands at bm25 6.0 against thinking at 0.5) and nowhere else',
  },

  // ——— multi-word-natural-language: what the MCP caller actually sends ———
  {
    id: 'nl-dunning-cron-to-queue',
    class: 'multi-word-natural-language',
    query: 'why did we switch the dunning retries from cron to a queue',
    expect: ['s06-dunning-queue-switch'],
    competes: 's07 is the other cron-with-retries session',
  },
  {
    id: 'nl-webhook-signature-fix',
    class: 'multi-word-natural-language',
    query: 'how did we fix the stripe webhook signature verification failure',
    expect: ['s01-stripe-webhook-signature'],
    competes: 's02 shares every term but stripe; s03 is a throwaway in the right project',
  },
  {
    id: 'nl-worker-own-database',
    class: 'multi-word-natural-language',
    query: 'what did we decide about giving the billing worker its own postgres database',
    expect: ['s17-worker-postgres-split'],
    competes: 's04 is the other billing-worker/postgres session',
  },
  {
    id: 'nl-flaky-ci',
    class: 'multi-word-natural-language',
    query: 'what did we do about the flaky tests in CI',
    expect: ['s12-flaky-ci-tests'],
    competes: 'every session runs tests, so only the ranking separates them',
  },
  {
    id: 'nl-rate-limiting',
    class: 'multi-word-natural-language',
    query: 'adding rate limiting to the public API',
    expect: ['s16-public-api-rate-limiting'],
    competes: 's05 and s06 both talk about the queue and backoff',
  },
  {
    id: 'nl-digest-duplicate-recipients',
    class: 'multi-word-natural-language',
    query: 'why is the weekly digest reaching a recipient more than once',
    expect: ['s22-digest-duplicate-sends'],
    competes:
      's23 is debugging the SMTP pool and notes the same duplicate send in a single passing line — the whole of its overlap with the question is that one aside, which is what short-message damping exists to demote',
  },
  {
    id: 'nl-unsubscribe-token-lifetime',
    class: 'multi-word-natural-language',
    query: 'how long does an unsubscribe token stay valid after we mint it',
    expect: ['s24-unsubscribe-token-expiry'],
    competes:
      's25 restates the same 72-hour expiry from the assistant side while writing up key rotation; s24 has it as the question the user typed, which is the only thing separating them',
  },
  {
    id: 'nl-social-preview-stale',
    class: 'multi-word-natural-language',
    query: 'what makes the social preview image go stale after a deploy',
    expect: ['s28-social-preview-stale'],
    competes:
      's29 covers the same staleness in one dense message and nowhere in its metadata; s28 matches both indexes weakly, so it wins on the sum and loses on best-of',
  },

  // ——— scoped: a filter narrows the corpus before ranking ———
  {
    id: 'scoped-webhook-checkout-api',
    class: 'scoped',
    query: 'webhook signature verification',
    expect: ['s01-stripe-webhook-signature'],
    opts: { project: '/eval-corpus/checkout-api' },
    forbid: ['s02-paddle-webhook-signature', 's09-customer-undefined-typeerror', 's13-typescript-strict-errors'],
    competes: 'the near-duplicate /eval-corpus/checkout-api-v2 must not leak past the prefix boundary',
  },
  {
    id: 'scoped-database-locked-pi',
    class: 'scoped',
    query: 'database is locked',
    expect: ['s10-sqlite-busy-index'],
    opts: { tool: 'pi' },
    forbid: ['s04-postgres-connection-refused'],
    competes: 's04 is the loudest "database" session but is a claude transcript',
  },
  {
    id: 'scoped-shared-postgres-pi',
    class: 'scoped',
    query: 'shared postgres database',
    expect: ['s17-worker-postgres-split'],
    opts: { tool: 'pi' },
    forbid: ['s04-postgres-connection-refused', 's05-redis-connection-refused'],
    competes: 's11 (also pi) provisions an rds postgres instance',
  },
  {
    id: 'scoped-terraform-infra',
    class: 'scoped',
    query: 'terraform apply',
    expect: ['s11-terraform-rds-apply'],
    opts: { project: '/eval-corpus/infra' },
    competes: 's07 is in scope and runs terraform apply against a different module',
  },
  {
    id: 'scoped-invoice-billing-worker',
    class: 'scoped',
    query: 'invoice rounding',
    expect: ['s18-invoice-rounding'],
    opts: { project: '/eval-corpus/billing-worker' },
    forbid: ['s09-customer-undefined-typeerror'],
    competes: 's09 builds invoices but lives in checkout-api-v2',
  },

  {
    id: 'scoped-tmp-webhook-scratch',
    class: 'scoped',
    query: 'stripe webhook signature verification',
    expect: ['s21-tmp-webhook-scratch'],
    opts: { project: '/private/tmp/webhook-scratch' },
    competes:
      's21 is a /private/tmp throwaway, removed from every unscoped search — scoping to it directly must bring it back',
  },

  // ——— negative: nothing in the corpus answers these ———
  {
    id: 'neg-kubernetes',
    class: 'negative',
    query: 'kubernetes ingress certificate renewal',
    expect: [],
    competes: 'no k8s session exists; "renewal" and "certificate" appear nowhere',
  },
  {
    id: 'neg-swiftui',
    class: 'negative',
    query: 'swiftui navigation stack crash on ios 18',
    expect: [],
    competes: 'only "stack" and "crash" overlap, and only incidentally',
  },
  {
    id: 'neg-knife',
    class: 'negative',
    query: 'how do I sharpen a chef knife properly',
    expect: [],
    competes: 'entirely out of domain; every content word is absent',
  },
  {
    id: 'neg-elasticsearch',
    class: 'negative',
    query: 'elasticsearch cluster stuck yellow after a node restart',
    expect: [],
    competes: 'infra vocabulary with no matching session',
  },
  {
    id: 'neg-nonce',
    class: 'negative',
    query: 'zzyzxqqq',
    expect: [],
    competes: 'a single token present in no document — the one query FTS can answer with silence',
  },
];
