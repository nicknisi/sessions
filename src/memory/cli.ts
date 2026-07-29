// Arg parsing and dispatch for the `memory` command group. Phase 1 shipped `mine`;
// Phase 2 adds approve/reject/snooze, Phase 4 adds export/import.
//
// The batch JSON goes to stdout and everything human-readable goes to stderr —
// that split is what makes `sessions memory mine | <agent>` a usable interface.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolveRepo } from '../repo';
import { writeStdoutFully } from '../stdout';
import { createContainerResolver, indexedSessions, mine } from './mine';
import { fromPortable, merge, toPortable, toRecord } from './portable';
import { getPersistedStates, listMemories, upsertCandidates, type PersistedState } from './store';
import { approve, dropSuppressed, isKnownMemory, reject, snooze, snoozeUntil, suppressedMemories } from './triage';
import { MEMORY_SCHEMA_VERSION, type PortableMemory, type MemoryRecord, type MemoryScope } from './types';
import { advanceWatermark, changedSessions, readWatermark, type WatermarkEntry } from './watermark';

/**
 * A bad invocation. Thrown rather than exiting inline so `parseMineArgs` stays a
 * pure function a test can drive; `runMemory` turns it into the stderr + exit 1
 * the CLI contract promises.
 */
export class UsageError extends Error {}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions memory — mine durable facts out of past sessions

Narrows past user turns to corrective-shaped candidates, collapses repeats, and
emits a candidate batch as JSON on stdout for an agent to triage. Candidates are
also written to a durable store (~/.local/share/sessions/memory.db) that survives
--clear-cache and cleanup.

Usage:
  sessions memory mine             Mine the current repo
  sessions memory mine --all       Mine every repo in the index
  sessions memory mine --since-last  Mine only what changed since the last mine
  sessions memory pending          Count and preview candidates awaiting triage
  sessions memory approve <id>     Keep a candidate as a durable memory
                                   (--always-on, --scope group:<name>)
  sessions memory reject <id>      Dismiss a candidate; it stops being emitted
  sessions memory snooze <id>      Hide a candidate without rejecting it
  sessions memory export           Write approved memories as a portable bundle
  sessions memory import <path>    Merge another author's bundle in as candidates

Options:
  --repo <path>         Scope to one repo container (default: the current repo)
  --all                 Mine every repo in the index
  --since-last          Mine only sessions changed since the last mine
  --json                Emit the candidate batch as JSON on stdout (the default)
  --out <path>          Write the export bundle to a file instead of stdout
  --always-on           (approve) Return this memory for every topic, and first
  --scope group:<name>  (approve) Assign a project group, not the derived scope
  -h, --help            Show this help

<id> is the \`id\` field of a record from the mine's JSON batch. A rejected
candidate never returns. A snoozed one is designed to return once its 30 days
are up AND new distinct phrasings have appeared — but every phrasing gets its
own record, so no re-mine can bump that count today and a snooze currently hides
a candidate indefinitely. Snooze still differs from reject: it records no
verdict, and the resurface it is waiting on is a missing feature, not a
cancelled one.

Retrieval is topic-conditional: the \`get_memory\` MCP tool takes a topic and
returns the memories relevant to it. --always-on exempts a memory from that filter,
for standing constraints a badly worded topic must never hide. It is set-only —
approving again without the flag does not clear it.

Project groups are the scope between repo and workflow: a fact true of several
related repos but not of everything. Membership comes from
~/.local/share/sessions/groups.json, e.g.
{"groups": {"authkit": ["~/Developer/authkit-*"]}}. A group memory whose group is
not configured there is simply never returned.

--since-last mines only transcripts whose mtime or size changed since the last
mine, so a repeat run over an unchanged corpus emits an empty batch instead of
the whole backfill. The first run records a watermark and therefore mines
everything. \`pending\` reports the untriaged backlog without mining at all.

Export carries approved memories only, and strips session paths and repo paths —
nothing about this machine's directory layout leaves it. There is no transport:
the bundle is a plain file, so whatever you already use (a git ref, a shared
drive, scp) carries it. Imported memory land as candidates for you to triage,
never as approved. Memory merge on a hash of their text, so two people who
phrase one fact differently produce two memory; clustering paraphrases is the
/memory skill's job, not a mechanical one.
`);
  process.exit(0);
}

