import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { getPiSessionsDir, getPiSessionRoots, getRikerHome, rikerJobFromPath } from './paths.ts';

// One resolver for every Pi consumer (index, scanner, report). These pin the
// precedence order so the three can never silently disagree again.
const ENVS = [
  'SESSIONS_PI_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_CODING_AGENT_DIR',
  'SESSIONS_HOME',
  'SESSIONS_RIKER',
  'SESSIONS_RIKER_DIR',
  'RIKER_HOME',
] as const;
const saved = new Map(ENVS.map((env) => [env, process.env[env]]));

beforeEach(() => {
  for (const env of ENVS) delete process.env[env];
});

afterAll(() => {
  for (const [env, val] of saved) {
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

// Riker job transcripts join Pi's tree as extra roots. Every case runs in a fixture
// home: SESSIONS_HOME sandboxes the ~/.riker default, so the real one is never read.
describe('getPiSessionRoots', () => {
  let home: string;
  const homes: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sessions-roots-'));
    homes.push(home);
    process.env.SESSIONS_HOME = home;
    process.env.SESSIONS_PI_DIR = join(home, 'pi');
  });

  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  /** A fixture Riker home: job dirs, some with a session/ dir, plus Riker's own non-session files. */
  function seedRiker(rikerHome: string, jobs: string[]): void {
    for (const id of jobs) {
      mkdirSync(join(rikerHome, 'jobs', id, 'session'), { recursive: true });
      writeFileSync(join(rikerHome, 'jobs', id, 'log.jsonl'), '{}\n');
    }
  }

  test('on by default: every <home>/.riker/jobs/<n>/session dir after Pi own tree', () => {
    seedRiker(join(home, '.riker'), ['7', '12']);
    mkdirSync(join(home, '.riker', 'jobs', '9')); // no session/ yet: not a root
    mkdirSync(join(home, '.riker', 'jobs', 'tmp', 'session'), { recursive: true }); // not a job id
    const roots = getPiSessionRoots();
    expect(roots[0]).toEqual({ dir: join(home, 'pi'), origin: 'pi' });
    expect(roots.slice(1).sort((a, b) => a.dir.localeCompare(b.dir))).toEqual([
      { dir: join(home, '.riker', 'jobs', '12', 'session'), origin: 'riker' },
      { dir: join(home, '.riker', 'jobs', '7', 'session'), origin: 'riker' },
    ]);
  });

  test('no Riker home: just Pi', () => {
    expect(getPiSessionRoots()).toEqual([{ dir: join(home, 'pi'), origin: 'pi' }]);
  });

  test('SESSIONS_RIKER=0 opts out', () => {
    seedRiker(join(home, '.riker'), ['7']);
    process.env.SESSIONS_RIKER = '0';
    expect(getPiSessionRoots()).toEqual([{ dir: join(home, 'pi'), origin: 'pi' }]);
  });

  test('RIKER_HOME overrides ~/.riker, and SESSIONS_RIKER_DIR beats both', () => {
    seedRiker(join(home, '.riker'), ['1']);
    seedRiker(join(home, 'elsewhere'), ['2']);
    seedRiker(join(home, 'ours'), ['3']);
    process.env.RIKER_HOME = join(home, 'elsewhere');
    expect(getRikerHome()).toBe(join(home, 'elsewhere'));
    expect(getPiSessionRoots().map((r) => r.dir)).toEqual([
      join(home, 'pi'),
      join(home, 'elsewhere', 'jobs', '2', 'session'),
    ]);
    process.env.SESSIONS_RIKER_DIR = join(home, 'ours');
    expect(getPiSessionRoots().map((r) => r.dir)).toEqual([
      join(home, 'pi'),
      join(home, 'ours', 'jobs', '3', 'session'),
    ]);
  });

  test('rikerJobFromPath reads the job number off a session transcript path only', () => {
    const jobs = join(home, '.riker', 'jobs');
    expect(rikerJobFromPath(join(jobs, '124', 'session', 'a.jsonl'))).toBe(124);
    expect(rikerJobFromPath(join(jobs, '124', 'log.jsonl'))).toBe(0);
    expect(rikerJobFromPath(join(jobs, '124', 'proof', 'session', 'a.jsonl'))).toBe(0);
    expect(rikerJobFromPath(join(home, 'pi', 'proj', 'a.jsonl'))).toBe(0);
  });
});
