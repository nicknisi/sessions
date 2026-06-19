import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the hook at a hermetic temp config dir BEFORE importing the module.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-hooks-')));
const claudeDir = join(fixtureRoot, 'claude');
mkdirSync(claudeDir, { recursive: true });
process.env.SESSIONS_CLAUDE_CONFIG_DIR = claudeDir;

const { enableSessionHook, disableSessionHook, HOOK_COMMAND } = await import('./hooks');

const settingsFile = join(claudeDir, 'settings.json');

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset to a clean (absent) settings file before each test.
  if (existsSync(settingsFile)) rmSync(settingsFile);
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
}

function sessionStartGroups(s: Record<string, unknown>): unknown[] {
  const hooks = (s.hooks ?? {}) as Record<string, unknown>;
  return Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];
}

/** Count matcher-groups whose hooks array contains our tagged command. */
function ourEntryCount(s: Record<string, unknown>): number {
  return sessionStartGroups(s).filter((g) => {
    const hooks = (g as { hooks?: { command?: string }[] }).hooks ?? [];
    return hooks.some((h) => h.command === HOOK_COMMAND);
  }).length;
}

describe('enableSessionHook', () => {
  test('creates the tagged entry on a missing settings file', () => {
    expect(existsSync(settingsFile)).toBe(false);
    const res = enableSessionHook('claude');
    expect(res.changed).toBe(true);
    expect(existsSync(settingsFile)).toBe(true);
    expect(ourEntryCount(readSettings())).toBe(1);
  });

  test('creates the tagged entry on an empty settings object', () => {
    writeFileSync(settingsFile, '{}\n');
    const res = enableSessionHook('claude');
    expect(res.changed).toBe(true);
    expect(ourEntryCount(readSettings())).toBe(1);
  });

  test('is idempotent: enabling twice leaves exactly one entry', () => {
    const first = enableSessionHook('claude');
    const second = enableSessionHook('claude');
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(ourEntryCount(readSettings())).toBe(1);
  });

  test('preserves a pre-existing unrelated SessionStart hook', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool-hook' }] }] },
      }) + '\n',
    );
    enableSessionHook('claude');
    const groups = sessionStartGroups(readSettings());
    expect(groups).toHaveLength(2); // the user's + ours
    expect(ourEntryCount(readSettings())).toBe(1);
    // The user's hook is untouched.
    const flatCommands = groups.flatMap((g) => (g as { hooks: { command: string }[] }).hooks.map((h) => h.command));
    expect(flatCommands).toContain('other-tool-hook');
  });

  test('preserves unrelated hook events (e.g. SessionEnd)', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'cleanup' }] }] },
      }) + '\n',
    );
    enableSessionHook('claude');
    const s = readSettings();
    const sessionEnd = (s.hooks as Record<string, unknown>).SessionEnd as unknown[];
    expect(sessionEnd).toHaveLength(1);
    expect(ourEntryCount(s)).toBe(1);
  });

  test('preserves unrelated top-level settings keys', () => {
    writeFileSync(settingsFile, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }) + '\n');
    enableSessionHook('claude');
    const s = readSettings();
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ FOO: 'bar' });
  });
});

describe('disableSessionHook', () => {
  test('removes only the tagged entry, leaving an unrelated hook intact', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool-hook' }] }] },
      }) + '\n',
    );
    enableSessionHook('claude');
    expect(ourEntryCount(readSettings())).toBe(1);

    const res = disableSessionHook('claude');
    expect(res.changed).toBe(true);

    const groups = sessionStartGroups(readSettings());
    expect(ourEntryCount(readSettings())).toBe(0);
    const flatCommands = groups.flatMap((g) => (g as { hooks: { command: string }[] }).hooks.map((h) => h.command));
    expect(flatCommands).toContain('other-tool-hook'); // user's hook survives
  });

  test('enable then disable round-trips to no SessionStart entry of ours', () => {
    enableSessionHook('claude');
    expect(ourEntryCount(readSettings())).toBe(1);
    disableSessionHook('claude');
    expect(ourEntryCount(readSettings())).toBe(0);
  });

  test('drops an empty SessionStart array after removing our only entry', () => {
    enableSessionHook('claude');
    disableSessionHook('claude');
    const hooks = (readSettings().hooks ?? {}) as Record<string, unknown>;
    expect(hooks.SessionStart).toBeUndefined();
  });

  test('is idempotent: disabling when absent is a no-op', () => {
    writeFileSync(settingsFile, '{}\n');
    const res = disableSessionHook('claude');
    expect(res.changed).toBe(false);
  });

  test('is a no-op on a missing settings file', () => {
    expect(existsSync(settingsFile)).toBe(false);
    const res = disableSessionHook('claude');
    expect(res.changed).toBe(false);
  });
});

describe('fail-safe on unparseable settings', () => {
  test('enable aborts without corrupting an unparseable file', () => {
    const garbage = '{ this is not json ]';
    writeFileSync(settingsFile, garbage);
    const res = enableSessionHook('claude');
    expect(res.changed).toBe(false);
    expect(readFileSync(settingsFile, 'utf-8')).toBe(garbage); // untouched
  });

  test('disable aborts without corrupting an unparseable file', () => {
    const garbage = 'not json at all';
    writeFileSync(settingsFile, garbage);
    const res = disableSessionHook('claude');
    expect(res.changed).toBe(false);
    expect(readFileSync(settingsFile, 'utf-8')).toBe(garbage); // untouched
  });
});
