/**
 * Invariants asserted against the real transcripts on THIS machine.
 *
 * Env-gated because it reads ~/.codex/sessions and ~/.claude/projects, which CI does not
 * have and which differ per developer. Run it with:
 *
 *     SESSIONS_LIVE_CORPUS=1 bun test src/parser.corpus.test.ts
 *
 * Why this exists rather than fixture tests alone: the Codex extraction bug was invisible
 * to fixtures for two years because parser.test.ts asserted a hand-written shape that
 * occurs zero times in real Codex logs, while the sibling extract-files/extract-commands
 * dispatchers DID understand the real envelope and kept populating files and commands.
 * Every unit test passed and every rollout still extracted to zero messages. Only reading
 * the actual corpus catches that class, so this asserts against it directly.
 *
 * The one-time main-vs-branch differential is deliberately NOT here: it compared two
 * checkouts of the same function and stops being expressible once the fix is merged. It
 * was run out-of-band over 9,112 Claude and 166 pi transcripts (108,545 and 1,542
 * messages) and found byte-identical output; what remains checkable in-repo is that the
 * non-Codex paths still produce messages at all, which `no harness extracts to zero`
 * below covers.
 */
import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Glob } from 'bun';
import { extractMessages } from './parser';
import { buildPiTree } from './pi-tree';

const ENABLED = process.env.SESSIONS_LIVE_CORPUS === '1';
const describeCorpus = ENABLED ? describe : describe.skip;

/** Real roots, not the SESSIONS_* test redirections — the point is the actual corpus. */
const CODEX_ROOT = join(homedir(), '.codex', 'sessions');
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects');
const PI_ROOT = join(homedir(), '.pi', 'agent', 'sessions');

// Kept in sync with the copy in parser.ts by the assertion below, which fails if a
// non-genuine turn appears that this pattern cannot explain.
const CODEX_INJECTED =
  /^(<environment_context|<user_action|<turn_aborted|<recommended_plugins|<image\b|<skill\b|<user_shell_command|# AGENTS\.md instructions for |Warning: )/;

async function* transcripts(root: string, pattern: string, cap: number): AsyncGenerator<string[]> {
  if (!existsSync(root)) return;
  let n = 0;
  for await (const p of new Glob(pattern).scan({ cwd: root, absolute: true })) {
    if (n++ >= cap) return;
    yield (await Bun.file(p).text()).split('\n').filter((l) => l.trim());
  }
}

describeCorpus('live corpus', () => {
  test('every substantive Codex rollout extracts messages', async () => {
    let files = 0;
    let substantive = 0;
    let extracted = 0;
    for await (const lines of transcripts(CODEX_ROOT, '**/rollout-*.jsonl', 5000)) {
      files++;
      // "Substantive" = carries at least one model-facing message record. A rollout that
      // was opened and abandoned holds only session_meta and legitimately yields nothing.
      const hasMessage = lines.some((l) => {
        try {
          const d = JSON.parse(l);
          return d?.type === 'response_item' && d?.payload?.type === 'message';
        } catch {
          return false;
        }
      });
      if (!hasMessage) continue;
      substantive++;
      if (extractMessages(lines).length > 0) extracted++;
    }
    if (files === 0) return; // no Codex corpus on this machine
    expect(substantive).toBeGreaterThan(0);
    expect(extracted).toBe(substantive);
  });

  test('Codex non-genuine turns are all explained by the injection prefixes', async () => {
    // The event_msg join and the prefix regex are independent signals. On the corpus they
    // agree exactly; a turn marked non-genuine that no prefix explains means the join has
    // started mis-firing (a whitespace-normalization drift between the two streams would
    // look like this), which is the failure mode that silently blanks first_prompt.
    const unexplained: string[] = [];
    for await (const lines of transcripts(CODEX_ROOT, '**/rollout-*.jsonl', 5000)) {
      for (const m of extractMessages(lines)) {
        if (m.role !== 'user' || m.genuine) continue;
        if (!CODEX_INJECTED.test(m.text.trim())) unexplained.push(m.text.slice(0, 80));
      }
    }
    expect(unexplained).toEqual([]);
  });

  test('numbering stays dense on every real transcript', async () => {
    // array[i].index === i is what get_session_messages pagination and message_fts hit
    // offsets both rely on. A harness-specific branch that emits out of order breaks
    // search-result deep-linking without breaking any single-message assertion.
    const roots: [string, string][] = [
      [CODEX_ROOT, '**/rollout-*.jsonl'],
      [CLAUDE_ROOT, '**/*.jsonl'],
      [PI_ROOT, '**/*.jsonl'],
    ];
    for (const [root, pattern] of roots) {
      for await (const lines of transcripts(root, pattern, 1500)) {
        const msgs = extractMessages(lines);
        expect(msgs.map((m) => m.index)).toEqual(msgs.map((_, i) => i));
      }
    }
  });

  test('no harness extracts to zero across its whole corpus', async () => {
    // The bug this file exists for, stated generally: a harness whose every transcript
    // yields nothing is a dispatch gap, never real data.
    for (const [label, root, pattern] of [
      ['codex', CODEX_ROOT, '**/rollout-*.jsonl'],
      ['claude', CLAUDE_ROOT, '**/*.jsonl'],
    ] as const) {
      let files = 0;
      let total = 0;
      for await (const lines of transcripts(root, pattern, 800)) {
        files++;
        total += extractMessages(lines).length;
      }
      if (files === 0) continue;
      expect({ label, zero: total === 0 }).toEqual({ label, zero: false });
    }
  });
});

// ——— Pi topology ———
// The pi block follows the same differential-oracle convention as the Codex block
// above: fork/active-path expectations are recomputed from raw lines by an
// independent inline walk, never by calling buildPiTree — a tree bug must not be its
// own oracle.

/** Mirrors the parser's message-ness for the pi shape: a user/assistant message line
 *  whose text is non-empty. Injection-tag stripping is a Claude/Codex phenomenon and
 *  never fires on pi corpus text, so the oracle compares raw text. */
function piMessageText(d: Record<string, unknown>): { role: string; text: string } | null {
  let role: string | undefined;
  if (d.type === 'user') role = 'user';
  else if (d.type === 'message') {
    const m = d.message as Record<string, unknown> | undefined;
    const r = m?.role;
    if (r === 'user' || r === 'assistant') role = r;
  }
  if (!role) return null;
  const m = d.message as Record<string, unknown> | undefined;
  const content = m?.content;
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const b = c as Record<string, unknown>;
      if (b.type === 'text' || (role === 'user' && b.type === 'input_text')) {
        texts.push(typeof b.text === 'string' ? b.text : '');
      }
    }
  }
  return { role, text: texts.join(' ') };
}

