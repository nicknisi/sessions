---
name: standup
description: >-
  Generate a quick standup summary of yesterday and today's AI coding sessions.
  Use when the user says "standup", "what did I do yesterday", "daily summary",
  "what have I been working on", or needs a quick recap for a standup meeting.
---

Generate a brief standup-style summary.

## Steps

1. **Calculate dates.** Yesterday and today in YYYY-MM-DD format.

2. **Fetch the digest.** Call `get_activity_digest` with:
   - `startDate`: yesterday
   - `endDate`: today
   - `detail`: `"compact"`

3. **Format as a standup.** Write three sections, each 2-4 bullets max:

   **Yesterday:**
   - What was accomplished (project: brief description)

   **Today (so far):**
   - What's been started or is in progress

   **Carrying forward:**
   - Anything that spans both days or is unfinished

## Guidelines

- Keep it terse. Each bullet should be one line.
- Group by project if multiple sessions touched the same project.
- Skip noise — only mention substantive sessions.
- If yesterday had no sessions, say so and focus on today.
- Format for pasting into Slack or a standup thread.
