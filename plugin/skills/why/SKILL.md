---
name: why
description: >-
  Explain why a piece of code exists by correlating it to the AI coding
  sessions behind it. Use when the user asks "why does this exist", "why
  did we write it this way", "what was the reasoning behind this
  line/file/commit", "who changed this and why", or points at a file,
  line, or commit and wants the rationale that git alone does not carry.
  Use PROACTIVELY before rewriting or removing code whose purpose is
  unclear — the deciding conversation may still be recoverable.
argument-hint: a file path, path:line, commit-ish, or topic
---

Explain why code exists by finding the session that produced it.

## Steps

1. **Call `why_did_this_change`** with the user's target as `target`:
   - A file → `src/cache.ts`
   - A specific line → `src/cache.ts:142` (pins the commit via git blame)
   - A commit → a sha, tag, or `HEAD~2`
   - A topic → free text (searches sessions in this repo, no git)

   The tool is read-only: it never writes to the repository.

2. **Read the evidence.** The result carries the resolved `commit` (subject, author
   time, files, trailers; `null` for the free-text form) and ranked `sessions`. Trust
   `confidence`: `files+time` (the session edited the committed files inside its window)
   is stronger than `time-only` (same repo and window, no file overlap). Two flags change
   how you read the commit: `commit.merge: true` means this is the merge that landed the
   change, not the commit that wrote it — the reasoning lives in the sessions, not the
   merge subject. A non-empty `unlandedAttempts` (file form only) means sessions touched
   this file but no commit ever landed from them — a possible abandoned attempt.

3. **Synthesize a short answer** from each session's `excerpts` and `headline`. Explain
   the reasoning and any abandoned approaches — the part git does not record. Do not
   invent rationale the excerpts do not support.

4. **Cite each session** you used: its tool, date (`startedAt`), and headline. Distinguish
   `files+time` matches from `time-only` matches so the user can weigh them.

5. **Check closed PRs before concluding "fixed".** When the question is "was this
   fixed" or "does this bug still exist", git history alone is not proof: a fix may
   have been tried and rejected without leaving a commit. If the repo has a GitHub
   remote and `gh` is available, run `gh search prs --state closed -- <terms>` (or
   `gh pr list --search "<file>" --state closed`) and report a closed-unmerged attempt
   alongside any merged fix. Skip silently when `gh` or a GitHub remote is absent.

6. **Offer a deep-dive.** If the user wants more, call `get_session_messages` with a
   session's `filePath` (use an `excerpts[].msgIndex` as the offset) to read the full
   exchange.

## Guidelines

- Empty `sessions` is a real answer: say no session correlates, rather than guessing.
- A `time-only` match is a weak signal — present it as "around the same time", not as cause.
- Surface commit `trailers` (e.g. Co-Authored-By) when present; they annotate authorship.
- Lead with the why, then the citations. Keep it to a few sentences unless asked for more.
