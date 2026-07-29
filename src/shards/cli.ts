// Arg parsing and dispatch for the `shards` command group. Phase 1 shipped `mine`;
// Phase 2 adds approve/reject/snooze, Phase 4 adds export/import.
//
// The batch JSON goes to stdout and everything human-readable goes to stderr —
// that split is what makes `sessions shards mine | <agent>` a usable interface.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolveRepo } from '../repo';
import { writeStdoutFully } from '../stdout';
import { createContainerResolver, mine } from './mine';
import { fromPortable, merge, toPortable, toRecord } from './portable';
import { getPersistedStates, listShards, upsertCandidates, type PersistedState } from './store';
import { approve, dropSuppressed, isKnownShard, reject, snooze, snoozeUntil, suppressedShards } from './triage';
import { SHARD_SCHEMA_VERSION, type PortableShard, type ShardRecord } from './types';

/**
 * A bad invocation. Thrown rather than exiting inline so `parseMineArgs` stays a
 * pure function a test can drive; `runShards` turns it into the stderr + exit 1
 * the CLI contract promises.
 */
export class UsageError extends Error {}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions shards — mine durable facts out of past sessions

Narrows past user turns to corrective-shaped candidates, collapses repeats, and
emits a candidate batch as JSON on stdout for an agent to triage. Candidates are
also written to a durable store (~/.local/share/sessions/shards.db) that survives
--clear-cache and cleanup.

Usage:
  sessions shards mine             Mine the current repo
  sessions shards mine --all       Mine every repo in the index
  sessions shards approve <id>     Keep a candidate as a durable shard
  sessions shards reject <id>      Dismiss a candidate; it stops being emitted
  sessions shards snooze <id>      Suppress a candidate for 30 days
  sessions shards export           Write approved shards as a portable bundle
  sessions shards import <path>    Merge another author's bundle in as candidates

Options:
  --repo <path>    Scope to one repo container (default: the current repo)
  --all            Mine every repo in the index
  --json           Emit the candidate batch as JSON on stdout (the default)
  --out <path>     Write the export bundle to a file instead of stdout
  -h, --help       Show this help

<id> is the \`id\` field of a record from the mine's JSON batch. A rejected
candidate never returns; a snoozed one returns only if new distinct phrasings
appear after the snooze expires.

Export carries approved shards only, and strips session paths and repo paths —
nothing about this machine's directory layout leaves it. There is no transport:
the bundle is a plain file, so whatever you already use (a git ref, a shared
drive, scp) carries it. Imported shards land as candidates for you to triage,
never as approved. Shards merge on a hash of their text, so two people who
phrase one fact differently produce two shards; clustering paraphrases is the
/shards skill's job, not a mechanical one.
`);
  process.exit(0);
}

/** Today in UTC as 'YYYY-MM-DD'. The only clock read in the shard pipeline — every
 *  function under src/shards/ takes the date as an argument so tests stay hermetic. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MineArgs {
  repo?: string;
  all: boolean;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/** Parse `shards mine` flags. Throws `UsageError` on a bad invocation; never exits. */
export function parseMineArgs(argv: string[]): MineArgs {
  const args: MineArgs = { all: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        // Help wins over everything after it: `--help --bogus` prints help.
        return { ...args, help: true };
      case '--repo': {
        const value = argv[++i];
        if (!value) throw new UsageError('--repo requires a path');
        args.repo = value;
        break;
      }
      case '--all':
        args.all = true;
        break;
      case '--json':
        // JSON on stdout is unconditional — the batch is the interface. Accepted
        // so the documented invocation works and stays explicit at call sites.
        break;
      default:
        throw new UsageError(`unknown option: ${a}`);
    }
    i++;
  }
  if (args.all && args.repo) throw new UsageError('--all and --repo are mutually exclusive');
  return args;
}

/** A triage subcommand: one positional shard id, no flags but `-h`. */
export type TriageAction = 'approve' | 'reject' | 'snooze';

