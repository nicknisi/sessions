// The eval corpus: a FROZEN set of fixture sessions that golden.ts's queries run
// against. Discipline (docs/EVAL.md):
//  - The corpus changes only deliberately, and every change bumps EVAL_V.
//  - It grows by logging REAL misses as new sessions + goldens, never by editing
//    an expectation to match whatever the ranker currently does.
//  - Vocabulary isolation is the corpus's load-bearing property: before adding a
//    session, grep this file for every term its goldens query. Two sessions share
//    a term only when a golden exists to pin the intended ranking between them
//    (the auth-*/"middleware" pair and the "cache" pair are the examples).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, unknown>;
const j = (o: unknown): string => JSON.stringify(o);

// Claude Code record helpers. Only the fields the extractors read are set.
const user = (text: string, t: string): Rec => ({
  type: 'user',
  timestamp: t,
  message: { role: 'user', content: [{ type: 'text', text }] },
  promptSource: 'typed',
});
const asst = (text: string, t: string): Rec => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const bash = (command: string, t: string): Rec => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});
const edit = (file_path: string, t: string): Rec => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] },
});
const read = (file_path: string, t: string): Rec => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path } }] },
});
const think = (thinking: string, t: string): Rec => ({
  type: 'assistant',
  timestamp: t,
  message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
});
// Tool-result errors are not turns: extractErrors carries their text into
// session_fts.context_text, and message_fts never sees them.
const toolError = (content: string, t: string): Rec => ({
  type: 'user',
  timestamp: t,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content }] },
});

const at = (day: number, minute: number): string =>
  `2026-06-${String(day).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00Z`;

interface Fixture {
  id: string;
  cwd: string;
  records: Rec[];
}

const CLAUDE_FIXTURES: Fixture[] = [
  {
    id: 'auth-jwt',
    cwd: '/repo/authapi',
    records: [
      user('add JWT authentication middleware to the express app', at(1, 0)),
      edit('/repo/authapi/src/auth/middleware.ts', at(1, 1)),
      bash('pnpm test auth', at(1, 2)),
      think('token rotation and expiry strategy', at(1, 3)),
    ],
  },
  {
    id: 'auth-oauth',
    cwd: '/repo/authapi',
    records: [
      user('debug the oauth callback loop', at(8, 0)),
      toolError('invalid_redirect_uri', at(8, 1)),
      read('/repo/authapi/src/auth/middleware.ts', at(8, 2)),
      asst('the redirect allowlist was missing the callback url', at(8, 3)),
    ],
  },
  {
    id: 'docker-dev',
    cwd: '/repo/shop',
    records: [
      user('set up containers for local development', at(2, 0)),
      bash('docker compose up', at(2, 1)),
      toolError('ECONNREFUSED 127.0.0.1:5432', at(2, 2)),
      asst('the postgres container was still starting', at(2, 3)),
    ],
  },
  {
    id: 'css-navbar',
    cwd: '/repo/shop',
    records: [
      user('fix the navbar layout on mobile', at(3, 0)),
      edit('/repo/shop/src/styles.css', at(3, 1)),
      asst('switched the navbar to flexbox with a wrapping row', at(3, 2)),
    ],
  },
  {
    id: 'perf-planner',
    cwd: '/repo/shop',
    records: [
      user('memoize the query planner', at(4, 0)),
      think('an lru cache with size-based eviction should be enough', at(4, 1)),
      bash('bun test planner', at(4, 2)),
    ],
  },
  {
    id: 'db-migration',
    cwd: '/repo/shop',
    records: [
      user('write the schema migration for orders', at(5, 0)),
      bash('psql -f migrations/0042_orders.sql', at(5, 1)),
      toolError('relation "orders" does not exist', at(5, 2)),
    ],
  },
  {
    id: 'flaky-test',
    cwd: '/repo/shop',
    records: [
      user('fix the flaky test hang in ci', at(6, 0)),
      edit('/repo/shop/vitest.config.ts', at(6, 1)),
      asst('increased testTimeout and stubbed the clock', at(6, 2)),
    ],
  },
  {
    id: 'release-14',
    cwd: '/repo/shop',
    records: [user('cut the 1.4.0 release', at(7, 0)), bash('gh release create v1.4.0', at(7, 1))],
  },
  {
    id: 'react-upgrade',
    cwd: '/repo/shop',
    records: [
      user('upgrade react to version 19', at(9, 0)),
      bash('npm install react@19', at(9, 1)),
      toolError('ERESOLVE unable to resolve dependency tree', at(9, 2)),
    ],
  },
  {
    id: 'logging',
    cwd: '/repo/shop',
    records: [user('add structured logging to the worker', at(10, 0)), edit('/repo/shop/src/logger.ts', at(10, 1))],
  },
  {
    id: 'rank-tune',
    cwd: '/repo/sessions',
    records: [
      user('tune the bm25 column weights', at(11, 0)),
      edit('/repo/sessions/src/cache.ts', at(11, 1)),
      asst('recall looked better with paths weighted up', at(11, 2)),
    ],
  },
  {
    // Noise floor: a session with no distinctive vocabulary. Goldens use it to
    // prove filters don't pull in generic chatter.
    id: 'chatter',
    cwd: '/repo/shop',
    records: [user('thanks, that worked perfectly', at(12, 0)), asst('glad to hear it', at(12, 1))],
  },
  {
    id: 'golang-api',
    cwd: '/repo/api',
    records: [
      user('add pagination to the handlers', at(14, 0)),
      bash('go test ./...', at(14, 1)),
      asst('the cursor token encodes the last id', at(14, 2)),
    ],
  },
];

function writeClaude(claudeDir: string, f: Fixture): void {
  const dir = join(claudeDir, 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = f.records.map((r) => j({ ...r, cwd: f.cwd })).join('\n');
  writeFileSync(join(dir, `${f.id}.jsonl`), lines);
}

function writePi(piDir: string): void {
  const dir = join(piDir, 'proj');
  mkdirSync(dir, { recursive: true });
  const records: Rec[] = [
    { type: 'session', id: 'pi-flag', timestamp: '2026-06-13T17:00:00.000Z', cwd: '/repo/cli' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-06-13T17:00:01.000Z' },
    {
      type: 'message',
      id: 'u1',
      parentId: 'm1',
      timestamp: '2026-06-13T17:01:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'rename the --all flag to --everywhere' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-06-13T17:02:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'updated the help output and completions' }] },
    },
  ];
  writeFileSync(join(dir, 'pi-flag.jsonl'), records.map(j).join('\n'));
}

export function seedEvalCorpus(dirs: { claudeDir: string; piDir: string }): void {
  for (const f of CLAUDE_FIXTURES) writeClaude(dirs.claudeDir, f);
  writePi(dirs.piDir);
}