interface OracleEntry {
  id: string;
  parentId: string | null;
  line: number;
  producesMessage: boolean;
}

/** Independent topology walk: entries, the active set, and each fork's subtree. */
function piTopology(lines: string[]): { entries: OracleEntry[]; active: Set<number>; forks: number[][] } {
  const entries: OracleEntry[] = [];
  lines.forEach((l, i) => {
    let d: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === 'object') d = v as Record<string, unknown>;
    } catch {
      return;
    }
    if (!d || typeof d.id !== 'string') return;
    const msg = piMessageText(d);
    entries.push({
      id: d.id,
      parentId: typeof d.parentId === 'string' ? d.parentId : null,
      line: i,
      producesMessage: msg !== null && msg.text.trim().length > 0,
    });
  });
  const byId = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!byId.has(e.id)) byId.set(e.id, i);
  });
  // The null-chain convention: null or unknown parentId chains to the preceding entry.
  const parentIdx = entries.map((e, i) => {
    const known = e.parentId !== null ? byId.get(e.parentId) : undefined;
    return known !== undefined ? known : i - 1;
  });
  const active = new Set<number>();
  for (let cur = entries.length - 1; cur >= 0 && !active.has(cur); cur = parentIdx[cur]!) active.add(cur);
  const children = new Map<number, number[]>();
  parentIdx.forEach((p, i) => {
    if (p < 0) return;
    const kids = children.get(p);
    if (kids) kids.push(i);
    else children.set(p, [i]);
  });
  // Fork heads: abandoned entries whose parent is ON the active path. A fork head's
  // whole subtree is abandoned, and /tree re-entry means one fork's subtree can span
  // several disjoint runs in file order — hence full subtree collection, not runs.
  const forks: number[][] = [];
  entries.forEach((_, i) => {
    if (active.has(i)) return;
    const p = parentIdx[i]!;
    if (p < 0 || !active.has(p)) return;
    const members: number[] = [];
    const seen = new Set<number>();
    const stack = [i];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      members.push(c);
      for (const k of children.get(c) ?? []) stack.push(k);
    }
    forks.push(members.sort((a, b) => a - b));
  });
  return { entries, active, forks };
}

