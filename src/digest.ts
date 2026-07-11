import { basename } from 'node:path';
import { extractMessages, stripInsightFences } from './parser';
import { resolveSessionFile } from './cache';
import { isOpencodePath, readSessionLines } from './opencode';

export interface DigestExchange {
  /** Message index of the user turn — feeds get_session_messages(offset). */
  index: number;
  /** Genuine user turn, stripped + truncated. */
  user: string;
  /** Last assistant text of the exchange (stripped + truncated); '' if none. */
  assistant: string;
}

export interface SessionDigest {
  messageCount: number;
  /** Exchange count before elision. */
  exchangeCount: number;
  exchanges: DigestExchange[];
  /** Exchanges removed from the middle to fit the budget. */
  elided: number;
}

/** Hard cap on the serialized digest (~2k tokens) — one bounded call, no knobs. */
export const DIGEST_MAX_CHARS = 8000;
/** Per-field truncation caps — starting points per spec, tuned against the budget test. */
export const USER_MAX = 200;
export const ASSISTANT_MAX = 300;

/** Collapse whitespace and truncate at a word boundary, marking cuts with an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Only back up to the boundary when it doesn't cost too much of the field.
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * The arc of one session: every genuine human turn paired with the last
 * assistant text of its exchange (outcome, not narration — the same tradeoff
 * closingMessages makes session-level). Non-genuine user turns (injected skill
 * bodies, hook context) neither start exchanges nor appear; they only consume
 * message indices. The serialized digest is elided from the middle — never the
 * head or tail — until it fits DIGEST_MAX_CHARS.
 */
export function buildSessionDigest(lines: string[]): SessionDigest {
  const messages = extractMessages(lines);

  const all: DigestExchange[] = [];
  let open: DigestExchange | null = null;
  const close = (): void => {
    if (!open) return;
    all.push({
      index: open.index,
      user: clip(open.user, USER_MAX),
      assistant: clip(stripInsightFences(open.assistant), ASSISTANT_MAX),
    });
    open = null;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.genuine) {
        close();
        open = { index: m.index, user: m.text, assistant: '' };
      }
    } else if (open) {
      open.assistant = m.text; // last assistant before the next boundary wins
    }
  }
  close();

  // Head+tail elision: keep k exchanges split as head = ceil(k/2), tail =
  // floor(k/2) (renderDigestMarkdown recomputes this split to place its
  // marker), shrinking k until the compact serialization fits the budget.
  // Field caps guarantee ~14 exchanges always fit, so head+tail both survive.
  const candidate = (k: number): SessionDigest => {
    const tailLen = Math.floor(k / 2);
    return {
      messageCount: messages.length,
      exchangeCount: all.length,
      exchanges: [...all.slice(0, Math.ceil(k / 2)), ...(tailLen === 0 ? [] : all.slice(all.length - tailLen))],
      elided: all.length - k,
    };
  };

  let digest = candidate(all.length);
  if (JSON.stringify(digest).length > DIGEST_MAX_CHARS) {
    // Largest k that fits, by binary search — each kept exchange adds more
    // serialized length than the shrinking `elided` digits remove, so length
    // is monotone in k. k = 1 always fits given the field caps.
    let lo = 1;
    let hi = all.length - 1;
    digest = candidate(1);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = candidate(mid);
      if (JSON.stringify(c).length <= DIGEST_MAX_CHARS) {
        digest = c;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }
  return digest;
}

/** Render a digest as compact markdown: one `**user** → assistant` block per exchange. */
export function renderDigestMarkdown(digest: SessionDigest, label: string): string {
  const out: string[] = [];
  out.push(`# Session digest: ${label}`);
  const elided = digest.elided > 0 ? ` · ${digest.elided} elided` : '';
  out.push(`\n_${digest.messageCount} messages · ${digest.exchangeCount} exchanges${elided}_\n`);

  if (digest.exchanges.length === 0) {
    out.push('No genuine user turns found in this session.');
    return out.join('\n') + '\n';
  }

  const headLen = Math.ceil(digest.exchanges.length / 2);
  digest.exchanges.forEach((ex, i) => {
    if (digest.elided > 0 && i === headLen) out.push(`_… ${digest.elided} exchanges elided …_\n`);
    out.push(`**[${ex.index}] user:** ${ex.user}`);
    if (ex.assistant) out.push(`**assistant:** ${ex.assistant}`);
    out.push('');
  });
  // Unreachable with current field caps (a lone kept exchange), but never lose the marker.
  if (digest.elided > 0 && headLen >= digest.exchanges.length) out.push(`_… ${digest.elided} exchanges elided …_\n`);

  return out.join('\n');
}

// ——— CLI: `sessions digest <session>` ———

export interface DigestArgs {
  /** A session JSONL file path, or an indexed session id. */
  target: string;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions digest — the arc of one session as compact markdown

Prints every genuine user turn paired with the exchange's final assistant
reply, bounded to ~8k chars (long sessions elide middle exchanges, keeping
the opening intent and closing state). Each exchange carries its message
index for targeted expansion via get_session_messages.

Usage:
  sessions digest <file-path>      Digest a session JSONL file
  sessions digest <session-id>     Resolve an indexed session id (newest match)

Options:
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseDigestArgs(argv: string[]): DigestArgs {
  let target = '';
  for (const a of argv) {
    if (a === '-h' || a === '--help') help();
    else if (a.startsWith('-')) die(`unknown option: ${a}`);
    else if (target) die('expected exactly one <session> argument');
    else target = a;
  }
  if (!target) die('usage: sessions digest <file-path | session-id>');
  return { target };
}

export async function runDigest(args: DigestArgs): Promise<void> {
  let filePath = args.target;
  // OpenCode paths are synthetic (dbPath/sessionId), so exists() is false — resolve
  // by id only for real, missing files; a query-string target still resolves below.
  if (!isOpencodePath(filePath) && !(await Bun.file(filePath).exists())) {
    const resolved = await resolveSessionFile(args.target);
    if (!resolved) die(`no session matching ${args.target} — try \`sessions <query>\` to find it`);
    filePath = resolved;
  }

  const lines = readSessionLines(filePath);
  if (lines.length === 0) die(`could not read ${filePath}`);

  const digest = buildSessionDigest(lines);
  const md = renderDigestMarkdown(digest, basename(filePath));
  process.stdout.write(md.endsWith('\n') ? md : md + '\n');
}
