import { test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRecord } from './record';
import { getMemoryDb, setAlwaysOn, setState, upsertCandidates } from './store';
import type { MemoryRecord, MemoryScope } from './types';
import { closeDatabases, makeTmp, setMemoryEnv } from './fixtures';

// THE PROVENANCE GUARD, as a test instead of a hope. Triage state — approve, reject,
// and above all `alwaysOn`, whose rows an agent is told to treat as binding and are
// served ahead of everything — must only ever change through a human at the CLI.
// The MCP surface is where models sit, so the invariant is: no MCP path writes the
// memory store. Today that is true by construction (every tool is a SELECT); this
// file exists so it stays true on purpose. A future write tool must consciously
// break BOTH assertions here and say why, the same way no-repo-writes.test.ts makes
// "never write into the user's repo" a decision rather than a habit.
//
// The two assertions are deliberately different kinds of proof: the annotations
// check catches a write tool being ADDED (a declaration a reviewer sees), and the
// byte-compare catches a "read-only" tool that mutates as a side effect (behavior a
// declaration can lie about).

const REPO: MemoryScope = { type: 'repo', key: '/repos/app' };
const WORKFLOW: MemoryScope = { type: 'workflow', key: '' };

function record(text: string, scope: MemoryScope): MemoryRecord {
  return buildRecord({
    text,
    scope,
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
}

/** Every column of every row, timestamps included — rowToRecord's projection drops
 *  created_at/updated_at, and a mutation that only touched those would slip past it. */
function dumpStore(): string {
  const rows = getMemoryDb().query('SELECT * FROM memory ORDER BY id').all();
  return JSON.stringify(rows);
}

let tmp: string;
let mcp: typeof import('../mcp');

async function connect(): Promise<Client> {
  const server = mcp.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sessions-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

beforeAll(async () => {
  tmp = makeTmp('memory-readonly');
  setMemoryEnv(tmp);
  closeDatabases();
  mcp = await import('../mcp');

  // One row in every state a write could disturb: an untriaged candidate, a plain
  // approval, a standing constraint, and a snooze with its expiry.
  const candidate = record('Always run the migrations before starting the dev server', REPO);
  const approved = record('Never rewrite the lockfile by hand, run the installer', REPO);
  const standing = record('Never commit directly to main on any repo', WORKFLOW);
  const snoozed = record('Always ask before force pushing to a shared branch', REPO);
  upsertCandidates([candidate, approved, standing, snoozed]);
  setState(approved.id, 'approved');
  setState(standing.id, 'approved');
  setAlwaysOn(standing.id, true);
  setState(snoozed.id, 'snoozed', '2026-12-01');
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

test('every MCP tool declares itself read-only — a write tool cannot land silently', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(0);
  for (const t of tools) {
    expect({ tool: t.name, annotations: t.annotations }).toEqual({
      tool: t.name,
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  }
  await client.close();
});

test('driving get_memory over the protocol leaves the store byte-identical', async () => {
  const before = dumpStore();
  const client = await connect();

  // Every shape of the call: scoped, topic-narrowed, and defaulted. The topic call is
  // the one that exercises the alwaysOn partition — the code nearest the flag.
  for (const args of [{ cwd: '/repos/app' }, { cwd: '/repos/app', topic: 'force pushing branches' }, {}]) {
    const res = await client.callTool({ name: 'get_memory', arguments: args });
    // Boolean(): the SDK reports success as an absent isError, not a false one.
    expect({ args, isError: Boolean(res.isError) }).toEqual({ args, isError: false });
  }

  await client.close();
  expect(dumpStore()).toBe(before);
});
