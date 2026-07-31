# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who pair with AI coding agents daily and use more than one of them. The
concrete scene: someone returns to a repo after two weeks, cannot remember why the
auth middleware was rewritten, and knows the reasoning was argued out in a Claude
Code session that git never recorded. A second scene: the same person opens a
billing dashboard and cannot tell which of their four tools spent the money.

They live in a terminal, run `brew install`, already have `fzf`, and read a README
before a marketing page. Single-machine, local-first: every transcript being
searched is already on their disk.

## Product Purpose

Every AI coding session leaves a transcript behind, and every transcript is
effectively write-only — Claude Code buries them in `~/.claude/projects/`, Codex
and Pi use their own layouts, OpenCode uses a SQLite database. `sessions` builds
one full-text index across all four and makes that history useful three ways:
search and resume from the CLI, recall for agents over MCP, and usage reporting.

Success is an agent that stops re-deriving a decision a past session already
settled, and a developer who can answer "where did I leave off" without reading
a transcript.

## Positioning

The mechanism a neighbor cannot truthfully copy: **one index across four
different agent CLIs, read from the transcripts already on the machine, exposed
to the agents themselves as MCP tools.** Not a hosted service, not a wrapper
around one vendor's history, not a log viewer. Nothing leaves the machine, and
the agent doing the recall is the same agent that will act on it.

The three surfaces the site must carry:

- **MCP** — eight read-only tools plus six skills, so the agent recalls prior
  work without being asked.
- **Report** — a self-contained HTML usage dashboard across tools, models,
  providers, projects, and subagents.
- **Wrapped** — the year as a scroll-through story, ending in a coding-personality
  reveal and a shareable image.

## Operating Context

Installed with `brew install nicknisi/formulae/sessions`, then `sessions setup`,
which detects installed tools (Claude Code, Cursor, Codex), writes the MCP config,
and registers the plugin so the skills are discoverable. Everything after that
happens in a terminal or in a browser tab the CLI opened itself.

Both the report and wrapped are HTML files written locally and opened in the
default browser — no server, no upload. The report adapts to light and dark; the
wrapped page commits to dark.

## Capabilities and Constraints

Confirmed, from the README and source:

- Four tools indexed: Claude Code, Codex, Pi, OpenCode.
- Eight MCP tools: `search_sessions`, `grep_sessions`, `get_session_messages`,
  `get_session_digest`, `get_activity_digest`, `get_session_metrics`,
  `get_context_primer`, `get_memory`. All read-only.
- Six skills: `/context`, `/recall`, `/standup`, `/weekly-summary`,
  `/session-metrics`, `/memory`.
- Memory has a triage lifecycle — mine, approve/reject/snooze/merge, export/import —
  with three scopes (repo, project group, workflow) and an `--always-on` flag.
- Search is BM25-ranked with porter stemming, message-granular; `grep_sessions` is
  the exhaustive counterpart.
- Cost is _estimated_ from LiteLLM pricing data, cached daily with an embedded
  offline snapshot. Pi and OpenCode use their own recorded cost where present.
  Token totals exclude cache reads. The site must never state cost as exact.
- `--roast` sends **stats only** to a local agent CLI, never transcript text, and
  every roast slide is stamped "improvised by \<tool\>". It fails open.
- Requires Bun only when building from source; the Homebrew install is a
  standalone binary. `fzf` is optional, with a numbered-list fallback.
- Auto-injected session-start context is **opt-in and off by default**, because it
  costs tokens on every session.

Constraints on the site itself: static build, no external requests at runtime,
self-hosted fonts, CSP of essentially `self`.

## Brand Commitments

Binding, and confirmed by the user this session: **the site wears the product's
own visual world**, the one already implemented in `src/report/html.ts` and
`src/wrapped/html.ts`.

- Space Grotesk (display/body) and JetBrains Mono (labels, figures, code). Pinned
  by the incumbent implementation, not chosen fresh.
- OKLCH accents: violet (default), cyan, magenta, mono — the report's own picker,
  in the report's own order.
- Dark ground first, light available. Rounded panels (12–16px), pill badges,
  uppercase tracked mono section labels, tabular figures.
- Lowercase wordmark: `sessions`.
- MIT, installed via Homebrew, source at github.com/nicknisi/sessions.
- Sibling site `ideation.engineering` deliberately wears a _different_ world; the
  two are not meant to match.

## Evidence on Hand

Real and quotable:

- `README.md` — every capability claim on the site traces here.
- `src/report/html.ts` (1445 lines) — the dashboard's real palette, charts, and
  glossary.
- `src/wrapped/html.ts` (1040 lines) — the real card grammar, accents, share card.
- `src/mcp.ts` — the eight `registerTool` calls, with their titles.
- `plugin/skills/*/SKILL.md` — the six skills' real names and descriptions.
- `src/cli.ts` — the real `sessions --help` output.
- `package.json` — the released version.

Absent, and not to be fabricated: no user counts, no download numbers, no
testimonials, no benchmarks, no logos. Any number rendered from a report or
wrapped on the site is **synthetic demonstration data and must be labeled**.

## Product Principles

1. **Local-first is the whole argument.** Nothing leaves the machine. Say it
   where a visitor is deciding whether to trust it with their transcripts.
2. **Show the artifact, not a description of it.** The report and wrapped are
   already beautiful HTML; the site's job is to let someone see them working.
3. **Read-only by construction.** Every MCP tool reads. Memory only changes when
   a human triages it. That restraint is a feature, not a footnote.
4. **Estimated is said out loud.** Cost is an estimate, roast slides are
   improvised, sample data is synthetic. Never let a generated number pass for a
   counted one — the product itself enforces this, and the site must too.
5. **Derive from source, don't restate it.** Facts on the site that exist in the
   repo are read at build time and fail the build when they drift.

## Accessibility & Inclusion

No product-specific standard was established. Baseline: the site must work at
360px, respect `prefers-reduced-motion`, keep visible focus rings, keep contrast
legible in both themes, and never encode meaning in accent color alone — the
accent is user-switchable, so it can never be the only signal.
