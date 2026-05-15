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

2. **Fetch the digest.** Call the `get_activity_digest` MCP tool with:
   - `startDate`: 7 days ago
   - `endDate`: today
   - `detail`: `"full"` (includes user messages for rich context)

3. **Scan the digest.** For each day, review the project groups. Identify:
   - Which projects were worked on and what was accomplished
   - Key decisions, pivots, or discoveries (found in user messages)
   - Recurring themes across projects

4. **Write the summary.** Structure it as:

   ### Week of {start} - {end}

   **By the numbers:** {total sessions} sessions, {total messages} messages across {project count} projects.

   **Day-by-day:**
   For each day with activity, write 2-4 bullet points capturing the most significant work. Be specific — name projects, features, and outcomes. Skip days with no meaningful activity.

   **Highlights:** The 3-5 most significant accomplishments across the entire week.

   **Themes:** Recurring work streams or focus areas (e.g., "SDK development", "infrastructure", "bug fixes").

## Guidelines

- Be specific. Quote project names, feature descriptions, and tool names.
- Capture pivots and discoveries, not just starting intents. The user messages reveal what actually happened, not just what was planned.
- Skip noise — 1-message sessions and test sessions are not worth mentioning.
- If a project appears across multiple days, note the arc of progress.
- Write for the user to review, not for a third party. Use "you" not "the user".
