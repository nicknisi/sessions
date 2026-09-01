import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { C } from './colors';
import { PLUGIN_FILES } from './plugin-files';
import { enableSessionHook, disableSessionHook } from './hooks';
import { getDataDir, getHome } from './paths';
import { splitFrontmatter, frontmatterDescription } from './skill-frontmatter';
import {
  cleanDeadConfigs,
  codexManualBlock,
  detectClients,
  unwireCodex,
  unwireJsonClient,
  wireCodex,
  wireJsonClient,
  type McpClient,
  type WireResult,
} from './mcp-config';

/** The sessions data dir. Single source of truth is getDataDir() — the memory store
 *  lives in the same directory, and the two must never disagree about where it is. */
function sessionsDir(): string {
  return getDataDir();
}
function pluginDest(): string {
  return join(sessionsDir(), 'plugin');
}
/**
 * The only paths the installer creates inside the data dir. Uninstall removes
 * exactly these — NOT the directory itself.
 *
 * The data dir also holds memory.db, whose approve/reject/snooze rows are human
 * judgments no re-mine can reconstruct. `sessions cleanup` routes through
 * runUninstall() (index.ts:28-34), so an `rm -rf` of the whole directory would
 * silently destroy every triage decision the user ever made — the same disposability
 * assumption that is correct for index.db and wrong here.
 */
function ownedInstallPaths(): string[] {
  return [pluginDest(), join(sessionsDir(), '.claude-plugin')];
}
const PLUGIN_VERSION = '1.29.2'; // x-release-please-version
const MARKETPLACE_NAME = 'sessions';
const PLUGIN_NAME = 'sessions';

function findPluginSource(): string {
  const candidates = [
    join(dirname(Bun.main), 'plugin'),
    join(dirname(Bun.main), '..', 'plugin'),
    join(dirname(Bun.main), '..', 'share', 'sessions', 'plugin'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, '.mcp.json'))) return c;
  }
  return '';
}

