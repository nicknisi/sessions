// Arg parsing and dispatch for the `memory` command group. Phase 1 shipped `mine`;
// Phase 2 adds approve/reject/snooze, Phase 4 adds export/import.
//
// Prose on stdout by default, the JSON batch on stdout under `--json`, and progress
// on stderr either way. The default flipped once a human ran `memory mine` at a
// terminal and got several hundred lines of records: the batch is the /memory skill's
// interface, and `sessions memory mine --json | <agent>` still pipes exactly as before.

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getDataDir } from '../paths';
import { resolveRepo } from '../repo';
import { writeStdoutFully } from '../stdout';
import { containerFor, createContainerResolver, indexedSessions, MAX_TEXT_LENGTH, mine, MIN_TEXT_LENGTH } from './mine';
import { documentedFacts, documentedSources } from './documented';
import { fromPortable, merge, toPortable, toRecord, type MergedMemory } from './portable';
import { buildRecord, gitAuthorEmail } from './record';
import { runRecurrence, type RecurrenceEnvelope } from './report';
import { appendSnapshot, scopeLabel, snapshotCounts } from './snapshots';
import { ContentScanError, describeFindings, scanMemoryText, type ScanFinding } from './scan';
import { collectAgentMemory, splitEntryToBand, type SourceAgent } from './sources';
import { getPersistedStates, listMemories, upsertCandidates, type PersistedState } from './store';
import {
  ALWAYS_ON_MAX_ENTRIES,
  AlwaysOnBudgetError,
  approve,
  dropSuppressed,
  isKnownMemory,
  mergeInto,
  reject,
  snooze,
  snoozeUntil,
  suppressedMemories,
} from './triage';
import {
  MEMORY_SCHEMA_VERSION,
  type PortableMemory,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from './types';
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
lists them. Candidates are also written to a durable store
(~/.local/share/sessions/memory.db) that survives --clear-cache and cleanup.

Deciding on them is \`/memory\`'s job, not yours: it clusters paraphrases, drops
what CLAUDE.md already says, writes the fact rather than the utterance, and runs
the commands below for you. \`--json\` is the seam it reads.

Usage:
  sessions memory mine             Mine the current repo
  sessions memory mine --all       Mine every repo in the index
  sessions memory mine --since-last  Mine only what changed since the last mine
  sessions memory pending          Count and preview candidates awaiting triage
  sessions memory report           What recurs: violations, untriaged repeats,
                                   fuzzy paraphrase candidates (--since YYYY-MM-DD)
  sessions memory documented       What is already binding here (CLAUDE.md,
                                   AGENTS.md, Claude Code's own memory store)
  sessions memory approve <id>     Keep a candidate as a durable memory
                                   (--as "<text>", --always-on,
                                    --scope group:<name>|repo:<path>)
  sessions memory reject <id>      Dismiss a candidate; it stops being emitted
  sessions memory snooze <id>      Hide a candidate without rejecting it
  sessions memory merge <id> <id>...  Fold paraphrases into the first id
  sessions memory export           Write approved memories as a portable bundle
  sessions memory import <path>    Merge another author's bundle in as candidates

Options:
  --repo <path>         Scope to one repo container (default: the current repo)
  --all                 Mine every repo in the index
  --since-last          Mine only sessions changed since the last mine
  --json                Emit the machine-readable batch on stdout. The default is
                        a prose listing — the JSON is the seam the /memory skill
                        parses, not something to read at a terminal
  --out <path>          Write the export bundle to a file instead of stdout
  --as "<text>"         (approve) Store this phrasing instead of the mined
                        utterance. A mined candidate is a verbatim user turn and
                        is often a question rather than the fact it implies; this
                        is where the triage skill writes the fact itself. The
                        original is kept as evidence, not discarded
  --always-on           (approve) Return this memory for every topic, and first.
                        Budgeted: at most ${ALWAYS_ON_MAX_ENTRIES} entries, so each one stays read
  --no-always-on        (approve) Explicitly revoke --always-on — the release valve
                        when the budget refuses a new grant
  --no-snapshot         (report) Render the TREND section without appending a
                        snapshot — for dry inspection of a per-run audit trail
  --scope group:<name>  (approve) Assign a project group, not the derived scope
  --scope repo:<path>   (approve) Bind to one repo — the path is resolved to its
                        repo container. Needed for an imported memory, whose
                        repo key is stripped on export (\`repo:.\` for this repo)
  -h, --help            Show this help

<id> is the \`id\` field of a record from the mine's JSON batch. A rejected
candidate never returns. A snoozed one returns once its 30 days are up AND you
have said the same thing in a new way since — snooze records no verdict, so
continued repetition is treated as evidence the dismissal was wrong.

That count only moves through \`merge\`. Every phrasing is its own record (an id
is a hash of that record's text), so recognizing two wordings as one fact is a
judgment the /memory skill makes and then writes back:

  sessions memory merge <canonical-id> <member-id> [<member-id>...]

The canonical row absorbs the members' evidence — distinct phrasings counted,
sessions unioned, date range widened — and the members stop being offered
separately. Merging into a snoozed row whose date has passed resurfaces it.

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
drive, scp) carries it. Imported memories land as candidates for you to triage,
never as approved. Records merge on a hash of their text, so two people who
phrase one fact differently produce two records; clustering those is the /memory
skill's job, and \`merge\` is how it records the result.

\`import --from\` reads the memory stores of the OTHER agents on this machine —
pi-hermes-memory's structured store (or its MEMORY.md/USER.md/failures.md files),
and Claude Code's global CLAUDE.md, repo CLAUDE.md/AGENTS.md, and per-project
memory — and lands their durable facts as candidates with the same gates as a
bundle import. Codex has no fact store (its rules are command permissions), so
--from codex reports that and imports nothing. Entries already in the store are
counted as known, not duplicated. A pi-hermes fact recorded against a bare
project name arrives unbound — bind it at approve time with --scope repo:.
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
  /** `--json` was passed: emit the machine-readable batch instead of the prose listing. */
  json?: boolean;
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
        // The AGENT seam, now explicit. Prose is the default because a human at a
        // terminal was the one getting several hundred lines of records.
        args.json = true;
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
  /** `--scope group:<name>` or `--scope repo:<path>` was passed. A repo key is still the
   *  RAW path here — `canonicalizeScope` resolves it, because this parser does no I/O. */
  scope?: MemoryScope;
  /** `--as "<text>"`: store this phrasing instead of the mined utterance. */
  as?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `--scope group:<name>` or `--scope repo:<path>` into a scope.
 *
 * `group:` is the tier no derivation can reach: the spread heuristic
 * (src/memory/mine.ts:151-156) can tell one container from several but not "these four
 * repos share a convention", so a human assigns it.
 *
 * `repo:` exists for the one case where the derivation is not merely overridable but
 * ABSENT. Export blanks a repo key on purpose — it is an absolute path on someone else's
 * machine (src/memory/portable.ts) — so an imported repo memory arrives with `key: ''`,
 * retrieval skips a keyless repo memory rather than matching every cwd
 * (src/memory/retrieve.ts), and nothing re-derives it: a mine builds records from
 * transcripts, and no transcript on THIS machine ever said the imported sentence. Without
 * this form such a memory can be approved and can never be returned, which is worse than
 * rejecting it — the user believes it is active.
 *
 * `workflow:` is still not assignable. It is the only direction that WIDENS, and a typo
 * that turns one repo's convention into a rule for every repo is silent by construction.
 * Narrowing to a repo, by contrast, is checked: `canonicalizeScope` resolves the path
 * through git and fails loudly when it is not a repo.
 */
function parseScopeValue(value: string): MemoryScope {
  const forms = 'group:<name> or repo:<path>';
  if (value.startsWith('group:')) {
    const name = value.slice('group:'.length);
    if (!name) throw new UsageError(`--scope group: requires a group name (accepts ${forms})`);
    return { type: 'group', key: name };
  }
  if (value.startsWith('repo:')) {
    const path = value.slice('repo:'.length);
    if (!path) throw new UsageError(`--scope repo: requires a path — use \`repo:.\` for the current repo`);
    return { type: 'repo', key: path };
  }
  throw new UsageError(`--scope only accepts ${forms}, got: ${value}`);
}

