import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { C } from './colors';
import { PLUGIN_FILES } from './plugin-files';

const home = homedir();
const PLUGIN_DEST = join(home, '.local', 'share', 'sessions', 'plugin');

interface ToolConfig {
  name: string;
  detected: boolean;
  mcpConfigPath: string;
  pluginDir: string;
}

function detectTools(): ToolConfig[] {
  return [
    {
      name: 'Claude Code',
      detected: existsSync(join(home, '.claude')),
      mcpConfigPath: join(home, '.claude', '.mcp.json'),
      pluginDir: join(home, '.claude', 'plugins'),
    },
    {
      name: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      mcpConfigPath: join(home, '.cursor', '.mcp.json'),
      pluginDir: join(home, '.cursor', 'plugins', 'local'),
    },
    {
      name: 'Codex',
      detected: existsSync(join(home, '.codex')),
      mcpConfigPath: join(home, '.codex', '.mcp.json'),
      pluginDir: join(home, '.codex', 'plugins'),
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

function installPlugin(): boolean {
  const source = findPluginSource();
  if (source) return installPluginFromDisk(source);
  return installPluginFromEmbed();
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

function registerPlugin(tool: ToolConfig): boolean {
  try {
    const dest = join(tool.pluginDir, 'sessions');
    mkdirSync(tool.pluginDir, { recursive: true });

    try {
      const stat = statSync(dest);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        require('node:fs').rmSync(dest, { recursive: true, force: true });
      }
    } catch {}

    require('node:fs').symlinkSync(PLUGIN_DEST, dest);
    return true;
  } catch {
    return false;
  }
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

    if (registerPlugin(tool)) {
      w(`  ${C.green}✓${C.reset} Plugin registered with ${C.dim}${tool.name}${C.reset}\n`);
    } else {
      w(`  ${C.red}✗${C.reset} Failed to register plugin with ${tool.name}\n`);
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
    const link = join(tool.pluginDir, 'sessions');
    try {
      require('node:fs').rmSync(link, { recursive: true, force: true });
      w(`  ${C.green}✓${C.reset} Removed plugin from ${C.dim}${tool.name}${C.reset}\n`);
    } catch {}

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
  }

  try {
    require('node:fs').rmSync(PLUGIN_DEST, { recursive: true, force: true });
    w(`  ${C.green}✓${C.reset} Removed ${C.dim}${PLUGIN_DEST}${C.reset}\n`);
  } catch {}

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}
