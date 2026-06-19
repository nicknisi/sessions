---
name: context
description: >-
  Load a context primer for the current repo before starting work. Use when the
  user says "what was I doing here", "catch me up on this repo", "context primer",
  "what's the open thread", or when resuming work on a codebase after a break.
argument-hint: optional repo path
---

Synthesize a prose context primer from past sessions on this repo.

## Steps

1. **Fetch the primer.** Call the `get_context_primer` MCP tool (pass `cwd` if a path was given).
2. **Synthesize, don't dump.** From the JSON, write: prior decisions, what was tried/abandoned, and the current open thread.
3. **Anchor the open thread** on the most-recent session's `closing` — but treat `closing.assistant` skeptically (it may be a question or tool call, not an outcome); cross-check `closing.user`.
4. **Keep it tight** — a short brief the user can act on, not a transcript.

## Guidelines

- Prefer the most recent + most-edited files as the likely active surface.
- If the primer is empty, say so plainly; don't invent history.
