import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { C } from './colors';
import { resolveRepo } from './repo';
import { getClaudeDir, getMemoryDbPath } from './paths';
import { sessionIdFor } from './session-id';
import { writeStdoutFully } from './stdout';
import {
  acceptProposal,
  deferredLessons,
  exportLessons,
  listLessons,
  listProposals,
  quarantinedStores,
  recoverLesson,
  rejectProposal,
  resolveReview,
  reviewGroups,
  retireLesson,
  type LessonRow,
  type ReviewChoice,
} from './memory';

export type LessonsAction = 'list' | 'review' | 'export' | 'audit' | 'retire';

/** What `review` does with a distilled proposal when nobody is at a terminal. */
export type ProposalChoice = 'accept' | 'reject';

export interface LessonsArgs {
  action: LessonsAction;
  all: boolean;
  out?: string;
  id?: number;
  /** Non-interactive resolution for `review`, so the walk is scriptable and testable. */
  keep?: ReviewChoice;
  /** The same, for the proposal queue — which needs accept/reject, not new/old/both. */
  proposals?: ProposalChoice;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions lessons — what past sessions concluded, not what they did

Lessons are saved by the remember_lesson MCP tool and served by the context
primer. They live in ${getMemoryDbPath()}, outside the search index, and
survive --clear-cache, cleanup, and uninstall.

Usage:
  sessions lessons                 Lessons in scope for the current repo
  sessions lessons --all           Every lesson, every repo
  sessions lessons review          Resolve conflicts and distilled proposals
  sessions lessons export          Print every lesson as JSON
  sessions lessons audit           Trace deferred provenance back to a session
  sessions lessons retire <id>     Take one lesson out of service (never deleted)

Options:
  --all            Ignore repo scope
  --out <path>     Write export output to a file instead of stdout
  --keep <which>   review: resolve every conflict non-interactively (new|old|both)
  --proposals <x>  review: decide every distilled proposal non-interactively
                   (accept|reject)
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseLessonsArgs(argv: string[]): LessonsArgs {
  const args: LessonsArgs = { action: 'list', all: false };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        help();
      case 'list':
      case 'review':
      case 'export':
      case 'audit':
        args.action = a;
        break;
      case 'retire': {
        args.action = 'retire';
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('retire needs a lesson id');
        args.id = v;
        break;
      }
      case '--all':
        args.all = true;
        break;
      case '--out':
        args.out = argv[++i];
        if (!args.out) die('--out requires a path');
        break;
      case '--keep': {
        const v = argv[++i] ?? '';
        if (v !== 'new' && v !== 'old' && v !== 'both') die('--keep must be new|old|both');
        args.keep = v;
        break;
      }
      case '--proposals': {
        const v = argv[++i] ?? '';
        if (v !== 'accept' && v !== 'reject') die('--proposals must be accept|reject');
        args.proposals = v;
        break;
      }
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }

  return args;
}

/** `hook`/`env`/`meta` are traceable; `deferred` and `none` are not, and say so. */
function provenanceLabel(row: LessonRow): string {
  if (row.source_verified === 1 && row.source_session) return `${row.provenance} · ${row.source_session.slice(0, 8)}`;
  if (row.provenance === 'deferred') return 'deferred · run `sessions lessons audit`';
  return `${row.provenance} · unverifiable`;
}

/** Names the decision a row is in, so it can be seen and undone. */
function statusLabel(row: LessonRow): string {
  switch (row.status) {
    case 'active':
      return 'active';
    case 'needs_review':
      return 'pending review';
    case 'retired':
      return 'retired';
    case 'superseded':
      return `superseded by #${row.superseded_by}`;
    case 'proposed':
      return 'proposed, awaiting review';
  }
}

function formatRow(row: LessonRow): string {
  const scope = row.scope === 'global' ? 'global' : basename(row.repo_container) || 'repo';
  // Everything but `active` is marked. In `review` that is what separates the rows
  // being decided from the ones only there to explain the conflict.
  const state = row.status === 'active' ? '' : ` · ${statusLabel(row)}`;
  const out = [`${C.bold}#${row.id}${C.reset} ${row.lesson}`];
  if (row.detail) out.push(`     ${C.dim}${row.detail}${C.reset}`);
  out.push(`     ${C.dim}${scope} · ${row.created_at.slice(0, 10)} · ${provenanceLabel(row)}${state}${C.reset}`);
  return out.join('\n');
}

/** A store that was moved aside is reported before anything else, on every listing. */
function warnQuarantined(): void {
  for (const path of quarantinedStores()) {
    process.stderr.write(
      `${C.red}!${C.reset} the lesson store was corrupt and was moved aside — nothing in it is being served:\n` +
        `    ${path}\n` +
        `${C.dim}  Nothing was deleted. Recover it with \`sqlite3 <file> .dump\`, or remove it to clear this notice.${C.reset}\n`,
    );
  }
}

