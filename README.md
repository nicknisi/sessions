<h1 align="center">sessions</h1>

<p align="center">
  Search and memory across your AI coding sessions.<br/>
  One index over <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Pi</strong>, and <strong>OpenCode</strong> — fuzzy-find and resume past sessions from the CLI, give agents recall over prior work via MCP, and see where your tokens go.
</p>

<p align="center">
  <a href="https://github.com/nicknisi/sessions/actions/workflows/ci.yml"><img src="https://github.com/nicknisi/sessions/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/nicknisi/sessions/releases/latest"><img src="https://img.shields.io/github/v/release/nicknisi/sessions" alt="Latest Release" /></a>
</p>

## Why

Every AI coding session leaves a transcript behind. Claude Code buries them in `~/.claude/projects/`, Codex and Pi have their own layouts, OpenCode keeps everything in a SQLite database — and everything in them (what you tried, what you decided, what broke) is effectively write-only.

`sessions` builds a full-text search index over all of it and makes that history useful in three ways:

- **Search & resume (CLI)** — fuzzy-find any past session across all four tools, ranked by relevance, and jump back in.
- **Agent memory (MCP)** — agents search your history, pull a repo-scoped context primer when you return to a codebase, and answer "what did I do last week?" via bundled skills.
- **Usage reports** — a token/cost dashboard across tools, models, and projects.

## Install

### Homebrew

```sh
brew install nicknisi/formulae/sessions
```

Or, equivalently:

```sh
brew tap nicknisi/formulae
brew install sessions
```

### From source

```sh
git clone https://github.com/nicknisi/sessions && cd sessions
bun install && bun run build
```

