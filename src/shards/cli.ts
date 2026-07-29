// Arg parsing and dispatch for the `shards` command group. Phase 1 ships only
// `mine`; Phase 2 adds approve/reject/snooze, Phase 4 adds export/import.
//
// The batch JSON goes to stdout and everything human-readable goes to stderr —
// that split is what makes `sessions shards mine | <agent>` a usable interface.

import { resolveRepo } from '../repo';
import { writeStdoutFully } from '../stdout';
import { createContainerResolver, mine } from './mine';
import { getPersistedStates, upsertCandidates, type PersistedState } from './store';
import type { ShardRecord } from './types';

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

Options:
  --repo <path>    Scope to one repo container (default: the current repo)
  --all            Mine every repo in the index
  --json           Emit the candidate batch as JSON on stdout (the default)
  -h, --help       Show this help
`);
  process.exit(0);
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
  upsertCandidates(mined);
  // Read the state back rather than trusting the fresh records: upsertCandidates
  // deliberately preserves a stored state (store.ts ON CONFLICT), so the batch on
  // stdout would otherwise disagree with the database it just wrote.
  const records = applyPersistedStates(mined, getPersistedStates(mined.map((r) => r.id)));

  await writeStdoutFully(JSON.stringify(records, null, 2) + '\n');
  const fresh = records.filter((r) => r.state === 'candidate').length;
  process.stderr.write(
    `  ${records.length} candidate${records.length === 1 ? '' : 's'}` +
      (fresh === records.length ? '' : ` (${fresh} untriaged)`) +
      '\n',
  );
}

export async function runShards(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') help();
  try {
    switch (sub) {
      case 'mine':
        await runMine(argv.slice(1));
        return;
      default:
        throw new UsageError(`unknown subcommand: ${sub}`);
    }
  } catch (error) {
    if (error instanceof UsageError) die(error.message);
    throw error;
  }
}
