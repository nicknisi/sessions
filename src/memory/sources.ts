// Cross-agent memory discovery: what every coding agent on this machine has stored
// about the user and their work, surfaced read-only.
//
// WHY THIS EXISTS. Sessions already mines durable facts out of transcripts, but the
// transcripts are only half of what an agent remembers. Each harness also keeps its
// own store beside the conversation: pi-hermes-memory writes MEMORY.md / USER.md /
// failures.md and a categorized SQLite table; Claude Code injects CLAUDE.md files and
// a per-project memory/ directory; Codex records command-permission rules. A user who
// hops between agents — the audience this project is for — has facts scattered across
// all of them, with no single window and no portability between them.
//
// This module is that window's read layer. It feeds two MCP tools (get_memory_sources
// for inventory, review_agent_memories for content) and one CLI path
// (`memory import --from`, src/memory/cli.ts), which turns another agent's facts into
// triage candidates in the local store.
//
// READ-ONLY, ALWAYS. Every reader here opens files or databases owned by another tool
// — the same contract documented.ts states for Claude's surfaces, extended to every
// agent. SQLite stores are opened `readonly: true`; a store that cannot be read (a
// locked WAL, a missing file) degrades to its fallback or is skipped, never created
// or repaired.
//
// WHAT "DURABLE" MEANS. An entry is `durable: true` when it is a standing fact or
// instruction about how the user works — the genre this project's own store holds,
// and therefore importable as a triage candidate. Codex's allow/deny rules are
// recorded permission decisions, and Claude's agent-memory files are research
// knowledge bases; both are worth seeing in an audit and neither is a candidate, so
// they are `durable: false`.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

