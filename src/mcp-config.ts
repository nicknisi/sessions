import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHome } from './paths';

// Where each client actually reads its MCP server list. Earlier versions of setup
// guessed `<config-dir>/.mcp.json` for all of them and reported success either
// way; every one of those guesses but Claude Code's plugin was a file no client
// ever opens. Paths here are the ones confirmed against a real install.

export type ClientId = 'claude' | 'cursor' | 'codex' | 'pi';

export interface McpClient {
  id: ClientId;
  name: string;
  detected: boolean;
  /**
   * The file the client reads. Empty for Claude Code: its MCP server arrives with
   * the plugin, so setup has no config file of its own to own there.
   */
  configPath: string;
}

/** What a wiring attempt actually did. Setup reports these rather than assuming. */
export type WireStatus = 'added' | 'unchanged' | 'refused' | 'failed';

export interface WireResult {
  status: WireStatus;
  /** Why it was refused or failed. Always shown — a refusal the user can't see is a lie. */
  reason?: string;
}

const ARGS = ['--mcp'];

export function detectClients(): McpClient[] {
  const home = getHome();
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      detected: existsSync(join(home, '.claude')),
      configPath: '',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      configPath: join(home, '.cursor', 'mcp.json'),
    },
    {
      id: 'codex',
      name: 'Codex',
      detected: existsSync(join(home, '.codex')),
      configPath: join(home, '.codex', 'config.toml'),
    },
    {
      id: 'pi',
      name: 'Pi',
      detected: existsSync(join(home, '.pi', 'agent')),
      configPath: join(home, '.pi', 'agent', 'mcp.json'),
    },
  ];
}

/** The server entry each client expects. Pi's schema wants an explicit transport. */
function serverEntry(id: ClientId, command: string): Record<string, unknown> {
  if (id === 'pi') return { type: 'stdio', command, args: ARGS };
  return { command, args: ARGS };
}

// ---- JSON clients (Cursor, Pi) ----

/**
 * Merge our server into a client's JSON config, preserving every other server.
 * Refuses on anything it can't merge without guessing, so a hand-edited config is
 * never replaced by ours.
 */
export function wireJsonClient(path: string, id: ClientId, command: string): WireResult {
  let config: Record<string, unknown> = {};

  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      return { status: 'failed', reason: `could not read it: ${String(err)}` };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'refused', reason: 'it is not a JSON object' };
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return { status: 'refused', reason: 'it is not valid JSON' };
    }
  }

  const existing = config.mcpServers;
  if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
    return { status: 'refused', reason: 'its `mcpServers` is not an object' };
  }

  const servers = (existing ?? {}) as Record<string, unknown>;
  const current = servers.sessions;
  // Update the keys we own and keep the rest, the same way the Codex merge does:
  // a `cwd` or `env` the user added is theirs, and a re-run must not eat it.
  const previous = typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {};
  const entry = { ...previous, ...serverEntry(id, command) };
  if (JSON.stringify(current) === JSON.stringify(entry)) return { status: 'unchanged' };

  servers.sessions = entry;
  config.mcpServers = servers;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  } catch (err) {
    return { status: 'failed', reason: `could not write it: ${String(err)}` };
  }
  return { status: 'added' };
}

/** Drop our server from a JSON config, leaving the user's other servers alone. */
export function unwireJsonClient(path: string): WireResult {
  if (!existsSync(path)) return { status: 'unchanged' };
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'refused', reason: 'it is not a JSON object' };
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return { status: 'refused', reason: 'it is not valid JSON' };
  }

  const servers = config.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return { status: 'unchanged' };
  const map = servers as Record<string, unknown>;
  if (!('sessions' in map)) return { status: 'unchanged' };

  delete map.sessions;
  try {
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  } catch (err) {
    return { status: 'failed', reason: `could not write it: ${String(err)}` };
  }
  return { status: 'added' };
}

// ---- Codex (TOML) ----

// Codex reads `[mcp_servers.<name>]` tables out of ~/.codex/config.toml, a file
// the user owns and that already holds their model, sandbox, and per-project
// trust settings. Runtime deps stay at two, so there is no TOML library here:
// the merge below edits only its own table, line by line, and refuses outright
// on any shape it cannot edit safely. A wrong merge corrupts real user config,
// so every ambiguity resolves to a refusal plus copy-paste instructions.

const CODEX_TABLE = 'mcp_servers.sessions';
const BACKUP_SUFFIX = '.sessions-bak';

interface TomlHeader {
  line: number;
  parts: string[];
  array: boolean;
}

