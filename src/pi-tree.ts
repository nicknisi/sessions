import {
  tryParse,
  extractUserText,
  isGenuineUserTurn,
  isUserMessage,
  asJsonString,
  type JsonObject,
} from './extract-util';

export interface PiEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  lineIndex: number; // 0-based position in lines[]
}

export interface PiFork {
  /** lineIndex of the first entry of the abandoned branch */
  atLine: number;
  /** id of the entry the branch forked from (on the active path) */
  fromEntryId: string;
  /** number of ENTRIES in the abandoned branch — not messages. toolResult/custom
   *  entries and pure-toolCall assistant lines produce no extracted message, so the
   *  message-level count on the fork marker in parser.ts is usually smaller. */
  abandonedCount: number;
  /** first genuine user text in the abandoned branch, truncated, '' if none */
  firstUserText: string;
  timestamp: string;
  /**
   * Line indexes of every entry in the fork's abandoned subtree, in file order.
   * Additive to the original spec'd shape because a fork's subtree is NOT
   * necessarily contiguous in the file: /tree can re-enter and extend an abandoned
   * branch, so one fork's entries appear as several disjoint runs interleaved with
   * active-path entries (the 24-break corpus session is a single fork whose 54-entry
   * subtree spans 12 such runs). Annotation needs exact membership, not ranges.
   */
  lineIndexes: number[];
}

export interface PiTree {
  entries: PiEntry[];
  /** Set of entry ids on the active path (root → last leaf). */
  activeIds: Set<string>;
  forks: PiFork[];
}

/** Max length of a fork's firstUserText (bounds the annotation metadata). */
const FORK_TEXT_MAX = 80;

/**
 * How far in to look for the pi id/parentId shape. The session header is line 1 and
 * the header-adjacent model_change (which carries both `id` and `parentId: null`)
 * line 2 of every real pi file; the slack absorbs a truncated or blank-padded head.
 * Sniffing keeps this cheap on non-pi transcripts: buildPiTree runs once per
 * extractMessages call — including on multi-megabyte Claude logs during indexing —
 * and those must be rejected without a full parse.
 */
const PI_SNIFF_LINES = 20;

/**
 * The single authority on pi session topology.
 *
 * Pi session files are trees, not logs: every entry carries `id`/`parentId`, /tree
 * navigation leaves abandoned branches behind in the same append-only JSONL, and the
 * shared parser reads the file linearly — so without this, dead-branch exchanges
 * render inline as if they happened in the live conversation. buildPiTree parses the
 * entries, chains them by parentId, and computes the active path (root → final leaf)
 * plus the fork list: every abandoned entry whose parent sits ON the active path.
 *
 * Returns null for non-pi transcripts: detection requires a line with BOTH `id` and
 * `parentId` keys, a shape only pi writes (Claude uses uuid/parentUuid, Codex nests
 * under `payload` envelopes, OpenCode's reconstructed lines carry no id fields —
 * verified against ~2,700 Claude, 305 Codex, and the reconstructed-OpenCode shapes).
 *
 * Never throws: malformed lines are skipped, unknown parentIds fall back to the
 * null-chain convention, and a backlink cycle yields a fully-active, fork-free tree.
 */
export function buildPiTree(lines: string[]): PiTree | null {
  // Detection, on the sniff window only (see PI_SNIFF_LINES).
  let detected = false;
  const sniff = Math.min(lines.length, PI_SNIFF_LINES);
  for (let i = 0; i < sniff; i++) {
    const d = tryParse(lines[i] ?? '');
    if (d && asJsonString(d.id) !== undefined && 'parentId' in d) {
      detected = true;
      break;
    }
  }
  if (!detected) return null;

  // Pass 1: collect the id-bearing entries (every line of a real pi file has one).
  const parsed: (JsonObject | null)[] = [];
  const entries: PiEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const d = tryParse(lines[i] ?? '');
    parsed.push(d);
    const id = asJsonString(d?.id);
    if (!d || id === undefined) continue;
    entries.push({
      id,
      parentId: asJsonString(d.parentId) ?? null,
      type: asJsonString(d.type) ?? '',
      timestamp: asJsonString(d.timestamp),
      lineIndex: i,
    });
  }

  // Pass 2: resolve parents. Two conventions, both corpus-verified: a null parentId
  // (the header-adjacent model_change in EVERY pi file) chains to the preceding
  // entry, and an unknown parentId does the same (defensive — never observed). First
  // occurrence wins on duplicate ids, so a later duplicate cannot re-fork.
  const byId = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!byId.has(e.id)) byId.set(e.id, i);
  });
  const parentIdx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i]!.parentId;
    const known = p !== null ? byId.get(p) : undefined;
    parentIdx.push(known !== undefined ? known : i - 1); // -1 on the first entry: the root
  }

  // Pass 3: the active path — parent backlinks from the final entry (the current
  // leaf) to the root. The visited-set guards against a corrupt cycle (A.parent=B,
  // B.parent=A): a cyclic file is treated as fully active, with no forks, rather
  // than looping forever.
  const activeIdx = new Set<number>();
  let cur = entries.length - 1;
  while (cur >= 0 && !activeIdx.has(cur)) {
    activeIdx.add(cur);
    cur = parentIdx[cur]!;
  }
  const activeIds = new Set<string>();
  if (cur >= 0) {
    for (const e of entries) activeIds.add(e.id);
    return { entries, activeIds, forks: [] };
  }
  for (const i of activeIdx) activeIds.add(entries[i]!.id);

  // Pass 4: forks. A fork head is an abandoned entry whose resolved parent is ON the
  // active path; abandoned entries whose parent is also abandoned are continuations
  // of an existing branch, not new forks (two raw topology breaks per /tree
  // abandonment: the fork-out AND the fork-back).
  const childIdx = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const p = parentIdx[i]!;
    if (p < 0) continue;
    const kids = childIdx.get(p);
    if (kids) kids.push(i);
    else childIdx.set(p, [i]);
  }
  const forks: PiFork[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (activeIdx.has(i)) continue;
    const p = parentIdx[i]!;
    if (p < 0 || !activeIdx.has(p)) continue;
    // A fork head's whole subtree is abandoned: an active descendant would put the
    // head itself on the active path.
    const members: number[] = [];
    const seen = new Set<number>();
    const stack = [i];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      members.push(c);
      for (const k of childIdx.get(c) ?? []) stack.push(k);
    }
    members.sort((a, b) => a - b);
    // First genuine human text in the branch, under the same rules the parser
    // applies to user turns, so injected/skill-preamble text never labels a fork.
    let firstUserText = '';
    for (const m of members) {
      const d = parsed[entries[m]!.lineIndex];
      if (!d || !isUserMessage(d)) continue;
      const text = extractUserText(d).trim();
      if (!text || !isGenuineUserTurn(d, text)) continue;
      firstUserText = text.length > FORK_TEXT_MAX ? text.slice(0, FORK_TEXT_MAX) : text;
      break;
    }
    forks.push({
      atLine: entries[i]!.lineIndex,
      fromEntryId: entries[p]!.id,
      abandonedCount: members.length,
      firstUserText,
      timestamp: entries[i]!.timestamp ?? '',
      lineIndexes: members.map((m) => entries[m]!.lineIndex),
    });
  }
  return { entries, activeIds, forks };
}
