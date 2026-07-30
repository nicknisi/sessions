// Sessions-owned walker that wraps the vendored walkJsonl with an mtime filter.
// Kept out of util.ts so that file stays byte-comparable with upstream.
//
// A bounded report (`--today`, `--days 7`, `--this-month`) otherwise pays to read
// and JSON-parse the entire transcript corpus before throwing almost all of it
// away in a date filter. A transcript's last write is an upper bound on the
// timestamps inside it, so a file untouched since before the window cannot hold
// an in-range event and never needs to be opened.
import { stat } from 'node:fs/promises';
import { walkJsonl as walkAll } from './util.ts';

/** Clock skew, timezone offsets, and restored-from-backup mtimes all shift a file's
 *  apparent age. Two days of slack costs a handful of extra file reads and makes
 *  the pruning safe against every one of them. */
export const MTIME_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

export interface WalkOptions {
  /** Local YYYY-MM-DD lower bound of the report period. Undefined means no bound,
   *  in which case every file is read. */
  since?: string;
}

/** Epoch ms below which a file cannot hold an event in the period. */
export function pruneThreshold(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const t = Date.parse(since + 'T00:00:00Z');
  return Number.isNaN(t) ? undefined : t - MTIME_SLACK_MS;
}

export async function* walkJsonl(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const threshold = pruneThreshold(opts.since);
  for await (const path of walkAll(root)) {
    if (threshold !== undefined) {
      try {
        if ((await stat(path)).mtimeMs < threshold) continue;
      } catch {
        // Unreadable stat is not a reason to drop data — fall through and let the
        // reader decide.
      }
    }
    yield path;
  }
}
