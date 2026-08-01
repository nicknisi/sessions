import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getPiSessionsDir } from './paths.ts';

// One resolver for every Pi consumer (index, scanner, report). These pin the
// precedence order so the three can never silently disagree again.
const saved = {
  sessionsPi: process.env.SESSIONS_PI_DIR,
  piSession: process.env.PI_CODING_AGENT_SESSION_DIR,
  piDir: process.env.PI_CODING_AGENT_DIR,
};

beforeEach(() => {
  delete process.env.SESSIONS_PI_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterAll(() => {
  for (const [env, val] of [
    ['SESSIONS_PI_DIR', saved.sessionsPi],
    ['PI_CODING_AGENT_SESSION_DIR', saved.piSession],
    ['PI_CODING_AGENT_DIR', saved.piDir],
  ] as const) {
    if (val === undefined) delete process.env[env];
    else process.env[env] = val;
  }
});

describe('getPiSessionsDir', () => {
  test('defaults to ~/.pi/agent/sessions', () => {
    expect(getPiSessionsDir()).toBe(join(homedir(), '.pi', 'agent', 'sessions'));
  });

  test('honors PI_CODING_AGENT_DIR (sessions live under the config dir)', () => {
    process.env.PI_CODING_AGENT_DIR = '/custom/pi-config';
    expect(getPiSessionsDir()).toBe('/custom/pi-config/sessions');
  });

  test('PI_CODING_AGENT_SESSION_DIR beats PI_CODING_AGENT_DIR', () => {
    process.env.PI_CODING_AGENT_DIR = '/custom/pi-config';
    process.env.PI_CODING_AGENT_SESSION_DIR = '/custom/session-store';
    expect(getPiSessionsDir()).toBe('/custom/session-store');
  });

  test('SESSIONS_PI_DIR beats every Pi override', () => {
    process.env.PI_CODING_AGENT_DIR = '/custom/pi-config';
    process.env.PI_CODING_AGENT_SESSION_DIR = '/custom/session-store';
    process.env.SESSIONS_PI_DIR = '/ours';
    expect(getPiSessionsDir()).toBe('/ours');
  });
});