/** Serialize a TOML basic string. Paths can hold spaces, quotes, or backslashes. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Parse a table header into its dotted key parts. Returns null when the line is
 * not a header, or is one we can't read — callers treat null on a `[`-leading
 * line as a reason to refuse rather than to guess.
 */
function parseHeader(line: string): TomlHeader | null {
  const s = line.trim();
  if (!s.startsWith('[')) return null;
  const array = s.startsWith('[[');
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let quote: string | null = null;

  for (let i = array ? 2 : 1; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += s[++i] ?? '';
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === '.') {
      parts.push(quoted ? cur : cur.trim());
      cur = '';
      quoted = false;
      continue;
    }
    if (ch === ']') {
      parts.push(quoted ? cur : cur.trim());
      return { line: 0, parts, array };
    }
    cur += ch;
  }
  return null; // unterminated header
}

/**
 * Shapes that defeat line-by-line editing. Refusing on these is what keeps the
 * merge honest: inside a multi-line string or array, a line starting with `[`
 * is content, not a table header, and mistaking the two rewrites the wrong span.
 */
function unsupportedShape(source: string, lines: string[]): string | null {
  if (/"""|'''/.test(source)) return 'it contains a multi-line string';
  for (const line of lines) {
    // An assignment whose array opens but does not close on the same line.
    if (/=\s*\[[^\]]*$/.test(line.split('#')[0] ?? '')) return 'it contains a multi-line array';
    // `mcp_servers` as a dotted key or inline table, which our table would duplicate.
    if (/^\s*mcp_servers\s*[.=]/.test(line)) return 'it defines `mcp_servers` as a key rather than a table';
  }
  return null;
}

/** Collect every table header, or the line number of one we could not parse. */
function collectHeaders(lines: string[]): { headers: TomlHeader[] } | { badLine: number } {
  const headers: TomlHeader[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith('[')) continue;
    const parsed = parseHeader(line);
    if (!parsed) return { badLine: i + 1 };
    headers.push({ ...parsed, line: i });
  }
  return { headers };
}

function isOurTable(h: TomlHeader): boolean {
  return h.parts.length === 2 && h.parts[0] === 'mcp_servers' && h.parts[1] === 'sessions';
}

/** True for `[mcp_servers.sessions.env]` and friends — part of our table's block. */
function isOurChild(h: TomlHeader): boolean {
  return h.parts.length > 2 && h.parts[0] === 'mcp_servers' && h.parts[1] === 'sessions';
}

export type TomlMerge = { text: string; changed: boolean } | { refused: string };

/**
 * Add or update `[mcp_servers.sessions]` in a Codex config, preserving the rest
 * of the file byte for byte. Only `command` and `args` are written: any other key
 * in the table (a tuned `startup_timeout_sec`, an `env` sub-table, a comment) is
 * the user's and survives a re-run.
 */
export function mergeCodexConfig(source: string, command: string): TomlMerge {
  const lines = source.split('\n');

  const unsupported = unsupportedShape(source, lines);
  if (unsupported) return { refused: unsupported };

  const collected = collectHeaders(lines);
  if ('badLine' in collected) return { refused: `line ${collected.badLine} is not a table header we can read` };
  const { headers } = collected;

  const ours = headers.find(isOurTable);
  if (headers.some((h) => h.array && (isOurTable(h) || isOurChild(h)))) {
    return { refused: '`mcp_servers.sessions` is an array of tables' };
  }

  const desiredCommand = `command = ${tomlString(command)}`;
  const desiredArgs = `args = [${ARGS.map(tomlString).join(', ')}]`;

  if (!ours) {
    // A new table at end of file is always valid: nothing can swallow it.
    const body = source.replace(/\s*$/, '');
    const text = `${body ? body + '\n\n' : ''}[${CODEX_TABLE}]\n${desiredCommand}\n${desiredArgs}\n`;
    return { text, changed: true };
  }

  // The table's own keys run to the next header of any kind; child tables keep theirs.
  const start = ours.line + 1;
  const end = headers.find((h) => h.line > ours.line)?.line ?? lines.length;
  const block = lines.slice(start, end);

  const isCommand = (l: string) => /^\s*command\s*=/.test(l);
  const isArgs = (l: string) => /^\s*args\s*=/.test(l);
  let changed = false;

  const cmdAt = block.findIndex(isCommand);
  if (cmdAt >= 0) {
    if (block[cmdAt]!.trim() !== desiredCommand) {
      block[cmdAt] = desiredCommand;
      changed = true;
    }
  } else {
    block.unshift(desiredCommand);
    changed = true;
  }

  const argsAt = block.findIndex(isArgs);
  if (argsAt >= 0) {
    if (block[argsAt]!.trim() !== desiredArgs) {
      block[argsAt] = desiredArgs;
      changed = true;
    }
  } else {
    block.splice(block.findIndex(isCommand) + 1, 0, desiredArgs);
    changed = true;
  }

  if (!changed) return { text: source, changed: false };
  return { text: [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n'), changed: true };
}

/** Remove our table and its sub-tables, leaving every other table untouched. */
export function removeCodexConfig(source: string): TomlMerge {
  const lines = source.split('\n');

  const unsupported = unsupportedShape(source, lines);
  if (unsupported) return { refused: unsupported };

  const collected = collectHeaders(lines);
  if ('badLine' in collected) return { refused: `line ${collected.badLine} is not a table header we can read` };
  const { headers } = collected;

  const ours = headers.find(isOurTable);
  if (!ours) return { text: source, changed: false };

  const next = headers.find((h) => h.line > ours.line && !isOurChild(h));
  const end = next?.line ?? lines.length;
  const kept = [...lines.slice(0, ours.line), ...lines.slice(end)];

  // Close the gap only at the seam. A blank run anywhere else in the file is the
  // user's formatting, and collapsing it would edit lines we never owned.
  const seam = ours.line;
  while (seam > 0 && kept[seam - 1] === '' && kept[seam] === '') kept.splice(seam, 1);
  while (kept.length > 1 && kept.at(-1) === '' && kept.at(-2) === '') kept.pop();

  return { text: kept.join('\n'), changed: true };
}

/** Copy the file aside once, before the first edit we ever make to it. */
function backupOnce(path: string): void {
  const backup = path + BACKUP_SUFFIX;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
}

export function wireCodex(path: string, command: string): WireResult {
  let source = '';
  if (existsSync(path)) {
    try {
      source = readFileSync(path, 'utf-8');
    } catch (err) {
      return { status: 'failed', reason: `could not read it: ${String(err)}` };
    }
  }

  const merged = mergeCodexConfig(source, command);
  if ('refused' in merged) return { status: 'refused', reason: merged.refused };
  if (!merged.changed) return { status: 'unchanged' };

  try {
    backupOnce(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, merged.text);
  } catch (err) {
    return { status: 'failed', reason: `could not write it: ${String(err)}` };
  }
  return { status: 'added' };
}

export function unwireCodex(path: string): WireResult {
  if (!existsSync(path)) return { status: 'unchanged' };
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch (err) {
    return { status: 'failed', reason: `could not read it: ${String(err)}` };
  }

  const removed = removeCodexConfig(source);
  if ('refused' in removed) return { status: 'refused', reason: removed.refused };
  if (!removed.changed) return { status: 'unchanged' };

  try {
    backupOnce(path);
    writeFileSync(path, removed.text);
  } catch (err) {
    return { status: 'failed', reason: `could not write it: ${String(err)}` };
  }
  return { status: 'added' };
}

/** The block to paste when we refuse to edit the file ourselves. */
export function codexManualBlock(command: string): string {
  return `[${CODEX_TABLE}]\ncommand = ${tomlString(command)}\nargs = [${ARGS.map(tomlString).join(', ')}]`;
}

// ---- dead files from earlier setups ----

/**
 * `<config-dir>/.mcp.json` files older versions of setup wrote and no client
 * reads. Removed only when the content is exactly what we generated — a lone
 * `sessions` server and nothing else — so a file the user made their own stays.
 */
function deadConfigPaths(): string[] {
  const home = getHome();
  return [join(home, '.claude', '.mcp.json'), join(home, '.cursor', '.mcp.json'), join(home, '.codex', '.mcp.json')];
}

function isOurDeadFile(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'mcpServers') return false;
    const servers = (parsed as { mcpServers: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false;
    const names = Object.keys(servers);
    return names.length === 1 && names[0] === 'sessions';
  } catch {
    return false;
  }
}

/** Returns the paths actually removed, for setup to report. */
export function cleanDeadConfigs(): string[] {
  const removed: string[] = [];
  for (const path of deadConfigPaths()) {
    try {
      if (!existsSync(path)) continue;
      if (!isOurDeadFile(readFileSync(path, 'utf-8'))) continue;
      rmSync(path);
      removed.push(path);
    } catch {}
  }
  return removed;
}
