# Retrieval eval baseline

Measured over the 30-transcript synthetic corpus in `src/eval/__fixtures__`. Regenerate with `bun run eval > docs/eval-baseline.md`; the output is deterministic, so a diff here means retrieval behavior changed.

Payload is the serialized top-5 `search_sessions` result page, in chars (~chars/4 tokens).
recall@5 saturates on a corpus this size, so recall@1 and MRR (over a 10-result window) are the metrics that move when the ranking constants do.

| class                       | queries | recall@5 | recall@1 | MRR  | median chars | max chars | median tokens | max tokens |
| --------------------------- | ------- | -------- | -------- | ---- | ------------ | --------- | ------------- | ---------- |
| exact-error-string          | 5       | 100%     | 100%     | 1.00 | 4559         | 6252      | 1140          | 1563       |
| file-path                   | 5       | 100%     | 100%     | 1.00 | 754          | 937       | 189           | 234        |
| command                     | 6       | 100%     | 83%      | 0.92 | 4037         | 4393      | 1009          | 1098       |
| multi-word-natural-language | 8       | 100%     | 88%      | 0.94 | 5891         | 6359      | 1473          | 1590       |
| scoped                      | 6       | 100%     | 100%     | 1.00 | 1511         | 2177      | 378           | 544        |
| negative                    | 5       | n/a      | n/a      | n/a  | 4920         | 5519      | 1230          | 1380       |

## Per query

`rank` is the 1-based position of the expected session; `—` means it was outside the top 10.

| id                             | class                       | rank | chars | top result                           |
| ------------------------------ | --------------------------- | ---- | ----- | ------------------------------------ |
| err-stripe-signature           | exact-error-string          | 1    | 6252  | s01-stripe-webhook-signature         |
| err-postgres-econnrefused      | exact-error-string          | 1    | 2915  | s04-postgres-connection-refused      |
| err-subscription-typeerror     | exact-error-string          | 1    | 4559  | s08-subscription-undefined-typeerror |
| err-ts2345                     | exact-error-string          | 1    | 5538  | s13-typescript-strict-errors         |
| err-sentry-module-not-found    | exact-error-string          | 1    | 3473  | s14-sentry-module-not-found          |
| path-stripe-webhook            | file-path                   | 1    | 754   | s01-stripe-webhook-signature         |
| path-paddle-webhook            | file-path                   | 1    | 689   | s02-paddle-webhook-signature         |
| path-dunning-migration         | file-path                   | 1    | 937   | s06-dunning-queue-switch             |
| path-invoice                   | file-path                   | 1    | 857   | s18-invoice-rounding                 |
| path-tailwind-config           | file-path                   | 1    | 591   | s15-tailwind-config-purge            |
| cmd-prisma-migrate-deploy      | command                     | 2    | 3800  | s17-worker-postgres-split            |
| cmd-terraform-rds              | command                     | 1    | 2264  | s11-terraform-rds-apply              |
| cmd-docker-compose-postgres    | command                     | 1    | 4368  | s17-worker-postgres-split            |
| cmd-bun-test-filter            | command                     | 1    | 4393  | s18-invoice-rounding                 |
| cmd-gh-pr-release              | command                     | 1    | 2927  | s19-release-pr-automation            |
| cmd-aws-logs-tail              | command                     | 1    | 4274  | s26-lambda-log-retention             |
| nl-dunning-cron-to-queue       | multi-word-natural-language | 1    | 6265  | s06-dunning-queue-switch             |
| nl-webhook-signature-fix       | multi-word-natural-language | 2    | 6061  | s02-paddle-webhook-signature         |
| nl-worker-own-database         | multi-word-natural-language | 1    | 5720  | s17-worker-postgres-split            |
| nl-flaky-ci                    | multi-word-natural-language | 1    | 6129  | s12-flaky-ci-tests                   |
| nl-rate-limiting               | multi-word-natural-language | 1    | 5536  | s16-public-api-rate-limiting         |
| nl-digest-duplicate-recipients | multi-word-natural-language | 1    | 6359  | s22-digest-duplicate-sends           |
| nl-unsubscribe-token-lifetime  | multi-word-natural-language | 1    | 5332  | s24-unsubscribe-token-expiry         |
| nl-social-preview-stale        | multi-word-natural-language | 1    | 5711  | s28-social-preview-stale             |
| scoped-webhook-checkout-api    | scoped                      | 1    | 2177  | s01-stripe-webhook-signature         |
| scoped-database-locked-pi      | scoped                      | 1    | 2108  | s10-sqlite-busy-index                |
| scoped-shared-postgres-pi      | scoped                      | 1    | 1636  | s17-worker-postgres-split            |
| scoped-terraform-infra         | scoped                      | 1    | 1386  | s11-terraform-rds-apply              |
| scoped-invoice-billing-worker  | scoped                      | 1    | 1071  | s18-invoice-rounding                 |
| scoped-tmp-webhook-scratch     | scoped                      | 1    | 1232  | s21-tmp-webhook-scratch              |

## Misses

Queries whose answer is not first. What beat it, and why it was allowed to:

- **cmd-prisma-migrate-deploy** — beaten by `s17-worker-postgres-split`. s17 runs the same command with --schema; s04 runs prisma migrate status; s18 prisma generate.
- **nl-webhook-signature-fix** — beaten by `s02-paddle-webhook-signature`. s02 shares every term but stripe; s03 is a throwaway in the right project.

## Negative queries (characterization)

Nothing in the corpus answers these. The OR-join in `searchSessions` means any single matching term is enough to return a session, so junk comes back and the caller pays for it. These rows record what happens today; they are not the desired behavior.

| id                | query                                                   | results | chars | top result                           |
| ----------------- | ------------------------------------------------------- | ------- | ----- | ------------------------------------ |
| neg-kubernetes    | kubernetes ingress certificate renewal                  | 0       | 2     | (none)                               |
| neg-swiftui       | swiftui navigation stack crash on ios 18                | 5       | 5519  | s08-subscription-undefined-typeerror |
| neg-knife         | how do I sharpen a chef knife properly                  | 5       | 5493  | s06-dunning-queue-switch             |
| neg-elasticsearch | elasticsearch cluster stuck yellow after a node restart | 5       | 4920  | s28-social-preview-stale             |
| neg-nonce         | zzyzxqqq                                                | 0       | 2     | (none)                               |
