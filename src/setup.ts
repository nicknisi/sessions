import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { C } from './colors';
import { PLUGIN_FILES } from './plugin-files';

const home = homedir();
const SESSIONS_DIR = join(home, '.local', 'share', 'sessions');
const PLUGIN_DEST = join(SESSIONS_DIR, 'plugin');
const PLUGIN_VERSION = '1.0.0';
const MARKETPLACE_NAME = 'sessions';
const PLUGIN_NAME = 'sessions';

const CLAUDE_PLUGINS_DIR = join(home, '.claude', 'plugins');
const CLAUDE_CACHE_DIR = join(CLAUDE_PLUGINS_DIR, 'cache', MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION);
const KNOWN_MARKETPLACES_PATH = join(CLAUDE_PLUGINS_DIR, 'known_marketplaces.json');
const INSTALLED_PLUGINS_PATH = join(CLAUDE_PLUGINS_DIR, 'installed_plugins.json');

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

function registerClaudePlugin(): boolean {
  try {
    mkdirSync(CLAUDE_CACHE_DIR, { recursive: true });
    cpSync(PLUGIN_DEST, CLAUDE_CACHE_DIR, { recursive: true, force: true });

    let marketplaces: Record<string, unknown> = {};
    if (existsSync(KNOWN_MARKETPLACES_PATH)) {
      try {
        marketplaces = JSON.parse(readFileSync(KNOWN_MARKETPLACES_PATH, 'utf-8'));
      } catch {}
    }
    marketplaces[MARKETPLACE_NAME] = {
      source: { source: 'directory', path: SESSIONS_DIR },
      installLocation: SESSIONS_DIR,
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(KNOWN_MARKETPLACES_PATH, JSON.stringify(marketplaces, null, 2) + '\n');

    let installed: Record<string, unknown> = { version: 2, plugins: {} };
    if (existsSync(INSTALLED_PLUGINS_PATH)) {
      try {
        installed = JSON.parse(readFileSync(INSTALLED_PLUGINS_PATH, 'utf-8'));
      } catch {}
    }
    const plugins = (installed.plugins ?? {}) as Record<string, unknown[]>;
    const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    plugins[key] = [
      {
        scope: 'user',
        installPath: CLAUDE_CACHE_DIR,
        version: PLUGIN_VERSION,
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    ];
    installed.plugins = plugins;
    writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(installed, null, 2) + '\n');

    return true;
  } catch {
    return false;
  }
}

function unregisterClaudePlugin(): void {
  try {
    if (existsSync(KNOWN_MARKETPLACES_PATH)) {
      const marketplaces = JSON.parse(readFileSync(KNOWN_MARKETPLACES_PATH, 'utf-8'));
      if (marketplaces[MARKETPLACE_NAME]) {
        delete marketplaces[MARKETPLACE_NAME];
        writeFileSync(KNOWN_MARKETPLACES_PATH, JSON.stringify(marketplaces, null, 2) + '\n');
      }
    }
  } catch {}

  try {
    if (existsSync(INSTALLED_PLUGINS_PATH)) {
      const installed = JSON.parse(readFileSync(INSTALLED_PLUGINS_PATH, 'utf-8'));
      const plugins = installed.plugins ?? {};
      const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
      if (plugins[key]) {
        delete plugins[key];
        installed.plugins = plugins;
        writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(installed, null, 2) + '\n');
      }
    }
  } catch {}

  try {
    const cacheDir = join(CLAUDE_PLUGINS_DIR, 'cache', MARKETPLACE_NAME);
    require('node:fs').rmSync(cacheDir, { recursive: true, force: true });
  } catch {}
}

export function runSetup(): void {
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
      if (registerClaudePlugin()) {
        w(`  ${C.green}✓${C.reset} Plugin registered with ${C.dim}${tool.name}${C.reset}\n`);
      } else {
        w(`  ${C.red}✗${C.reset} Failed to register plugin with ${tool.name}\n`);
      }
    }
  }

  w(`\n  ${C.bold}Skills available:${C.reset}\n`);
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
    }
  }

  // Clean up old symlinks from previous versions
  const oldLink = join(CLAUDE_PLUGINS_DIR, 'sessions');
  try {
    require('node:fs').rmSync(oldLink, { recursive: true, force: true });
  } catch {}

  try {
    require('node:fs').rmSync(PLUGIN_DEST, { recursive: true, force: true });
    w(`  ${C.green}✓${C.reset} Removed ${C.dim}${PLUGIN_DEST}${C.reset}\n`);
  } catch {}

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}