The compiled binary is at `dist/sessions`. Requires [Bun](https://bun.sh) when building from source. The Homebrew install is a standalone binary — no runtime needed.

### Dependencies

- **fzf** (optional but recommended) — used for fuzzy selection. If fzf is not installed, a built-in numbered list selector is used as a fallback. Install with `brew install fzf`.

## Quick Setup

After installing, run:

```sh
sessions setup
```

This automatically:

1. Copies the plugin and skills to `~/.local/share/sessions/plugin/`
2. Detects which AI tools you have installed (Claude Code, Cursor, Codex)
3. Adds the MCP server config to each tool
4. Registers the plugin so skills are discoverable

```
❯ sessions setup

sessions setup

  ✓ Plugin installed to ~/.local/share/sessions/plugin/
  ✓ MCP server added to Claude Code
  ✓ Plugin registered with Claude Code
  ✓ MCP server added to Cursor
  ✓ Plugin registered with Cursor

  Skills available:
    /context           Context primer for the current repo
    /weekly-summary    Summarize your past week's AI sessions
    /standup           Yesterday + today activity for standups
    /recall            What did I do on a specific project?
    /session-metrics   Usage dashboard with tool breakdown
    /memory            Triage durable facts mined from past sessions

  Run `sessions setup` again after upgrading to update skills.
```

After upgrading sessions (e.g., `brew upgrade sessions`), run `sessions setup` again to update the skills to the latest version.

To remove the plugin, the MCP config, and the SessionStart hook: `sessions uninstall`. It removes only what the installer created — durable data in `~/.local/share/sessions` (memory triage decisions) is left alone.

## CLI: search & resume

```sh
sessions                     # Browse all sessions with fzf
sessions <query>             # Full-text search across session content
sessions --here              # Scope to current git repo only
sessions --tool claude       # Filter to Claude Code sessions only
sessions --errored           # Only sessions that hit an error
sessions --file src/auth.ts  # Only sessions that touched this file
sessions context             # Print a context primer for the current repo
sessions digest <session>    # Print one session's arc as compact markdown
sessions report              # Usage report (HTML dashboard, opens in browser)
sessions memory mine         # Mine past sessions for durable facts (JSON on stdout)
sessions memory mine --since-last # ...only transcripts changed since the last mine
sessions memory pending      # Count + preview the candidates awaiting triage
sessions memory approve <id> # Keep a mined candidate as a durable memory
sessions memory approve <id> --always-on          # ...and exempt it from topic filtering
sessions memory approve <id> --no-always-on       # ...or explicitly revoke that exemption
sessions memory approve <id> --scope group:authkit # ...and scope it to a project group
sessions memory approve <id> --scope repo:.        # ...or bind it to this repo (imports arrive unbound)
sessions memory reject <id>  # Dismiss a candidate; it stops being emitted
sessions memory snooze <id>  # Hide a candidate without rejecting it
sessions memory merge <id> <id>...  # Fold paraphrases into the first id
sessions memory export       # Write approved memories as a portable bundle (JSON)
sessions memory import <p>   # Merge another author's bundle in as candidates
sessions memory import --from pi-hermes  # ...or import another agent's memory store
```

### Options

| Flag / Command                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`                       | Print a markdown context primer for the current repo (see [Context primer](#context-primer))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `digest <session>`              | Print one session's arc as compact markdown (~8k chars): each genuine user turn with its exchange's final assistant reply. Accepts a JSONL file path or a session id                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `report`                        | Generate a usage report (see [Usage reports](#usage-reports))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory mine`                   | Mine past sessions for durable facts worth remembering and print the candidate batch as JSON. `--repo <path>` scopes to one repo container (default: the current repo); `--all` mines every repo; `--since-last` mines only transcripts whose mtime or size changed since the previous mine, so a repeat run over an unchanged corpus emits an empty batch                                                                                                                                                                                                                                                                                         |
| `memory pending`                | Print the untriaged backlog as JSON: the true candidate count plus the first five texts. Reads the store only — it never mines, which is what makes it cheap enough for `/weekly-summary` to call                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `memory <action>`               | Record a triage decision by the `id` from the mine's batch: `approve <id>`, `reject <id>` (never emitted again), or `snooze <id>` (hidden until the snooze expires **and** a later `merge` adds a phrasing that was not there before). `approve` also takes `--always-on` (budgeted — see [Topic filtering and standing constraints](#topic-filtering-and-standing-constraints)), `--no-always-on` to explicitly revoke it, `--scope group:<name>` — see [Project groups](#project-groups) — and `--scope repo:<path>`, which binds a memory to one repo (the path is resolved to its repo container, so any worktree or subdirectory of it works) |
| `memory export`                 | Write approved memories as a portable JSON bundle on stdout; `--out <path>` writes a file. Approved records only, with session paths and repo paths stripped — no local paths leave the machine                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `memory import <path>`          | Merge a bundle from another author in as candidates to triage. Never lands as approved and never overwrites your own approve/reject decisions. A `repo`-scoped memory arrives with no repo key — export strips local paths — so bind it to one of your repos when you approve it: `--scope repo:.`. Import says how many need it                                                                                                                                                                                                                                                                                                                   |
| `memory import --from <source>` | Import the durable facts another agent on this machine has stored, as candidates to triage: `pi-hermes` (its structured store, or MEMORY.md/USER.md/failures.md), `claude` (global and repo CLAUDE.md/AGENTS.md plus the per-project memory store), or `all`. `--repo <path>` sets the repo context (default: cwd). Long consolidated entries split at their own sentence boundaries to fit the memory band; entries already in the store count as known, not duplicates. `codex` stores hold command permissions, not facts, so it imports nothing. See [Other agents' memory stores](#other-agents-memory-stores)                                |
| `setup`                         | Install plugin and configure MCP for detected tools (`--hooks` opts into auto-injection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `uninstall`                     | Remove plugin, MCP config, and the SessionStart hook from all tools. Triage decisions in `~/.local/share/sessions` are preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cleanup`                       | Full reset: uninstall plugin + clear search index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--here`                        | Scope to the current git repo (default: all projects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--tool <name>`                 | Filter by tool: `claude`, `codex`, `pi`, or `opencode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--errored`                     | Only show sessions that hit an error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--file <path>`                 | Only sessions that touched or read this path (substring match; repeatable — every path must match). Newest first when no query is given                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--mcp`                         | Start as an MCP server (stdio transport)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--clear-cache`                 | Remove the search index (rebuilds on next use)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--no-color`                    | Disable colored output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `-h`, `--help`                  | Show help                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Browsing

With no arguments, `sessions` scans all session directories, extracts the first user prompt from each conversation, and pipes the results into fzf for fuzzy selection:

```
● my-project       claude  today     Refactor the auth middleware to use JWT
● my-project       pi      2d        Help me debug the flaky integration test
● api-server       codex   1w        Add rate limiting to the /api/v2 endpoints
○ old-project      claude  2025-03   Set up the initial project structure
```

- **●** (green) — the project directory still exists
- **○** (red) — the project directory has been deleted

### Searching

Pass a query to run a full-text search across all sessions:

```sh
sessions "rate limit"
```

The CLI uses the same search index as the MCP server: results are ranked by relevance (BM25) rather than recency, matching uses porter stemming (`refactor` matches `refactoring`), and multi-word queries match sessions containing _any_ of the terms with the closest matches first. Search covers both your messages and the assistant's replies; system-injected content (`<system-reminder>`, etc.) is stripped from your messages so you only match what you actually typed. Search is message-granular: each matching session is shown with the best-matching message's snippet and its `msg#N` index, then piped into fzf.

### After selection

When you pick a session, `sessions` displays the resume command and copies it to your clipboard:

```
  my-project (claude)
  Refactor the auth middleware to use JWT

  cd /Users/you/Developer/my-project && claude --resume abc123
  (copied to clipboard)
```

For Claude Code sessions, the command includes `--resume <session-id>`; for OpenCode, `opencode --session <session-id>`. For Pi and Codex sessions, it navigates to the project directory (these tools don't support direct session resume).

## Agent memory

`sessions` includes an [MCP](https://modelcontextprotocol.io/) server that gives AI agents searchable access to your past conversations — across every tool, not just the one they're running in. `sessions setup` configures it automatically; for manual setup, add to your MCP configuration (e.g., `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "sessions": {
      "command": "sessions",
      "args": ["--mcp"]
    }
  }
}
```

### MCP tools

The MCP server exposes ten tools:

| Tool                    | Description                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_sessions`       | Ranked, top-k search across sessions by keyword; each result includes snippets, files/commands, an errored flag, a resume command, and `messageHits` — the specific matching messages (index, role, snippet). `files` and `commands` are capped at 10 and 5, with `fileCount`/`commandCount` reporting the true totals. A `files` filter answers "which sessions touched this file?" (newest first) |
| `grep_sessions`         | Exhaustive literal-or-regex match over every indexed message — for "every time I said X", counts, or exact patterns where ranked search would miss some. Returns `totalHits`/`totalSessions` and hit snippets; each hit's `msgIndex` feeds `get_session_messages` directly                                                                                                                          |
| `get_session_messages`  | Retrieve messages from a specific session, paginated by offset and limit — pass a `messageHits[].index` from search (or a `grep_sessions` hit's `msgIndex`, or an `exchanges[].index` from the digest) as the offset. `include_tools` annotates each turn with the assistant's tool calls                                                                                                           |
| `get_session_digest`    | The arc of one session in a single bounded call (~2k tokens): every genuine user turn paired with its exchange's final assistant reply. Long sessions elide middle exchanges, never the ends                                                                                                                                                                                                        |
| `get_activity_digest`   | Compact digest of sessions in a date range, grouped by day and project — for weekly summaries                                                                                                                                                                                                                                                                                                       |
| `get_session_metrics`   | Usage metrics for a date range: tool/project breakdown, daily activity, active hours                                                                                                                                                                                                                                                                                                                |
| `get_context_primer`    | Repo-scoped primer (recent sessions in detail + older headlines) for re-injecting prior work                                                                                                                                                                                                                                                                                                        |
| `get_memory`            | Approved standing instructions and durable facts for this repo, its project groups, and cross-repo workflow rules — a bounded set of short sentences to read before starting a task. An optional `topic` narrows the result to what is relevant to the task at hand; memory approved with `--always-on` are returned regardless and come first                                                      |
| `get_memory_sources`    | Inventory every memory store the agents on this machine keep — pi-hermes-memory, Claude Code's global/per-project memory and CLAUDE.md/AGENTS.md files, Codex's rules and goals — with entry counts, durable-fact counts, and last-updated dates. Pure discovery for "what does each agent know?"                                                                                                   |
| `review_agent_memories` | Read the CONTENTS of those stores with provenance: source agent and store, scope, a durable flag (importable fact vs audit-only material), and a `similarTo` flag when an entry substantially overlaps a memory sessions already holds. Secret/injection text is withheld with a count. Filter by `agent`, narrow by `topic`; capped at 50 entries with `total`/`truncated` reporting the rest      |

Together these support the recall flow the bundled skills teach: `search_sessions` (ranked) or `grep_sessions` (exhaustive) localizes the hit to a message, the digest gives a session's whole arc in one call, and targeted message reads expand only the exchanges that matter — no paging full transcripts.

The `get_activity_digest` tool supports a `detail` parameter: `"compact"` (default) returns topics and file paths only, `"highlights"` adds first and last user messages for substantive sessions (best for summaries), and `"full"` includes all user messages per session.

### Skills

The plugin ships six skills that compose the MCP tools (and, for `/memory`, the CLI) into repeatable workflows:

| Skill              | Trigger                                     | What it does                                                                                                    |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/context`         | "what was I doing here", "catch me up"      | Repo-scoped primer: prior decisions, dead ends, the open thread                                                 |
| `/recall`          | "what did I do on [project]"                | Searches by topic or file, digests the best candidates, expands only the matched exchanges                      |
| `/standup`         | "standup", "what did I do yesterday"        | Yesterday + today in compact format, terse bullets for Slack                                                    |
| `/weekly-summary`  | "summarize my week", "weekly recap"         | Fetches full digest for the past 7 days, writes structured report, then nudges toward any new memory candidates |
| `/session-metrics` | "session stats", "which tool do I use most" | Tool/project breakdown, daily activity, active hours heatmap                                                    |
| `/memory`          | "triage memory", "review memory"            | Runs the mine, clusters paraphrases, merges them, and walks approve / reject / snooze                           |

Skills work with Claude Code, Cursor, Codex, and any agent that supports the skills.sh format.

### Project groups

A memory's scope is normally derived: a fact seen in one repo container is `repo`-scoped, one seen across unrelated containers is `workflow`-scoped. A **project group** is the tier in between — a fact true of several related repos, but not of everything.

Group membership cannot be derived from your session history, so it comes from a config file at `~/.local/share/sessions/groups.json` (or `$SESSIONS_DATA_DIR/groups.json`). Nothing writes it for you; create it yourself:

```json
{
  "groups": {
    "authkit": ["~/Developer/authkit-*"],
    "workos-cli": ["~/Developer/cli/*"]
  }
}
```

Each group maps a name to a list of path globs matched against the resolved repo container. `~` expands to your home directory, and a subdirectory of a match counts as a member — working in `~/Developer/authkit-session/packages/core` puts you in `authkit`.

Then assign a group at triage time:

```bash
sessions memory approve <id> --scope group:authkit
```

The file is never read from inside a repo, and it is never required. If it is missing, malformed, or does not mention a memory's group, retrieval quietly degrades to repo-plus-workflow rather than failing — but that also means a group memory with no matching config is silently never returned, so check the file if a group memory is not showing up.

### Topic filtering and standing constraints

`get_memory` takes an optional `topic`. When present, the returned set is narrowed to memory whose text overlaps the topic, so an agent about to work on authentication does not spend context on your build conventions. Omitting `topic` returns everything, exactly as before.

Some facts must never be filtered out — "canary is the mainline branch" has to reach the agent whether or not the task description mentions branching. Approve those with `--always-on`:

```bash
sessions memory approve <id> --always-on
```

An always-on memory is returned for every topic and sorts first, so an agent that truncates drops the conditional tail rather than the invariants. It still respects state and scope: rejected, snoozed, and out-of-scope memories are never returned. Approving again without the flag does not clear it — omission is not a decision; clearing takes an explicit `--no-always-on`.

The set is budgeted: at most 20 always-on memories totalling 2,000 characters. The cap is what keeps the flag's promise credible — standing constraints only cut through if there are few enough of them to always be read — so a grant past it is refused with instructions to free a slot (`--no-always-on`). A store already over budget (hand-edited, or written before the cap existed) is still served in full, and `get_memory` says so: truncating a standing constraint would be exactly the silent suppression the flag exists to prevent.

### Content scanning

Memory text is scanned at every boundary it can cross. Secret material (API keys, tokens, private-key blocks), prompt-injection phrasing ("ignore previous instructions…"), and invisible Unicode characters never enter the store or reach an agent: the mine drops the turn, `import` withholds the record and says so on stderr, `approve` refuses with the finding named, and `get_memory` withholds any pre-existing approved row while reporting its id — so you can `reject` it or re-approve a clean rephrasing with `--as`. The withheld text itself is never served, not even in the warning.

Facts _about_ secret handling are deliberately not flagged — "set `DATABASE_URL` through doppler, never in `.env`" and "never pipe `$GITHUB_TOKEN` through curl" are exactly the memories worth keeping. The scanner matches secret material and hijack phrasing, not secret vocabulary: a prohibition legitimately names the thing it prohibits.

### Other agents' memory stores

Sessions are only half of what an agent remembers. Each harness also keeps its own store beside the conversation, and if you hop between agents those stores scatter: pi-hermes-memory writes a categorized SQLite store plus `MEMORY.md`/`USER.md`/`failures.md`; Claude Code injects a global `~/.claude/CLAUDE.md`, per-repo `CLAUDE.md`/`AGENTS.md` files, and a per-project `memory/` directory; Codex records command-permission rules. Three surfaces make them visible and portable, all read-only against the source stores:

- **`get_memory_sources`** (MCP) inventories every store it can see for the current repo: what it is, how many entries it holds, how many of those are durable facts, and when it was last updated. This is the "what does each agent know about me?" answer.
- **`review_agent_memories`** (MCP) reads their contents with provenance. Every entry carries its source agent and store, a sessions-style scope, and a `durable` flag — `true` for standing facts (importable), `false` for audit-only material like Codex's allow/deny rules or Claude's agent research notes. Entries that substantially overlap a memory sessions already stores are flagged in `similarTo`, so redundancy and near-conflicts between agents are visible. The content scanner gates this surface too: flagged text is withheld with a count, never served. These entries are untriaged source material, not binding instructions — `get_memory` remains the binding surface.
- **`sessions memory import --from <pi-hermes|claude|all>`** (CLI) lands another store's durable facts in your own store as candidates, through the same gates as a bundle import: the text band, the content scan, and candidate-until-approved. Long consolidated entries (pi-hermes averages ~1,100 characters per row) split at their own enumeration and sentence boundaries to fit the 240-character band; fragments that can't be reshaped are counted, never silently dropped. Entries already in the store are reported as known, and a pi-hermes fact recorded against a bare project name arrives unbound — bind it with `approve <id> --scope repo:.` like any import.

The workflow this enables: switch agents for a project, run `get_memory_sources` to see what the old harness learned, `review_agent_memories` to audit it, and `memory import --from` to carry the facts worth keeping — then triage with `/memory` as usual. Codex keeps permission decisions rather than facts, so `--from codex` reports that and imports nothing.

### Context primer

When you return to a codebase, the primer answers "where did I leave off?" — recent sessions in detail, older ones as headlines, including the branch you were on and the last exchange of each session. It's available three ways:

- **On demand from an agent** — the `/context` skill or the `get_context_primer` MCP tool
- **On demand from the shell** — `sessions context` prints it as markdown (`--full` widens detail; `--limit`/`--days`/`--tool` filter; `--worktree` narrows to the current worktree; `--out <path>` writes to a file)
- **Automatically at session start** — opt-in, below

#### Auto-injecting context at session start (opt-in)

You can have a small primer injected automatically at the start of every Claude Code session via a [SessionStart hook](https://docs.claude.com/en/docs/claude-code/hooks):

```bash
sessions setup --hooks    # enable auto-injection (Claude Code)
```

Run without `--hooks` and `setup` will ask interactively (when on a TTY); it is **off by default** because it costs a small number of tokens on every session. The hook runs `sessions context --hook` — a tiny primer (the 3 most recent sessions for the current repo). In a fresh repo with no history, or outside a git repo, it injects nothing and never blocks session start.

To turn it off, run `sessions uninstall` (which also removes the plugin and MCP config). The hook lives in `~/.claude/settings.json` under `hooks.SessionStart`; enabling and disabling preserve any other hooks you have configured.

> Codex and Cursor are not yet supported — their session-start hook contracts are still being confirmed. The hook also requires `sessions` to be on your `PATH` at session start.

## Usage reports

`sessions report` reads your local Claude Code, Codex, Pi, and OpenCode logs and produces a token/cost usage report. By default it renders a self-contained HTML dashboard and opens it in your browser; JSON is available for piping and `--format text` prints a summary straight to the terminal.

```sh
sessions report                              # HTML dashboard, opens in your browser
sessions report --format text --today        # quick terminal summary
sessions report --out ./report.html          # save the dashboard instead of opening it
sessions report --format json --stdout       # print JSON to stdout (for piping)
sessions report --days 30 --tool claude      # last 30 days, Claude Code only
sessions report --this-month                 # current month to date
sessions report --month 2026-05              # a specific calendar month
sessions report --here                       # current project only
```

Parsed transcripts are cached against their mtime and size, so only what changed is re-read; a bounded period additionally skips files last written before the window. Pass `--no-cache` to force a full read.

The selected period is shown prominently at the top of both outputs (and in the JSON `period`).

### Report options

| Flag                                                                        | Description                                                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format json\|html\|both\|text`                                           | What to emit. Default `html`. `text` prints to stdout and writes no file.                                                                       |
| `--out <path>`                                                              | Save output instead of opening in the browser. For `both`, a directory → `usage-report.json` + `report.html`; for a single format, a file path. |
| `--here`                                                                    | Restrict to the current project.                                                                                                                |
| `--from YYYY-MM-DD` / `--to YYYY-MM-DD`                                     | Inclusive local-date range. Default: all time.                                                                                                  |
| `--days N`                                                                  | Last `N` days (instead of `--from`/`--to`).                                                                                                     |
| `--today` / `--this-week` / `--this-month` / `--last-month` / `--this-year` | Convenience presets that resolve to a date range.                                                                                               |
| `--month YYYY-MM`                                                           | A specific calendar month.                                                                                                                      |
| `--tool claude\|codex\|pi\|opencode`                                        | Restrict to one tool. Default: all four.                                                                                                        |
| `--tz <IANA>`                                                               | Timezone for day/hour bucketing. Default: `$TIMEZONE`, else `America/Chicago`.                                                                  |
| `--stdout`                                                                  | Print the JSON to stdout and skip the JSON file (HTML is still written if requested).                                                           |
| `--offline`                                                                 | Skip the pricing refresh; use cached/embedded pricing data.                                                                                     |
| `--refresh-pricing`                                                         | Force a pricing refresh even if the cache is fresh.                                                                                             |
| `--no-cache`                                                                | Bypass the incremental parse cache and re-read every transcript.                                                                                |

### What's in the report

Both outputs are built from the same data:

- **Summary** — total cost, tokens, sessions, messages, active days, current/longest streak, peak hour, and most-used model.
- **Pace** — spend per active day, a straight-line projection to the end of the period, and the equally long window immediately before it. Only for a bounded period; an all-time report has nothing to pace against.
- **Cache** — hit rate, read and write volume, and what the prompt cache saved against uncached input rates.
- **Breakdowns** — by tool, provider, model, and project.
- **Weekly trend and model mix** — cost per week, and cost per week stacked by model, so a shift between models is visible while it happens.
- **Subagents** — spend by dispatched agent type with the cost of a single dispatch of each, plus the costliest individual dispatches. Roughly half of a heavy Task user's tokens land here; they are counted in every total above, and this says who spent them.
- **Sessions** — the distribution of session spend (median, p90, max across every session), and the most expensive ones named with their title or opening prompt, pulled read-only from the search index when one exists.
- **Daily series** — per-day tokens/cost/sessions/messages with an hourly histogram.
- **Insights** — a weekly trend plus hour-of-day and weekday activity profiles.

In the HTML, every stat, section heading, and table column explains itself on hover — what is counted, what is excluded, and what the cost is an estimate of.

The JSON is a sessions-owned `UsageReport` (`{ "generator": "sessions", "version": 1, ... }`). The HTML is fully self-contained (inline SVG charts, no external assets) and adapts to light/dark.

Cost is estimated from [LiteLLM](https://github.com/BerriAI/litellm) pricing data, fetched at most once per day and cached locally, with an embedded snapshot as the offline fallback — a failed fetch never blocks the report. Pi sessions use the cost recorded in their own logs; OpenCode sessions use their recorded cost when present (Anthropic) and fall back to estimated pricing otherwise (OpenAI). A model with no published price is billed at the newest rate in its own family and flagged as an estimate in the report; one in no known family is counted at `$0`, loudly. Token totals exclude cache reads (replayed context, mostly free reuse).

## Wrapped

`sessions wrapped` turns your year of AI pairing into a Spotify-Wrapped-style scroll-through story and opens it in your browser: tokens with a human-scale equivalence, the API-rate receipt, streaks, a rhythm heatmap, top projects and models, your most significant session — and a set of fun stats mined from what you and your agents actually said to each other (the interrupt census, the two-sided apology scoreboard, how many times Claude told you "you're absolutely right", your word of the year). It ends with a coding-personality reveal built from three behavioral axes, with the evidence printed on the card, followed by a shareable image you can download or copy straight to the clipboard — at 1200 × 630 for timelines or 1080 × 1920 for stories, in whichever of six accents you like.

```sh
sessions wrapped                     # this year, opens in your browser
sessions wrapped --year 2025         # a past calendar year
sessions wrapped --roast             # let an agent CLI improvise roast slides
sessions wrapped --stdout            # the underlying JSON, for piping
sessions wrapped --extras roast.json # inject your own extra slides
```

The fun slides are **dynamically selected**: every candidate stat is scored for how notable it is in _your_ data, and only the top ones render — a daylight coder never sees a 3 AM slide. Everything is computed locally (event logs + the search index); nothing leaves your machine. Because AI tools prune old transcripts, the page discloses when its data starts if that's later than January 1. Token and cost math match `sessions report` exactly.

### Roast mode

`--roast` hands your computed stats to an agent CLI you already have installed (`claude`, then `codex`, then `pi` — override with `--roast-with <tool>`) and asks it to improvise a few edgy, bespoke roast slides, which are appended to the story. It rides your existing subscription — no API key, no setup. Only the **stats** are sent (counts, project names, the numbers already on the page), never raw transcript text, and every roast slide is stamped "improvised by \<tool\>" so a generated line can never pass for a counted one. It's opt-in and fails open: no CLI, a timeout, or unparseable output just drops the roast and the deterministic page renders as normal. Expect it to add 15–90s.

`--extras <path>` is the manual version: a JSON array of up to six slides (`[{"headline": "...", "title"?, "subline"?, "footnote"?}]`) injected into the story. `--roast` is the same seam, filled by a model instead of by hand.

## How it works

### Session discovery

`sessions` reads JSONL session files (and OpenCode's SQLite database) from these locations:

| Tool        | Location                              |
| ----------- | ------------------------------------- |
| Claude Code | `~/.claude/projects/<project>/`       |
| Pi          | `~/.pi/agent/sessions/`               |
| Codex       | `~/.codex/sessions/`                  |
| OpenCode    | `~/.local/share/opencode/opencode.db` |

Each session file is parsed to extract:

- **Working directory** — read from the session metadata to determine which project the session belongs to
- **First user prompt** — the initial message you sent, cleaned of system-injected tags
- **Custom title** — if the session was renamed in Claude Code, that title is used instead
- **Message count** — total user + assistant messages in the session
- **Timestamps** — first and last timestamps for session duration and date-range queries
- **Subagent content** — for Claude Code, user messages from subagent sidecar files are folded into the search index

### Search index

Both the CLI and the MCP server share a SQLite + FTS5 index at `~/.cache/sessions/index.db`. Messages are indexed individually, so a hit localizes to the exact message that matched — not just the session. The index is built automatically on first use (under a minute for a few thousand sessions) and updated incrementally on subsequent runs by checking file modification times — only new or changed sessions are re-indexed.

Long-lived MCP servers coalesce concurrent refreshes and reuse a freshness check for five seconds, so a burst of related tool calls does not walk the full session tree repeatedly. Set `SESSIONS_REFRESH_INTERVAL_MS=0` on the MCP process to require a source scan before every call.

To clear the index and force a full rebuild:

```sh
sessions --clear-cache
```

### Scoping with `--here`

When `--here` is passed, `sessions` resolves the current git repo root and only shows sessions whose working directory falls under that root. This works with bare repo worktrees — if a `.git` file points to a `.bare` directory, the parent is used as the repo root.

## Development

```sh
bun install                  # Install dependencies
bun run dev                  # Run directly without compiling
bun run build                # Compile to dist/sessions
bun run typecheck            # Type-check with tsc
bun run lint                 # Lint with oxlint
bun run format               # Format with oxfmt
bun run format:check         # Check formatting without writing
bun run eval                 # Search ranking eval against the golden fixture
```

Search ranking is gated by a frozen golden eval fixture (`src/eval/`): recall@5, MRR, and negative-abstention thresholds run in CI, and the ranking constants in `cache.ts` move only against that fixture. See [docs/EVAL.md](docs/EVAL.md) for the discipline and how to log a real miss as a new golden.

### Cross-compilation

The release workflow compiles binaries for three platforms:

| Target                    | Artifact                 |
| ------------------------- | ------------------------ |
| macOS ARM (Apple Silicon) | `sessions-darwin-arm64`  |
| macOS x86_64 (Intel)      | `sessions-darwin-x86_64` |
| Linux x86_64              | `sessions-linux-x86_64`  |

Binaries are compiled with `bun build --compile --minify` and distributed as `.tar.gz` archives attached to GitHub Releases.

### Release process

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Push commits to `main` using [conventional commit](https://www.conventionalcommits.org/) messages
2. Release-please opens a version-bump PR with an auto-generated changelog
3. Merge the PR to trigger the release pipeline
4. Binaries are built, attached to the GitHub Release, and the Homebrew formula is auto-updated

## License

MIT
