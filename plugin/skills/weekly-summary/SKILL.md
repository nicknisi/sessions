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

## Guidelines

- Process the digest inline. Do not spawn a subagent to read it.
- Be specific. Quote project names, feature descriptions, and tool names.
- The first message shows intent; the last message shows outcome. Use both to capture the arc.
- Skip noise — 1-message sessions and test sessions are not worth mentioning.
- If a project appears across multiple days, note the arc of progress.
- Write for the user to review, not for a third party. Use "you" not "the user".
