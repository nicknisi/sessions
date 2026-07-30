import { writeFile } from 'node:fs/promises';
import { resolveRepo } from './repo';
import { getContextPrimer } from './cache';
import type { ContextPrimer, Tool } from './types';

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'pi', 'opencode']);

export interface ContextArgs {
  here: boolean; // scope to current repo (always true for this command)
  limit: number;
  days?: number;
  tool: Tool | '';
  full: boolean;
  worktreeOnly: boolean;
  out?: string;
  hook: boolean; // SessionStart-hook mode: tight defaults, never-throw, empty-on-nothing
}

/** Recent-tier size used by `--hook` mode: a small primer, not a transcript. */
export const HOOK_LIMIT = 3;

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
  --tool <name>    Filter: claude, codex, pi, opencode
  --full           Widen per-session detail
  --worktree       Restrict to the current worktree (default: all worktrees)
  --out <path>     Write the primer to a file instead of stdout
  --hook           SessionStart-hook mode: tiny primer, exit 0 on anything
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
    hook: false,
  };

  let limitExplicit = false;

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
        limitExplicit = true;
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
        if (!VALID_TOOLS.has(v)) die('--tool must be claude|codex|pi|opencode');
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
      case '--hook':
        args.hook = true;
        break;
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }

  // Hook mode is a tiny primer by default; an explicit --limit still wins.
  if (args.hook && !limitExplicit) args.limit = HOOK_LIMIT;

  return args;
}

const EMPTY_LINE = 'No past sessions found for this repo.';

/** Render a context primer as markdown: a `## Recent` detail tier + an `## Earlier` headline tier. */
/**
 * `## Memory`: what this user has already established here, ahead of what merely happened.
 *
 * First in the primer, and unconditional. `get_memory` is topic-conditional and an agent
 * has to choose to call it — the same "only fires when the model decides to" dependency
 * that left the previous lesson store at one row for months. This tier is the guaranteed
 * delivery; the tool stays the precise one.
 *
 * Standing constraints are marked, because "do not do X, ever" and "this repo uses Y" are
 * read differently, and the count left out is stated rather than implied — a primer that
 * silently shows 8 of 40 reads as the whole set.
 */
function renderMemory(primer: ContextPrimer): string[] {
  if (primer.memory.length === 0) return [];
  const out = ['\n## Memory\n'];
  for (const m of primer.memory) {
    const marks = [m.alwaysOn ? 'standing' : '', m.scope === 'repo' ? '' : m.scope].filter(Boolean);
    out.push(`- ${m.text}${marks.length > 0 ? ` _(${marks.join(' · ')})_` : ''}`);
  }
  const omitted = primer.memoryTotal - primer.memory.length;
  if (omitted > 0) {
    out.push(`- _+${omitted} more — call \`get_memory\` with a topic for the ones relevant to your task_`);
  }
  return out;
}

export function renderMarkdown(primer: ContextPrimer, full: boolean): string {
  if (primer.isEmpty) {
    return `# Context primer: ${primer.repoLabel}\n\n${EMPTY_LINE}\n`;
  }

  const out: string[] = [];
  out.push(`# Context primer: ${primer.repoLabel}`);
  if (primer.toolFilter) out.push(`\n_Filtered to ${primer.toolFilter} sessions._`);

  out.push(...renderMemory(primer));
  out.push('\n## Recent\n');
  for (const s of primer.recent) {
    out.push(`### ${s.date} · ${s.tool} · ${s.branch}`);
    out.push(`- **Intent:** ${s.intent || '(none)'}`);
    if (s.files.length > 0) {
      const shown = full ? s.files : s.files.slice(0, 5);
      // Count against fileCount, not files.length: the primer caps `files` upstream, so
      // the array no longer knows how many were dropped. `--full` widens the detail it is
      // given and still says so when the producer truncated — silent is the failure mode.
      const hidden = s.fileCount - shown.length;
      out.push(`- **Files:** ${shown.join(', ')}${hidden > 0 ? ` (+${hidden} more)` : ''}`);
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
  // Hook mode runs at session start: it must never error or block. On no repo,
  // no history, or any failure it degrades to injecting nothing (exit 0).
  if (args.hook) {
    await runContextHook(args);
    return;
  }

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

/**
 * SessionStart-hook mode. Bounded, fail-safe primer for injection at session
 * start. Prints a tiny markdown primer when there is repo history; prints
 * nothing (and never throws) otherwise. Always exits 0 so the hook can never
 * block or error a session start.
 */
async function runContextHook(args: ContextArgs): Promise<void> {
  try {
    const repo = resolveRepo(process.cwd());
    if (!repo) return; // not a git repo → inject nothing

    const primer = await getContextPrimer(repo, {
      limit: args.limit,
      days: args.days,
      tool: args.tool,
      worktreeOnly: args.worktreeOnly,
    });

    if (primer.isEmpty) return; // no history → inject nothing

    // Never widen detail in hook mode — keep the injected block small.
    process.stdout.write(renderMarkdown(primer, false));
    // Standing pointer for the agent: the primer is a snapshot, not the archive.
    process.stdout.write(
      '\n> This is a snapshot of recent sessions on this repo. Full history across all past sessions is searchable — use the sessions MCP tools (search_sessions, get_session_digest, get_context_primer) when prior work, decisions, or dead ends are referenced.\n',
    );
  } catch {
    // Any failure at session start degrades to injecting nothing.
  }
}
