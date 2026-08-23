import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandboxed home, set BEFORE import: nothing here may touch the real ~/.codex,
// ~/.cursor, or ~/.pi — the whole point of these tests is a merge into a live
// user-owned config, and the live one is the user's.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-mcpcfg-')));
process.env.SESSIONS_HOME = fixtureRoot;

const {
  detectClients,
  wireJsonClient,
  unwireJsonClient,
  wireCodex,
  unwireCodex,
  mergeCodexConfig,
  removeCodexConfig,
  cleanDeadConfigs,
} = await import('./mcp-config');

const codexPath = join(fixtureRoot, '.codex', 'config.toml');
const cursorPath = join(fixtureRoot, '.cursor', 'mcp.json');
const piPath = join(fixtureRoot, '.pi', 'agent', 'mcp.json');
const CMD = '/opt/homebrew/bin/sessions';

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const dir of ['.codex', '.cursor', '.pi', '.claude']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
});

function writeFixture(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** A config.toml shaped like the real one: settings, project tables, other servers. */
const REAL_CONFIG = `approval_policy = "never"
model = "gpt-5.6-sol"

[projects."/Users/someone/Developer/thing"]
trust_level = "trusted"

[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/node_repl"
startup_timeout_sec = 120.0

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/someone/.codex"

[mcp_servers.workos]
url = "https://mcp.workos.com/mcp"
`;

describe('detectClients', () => {
  test('finds each client by the directory it actually owns', () => {
    mkdirSync(join(fixtureRoot, '.codex'), { recursive: true });
    mkdirSync(join(fixtureRoot, '.pi', 'agent'), { recursive: true });

    const byId = Object.fromEntries(detectClients().map((c) => [c.id, c]));
    expect(byId.codex!.detected).toBe(true);
    expect(byId.pi!.detected).toBe(true);
    expect(byId.cursor!.detected).toBe(false);

    // The paths the clients read — not the `.mcp.json` dotfiles setup used to write.
    expect(byId.codex!.configPath).toBe(codexPath);
    expect(byId.cursor!.configPath).toBe(cursorPath);
    expect(byId.pi!.configPath).toBe(piPath);
    expect(byId.claude!.configPath).toBe(''); // wired through the plugin instead
  });

  test('no client is wired through a `<config-dir>/.mcp.json` dotfile', () => {
    // The original bug stated as an invariant. Every write target was
    // `<config-dir>/.mcp.json`, a filename no client in this list opens, and setup
    // printed a checkmark for each one. A future client added with the same guess
    // fails here rather than shipping a silent no-op.
    for (const client of detectClients()) {
      expect(client.configPath.endsWith('/.mcp.json')).toBe(false);
    }
  });
});

describe('codex config.toml merge', () => {
  test('merges into an existing config with prior entries, preserving all of them', () => {
    writeFixture(codexPath, REAL_CONFIG);
    expect(wireCodex(codexPath, CMD).status).toBe('added');

    const after = readFileSync(codexPath, 'utf-8');
    expect(after).toContain('[mcp_servers.sessions]');
    expect(after).toContain(`command = "${CMD}"`);
    expect(after).toContain('args = ["--mcp"]');

    // Every pre-existing line survives byte for byte.
    for (const line of REAL_CONFIG.trimEnd().split('\n')) {
      expect(after).toContain(line);
    }
  });

  test('backs the file up before the first edit', () => {
    writeFixture(codexPath, REAL_CONFIG);
    wireCodex(codexPath, CMD);
    expect(readFileSync(codexPath + '.sessions-bak', 'utf-8')).toBe(REAL_CONFIG);
  });

  test('is idempotent: a second run changes nothing', () => {
    writeFixture(codexPath, REAL_CONFIG);
    wireCodex(codexPath, CMD);
    const first = readFileSync(codexPath, 'utf-8');

    expect(wireCodex(codexPath, CMD).status).toBe('unchanged');
    expect(readFileSync(codexPath, 'utf-8')).toBe(first);
  });

  test('updates a stale command in place without touching the user keys beside it', () => {
    writeFixture(
      codexPath,
      `${REAL_CONFIG}
[mcp_servers.sessions]
command = "/old/path/sessions"
args = ["--mcp"]
startup_timeout_sec = 30.0

[mcp_servers.sessions.env]
SESSIONS_DEBUG = "1"
`,
    );
    expect(wireCodex(codexPath, CMD).status).toBe('added');

    const after = readFileSync(codexPath, 'utf-8');
    expect(after).toContain(`command = "${CMD}"`);
    expect(after).not.toContain('/old/path/sessions');
    expect(after).toContain('startup_timeout_sec = 30.0'); // the user's, kept
    expect(after).toContain('SESSIONS_DEBUG = "1"');
  });

  test('adds a missing args key to a half-written table', () => {
    writeFixture(codexPath, `[mcp_servers.sessions]\ncommand = "${CMD}"\n`);
    expect(wireCodex(codexPath, CMD).status).toBe('added');
    expect(readFileSync(codexPath, 'utf-8')).toContain('args = ["--mcp"]');
  });

  test('creates the file when Codex has no config yet', () => {
    mkdirSync(join(fixtureRoot, '.codex'), { recursive: true });
    expect(wireCodex(codexPath, CMD).status).toBe('added');
    expect(readFileSync(codexPath, 'utf-8')).toBe(`[mcp_servers.sessions]\ncommand = "${CMD}"\nargs = ["--mcp"]\n`);
  });

  test('quotes a command containing spaces and quotes', () => {
    const odd = '/Applications/My "Tools"/sessions';
    expect(mergeCodexConfig('', odd)).toMatchObject({
      text: `[mcp_servers.sessions]\ncommand = "/Applications/My \\"Tools\\"/sessions"\nargs = ["--mcp"]\n`,
    });
  });

  test('keeps a table whose name merely starts the same', () => {
    writeFixture(codexPath, '[mcp_servers.sessions_other]\ncommand = "/bin/other"\n');
    wireCodex(codexPath, CMD);

    const after = readFileSync(codexPath, 'utf-8');
    expect(after).toContain('[mcp_servers.sessions_other]');
    expect(after).toContain('command = "/bin/other"');
    expect(after).toContain('[mcp_servers.sessions]');
  });
});

describe('codex config.toml refusals', () => {
  // Each of these is a file we cannot edit by hand without risking corruption.
  // The contract is that the file comes back untouched and the caller is told.
  const malformed: [string, string][] = [
    ['a multi-line string', 'notice = """\nhello\n[mcp_servers.sessions]\n"""\n'],
    ['a multi-line array', 'notify = [\n  "one",\n  "two",\n]\n'],
    ['mcp_servers as a dotted key', 'mcp_servers.sessions = { command = "/bin/x" }\n'],
    ['mcp_servers as an inline table', 'mcp_servers = { sessions = { command = "/bin/x" } }\n'],
    ['an unterminated table header', '[mcp_servers.sessions\ncommand = "/bin/x"\n'],
    ['our table as an array of tables', '[[mcp_servers.sessions]]\ncommand = "/bin/x"\n'],
  ];

  for (const [label, content] of malformed) {
    test(`refuses ${label} rather than corrupting it`, () => {
      writeFixture(codexPath, content);
      const result = wireCodex(codexPath, CMD);

      expect(result.status).toBe('refused');
      expect(result.reason).toBeTruthy();
      expect(readFileSync(codexPath, 'utf-8')).toBe(content); // untouched
      expect(existsSync(codexPath + '.sessions-bak')).toBe(false); // never even opened for writing
    });
  }

  test('a refusal never writes a partial table', () => {
    writeFixture(codexPath, 'notify = [\n  "one",\n]\n');
    wireCodex(codexPath, CMD);
    expect(readFileSync(codexPath, 'utf-8')).not.toContain('sessions');
  });
});

describe('codex removal', () => {
  test('removes our table and its sub-tables, keeping every other server', () => {
    writeFixture(
      codexPath,
      `${REAL_CONFIG}
[mcp_servers.sessions]
command = "${CMD}"
args = ["--mcp"]

[mcp_servers.sessions.env]
SESSIONS_DEBUG = "1"
`,
    );
    expect(unwireCodex(codexPath).status).toBe('added');

    const after = readFileSync(codexPath, 'utf-8');
    expect(after).not.toContain('sessions');
    expect(after).toContain('[mcp_servers.node_repl]');
    expect(after).toContain('[mcp_servers.workos]');
    expect(after).toContain('url = "https://mcp.workos.com/mcp"');
  });

  test('is a no-op when our table was never there', () => {
    writeFixture(codexPath, REAL_CONFIG);
    expect(unwireCodex(codexPath).status).toBe('unchanged');
    expect(readFileSync(codexPath, 'utf-8')).toBe(REAL_CONFIG);
  });

  test('round-trips: merge then remove restores the original byte for byte', () => {
    const merged = mergeCodexConfig(REAL_CONFIG, CMD);
    if (!('text' in merged)) throw new Error(`merge refused: ${merged.refused}`);
    const removed = removeCodexConfig(merged.text);
    if (!('text' in removed)) throw new Error(`remove refused: ${removed.refused}`);
    expect(removed.text).toBe(REAL_CONFIG);
  });

  test('leaves blank runs the user wrote elsewhere in the file alone', () => {
    // Two blank lines before a later table: the user's formatting, not our seam.
    const spaced = `model = "gpt-5.6-sol"\n\n\n[plugins."github"]\nenabled = true\n`;
    const merged = mergeCodexConfig(spaced, CMD);
    if (!('text' in merged)) throw new Error(`merge refused: ${merged.refused}`);
    const removed = removeCodexConfig(merged.text);
    if (!('text' in removed)) throw new Error(`remove refused: ${removed.refused}`);
    expect(removed.text).toBe(spaced);
  });
});

describe('json clients', () => {
  test('merges into Cursor mcp.json, preserving the servers already there', () => {
    writeFixture(
      cursorPath,
      JSON.stringify({ mcpServers: { workos: { url: 'https://mcp.workos.com/mcp' } } }, null, 2),
    );
    expect(wireJsonClient(cursorPath, 'cursor', CMD).status).toBe('added');

    const after = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    expect(after.mcpServers.workos).toEqual({ url: 'https://mcp.workos.com/mcp' });
    expect(after.mcpServers.sessions).toEqual({ command: CMD, args: ['--mcp'] });
  });

  test('gives Pi the stdio type its schema expects, and keeps its other keys', () => {
    writeFixture(piPath, JSON.stringify({ discoveryMode: 'auto', importConfigs: ['~/.claude.json'], mcpServers: {} }));
    expect(wireJsonClient(piPath, 'pi', CMD).status).toBe('added');

    const after = JSON.parse(readFileSync(piPath, 'utf-8'));
    expect(after.mcpServers.sessions).toEqual({ type: 'stdio', command: CMD, args: ['--mcp'] });
    expect(after.discoveryMode).toBe('auto');
    expect(after.importConfigs).toEqual(['~/.claude.json']);
  });

  test('is idempotent', () => {
    writeFixture(cursorPath, '{}\n');
    wireJsonClient(cursorPath, 'cursor', CMD);
    const first = readFileSync(cursorPath, 'utf-8');

    expect(wireJsonClient(cursorPath, 'cursor', CMD).status).toBe('unchanged');
    expect(readFileSync(cursorPath, 'utf-8')).toBe(first);
  });

  test('refuses malformed JSON rather than replacing it', () => {
    const broken = '{ "mcpServers": { oops\n';
    writeFixture(cursorPath, broken);

    const result = wireJsonClient(cursorPath, 'cursor', CMD);
    expect(result.status).toBe('refused');
    expect(readFileSync(cursorPath, 'utf-8')).toBe(broken);
  });

  test('refuses a config whose mcpServers is the wrong shape', () => {
    writeFixture(cursorPath, JSON.stringify({ mcpServers: [] }));
    expect(wireJsonClient(cursorPath, 'cursor', CMD).status).toBe('refused');
  });

  test('a re-run keeps keys the user added to our entry', () => {
    writeFixture(
      piPath,
      JSON.stringify({
        mcpServers: { sessions: { type: 'stdio', command: '/old/dev/build', args: ['--mcp'], cwd: '/work/sessions' } },
      }),
    );
    expect(wireJsonClient(piPath, 'pi', CMD).status).toBe('added');

    const after = JSON.parse(readFileSync(piPath, 'utf-8'));
    expect(after.mcpServers.sessions.command).toBe(CMD); // stale path updated
    expect(after.mcpServers.sessions.cwd).toBe('/work/sessions'); // the user's, kept
  });

  test('removal takes only our server', () => {
    writeFixture(cursorPath, JSON.stringify({ mcpServers: { workos: { url: 'x' }, sessions: { command: CMD } } }));
    expect(unwireJsonClient(cursorPath).status).toBe('added');

    const after = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    expect(after.mcpServers.sessions).toBeUndefined();
    expect(after.mcpServers.workos).toEqual({ url: 'x' });
  });
});

describe('cleanDeadConfigs', () => {
  const ours = JSON.stringify({ mcpServers: { sessions: { command: CMD, args: ['--mcp'] } } }, null, 2) + '\n';

  test('removes the dotfiles older setups wrote that no client reads', () => {
    writeFixture(join(fixtureRoot, '.codex', '.mcp.json'), ours);
    writeFixture(join(fixtureRoot, '.cursor', '.mcp.json'), ours);
    writeFixture(join(fixtureRoot, '.claude', '.mcp.json'), ours);

    const removed = cleanDeadConfigs();
    expect(removed).toHaveLength(3);
    expect(existsSync(join(fixtureRoot, '.codex', '.mcp.json'))).toBe(false);
    expect(existsSync(join(fixtureRoot, '.cursor', '.mcp.json'))).toBe(false);
  });

  test('leaves a file the user made their own, even at our path', () => {
    const theirs = JSON.stringify({ mcpServers: { sessions: { command: CMD }, other: { command: '/bin/x' } } });
    writeFixture(join(fixtureRoot, '.cursor', '.mcp.json'), theirs);

    expect(cleanDeadConfigs()).toEqual([]);
    expect(readFileSync(join(fixtureRoot, '.cursor', '.mcp.json'), 'utf-8')).toBe(theirs);
  });

  test('leaves a file with keys beyond mcpServers alone', () => {
    const theirs = JSON.stringify({ mcpServers: { sessions: { command: CMD } }, inputs: [] });
    writeFixture(join(fixtureRoot, '.codex', '.mcp.json'), theirs);
    expect(cleanDeadConfigs()).toEqual([]);
  });

  test('never touches the real config files', () => {
    // The paths cleaned are resolved from SESSIONS_HOME, not the real home.
    writeFixture(join(fixtureRoot, '.codex', '.mcp.json'), ours);
    for (const path of cleanDeadConfigs()) {
      expect(path.startsWith(fixtureRoot)).toBe(true);
    }
  });
});