/**
 * Resolve a parsed scope's key into the form the store must hold. A no-op for `group`.
 *
 * A repo key is only useful if it is byte-identical to what retrieval derives for a cwd
 * inside that repo, so it goes through the SAME `containerFor` the mine and
 * `activeMemoryFor` use rather than through `resolve()` alone. `~/dev/app/src` and a linked
 * worktree of the same repo both canonicalize to the one container; an unresolved relative
 * path or a worktree path would not match and the memory would be silently inert.
 *
 * Both failures throw instead of falling back to the raw path — which is what
 * `createContainerResolver` does, correctly, for a mine that must not die on one bad cwd.
 * Here a fallback would store a key that can never match and report success, recreating
 * the exact dead end this form exists to remove.
 *
 * `resolveRepoInfo` is injected for the same reason `todayIso` is: so a test can assert
 * both branches without a real repo on disk.
 */
export function canonicalizeScope(scope: MemoryScope, resolveRepoInfo: typeof resolveRepo = resolveRepo): MemoryScope {
  if (scope.type !== 'repo') return scope;
  const abs = resolvePath(scope.key);
  if (!existsSync(abs)) throw new UsageError(`--scope repo:${scope.key} — no such directory: ${abs}`);
  const info = resolveRepoInfo(abs);
  if (!info) throw new UsageError(`--scope repo:${scope.key} is not inside a git repository: ${abs}`);
  return { type: 'repo', key: containerFor(info) };
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
    if (a === '--always-on' || a === '--no-always-on') {
      const value = a === '--always-on';
      // Contradiction is an error, not last-one-wins: both flags on one invocation
      // means the user's intent is unknown, and recording a guess would be worse
      // than asking.
      if (args.alwaysOn !== undefined && args.alwaysOn !== value) {
        throw new UsageError('--always-on and --no-always-on are contradictory — pass one');
      }
      args.alwaysOn = value;
    } else if (a === '--scope') {
      const value = argv[++i];
      if (!value) throw new UsageError('--scope requires a value (group:<name>)');
      args.scope = parseScopeValue(value);
    } else if (a === '--as') {
      // Consumed positionally rather than checked for a leading dash: a canonical
      // phrasing legitimately starts with one ("--json is the agent seam"), and rejecting
      // that would make the flag unusable for exactly the sentences worth storing.
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--as requires the phrasing to store, in quotes');
      if (!value.trim()) throw new UsageError('--as needs a non-empty phrasing');
      args.as = value;
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

/** The agent stores `memory import --from` can read. 'all' composes the fact-bearing ones. */
export const IMPORT_SOURCES = ['pi-hermes', 'claude', 'codex', 'all'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** ImportSource -> the agent family its entries carry. 'all' never reaches this map. */
const SOURCE_AGENT = {
  'pi-hermes': 'pi',
  claude: 'claude',
  codex: 'codex',
} satisfies Record<Exclude<ImportSource, 'all'>, SourceAgent>;

export interface ImportArgs {
  /** Path to a bundle written by `memory export`. */
  path?: string;
  /** Read another agent's memory stores instead of a bundle. */
  from?: ImportSource;
  /** Repo context for `--from` (repo-scoped stores resolve against it). */
  repo?: string;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

/**
 * Parse `memory import <path>` or `memory import --from <source> [--repo <path>]`.
 * Throws `UsageError`; never exits.
 *
 * The two forms are mutually exclusive: a bundle path and `--from` name two different
 * origins, and accepting both would silently import one while the user reads the
 * other. `--repo` only makes sense with `--from` (a bundle carries its own scoping),
 * so it is rejected on the path form rather than ignored.
 */
export function parseImportArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = { help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--from') {
      const value = argv[++i];
      if (!value) throw new UsageError(`--from requires a source (${IMPORT_SOURCES.join(', ')})`);
      const sources: readonly string[] = IMPORT_SOURCES;
      if (!sources.includes(value)) {
        throw new UsageError(`--from only accepts ${IMPORT_SOURCES.join(', ')}, got: ${value}`);
      }
      if (args.from !== undefined) throw new UsageError('--from was given twice');
      // SAFETY: the includes() membership test above proves value is one of IMPORT_SOURCES.
      args.from = value as ImportSource;
    } else if (a === '--repo') {
      const value = argv[++i];
      if (!value) throw new UsageError('--repo requires a path');
      args.repo = value;
    } else if (a.startsWith('-')) {
      throw new UsageError(`unknown option: ${a}`);
    } else if (args.path !== undefined) {
      throw new UsageError(`unexpected argument: ${a} (expected exactly one bundle path)`);
    } else {
      args.path = a;
    }
    i++;
  }
  if (args.path !== undefined && args.from !== undefined) {
    throw new UsageError('import takes a bundle path OR --from <source>, not both');
  }
  if (args.repo !== undefined && args.from === undefined) {
    throw new UsageError('--repo only applies to --from (a bundle carries its own scoping)');
  }
  return args;
}

export interface PendingArgs {
  /** `--json` was passed: emit the machine-readable batch instead of the prose listing. */
  json?: boolean;
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
  const args: PendingArgs = { help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--json') args.json = true;
    else throw new UsageError(`unknown option: ${a}`);
  }
  return args;
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

  const candidates = listMemories({ state: 'candidate' });
  if (args.json) {
    const batch = pendingBatch(candidates);
    await writeStdoutFully(JSON.stringify(batch, null, 2) + '\n');
    process.stderr.write(`  ${batch.count} candidate${batch.count === 1 ? '' : 's'} awaiting triage\n`);
    return;
  }
  await writeStdoutFully(renderBatch(candidates) + '\n');
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

  const hidden = records.length - batch.length;
  if (args.json) {
    await writeStdoutFully(JSON.stringify(batch, null, 2) + '\n');
    const fresh = batch.filter((r) => r.state === 'candidate').length;
    process.stderr.write(
      `  ${batch.length} candidate${batch.length === 1 ? '' : 's'}` +
        (fresh === batch.length ? '' : ` (${fresh} untriaged)`) +
        (hidden > 0 ? `, ${hidden} suppressed` : '') +
        '\n',
    );
    return;
  }
  await writeStdoutFully(renderBatch(batch, { suppressed: hidden }) + '\n');
}

export interface ReportArgs {
  repo?: string;
  all: boolean;
  /**
   * `--since YYYY-MM-DD` was passed: drop cluster evidence that ends before the
   * date. Absent rather than false so an untouched parse stays bare, matching
   * `MineArgs.sinceLast` — the shape `parseReportArgs([])` returns is asserted
   * verbatim in cli.test.ts.
   */
  since?: string;
  /** `--json` was passed: emit the machine-readable report instead of the prose. */
  json?: boolean;
  /** `--no-snapshot` was passed: render without appending to the trend snapshot
   *  file. Absent-not-false, same convention as `since` above. */
  noSnapshot?: boolean;
  /** `-h`/`--help` was passed; the caller prints help and exits 0. */
  help: boolean;
}

const SINCE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse `memory report` flags. Throws `UsageError` on a bad invocation; never exits.
 *
 * Mirrors `parseMineArgs` flag-for-flag except `--since-last`, which report replaces
 * with `--since <date>`: report is read-only, so a watermark-advancing flag would be
 * a lie, and the recurrence module documents why the date filters cluster evidence
 * rather than memories (src/memory/recurrence.ts, RecurrenceOptions.since).
 */
export function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { all: false, help: false };
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
      case '--since': {
        const value = argv[++i];
        if (!value) throw new UsageError('--since requires a date');
        if (!SINCE_DATE.test(value)) throw new UsageError(`--since takes YYYY-MM-DD, got: ${value}`);
        args.since = value;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--no-snapshot':
        args.noSnapshot = true;
        break;
      default:
        throw new UsageError(`unknown option: ${a}`);
    }
    i++;
  }
  if (args.all && args.repo) throw new UsageError('--all and --repo are mutually exclusive');
  return args;
}

