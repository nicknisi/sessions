import { C, disableColors } from './colors';
import { type Tool, type CliArgs } from './types';
import { resolveRepo } from './repo';

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'pi']);

function usage(): never {
  process.stderr.write(`${C.bold}sessions${C.reset} — find and resume AI coding sessions

Browse sessions from Claude Code, Codex, and Pi with fuzzy search.
Scoped to the current git repo.

${C.bold}Usage:${C.reset}
  sessions                    Browse all sessions with fzf
  sessions <query>            Search session content for a phrase
  sessions --here             Scope to current repo only

${C.bold}Options:${C.reset}
  --here           Scope to current git repo (default: all projects)
  --tool <name>    Filter: claude, codex, pi
  --mcp            Start as an MCP server (stdio transport)
  --clear-cache    Remove the search index (rebuilds on next use)
  -h, --help       Show this help

${C.bold}Commands:${C.reset}
  report           Generate a usage report (HTML dashboard, opens in browser)
                   --out <path> saves instead of opening; --format json|html|both
                   (default html); --stdout prints JSON; --here scopes to the
                   current project; --from/--to/--days/--month limit the period
  setup            Install plugin and configure MCP for detected tools
  uninstall        Remove plugin and MCP config from all tools
  cleanup          Uninstall plugin + clear search index (full reset)

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
  const args: CliArgs = { toolFilter: '', searchQuery: '', scopeHere: false };

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
          die(`--tool requires one of: claude, codex, pi`);
        }
        args.toolFilter = argv[i] as Tool;
        break;
      case '--here':
        args.scopeHere = true;
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