export interface TriageArgs {
  id?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `shards approve|reject|snooze <id>`. Throws `UsageError`; never exits.
 *
 * A separate parser rather than a reuse: `parseMineArgs` treats every bare word as
 * an unknown option, because `mine` takes no positionals. These take exactly one.
 */
export function parseTriageArgs(argv: string[]): TriageArgs {
  const args: TriageArgs = { help: false };
  for (const a of argv) {
    // Help wins over everything after it, matching parseMineArgs.
    if (a === '-h' || a === '--help') return { help: true };
    if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
    if (args.id !== undefined) throw new UsageError(`unexpected argument: ${a} (expected exactly one shard id)`);
    args.id = a;
  }
  return args;
}

export interface ExportArgs {
  /** Write the bundle here instead of stdout. */
  out?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `shards export [--out <path>]`. Throws `UsageError`; never exits.
 *
 * A third parser rather than a reuse: `parseTriageArgs` rejects anything starting
 * with `-`, so it cannot take `--out`, and its duplicate-positional message names a
 * "shard id" — misleading for a file path.
 */
export function parseExportArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = { help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        return { ...args, help: true };
      case '--out': {
        const value = argv[++i];
        if (!value) throw new UsageError('--out requires a path');
        args.out = value;
        break;
      }
      default:
        throw new UsageError(`unknown option: ${a}`);
    }
    i++;
  }
  return args;
}

export interface ImportArgs {
  /** Path to a bundle written by `shards export`. */
  path?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/** Parse `shards import <path>`. Throws `UsageError`; never exits. */
export function parseImportArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = { help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { help: true };
    if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
    if (args.path !== undefined) throw new UsageError(`unexpected argument: ${a} (expected exactly one bundle path)`);
    args.path = a;
  }
  return args;
}

/**
 * Overlay the store's triage state onto a freshly mined batch.
 *
 * `mine()` reads transcripts, so every record it builds says `candidate`. The pipe
 * is the documented Phase 2 interface, so it has to carry the same truth the table
 * does — otherwise a shard the user rejected last week is re-presented as a fresh
 * candidate on every run. Spreading over the existing keys preserves field order,
 * which the determinism criterion compares byte for byte.
 */
export function applyPersistedStates(records: ShardRecord[], persisted: Map<string, PersistedState>): ShardRecord[] {
  return records.map((r) => {
    const stored = persisted.get(r.id);
    return stored ? { ...r, state: stored.state, snoozedUntil: stored.snoozedUntil } : r;
  });
}

async function runMine(argv: string[]): Promise<void> {
  const args = parseMineArgs(argv);
  if (args.help) help();
  // Resolve whatever path we were given to its repo container, so `--repo "$PWD"`
  // works from a linked worktree and still mines the whole repo's sessions.
  const containerOf = createContainerResolver();

  let repo: string | undefined;
  if (!args.all) {
    const target = args.repo ?? process.cwd();
    if (args.repo || resolveRepo(target)) {
      repo = containerOf(target);
    } else {
      process.stderr.write('  not inside a git repository — mining every repo in the index\n');
    }
  }

  process.stderr.write(`  mining ${repo ?? 'all repos'}...\n`);
  const mined = await mine({ repo });
  // Snapshot the suppression set BEFORE upsertCandidates: its ON CONFLICT refreshes
  // `evidence` (store.ts ON CONFLICT), which would overwrite the distinctPhrasings
  // baseline shouldResurface compares the fresh count against.
  const suppressed = suppressedShards();
  upsertCandidates(mined);
  // Read the state back rather than trusting the fresh records: upsertCandidates
  // deliberately preserves a stored state (store.ts ON CONFLICT), so the batch on
  // stdout would otherwise disagree with the database it just wrote.
  const records = applyPersistedStates(mined, getPersistedStates(mined.map((r) => r.id)));
  // Everything the user already dismissed leaves the pipe — re-presenting it on
  // every run is the triage-fatigue failure mode. The rows stay in the table with
  // their evidence refreshed; only the batch narrows.
  const batch = dropSuppressed(records, suppressed, todayIso());

  await writeStdoutFully(JSON.stringify(batch, null, 2) + '\n');
  const fresh = batch.filter((r) => r.state === 'candidate').length;
  const hidden = records.length - batch.length;
  process.stderr.write(
    `  ${batch.length} candidate${batch.length === 1 ? '' : 's'}` +
      (fresh === batch.length ? '' : ` (${fresh} untriaged)`) +
      (hidden > 0 ? `, ${hidden} suppressed` : '') +
      '\n',
  );
}

/**
 * Persist one triage decision.
 *
 * The existence check is not defensive padding: `setState` is a bare
 * `UPDATE ... WHERE id = ?` (store.ts), so a mistyped id would exit 0 having
 * changed nothing and the agent driving the skill would report a decision that was
 * never recorded.
 */