describeCorpus('live corpus — pi', () => {
  test('every pi file with the id/parentId shape builds a tree without throwing', async () => {
    let files = 0;
    for await (const lines of transcripts(PI_ROOT, '**/*.jsonl', 5000)) {
      files++;
      // Detection is shape-based: a file carrying id+parentId lines must be recognized.
      const hasTreeShape = lines.slice(0, 20).some((l) => {
        try {
          const d = JSON.parse(l);
          return d && typeof d.id === 'string' && 'parentId' in d;
        } catch {
          return false;
        }
      });
      const tree = buildPiTree(lines); // must not throw, whatever the file holds
      if (hasTreeShape) expect(tree).not.toBeNull();
    }
    if (files === 0) return; // no pi corpus on this machine
  });

  test('declared parentIds reference an earlier entry or are null (append-only invariant)', async () => {
    // This is what makes the defensive "unknown parentId → chain to preceding" path
    // dead code on the real corpus. If a pi version ever writes a forward or dangling
    // reference, this fails and that path stops being theoretical.
    let files = 0;
    for await (const lines of transcripts(PI_ROOT, '**/*.jsonl', 5000)) {
      files++;
      const seen = new Set<string>();
      for (const l of lines) {
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(l);
        } catch {
          continue;
        }
        if (!d || typeof d.id !== 'string') continue;
        if (typeof d.parentId === 'string') expect(seen.has(d.parentId)).toBe(true);
        seen.add(d.id);
      }
    }
    if (files === 0) return;
  });

  test('branch labels and fork markers match an independent topology walk', async () => {
    let files = 0;
    let branched = 0;
    for await (const lines of transcripts(PI_ROOT, '**/*.jsonl', 5000)) {
      files++;
      const { entries, active, forks } = piTopology(lines);
      const msgs = extractMessages(lines);
      if (forks.length === 0) {
        // No-op purity: unbranched sessions gain no metadata at all.
        for (const m of msgs) {
          expect(m.branch).toBeUndefined();
          expect(m.fork).toBeUndefined();
        }
        continue;
      }
      branched++;
      // Every abandoned message line, and only those, is labeled.
      const expectedAbandoned = entries.filter((e, i) => !active.has(i) && e.producesMessage).length;
      expect(msgs.filter((m) => m.branch === 'abandoned')).toHaveLength(expectedAbandoned);
      // Exactly the forks with at least one extracted message carry a marker — a fork
      // whose subtree holds no messages (the real corpus has custom-only subtrees) has
      // nothing to hang one on. The marker's abandonedCount is the branch's MESSAGE
      // count, and interleaved runs (one fork, several disjoint runs) still count once.
      const expectedCounts = forks
        .map((members) => members.filter((m) => entries[m]!.producesMessage))
        .filter((ms) => ms.length > 0)
        .map((ms) => ({ count: ms.length, firstLine: entries[ms[0]!]!.line }))
        .sort((a, b) => a.firstLine - b.firstLine);
      const markers = msgs.filter((m) => m.fork);
      expect(markers.map((m) => m.fork!.abandonedCount)).toEqual(expectedCounts.map((c) => c.count));
    }
    if (files === 0) return;
    // The corpus has branched files today; zero here means the walk broke, not the data.
    expect(branched).toBeGreaterThan(0);
  });

  test('no substantive pi transcript extracts to zero', async () => {
    // The pi equivalent of the "no harness extracts to zero" guard: a file carrying at
    // least one user/assistant message line must yield messages.
    let files = 0;
    let substantive = 0;
    for await (const lines of transcripts(PI_ROOT, '**/*.jsonl', 5000)) {
      files++;
      const hasMessage = lines.some((l) => {
        try {
          const m = piMessageText(JSON.parse(l));
          return m !== null && m.text.trim().length > 0;
        } catch {
          return false;
        }
      });
      if (!hasMessage) continue;
      substantive++;
      expect(extractMessages(lines).length).toBeGreaterThan(0);
    }
    if (files === 0) return;
    expect(substantive).toBeGreaterThan(0);
  });
});
