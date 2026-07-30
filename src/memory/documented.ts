// What is ALREADY binding on an agent in this repo, read from the surfaces Claude Code
// itself loads. Read-only, always: `sessions` never writes to any of them.
//
// WHY THIS EXISTS. The mine reads transcripts, so it re-derives facts the user already
// wrote down somewhere that gets injected every session — `~/.claude/CLAUDE.md`, a
// project `CLAUDE.md`, and `~/.claude/projects/<slug>/memory/*.md`. That last one is the
// sharp overlap: it is the same genre and the same mechanism as this store — durable
// facts captured from sessions, injected at session start. This repo already has eight of
// them, mined out of the very sessions `memory mine` reads.
//
// A duplicate memory is worse than a missing one. It spends context twice, and the two
// copies drift: when the CLAUDE.md version is edited and the approved memory is not,
// an agent gets both and cannot tell which is current.
//
// WHY IT IS NOT A MECHANICAL DEDUPE. Token-overlap scoring was tried against this exact
// corpus and was useless — it scored "I don't know!" as already-documented. Whether two
// sentences assert the same fact is the judgment the /memory skill already makes for
// clustering. This module's job is only to put the prior art in front of that judgment.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Resolved lazily from the env on every call, matching src/cache.ts:51-55 — a test that
// sets SESSIONS_CLAUDE_DIR after import must still be honored.
//
// SESSIONS_CLAUDE_DIR is the PROJECTS root (`~/.claude/projects`), not `~/.claude`, so
// the global instruction file is one level up from it. Deriving it rather than reading
// $HOME keeps a redirected test env fully contained.
function projectsDir(): string {
  return process.env.SESSIONS_CLAUDE_DIR || join(homedir(), '.claude/projects');
}
function claudeHome(): string {
  return dirname(projectsDir());
}

/** One already-binding statement, with enough provenance for the skill to cite it. */
export interface DocumentedFact {
  /** Display path, tilde-collapsed — this is shown to a human and must not leak $HOME. */
  source: string;
  text: string;
}

/** Claude Code's per-project directory name: the cwd with separators flattened to `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function collapseHome(path: string): string {
  const home = process.env.HOME ?? '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Split a markdown doc into statements.
 *
 * Bullets and paragraphs, not sentences: an instruction file states one rule per bullet,
 * and splitting on `.` would shred "use bun, not npm. always." into two half-facts that
 * match nothing. Headings and fenced code are dropped — a heading is a label and a code
 * block is an example, neither is a claim.
 */
export function statementsIn(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith('#') || line.startsWith('|') || line.startsWith('---')) continue;
    out.push(line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  return out.filter((s) => s.length >= 20);
}

function readFacts(path: string, label: string, into: DocumentedFact[]): void {
  if (!existsSync(path)) return;
  try {
    for (const text of statementsIn(readFileSync(path, 'utf8'))) into.push({ source: label, text });
  } catch {
    // An unreadable instruction file must not fail a mine. Prior art is an input to a
    // judgment, not a correctness requirement.
  }
}

/**
 * Every already-binding statement that applies to `cwd`.
 *
 * Ordered global-first so the skill sees the broadest constraints before the repo's own,
 * which is also the order Claude Code injects them in.
 */
export function documentedFacts(cwd: string): DocumentedFact[] {
  const facts: DocumentedFact[] = [];

  readFacts(join(claudeHome(), 'CLAUDE.md'), '~/.claude/CLAUDE.md', facts);
  readFacts(join(cwd, 'CLAUDE.md'), 'CLAUDE.md', facts);
  readFacts(join(cwd, 'AGENTS.md'), 'AGENTS.md', facts);

  // Claude Code's own memory store for this project. MEMORY.md is the index — one
  // pointer line per file — so reading it alongside the files it points at would count
  // every fact twice, once as a hook and once in full.
  const memoryDir = join(projectsDir(), projectSlug(cwd), 'memory');
  if (existsSync(memoryDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      entries = [];
    }
    for (const file of entries.sort()) {
      readFacts(join(memoryDir, file), `claude-memory/${basename(file, '.md')}`, facts);
    }
  }

  return facts;
}

/** `documentedFacts` for display: the tilde-collapsed roots that were actually read. */
export function documentedSources(cwd: string): string[] {
  const candidates = [
    join(claudeHome(), 'CLAUDE.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'AGENTS.md'),
    join(projectsDir(), projectSlug(cwd), 'memory'),
  ];
  return candidates.filter((p) => existsSync(p)).map(collapseHome);
}
