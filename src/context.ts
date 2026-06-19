import { writeFile } from 'node:fs/promises';
import { resolveRepo } from './repo';
import { getContextPrimer } from './cache';
import type { ContextPrimer, Tool } from './types';

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'pi']);

export interface ContextArgs {
  here: boolean; // scope to current repo (always true for this command)
  limit: number;
  days?: number;
  tool: Tool | '';
  full: boolean;
  worktreeOnly: boolean;
  out?: string;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions context — load a context primer for the current repo

Prints a markdown primer of recent sessions (in detail) plus older headlines,
for pasting into a tool without skill support. Inherently repo-scoped.

Usage:
  sessions context                 Primer for the current repo
  sessions context --full          Wider per-session detail
  sessions context --out p.md      Write to a file instead of stdout

Options:
  --limit N        Recent-tier size (default 10)
  --days N         Only include sessions from the last N days
  --tool <name>    Filter: claude, codex, pi
  --full           Widen per-session detail
  --worktree       Restrict to the current worktree (default: all worktrees)
  --out <path>     Write the primer to a file instead of stdout
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseContextArgs(argv: string[]): ContextArgs {
  const args: ContextArgs = {
    here: true,
    limit: 10,
    tool: '',
    full: false,
    worktreeOnly: false,
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        help();
      case '--limit': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('--limit must be a positive integer');
        args.limit = v;
        break;
      }
      case '--days': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('--days must be a positive integer');
        args.days = v;
        break;
      }
      case '--tool': {
        const v = argv[++i] ?? '';
        if (!VALID_TOOLS.has(v)) die('--tool must be claude|codex|pi');
        args.tool = v as Tool;
        break;
      }
      case '--here':
        // No-op: `context` is inherently repo-scoped. Accepted so the documented
        // `sessions context --here` invocation works without surprising users.
        args.here = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--worktree':
        args.worktreeOnly = true;
        break;
      case '--out':
        args.out = argv[++i];
        if (!args.out) die('--out requires a path');
        break;
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }

  return args;
}

const EMPTY_LINE = 'No past sessions found for this repo.';

/** Render a context primer as markdown: a `## Recent` detail tier + an `## Earlier` headline tier. */
export function renderMarkdown(primer: ContextPrimer, full: boolean): string {
  if (primer.isEmpty) {
    return `# Context primer: ${primer.repoLabel}\n\n${EMPTY_LINE}\n`;
  }

  const out: string[] = [];
  out.push(`# Context primer: ${primer.repoLabel}`);
  if (primer.toolFilter) out.push(`\n_Filtered to ${primer.toolFilter} sessions._`);

  out.push('\n## Recent\n');
  for (const s of primer.recent) {
    out.push(`### ${s.date} · ${s.tool} · ${s.branch}`);
    out.push(`- **Intent:** ${s.intent || '(none)'}`);
    if (s.files.length > 0) {
      const shown = full ? s.files : s.files.slice(0, 5);
      out.push(
        `- **Files:** ${shown.join(', ')}${!full && s.files.length > 5 ? ` (+${s.files.length - 5} more)` : ''}`,
      );
    }
    if (full && s.opening && s.opening !== s.intent) {
      out.push(`- **Opening:** ${s.opening}`);
    }
    if (s.closing.user) out.push(`- **Closing (user):** ${s.closing.user}`);
    if (s.closing.assistant) out.push(`- **Closing (assistant):** ${s.closing.assistant}`);
    out.push('');
  }

  if (primer.headlines.length > 0) {
    out.push('## Earlier\n');
    for (const h of primer.headlines) {
      out.push(`- **${h.date}** (${h.tool} · ${h.branch}) — ${h.intent || '(none)'}`);
    }
    out.push('');
  }

  return out.join('\n');
}

export async function runContext(args: ContextArgs): Promise<void> {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    process.stderr.write('Not inside a git repository.\n');
    process.exit(0);
  }

  const primer = await getContextPrimer(repo, {
    limit: args.limit,
    days: args.days,
    tool: args.tool,
    worktreeOnly: args.worktreeOnly,
  });

  const md = renderMarkdown(primer, args.full);

  if (args.out) {
    try {
      await writeFile(args.out, md, 'utf-8');
      process.stderr.write(`wrote ${args.out}\n`);
    } catch (e) {
      die(`could not write ${args.out}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    process.stdout.write(md.endsWith('\n') ? md : md + '\n');
  }
}