/** '2026-08-18' -> '08-18' for the prose columns; an empty date stays empty. */
function shortDate(iso: string): string {
  return iso ? iso.slice(5) : '';
}

/**
 * The recurrence classification as prose. Three sections, never three flags — the
 * comparison between "working" and "failing" memories is the point of the report.
 *
 * Counts are session counts, not phrasing counts: `evidence.sessions` is the only
 * per-occurrence evidence a cluster carries (mine emits no per-session date map),
 * so "matched in 2 sessions, latest 06-02" reads `lastSeen` as the latest date.
 */
export function renderReport(report: RecurrenceEnvelope, opts: { today: string; lastMined: string | null }): string {
  const stale = opts.lastMined ? `last mine ${opts.lastMined.slice(0, 10)}` : 'never mined';
  const lines: string[] = [`memory report — ${opts.today} (${stale})`, ''];

  lines.push('VIOLATIONS (approved memories still being re-corrected)');
  if (report.violations.length === 0) {
    lines.push('  none');
  }
  for (const v of report.violations) {
    lines.push(
      `  ${v.sessions.length}x  "${v.memory.text}"        approved, last seen ${shortDate(v.memory.evidence.lastSeen)}`,
      `      → matched "${v.cluster.text}" in ${v.sessions.length} session${v.sessions.length === 1 ? '' : 's'}, latest ${shortDate(v.latestDate)}`,
      `      sessions: ${v.sessions.join(', ')}`,
    );
  }

  lines.push('', 'REPEATS (corrections never triaged)');
  if (report.repeats.length === 0) {
    lines.push('  none');
  }
  for (const r of report.repeats) {
    const known = r.candidateId ? ' (already a candidate)' : '';
    lines.push(
      `  ${r.sessions.length}x  "${r.cluster.text}"        ${r.sessions.length} sessions, ${shortDate(r.firstDate)} → ${shortDate(r.latestDate)}${known}`,
      `      sessions: ${r.sessions.join(', ')}`,
    );
  }

  lines.push('', 'FUZZY (possible paraphrases — confirm in /memory triage)');
  if (report.fuzzy.length === 0) {
    lines.push('  none');
  }
  for (const f of report.fuzzy) {
    lines.push(`  ?   "${f.memory.text}" ~ "${f.cluster.text}"`);
  }

  // TREND reads the deltas report.ts computed against the previous snapshot. The
  // header line stays first — cli.test.ts's locked regex anchors it — and the
  // scope/first-run note (trendNote) leads the section rather than a per-row
  // caveat that would repeat on every violation.
  lines.push('', 'TREND (violation counts vs the previous snapshot)');
  if (report.trendNote) lines.push(`  note: ${report.trendNote}`);
  if (report.trend.length === 0) {
    lines.push('  none');
  } else {
    const textById = new Map(report.violations.map((v) => [v.memory.id, v.memory.text]));
    for (const t of report.trend) {
      const delta =
        t.delta === null
          ? '(new)'
          : `(${t.delta >= 0 ? '+' : ''}${t.delta}${report.trendSince ? ` since ${shortDate(report.trendSince)}` : ''})`;
      lines.push(`  ${t.violations} ${delta}  "${textById.get(t.id) ?? t.id}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Report what recurs: freshly mined clusters classified against the store.
 *
 * Read-only like `pending`, but unlike `pending` it DOES mine — recurrence is
 * defined against fresh evidence, so the run pays for an index read. The one
 * write it performs is the trend-snapshot append, skipped under `--no-snapshot`;
 * no upsert, no watermark advance.
 */
async function runReport(argv: string[]): Promise<void> {
  const args = parseReportArgs(argv);
  if (args.help) help();

  // The pipeline is shared with the get_memory_recurrence MCP tool
  // (src/memory/report.ts) — including the absent-store guard, which is checked by
  // path because getMemoryDb() would CREATE the file as a side effect of asking.
  const run = await runRecurrence({
    repo: args.repo,
    all: args.all,
    since: args.since,
    today: todayIso(),
    onScope: (scope) => {
      if (scope.outsideRepo) {
        process.stderr.write('  not inside a git repository — reporting across every repo in the index\n');
      }
      process.stderr.write(`  mining ${scope.repo ?? 'all repos'}...\n`);
    },
  });
  // An absent store is an empty report, not an error (spec error table).
  if (!run) {
    process.stderr.write('  no memory store — run sessions memory mine first\n');
    return;
  }

  const { report } = run;
  const counts = `${report.violations.length} violations, ${report.repeats.length} repeats, ${report.fuzzy.length} fuzzy`;

  // The envelope is already the byte-compatible shape — report.ts owns it so the
  // MCP tool emits the identical JSON, trend fields included.
  if (args.json) {
    await writeStdoutFully(JSON.stringify(report, null, 2) + '\n');
  } else {
    await writeStdoutFully(renderReport(report, { today: report.generatedAt, lastMined: report.lastMinedAt }) + '\n');
  }
  process.stderr.write(`  ${counts}\n`);

  // Append AFTER the render, in both branches: the previous-snapshot read inside
  // runRecurrence must see the file BEFORE this run's line, or the deltas would
  // diff the report against itself. `--no-snapshot` skips the write entirely —
  // including creating the file on a first run.
  if (!args.noSnapshot) {
    appendSnapshot(
      { v: 1, date: report.generatedAt, scope: scopeLabel(run.scope), counts: snapshotCounts(report.violations) },
      getDataDir(),
    );
  }
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
  // `!== undefined`, not truthy: `--no-always-on` parses to false and is exactly as
  // wrong on a reject as `--always-on` is.
  if (args.alwaysOn !== undefined) {
    throw new UsageError(`${action} does not take --always-on/--no-always-on (they apply to approve only)`);
  }
  if (args.scope) throw new UsageError(`${action} does not take --scope (it applies to approve only)`);
  if (args.as) throw new UsageError(`${action} does not take --as (it applies to approve only)`);
}

/**
 * Persist one triage decision.
 *
 * The existence check is not defensive padding: `setState` is a bare
 * `UPDATE ... WHERE id = ?` (store.ts), so a mistyped id would exit 0 having
 * changed nothing and the agent driving the skill would report a decision that was
 * never recorded.
 */
/**
 * `memory merge <canonical-id> <member-id>...`
 *
 * The write-back path for the triage skill's paraphrase clustering. Without it the
 * skill's judgment stays in its context and `distinctPhrasings` can never exceed 1,
 * which is what kept snooze-resurface unreachable (see `mergeInto`).
 */
function runMerge(argv: string[]): void {
  if (argv.includes('-h') || argv.includes('--help')) help();
  const flag = argv.find((a) => a.startsWith('-'));
  if (flag) throw new UsageError(`unknown option: ${flag}`);
  const [canonical, ...members] = argv;
  if (!canonical) throw new UsageError('merge requires a canonical memory id, then one or more member ids');
  if (members.length === 0) throw new UsageError(`merge requires at least one member id to fold into ${canonical}`);
  for (const id of [canonical, ...members]) {
    if (!isKnownMemory(id)) throw new UsageError(`unknown memory id: ${id}`);
  }

  const result = mergeInto(canonical, members, todayIso());
  process.stderr.write(
    `  merged ${result.absorbed.length} into ${result.canonicalId} (${result.distinctPhrasings} distinct phrasings)\n`,
  );
  if (result.resurfaced) {
    process.stderr.write(`  ${result.canonicalId} resurfaced — snoozed, but you kept saying it in new words\n`);
  }
}

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
      // Resolved here rather than in the parser: this is the I/O layer, and the failure it
      // can raise (a path that is not a repo) must reach the user before anything is written.
      const scope = args.scope ? canonicalizeScope(args.scope) : undefined;
      // `approve` returns the id that now carries the fact, which differs from the one
      // passed in whenever --as rewrote the text. Reporting the argument instead would
      // print an id that is no longer the canonical row.
      const kept = approve(id, { alwaysOn: args.alwaysOn, scope, as: args.as });
      const notes = [
        args.alwaysOn ? 'always-on' : args.alwaysOn === false ? 'always-on cleared' : '',
        scope ? `scope ${scope.type}:${scope.key}` : '',
      ].filter(Boolean);
      process.stderr.write(`  approved ${kept}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}\n`);
      if (kept !== id) process.stderr.write(`  rephrased — ${id} folded in as evidence\n`);
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
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
/**
 * Import another agent's memory store as triage candidates.
 *
 * The same gates as a bundle import, in the same order, for the same reasons: the
 * text band the mine enforces (an oversized entry is a context tax on every future
 * task), the content scan (a store written by another tool is exactly the injection
 * vector the gate exists for), and candidate state on arrival — importing is not
 * consent, and nothing here can reach an agent until the user approves it.
 *
 * Dedupe falls out of the content-addressed id: an entry whose text already lives in
 * the store upserts to the same id, `upsertCandidates` unions evidence, and the count
 * is reported as "already known" rather than double-imported.
 *
 * Provenance is deliberately NOT recorded on the record: MemoryRecord has no field
 * for it (bundle imports lose their transport the same way), and a mine re-deriving
 * the fact later must not find a second copy. The source is reported on stderr at
 * import time; after that the fact stands on its own, to be triaged like any other.
 */
function runImportFrom(source: ImportSource, repo: string | undefined): void {
  if (source === 'codex') {
    // By construction: codex entries are permission rules and thread goals, both
    // durable: false (src/memory/sources.ts). Saying so beats importing zero rows
    // with no explanation.
    process.stderr.write(
      '  codex stores hold command permissions and thread goals, not durable facts — nothing to import\n' +
        '  (review them with the review_agent_memories MCP tool)\n',
    );
    return;
  }

  const cwd = repo ? resolvePath(repo) : process.cwd();
  const { entries } = collectAgentMemory(cwd);
  const agent = source === 'all' ? null : SOURCE_AGENT[source];
  const selected = entries.filter((e) => e.durable && (agent === null || e.agent === agent));

  // Reshape to the band the mine enforces (src/memory/mine.ts): entries within it
  // import whole; longer ones split at their own enumeration and sentence
  // boundaries. Splitting rather than skipping because pi-hermes consolidates many
  // facts into one ~1,100-char row — a hard skip would import nothing from the
  // store this flag exists for. See splitEntryToBand (src/memory/sources.ts).
  interface BandedEntry {
    kind: MemoryKind;
    scope: MemoryScope;
    text: string;
    created?: string;
    lastUpdated?: string;
  }
  const banded: BandedEntry[] = [];
  let skippedLong = 0;
  let skippedShort = 0;
  for (const e of selected) {
    if (e.text.length >= MIN_TEXT_LENGTH && e.text.length <= MAX_TEXT_LENGTH) {
      banded.push(e);
      continue;
    }
    const split = splitEntryToBand(e.text);
    skippedLong += split.skippedLong;
    skippedShort += split.skippedShort;
    for (const text of split.pieces) banded.push({ ...e, text });
  }

  // The scan gate, same shape as the bundle path above: another tool's text is the
  // injection vector src/memory/scan.ts exists for, and a flagged piece is refused
  // LOUDLY rather than dropped, because a silent drop reads as a successful import.
  const admitted: BandedEntry[] = [];
  const flagged: { text: string; findings: ScanFinding[] }[] = [];
  for (const s of banded) {
    const findings = scanMemoryText(s.text);
    if (findings.length > 0) flagged.push({ text: s.text, findings });
    else admitted.push(s);
  }

  const local = new Map(listMemories().map((r) => [r.id, r]));
  const author = gitAuthorEmail();
  const records = admitted.map((e) =>
    buildRecord({
      text: e.text,
      kind: e.kind,
      scope: e.scope,
      author,
      sessions: [],
      dates: [e.created ?? '', e.lastUpdated ?? ''],
      distinctPhrasings: 1,
    }),
  );
  upsertCandidates(records);

  const known = records.filter((r) => local.has(r.id)).length;
  process.stderr.write(
    `  ${records.length - known} imported from ${source}${known > 0 ? `, ${known} already known` : ''}\n`,
  );
  if (flagged.length > 0) {
    const plural = flagged.length === 1 ? 'entry' : 'entries';
    process.stderr.write(
      `  ⚠ ${flagged.length} ${plural} withheld — text matches secret or prompt-injection patterns, not stored:\n`,
    );
    for (const w of flagged) process.stderr.write(`    ${w.text.slice(0, 60)}… (${describeFindings(w.findings)})\n`);
  }
  if (skippedLong + skippedShort > 0) {
    process.stderr.write(
      `  ${skippedLong + skippedShort} fragments skipped while splitting to the ${MIN_TEXT_LENGTH}–${MAX_TEXT_LENGTH}-char band ` +
        `(${skippedLong} over, ${skippedShort} under); review the source store directly\n`,
    );
  }

  // A pi-hermes row names its project as a bare repo NAME, which no path resolution
  // can bind honestly (src/memory/sources.ts hermesScope). The record is inert until
  // the user binds it — same shape and same fix as an imported bundle's repo memory.
  const unbound = records.filter((r) => r.scope.type === 'repo' && !r.scope.key).length;
  if (unbound > 0) {
    const plural = unbound === 1 ? 'memory' : 'memories';
    process.stderr.write(
      `  ${unbound} repo-scoped ${plural} arrived unbound (the source named a project this machine cannot resolve to a path)\n` +
        `  bind ${unbound === 1 ? 'it' : 'each'} to a repo when you approve: ` +
        `sessions memory approve <id> --scope repo:.\n`,
    );
  }
}

function runImport(argv: string[]): void {
  const args = parseImportArgs(argv);
  if (args.help) help();
  if (args.from !== undefined) {
    runImportFrom(args.from, args.repo);
    return;
  }
  const path = args.path;
  if (!path) {
    throw new UsageError(
      `import requires a path to a bundle written by \`memory export\`, or --from <source> (${IMPORT_SOURCES.join(', ')})`,
    );
  }

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

  // The scan gate on the one path where another MACHINE's text enters the store
  // (src/memory/scan.ts). A bundle is exactly the prompt-injection vector the serve
  // path worries about, minus even the "the user once said this" provenance a mined
  // candidate has — so a flagged record is refused entry outright, and LOUDLY: a
  // silent drop would leave the sender believing the fact arrived.
  const admitted: MergedMemory[] = [];
  const flagged: { memory: MergedMemory; findings: ScanFinding[] }[] = [];
  for (const m of merged) {
    const findings = scanMemoryText(m.text);
    if (findings.length > 0) flagged.push({ memory: m, findings });
    else admitted.push(m);
  }

  const local = new Map(listMemories().map((r) => [r.id, r]));
  const records = admitted.map((m) => toRecord(m, local.get(m.id)));
  upsertCandidates(records);

  // Nothing on stdout: this writes to the store, it does not emit a batch.
  const known = admitted.filter((m) => local.has(m.id)).length;
  process.stderr.write(`  ${admitted.length - known} imported, ${known} already known\n`);
  if (flagged.length > 0) {
    const plural = flagged.length === 1 ? 'memory' : 'memories';
    process.stderr.write(
      `  ⚠ ${flagged.length} ${plural} withheld — text matches secret or prompt-injection patterns, not stored:\n`,
    );
    for (const w of flagged) process.stderr.write(`    ${w.memory.id} (${describeFindings(w.findings)})\n`);
  }

  // A repo-scoped memory arrives with no key — export blanks the local path on purpose —
  // and retrieval skips a keyless repo memory rather than matching every cwd. Approving one
  // therefore succeeds and changes nothing, which is the worst available outcome: the user
  // believes the memory is active. Say so at the moment the rows land, and name the fix.
  const unbound = records.filter((r) => r.scope.type === 'repo' && !r.scope.key).length;
  if (unbound > 0) {
    const plural = unbound === 1 ? 'memory' : 'memories';
    process.stderr.write(
      `  ${unbound} repo-scoped ${plural} arrived with no repo key (export strips local paths)\n` +
        `  bind ${unbound === 1 ? 'it' : 'each'} to a repo when you approve: ` +
        `sessions memory approve <id> --scope repo:.\n`,
    );
  }
}

