---
name: memory
description: >-
  Triage context-memory candidates mined from past AI coding sessions. Use when
  the user says "triage memory", "review memory", "mine memory", "/memory", or
  asks what durable facts their session history contains. Runs the mine, clusters
  paraphrased candidates, judges which facts generalize beyond the session they
  came from, and walks approve / reject / snooze, including marking standing
  constraints always-on and assigning project groups.
argument-hint: repo path (optional, defaults to current repo)
---

Turn mined candidate turns into a small set of durable facts worth remembering.

## Steps

1. **Run the mine.** `sessions memory mine --repo <path> --json` (omit `--repo` for the current repo; `--all` mines every repo in the index; add `--since-last` to mine only transcripts that changed since the previous mine, which is what the weekly summary uses). stdout is a JSON array of candidate records; progress goes to stderr. If the command is not found, say so and stop — do not substitute a search. If the array is empty, say there is nothing to triage and stop; never invent candidates.

2. **Cluster paraphrases.** Group candidates whose texts assert the same fact in different words — "use canary as the base branch" and "we branch off canary" are one memory in two phrasings. A cluster's `distinctPhrasings` is the number of distinct member texts. Keep the clearest phrasing as the cluster's `text`; the rest are evidence, not separate memory. Byte-identical repeats were already collapsed upstream, so every member you see is genuinely a different wording.

3. **Apply the generalizability rubric.** For each cluster ask: _does this fact hold beyond the session it appeared in?_ Propose only the clusters that pass.
   - **Passes** — standing constraints ("API keys go in the keychain when available"), repo or tooling facts ("this repo branches off canary", "skills can invoke inline scripts"), architectural rules.
   - **Fails** — one-off task instructions ("make it Ideation instead of docs/ideation", "let's do a single PR"), bug reports ("syntax highlighting isn't loading"), anything naming a specific transient artifact.
   - **Fails loudly** — text that reads like a copy-pasted prompt or eval fixture. A suspiciously boilerplate candidate is chaff, not signal.
   - Assign `kind`: `instruction` for "do this / don't do that", `information` for "this is how the world is".

4. **Walk triage.** One `AskUserQuestion` per cluster, batching up to 4 independent clusters per call. For each, show the text, the derived scope (`repo` with its container, or `workflow`), `distinctPhrasings`, and the `firstSeen`–`lastSeen` range. Options: **Approve**, **Approve as always-on**, **Reject**, **Snooze** (hide without a verdict).

   Offer **Approve as always-on** only when the fact is a standing constraint an agent must see no matter what it is working on — "canary is the mainline branch", "API keys go in the keychain". Retrieval is topic-conditional by default, so a normal approval means the memory comes back only when the task looks related. Always-on is the exception, and proposing it for everything defeats the filter.

5. **Persist.** One command per decision, using the cluster's `id`:
   - `sessions memory approve <id>` (add `--always-on` for a standing constraint)
   - `sessions memory reject <id>`
   - `sessions memory snooze <id>`

   Each exits non-zero on an unknown id, so a failure means the decision was not recorded — surface it rather than reporting success.

   If the user says a fact applies to a set of related repos rather than just this one, assign a project group: `sessions memory approve <id> --scope group:<name>`. Only ask when they volunteer it — group membership comes from `~/.local/share/sessions/groups.json`, which the user maintains by hand, and a group they have not configured there is silently never returned. Say so if you assign one.

6. **Report.** Proposed count, approved count, and the ratio. That ratio is the number the precision goal is measured on, so state it plainly even when it is bad.

## Guidelines

- Propose only what passes the rubric. Dumping every narrowed candidate on the user is the failure mode that trains people to reject the whole list without reading it — a short, high-precision proposal is the point.
- Records already carry a `state`. Triage the `candidate` ones and leave `approved` records alone unless the user asks to revisit them. Rejected candidates never appear, and in practice neither do snoozed ones: resurface needs a record's distinct-phrasing count to grow, and the mine gives every phrasing its own record, so the count never grows. If a `snoozed` record ever does reach the batch, it has resurfaced — say so when you present it.
- `repo` and `workflow` scope are derived from evidence and are shown, not edited. The one assignable scope is `group`, and only because no derivation can reach it — the index cannot tell "these four repos share a convention" from "this is universal".
- Never paste raw session text you did not get from the batch — records deliberately carry no verbatim quotes.
- Snooze means "not now, and stop asking". It is designed to return a candidate that keeps being said in new words, but that trigger is not implemented yet, so today a snooze hides the candidate indefinitely. Still prefer it over reject when the fact might be real but the evidence is thin — snooze records no verdict, and tell the user it will not come back on its own so the choice is informed.
