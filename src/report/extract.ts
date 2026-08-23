import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from './parsers/types.ts';
import type { ToolId } from './types.ts';
import {
  parseClaudeCode,
  parseClaudeCodeFile,
  dedupeEvents,
  resolveAgentTypes,
  mergeAgentNames,
  type AgentName,
} from './parsers/claude-code.ts';
import { parsePi, parsePiFile } from './parsers/pi.ts';
import { parseCodex, parseCodexFile } from './parsers/codex.ts';
import { parseOpencode } from './parsers/opencode.ts';
import { walkJsonl, pruneThreshold } from './parsers/walk.ts';
import { getOpencodeDbPath } from '../opencode.ts';
import { getPiSessionsDir } from '../paths.ts';
import {
  openEventCache,
  statAll,
  planRefresh,
  putFile,
  pruneMissing,
  decodeRow,
  type FileParse,
  type FileStat,
} from './event-cache.ts';

export interface ReportRoots {
  claudeCode: string;
  pi: string;
  codex: string;
  /** OpenCode's SQLite DB path (not a directory) — its sessions live in one DB. Optional so
   *  callers that predate OpenCode support (and tests) need not supply it. */
  opencode?: string;
}

export function defaultRoots(): ReportRoots {
  const home = homedir();
  return {
    claudeCode: join(home, '.claude', 'projects'),
    // Same resolution (SESSIONS_PI_DIR / PI_CODING_AGENT_* overrides included) as
    // the search index and scanner — one source of truth.
    pi: getPiSessionsDir(),
    codex: join(home, '.codex', 'sessions'),
    // Same resolution (env override included) as the search index — one source of truth.
    opencode: getOpencodeDbPath(),
  };
}

export interface GatherOptions {
  /** Local YYYY-MM-DD lower bound of the report period, when one is set. Files not
   *  written since then are skipped unread — see parsers/walk.ts. OpenCode reads a
   *  single SQLite database rather than a file tree, so it ignores this. */
  since?: string;
  /** Skip the incremental parse cache and read every file. */
  noCache?: boolean;
}

/** A file-tree source: how to enumerate it, and how to parse one of its files. */
interface FileSource {
  root: string;
  parseFile: (path: string) => Promise<FileParse>;
}

function fileSources(roots: ReportRoots, want: (t: ToolId) => boolean): FileSource[] {
  const out: FileSource[] = [];
  if (want('claude-code')) out.push({ root: roots.claudeCode, parseFile: parseClaudeCodeFile });
  if (want('pi'))
    out.push({
      root: roots.pi,
      parseFile: async (p) => {
        const events = await parsePiFile(p);
        // Register each Pi dispatch under its own (already final) type, so the
        // cross-file resolveAgentTypes pass confirms it instead of renaming it
        // to 'unknown' — Pi has no parent-record naming step to wait for.
        const agentTypes: Record<string, AgentName> = {};
        for (const e of events) if (e.agent) agentTypes[e.agent.id] = { type: e.agent.type, strong: true };
        return { events, agentTypes };
      },
    });
  if (want('codex'))
    out.push({ root: roots.codex, parseFile: async (p) => ({ events: await parseCodexFile(p), agentTypes: {} }) });
  return out;
}

/** The uncached path: each parser walks its own tree, exactly as before. */
async function gatherDirect(roots: ReportRoots, want: (t: ToolId) => boolean, since?: string): Promise<UsageEvent[]> {
  const walk = { since };
  const tasks: Promise<UsageEvent[]>[] = [];
  if (want('claude-code')) tasks.push(parseClaudeCode(roots.claudeCode, walk));
  if (want('pi')) tasks.push(parsePi(roots.pi, walk));
  if (want('codex')) tasks.push(parseCodex(roots.codex, walk));
  return (await Promise.all(tasks)).flat();
}

export async function gatherEvents(
  roots: ReportRoots = defaultRoots(),
  tools?: Set<ToolId>,
  opts: GatherOptions = {},
): Promise<UsageEvent[]> {
  const want = (t: ToolId): boolean => !tools || tools.has(t);

  // OpenCode is one SQLite database, not a file tree, so it has nothing to
  // incrementally re-walk and stays on the direct path either way.
  const opencode: UsageEvent[] = want('opencode') && roots.opencode ? await parseOpencode(roots.opencode) : [];

  const db = opts.noCache ? null : openEventCache();
  if (!db) return [...(await gatherDirect(roots, want, opts.since)), ...opencode];

  try {
    const threshold = pruneThreshold(opts.since);
    const collected: UsageEvent[] = [];
    const agentTypes: Record<string, AgentName> = {};
    const livePaths = new Set<string>();
    const enumeratedRoots: string[] = [];

    for (const source of fileSources(roots, want)) {
      enumeratedRoots.push(source.root);
      // Enumerate the whole tree, not just the period: cheap (one stat per file)
      // and it keeps the cache complete, so today's bounded run does not throw
      // away the parse that tomorrow's unbounded run needs.
      const files = await statAll(walkJsonl(source.root));
      for (const f of files) livePaths.add(f.path);

      const { stale, fresh } = planRefresh(db, files);
      // A stale file older than the period cannot hold an in-range event, so it
      // is left unparsed. It stays absent from the cache and will be picked up by
      // the first run whose window includes it.
      const toParse = threshold === undefined ? stale : stale.filter((f) => f.mtimeMs >= threshold);

      const parsed = await Promise.all(
        toParse.map(async (f): Promise<[FileStat, FileParse]> => [f, await source.parseFile(f.path)]),
      );
      db.transaction(() => {
        for (const [f, p] of parsed) putFile(db, f, p);
      })();

      const inWindow = (mtimeMs: number) => threshold === undefined || mtimeMs >= threshold;
      for (const [f, p] of parsed) {
        if (!inWindow(f.mtimeMs)) continue;
        collected.push(...p.events);
        mergeAgentNames(agentTypes, p.agentTypes);
      }
      for (const row of fresh.values()) {
        if (!inWindow(row.mtime_ms)) continue;
        const p = decodeRow(row);
        collected.push(...p.events);
        mergeAgentNames(agentTypes, p.agentTypes);
      }
    }

    // Full enumeration per root, so anything under a walked root that is not in
    // livePaths is genuinely gone. Roots we did not walk are left alone.
    pruneMissing(db, livePaths, enumeratedRoots);

    // Dedup and dispatch naming are cross-file steps, so they run here rather
    // than in the per-file parse the cache stores.
    const events = dedupeEvents(collected);
    resolveAgentTypes(events, agentTypes);
    return [...events, ...opencode];
  } catch {
    // Any cache-path failure falls back to a plain read rather than a bad report.
    return [...(await gatherDirect(roots, want, opts.since)), ...opencode];
  } finally {
    try {
      db.close();
    } catch {}
  }
}