/** How many records the human listing prints before it stops and points at the skill. */
export const HUMAN_LIST_LIMIT = 20;

/**
 * A candidate batch as prose.
 *
 * The JSON batch is the AGENT seam — the /memory skill parses it, clusters it, and drives
 * the triage commands. It was also the default, so a human running `sessions memory mine`
 * got several hundred lines of records at a terminal, which is the interface complaint
 * that produced this function: unreadable, and it invites hand-running triage commands
 * that the skill exists to run for you.
 *
 * So this is deliberately NOT a rendering of every field. It is a summary plus enough of
 * each record to recognise it, and it ends by naming `/memory` — because reading the list
 * is a human job and deciding on 470 of them one `approve` at a time is not.
 */
export function renderBatch(records: MemoryRecord[], opts: { suppressed?: number } = {}): string {
  const untriaged = records.filter((r) => r.state === 'candidate').length;
  const suppressed = opts.suppressed ?? 0;

  if (records.length === 0) {
    return suppressed > 0
      ? `No new candidates. ${suppressed} already triaged and suppressed.`
      : 'No candidates. Nothing in the mined history looks like a durable fact.';
  }

  const head = [
    `${records.length} candidate${records.length === 1 ? '' : 's'}` +
      (untriaged === records.length ? '' : ` (${untriaged} untriaged)`) +
      (suppressed > 0 ? `, ${suppressed} suppressed` : ''),
    '',
  ];

  for (const r of records.slice(0, HUMAN_LIST_LIMIT)) {
    const e = r.evidence;
    const span = e.firstSeen === e.lastSeen ? e.firstSeen : `${e.firstSeen} → ${e.lastSeen}`;
    const facts = [
      `${e.distinctPhrasings} phrasing${e.distinctPhrasings === 1 ? '' : 's'}`,
      `${e.sessions.length} session${e.sessions.length === 1 ? '' : 's'}`,
      span,
      r.scope.type,
      r.state === 'candidate' ? '' : r.state,
    ].filter(Boolean);
    head.push(`  ${r.text}`, `    ${facts.join(' · ')}`, `    ${r.id}`, '');
  }

  if (records.length > HUMAN_LIST_LIMIT) {
    head.push(`  … ${records.length - HUMAN_LIST_LIMIT} more`, '');
  }
  head.push('Run /memory to triage these — it clusters paraphrases and writes the decisions back.');
  head.push('Add --json for the machine-readable batch.');
  return head.join('\n');
}

