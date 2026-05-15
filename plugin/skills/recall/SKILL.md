---
name: recall
description: >-
  Recall what was done on a specific project or topic. Use when the user says
  "what did I do on [project]", "recall [topic]", "history of [project]",
  "when did I last work on [thing]", or wants to remember past work on a
  specific codebase or feature.
argument-hint: project name or path
---

Recall past work on a specific project or topic.

## Steps

1. **Identify the target.** The user's argument is a project name, path, or topic. If it looks like a path, use it directly. If it's a name, search for it.

2. **Search sessions.** Call `search_sessions` with:
   - `query`: the topic/keyword if searching by content
   - `project`: the path if filtering by project directory
   - `limit`: 20

3. **Get context for top results.** For the most relevant sessions (up to 5), call `get_session_messages` with:
   - `filePath`: from the search results
   - `limit`: 20

4. **Summarize the history.** Write a chronological summary:

   ### Sessions on {project/topic}

   For each relevant session:
   - **{date}** ({tool}) — What was worked on, key decisions made, outcome

   **Overall arc:** How the work evolved across sessions.

## Guidelines

- Order chronologically (oldest first) to show the arc of work.
- If the user gives a vague name, try both `search_sessions` (keyword search) and `get_activity_digest` (project path filter) to find matches.
- Focus on decisions and outcomes, not implementation details.
- If there are many sessions, group by phase or milestone rather than listing each one.