async function runList(args: LessonsArgs): Promise<void> {
  const repo = resolveRepo(process.cwd());
  const rows = listLessons({
    all: args.all,
    container: repo?.container ?? '',
    remote: repo?.remote ?? '',
  });
  // After the read, which is what moves a corrupt file aside.
  warnQuarantined();

  const active = rows.filter((r) => r.status === 'active');
  const flagged = rows.filter((r) => r.status === 'needs_review');
  const proposed = rows.filter((r) => r.status === 'proposed');
  const gone = rows.filter((r) => r.status === 'superseded' || r.status === 'retired');

  if (rows.length === 0) {
    const where = args.all ? '' : ' for this repo';
    process.stderr.write(`${C.dim}No lessons${where}. They are saved by the remember_lesson MCP tool.${C.reset}\n`);
    return;
  }

  const out: string[] = [];
  for (const row of active) out.push(formatRow(row));
  if (flagged.length > 0) {
    out.push(
      `\n${C.yellow}${flagged.length} lesson${flagged.length === 1 ? '' : 's'} flagged as conflicting${C.reset} ` +
        `${C.dim}— withheld from the primer until resolved. Run \`sessions lessons review\`.${C.reset}`,
    );
  }
  // Distilled proposals are listed in full, not as a count: unlike a conflict, there is
  // nothing to arbitrate — the only way to decide one is to read it. A row that matched
  // none of these buckets would be counted by the `rows.length === 0` guard above and
  // then printed nowhere, which is how a whole distill run goes invisible.
  if (proposed.length > 0) {
    out.push(
      `\n${C.yellow}${proposed.length} distilled proposal${proposed.length === 1 ? '' : 's'} awaiting review${C.reset} ` +
        `${C.dim}— never served until accepted. Run \`sessions lessons review\`.${C.reset}`,
    );
    for (const row of proposed) out.push(formatRow(row));
  }
  // A row can leave service without anyone watching — a review, a retire, or a
  // supersedes from an agent. Listing them is what makes that reversible.
  if (gone.length > 0) {
    out.push(`\n${C.dim}${gone.length} out of service — kept, never deleted:${C.reset}`);
    for (const row of gone) out.push(`${C.dim}  #${row.id} ${statusLabel(row)} — ${row.lesson}${C.reset}`);
  }
  await writeStdoutFully(out.join('\n') + '\n');
}

async function runReview(args: LessonsArgs): Promise<void> {
  // Same scope rule as `sessions lessons`: --all or the repo you are standing in. A
  // review queue that ignored scope would walk proposals mined out of another checkout
  // while the listing beside it showed only this one's.
  const repo = resolveRepo(process.cwd());
  const scope = { all: args.all, container: repo?.container ?? '', remote: repo?.remote ?? '' };
  const proposals = listProposals(scope);
  warnQuarantined();

  if (proposals.length === 0 && reviewGroups().length === 0) {
    process.stderr.write(`${C.dim}No conflicting lessons or proposals to review.${C.reset}\n`);
    return;
  }

  // Proposals first, and as their own pass. A conflict is arbitration between rival
  // claims (new/old/both); a proposal is a machine's guess nobody has read yet, and the
  // only question is whether it earns a place at all.
  for (const row of proposals) {
    process.stderr.write(`\n${C.bold}Proposal${C.reset} ${C.dim}(from \`sessions distill\`)${C.reset}\n`);
    process.stderr.write(`${formatRow(row)}\n`);

    const choice = args.proposals ?? askProposal();
    if (!choice) {
      process.stderr.write(`  ${C.dim}skipped${C.reset}\n`);
      continue;
    }
    if (choice === 'reject') {
      rejectProposal(row.id);
      process.stderr.write(`  ${C.green}✓${C.reset} rejected — retired, not deleted\n`);
      continue;
    }
    // Accepting runs the ordinary save path, so a proposal that overlaps a live lesson
    // lands in the conflict quarantine rather than becoming a second copy of it.
    const result = acceptProposal(row.id);
    const mark = result.outcome === 'rejected' ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
    process.stderr.write(`  ${mark} ${result.message}\n`);
  }

  // Re-read AFTER the proposal walk, never before it. Accepting a proposal that overlaps
  // a live lesson routes through saveLesson and OPENS a conflict group; a snapshot taken
  // up front would not contain it, so the decision the accept just created would sit
  // there unoffered until somebody thought to run review again.
  for (const group of reviewGroups()) {
    process.stderr.write(`\n${C.bold}Conflict${C.reset} ${C.dim}(group ${group.group})${C.reset}\n`);
    for (const row of group.rows) process.stderr.write(`${formatRow(row)}\n`);
    // A group can carry rows that are only there to explain it — a retired lesson the
    // newcomer overlaps, or a supersedes target it never matched. Say so, because the
    // choice below does not touch them.
    if (group.rows.some((r) => r.status !== 'needs_review')) {
      process.stderr.write(
        `  ${C.dim}Only the rows marked "pending review" are decided here; the rest are context and stay as they are.${C.reset}\n`,
      );
    }

    // Nothing is ever merged. Whichever way this goes, both texts stay readable —
    // the loser is marked superseded or retired, not rewritten.
    const choice = args.keep ?? askChoice();
    if (!choice) {
      process.stderr.write(`  ${C.dim}skipped${C.reset}\n`);
      continue;
    }
    resolveReview(group.group, choice);
    process.stderr.write(`  ${C.green}✓${C.reset} kept ${choice}\n`);
  }
}

