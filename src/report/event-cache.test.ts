import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherEvents, type ReportRoots } from './extract.ts';
import { openEventCache, planRefresh, putFile, pruneMissing, statAll, getEventCachePath } from './event-cache.ts';
import { walkJsonl } from './parsers/walk.ts';
import type { ToolId } from './types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-evcache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let box = '';
let caseNo = 0;
let roots: ReportRoots;

beforeEach(() => {
  box = join(tmp, `case${caseNo++}`);
  mkdirSync(box, { recursive: true });
  process.env.SESSIONS_CACHE_DIR = join(box, 'cache');
  roots = { claudeCode: join(box, 'claude'), pi: join(box, 'no-pi'), codex: join(box, 'no-codex') };
  mkdirSync(roots.claudeCode, { recursive: true });
});

const CLAUDE: Set<ToolId> = new Set<ToolId>(['claude-code']);

function line(opts: { id: string; input?: number; sessionId?: string; agentId?: string }): string {
  const rec: Record<string, unknown> = {
    type: 'assistant',
    sessionId: opts.sessionId ?? 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: '2026-06-01T14:30:00Z',
    requestId: 'req_' + opts.id,
    message: {
      id: 'msg_' + opts.id,
      model: 'claude-opus-4-8',
      usage: { input_tokens: opts.input ?? 100, output_tokens: 10 },
    },
  };
  if (opts.agentId) {
    rec.agentId = opts.agentId;
    rec.isSidechain = true;
  }
  return JSON.stringify(rec) + '\n';
}

/** Write a transcript with a controlled mtime so cache staleness is deterministic. */
function write(rel: string, content: string, mtimeMs?: number): string {
  const p = join(roots.claudeCode, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  if (mtimeMs !== undefined) utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

describe('gatherEvents through the cache', () => {
  test('a warm run returns exactly what the cold run did', async () => {
    write('proj/a.jsonl', line({ id: '1' }) + line({ id: '2' }));
    const cold = await gatherEvents(roots, CLAUDE);
    const warm = await gatherEvents(roots, CLAUDE);
    expect(warm).toEqual(cold);
    expect(warm).toHaveLength(2);
  });

  test('and matches the uncached path exactly', async () => {
    write('proj/a.jsonl', line({ id: '1' }));
    write('proj/s1/subagents/agent-a7.jsonl', line({ id: '2', agentId: 'a7' }));
    writeFileSync(
      join(roots.claudeCode, 'proj/s1/subagents/agent-a7.meta.json'),
      JSON.stringify({ agentType: 'Explore' }),
    );
    const cached = await gatherEvents(roots, CLAUDE);
    const direct = await gatherEvents(roots, CLAUDE, { noCache: true });
    expect(cached).toEqual(direct);
    expect(cached.find((e) => e.agent)?.agent).toEqual({ id: 'a7', type: 'Explore' });
  });

  test('picks up an appended file rather than serving the stale parse', async () => {
    const p = write('proj/a.jsonl', line({ id: '1' }));
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
    writeFileSync(p, line({ id: '1' }) + line({ id: '2' }));
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(2);
  });

  test('a changed size invalidates even when the timestamp is unchanged', async () => {
    const p = write('proj/a.jsonl', line({ id: '1' }));
    const { mtimeMs } = statSync(p);
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
    // Restore the original mtime after appending, so size is the only signal
    // left. This is the restored-backup and same-millisecond-rewrite case.
    writeFileSync(p, line({ id: '1' }) + line({ id: '2' }));
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(2);
  });

  test('a changed timestamp invalidates even when the size is unchanged', async () => {
    const p = write('proj/a.jsonl', line({ id: '1', input: 111 }));
    const { mtimeMs } = statSync(p);
    expect((await gatherEvents(roots, CLAUDE))[0]!.tokens.input).toBe(111);
    // Same byte count (111 and 222 are both three digits), later timestamp.
    const before = statSync(p).size;
    writeFileSync(p, line({ id: '1', input: 222 }));
    expect(statSync(p).size).toBe(before);
    utimesSync(p, mtimeMs / 1000 + 60, mtimeMs / 1000 + 60);
    expect((await gatherEvents(roots, CLAUDE))[0]!.tokens.input).toBe(222);
  });

  test('drops events for a deleted transcript', async () => {
    const p = write('proj/a.jsonl', line({ id: '1' }));
    write('proj/b.jsonl', line({ id: '2' }));
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(2);
    rmSync(p);
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
  });

  test('dedupes the same response across files, warm as well as cold', async () => {
    write('proj/a.jsonl', line({ id: 'dup' }));
    write('proj/b.jsonl', line({ id: 'dup' }));
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
  });

  test('names a dispatch from a parent file cached in an earlier run', async () => {
    // The subagent transcript alone cannot name itself; the parent record can.
    // Both must survive a round trip through the cache.
    write('proj/s1/subagents/agent-a9.jsonl', line({ id: '1', agentId: 'a9' }));
    write(
      'proj/parent.jsonl',
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-06-01T14:31:00Z',
        toolUseResult: { agentId: 'a9', agentType: 'general-purpose' },
      }) + '\n',
    );
    await gatherEvents(roots, CLAUDE);
    const warm = await gatherEvents(roots, CLAUDE);
    expect(warm[0]!.agent).toEqual({ id: 'a9', type: 'general-purpose' });
  });

  test('a bounded run leaves the cache usable for a later unbounded one', async () => {
    write('proj/old.jsonl', line({ id: 'old' }), Date.parse('2026-01-01T00:00:00Z'));
    write('proj/new.jsonl', line({ id: 'new' }), Date.parse('2026-06-15T00:00:00Z'));
    // Bounded: the old file is never read...
    expect(await gatherEvents(roots, CLAUDE, { since: '2026-06-10' })).toHaveLength(1);
    // ...and the unbounded run that follows still sees it.
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(2);
  });

  test('a corrupt cache falls back to reading transcripts', async () => {
    write('proj/a.jsonl', line({ id: '1' }));
    await gatherEvents(roots, CLAUDE);
    writeFileSync(getEventCachePath(), 'not a database at all');
    expect(await gatherEvents(roots, CLAUDE)).toHaveLength(1);
  });
});

describe('cache bookkeeping', () => {
  test('planRefresh calls an unknown file stale and a matching one fresh', async () => {
    write('proj/a.jsonl', line({ id: '1' }));
    const db = openEventCache()!;
    const files = await statAll(walkJsonl(roots.claudeCode));
    expect(planRefresh(db, files).stale).toHaveLength(1);
    putFile(db, files[0]!, { events: [], agentTypes: {} });
    const after = planRefresh(db, files);
    expect(after.stale).toHaveLength(0);
    expect(after.fresh.size).toBe(1);
    db.close();
  });

  test('pruneMissing only evicts under the roots that were walked', async () => {
    const db = openEventCache()!;
    const stat = { path: '/elsewhere/other-tool/x.jsonl', mtimeMs: 1, size: 1 };
    putFile(db, stat, { events: [], agentTypes: {} });
    // Walking only the claude root must not evict a row belonging to another.
    expect(pruneMissing(db, new Set(), [roots.claudeCode])).toBe(0);
    // Naming its root does evict it.
    expect(pruneMissing(db, new Set(), ['/elsewhere'])).toBe(1);
    db.close();
  });

  test('no roots walked means nothing evicted', async () => {
    const db = openEventCache()!;
    putFile(db, { path: '/a/b.jsonl', mtimeMs: 1, size: 1 }, { events: [], agentTypes: {} });
    expect(pruneMissing(db, new Set(), [])).toBe(0);
    db.close();
  });
});
