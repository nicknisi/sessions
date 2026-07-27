import { C, disableColors } from './colors';
import { type Tool, type CliArgs } from './types';
import type { SearchOptions } from './cache';
import { resolveRepo } from './repo';

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'pi', 'opencode']);

function usage(): never {
  process.stderr.write(`${C.bold}sessions${C.reset} — find and resume AI coding sessions

Browse sessions from Claude Code, Codex, Pi, and OpenCode with fuzzy search.
Scoped to the current git repo.

${C.bold}Usage:${C.reset}
  sessions                    Browse all sessions with fzf
  sessions <query>            Search session content for a phrase
  sessions --here             Scope to current repo only

${C.bold}Options:${C.reset}
  --here           Scope to current git repo (default: all projects)
  --tool <name>    Filter: claude, codex, pi, opencode
  --errored        Only sessions that hit an error
  --file <path>    Only sessions that touched or read this path (substring
                   match; repeatable — every path must match). Newest first
                   when no query is given
  --mcp            Start as an MCP server (stdio transport)
  --clear-cache    Remove the search index (rebuilds on next use)
  -v, --version    Print the CLI version
  -h, --help       Show this help

${C.bold}Commands:${C.reset}
  context          Print a context primer for the current repo (markdown)
                   --full widens detail; --limit/--days/--tool filter; --worktree
                   narrows to the current worktree; --out <path> writes to a file
  lessons          Lessons saved for this repo — what past sessions concluded,
                   not what they did. review resolves conflicts and distilled
                   proposals, export writes them out as JSON, audit traces
                   deferred provenance, retire takes one out of service. Stored
                   outside the search index
  distill          Mine past sessions for lessons and park them for review.
                   Every result is a proposal, never served until accepted.
                   --query ranks the selection; --limit/--days bound it;
                   --here scopes to this repo; --with picks the agent CLI
  digest <session> Print the arc of one session as compact markdown (~8k chars):
                   each genuine user turn with its exchange's final assistant
                   reply. Accepts a JSONL file path or an indexed session id
  export           Print sessions as trajectory-v1 JSONL (one document per
                   line). <session> exports one; --query "..." exports the
                   top-ranked matches. --strict fails instead of dropping
                   records trajectory-v1 cannot carry
  report           Generate a usage report (HTML dashboard, opens in browser)
                   --out <path> saves instead of opening; --format json|html|both
                   (default html); --stdout prints JSON; --here scopes to the
                   current project; --from/--to/--days/--month limit the period
  wrapped          Your year with AI agents, Spotify-Wrapped style (opens in
                   browser). --year <YYYY> wraps a past year; --out/--stdout,
                   --tool, --extras <json> add agent-authored slides
  setup            Install plugin and configure MCP for detected tools
                   --hooks opts in to SessionStart auto-injection (off by
                   default); without it, an interactive prompt asks when on a TTY
  uninstall        Remove plugin, MCP config, and the SessionStart hook. Saved
                   lessons are kept; --purge-lessons --yes deletes them too
  cleanup          Uninstall plugin + clear search index (full reset). Keeps
                   saved lessons — they are not re-derivable from transcripts

${C.bold}Search:${C.reset}
  With no argument, opens fzf with session summaries.
  With an argument, greps across session content for matching
  sessions, then opens fzf with the results.
`);
  process.exit(0);
}

function die(msg: string): never {
  process.stderr.write(`${C.red}error:${C.reset} ${msg}\n`);
  process.exit(1);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { toolFilter: '', searchQuery: '', scopeHere: false, errored: false, files: [] };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        usage();
      case '--tool':
        i++;
        if (!argv[i] || !VALID_TOOLS.has(argv[i]!)) {
          die(`--tool requires one of: claude, codex, pi, opencode`);
        }
        args.toolFilter = argv[i] as Tool;
        break;
      case '--here':
        args.scopeHere = true;
        break;
      case '--errored':
        args.errored = true;
        break;
      case '--file':
        i++;
        if (!argv[i]) die(`--file requires a path`);
        args.files.push(argv[i]!);
        break;
      case '--no-color':
        disableColors();
        break;
      default:
        if (arg.startsWith('-')) die(`unknown option: ${arg}`);
        args.searchQuery = arg;
    }
    i++;
  }

  return args;
}

export function getRepoRoot(scopeHere: boolean): string {
  if (!scopeHere) return '';

  // Delegate to the git-common-dir based resolver. Its `container` is the tree
  // holding all worktrees (bare or normal), replacing the old `../.git`+`.bare`
  // string match. Fall back to the cwd when not in a git repo.
  const repo = resolveRepo(process.cwd());
  return repo ? repo.container : process.cwd();
}

/** The single mapping from CLI args to a searchSessions() call (keeps the CLI a thin shell). */
export function toSearchOptions(args: CliArgs, repoRoot: string): { query: string; opts: SearchOptions } {
  return {
    query: args.searchQuery,
    opts: { tool: args.toolFilter, project: repoRoot, errored: args.errored, files: args.files, limit: 1000 },
  };
}
