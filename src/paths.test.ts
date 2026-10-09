import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { getPiSessionsDir, getPiExtraDirs } from './paths.ts';

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

describe('getPiExtraDirs', () => {
  const saved = { home: process.env.SESSIONS_HOME, extra: process.env.SESSIONS_PI_EXTRA_DIRS };
  // A fixture home: SESSIONS_HOME makes `~` point here, so no real folder is ever read.
  const home = mkdtempSync(join(tmpdir(), 'sessions-extra-'));
  for (const job of ['7', '12', '9']) mkdirSync(join(home, '.riker', 'jobs', job, 'session'), { recursive: true });
  writeFileSync(join(home, '.riker', 'jobs', '7', 'log.jsonl'), '{}');
  mkdirSync(join(home, '.riker', 'jobs', '30')); // no session/ dir: not matched
  mkdirSync(join(home, 'flat'));

  beforeEach(() => {
    process.env.SESSIONS_HOME = home;
    delete process.env.SESSIONS_PI_EXTRA_DIRS;
  });

  afterAll(() => {
    for (const [env, val] of [
      ['SESSIONS_HOME', saved.home],
      ['SESSIONS_PI_EXTRA_DIRS', saved.extra],
    ] as const) {
      if (val === undefined) delete process.env[env];
      else process.env[env] = val;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test('none by default', () => {
    expect(getPiExtraDirs()).toEqual([]);
  });

  test('expands ~ and * globs to the existing directories, in order', () => {
    process.env.SESSIONS_PI_EXTRA_DIRS = '~/flat:~/.riker/jobs/*/session';
    const jobs = join(home, '.riker', 'jobs');
    expect(getPiExtraDirs()).toEqual([
      join(home, 'flat'),
      join(jobs, '12', 'session'),
      join(jobs, '7', 'session'),
      join(jobs, '9', 'session'),
    ]);
  });

  test('missing folders, globs that match nothing, and empty entries are skipped silently', () => {
    process.env.SESSIONS_PI_EXTRA_DIRS = `::~/nope:${join(home, 'nope', '*')}:~/.riker/jobs/*/nothing:${join(home, 'flat')}`;
    expect(getPiExtraDirs()).toEqual([join(home, 'flat')]);
  });
});
