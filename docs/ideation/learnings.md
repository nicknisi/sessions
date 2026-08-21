# Ideation Learnings

Generalizable spec-gap and interview patterns captured from completed
ideation projects. Intake reads this file so recurring gaps inform future
questioning and spec generation. Each entry is dated and cites its
evidence; treat entries as hints, never as a substitute for gate evidence.

## 2026-08-19 — memory-recurrence

- **Pattern**: pi engine stage agents don't inherit the user's model settings — the spawn runtime builds child sessions with `SettingsManager.inMemory()`, so an unset spawn model falls to pi's per-provider default (`anthropic/claude-opus-4-8` via `findInitialModel`), and every child dies silently when that provider's account is broken (credit exhaustion), while the parent session keeps working on its own provider.
  **Evidence**: two full engine runs failed every stage with `400 credit balance too low` before `.pi/ideation-engine.json {"model": "openrouter/moonshotai/kimi-k3"}` was written; the run then completed 4/4 phases.
  **Spec/interview implication**: autopilot should pre-flight one cheap child spawn before dispatching a multi-phase engine run, and on failure name the override file as the fix instead of retrying; when a project will run the engine, mention the override at contract time.
