import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { C } from './colors';
import { PLUGIN_FILES } from './plugin-files';
import { enableSessionHook, disableSessionHook } from './hooks';

const home = homedir();
const SESSIONS_DIR = join(home, '.local', 'share', 'sessions');
const PLUGIN_DEST = join(SESSIONS_DIR, 'plugin');
const PLUGIN_VERSION = '1.0.0';
const MARKETPLACE_NAME = 'sessions';
const PLUGIN_NAME = 'sessions';

interface ToolConfig {
  name: string;
  detected: boolean;
  mcpConfigPath: string;
}

function detectTools(): ToolConfig[] {
  return [
    {
      name: 'Claude Code',
      detected: existsSync(join(home, '.claude')),
      mcpConfigPath: join(home, '.claude', '.mcp.json'),
    },
    {
      name: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      mcpConfigPath: join(home, '.cursor', '.mcp.json'),
    },
    {
      name: 'Codex',
      detected: existsSync(join(home, '.codex')),
      mcpConfigPath: join(home, '.codex', '.mcp.json'),
    },
  ];
}

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
    mkdirSync(dirname(PLUGIN_DEST), { recursive: true });
    cpSync(source, PLUGIN_DEST, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function installPluginFromEmbed(): boolean {
  try {
    mkdirSync(dirname(PLUGIN_DEST), { recursive: true });
    for (const [relPath, content] of Object.entries(PLUGIN_FILES)) {
      const dest = join(PLUGIN_DEST, relPath);
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
  const dir = join(SESSIONS_DIR, '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
}

function installPlugin(): boolean {
  const source = findPluginSource();
  const ok = source ? installPluginFromDisk(source) : installPluginFromEmbed();
  if (ok) writeMarketplaceJson();
  return ok;
}

function sessionsCommand(): string {
  try {
    const result = Bun.spawnSync(['which', 'sessions']);
    const path = new TextDecoder().decode(result.stdout).trim();
    if (path) return path;
  } catch {}
  return 'sessions';
}

function configureMcp(tool: ToolConfig): boolean {
  try {
    const cmd = sessionsCommand();
    let config: Record<string, unknown> = {};

    if (existsSync(tool.mcpConfigPath)) {
      try {
        config = JSON.parse(readFileSync(tool.mcpConfigPath, 'utf-8'));
      } catch {}
    }

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers.sessions = {
      command: cmd,
      args: ['--mcp'],
    };
    config.mcpServers = servers;

    mkdirSync(dirname(tool.mcpConfigPath), { recursive: true });
    writeFileSync(tool.mcpConfigPath, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

function runClaude(...args: string[]): boolean {
  try {
    const result = Bun.spawnSync(['claude', 'plugins', ...args], { stderr: 'pipe', stdout: 'pipe' });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function registerClaudePlugin(): { marketplace: boolean; install: boolean } {
  const marketplace = runClaude('marketplace', 'add', SESSIONS_DIR);
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
    w(`  ${C.green}✓${C.reset} Plugin installed to ${C.dim}${PLUGIN_DEST}${C.reset}\n`);
  } else {
    w(`  ${C.red}✗${C.reset} Failed to install plugin to ${PLUGIN_DEST}\n`);
    process.exit(1);
  }

  const tools = detectTools();
  const detected = tools.filter((t) => t.detected);

  if (detected.length === 0) {
    w(`\n  ${C.dim}No AI tools detected. Install Claude Code, Cursor, or Codex first.${C.reset}\n\n`);
    process.exit(0);
  }

  for (const tool of detected) {
    if (configureMcp(tool)) {
      w(`  ${C.green}✓${C.reset} MCP server added to ${C.dim}${tool.name}${C.reset}\n`);
    } else {
      w(`  ${C.red}✗${C.reset} Failed to configure MCP for ${tool.name}\n`);
    }

    if (tool.name === 'Claude Code') {
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
  }

  // SessionStart auto-injection hook — opt-in, Claude Code only for now.
  const claudeDetected = detected.some((t) => t.name === 'Claude Code');
  if (claudeDetected && shouldEnableHook(opts)) {
    const res = enableSessionHook('claude');
    if (res.changed) {
      w(`  ${C.green}✓${C.reset} SessionStart auto-injection enabled for ${C.dim}Claude Code${C.reset}\n`);
    } else {
      w(`  ${C.dim}ℹ${C.reset} SessionStart auto-injection already enabled for ${C.dim}Claude Code${C.reset}\n`);
    }
    w(`  ${C.dim}  Disable any time with \`sessions uninstall\`.${C.reset}\n`);
  }

  w(`\n  ${C.bold}Skills available:${C.reset}\n`);
  w(`    ${C.cyan}/context${C.reset}           Context primer for the current repo\n`);
  w(`    ${C.cyan}/weekly-summary${C.reset}    Summarize your past week's AI sessions\n`);
  w(`    ${C.cyan}/standup${C.reset}           Yesterday + today activity for standups\n`);
  w(`    ${C.cyan}/recall${C.reset}            What did I do on a specific project?\n`);
  w(`    ${C.cyan}/session-metrics${C.reset}   Usage dashboard with tool breakdown\n`);
  w(`\n  ${C.dim}Run \`sessions setup\` again after upgrading to update skills.${C.reset}\n\n`);
}

export function runUninstall(): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}sessions uninstall${C.reset}\n\n`);

  const tools = detectTools();
  for (const tool of tools.filter((t) => t.detected)) {
    try {
      if (existsSync(tool.mcpConfigPath)) {
        const config = JSON.parse(readFileSync(tool.mcpConfigPath, 'utf-8'));
        if (config.mcpServers?.sessions) {
          delete config.mcpServers.sessions;
          writeFileSync(tool.mcpConfigPath, JSON.stringify(config, null, 2) + '\n');
          w(`  ${C.green}✓${C.reset} Removed MCP config from ${C.dim}${tool.name}${C.reset}\n`);
        }
      }
    } catch {}

    if (tool.name === 'Claude Code') {
      unregisterClaudePlugin();
      w(`  ${C.green}✓${C.reset} Removed plugin from ${C.dim}${tool.name}${C.reset}\n`);

      const res = disableSessionHook('claude');
      if (res.changed) {
        w(`  ${C.green}✓${C.reset} Removed SessionStart auto-injection from ${C.dim}${tool.name}${C.reset}\n`);
      }
    }
  }

  try {
    require('node:fs').rmSync(SESSIONS_DIR, { recursive: true, force: true });
    w(`  ${C.green}✓${C.reset} Removed ${C.dim}${SESSIONS_DIR}${C.reset}\n`);
  } catch {}

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}
