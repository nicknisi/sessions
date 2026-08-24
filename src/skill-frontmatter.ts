import { asJsonObject, asJsonString, type JsonValue } from './extract-util';

/**
 * Split a leading `---`-delimited YAML frontmatter block off a skill body. Returns the whole
 * input as `body` when there is none, so a skill that loses its frontmatter still serves.
 */
export interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

export function splitFrontmatter(raw: string): FrontmatterSplit {
  if (!raw.startsWith('---\n')) return { frontmatter: '', body: raw };
  // Search from 3 so an empty block (`---\n---\n`) still terminates.
  const end = raw.indexOf('\n---\n', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  return { frontmatter: raw.slice(4, end + 1), body: raw.slice(end + 5) };
}

/** The skill's own `description`, lifted out of its frontmatter and folded to one line. */
export function frontmatterDescription(frontmatter: string): string {
  try {
    // SAFETY: YAML is a JSON superset at the values we write here — simple
    // `key: value` frontmatter lines parse into the JSON domain.
    const parsed = asJsonObject(Bun.YAML.parse(frontmatter) as JsonValue);
    const description = asJsonString(parsed?.description);
    if (description !== undefined) {
      // Folded scalars (`description: >-`) arrive with hard newlines; a prompt description
      // is a single sentence in a picker.
      return description.replace(/\s+/g, ' ').trim();
    }
  } catch {
    // A malformed block is not worth refusing to serve the prompt over — the body is what
    // matters, and the description falls back to the registration-site sentence.
  }
  return '';
}
