/**
 * Editorial ordering and one-line summaries for the bundled skills.
 *
 * As with the MCP tools, the names and the trigger phrases are read from
 * plugin/skills/ * /SKILL.md at build time; only the ordering and the "what you
 * walk away with" line are authored. The join throws when the two disagree,
 * because the page states a skill count in prose.
 */
import { readSkills, triggerPhrases, type Skill } from '../lib/skills';

const ORDER: { name: string; outcome: string }[] = [
  { name: 'context', outcome: 'Prior decisions, dead ends, and the thread you left open.' },
  { name: 'recall', outcome: 'The reasoning behind one past decision, without paging a transcript.' },
  { name: 'why', outcome: 'The sessions behind a file, line, or commit — and a resume command to reopen them.' },
  { name: 'standup', outcome: 'Yesterday and today as terse bullets you can paste into Slack.' },
  { name: 'weekly-summary', outcome: 'A structured week, then a nudge toward any new memory worth keeping.' },
  { name: 'session-metrics', outcome: 'Which tool you actually use, and the hours you actually work.' },
  { name: 'memory', outcome: 'A mined batch clustered and triaged — approve, reject, or snooze each one.' },
];

export interface JoinedSkill extends Skill {
  outcome: string;
  phrases: string[];
}

export function skillList(): JoinedSkill[] {
  const shipped = readSkills();
  const byName = new Map(shipped.map((skill) => [skill.name, skill]));
  const claimed = new Set<string>();

  const ordered = ORDER.map((entry) => {
    const skill = byName.get(entry.name);
    if (!skill) {
      throw new Error(
        `site/src/data/skills.ts lists a skill "${entry.name}" that plugin/skills/ no longer ships. ` +
          `Shipped skills: ${shipped.map((s) => s.name).join(', ')}`,
      );
    }
    claimed.add(entry.name);
    return { ...skill, outcome: entry.outcome, phrases: triggerPhrases(skill) };
  });

  const undocumented = shipped.filter((skill) => !claimed.has(skill.name));
  if (undocumented.length > 0) {
    throw new Error(
      `plugin/skills/ ships ${undocumented.map((s) => s.name).join(', ')}, which the site does not list. ` +
        'Add an entry to site/src/data/skills.ts.',
    );
  }

  return ordered;
}
