# `sessions wrapped` — research & design notes

_2026-07-13 · deep-research synthesis (5 agents: report-pipeline map, content-layer map, CLI conventions, Spotify Wrapped design research, dev-tool year-in-review precedents) + implementation decisions._

## Why these metrics

Two data sources with different truths, deliberately split:

| Source                                                            | Truth it holds                 | Metrics built on it                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report pipeline `UsageEvent[]` (re-parsed JSONL, full timestamps) | tokens, cost, per-message time | totals, receipt, streaks, rhythm heatmap, nights past midnight, longest **sitting**, biggest day, model adoption dates, cache hit rate            |
| Search index (`message_fts` + `sessions`)                         | what was actually said         | phrase censuses, monologue asymmetry, drive-bys, abandoned project, session of the year (significanceScore), word of the year, top files/commands |

Key mechanics locked during research (verified live against the real index):

- **Phrase counting uses `LIKE`, never FTS `MATCH`** — porter stemming makes phrase queries fuzzy ("wait" matches "waiting") and `MATCH` counts rows regardless. Counts are messages-containing, which is dispute-proof.
- **Token math matches `sessions report`** (input + output + cacheWrite; cacheRead excluded) so the two commands never disagree. Cache reads get their own line on the receipt card.
- **Sessions counted as distinct `tool|sessionId` over raw events** — `aggregate()`'s summary double-counts cross-midnight sessions (sum-of-daily).
- **Longest sitting, not longest session**: resumed sessions span weeks; events are split into continuous runs (≤ 30 min gaps).
- **Session of the year uses `significanceScore` alone** (not `blendedScore` — recency decay would bury January).
- **Depth median excludes drive-bys** (≤ 2 messages): the distribution is bimodal and the raw median lands in the trivia lobe.
- **Vendored files (`aggregate.ts`, `types.ts`, parsers/util, pi, project) are never edited** — wrapped layers on top of `aggregate()` output plus its own event pass.

## Dynamic fun-slide selection (the personalization mechanism)

Every fun stat is a scored candidate (`select.ts`); saturating notability scores (`1 − e^(−count/mid)`) with per-stat thresholds. Only the top candidates render, grouped into three themed cards (friction reel / relationship / bloopers) — a card drops entirely if its lead stat doesn't clear the bar. Consequences:

- No "0 times" filler slides (the one deliberate exception: the "you're absolutely right" zero-joke).
- Graceful degradation and personalization are the same mechanism — no index → no fun cards, page still works.
- Corpus-mined **word of the year**: TF over genuine user prompts, ~700-word stop list (common English + dev-generic), required spread ≥ 8 sessions so one rant can't win.
- `--extras <json>` injects agent-authored slides (cap 6, shape-validated) — the LLM tier lives outside the binary, which stays offline/deterministic.

## Design rules applied (from the Wrapped research)

Story not dashboard (one stat per full-viewport scroll-snap card, payoffs late, persona as climax) · numerals as artwork (echo layer) · flat text panels over decoration (the 2021→2024 legibility lesson) · limited palette = the report's six OKLCH accents, one per card · self-relative comparisons only, never invented percentiles (the Spotify-2024 trust failure) · hedged copy on disputable stats ("pastes count", "failing greps count") · evidence printed on the persona card (the "Pink Pilates Princess" lesson: never a label the user can't verify) · data-horizon disclosure ("data begins Feb 11 — transcripts pruned") · self-contained HTML, no external requests, textContent-only JS, `prefers-reduced-motion` honored.

Persona recipe (Spotify Listening Personality, adapted): 3 median-split behavioral axes → 8 flattering archetypes. Clock (night share ≥ 25%), Focus (top-project token share ≥ 40%), Depth (median engaged-session turns ≥ 40). Interrupt rate is display-only flavor, not a fourth split.

## Known limitations (reviewed and accepted for v1)

Both surfaced by the adversarial review (fable-5 4-lens workflow + independent gpt-5.5/codex pass) and accepted as indexer-level constraints, not wrapped bugs:

- **Index dates are UTC-sliced** (`created_at`/`date` come from `ts.slice(0,10)`) while event stats bucket in local tz — content stats can disagree with event stats by one day near midnight UTC. Time-of-day is not stored in the index, so wrapped cannot convert. The cursed-weekday footnote discloses UTC attribution. Fix would be a schema bump storing local dates or timestamps.
- **Forked/resumed Claude transcripts duplicate history in the index** — the report pipeline dedupes usage by `message.id|requestId`, but `message_fts` has no message ids, so a phrase copied into a fork counts once per copy. Phrase-census copy says "messages containing each phrase," which is literally what is counted. Fix would be indexer-level dedup (affects search semantics too — forks are deliberately findable).

Content-stat period semantics: **sessions started within the calendar year** (`created_at` in range) — overlap semantics would import entire prior-December sessions into the new year and were rejected in review.

## Deferred / follow-ups

- **Retention**: transcripts prune (~6 months survive); a December run won't cover January. Option: persist monthly aggregate snapshots. For now the page discloses its horizon.
- **Share export (shipped)**: one canvas card on a dedicated slide after the persona, at 1200x630 and 1080x1920, with a six-accent picker and a reroll for the token comparison. One image, not one per section: the deck's card count varies per user (no cost card on a local-model year, variable `fun`/`extras`), so a per-section export would be a screenshot lottery, and the chart slides carry their meaning in hover tooltips that do not survive flattening. Painted from a block list rather than fixed coordinates — two aspects and a swappable comparison line mean nothing can be pinned to a fixed y. Verified by `src/wrapped/share-card.test.ts`, which runs the painter's template-string JS against a stub DOM and a recording 2D context.
- **Roast mode (shipped)**: `--roast` sends the stats-only digest to an installed agent CLI (`claude`→`codex`→`pi`, or `--roast-with`), validates the returned slides through the shared `coerceExtras`, and stamps provenance. Opt-in, fails open, rides the user's own auth. Chosen over a `/wrapped` plugin skill (tool-specific, needs install/update) because wrapped's users definitionally have an agent CLI installed. Deeper snippet-level roasting (feeding the model actual message excerpts) deferred — stats-only avoids the latency/cost/hallucination jump and the privacy surface.
- **Tool-call league table** (Bash vs Edit vs Read counts): needs a full JSONL re-parse; the `commands` column proxy was judged enough for v1.
- Per-tool data asymmetry (Pi: no files/commands; Codex: no files_read, cacheWrite always 0) is footnoted, not normalized.
