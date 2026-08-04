import type { Tool } from './types';
import { tryParse } from './extract-util';

/** Total cap on a session's custom context, mirroring MAX_THINKING_LEN — recaps run
 *  ~2k, so 20k is generous while a pathological extension cannot bloat the FTS row. */
export const MAX_CUSTOM_CONTEXT_LEN = 20_000;

/** web-search-results entries carry full page fetches; each URL's content is
 *  truncated so one fetched page cannot eat the whole per-session budget. */
const MAX_URL_CONTENT_LEN = 500;

/**
 * Searchable text from pi's `custom`/`custom_message` entries — extension injections
 * (recaps, web-search fetches, intercom messages), never conversation turns. Feeds the
 * session-level `context_text` FTS column only; the message view stays truthful to pi's
 * rendering and never sees this text.
 *
 * Inclusion is OPT-IN, not opt-out: `turn-duration` (timing noise, thousands of
 * occurrences, zero search value) and every unknown future customType are excluded by
 * default, so the next junk-writing extension cannot silently pollute the index. Note
 * web-search-results also has a `data.type: 'search'` sub-shape (`queries[]` of
 * query+answer); only the fetch sub-shape (`urls[]`) is indexed, per spec.
 *
 * Never throws: entries with missing data/content are skipped, collection continues.
 */
function collect(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const d = tryParse(line);
    if (!d) continue;
    if (d.type === 'custom') {
      const data = d.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      if (d.customType === 'recap') {
        if (typeof data.summary === 'string') parts.push(data.summary);
      } else if (d.customType === 'web-search-results') {
        const urls = data.urls;
        if (!Array.isArray(urls)) continue;
        for (const u of urls) {
          if (!u || typeof u !== 'object') continue;
          const entry = u as Record<string, unknown>;
          if (typeof entry.title === 'string') parts.push(entry.title);
          if (typeof entry.content === 'string') parts.push(entry.content.slice(0, MAX_URL_CONTENT_LEN));
        }
      }
      // turn-duration and unknown customTypes: excluded (opt-in inclusion).
    } else if (d.type === 'custom_message') {
      // Any customType — bounded by the 20k cap below. Content is a plain string.
      if (typeof d.content === 'string') parts.push(d.content);
    }
  }
  return parts.join('\n').slice(0, MAX_CUSTOM_CONTEXT_LEN);
}

/**
 * Custom-entry context for the session_fts `context_text` column. Pi only — other
 * tools write no custom/custom_message lines and return empty.
 */
export function extractCustomContext(lines: string[], tool: Tool): string {
  if (tool !== 'pi') return '';
  return collect(lines);
}
