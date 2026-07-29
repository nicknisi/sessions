---
name: weekly-summary
description: >-
  Generate a comprehensive summary of AI coding sessions from the past week.
  Use when the user says "weekly summary", "what did I do this week",
  "summarize my week", "weekly recap", "week in review", or asks for a
  summary of recent work across projects.
---

Generate a weekly summary of the user's AI coding sessions.

## Steps

1. **Get the date range.** Calculate the start date (7 days ago) and end date (today) in YYYY-MM-DD format.

2. **Fetch the digest.** Call `get_activity_digest` with:
   - `startDate`: 7 days ago
   - `endDate`: today
   - `detail`: `"highlights"` (first + last user messages for substantive sessions)

3. **Review the digest.** Read the response directly — do NOT send it to a subagent. The highlights mode is compact enough to process inline. For each day, identify:
   - Which projects were worked on and what was accomplished
   - Key decisions, pivots, or discoveries (visible in the first/last message pairs)
   - Recurring themes across projects

4. **Drill into key sessions (optional).** If any sessions look particularly significant (high message count, interesting topic) but the highlights don't capture enough detail, call `get_session_messages` on those specific sessions (up to 5) using the `filePath` from the digest.

5. **Write the summary.** Structure it as:

   ### Week of {start} - {end}

   **By the numbers:** {total sessions} sessions, {total messages} messages across {project count} projects.

   **Day-by-day:**
   For each day with activity, write 2-4 bullet points capturing the most significant work. Be specific — name projects, features, and outcomes. Skip days with no meaningful activity.

   **Highlights:** The 3-5 most significant accomplishments across the entire week.

   **Themes:** Recurring work streams or focus areas (e.g., "SDK development", "infrastructure", "bug fixes").

6. **Surface new memory candidates.** Run `sessions memory mine --all --since-last --json`, then `sessions memory pending --json`. The mine picks up only transcripts that changed since the last run, so this is cheap; `--all` is deliberate — a weekly summary spans every project, not whichever repo you happen to be sitting in.

   `--all` advances the watermark for **every** repo, not just this one. That is the point (nothing gets skipped), but it means a later `sessions memory mine --since-last` inside any single repo reports nothing changed until that repo's transcripts move again — this step has already mined them. Say nothing about it here; it is noted so the interaction is not rediscovered as a bug.

   `pending` prints `{"count": N, "preview": [{"id", "text"}]}`. **If the count is zero, say nothing.** Do not add an empty section, do not write "no new memory", do not mention that you checked. Most weeks have nothing, and a recurring empty section trains the user to skim past the whole summary.

   Otherwise close the summary with a short block: the count, up to **three** candidate texts from the preview (the preview holds five; showing three is deliberate), and one line saying to run `/memory` to triage. Do not triage here and never approve, reject, or snooze anything — this is a nudge, not the workflow.

   **This step must never damage the summary.** Unlike `/memory`, which stops loudly when the binary is missing, this one fails silently: if `sessions` is not installed, either command exits non-zero, or the output does not parse, skip the block entirely and finish the summary as written. The summary already succeeded before this step ran.

## Guidelines

- Process the digest inline. Do not spawn a subagent to read it.
- Be specific. Quote project names, feature descriptions, and tool names.
- The first message shows intent; the last message shows outcome. Use both to capture the arc.
- Skip noise — 1-message sessions and test sessions are not worth mentioning.
- If a project appears across multiple days, note the arc of progress.
- Write for the user to review, not for a third party. Use "you" not "the user".
