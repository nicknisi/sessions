<h1 align="center">sessions</h1>

<p align="center">
  Find and resume AI coding sessions.<br/>
  Browse conversations from <strong>Claude Code</strong>, <strong>Codex</strong>, and <strong>Pi</strong> with fuzzy search, scoped to the current repo or across all projects.
</p>

<p align="center">
  <a href="https://github.com/nicknisi/sessions/actions/workflows/ci.yml"><img src="https://github.com/nicknisi/sessions/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/nicknisi/sessions/releases/latest"><img src="https://img.shields.io/github/v/release/nicknisi/sessions" alt="Latest Release" /></a>
</p>

## Why

AI coding tools don't make it easy to find old sessions. Claude Code buries them in `~/.claude/projects/`, Codex and Pi have their own layouts. You end up grepping JSONL files or scrolling through `claude --resume` hoping to spot the right one.

`sessions` indexes all three tools, extracts the first user prompt from each conversation, and presents them in a unified fuzzy-searchable list. Pick a session and the resume command is copied to your clipboard.

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

## Dependencies

- **fzf** (optional but recommended) — used for fuzzy selection. If fzf is not installed, a built-in numbered list selector is used as a fallback. Install with `brew install fzf`.

## Usage

```sh
sessions                     # Browse all sessions with fzf
sessions <query>             # Search session content for a phrase
sessions --here              # Scope to current git repo only
sessions --tool claude       # Filter to Claude Code sessions only
sessions report              # Generate a usage report (JSON + HTML dashboard)
```

### Options

