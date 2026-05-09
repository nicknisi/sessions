import { C, disableColors } from "./colors";
import { type Tool, type CliArgs } from "./types";

const VALID_TOOLS = new Set<string>(["claude", "codex", "pi"]);

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
  -h, --help       Show this help

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
	const args: CliArgs = { toolFilter: "", searchQuery: "", scopeHere: false };

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i]!;
		switch (arg) {
			case "-h":
			case "--help":
				usage();
			case "--tool":
				i++;
				if (!argv[i] || !VALID_TOOLS.has(argv[i]!)) {
					die(`--tool requires one of: claude, codex, pi`);
				}
				args.toolFilter = argv[i] as Tool;
				break;
			case "--here":
				args.scopeHere = true;
				break;
			case "--no-color":
				disableColors();
				break;
			default:
				if (arg.startsWith("-")) die(`unknown option: ${arg}`);
				args.searchQuery = arg;
		}
		i++;
	}

	return args;
}

export function getRepoRoot(scopeHere: boolean): string {
	if (!scopeHere) return "";

	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
		let root = new TextDecoder().decode(result.stdout).trim();
		if (!root) return process.cwd();

		try {
			const parentGit = `${root}/../.git`;
			const content = require("fs").readFileSync(parentGit, "utf-8");
			if (content.includes("gitdir") && content.includes(".bare")) {
				root = require("path").resolve(root, "..");
			}
		} catch {
			// not a bare repo worktree
		}

		return root;
	} catch {
		return process.cwd();
	}
}
