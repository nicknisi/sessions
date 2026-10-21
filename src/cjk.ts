// CJK-aware lexical lane.
//
// The FTS tables tokenize with `porter unicode61`, which splits on anything that is
// not a letter or digit. Han, Kana and Hangul are letters, so a stretch of CJK text
// with no spaces is ONE token: searching 검색 cannot find 검색을, and 検索 cannot find
// 全文検索機能. Worse, a Latin word glued to CJK text (`React에서`, `Reactを使って`) is
// one token with it, so searching `React` misses it. SQLite's built-in `trigram`
// tokenizer does not help: it cannot answer a query shorter than three characters,
// and most Korean and Chinese words are two.
//
// So CJK text gets a second, sparse index (see message_cjk_fts / session_cjk_fts in
// cache.ts) holding overlapping two-character sequences — the standard CJK
// compromise, with no dictionary and no dependency. The primary tables and their
// queries are untouched, so a corpus without CJK text behaves byte-for-byte as
// before and CJK matching only ever adds hits.

const SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\u30FC]/u;
const LETTER = /[\p{L}\p{N}\p{M}]/u;

/** True when `text` contains at least one Han, Kana or Hangul letter. */
export function hasCjk(text: string): boolean {
  return SCRIPT.test(text);
}

interface Segment {
  cjk: boolean;
  text: string;
  /** No separator between this segment and the previous one. */
  glued: boolean;
}

/** Split into maximal runs of CJK letters and of other letters/digits. Everything
 *  else is a separator. NFKC first, so full-width Latin, half-width Kana and the
 *  decomposed Hangul macOS puts in file names match what a user types. */
function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let separated = true;
  for (const ch of text.normalize('NFKC')) {
    const isLetter = LETTER.test(ch);
    if (!isLetter) {
      separated = true;
      continue;
    }
    const cjk = SCRIPT.test(ch);
    const last = out[out.length - 1];
    if (last !== undefined && !separated && last.cjk === cjk) last.text += ch;
    else out.push({ cjk, text: ch, glued: !separated && last !== undefined });
    separated = false;
  }
  return out;
}

/** A non-CJK segment that touches CJK text, like `React` in `React에서`. */
function touchesCjk(segments: Segment[], i: number): boolean {
  const prev = segments[i - 1];
  const next = segments[i + 1];
  return (prev !== undefined && prev.cjk && segments[i]!.glued) || (next !== undefined && next.cjk && next.glued);
}

function bigrams(run: string): string[] {
  const chars = [...run];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/**
 * The text for a cjk index column: every overlapping character pair of each CJK run,
 * the Latin words glued to CJK text, and — after everything else, so phrase
 * adjacency is never disturbed — the last character of each run, which is what lets
 * a one-character query find a character that ends a word. Empty when the text has
 * no CJK, which is what keeps the side tables sparse.
 */
export function cjkIndexText(text: string): string {
  if (!hasCjk(text)) return '';
  const segments = segment(text);
  const tokens: string[] = [];
  const tails = new Set<string>();
  segments.forEach((seg, i) => {
    if (!seg.cjk) {
      if (touchesCjk(segments, i)) tokens.push(seg.text);
      return;
    }
    const chars = [...seg.text];
    if (chars.length === 1) tokens.push(seg.text);
    else {
      tokens.push(...bigrams(seg.text));
      tails.add(chars[chars.length - 1]!);
    }
  });
  return [...tokens, ...tails].join(' ');
}

/** One query term as an expression over the cjk index. A term with no CJK is matched
 *  as is, which is how `React` finds `React에서`; a CJK run becomes a phrase of its
 *  pairs (a one-character run a prefix, which reaches every pair and tail it begins). */
function termExpression(term: string): string {
  const clean = term.replace(/['"]/g, '').trim();
  if (clean === '') return '';
  if (!hasCjk(clean)) return `"${clean}"`;
  const segments = segment(clean);
  const parts: string[] = [];
  segments.forEach((seg, i) => {
    if (!seg.cjk) {
      if (touchesCjk(segments, i)) parts.push(`"${seg.text}"`);
      return;
    }
    parts.push([...seg.text].length === 1 ? `"${seg.text}"*` : `"${bigrams(seg.text).join(' ')}"`);
  });
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
}

/** The OR-joined cjk-index query for already-split terms, or '' when none apply.
 *  Mirrors searchSessions' recall-first shape: any term may match, bm25 orders them. */
export function cjkQuery(terms: string[]): string {
  return terms
    .map(termExpression)
    .filter((e) => e !== '')
    .join(' OR ');
}

// # ponytail: fixed width; roughly the 32-token window snippet() gives English text.
const SNIPPET_CHARS = 100;

/** A display excerpt around the first query term found in `text`. FTS5's own snippet()
 *  cannot localize a hit that lives only in the cjk index (its tokens are character
 *  pairs, not text), so a CJK-only hit is excerpted here instead. Falls back to the
 *  start of the text when no term is found verbatim (e.g. a half-width spelling). */
export function cjkSnippet(text: string, terms: string[]): string {
  const hay = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = term === '' ? -1 : hay.indexOf(term.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let start = Math.max(0, at - SNIPPET_CHARS / 4);
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  // Never cut a surrogate pair in half (Han extension characters live outside the BMP).
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end++;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