| Flag / Command  | Description                                                                              |
| --------------- | ---------------------------------------------------------------------------------------- |
| `report`        | Generate a usage report — JSON + HTML dashboard (see [Usage reports](#usage-reports))    |
| `setup`         | Install plugin and configure MCP for detected tools (`--hooks` opts into auto-injection) |
| `uninstall`     | Remove plugin, MCP config, and the SessionStart hook from all tools                      |
| `cleanup`       | Full reset: uninstall plugin + clear search index                                        |
| `--here`        | Scope to the current git repo (default: all projects)                                    |
| `--tool <name>` | Filter by tool: `claude`, `codex`, or `pi`                                               |
| `--mcp`         | Start as an MCP server (stdio transport)                                                 |
| `--clear-cache` | Remove the search index (rebuilds on next use)                                           |
| `--no-color`    | Disable colored output                                                                   |
| `-h`, `--help`  | Show help                                                                                |

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

Pass a query to search across user messages in all sessions:

```sh
sessions "rate limit"
```

This greps through session content (user messages only, ignoring system-injected blocks) and shows matching sessions with a snippet of the matching context. The search is case-insensitive.

### After selection

When you pick a session, `sessions` displays the resume command and copies it to your clipboard:

```
  my-project (claude)
  Refactor the auth middleware to use JWT

  cd /Users/you/Developer/my-project && claude --resume abc123
  (copied to clipboard)
```

For Claude Code sessions, the command includes `--resume <session-id>`. For Pi and Codex sessions, it navigates to the project directory (these tools don't support direct session resume).

## Usage reports

`sessions report` does a fresh pass over your local Claude Code, Codex, and Pi logs and produces a token/cost usage report — as machine-readable JSON, a self-contained HTML dashboard, or both.

```sh
sessions report                              # writes usage-report.json + report.html to the cwd
sessions report --format html --out /tmp/r   # just the dashboard
sessions report --format json --stdout       # print JSON to stdout (for piping)
sessions report --days 30 --tool claude      # last 30 days, Claude Code only
sessions report --this-month                 # current month to date
sessions report --month 2026-05              # a specific calendar month
```

The selected period is shown prominently at the top of both outputs (and in the JSON `period`).

### Report options

| Flag                                                                        | Description                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--format json\|html\|both`                                                 | What to emit. Default `both`.                                                                                  |
| `--out <path>`                                                              | For `both`, a directory (default `.`) → `usage-report.json` + `report.html`. For a single format, a file path. |
| `--from YYYY-MM-DD` / `--to YYYY-MM-DD`                                     | Inclusive local-date range. Default: all time.                                                                 |
| `--days N`                                                                  | Last `N` days (instead of `--from`/`--to`).                                                                    |
| `--today` / `--this-week` / `--this-month` / `--last-month` / `--this-year` | Convenience presets that resolve to a date range.                                                              |
| `--month YYYY-MM`                                                           | A specific calendar month.                                                                                     |
| `--tool claude\|codex\|pi`                                                  | Restrict to one tool. Default: all three.                                                                      |
| `--tz <IANA>`                                                               | Timezone for day/hour bucketing. Default: `$TIMEZONE`, else `America/Chicago`.                                 |
| `--stdout`                                                                  | Print the JSON to stdout and skip the JSON file (HTML is still written if requested).                          |

### What's in the report

Both outputs are built from the same data:

- **Summary** — total cost, tokens, sessions, messages, active days, current/longest streak, peak hour, and most-used model.
- **Breakdowns** — by tool, provider, model, and project.
- **Daily series** — per-day tokens/cost/sessions/messages with an hourly histogram.
- **Insights** — a weekly trend plus hour-of-day and weekday activity profiles.

The JSON is a sessions-owned `UsageReport` (`{ "generator": "sessions", "version": 1, ... }`). The HTML is fully self-contained (inline SVG charts, no external assets) and adapts to light/dark.

Cost is estimated from a built-in pricing table for Claude and other known models; Pi sessions use the cost recorded in their own logs. Tokens for unknown models are still counted, with cost shown as `$0`. Token totals exclude cache reads (replayed context, mostly free reuse).

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
    /weekly-summary    Summarize your past week's AI sessions
    /standup           Yesterday + today activity for standups
    /recall            What did I do on a specific project?
    /session-metrics   Usage dashboard with tool breakdown

  Run `sessions setup` again after upgrading to update skills.
```

After upgrading sessions (e.g., `brew upgrade sessions`), run `sessions setup` again to update the skills to the latest version.

To remove everything: `sessions uninstall`

### Auto-injecting context at session start (opt-in)

By default, the context primer is available on demand (the `/context` skill, the
`sessions context` command, or the `get_context_primer` MCP tool). You can also
have it injected **automatically** at the start of every Claude Code session via
a [SessionStart hook](https://docs.claude.com/en/docs/claude-code/hooks):

```bash
sessions setup --hooks    # enable auto-injection (Claude Code)
```

Run without `--hooks` and `setup` will ask interactively (when on a TTY); it is
**off by default** because it costs a small number of tokens on every session.
The hook runs `sessions context --hook` — a tiny primer (the 3 most recent
sessions for the current repo). In a fresh repo with no history, or outside a
git repo, it injects nothing and never blocks session start.

To turn it off, run `sessions uninstall` (which also removes the plugin and MCP
config). The hook lives in `~/.claude/settings.json` under `hooks.SessionStart`;
enabling and disabling preserve any other hooks you have configured.

> Codex and Cursor are not yet supported — their session-start hook contracts
> are still being confirmed. The hook also requires `sessions` to be on your
> `PATH` at session start.

## Skills

The plugin ships four skills that compose the MCP tools into repeatable workflows:

| Skill              | Trigger                                     | What it does                                                      |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| `/weekly-summary`  | "summarize my week", "weekly recap"         | Fetches full digest for the past 7 days, writes structured report |
| `/standup`         | "standup", "what did I do yesterday"        | Yesterday + today in compact format, terse bullets for Slack      |
| `/recall`          | "what did I do on [project]"                | Searches sessions by project/topic, shows chronological history   |
| `/session-metrics` | "session stats", "which tool do I use most" | Tool/project breakdown, daily activity, active hours heatmap      |

Skills work with Claude Code, Cursor, Codex, and any agent that supports the skills.sh format.

## MCP Server

`sessions` includes an [MCP](https://modelcontextprotocol.io/) server that gives AI agents searchable access to your past conversations. The MCP server is configured automatically by `sessions setup`, but you can also set it up manually.

### Manual MCP Setup

If you prefer to configure the MCP server yourself, add to your MCP configuration (e.g., `~/.claude/.mcp.json`):

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

### Tools

The MCP server exposes four tools:

| Tool                   | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `search_sessions`      | Search across sessions by keyword, filter by tool or project, list recent                     |
| `get_session_messages` | Retrieve messages from a specific session, paginated by offset and limit                      |
| `get_activity_digest`  | Compact digest of sessions in a date range, grouped by day and project — for weekly summaries |
| `get_session_metrics`  | Usage metrics for a date range: tool/project breakdown, daily activity, active hours          |

The `get_activity_digest` tool supports a `detail` parameter: `"compact"` (default) returns topics and file paths only, while `"full"` includes user messages per session for generating rich summaries like blog posts.

### Search index

The MCP server maintains a SQLite + FTS5 index at `~/.cache/sessions/index.db` for fast full-text search across all sessions. The index is built automatically on first use (~5s for thousands of sessions) and updated incrementally on subsequent calls by checking file modification times — only new or changed sessions are re-indexed.

To clear the index and force a full rebuild:

```sh
sessions --clear-cache
```

## How it works

### Session discovery

`sessions` reads JSONL session files from these locations:

| Tool        | Directory                       |
| ----------- | ------------------------------- |
| Claude Code | `~/.claude/projects/<project>/` |
| Pi          | `~/.pi/agent/sessions/`         |
| Codex       | `~/.codex/sessions/`            |

Each session file is parsed to extract:

- **Working directory** — read from the session metadata to determine which project the session belongs to
- **First user prompt** — the initial message you sent, cleaned of system-injected tags
- **Custom title** — if the session was renamed in Claude Code, that title is used instead
- **Message count** — total user + assistant messages in the session
- **Timestamps** — first and last timestamps for session duration and date-range queries
- **Subagent content** — for Claude Code, user messages from subagent sidecar files are folded into the search index

### Scoping with `--here`

When `--here` is passed, `sessions` resolves the current git repo root and only shows sessions whose working directory falls under that root. This works with bare repo worktrees — if a `.git` file points to a `.bare` directory, the parent is used as the repo root.

### Search filtering

When a query is provided, only sessions containing that text in user messages are shown. System-injected content (`<system-reminder>`, `<local-command-stdout>`, etc.) is stripped before matching so you only search what you actually typed.

## Development

```sh
bun install                  # Install dependencies
bun run dev                  # Run directly without compiling
bun run build                # Compile to dist/sessions
bun run typecheck            # Type-check with tsc
bun run lint                 # Lint with oxlint
bun run format               # Format with oxfmt
bun run format:check         # Check formatting without writing
```

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
