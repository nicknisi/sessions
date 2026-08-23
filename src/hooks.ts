import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { asJsonObject, type JsonObject, type JsonValue } from './extract-util';

/**
 * Tools whose SessionStart hook contract is confirmed. Claude Code only for
 * now — Codex and Cursor session-start hook schemas are unverified, so we ship
 * Claude first and gate the others on confirmed schemas (see spec Open Items).
 */
export type SupportedTool = 'claude';

/** Stable marker: the exact command string identifies our hook entry so enable
 * is idempotent and disable removes only ours, never the user's other hooks. */
export const HOOK_COMMAND = 'sessions context --hook';

/** SessionStart hook startup budget. Generous, but bounds a pathological run. */
const HOOK_TIMEOUT_MS = 10000;

/** The Claude Code settings file that owns the user's `hooks` block. The
 * `SESSIONS_CLAUDE_CONFIG_DIR` override keeps tests hermetic and lets advanced
 * users relocate their config. */
function settingsPath(tool: SupportedTool): string {
  switch (tool) {
    case 'claude': {
      const dir = process.env.SESSIONS_CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
      return join(dir, 'settings.json');
    }
  }
}

/** Our tagged SessionStart entry: stdout becomes additional session context. */
function hookEntry(): JsonObject {
  return {
    hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_MS }],
  };
}

/**
 * Load the tool's settings JSON. Returns `null` (with a written message) when
 * the file exists but is unparseable, so callers abort rather than clobber it.
 * A missing file is fine — it returns an empty object to be created on write.
 */
function loadSettings(path: string): JsonObject | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = asJsonObject(JSON.parse(readFileSync(path, 'utf-8')));
    if (!parsed) throw new Error('settings file is not a JSON object');
    return parsed;
  } catch {
    process.stderr.write(`settings file unparseable, leaving it untouched: ${path}\n`);
    return null;
  }
}

function writeSettings(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

/** True if a matcher group contains our tagged command hook. */
function isOurEntry(group: JsonValue | undefined): boolean {
  const hooks = asJsonObject(group)?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const hook = asJsonObject(h);
    return hook?.type === 'command' && hook.command === HOOK_COMMAND;
  });
}

/** The enable/disable result. */
interface HookChange {
  changed: boolean;
}

/**
 * Add our tagged SessionStart hook to the tool's settings, preserving any
 * existing hooks. Idempotent: enabling twice leaves exactly one entry.
 */
export function enableSessionHook(tool: SupportedTool): HookChange {
  const path = settingsPath(tool);
  const config = loadSettings(path);
  if (config === null) return { changed: false }; // unparseable → abort, no corruption

  // asJsonObject detaches the subtree; config.hooks is re-attached before write.
  const hooks = asJsonObject(config.hooks) ?? {};
  const existing = hooks.SessionStart;
  const sessionStart = Array.isArray(existing) ? existing : [];

  if (sessionStart.some(isOurEntry)) return { changed: false }; // already present

  sessionStart.push(hookEntry());
  hooks.SessionStart = sessionStart;
  config.hooks = hooks;

  writeSettings(path, config);
  return { changed: true };
}

/**
 * Remove only our tagged SessionStart hook, leaving any other hooks intact.
 * Idempotent: disabling when absent is a no-op.
 */
export function disableSessionHook(tool: SupportedTool): HookChange {
  const path = settingsPath(tool);
  const config = loadSettings(path);
  if (config === null) return { changed: false }; // unparseable → abort, no corruption

  const hooks = asJsonObject(config.hooks);
  const existing = hooks?.SessionStart;
  if (!hooks || !Array.isArray(existing)) return { changed: false };

  const kept = existing.filter((g) => !isOurEntry(g));
  if (kept.length === existing.length) return { changed: false }; // nothing of ours

  if (kept.length > 0) {
    hooks.SessionStart = kept;
  } else {
    delete hooks.SessionStart; // drop the now-empty array rather than leave clutter
  }
  // asJsonObject detaches the subtree — re-attach before serializing.
  config.hooks = hooks;

  writeSettings(path, config);
  return { changed: true };
}