function installPluginFromDisk(source: string): boolean {
  try {
    mkdirSync(dirname(pluginDest()), { recursive: true });
    cpSync(source, pluginDest(), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function installPluginFromEmbed(): boolean {
  try {
    mkdirSync(dirname(pluginDest()), { recursive: true });
    for (const [relPath, content] of Object.entries(PLUGIN_FILES)) {
      const dest = join(pluginDest(), relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return true;
  } catch {
    return false;
  }
}

function writeMarketplaceJson(): void {
  const marketplace = {
    name: MARKETPLACE_NAME,
    owner: { name: 'Nick Nisi', email: 'nick@nisi.org' },
    metadata: { description: 'Skills for summarizing and recalling AI coding sessions', version: PLUGIN_VERSION },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: './plugin',
        description: 'Weekly summaries, standups, recall, and metrics for AI coding sessions.',
      },
    ],
  };
  const dir = join(sessionsDir(), '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
}

function installPlugin(): boolean {
  const source = findPluginSource();
  const ok = source ? installPluginFromDisk(source) : installPluginFromEmbed();
  if (ok) writeMarketplaceJson();
  return ok;
}

// ——— Pi skills ———
//
// Pi has no plugin marketplace: it discovers skills as <skillsDir>/<name>/SKILL.md and
// its MCP list in mcp.json. Setup wired only the MCP entry, so Pi got the tools without
// the skills that carry their procedures. The bridge is one symlink per skill into Pi's
// skills dir — links, not copies, so an upgraded plugin never leaves stale skills behind.

function piSkillsDir(): string {
  return join(getHome(), '.pi', 'agent', 'skills');
}

export interface SkillLink {
  name: string;
  status: 'linked' | 'unchanged' | 'refused';
}

interface InstalledSkill {
  name: string;
  description: string;
}

/** The description's first sentence, folded — enough for a list; the rest is trigger text. */
function firstSentence(description: string): string {
  const m = /^.+?\.(?=\s|$)/.exec(description);
  return m ? m[0] : description;
}

/** Every skill the plugin ships, read from the just-installed copy with its frontmatter
 *  description — the SKILL.md set is the source of truth, so a new skill appears here
 *  without a setup.ts edit. */
export function installedSkills(skillsRoot = join(pluginDest(), 'skills')): InstalledSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const out: InstalledSkill[] = [];
  for (const name of readdirSync(skillsRoot).sort()) {
    try {
      if (!statSync(join(skillsRoot, name)).isDirectory()) continue;
      const raw = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
      const { frontmatter } = splitFrontmatter(raw);
      out.push({ name, description: firstSentence(frontmatterDescription(frontmatter)) });
    } catch {
      out.push({ name, description: '' });
    }
  }
  return out;
}

function isOurLink(dest: string, source: string): boolean {
  try {
    return lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === source;
  } catch {
    return false;
  }
}

/** Link each plugin skill into Pi's skills dir. An existing entry that is not already
 *  our link (a hand-written skill with the same name) is refused, never clobbered. */
export function linkPiSkills(skillsDir = piSkillsDir(), pluginSkills = join(pluginDest(), 'skills')): SkillLink[] {
  if (!existsSync(pluginSkills)) return [];
  mkdirSync(skillsDir, { recursive: true });
  const results: SkillLink[] = [];
  for (const name of readdirSync(pluginSkills).sort()) {
    const source = join(pluginSkills, name);
    if (!statSync(source).isDirectory()) continue;
    const dest = join(skillsDir, name);
    if (lstatSync(dest, { throwIfNoEntry: false })) {
      results.push({ name, status: isOurLink(dest, source) ? 'unchanged' : 'refused' });
      continue;
    }
    symlinkSync(source, dest, 'dir');
    results.push({ name, status: 'linked' });
  }
  return results;
}

/** Remove only links that point into our plugin skills dir; anything else stays. */
export function unlinkPiSkills(skillsDir = piSkillsDir(), pluginSkills = join(pluginDest(), 'skills')): string[] {
  if (!existsSync(skillsDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const dest = join(skillsDir, name);
    try {
      if (!lstatSync(dest).isSymbolicLink()) continue;
      const target = readlinkSync(dest);
      if (target !== join(pluginSkills, name) && !target.startsWith(pluginSkills + sep)) continue;
      rmSync(dest);
      removed.push(name);
    } catch {}
  }
  return removed;
}

function sessionsCommand(): string {
  try {
    const result = Bun.spawnSync(['which', 'sessions']);
    const path = new TextDecoder().decode(result.stdout).trim();
    if (path) return path;
  } catch {}
  return 'sessions';
}

/**
 * Write the MCP entry into the file this client actually reads.
 *
 * Claude Code has no config of its own here: its server arrives with the plugin, which
 * is also the reason the old dotfile bug went unnoticed for so long — the one client
 * most likely to be tested worked through a path setup never touched.
 */
function wire(client: McpClient): WireResult {
  if (!client.configPath) return { status: 'unchanged' };
  const cmd = sessionsCommand();
  return client.id === 'codex' ? wireCodex(client.configPath, cmd) : wireJsonClient(client.configPath, client.id, cmd);
}

function unwire(client: McpClient): WireResult {
  if (!client.configPath) return { status: 'unchanged' };
  return client.id === 'codex' ? unwireCodex(client.configPath) : unwireJsonClient(client.configPath);
}

function runClaude(...args: string[]): boolean {
  try {
    const result = Bun.spawnSync(['claude', 'plugins', ...args], { stderr: 'pipe', stdout: 'pipe' });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

interface PluginRegistration {
  marketplace: boolean;
  install: boolean;
}

function registerClaudePlugin(): PluginRegistration {
  const marketplace = runClaude('marketplace', 'add', sessionsDir());
  const install = runClaude('install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  return { marketplace, install };
}

function unregisterClaudePlugin(): void {
  runClaude('uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  runClaude('marketplace', 'remove', MARKETPLACE_NAME);
}

export interface SetupOptions {
  /** Explicitly enable the SessionStart auto-injection hook (default: off). */
  hooks?: boolean;
}

/**
 * Decide whether to enable the SessionStart hook. Default is OFF: auto-injection
 * costs tokens on every session, so it is never enabled silently.
 *  - `--hooks` → enable.
 *  - no flag + TTY → ask once (default no).
 *  - no flag + non-TTY → leave off.
 */
function shouldEnableHook(opts: SetupOptions): boolean {
  if (opts.hooks) return true;
  if (!process.stdin.isTTY) return false;

  process.stderr.write(
    `\n  ${C.bold}Auto-inject a context primer at session start?${C.reset}\n` +
      `  ${C.dim}Runs \`sessions context --hook\` on every Claude Code session start.${C.reset}\n` +
      `  ${C.dim}Costs a small number of tokens each session. Reversible via \`sessions uninstall\`.${C.reset}\n` +
      `  ${C.dim}Enable? [y/N] ${C.reset}`,
  );
  const answer = (prompt('') ?? '').trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export function runSetup(opts: SetupOptions = {}): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}sessions setup${C.reset}\n\n`);

  if (installPlugin()) {
    w(`  ${C.green}✓${C.reset} Plugin installed to ${C.dim}${pluginDest()}${C.reset}\n`);
  } else {
    w(`  ${C.red}✗${C.reset} Failed to install plugin to ${pluginDest()}\n`);
    process.exit(1);
  }

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config ${C.dim}${path}${C.reset}\n`);
  }

  const detected = detectClients().filter((t) => t.detected);

  if (detected.length === 0) {
    w(`\n  ${C.dim}No AI tools detected. Install Claude Code, Cursor, Codex, or Pi first.${C.reset}\n\n`);
    process.exit(0);
  }

  for (const tool of detected) {
    // Report what the write actually did. The previous version printed a checkmark for
    // every client whose file it managed to create, including three no client reads.
    const res = wire(tool);
    if (res.status === 'added') {
      w(
        `  ${C.green}✓${C.reset} MCP server added to ${C.dim}${tool.name}${C.reset} ${C.dim}(${tool.configPath})${C.reset}\n`,
      );
    } else if (res.status === 'unchanged' && tool.configPath) {
      w(`  ${C.dim}ℹ${C.reset} MCP server already configured for ${C.dim}${tool.name}${C.reset}\n`);
    } else if (res.status === 'refused') {
      w(`  ${C.yellow}!${C.reset} Left ${C.dim}${tool.configPath}${C.reset} alone — ${res.reason}\n`);
      if (tool.id === 'codex') {
        w(`  ${C.dim}  Add this yourself:${C.reset}\n`);
        for (const line of codexManualBlock(sessionsCommand()).split('\n')) w(`  ${C.dim}    ${line}${C.reset}\n`);
      }
    } else if (res.status === 'failed') {
      w(`  ${C.red}✗${C.reset} Failed to configure MCP for ${tool.name} — ${res.reason}\n`);
    }

    if (tool.id === 'claude') {
      const result = registerClaudePlugin();
      if (result.marketplace) {
        w(`  ${C.green}✓${C.reset} Marketplace added to ${C.dim}${tool.name}${C.reset}\n`);
      } else {
        w(`  ${C.dim}ℹ${C.reset} Marketplace already registered with ${C.dim}${tool.name}${C.reset}\n`);
      }
      if (result.install) {
        w(`  ${C.green}✓${C.reset} Plugin installed in ${C.dim}${tool.name}${C.reset}\n`);
      } else {
        w(`  ${C.dim}ℹ${C.reset} Plugin already installed in ${C.dim}${tool.name}${C.reset}\n`);
      }
    }

    if (tool.id === 'pi') {
      const links = linkPiSkills();
      const linked = links.filter((l) => l.status === 'linked').length;
      if (linked) {
        w(
          `  ${C.green}✓${C.reset} ${linked} skill${linked === 1 ? '' : 's'} linked into ${C.dim}Pi${C.reset} ${C.dim}(${piSkillsDir()})${C.reset}\n`,
        );
      } else if (links.length && links.every((l) => l.status === 'unchanged')) {
        w(`  ${C.dim}ℹ${C.reset} Skills already linked for ${C.dim}Pi${C.reset}\n`);
      }
      for (const r of links.filter((l) => l.status === 'refused')) {
        w(
          `  ${C.yellow}!${C.reset} Left ${C.dim}${join(piSkillsDir(), r.name)}${C.reset} alone — not a sessions link\n`,
        );
      }
    }
  }

  // SessionStart auto-injection hook — opt-in, Claude Code only for now.
  const claudeDetected = detected.some((t) => t.id === 'claude');
  if (claudeDetected && shouldEnableHook(opts)) {
    const res = enableSessionHook('claude');
    if (res.changed) {
      w(`  ${C.green}✓${C.reset} SessionStart auto-injection enabled for ${C.dim}Claude Code${C.reset}\n`);
    } else {
      w(`  ${C.dim}ℹ${C.reset} SessionStart auto-injection already enabled for ${C.dim}Claude Code${C.reset}\n`);
    }
    w(`  ${C.dim}  Disable any time with \`sessions uninstall\`.${C.reset}\n`);
  }

  // Only Claude Code (plugin) and Pi (symlinks) actually receive the skills; printing
  // this list to a Cursor/Codex-only user advertises skills they never got. The list is
  // read from the just-installed skills, not hardcoded — the hardcoded version already
  // shipped without /why once.
  const skills = installedSkills();
  if (detected.some((t) => t.id === 'claude' || t.id === 'pi') && skills.length) {
    w(`\n  ${C.bold}Skills available:${C.reset}\n`);
    const width = Math.max(...skills.map((s) => s.name.length));
    for (const s of skills) {
      w(`    ${C.cyan}/${s.name.padEnd(width)}${C.reset}  ${C.dim}${s.description}${C.reset}\n`);
    }
    w(`\n  ${C.dim}Run \`sessions setup\` again after upgrading to update skills.${C.reset}\n\n`);
  }
}

export function runUninstall(): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}sessions uninstall${C.reset}\n\n`);

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config ${C.dim}${path}${C.reset}\n`);
  }

  for (const tool of detectClients().filter((t) => t.detected)) {
    const res = unwire(tool);
    if (res.status === 'added') {
      w(`  ${C.green}✓${C.reset} Removed MCP config from ${C.dim}${tool.name}${C.reset}\n`);
    } else if (res.status === 'refused' || res.status === 'failed') {
      w(`  ${C.yellow}!${C.reset} Left ${C.dim}${tool.configPath}${C.reset} alone — ${res.reason}\n`);
    }

    if (tool.id === 'claude') {
      unregisterClaudePlugin();
      w(`  ${C.green}✓${C.reset} Removed plugin from ${C.dim}${tool.name}${C.reset}\n`);

      const res = disableSessionHook('claude');
      if (res.changed) {
        w(`  ${C.green}✓${C.reset} Removed SessionStart auto-injection from ${C.dim}${tool.name}${C.reset}\n`);
      }
    }

    if (tool.id === 'pi') {
      const removed = unlinkPiSkills();
      if (removed.length) {
        w(
          `  ${C.green}✓${C.reset} Removed ${removed.length} skill link${removed.length === 1 ? '' : 's'} from ${C.dim}Pi${C.reset}\n`,
        );
      }
    }
  }

  for (const path of removeInstalledFiles()) {
    w(`  ${C.green}✓${C.reset} Removed ${C.dim}${path}${C.reset}\n`);
  }

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}

/**
 * Delete the installer-owned subtrees of the data dir and return what was removed.
 *
 * Exported as the seam durability tests exercise: the rest of runUninstall talks to
 * the real ~/.claude config and shells out to `claude plugins uninstall`, so no test
 * may call it — but this is the only part that touches the data dir, and it must be
 * provably scoped to the two directories the installer created.
 */
export function removeInstalledFiles(): string[] {
  const removed: string[] = [];
  for (const path of ownedInstallPaths()) {
    if (!existsSync(path)) continue;
    try {
      require('node:fs').rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {}
  }
  return removed;
}