export interface DocumentedArgs {
  repo?: string;
  /** Emit as JSON for the triage skill; default is the human listing. */
  json?: boolean;
  help: boolean;
}

/** Parse `memory documented [--repo <path>] [--json]`. Throws `UsageError`; never exits. */
export function parseDocumentedArgs(argv: string[]): DocumentedArgs {
  const args: DocumentedArgs = { help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--json') args.json = true;
    else if (a === '--repo') {
      const value = argv[++i];
      if (!value) throw new UsageError('--repo requires a path');
      args.repo = value;
    } else throw new UsageError(`unknown option: ${a}`);
    i++;
  }
  return args;
}

/**
 * What is already binding on an agent here, so triage can avoid repeating it.
 *
 * Read-only over Claude Code's own surfaces. `sessions` never writes to them — the
 * org rule is that a single-tool memory file is not this tool's to edit, and the
 * whole point of reading them is that they are already injected without us.
 */
async function runDocumented(argv: string[]): Promise<void> {
  const args = parseDocumentedArgs(argv);
  if (args.help) help();

  const cwd = args.repo ? resolvePath(args.repo) : process.cwd();
  const facts = documentedFacts(cwd);
  const sources = documentedSources(cwd);

  if (args.json) {
    await writeStdoutFully(JSON.stringify({ cwd, sources, facts }, null, 2) + '\n');
    process.stderr.write(`  ${facts.length} statement${facts.length === 1 ? '' : 's'} already binding here\n`);
    return;
  }

  if (facts.length === 0) {
    process.stderr.write(
      '  Nothing found. Looked for CLAUDE.md, AGENTS.md, and Claude Code’s memory store for this repo.\n',
    );
    return;
  }

  const lines: string[] = [`${facts.length} statements already binding in ${cwd}`, ''];
  let current = '';
  for (const fact of facts) {
    if (fact.source !== current) {
      current = fact.source;
      lines.push(`  ${current}`);
    }
    lines.push(`    - ${fact.text.length > 120 ? `${fact.text.slice(0, 119)}…` : fact.text}`);
  }
  lines.push(
    '',
    `Read from: ${sources.join(', ')}`,
    'These are read, never written — a memory that repeats one is noise.',
  );
  await writeStdoutFully(lines.join('\n') + '\n');
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
      case 'report':
        await runReport(argv.slice(1));
        return;
      case 'documented':
        await runDocumented(argv.slice(1));
        return;
      case 'approve':
      case 'reject':
      case 'snooze':
        runTriage(sub, argv.slice(1));
        return;
      case 'merge':
        runMerge(argv.slice(1));
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
    // The triage seam's own refusals — a flagged text or a blown always-on budget.
    // User-caused, so they get the clean line a UsageError gets, not a stack trace;
    // listed explicitly so a programmer error still crashes loudly.
    if (error instanceof ContentScanError || error instanceof AlwaysOnBudgetError) die(error.message);
    throw error;
  }
}
