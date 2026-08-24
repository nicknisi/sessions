# Search eval

Search ranking is governed by a **golden eval fixture**, not by vibes. The fixture
lives in `src/eval/` and runs as part of `bun test` (so CI enforces it); run it on
its own while tuning:

```sh
bun run eval
```

## Layout

| File                    | Role                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/eval/corpus.ts`    | The frozen corpus: ~14 fixture sessions (Claude + pi) with deliberately isolated vocabulary.                            |
| `src/eval/golden.ts`    | The golden queries (`GOLDEN`), the gates (`GATES`), and the fixture version (`EVAL_V`).                                 |
| `src/eval/eval.test.ts` | The runner: seeds the corpus, plays every golden through the real `searchSessions`, prints a report, asserts the gates. |

Golden classes: **lexical** (error strings, paths, commands — the cues people
re-find sessions by), **natural-language** (the LLM/MCP caller's long OR-recall
queries), **ranking** (two sessions share a term; the _order_ is the expectation),
**filter** (tool/project/errored/files narrowing), and **negative** (no lexical
overlap with the corpus — must return zero results. A lexical engine's abstention
is "no signal, no answer", and a regression there means noise ranked).

Gates: `recall@5 ≥ 0.9`, `MRR ≥ 0.7`, negatives abstain `100%` (hard).

## The discipline

Adapted from the ctx project's retrieval eval (`../ctx`). Lexical ranking is the
floor and the subject of this eval: sessions re-finds work by concrete cues
(error strings, paths, commands), which is a lexical problem (see
`docs/superpowers/specs/2026-06-27-search-faster-better-design.md`), and these
gates hold that floor.

Embeddings are not evaluated here. The optional semantic lane (`src/semantic/`,
Ollama-detected, localhost-only) fuses with lexical ranking to catch paraphrase
("flaky tests" finding "intermittent CI failures") — additively, never replacing
lexical. It has its own suite (`src/semantic/semantic.test.ts`) run against a fake
deterministic embedder, so `bun run eval` stays embedder-free and green on any
machine: it executes `searchSessions` with no embedder present, so the fusion lane
never engages and the numbers below measure lexical alone.

1. **The fixture is frozen.** Do not edit an expectation to match whatever the
   ranker currently does. If a golden fails, either the code regressed or the
   golden was wrong about _documented_ behavior — say which in the commit.
2. **Weights move only against the fixture, in coarse steps.** The tunables are
   named constants in `src/cache.ts`: `SESSION_FTS_COLUMN_WEIGHTS`,
   `MESSAGE_FTS_COLUMN_WEIGHTS`, `USER_HIT_BOOST`. Change one, run `bun run eval`,
   keep the change only if a real miss got fixed and the gates stay green.
3. **The fixture grows by logging real misses.** When search fails you in real
   use, add a session + golden that reproduces the miss, then fix the ranker. The
   corpus's vocabulary-isolation rule: before adding a session, grep `corpus.ts`
   for every term its goldens query — two sessions may share a term only when a
   ranking golden pins the intended order between them.
4. **Version the fixture with the config.** Any change to the corpus, the goldens,
   or the gates bumps `EVAL_V`, so a report line always names the exact fixture it
   measured.

## Reading a failure

The aggregate test prints per-class recall, the three gate metrics, and a
`misses:` list naming each failing golden with the ranking it actually got. Fix
the smallest thing that turns it green — a corpus fix, a golden correction, or a
weight move, in that order of preference.
