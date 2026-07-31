/**
 * The six bundled skills, read out of plugin/skills/ * /SKILL.md at build time.
 *
 * A skill's `description` frontmatter is its trigger contract — the sentences an
 * agent matches a user's phrasing against. That is genuinely the most useful
 * thing to show a reader ("say any of this and it fires"), and it is also the
 * field most likely to be tuned between releases, so it is read rather than
 * retyped. The site quotes the trigger phrases straight out of it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoPath } from './repo';

export interface Skill {
  /** Directory name and slash-command name, e.g. `weekly-summary`. */
  name: string;
  /** The full trigger description from frontmatter. */
  description: string;
  /** `argument-hint`, when the skill takes one. */
  argumentHint: string | null;
}

/**
 * Pull the quoted phrases out of a trigger description.
 *
 * Every skill's description follows the same convention — 'Use when the user
 * says "standup", "what did I do yesterday"…' — so the quoted spans are the
 * literal things a person types. Showing those beats showing the paragraph.
 */
export function triggerPhrases(skill: Skill, limit = 4): string[] {
  const quoted = skill.description.match(/[“"]([^”"]{2,60})[”"]/g) ?? [];
  return quoted.map((q) => q.slice(1, -1).replace(/\s+/g, ' ').trim()).slice(0, limit);
}

export function readSkills(): Skill[] {
  const dir = repoPath('plugin', 'skills');
  if (!existsSync(dir)) {
    throw new Error(`the site reads the bundled skills from ${dir} at build time, but it does not exist`);
  }

  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;

    const raw = readFileSync(file, 'utf8');
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) {
      throw new Error(`plugin/skills/${entry.name}/SKILL.md has no YAML frontmatter`);
    }

    const meta = parse(frontmatter[1]!) as Record<string, unknown>;
    if (typeof meta.name !== 'string' || typeof meta.description !== 'string') {
      throw new Error(`plugin/skills/${entry.name}/SKILL.md frontmatter needs a string name and description`);
    }
    if (meta.name !== entry.name) {
      // The slash command is the directory name; a frontmatter name that
      // disagrees would put a command on the page that nobody can invoke.
      throw new Error(
        `plugin/skills/${entry.name}/SKILL.md declares name "${meta.name}" but lives in "${entry.name}"`,
      );
    }

    skills.push({
      name: meta.name,
      description: meta.description.replace(/\s+/g, ' ').trim(),
      argumentHint: typeof meta['argument-hint'] === 'string' ? meta['argument-hint'] : null,
    });
  }

  if (skills.length === 0) {
    throw new Error('found no SKILL.md files under plugin/skills/');
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
