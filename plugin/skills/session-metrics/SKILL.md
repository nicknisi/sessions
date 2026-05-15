---
name: session-metrics
description: >-
  Show usage metrics and analytics for AI coding sessions. Use when the user
  asks "how much have I been coding", "session stats", "show me metrics",
  "tool usage", "which tool do I use most", "active hours", or wants
  analytics about their AI coding tool usage.
argument-hint: time period (e.g., "past week", "may", "past month")
---

Show session usage metrics and analytics.

## Steps

1. **Parse the time period.** Convert the user's argument to a date range (YYYY-MM-DD). Default to the past 7 days if no period specified. Common inputs: "past week", "this month", "past 30 days", "may 2026".

2. **Fetch metrics.** Call `get_session_metrics` with:
   - `startDate` and `endDate` from the parsed range

3. **Format the dashboard:**

   ### Session Metrics: {start} to {end}

   **Overview**
   - {total sessions} sessions | {total messages} messages
   - Tools: {breakdown with counts}

   **Top Projects** (table: project, sessions, messages)
   List the top 10 by session count.

   **Daily Activity** (table or mini-chart: date, sessions, messages)
   Show each day in the range.

   **Active Hours**
   Render the hours heatmap as a simple bar chart or table showing which hours of the day have the most sessions. Convert to local time labels (e.g., "9am", "2pm").

## Guidelines

- Round percentages to whole numbers.
- For active hours, group into time blocks if the data is sparse (morning/afternoon/evening/night).
- If a tool has zero sessions, omit it from the breakdown.
- Keep the formatting clean — this should be pasteable into a document or message.
