import { closeSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { createCommandsCollector } from './extract-commands';
import { createCustomContextCollector } from './extract-custom';
import { createErrorsCollector, type SessionErrors } from './extract-errors';
import { createFilesCollector, createFilesReadCollector } from './extract-files';
import { createThinkingCollector } from './extract-thinking';
import type { CappedTextState } from './extract-util';
import {
  createMessageStream,
  createMetadataCollector,
  sessionParentSession,
  summarizeTurns,
  type ExtractedMessage,
  type MessageSummary,
  type SessionMetadata,
} from './parser';
import {
  collectPiEntries,
  isPiTranscript,
  piTreeFromEntries,
  PI_SNIFF_LINES,
  type PiEntry,
  type PiFork,
} from './pi-tree';

/**
 * Streaming, resumable indexing of pi transcripts.
 *
 * Pi appends to its session files and never rewrites them, and long-lived agent
 * sessions reach hundreds of MB. Reading such a file whole holds the text plus every
 * extractor's parse of it at once, and re-reading it after each turn costs a full
 * parse for a few new lines. Here the file is read line by line and fed to the same
 * extractors in chunks (their Collector forms), and the extractor state is saved
 * with the byte offset where the last complete line ended, so the next refresh
 * parses only what was appended. The file's first bytes are hashed with the state:
 * a file that shrank or whose head changed is parsed again from the start.
 */

/** Bytes hashed from the start of a file to notice it was replaced. */
export const HEAD_BYTES = 4096;
/** Characters of complete lines handed to the extractors at once. */
export const CHUNK_CHARS = 16 * 1024 * 1024;
const READ_BYTES = 4 * 1024 * 1024;
const STATE_VERSION = 1;

/** The transcript could not be opened or read (vanished, unreadable): a source
 *  problem, unlike a database error, so the caller can fall back to another copy. */
export class TranscriptReadError extends Error {}

function openTranscript(filePath: string): number {
  try {
    return openSync(filePath, 'r');
  } catch (error) {
    throw new TranscriptReadError(String(error));
  }
}

function readTranscript(fd: number, buf: Buffer, length: number, position: number): number {
  try {
    return readSync(fd, buf, 0, length, position);
  } catch (error) {
    throw new TranscriptReadError(String(error));
  }
}

export function headHash(filePath: string, length: number): string {
  const fd = openTranscript(filePath);
  try {
    const buf = Buffer.alloc(length);
    const n = readTranscript(fd, buf, length, 0);
    return createHash('sha1').update(buf.subarray(0, n)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the lines between byte `start` and `end`, handing them to `onChunk` in file
 * order, about CHUNK_CHARS at a time. Returns the offset after the last line read.
 * A last line with no newline is read only if it is complete JSON; otherwise it is
 * a write in progress, and the returned offset stops before it so the next read
 * starts there.
 */
export function readLineChunks(
  filePath: string,
  start: number,
  end: number,
  onChunk: (lines: string[]) => void,
): number {
  const fd = openTranscript(filePath);
  try {
    const buf = Buffer.allocUnsafe(READ_BYTES);
    let pos = start;
    // A previous read took a complete last line that had no newline yet. The newline
    // written since ends that line; read as a line separator it would add an empty
    // line and shift every later line number by one. A real blank line follows a
    // newline, so it is kept.
    if (start > 0 && start < end) {
      const edge = Buffer.alloc(2);
      if (readTranscript(fd, edge, 2, start - 1) === 2 && edge[0] !== 10 && edge[1] === 10) pos = start + 1;
    }
    let consumed = pos;
    let carry: Buffer[] = [];
    let lines: string[] = [];
    let chars = 0;
    const push = (line: string): void => {
      lines.push(line);
      chars += line.length;
      if (chars >= CHUNK_CHARS) {
        onChunk(lines);
        lines = [];
        chars = 0;
      }
    };
    while (pos < end) {
      const n = readTranscript(fd, buf, Math.min(READ_BYTES, end - pos), pos);
      if (n === 0) break;
      const view = buf.subarray(0, n);
      let s = 0;
      for (let nl = view.indexOf(10, s); nl !== -1; nl = view.indexOf(10, s)) {
        if (carry.length) {
          carry.push(view.subarray(s, nl));
          push(Buffer.concat(carry).toString('utf8'));
          carry = [];
        } else {
          push(view.toString('utf8', s, nl));
        }
        s = nl + 1;
        consumed = pos + s;
      }
      // `buf` is reused by the next read, so a partial line is copied out.
      if (s < n) carry.push(Buffer.from(view.subarray(s)));
      pos += n;
    }
    if (carry.length) {
      const tail = Buffer.concat(carry).toString('utf8');
      if (parses(tail)) {
        push(tail);
        consumed = pos;
      }
    }
    if (lines.length) onChunk(lines);
    return consumed;
  } finally {
    closeSync(fd);
  }
}

/**
 * Tree entries saved column by column, compactly: they are one per transcript line,
 * so they are most of a state's size. Decoding is exact.
 */
interface SavedEntries {
  id: string[];
  /** 0: the previous entry's id (the usual case); otherwise the parentId as written. */
  parent: (string | null | 0)[];
  /** Milliseconds after the previous delta-coded timestamp, for a timestamp that Date's
   *  ISO form reproduces exactly; null when the timestamp is kept as written in tsRaw. */
  ts: (number | null)[];
  /** entry position → timestamp as written, for those `ts` cannot code (absent: none) */
  tsRaw: Record<number, string>;
  /** Line number minus the previous entry's. */
  line: number[];
  /** entry position → genuine user text, for the few entries that have one */
  user: Record<number, string>;
}

export interface PiIndexState {
  v: number;
  /** Bytes indexed: the end of the last complete line read. */
  offset: number;
  /** sha1 of the file's first headLen bytes when the state was saved. */
  head: string;
  headLen: number;
  /** Lines indexed, so resumed tree entries keep their file line numbers. */
  lines: number;
  nextIndex: number;
  /** Whether the file's first PI_SNIFF_LINES lines show pi's id/parentId tree. */
  tree: boolean;
  forkedFrom: string;
  meta: SessionMetadata;
  turns: { first: string; lastUser: string; lastAssistant: string };
  files: string[];
  filesRead: string[];
  commands: string[];
  errors: SessionErrors;
  thinking: CappedTextState;
  custom: CappedTextState;
  entries: SavedEntries;
}

/** Everything the session row and session-level FTS row need from one transcript. */
export interface SessionDoc {
  metadata: SessionMetadata;
  summary: MessageSummary;
  filesTouched: string[];
  filesRead: string[];
  commands: string[];
  errors: SessionErrors;
  thinking: string;
  customContext: string;
  forkedFrom: string;
  forks: PiFork[];
}

function loadEntries(saved: SavedEntries): PiEntry[] {
  let lineIndex = 0;
  let ms = 0;
  return saved.id.map((id, i) => {
    const p = saved.parent[i]!;
    lineIndex += saved.line[i]!;
    const entry: PiEntry = { id, parentId: p === 0 ? saved.id[i - 1]! : p, type: '', lineIndex };
    const t = saved.ts[i]!;
    if (t !== null) {
      ms += t;
      entry.timestamp = new Date(ms).toISOString();
    } else if (saved.tsRaw[i] !== undefined) {
      entry.timestamp = saved.tsRaw[i];
    }
    const user = saved.user[i];
    if (user !== undefined) entry.userText = user;
    return entry;
  });
}

function saveEntries(entries: PiEntry[]): SavedEntries {
  const saved: SavedEntries = { id: [], parent: [], ts: [], tsRaw: {}, line: [], user: {} };
  let lineIndex = 0;
  let ms = 0;
  entries.forEach((e, i) => {
    saved.id.push(e.id);
    saved.parent.push(i > 0 && e.parentId === entries[i - 1]!.id ? 0 : e.parentId);
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(t) && new Date(t).toISOString() === e.timestamp) {
      saved.ts.push(t - ms);
      ms = t;
    } else {
      saved.ts.push(null);
      if (e.timestamp !== undefined) saved.tsRaw[i] = e.timestamp;
    }
    saved.line.push(e.lineIndex - lineIndex);
    lineIndex = e.lineIndex;
    if (e.userText !== undefined) saved.user[i] = e.userText;
  });
  return saved;
}

/** Validate a saved state against the file as it is now; null means parse from the start. */
export function resumableState(filePath: string, raw: string | null, size: number): PiIndexState | null {
  if (!raw) return null;
  let state: PiIndexState;
  try {
    // SAFETY: only PiFileIndexer.state() writes this column, and a state written by
    // another layout fails the version check below.
    state = JSON.parse(raw) as PiIndexState;
  } catch {
    return null;
  }
  if (state.v !== STATE_VERSION || size < state.offset) return null;
  try {
    if (headHash(filePath, state.headLen) !== state.head) return null;
  } catch {
    return null;
  }
  return state;
}

/**
 * One pi file's extractors, fed chunks of lines in file order (from the start, or
 * resumed from a saved state). Emits each new message as it is found.
 */
export class PiFileIndexer {
  private readonly meta;
  private readonly messages;
  private readonly files;
  private readonly filesRead;
  private readonly commands;
  private readonly errors;
  private readonly thinking;
  private readonly custom;
  private readonly entries: PiEntry[];
  private readonly turns: { first: string; lastUser: string; lastAssistant: string };
  private lines: number;
  private tree: boolean;
  private forkedFrom: string;

  constructor(state?: PiIndexState) {
    this.meta = createMetadataCollector('pi', state?.meta);
    this.messages = createMessageStream(state?.nextIndex ?? 0);
    this.files = createFilesCollector('pi', state?.files);
    this.filesRead = createFilesReadCollector('pi', state?.filesRead);
    this.commands = createCommandsCollector('pi', state?.commands);
    this.errors = createErrorsCollector('pi', state?.errors);
    this.thinking = createThinkingCollector('pi', state?.thinking);
    this.custom = createCustomContextCollector('pi', state?.custom);
    this.entries = state ? loadEntries(state.entries) : [];
    this.turns = state ? { ...state.turns } : { first: '', lastUser: '', lastAssistant: '' };
    this.lines = state?.lines ?? 0;
    this.tree = state?.tree ?? false;
    this.forkedFrom = state?.forkedFrom ?? '';
  }

  /** The cwd from the session header, once read ('' before). */
  get cwd(): string {
    return this.meta.result().cwd;
  }

  add(lines: string[], emit: (message: ExtractedMessage) => void): void {
    if (this.lines === 0) this.forkedFrom = sessionParentSession(lines, 'pi');
    // Detection reads the file's first PI_SNIFF_LINES lines, which a short file may
    // not have yet; entries are collected either way, so a later detection loses none.
    if (!this.tree && this.lines < PI_SNIFF_LINES) {
      this.tree = isPiTranscript(lines.slice(0, PI_SNIFF_LINES - this.lines));
    }
    this.meta.add(lines);
    this.messages.add(lines, (message) => {
      if (message.role === 'user' && message.genuine) {
        if (!this.turns.first) this.turns.first = message.text;
        this.turns.lastUser = message.text;
      } else if (message.role === 'assistant') {
        this.turns.lastAssistant = message.text;
      }
      emit(message);
    });
    this.files.add(lines);
    this.filesRead.add(lines);
    this.commands.add(lines);
    this.errors.add(lines);
    this.thinking.add(lines);
    this.custom.add(lines);
    collectPiEntries(lines, this.lines, this.entries);
    this.lines += lines.length;
  }

  doc(): SessionDoc {
    return {
      metadata: this.meta.result(),
      summary: summarizeTurns(this.turns),
      filesTouched: this.files.result(),
      filesRead: this.filesRead.result(),
      commands: this.commands.result(),
      errors: this.errors.result(),
      thinking: this.thinking.result(),
      customContext: this.custom.result(),
      forkedFrom: this.forkedFrom,
      forks: this.tree ? piTreeFromEntries(this.entries).forks : [],
    };
  }

  state(filePath: string, offset: number): PiIndexState {
    const headLen = Math.min(HEAD_BYTES, offset);
    return {
      v: STATE_VERSION,
      offset,
      head: headHash(filePath, headLen),
      headLen,
      lines: this.lines,
      nextIndex: this.messages.nextIndex(),
      tree: this.tree,
      forkedFrom: this.forkedFrom,
      meta: this.meta.state(),
      turns: { ...this.turns },
      files: this.files.state(),
      filesRead: this.filesRead.state(),
      commands: this.commands.state(),
      errors: this.errors.state(),
      thinking: this.thinking.state(),
      custom: this.custom.state(),
      entries: saveEntries(this.entries),
    };
  }
}
