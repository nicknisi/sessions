import { writeFile } from 'node:fs/promises';
import { resolveRepo } from './repo';
import { getContextPrimer } from './cache';
import { LESSON_HOOK_LIMIT } from './memory';
import { writeHandoff } from './provenance';
import { envelope } from './search-format';
import { writeStdoutFully } from './stdout';
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
  json: boolean; // emit the primer as a versioned envelope instead of markdown
  noRefresh: boolean; // serve the index as-is; never scan, never build one
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
  --json           Emit the primer as JSON: the ContextPrimer fields under a
                   {generator, version} envelope. Outside a git repo it still
                   prints a valid empty envelope, never nothing
  --no-refresh     Serve the index as-is instead of scanning for new transcripts.
                   With no index yet, serves lessons only and builds nothing
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
    json: false,
    noRefresh: false,
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
      case '--json':
        args.json = true;
        break;
      case '--no-refresh':
        args.noRefresh = true;
        break;
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }

  // Hook mode appends a prose pointer paragraph after the primer and swallows every
  // error, so a caller asking for both would get markdown trailing its JSON. Rejected
  // rather than silently letting one win.
  if (args.json && args.hook) die('--json cannot be combined with --hook');

  // Hook mode is a tiny primer by default; an explicit --limit still wins.
  if (args.hook && !limitExplicit) args.limit = HOOK_LIMIT;

  return args;
}

const EMPTY_LINE = 'No past sessions found for this repo.';

/**
 * Lesson text budget, hook mode and full. Truncation drops whole lessons — half a
 * lesson is worse than a missing one, because the half that survives reads as the
 * complete claim.
 */
export const LESSONS_MAX_CHARS_HOOK = 1200;
export const LESSONS_MAX_CHARS_FULL = 3000;

/** `## Lessons`: what was learned here, ahead of what merely happened here. */
function renderLessons(primer: ContextPrimer, maxChars: number): string[] {
  if (primer.lessons.length === 0 && primer.lessonsFlagged === 0 && primer.lessonsQuarantined.length === 0) {
    return [];
  }

  const out: string[] = ['## Lessons\n'];
  // First, and outside the char budget: an empty lesson list and a lesson store that
  // was moved aside look identical, and only one of them means something was lost.
  for (const path of primer.lessonsQuarantined) {
    out.push(
      `- **The lesson store was corrupt and moved to \`${path}\`.** Nothing from it is being served and nothing was deleted — recover it (\`sqlite3 <file> .dump\`) or remove it to clear this notice.`,
    );
  }

  let used = 0;
  let shown = 0;
  for (const l of primer.lessons) {
    const scope = l.scope === 'global' ? ' · global' : '';
    // An unauditable lesson is still worth serving, but never silently: the mark is
    // the difference between a claim you can trace and one you cannot.
    const mark = l.verified ? '' : ' · unverified source';
    const line = `- ${l.lesson}${l.detail ? ` — ${l.detail}` : ''} _(#${l.id}${scope}${mark})_`;
    if (shown > 0 && used + line.length > maxChars) break;
    out.push(line);
    used += line.length;
    shown++;
  }

  const omitted = primer.lessonsTotal - shown;
  if (omitted > 0) out.push(`- _+${omitted} more — run \`sessions lessons\`_`);
  if (primer.lessonsFlagged > 0) {
    out.push(
      `- _${primer.lessonsFlagged} lesson${primer.lessonsFlagged === 1 ? '' : 's'} flagged as conflicting and withheld — run \`sessions lessons review\`_`,
    );
  }
  out.push('');
  return out;
}

/** Render a context primer as markdown: `## Lessons`, then a `## Recent` detail tier + an `## Earlier` headline tier. */
export function renderMarkdown(primer: ContextPrimer, full: boolean, lessonsMaxChars = LESSONS_MAX_CHARS_FULL): string {
  if (primer.isEmpty) {
    return `# Context primer: ${primer.repoLabel}\n\n${EMPTY_LINE}\n`;
  }

  const out: string[] = [];
  out.push(`# Context primer: ${primer.repoLabel}`);
  if (primer.toolFilter) out.push(`\n_Filtered to ${primer.toolFilter} sessions._`);

  out.push('');
  out.push(...renderLessons(primer, lessonsMaxChars));

  if (primer.recent.length === 0 && primer.headlines.length === 0) return out.join('\n');

  out.push('## Recent\n');
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
  // Hook mode runs at session start: it must never error or block. On no repo,
  // no history, or any failure it degrades to injecting nothing (exit 0).
  if (args.hook) {
    await runContextHook(args);
    return;
  }

  const repo = resolveRepo(process.cwd());
  if (!repo) {
    // A machine surface has to emit parseable bytes even when there is nothing to say:
    // today's "message on stderr, empty stdout" makes a statusline call JSON.parse('')
    // and throw. An empty primer says the same thing in a shape the caller can read.
    if (args.json) {
      await emitContext(JSON.stringify(envelope(EMPTY_PRIMER)), args);
      return;
    }
    process.stderr.write('Not inside a git repository.\n');
    process.exit(0);
  }

  const primer = await getContextPrimer(repo, {
    limit: args.limit,
    days: args.days,
    tool: args.tool,
    worktreeOnly: args.worktreeOnly,
    noRefresh: args.noRefresh,
  });

  // Non-pretty, matching the MCP handlers: indentation is pure byte cost on a machine
  // surface. The envelope is a CLI concern only — get_context_primer (src/mcp.ts) keeps
  // returning the bare primer, because its clients pin the MCP protocol version instead.
  await emitContext(args.json ? JSON.stringify(envelope(primer)) : renderMarkdown(primer, args.full), args);
}

