import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabases, makeTmp, setMemoryEnv } from './memory/fixtures';
import { PLUGIN_FILES } from './plugin-files';

// prompts/list and prompts/get have no run* seam either, so everything here goes through an
// in-memory Client. The load-bearing assertion is not "a prompt exists" but "its text is the
// embedded SKILL.md body": the four workflows already ship to Claude Code as skills, and a
// hand-copied string in src/mcp.ts would drift from them with nothing to detect it.

let tmp: string;
let mcp: typeof import('./mcp');

/** Sorted, because prompts/list order is not a guarantee worth asserting. */
const PROMPT_NAMES = ['context', 'recall', 'standup', 'weekly-summary'];

interface SkillKeyByName {
  [prompt: string]: string;
}
const SKILL_KEYS: SkillKeyByName = {
  standup: 'skills/standup/SKILL.md',
  'weekly-summary': 'skills/weekly-summary/SKILL.md',
  context: 'skills/context/SKILL.md',
  recall: 'skills/recall/SKILL.md',
};

/** Valid arguments per prompt: `recall` requires a topic, the other three take none. */
interface ValidArgsByName {
  [prompt: string]: Record<string, string>;
}
const VALID_ARGS: ValidArgsByName = {
  standup: {},
  'weekly-summary': {},
  context: {},
  recall: { topic: 'retry backoff' },
};

/**
 * A prompt message's content is a union (text / image / audio / resource_link / resource),
 * so `.text` needs narrowing. Every prompt this server serves is text, and asserting that
 * here means a future non-text content type fails loudly instead of stringifying to
 * "undefined" and quietly passing the `not.toContain` assertions below.
 */
function textOf(content: { type: string }): string {
  if (content.type !== 'text') throw new Error(`expected text content, got ${content.type}`);
  // SAFETY: the throw above establishes content is the text variant of the union.
  return (content as { type: 'text'; text: string }).text;
}

/**
 * The frontmatter split, written independently of the implementation's own helper. A test
 * that called the same function could not catch a stripper that cuts in the wrong place.
 */
function embeddedBody(name: string): string {
  const raw = PLUGIN_FILES[SKILL_KEYS[name]!]!;
  const end = raw.indexOf('\n---\n', 3);
  return raw.slice(end + 5);
}

