import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linkPiSkills, unlinkPiSkills, installedSkills } from './setup';
import { PLUGIN_FILES } from './plugin-files';
import { splitFrontmatter } from './skill-frontmatter';

let tmp: string;
let pluginSkills: string;
let piSkills: string;

function writeSkill(dir: string, name: string, description: string): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n${description}\n---\n\n# ${name}\n`);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-setup-'));
  pluginSkills = join(tmp, 'plugin', 'skills');
  piSkills = join(tmp, 'pi', 'skills');
  writeSkill(pluginSkills, 'why', 'description: >-\n  Explain why code exists.\n  More trigger text follows.');
  writeSkill(pluginSkills, 'recall', 'description: Recall past sessions.');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('linkPiSkills', () => {
  test('links every plugin skill into the pi skills dir', () => {
    const results = linkPiSkills(piSkills, pluginSkills);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['recall', 'linked'],
      ['why', 'linked'],
    ]);
    for (const name of ['why', 'recall']) {
      const dest = join(piSkills, name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(pluginSkills, name));
    }
  });

  test('is idempotent and refuses to clobber a hand-written skill', () => {
    // Second run: our own links report unchanged.
    expect(linkPiSkills(piSkills, pluginSkills).every((r) => r.status === 'unchanged')).toBe(true);

    // A real directory with a colliding name is refused, not replaced.
    mkdirSync(join(piSkills, 'memory'), { recursive: true });
    writeFileSync(join(piSkills, 'memory', 'SKILL.md'), 'mine');
    writeSkill(pluginSkills, 'memory', 'description: ours.');
    const results = linkPiSkills(piSkills, pluginSkills);
    expect(results.find((r) => r.name === 'memory')?.status).toBe('refused');
    expect(lstatSync(join(piSkills, 'memory')).isSymbolicLink()).toBe(false);
  });
});

describe('unlinkPiSkills', () => {
  test('removes only links that point into the plugin skills dir', () => {
    const removed = unlinkPiSkills(piSkills, pluginSkills);
    expect(removed.sort()).toEqual(['recall', 'why']);
    expect(existsSync(join(piSkills, 'why'))).toBe(false);
    // The refused hand-written skill survives uninstall.
    expect(existsSync(join(piSkills, 'memory', 'SKILL.md'))).toBe(true);
  });
});

test('bundles instruction-review alongside session-reflect and their checks for setup discovery and Pi links', () => {
  const bundledSkills = join(tmp, 'review-plugin', 'skills');
  const linksDir = join(tmp, 'review-pi');
  const skills = [
    { name: 'instruction-review', description: 'Propose evidence-backed improvements to repository instructions using sessions history.' },
    { name: 'session-reflect', description: 'Reflect on how you work with AI coding agents using sessions history.' },
  ];

  for (const { name } of skills) {
    const skillDir = join(bundledSkills, name);
    mkdirSync(skillDir, { recursive: true });
    for (const file of ['SKILL.md', 'tests.md']) {
      const embedded = PLUGIN_FILES[`skills/${name}/${file}`];
      expect(embedded).toBeDefined();
      const source = readFileSync(join(import.meta.dir, '..', 'plugin', 'skills', name, file), 'utf8');
      expect(embedded).toBe(source);
      if (file === 'SKILL.md') {
        expect(Bun.YAML.parse(splitFrontmatter(source).frontmatter)).toMatchObject({ name });
      }
      writeFileSync(join(skillDir, file), embedded!);
    }
  }

  expect(installedSkills(bundledSkills)).toEqual(skills);
  expect(linkPiSkills(linksDir, bundledSkills)).toEqual(skills.map(({ name }) => ({ name, status: 'linked' })));
  for (const { name } of skills) {
    for (const file of ['SKILL.md', 'tests.md']) {
      expect(PLUGIN_FILES[`skills/${name}/${file}`]).toBe(readFileSync(join(linksDir, name, file), 'utf8'));
    }
  }
});

describe('installedSkills', () => {
  test('reads every skill from disk with the first sentence of its description', () => {
    const skills = installedSkills(pluginSkills);
    const why = skills.find((s) => s.name === 'why');
    // Folded scalar collapses to one line; only the first sentence is kept.
    expect(why?.description).toBe('Explain why code exists.');
    // A skill the old hardcoded list forgot still appears.
    expect(skills.map((s) => s.name)).toContain('recall');
  });
});
