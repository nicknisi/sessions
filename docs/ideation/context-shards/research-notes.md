# Context shards — source notes

_Research material for this project: a summary of the talk that described the original context-shards idea. Kept for provenance; the binding design lives in `contract.md` and the phase specs._

**Context shards** (also referred to in the transcript as "contact shards" due to a slight mispronunciation or transcription error) represent a volume-based shared memory system designed to improve how AI coding agents collaborate with engineering teams [1, 2]. Unlike standard AI memory systems that aggressively save everything and quickly become cluttered with useless or conflicting information, context shards are built on long-term analytics to capture only the most valuable, repeated instructions [3, 4].

**How Context Shards are Used**

- **Extracting Repeated Patterns:** A background "supervisor agent" monitors the prompt sessions across an entire team of developers [1, 5, 6]. It looks for instructions, context, or corrections that the team repeatedly has to tell the AI, such as architectural rules or branch naming conventions (e.g., using "canary" instead of "main") [2].
- **System Prompt Injection:** Once a useful pattern is identified and approved, it is transformed into a "shard" of memory [1, 7]. These shards are programmatically injected into the user's main AI system prompt to automatically guide the agent's behavior moving forward [8, 9].
- **Conditional vs. Global Activation:** Shards can be configured to be "always on" for global rules, or they can be conditionally activated so they are only injected into the context window when a developer is working on a specific relevant task [10, 11].
- **Building a Single Source of Truth:** The ultimate goal is to create a high-standard, shared memory file (like a `claude.md` file) for the entire team [10, 12]. If five team members correct the AI on a specific workflow, the system learns this so the sixth person automatically benefits from the shared knowledge without having to train the AI themselves [13].

**How Context Shards are Surfaced**

- **Human-in-the-Loop Triage:** The system generates memory candidates called "session statements," which include the proposed fact, who said it, and a summary of the conversation context [14, 15]. Users must review and triage these candidates to decide if they are actually useful before they are permanently adopted [7].
- **Slack and Email Integration:** To avoid forcing users to check a new dashboard, the developers suggest surfacing these memory candidates directly in a daily Slack message or email digest [16, 17]. Developers can quickly approve or deny newly proposed shards (e.g., clicking "yes" or "no") during their morning routine [16-18].
- **Staged Rollouts and PRs:** Context shards follow a staged adoption process [7]. A user can turn a shard on for themselves to test it, and then share it with their team [7, 18]. To permanently bake a shard into the team's workflow, the system can automatically create a Pull Request (PR) to save the rule as a version-controlled config file (like JSON or Markdown) directly in the codebase [7, 18, 19].
- **Snoozing Features:** If a user dismisses a proposed shard, it disappears for 30 days [20]. However, if the system detects that the team is _still_ repeatedly manually typing that same instruction to the AI, it will resurface the shard 30 days later to double-check if the team wants to automate it [8, 20].