async function connect(): Promise<Client> {
  const server = mcp.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sessions-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

beforeAll(async () => {
  // No index is needed — prompt handlers return text — but the env still has to point away
  // from the developer's real ~/.cache and ~/.local/share, since createServer() wires up
  // every tool as well.
  tmp = makeTmp('mcp-prompts');
  setMemoryEnv(tmp);
  mcp = await import('./mcp');
});

beforeEach(() => {
  setMemoryEnv(tmp);
});

afterAll(() => {
  closeDatabases();
  rmSync(tmp, { recursive: true, force: true });
});

describe('prompt surface', () => {
  test('prompts/list returns exactly the four workflows, each with a title and description', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();

    // A name list, not a count: session-metrics and memory are deliberately absent because
    // their tools already serve every client, and a count would not notice one appearing.
    expect(prompts.map((p) => p.name).sort()).toEqual(PROMPT_NAMES);
    for (const p of prompts) {
      expect(p.title).toBeTypeOf('string');
      expect(p.title!.length).toBeGreaterThan(0);
      expect(p.description!.length).toBeGreaterThan(40);
      // The description is lifted out of the skill's frontmatter, so it must not still be
      // carrying the YAML that produced it.
      expect(p.description).not.toContain('description:');
      expect(p.description).not.toContain('\n');
    }
    await client.close();
  });

  test('prompt arguments are minimal and string-typed: only recall requires one', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const args = (name: string) => prompts.find((p) => p.name === name)!.arguments ?? [];

    expect(args('standup')).toEqual([]);
    expect(args('weekly-summary').map((a) => [a.name, a.required])).toEqual([['weeksAgo', false]]);
    expect(args('context').map((a) => [a.name, a.required])).toEqual([['cwd', false]]);
    expect(args('recall').map((a) => [a.name, a.required])).toEqual([['topic', true]]);
    // Every argument is documented — prompts/list is all a non-Claude client has to go on.
    for (const name of PROMPT_NAMES) {
      for (const a of args(name)) expect(a.description!.length).toBeGreaterThan(10);
    }
    await client.close();
  });

  test('every prompts/get returns one non-empty user message sourced from the embedded skill', async () => {
    const client = await connect();
    for (const name of PROMPT_NAMES) {
      const res = await client.getPrompt({ name, arguments: VALID_ARGS[name]! });
      expect(res.messages.length).toBeGreaterThanOrEqual(1);
      const m = res.messages[0]!;
      expect(m.role).toBe('user');
      expect(m.content.type).toBe('text');
      const text = textOf(m.content);
      expect(text.length).toBeGreaterThan(100);
      // PLUGIN_FILES is the single source of truth: the message opens with the skill body
      // byte for byte, so editing plugin/skills/*/SKILL.md is the only way to change it.
      expect(text.startsWith(embeddedBody(name).trimEnd())).toBe(true);
    }
    await client.close();
  });

  test('no prompt leaks YAML frontmatter into its message', async () => {
    const client = await connect();
    for (const name of PROMPT_NAMES) {
      const res = await client.getPrompt({ name, arguments: VALID_ARGS[name]! });
      const text = textOf(res.messages[0]!.content);
      expect(text.startsWith('---')).toBe(false);
      expect(text).not.toContain('\n---\n');
      expect(text).not.toContain('description: >-');
      expect(text).not.toContain(`name: ${name}`);
    }
    await client.close();
  });

  test('prompts/get on recall without its required topic is rejected', async () => {
    const client = await connect();
    // Prompts reject where tools return isError, so this is a rejection assertion — and an
    // empty topic is refused too, since recall over everything is just a search.
    await expect(client.getPrompt({ name: 'recall' })).rejects.toThrow(/recall/);
    await expect(client.getPrompt({ name: 'recall', arguments: { topic: '' } })).rejects.toThrow(/recall/);
    await client.close();
  });

  test('prompt arguments reach the message as an explicit trailing instruction', async () => {
    const client = await connect();

    const recall = await client.getPrompt({ name: 'recall', arguments: { topic: 'retry backoff' } });
    expect(textOf(recall.messages[0]!.content)).toContain('Topic to recall: retry backoff');

    const weekly = await client.getPrompt({ name: 'weekly-summary', arguments: { weeksAgo: '2' } });
    expect(textOf(weekly.messages[0]!.content)).toContain('2 week(s) before today');

    const ctx = await client.getPrompt({ name: 'context', arguments: { cwd: '/repos/live' } });
    expect(textOf(ctx.messages[0]!.content)).toContain('/repos/live');
    await client.close();
  });

  test('a non-numeric weeksAgo falls back to the skill default instead of a nonsense window', async () => {
    const client = await connect();
    // The wire type for a prompt argument is string, so the handler — not the schema — has to
    // decide what an unparseable value means. Silently ignoring it beats instructing the
    // model to cover "NaN week(s)".
    for (const weeksAgo of ['banana', '0', '-3']) {
      const res = await client.getPrompt({ name: 'weekly-summary', arguments: { weeksAgo } });
      expect(textOf(res.messages[0]!.content)).not.toContain('week(s) before today');
    }
    await client.close();
  });

  test('a missing PLUGIN_FILES key fails at registration rather than serving an empty prompt', () => {
    const key = SKILL_KEYS.standup!;
    const saved = PLUGIN_FILES[key]!;
    // Simulates a renamed or dropped skill, which is otherwise invisible: the generated embed
    // is rebuilt by `bun run build`, and nothing else links these keys to plugin/ on disk.
    delete PLUGIN_FILES[key];
    try {
      expect(() => mcp.createServer()).toThrow(/generate-plugin-embed/);
    } finally {
      PLUGIN_FILES[key] = saved;
    }
    // And the very next createServer() is healthy again — the throw is not sticky state.
    expect(() => mcp.createServer()).not.toThrow();
  });
});