/** Ask once per group. A non-TTY (or anything unrecognized) skips rather than guessing. */
function askChoice(): ReviewChoice | null {
  if (!process.stdin.isTTY) return null;
  process.stderr.write(`  ${C.dim}Keep [n]ew / [o]ld / [b]oth / [s]kip? ${C.reset}`);
  const answer = (prompt('') ?? '').trim().toLowerCase();
  if (answer === 'n' || answer === 'new') return 'new';
  if (answer === 'o' || answer === 'old') return 'old';
  if (answer === 'b' || answer === 'both') return 'both';
  return null;
}

/** Same contract as askChoice: a non-TTY skips rather than guessing, and `--proposals`
 *  is what makes the walk scriptable — and therefore testable. */
function askProposal(): ProposalChoice | null {
  if (!process.stdin.isTTY) return null;
  process.stderr.write(`  ${C.dim}[a]ccept / [r]eject / [s]kip? ${C.reset}`);
  const answer = (prompt('') ?? '').trim().toLowerCase();
  if (answer === 'a' || answer === 'accept') return 'accept';
  if (answer === 'r' || answer === 'reject') return 'reject';
  return null;
}

async function runExport(args: LessonsArgs): Promise<void> {
  const json = JSON.stringify(exportLessons(), null, 2) + '\n';
  if (args.out) {
    await writeFile(args.out, json, 'utf-8');
    process.stderr.write(`wrote ${args.out}\n`);
    return;
  }
  await writeStdoutFully(json);
}

export interface AuditResult {
  scanned: number;
  recovered: number;
  unresolved: number;
  grepFailed: boolean;
}

/**
 * Promote deferred rows to `recovered`.
 *
 * A deferred lesson has no session id but does have the tool_use id its client sent,
 * which appears verbatim in the transcript on disk. It is client-generated, the model
 * never sees it, and it is unique across the corpus — so an exact-literal search for
 * it is an unforgeable way to find the conversation after the fact.
 */
export function auditDeferred(): AuditResult {
  const pending = deferredLessons();
  const result: AuditResult = { scanned: pending.length, recovered: 0, unresolved: 0, grepFailed: false };

  for (const row of pending) {
    const needle = row.source_tool_use_id!;
    let out: string;
    try {
      const proc = Bun.spawnSync(['grep', '-rlF', '--include=*.jsonl', needle, getClaudeDir()]);
      // grep exits 1 for "no match" and 2 for a real error; only 2 is our problem.
      if (proc.exitCode === 2) {
        result.grepFailed = true;
        break;
      }
      out = new TextDecoder().decode(proc.stdout).trim();
    } catch {
      result.grepFailed = true;
      break;
    }

    const hit = out.split('\n').find(Boolean);
    if (!hit) {
      result.unresolved++;
      continue;
    }
    recoverLesson(row.id, sessionIdFor(hit, 'claude'), hit);
    result.recovered++;
  }

  return result;
}

function runAudit(): void {
  const res = auditDeferred();
  if (res.scanned === 0) {
    process.stderr.write(`${C.dim}No lessons are waiting on provenance.${C.reset}\n`);
    return;
  }
  if (res.grepFailed) {
    process.stderr.write(`${C.red}✗${C.reset} could not search the transcripts (grep unavailable).\n`);
    return;
  }
  process.stderr.write(
    `${C.green}✓${C.reset} traced ${res.recovered} of ${res.scanned} lesson${res.scanned === 1 ? '' : 's'} back to a session` +
      (res.unresolved > 0 ? `; ${res.unresolved} had no matching transcript and stay deferred` : '') +
      '\n',
  );
}

function runRetire(id: number): void {
  if (retireLesson(id)) {
    process.stderr.write(`${C.green}✓${C.reset} lesson #${id} retired. It is out of the primer, not deleted.\n`);
  } else {
    process.stderr.write(`${C.dim}No active lesson #${id}.${C.reset}\n`);
  }
}

export async function runLessons(args: LessonsArgs): Promise<void> {
  switch (args.action) {
    case 'list':
      return runList(args);
    case 'review':
      return runReview(args);
    case 'export':
      return runExport(args);
    case 'audit':
      return runAudit();
    case 'retire':
      return runRetire(args.id!);
  }
}