/** Not a git repo, in the shape `--json` promises: every ContextPrimer field, all empty. */
const EMPTY_PRIMER: ContextPrimer = {
  repoLabel: '',
  toolFilter: '',
  recent: [],
  headlines: [],
  lessons: [],
  lessonsFlagged: 0,
  lessonsTotal: 0,
  lessonsQuarantined: [],
  isEmpty: true,
};

/** `--out` writes whatever `--json` decided the body is; stdout gets the same bytes
 *  otherwise. writeStdoutFully because index.ts process.exit()s the moment runContext
 *  returns, and a bare write truncates a piped primer at the 64KB pipe buffer. */
async function emitContext(body: string, args: ContextArgs): Promise<void> {
  const text = body.endsWith('\n') ? body : body + '\n';
  if (args.out) {
    try {
      await writeFile(args.out, text, 'utf-8');
      process.stderr.write(`wrote ${args.out}\n`);
    } catch (e) {
      die(`could not write ${args.out}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  await writeStdoutFully(text);
}

/** The SessionStart payload Claude Code writes to the hook's stdin. */
interface SessionStartPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
}

/**
 * Read the hook payload, or give up quickly.
 *
 * A client that pipes nothing leaves stdin open forever, and the hook has a 10s
 * budget it must stay well inside. The unresolved read is simply abandoned — the
 * `context` command exits the process when it returns, so nothing is left hanging.
 */
async function readHookPayload(timeoutMs = 250): Promise<SessionStartPayload | null> {
  const text = await Promise.race([
    Bun.stdin.text(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!text) return null;
  try {
    const payload = JSON.parse(text) as SessionStartPayload;
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Hand the MCP server what only the hook knows.
 *
 * The hook is told the session id and transcript path directly, and it fires again
 * with the correct ones after a resume — which is exactly where the inherited
 * CLAUDE_CODE_SESSION_ID lies. Keyed by that inherited value, stale or not, because
 * both processes are children of the same client and so agree on it.
 */
function handOffSession(payload: SessionStartPayload | null): void {
  if (!payload?.session_id || !payload.transcript_path) return;
  const key = process.env.CLAUDE_CODE_SESSION_ID || payload.session_id;
  writeHandoff(key, {
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd ?? process.cwd(),
    source: payload.source ?? '',
    writtenAt: new Date().toISOString(),
  });
}

/**
 * SessionStart-hook mode. Bounded, fail-safe primer for injection at session
 * start. Prints a tiny markdown primer when there is repo history; prints
 * nothing (and never throws) otherwise. Always exits 0 so the hook can never
 * block or error a session start.
 */
async function runContextHook(args: ContextArgs): Promise<void> {
  try {
    // Inside the same try as everything else: a read-only HOME must not fail a
    // session start just because provenance could not be recorded.
    handOffSession(await readHookPayload());

    const repo = resolveRepo(process.cwd());
    if (!repo) return; // not a git repo → inject nothing

    const primer = await getContextPrimer(repo, {
      limit: args.limit,
      days: args.days,
      tool: args.tool,
      worktreeOnly: args.worktreeOnly,
      lessonLimit: LESSON_HOOK_LIMIT,
    });

    if (primer.isEmpty) return; // no history → inject nothing

    // Never widen detail in hook mode — keep the injected block small. Awaited for the
    // same reason as the primer path: index.ts exits the moment this returns.
    await writeStdoutFully(renderMarkdown(primer, false, LESSONS_MAX_CHARS_HOOK));
    // Standing pointer for the agent: the primer is a snapshot, not the archive — and
    // the store is written, not only read. Nothing else fires at the moment something
    // is learned, so the one sentence that says "save it" has to ride along here.
    await writeStdoutFully(
      '\n> This is a snapshot of recent sessions on this repo. Full history across all past sessions is searchable — use the sessions MCP tools (search_sessions, get_session_digest, get_context_primer) when prior work, decisions, or dead ends are referenced. When this session turns up something the next one would otherwise re-derive — a root cause that took real work, a correction from the user, an approach that looked right and was not — call remember_lesson before you finish.\n',
    );
  } catch {
    // Any failure at session start degrades to injecting nothing.
  }
}