/** Today in UTC as 'YYYY-MM-DD'. The only clock read in the memory pipeline — every
 *  function under src/memory/ takes the date as an argument so tests stay hermetic. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MineArgs {
  repo?: string;
  all: boolean;
  /**
   * `--since-last` was passed. Absent rather than false so an untouched parse stays
   * bare, matching `TriageArgs.alwaysOn` — the shape `parseMineArgs([])` returns is
   * asserted verbatim in cli.test.ts.
   */
  sinceLast?: boolean;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/** Parse `memory mine` flags. Throws `UsageError` on a bad invocation; never exits. */
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
      case '--since-last':
        // Composes with both --all and --repo on purpose: the watermark is per file,
        // and a scoped mine advances only the files it actually looked at.
        args.sinceLast = true;
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

/** A triage subcommand: one positional memory id, plus two approve-only flags. */
export type TriageAction = 'approve' | 'reject' | 'snooze';

export interface TriageArgs {
  id?: string;
  /** `--always-on` was passed. Absent rather than false so an untouched parse stays bare. */
  alwaysOn?: boolean;
  /** `--scope group:<name>` was passed. */
  scope?: MemoryScope;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `--scope group:<name>` into a scope.
 *
 * `group:` is the only accepted form on purpose. Repo and workflow scope are DERIVED
 * from how far a paraphrase cluster spread (src/memory/mine.ts:151-156), and that
 * derivation is evidence-backed — letting a flag overwrite it would let a typo silently
 * turn one repo's convention into a rule for every repo. A group is the one tier no
 * derivation can reach, so it is the one tier a human assigns.
 */
function parseScopeValue(value: string): MemoryScope {
  const name = value.startsWith('group:') ? value.slice('group:'.length) : '';
  if (!name) {
    throw new UsageError(`--scope only accepts group:<name>, got: ${value}`);
  }
  return { type: 'group', key: name };
}

/**
 * Parse `memory approve|reject|snooze <id> [--always-on] [--scope group:<name>]`.
 * Throws `UsageError`; never exits.
 *
 * A separate parser rather than a reuse: `parseMineArgs` treats every bare word as
 * an unknown option, because `mine` takes no positionals. These take exactly one.
 *
 * Both flags parse for all three subcommands and are rejected for two of them in
 * `runTriage`. That split is deliberate — the parser stays a pure function of argv with
 * no knowledge of which subcommand invoked it, and `sessions memory reject <id>
 * --always-on` gets "reject does not take --always-on" instead of the far more
 * confusing "unknown option: --always-on".
 */
export function parseTriageArgs(argv: string[]): TriageArgs {
  const args: TriageArgs = { help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    // Help wins over everything after it, matching parseMineArgs.
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--always-on') {
      args.alwaysOn = true;
    } else if (a === '--scope') {
      const value = argv[++i];
      if (!value) throw new UsageError('--scope requires a value (group:<name>)');
      args.scope = parseScopeValue(value);
    } else if (a.startsWith('-')) {
      throw new UsageError(`unknown option: ${a}`);
    } else if (args.id !== undefined) {
      throw new UsageError(`unexpected argument: ${a} (expected exactly one memory id)`);
    } else {
      args.id = a;
    }
    i++;
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
 * Parse `memory export [--out <path>]`. Throws `UsageError`; never exits.
 *
 * A third parser rather than a reuse: `parseTriageArgs` rejects anything starting
 * with `-`, so it cannot take `--out`, and its duplicate-positional message names a
 * "memory id" — misleading for a file path.
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
  /** Path to a bundle written by `memory export`. */
  path?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/** Parse `memory import <path>`. Throws `UsageError`; never exits. */
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

export interface PendingArgs {
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `memory pending [--json]`. Throws `UsageError`; never exits.
 *
 * A fourth parser rather than a reuse: every other one accepts a flag or a positional
 * this subcommand must reject, and `pending` deliberately takes nothing but `--json`.
 */
export function parsePendingArgs(argv: string[]): PendingArgs {
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { help: true };
    // Accepted and ignored, exactly as on `mine`: JSON on stdout is unconditional
    // because the batch is the interface. The flag exists so the documented
    // invocation works and stays explicit at call sites.
    if (a === '--json') continue;
    throw new UsageError(`unknown option: ${a}`);
  }
  return { help: false };
}

/** How many candidate texts the pending payload previews. The count is the true total. */
export const PENDING_PREVIEW = 5;

export interface PendingBatch {
  /** Every untriaged candidate in the store — NOT the preview length. */
  count: number;
  preview: { id: string; text: string }[];
}

/**
 * The untriaged backlog, as a count plus a short preview.
 *
 * Pure over `listMemories`'s output so the projection is testable without a CLI.
 * `listMemories` already returns `ORDER BY id`, which is arbitrary but stable — the
 * preview is "five of them", not "the five most recent", and nothing here should be
 * read as recency.
 *
 * KNOWN LIMIT: this is a RUNNING TOTAL of everything untriaged, not "new since last
 * week". Until the backlog is worked down, the weekly digest carries the same non-zero
 * block with the same texts every week — which is the skim-past failure the "silent
 * when empty" rule exists to prevent, arrived at from the other side. Reporting a delta
 * needs a per-row "first surfaced" timestamp the store does not keep; that is the
 * spec's open item, deliberately not resolved by guessing here.
 */
export function pendingBatch(candidates: MemoryRecord[]): PendingBatch {
  return {
    count: candidates.length,
    preview: candidates.slice(0, PENDING_PREVIEW).map((r) => ({ id: r.id, text: r.text })),
  };
}

/**
 * Report the untriaged backlog. Reads only; it never mines and never writes.
 *
 * That separation is the point: the weekly-summary skill calls `mine --since-last`
 * first and this second, so a digest that only wants a number does not pay for an
 * index refresh. There is no `getIndexDb()` call anywhere on this path.
 */
async function runPending(argv: string[]): Promise<void> {
  const args = parsePendingArgs(argv);
  if (args.help) help();

  const batch = pendingBatch(listMemories({ state: 'candidate' }));
  await writeStdoutFully(JSON.stringify(batch, null, 2) + '\n');
  process.stderr.write(`  ${batch.count} candidate${batch.count === 1 ? '' : 's'} awaiting triage\n`);
}

/**
 * Overlay the store's triage state onto a freshly mined batch.
 *
 * `mine()` reads transcripts, so every record it builds says `candidate`. The pipe
 * is the documented Phase 2 interface, so it has to carry the same truth the table
 * does — otherwise a memory the user rejected last week is re-presented as a fresh
 * candidate on every run. Spreading over the existing keys preserves field order,
 * which the determinism criterion compares byte for byte.
 */
export function applyPersistedStates(records: MemoryRecord[], persisted: Map<string, PersistedState>): MemoryRecord[] {
  return records.map((r) => {
    const stored = persisted.get(r.id);
    return stored ? { ...r, state: stored.state, snoozedUntil: stored.snoozedUntil } : r;
  });
}

/**
 * The changed-file restriction to hand `mine`, or `undefined` when restricting would
 * narrow nothing.
 *
 * A changed set that covers the WHOLE scoped inventory is the first `--since-last` run
 * (and any run after `DELETE FROM mine_watermark`): every session is new, so pass 1's
 * `m.file_path IN (...)` matches every row it could match and the restriction is pure
 * cost — `ceil(N/FILE_CHUNK)` extra `MATCH` scans on top of the full-corpus pass 2, or
 * ~13 of them at the author's 4,498-session inventory. Handing `mine` `undefined`
 * instead makes "the first run is equivalent to a full backfill" true of cost as well
 * as of output; the emitted records are identical either way, because a filter that
 * admits everything admits everything.
 *
 * `changed.length > 0` is load-bearing and not a paranoia guard: an EMPTY inventory
 * also produces an empty changed set, and `undefined` there would mean "mine the whole
 * corpus" rather than "nothing changed" — the one place the two spellings disagree.
 *
 * Exported as a pure function so the decision is asserted directly (stream.test.ts);
 * observing it through wall-clock time would be a flaky test of the same claim.
 */
export function mineRestriction(changed: string[], inventorySize: number): string[] | undefined {
  return changed.length > 0 && changed.length === inventorySize ? undefined : changed;
}

/**
 * Persist a mined batch and advance the watermark, in that order and never the other.
 *
 * The ordering is the whole failure mode: a watermark advanced before the upsert marks
 * material as mined that was never stored, and if the write then throws, those facts
 * are skipped by every future `--since-last` run — silently and unrecoverably. Because
 * `advanceWatermark` only runs after `upsert` returns, a throw leaves the watermark
 * exactly where it was and the next run re-mines the same window.
 *
 * Extracted and injectable so that ordering is asserted by a test that makes the write
 * fail, rather than by reading this file.
 */
export function persistMine(
  mined: MemoryRecord[],
  watermark: WatermarkEntry[] | undefined,
  upsert: (records: MemoryRecord[]) => void = upsertCandidates,
): void {
  upsert(mined);
  if (watermark) advanceWatermark(watermark);
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

  // The changed set and the entries to advance come from the SAME scoped inventory, so
  // `--repo X --since-last` can never mark another repo's sessions as mined.
  let files: string[] | undefined;
  let advance: WatermarkEntry[] | undefined;
  if (args.sinceLast) {
    const inventory = await indexedSessions({ repo });
    const watermark = readWatermark();
    if (watermark.size === 0) {
      process.stderr.write('  no watermark yet — this run mines everything and records one\n');
    }
    const changed = changedSessions(inventory, watermark);
    const byPath = new Map(inventory.map((entry) => [entry.filePath, entry]));
    // `undefined` when everything changed: same batch, one scan instead of thirteen.
    // See mineRestriction. The watermark still advances over the full changed set —
    // the short-circuit is about how the mine is asked, not about what it saw.
    files = mineRestriction(changed, inventory.length);
    advance = changed.map((path) => byPath.get(path)!);
    process.stderr.write(`  ${changed.length} session${changed.length === 1 ? '' : 's'} changed since the last mine\n`);
  }

  process.stderr.write(`  mining ${repo ?? 'all repos'}...\n`);
  const mined = await mine({ repo, files });
  // Snapshot the suppression set BEFORE upsertCandidates: its ON CONFLICT refreshes
  // `evidence` (store.ts ON CONFLICT), which would overwrite the distinctPhrasings
  // baseline shouldResurface compares the fresh count against.
  const suppressed = suppressedMemories();
  persistMine(mined, advance);
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
 * Reject the approve-only flags on `reject` and `snooze`. Throws `UsageError`; never exits.
 *
 * Separate from `parseTriageArgs` and exported on its own so both stay pure functions a
 * test can drive: the parser has no business knowing which subcommand invoked it, and
 * the alternative — teaching it the action — would make `--always-on` come back as
 * "unknown option" on a reject, which is true of neither the flag nor the mistake.
 *
 * Both flags attach a standing property to a memory the user is KEEPING. On a rejection
 * or a snooze they can only be a mistake, and quietly ignoring one would record a
 * decision the user did not make.
 */
export function assertActionAcceptsFlags(action: TriageAction, args: TriageArgs): void {
  if (action === 'approve') return;
  if (args.alwaysOn) throw new UsageError(`${action} does not take --always-on (it applies to approve only)`);
  if (args.scope) throw new UsageError(`${action} does not take --scope (it applies to approve only)`);
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
  if (!id) throw new UsageError(`${action} requires a memory id (the \`id\` field from \`memory mine\`)`);
  // Before the existence check, so a wrong flag is reported as a wrong flag whatever
  // the id turns out to be.
  assertActionAcceptsFlags(action, args);
  if (!isKnownMemory(id)) throw new UsageError(`unknown memory id: ${id}`);

  const today = todayIso();
  switch (action) {
    case 'approve': {
      approve(id, { alwaysOn: args.alwaysOn, scope: args.scope });
      const notes = [args.alwaysOn ? 'always-on' : '', args.scope ? `scope group:${args.scope.key}` : ''].filter(
        Boolean,
      );
      process.stderr.write(`  approved ${id}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}\n`);
      return;
    }
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
 * Write approved memories as a portable bundle.
 *
 * stdout by default so it pipes straight into whatever transport the team already
 * has; `--out` mirrors the convention in src/context.ts:100-103,183-188, down to the
 * `wrote <path>` line on stderr. The payload goes through `writeStdoutFully`
 * (src/stdout.ts:14-18) for the same reason the mine batch does — a bare write plus
 * the CLI's process.exit truncates a piped bundle at 64KB.
 *
 * The approved-only filter is a `listMemories` WHERE rather than a post-filter, so an
 * unreviewed candidate has no path into the file at all.
 */
async function runExport(argv: string[]): Promise<void> {
  const args = parseExportArgs(argv);
  if (args.help) help();

  const bundle = toPortable(listMemories({ state: 'approved' }), todayIso());
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

  const n = bundle.memories.length;
  process.stderr.write(`  ${n} approved ${n === 1 ? 'memory' : 'memories'} exported\n`);
}

/**
 * Merge another author's bundle in as candidates.
 *
 * Every failure on the way in is converted to a `UsageError`. `readFileSync` throws
 * ENOENT, `JSON.parse` throws a SyntaxError, and `fromPortable` throws a
 * `PortableFormatError` — none of them are programmer errors, and `runMemory` rethrows
 * everything but `UsageError` into an index.ts that has no handler, so an unwrapped
 * throw reaches the user as a raw stack trace.
 *
 * The existing rows are read BEFORE the upsert and passed to `toRecord`, which is what
 * keeps `sessions memory export > b.json && sessions memory import b.json` a no-op
 * instead of a self-inflicted evidence wipe. See the comment on `toRecord`.
 */
function runImport(argv: string[]): void {
  const args = parseImportArgs(argv);
  if (args.help) help();
  const path = args.path;
  if (!path) throw new UsageError('import requires a path to a bundle written by `memory export`');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${errorMessage(error)}`);
  }

  let incoming: PortableMemory[];
  try {
    incoming = fromPortable(JSON.parse(raw));
  } catch (error) {
    throw new UsageError(
      `${path} is not a valid memory bundle (expected v${MEMORY_SCHEMA_VERSION}): ${errorMessage(error)}`,
    );
  }

  // merge() even for a single bundle: it collapses duplicate ids inside the file,
  // which the store's PRIMARY KEY would otherwise coalesce silently with the last
  // write winning — and it is the same call a multi-bundle transport would make.
  const merged = merge(incoming);
  const local = new Map(listMemories().map((r) => [r.id, r]));
  upsertCandidates(merged.map((m) => toRecord(m, local.get(m.id))));

  // Nothing on stdout: this writes to the store, it does not emit a batch.
  const known = merged.filter((m) => local.has(m.id)).length;
  process.stderr.write(`  ${merged.length - known} imported, ${known} already known\n`);
}

export async function runMemory(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') help();
  try {
    switch (sub) {
      case 'mine':
        await runMine(argv.slice(1));
        return;
      case 'pending':
        await runPending(argv.slice(1));
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