function runTriage(action: TriageAction, argv: string[]): void {
  const args = parseTriageArgs(argv);
  if (args.help) help();
  const id = args.id;
  if (!id) throw new UsageError(`${action} requires a shard id (the \`id\` field from \`shards mine\`)`);
  if (!isKnownShard(id)) throw new UsageError(`unknown shard id: ${id}`);

  const today = todayIso();
  switch (action) {
    case 'approve':
      approve(id);
      process.stderr.write(`  approved ${id}\n`);
      return;
    case 'reject':
      reject(id);
      process.stderr.write(`  rejected ${id}\n`);
      return;
    case 'snooze':
      snooze(id, today);
      process.stderr.write(`  snoozed ${id} until ${snoozeUntil(today)}\n`);
      return;
  }
}

/** The message of a thrown value, without assuming it is an Error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write approved shards as a portable bundle.
 *
 * stdout by default so it pipes straight into whatever transport the team already
 * has; `--out` mirrors the convention in src/context.ts:100-103,183-188, down to the
 * `wrote <path>` line on stderr. The payload goes through `writeStdoutFully`
 * (src/stdout.ts:14-18) for the same reason the mine batch does — a bare write plus
 * the CLI's process.exit truncates a piped bundle at 64KB.
 *
 * The approved-only filter is a `listShards` WHERE rather than a post-filter, so an
 * unreviewed candidate has no path into the file at all.
 */
async function runExport(argv: string[]): Promise<void> {
  const args = parseExportArgs(argv);
  if (args.help) help();

  const bundle = toPortable(listShards({ state: 'approved' }), todayIso());
  const json = JSON.stringify(bundle, null, 2) + '\n';

  if (args.out) {
    try {
      await writeFile(args.out, json, 'utf-8');
    } catch (error) {
      throw new UsageError(`could not write ${args.out}: ${errorMessage(error)}`);
    }
    process.stderr.write(`wrote ${args.out}\n`);
  } else {
    await writeStdoutFully(json);
  }

  const n = bundle.shards.length;
  process.stderr.write(`  ${n} approved shard${n === 1 ? '' : 's'} exported\n`);
}

/**
 * Merge another author's bundle in as candidates.
 *
 * Every failure on the way in is converted to a `UsageError`. `readFileSync` throws
 * ENOENT, `JSON.parse` throws a SyntaxError, and `fromPortable` throws a
 * `PortableFormatError` — none of them are programmer errors, and `runShards` rethrows
 * everything but `UsageError` into an index.ts that has no handler, so an unwrapped
 * throw reaches the user as a raw stack trace.
 *
 * The existing rows are read BEFORE the upsert and passed to `toRecord`, which is what
 * keeps `sessions shards export > b.json && sessions shards import b.json` a no-op
 * instead of a self-inflicted evidence wipe. See the comment on `toRecord`.
 */
function runImport(argv: string[]): void {
  const args = parseImportArgs(argv);
  if (args.help) help();
  const path = args.path;
  if (!path) throw new UsageError('import requires a path to a bundle written by `shards export`');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${errorMessage(error)}`);
  }

  let incoming: PortableShard[];
  try {
    incoming = fromPortable(JSON.parse(raw));
  } catch (error) {
    throw new UsageError(
      `${path} is not a valid shard bundle (expected v${SHARD_SCHEMA_VERSION}): ${errorMessage(error)}`,
    );
  }

  // merge() even for a single bundle: it collapses duplicate ids inside the file,
  // which the store's PRIMARY KEY would otherwise coalesce silently with the last
  // write winning — and it is the same call a multi-bundle transport would make.
  const merged = merge(incoming);
  const local = new Map(listShards().map((r) => [r.id, r]));
  upsertCandidates(merged.map((m) => toRecord(m, local.get(m.id))));

  // Nothing on stdout: this writes to the store, it does not emit a batch.
  const known = merged.filter((m) => local.has(m.id)).length;
  process.stderr.write(`  ${merged.length - known} imported, ${known} already known\n`);
}

export async function runShards(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') help();
  try {
    switch (sub) {
      case 'mine':
        await runMine(argv.slice(1));
        return;
      case 'approve':
      case 'reject':
      case 'snooze':
        runTriage(sub, argv.slice(1));
        return;
      case 'export':
        await runExport(argv.slice(1));
        return;
      case 'import':
        runImport(argv.slice(1));
        return;
      default:
        throw new UsageError(`unknown subcommand: ${sub}`);
    }
  } catch (error) {
    if (error instanceof UsageError) die(error.message);
    throw error;
  }
}
