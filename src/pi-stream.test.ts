// src/pi-stream.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JsonValue } from './extract-util';
import {
  extractMessages,
  extractSessionMetadata,
  sessionParentSession,
  summarizeMessages,
  type ExtractedMessage,
} from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import { extractCustomContext } from './extract-custom';
import { buildPiTree } from './pi-tree';
import { PiFileIndexer, readLineChunks, resumableState, type PiIndexState, type SessionDoc } from './pi-stream';

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pi-stream-test-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ts = (s: number): string =>
  `2026-08-04T17:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const msg = (id: string, parentId: string, s: number, message: JsonValue): string =>
  j({ type: 'message', id, parentId, timestamp: ts(s), message });
const user = (id: string, parentId: string, s: number, text: string): string =>
  msg(id, parentId, s, { role: 'user', content: [{ type: 'text', text }] });
const assistant = (id: string, parentId: string, s: number, content: JsonValue[]): string =>
  msg(id, parentId, s, { role: 'assistant', content });

// One transcript that gives every extractor something to find: a title, a /fork
// parent, edits/reads/bash calls, errors, thinking, custom context, and an abandoned
// /tree branch (u2,a2 fork off t1; the session continues from t1 with u3).
const LINES = [
  j({ type: 'session', id: 's1', timestamp: ts(0), cwd: '/repoPi', parentSession: '/x/parent.jsonl' }),
  j({ type: 'model_change', id: 'm1', parentId: null, timestamp: ts(1) }),
  user('u1', 'm1', 2, 'fix the login bug'),
  assistant('a1', 'u1', 3, [
    { type: 'thinking', thinking: 'the token check is inverted' },
    { type: 'text', text: 'Looking at auth.' },
    { type: 'toolCall', name: 'read', arguments: { path: 'src/auth.ts' } },
    { type: 'toolCall', name: 'bash', arguments: { command: 'bun test auth' } },
  ]),
  msg('t1', 'a1', 4, { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'auth test failed' }] }),
  user('u2', 't1', 5, 'try a rewrite instead'),
  assistant('a2', 'u2', 6, [{ type: 'text', text: 'Rewriting.' }]),
  user('u3', 't1', 7, 'no, keep the patch small'),
  assistant('a3', 'u3', 8, [
    { type: 'text', text: 'Patched the check.' },
    { type: 'toolCall', name: 'edit', arguments: { path: 'src/auth.ts' } },
  ]),
  j({ type: 'session_info', id: 'i1', parentId: 'a3', timestamp: ts(9), name: 'login bug' }),
  j({
    type: 'custom',
    id: 'c1',
    parentId: 'i1',
    timestamp: ts(10),
    customType: 'recap',
    data: { summary: 'recap: auth fixed' },
  }),
  j({
    type: 'custom_message',
    id: 'c2',
    parentId: 'c1',
    timestamp: ts(11),
    customType: 'intercom',
    content: 'ping from lead',
  }),
  msg('b1', 'c2', 12, { role: 'bashExecution', command: 'git status', exitCode: 1, output: 'not a repo' }),
  assistant('a4', 'b1', 13, [{ type: 'text', text: 'Done.' }]),
];

/** What writeSessionRow computes from the whole file. */
function wholeFileDoc(lines: string[]) {
  const messages = extractMessages(lines);
  return {
    messages,
    doc: {
      metadata: extractSessionMetadata(lines, 'pi'),
      summary: summarizeMessages(messages),
      filesTouched: extractFiles(lines, 'pi'),
      filesRead: extractFilesRead(lines, 'pi'),
      commands: extractCommands(lines, 'pi'),
      errors: extractErrors(lines, 'pi'),
      thinking: extractThinking(lines, 'pi'),
      customContext: extractCustomContext(lines, 'pi'),
      forkedFrom: sessionParentSession(lines, 'pi'),
      forks: buildPiTree(lines)?.forks ?? [],
    } satisfies SessionDoc,
  };
}

const indexed = (m: ExtractedMessage) => ({ role: m.role, text: m.text, index: m.index, genuine: m.genuine });

test('the whole-file fixture exercises every field', () => {
  const { doc } = wholeFileDoc(LINES);
  expect(doc.metadata.customTitle).toBe('login bug');
  expect(doc.filesTouched).toEqual(['src/auth.ts']);
  expect(doc.filesRead).toEqual(['src/auth.ts']);
  expect(doc.commands).toEqual(['bun test auth', 'git status']);
  expect(doc.errors.count).toBe(2);
  expect(doc.thinking).toContain('inverted');
  expect(doc.customContext).toContain('ping from lead');
  expect(doc.forkedFrom).toBe('/x/parent.jsonl');
  expect(doc.forks).toHaveLength(1);
});

test('fed in chunks, and resumed from saved JSON state after every chunk, the indexer equals one whole-file parse', () => {
  const expected = wholeFileDoc(LINES);
  const file = join(tmp, 'chunked.jsonl');
  writeFileSync(file, LINES.join('\n') + '\n');
  for (const size of [1, 2, 3, 5, LINES.length]) {
    let state: PiIndexState | undefined;
    const emitted: ExtractedMessage[] = [];
    let doc: SessionDoc | undefined;
    for (let start = 0; start < LINES.length; start += size) {
      // A fresh indexer per chunk, seeded from the previous chunk's state as the
      // index stores it (a JSON round trip), is the incremental refresh path.
      // SAFETY: a JSON round trip of a PiIndexState, as the index stores it.
      const indexer = new PiFileIndexer(state ? (JSON.parse(JSON.stringify(state)) as PiIndexState) : undefined);
      indexer.add(LINES.slice(start, start + size), (m) => emitted.push(m));
      state = indexer.state(file, 0);
      doc = indexer.doc();
    }
    expect({ size, doc }).toEqual({ size, doc: expected.doc });
    expect(emitted.map(indexed)).toEqual(expected.messages.map(indexed));
  }
});

test('readLineChunks stops before an unfinished last line and resumes there', () => {
  const file = join(tmp, 'growing.jsonl');
  const head = LINES.slice(0, 3).join('\n') + '\n';
  const partial = LINES[3]!.slice(0, 40);
  writeFileSync(file, head + partial);
  const seen: string[] = [];
  const end1 = readLineChunks(file, 0, Buffer.byteLength(head + partial), (lines) => seen.push(...lines));
  expect(seen).toEqual(LINES.slice(0, 3));
  expect(end1).toBe(Buffer.byteLength(head));

  appendFileSync(file, LINES[3]!.slice(40) + '\n' + LINES[4]);
  const total = Buffer.byteLength(LINES.slice(0, 5).join('\n'));
  const more: string[] = [];
  // The unterminated last line is complete JSON, so it is read and consumed.
  const end2 = readLineChunks(file, end1, total, (lines) => more.push(...lines));
  expect(more).toEqual(LINES.slice(3, 5));
  expect(end2).toBe(total);
});

test('a saved state is not resumed when the file shrank or its first bytes changed', () => {
  const file = join(tmp, 'rewritten.jsonl');
  const text = LINES.join('\n') + '\n';
  writeFileSync(file, text);
  const indexer = new PiFileIndexer();
  const end = readLineChunks(file, 0, Buffer.byteLength(text), (lines) => indexer.add(lines, () => {}));
  const saved = JSON.stringify(indexer.state(file, end));
  expect(resumableState(file, saved, Buffer.byteLength(text))?.offset).toBe(end);

  expect(resumableState(file, saved, end - 1)).toBeNull();

  writeFileSync(file, text.replace('/repoPi', '/repoPX'));
  expect(resumableState(file, saved, Buffer.byteLength(text))).toBeNull();
});