import { getPiSessionsDir } from '../paths';
import { collapseHome, claudeHome, projectsDir, projectSlug, statementsIn } from './documented';
import { createContainerResolver, MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from './mine';
import { normalizeText } from './record';
import { scanMemoryText, type ScanFinding } from './scan';
import { tokenize } from './topic';
import type { MemoryKind, MemoryScope } from './types';

export type SourceAgent = 'pi' | 'claude' | 'codex';

/** One memory store an agent keeps, as inventory. */
export interface AgentStore {
  /** Stable id, e.g. 'pi-hermes:db' or 'claude:repo-claude-md'. */
  id: string;
  agent: SourceAgent;
  /** Display path (tilde-collapsed) of the file or directory read. */
  path: string;
  /** Entries read from this store. */
  entries: number;
  /** How many of those entries are importable facts (see the header). */
  durable: number;
  /** 'YYYY-MM-DD' — newest entry date, else the file's mtime, else null. */
  lastUpdated: string | null;
  description: string;
}

/** One fact or rule read out of an agent's store. */
export interface AgentMemoryEntry {
  /** The AgentStore.id it came from. */
  store: string;
  agent: SourceAgent;
  /**
   * Sessions-style scope, derived from provenance: a pi-hermes row's project, the
   * repo a CLAUDE.md sits in, workflow for anything global. A repo scope with an
   * EMPTY key is "repo-scoped but unbound" — the source named a project this
   * machine cannot resolve to a path (pi-hermes records bare repo names), and the
   * same inert-until-triage semantics apply as for a bundle import (retrieve.ts
   * skips a keyless repo memory rather than matching every cwd).
   */
  scope: MemoryScope;
  kind: MemoryKind;
  text: string;
  durable: boolean;
  /** 'YYYY-MM-DD' when the source tracks creation. */
  created?: string;
  lastUpdated?: string;
}

// ——— path resolvers ———

/**
 * pi-hermes-memory's home. SESSIONS_PI_HERMES_DIR is the explicit override; absent
 * one, the dir is derived from getPiSessionsDir() so a test that already redirects
 * SESSIONS_PI_DIR into a tmp tree gets a hermetic `<tmp>/pi-hermes-memory` for free —
 * the real store never leaks into a test that forgot this module existed.
 */
export function piHermesDir(): string {
  if (process.env.SESSIONS_PI_HERMES_DIR) return process.env.SESSIONS_PI_HERMES_DIR;
  return join(dirname(getPiSessionsDir()), 'pi-hermes-memory');
}

/**
 * Codex's home (`~/.codex`). SESSIONS_CODEX_DIR points at the SESSIONS subdirectory
 * (src/preview.ts:19), so the home is its dirname — the same trick as piHermesDir,
 * and likewise hermetic under the existing test env.
 */
export function codexHome(): string {
  const sessionsDir = process.env.SESSIONS_CODEX_DIR || join(homedir(), '.codex', 'sessions');
  return dirname(sessionsDir);
}

// ——— small helpers ———

/** 'YYYY-MM-DD' from a path's mtime, or null when it cannot be statted. */
function mtimeDate(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce an arbitrary stored date value to 'YYYY-MM-DD' or undefined. pi-hermes
 * writes DATE columns as ISO timestamps; anything else (null, numbers, garbage) is
 * dropped rather than carried into evidence, which validates dates strictly
 * (src/memory/record.ts).
 */
function asDate(value: SqlColumnValue): string | undefined {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return undefined;
  const day = parsed.data.slice(0, 10);
  return ISO_DATE.test(day) ? day : undefined;
}

/** Newest of a set of optional dates; ISO dates sort lexicographically. */
function latestDate(dates: (string | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

// ——— pi-hermes ———

/** What SQLite's dynamic typing can hand back for a column. */
type SqlColumnValue = string | number | bigint | null | Uint8Array;

interface HermesRow {
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  created: SqlColumnValue;
  last_referenced: SqlColumnValue;
}

/**
 * Kind from a pi-hermes category. Corrections, preferences, and conventions are
 * directives ("do it this way"); failures, insights, and tool quirks are state of
 * the world. Absent a category the row is informational — the conservative default,
 * since get_memory serves both kinds identically and kind is only a label.
 */
export function hermesKind(category: string | null): MemoryKind {
  if (category === 'correction' || category === 'preference' || category === 'convention') return 'instruction';
  return 'information';
}

/**
 * Scope from a pi-hermes `project` value. Absolute paths canonicalize through the
 * same container resolution the mine uses, so a row recorded in a linked worktree
 * binds to the repo it belongs to. Bare repo NAMES (what pi actually writes) are
 * unresolvable without guessing at the user's directory layout, and a wrong guess
 * binds one repo's fact to another — so they arrive unbound instead, and the import
 * path names the fix (`approve --scope repo:.`).
 */
export function hermesScope(project: string | null, containerOf: (cwd: string) => string): MemoryScope {
  if (!project) return { type: 'workflow', key: '' };
  if (project.startsWith('/')) return { type: 'repo', key: containerOf(project) };
  return { type: 'repo', key: '' };
}

/**
 * Read pi-hermes's structured store, or null when it is absent or unreadable.
 *
 * `readonly: true` is load-bearing: this is another extension's live database (WAL
 * mode), and opening it read-write would create the file when missing and could
 * interfere with the owner's locking. A readonly open of a WAL database can still
 * fail when the -shm is gone but a -wal remains (an owner killed mid-write); the
 * caller falls back to the markdown rendering rather than treating that as fatal.
 */
function readHermesDb(dir: string): HermesRow[] | null {
  const path = join(dir, 'sessions.db');
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    return db
      .query<HermesRow, []>(
        'SELECT project, target, category, content, created, last_referenced FROM memories ORDER BY id',
      )
      .all();
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/** A §-separated section of a pi-hermes markdown store, with its trailing metadata. */
export interface HermesSection {
  text: string;
  created?: string;
  lastUpdated?: string;
}

/**
 * Parse MEMORY.md / USER.md / failures.md. Sections are separated by a line
 * containing only `§` and carry a trailing `<!-- created=YYYY-MM-DD, last=... -->`
 * comment written by the extension. Text is normalized the same way the mine
 * normalizes candidates, so a fact identical in both worlds fingerprints identically
 * and dedupes on import.
 */
export function parseHermesSections(raw: string): HermesSection[] {
  const out: HermesSection[] = [];
  for (const chunk of raw.split(/^\s*§\s*$/m)) {
    let body = chunk.trim();
    if (!body) continue;
    let created: string | undefined;
    let lastUpdated: string | undefined;
    const meta = body.match(/<!--\s*created=(\d{4}-\d{2}-\d{2})(?:\s*,\s*last=(\d{4}-\d{2}-\d{2}))?\s*-->\s*$/);
    if (meta) {
      created = meta[1];
      lastUpdated = meta[2] ?? meta[1];
      body = body.slice(0, meta.index).trim();
    }
    const text = normalizeText(body);
    if (text) out.push({ text, created, lastUpdated });
  }
  return out;
}

/** The markdown stores, in the order they matter: facts, profile, corrections. */
const HERMES_MD_FILES = ['MEMORY.md', 'USER.md', 'failures.md'] as const;

/** failures.md records corrections and conventions; the other two are descriptive. */
function hermesMdKind(file: string): MemoryKind {
  return file === 'failures.md' ? 'instruction' : 'information';
}

/** Everything discovered from one agent's memory world. */
interface AgentCollection {
  stores: AgentStore[];
  entries: AgentMemoryEntry[];
}

function collectHermes(): AgentCollection {
  const dir = piHermesDir();
  const rows = readHermesDb(dir);

  if (rows !== null) {
    const containerOf = createContainerResolver();
    const entries: AgentMemoryEntry[] = rows
      .map((row) => ({
        store: 'pi-hermes:db',
        agent: 'pi' as const,
        scope: hermesScope(row.project, containerOf),
        kind: hermesKind(row.category),
        text: normalizeText(row.content),
        durable: true,
        created: asDate(row.created),
        lastUpdated: asDate(row.last_referenced),
      }))
      .filter((entry) => entry.text.length > 0);
    const store: AgentStore = {
      id: 'pi-hermes:db',
      agent: 'pi',
      path: collapseHome(join(dir, 'sessions.db')),
      entries: entries.length,
      durable: entries.length,
      lastUpdated: latestDate(entries.map((e) => e.lastUpdated)) ?? mtimeDate(join(dir, 'sessions.db')),
      description:
        "Pi's structured memory store (pi-hermes-memory): durable facts, user profile, and failures, with categories and per-project scoping.",
    };
    return { stores: [store], entries };
  }

  // Fallback: the markdown rendering the extension maintains for its own context
  // injection. Global by construction — the .md layer has no per-project split.
  const stores: AgentStore[] = [];
  const entries: AgentMemoryEntry[] = [];
  for (const file of HERMES_MD_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let sections: HermesSection[] = [];
    try {
      sections = parseHermesSections(readFileSync(path, 'utf8'));
    } catch {
      continue; // unreadable: skip the store, never fail discovery
    }
    if (sections.length === 0) continue;
    const id = `pi-hermes:${file}`;
    stores.push({
      id,
      agent: 'pi',
      path: collapseHome(path),
      entries: sections.length,
      durable: sections.length,
      lastUpdated: latestDate(sections.map((s) => s.lastUpdated)) ?? mtimeDate(path),
      description: `pi-hermes-memory's ${file} — ${file === 'USER.md' ? 'user profile and working preferences' : file === 'failures.md' ? 'recorded corrections and conventions' : 'environment facts and tool quirks'}.`,
    });
    for (const s of sections) {
      entries.push({
        store: id,
        agent: 'pi',
        scope: { type: 'workflow', key: '' },
        kind: hermesMdKind(file),
        text: s.text,
        durable: true,
        created: s.created,
        lastUpdated: s.lastUpdated,
      });
    }
  }
  return { stores, entries };
}

// ——— claude ———

function readStatements(path: string): string[] {
  try {
    return statementsIn(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

interface FileStoreResult {
  store: AgentStore | null;
  entries: AgentMemoryEntry[];
}

function fileStore(
  id: string,
  path: string,
  description: string,
  scope: MemoryScope,
  durable: boolean,
): FileStoreResult {
  if (!existsSync(path)) return { store: null, entries: [] };
  const statements = readStatements(path);
  if (statements.length === 0) return { store: null, entries: [] };
  const store: AgentStore = {
    id,
    agent: 'claude',
    path: collapseHome(path),
    entries: statements.length,
    durable: durable ? statements.length : 0,
    lastUpdated: mtimeDate(path),
    description,
  };
  return {
    store,
    entries: statements.map((text) => ({
      store: id,
      agent: 'claude' as const,
      scope,
      kind: 'instruction' as const,
      text,
      durable,
      lastUpdated: store.lastUpdated ?? undefined,
    })),
  };
}

function collectClaude(cwd: string): AgentCollection {
  const stores: AgentStore[] = [];
  const entries: AgentMemoryEntry[] = [];
  const push = (result: FileStoreResult): void => {
    if (result.store) stores.push(result.store);
    entries.push(...result.entries);
  };

  const container = createContainerResolver()(cwd);
  const repoScope: MemoryScope = { type: 'repo', key: container };

  push(
    fileStore(
      'claude:global',
      join(claudeHome(), 'CLAUDE.md'),
      "Claude Code's global instruction file, injected into every Claude session on this machine.",
      { type: 'workflow', key: '' },
      true,
    ),
  );
  push(
    fileStore(
      'claude:repo-claude-md',
      join(container, 'CLAUDE.md'),
      "This repo's CLAUDE.md — version-controlled project conventions Claude Code injects (and other agents read).",
      repoScope,
      true,
    ),
  );
  push(
    fileStore(
      'claude:repo-agents-md',
      join(container, 'AGENTS.md'),
      "This repo's AGENTS.md — the cross-agent convention file.",
      repoScope,
      true,
    ),
  );

  // Claude Code's per-project memory store: the same genre as this project's own
  // store, captured from Claude sessions. MEMORY.md is the index of pointers, not a
  // fact file — documented.ts already excludes it for the same reason.
  const memoryDir = join(projectsDir(), projectSlug(container), 'memory');
  if (existsSync(memoryDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .sort();
    } catch {
      files = [];
    }
    const dirEntries: AgentMemoryEntry[] = [];
    for (const file of files) {
      const path = join(memoryDir, file);
      for (const text of readStatements(path)) {
        dirEntries.push({
          store: 'claude:project-memory',
          agent: 'claude',
          scope: repoScope,
          kind: 'instruction',
          text,
          durable: true,
          lastUpdated: mtimeDate(path) ?? undefined,
        });
      }
    }
    if (dirEntries.length > 0) {
      stores.push({
        id: 'claude:project-memory',
        agent: 'claude',
        path: collapseHome(memoryDir),
        entries: dirEntries.length,
        durable: dirEntries.length,
        lastUpdated: latestDate(dirEntries.map((e) => e.lastUpdated)),
        description: "Claude Code's per-project memory store — facts captured from past Claude sessions in this repo.",
      });
      entries.push(...dirEntries);
    }
  }

  // Agent research memory: knowledge bases an agent wrote for itself, not directives
  // for future sessions. Visible in an audit, not importable.
  const agentMemoryDir = join(claudeHome(), 'agent-memory');
  if (existsSync(agentMemoryDir)) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(agentMemoryDir).sort();
    } catch {
      dirs = [];
    }
    const dirEntries: AgentMemoryEntry[] = [];
    for (const name of dirs) {
      const path = join(agentMemoryDir, name, 'MEMORY.md');
      for (const text of readStatements(path)) {
        dirEntries.push({
          store: 'claude:agent-memory',
          agent: 'claude',
          scope: { type: 'workflow', key: '' },
          kind: 'information',
          text,
          durable: false,
          lastUpdated: mtimeDate(path) ?? undefined,
        });
      }
    }
    if (dirEntries.length > 0) {
      stores.push({
        id: 'claude:agent-memory',
        agent: 'claude',
        path: collapseHome(agentMemoryDir),
        entries: dirEntries.length,
        durable: 0,
        lastUpdated: latestDate(dirEntries.map((e) => e.lastUpdated)),
        description: "Claude Code's agent research memory — agent-written knowledge bases, not standing instructions.",
      });
      entries.push(...dirEntries);
    }
  }

  return { stores, entries };
}

// ——— codex ———

const CODEX_RULE = /^prefix_rule\(pattern=\[(.*)\],\s*decision="(allow|deny)"\)\s*$/;

/**
 * Render one `prefix_rule(pattern=[...], decision="allow")` line as prose, or null
 * when the line is not one. The pattern is a shell-argv-style quoted list; joining
 * the tokens is a readable approximation, not an evaluatable command.
 */
export function parseCodexRule(line: string): { text: string; decision: 'allow' | 'deny' } | null {
  const match = line.trim().match(CODEX_RULE);
  if (!match) return null;
  const tokens = [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (tokens.length === 0) return null;
  // SAFETY: CODEX_RULE's second group is the literal alternation (allow|deny).
  return { text: `codex ${match[2]}: ${tokens.join(' ')}`, decision: match[2] as 'allow' | 'deny' };
}

function collectCodex(): AgentCollection {
  const stores: AgentStore[] = [];
  const entries: AgentMemoryEntry[] = [];
  const home = codexHome();

  const rulesDir = join(home, 'rules');
  if (existsSync(rulesDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(rulesDir)
        .filter((f) => f.endsWith('.rules'))
        .sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const path = join(rulesDir, file);
      let rules: { text: string; decision: string }[] = [];
      try {
        rules = readFileSync(path, 'utf8')
          .split('\n')
          .map(parseCodexRule)
          .filter((r): r is { text: string; decision: 'allow' | 'deny' } => r !== null);
      } catch {
        continue;
      }
      if (rules.length === 0) continue;
      const id = `codex:rules:${file}`;
      stores.push({
        id,
        agent: 'codex',
        path: collapseHome(path),
        entries: rules.length,
        durable: 0, // permission decisions, not durable facts — audit only
        lastUpdated: mtimeDate(path),
        description: `Codex command permissions (${file}) — allow/deny decisions recorded from past approvals.`,
      });
      for (const rule of rules) {
        entries.push({
          store: id,
          agent: 'codex',
          scope: { type: 'workflow', key: '' },
          kind: 'information',
          text: rule.text,
          durable: false,
          lastUpdated: mtimeDate(path) ?? undefined,
        });
      }
    }
  }

  // Thread objectives: ephemeral per-thread state, so inventory only — there is no
  // fact here a future session should treat as standing.
  const goalsDb = join(home, 'goals_1.sqlite');
  if (existsSync(goalsDb)) {
    let count = 0;
    let db: Database | null = null;
    try {
      db = new Database(goalsDb, { readonly: true });
      count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM thread_goals').get()?.n ?? 0;
    } catch {
      count = 0;
    } finally {
      try {
        db?.close();
      } catch {}
    }
    stores.push({
      id: 'codex:goals',
      agent: 'codex',
      path: collapseHome(goalsDb),
      entries: count,
      durable: 0,
      lastUpdated: mtimeDate(goalsDb),
      description: "Codex's thread objectives — ephemeral per-thread goals, not durable memory.",
    });
  }

  return { stores, entries };
}

// ——— assembly ———

/** Every store and entry visible from `cwd`, sorted deterministically. */
export function collectAgentMemory(cwd: string): AgentCollection {
  const families = [collectHermes(), collectClaude(cwd), collectCodex()];
  const stores = families.flatMap((f) => f.stores);
  const entries = families.flatMap((f) => f.entries);
  stores.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Entries follow the store order and keep SOURCE order within each store (file
  // order, row order) — the author's ordering is meaningful, and a stable sort keeps
  // it while making the whole batch deterministic. Fingerprinting happens at the
  // consumers that need ids (the review projection, the import's dedupe), not here.
  const storeOrder = new Map(stores.map((s, index) => [s.id, index]));
  entries.sort((a, b) => storeOrder.get(a.store)! - storeOrder.get(b.store)!);
  return { stores, entries };
}

// ——— reshaping long entries to the memory band ———

export interface SplitResult {
  /** Pieces within the mine's text band, in source order. */
  pieces: string[];
  /** Sentences that were individually too long even after splitting. */
  skippedLong: number;
  /** Fragments too short to stand as a fact and with nothing to fold into. */
  skippedShort: number;
}

/**
 * Sentence boundary: terminal punctuation, whitespace, then something that can start
 * a sentence. The lookahead deliberately excludes lowercase letters, which is what
 * keeps "e.g. in vitest config" and "vs. the old path" from being read as boundaries
 * at the cost of never splitting "...end. then we..." — a missed boundary merges two
 * sentences into one candidate, and triage merges and splits routinely, so the safe
 * direction is not splitting.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9`"'(●—–\-•§])/;

/** Abbreviations whose trailing period SENTENCE_BOUNDARY can misread. */
const ABBREVIATION_END = /\b(e\.g|i\.e|etc|vs|cf|ca)\.$/;

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(SENTENCE_BOUNDARY)) {
    const prev = out[out.length - 1];
    if (prev && ABBREVIATION_END.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * Reshape one source entry into band-sized candidates.
 *
 * pi-hermes consolidates: one row averages ~1,100 chars on the author's machine and
 * holds several facts, so an import that enforced the mine's 240-char ceiling on the
 * whole entry would bring in NOTHING from the store this feature exists for. The
 * split uses the source's own structure, in order:
 *
 *  1. Enumeration markers `(1) (2) …` — hermes's explicit sub-fact boundaries.
 *  2. Sentence boundaries inside an over-long chunk, packed greedily up to the band
 *     so related sentences stay together rather than arriving as orphaned fragments.
 *
 * Everything here is deterministic and conservative: it never reorders, never
 * paraphrases, and prefers a too-long skip to a mid-sentence cut. The pieces are
 * CANDIDATES — a wrong boundary costs one triage decision, which is where the
 * judgment lives (the /memory skill's merge and approve --as).
 *
 * A leading fragment under the floor ("Env tool-quirks:" before the first `(1)`)
 * folds FORWARD into the next chunk when the combination fits — it is the chunk's
 * label, and dropping it would orphan every fact that follows from its topic.
 */
export function splitEntryToBand(text: string): SplitResult {
  const chunks = text
    .split(/(?=\(\d{1,2}\)\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let skippedLong = 0;
  let skippedShort = 0;

  const pushPiece = (p: string): void => {
    if (p.length > MAX_TEXT_LENGTH) {
      skippedLong++;
      return;
    }
    if (p.length < MIN_TEXT_LENGTH) {
      skippedShort++;
      return;
    }
    pieces.push(p);
  };

  let carry = '';
  for (const chunk of chunks) {
    const combined = carry ? `${carry} ${chunk}` : chunk;
    if (combined.length < MIN_TEXT_LENGTH) {
      carry = combined; // a label fragment — keep accumulating forward
      continue;
    }
    carry = '';
    if (combined.length <= MAX_TEXT_LENGTH) {
      pushPiece(combined);
      continue;
    }
    let buffer = '';
    for (const sentence of splitSentences(combined)) {
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= MAX_TEXT_LENGTH) {
        buffer = candidate;
        continue;
      }
      if (buffer) pushPiece(buffer);
      buffer = sentence; // a lone sentence may itself be over; pushPiece counts it
    }
    if (buffer) pushPiece(buffer);
  }
  if (carry) skippedShort++;
  return { pieces, skippedLong, skippedShort };
}

/** Entries whose text passes the content gate, and the ones it refuses, with findings. */
interface ScanSplit {
  clean: AgentMemoryEntry[];
  flagged: { entry: AgentMemoryEntry; findings: ScanFinding[] }[];
}

export function splitByScan(entries: AgentMemoryEntry[]): ScanSplit {
  const clean: AgentMemoryEntry[] = [];
  const flagged: { entry: AgentMemoryEntry; findings: ScanFinding[] }[] = [];
  for (const entry of entries) {
    const findings = scanMemoryText(entry.text);
    if (findings.length > 0) flagged.push({ entry, findings });
    else clean.push(entry);
  }
  return { clean, flagged };
}

/**
 * Token-overlap threshold for "another store already holds this fact". Deliberately
 * stricter than retrieval's TOPIC_THRESHOLD: a topic match decides relevance, while
 * this flags probable redundancy, and a false positive there tells the user two
 * stores agree when they merely share vocabulary.
 */
export const SIMILARITY_THRESHOLD = 0.6;

/**
 * Ids of stored memories whose text substantially overlaps `text`, sorted.
 *
 * Overlap is `|∩| / min(|A|, |B|)` over the stemmed token sets (src/memory/topic.ts),
 * so a short stored rule fully contained in a longer agent entry still flags. Both
 * sets need at least three tokens — below that, containment is vocabulary, not
 * redundancy ("use pnpm" matches everything about pnpm).
 *
 * Exact text duplicates are caught separately by fingerprint equality at the call
 * site; this is the fuzzy half.
 */
export function similarStoredIds(text: string, stored: { id: string; text: string }[]): string[] {
  const self = tokenize(text);
  if (self.size < 3) return [];
  const out: string[] = [];
  for (const s of stored) {
    const other = tokenize(s.text);
    if (other.size < 3) continue;
    const [smaller, larger] = self.size <= other.size ? [self, other] : [other, self];
    let hits = 0;
    for (const token of smaller) if (larger.has(token)) hits++;
    if (hits / smaller.size >= SIMILARITY_THRESHOLD) out.push(s.id);
  }
  return out.sort();
}
