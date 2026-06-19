import { describe, test, expect } from 'bun:test';
import { extractFiles, MAX_FILES } from './extract-files';

function jsonl(...objs: Record<string, unknown>[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

function claudeToolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}

describe('extractFiles — claude', () => {
  test('returns [] for a session with no edits', () => {
    const lines = jsonl(
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    );
    expect(extractFiles(lines, 'claude')).toEqual([]);
  });

  test('collects Edit/Write/MultiEdit paths, deduped and in first-seen order', () => {
    const lines = jsonl(
      claudeToolUse('Edit', { file_path: '/repo/a.ts' }),
      claudeToolUse('Write', { file_path: '/repo/b.ts' }),
      claudeToolUse('MultiEdit', { file_path: '/repo/c.ts' }),
      claudeToolUse('Edit', { file_path: '/repo/a.ts' }), // duplicate
    );
    expect(extractFiles(lines, 'claude')).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  });

  test('reads NotebookEdit from notebook_path', () => {
    const lines = jsonl(claudeToolUse('NotebookEdit', { notebook_path: '/repo/nb.ipynb' }));
    expect(extractFiles(lines, 'claude')).toEqual(['/repo/nb.ipynb']);
  });

  test('ignores non-editing tool_use blocks (Read, Bash)', () => {
    const lines = jsonl(claudeToolUse('Read', { file_path: '/repo/a.ts' }), claudeToolUse('Bash', { command: 'ls' }));
    expect(extractFiles(lines, 'claude')).toEqual([]);
  });

  test('caps the result at MAX_FILES', () => {
    const lines = Array.from({ length: MAX_FILES + 10 }, (_, i) =>
      JSON.stringify(claudeToolUse('Edit', { file_path: `/repo/f${i}.ts` })),
    );
    expect(extractFiles(lines, 'claude')).toHaveLength(MAX_FILES);
  });
});

describe('extractFiles — codex', () => {
  // Envelope confirmed against real ~/.codex/sessions logs: a response_item whose
  // payload is a custom_tool_call named apply_patch, with payload.input holding the patch.
  function applyPatch(input: string): Record<string, unknown> {
    return {
      type: 'response_item',
      payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', input },
    };
  }

  test('extracts Add + Update + Delete File paths from a real apply_patch envelope', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /repo/new.ts',
      '+export const x = 1;',
      '*** Update File: /repo/existing.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: /repo/gone.ts',
      '*** End Patch',
    ].join('\n');
    expect(extractFiles(jsonl(applyPatch(patch)), 'codex')).toEqual([
      '/repo/new.ts',
      '/repo/existing.ts',
      '/repo/gone.ts',
    ]);
  });

  test('dedupes paths touched by multiple patches', () => {
    const p1 = ['*** Begin Patch', '*** Update File: /repo/a.ts', '@@', '+x', '*** End Patch'].join('\n');
    const p2 = ['*** Begin Patch', '*** Update File: /repo/a.ts', '@@', '+y', '*** End Patch'].join('\n');
    expect(extractFiles(jsonl(applyPatch(p1), applyPatch(p2)), 'codex')).toEqual(['/repo/a.ts']);
  });

  test('returns [] for a codex session with no patches', () => {
    const lines = jsonl({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } });
    expect(extractFiles(lines, 'codex')).toEqual([]);
  });
});

describe('extractFiles — pi', () => {
  // TODO: Pi's edited-file shape is unconfirmed — no captured Pi session with file
  // edits exists yet. Per the spec's Open Items this branch returns [] until real
  // fixtures land. This test pins the documented current behavior.
  test('returns [] (branch deferred pending real fixtures)', () => {
    const lines = jsonl(
      { type: 'session', cwd: '/repo' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    );
    expect(extractFiles(lines, 'pi')).toEqual([]);
  });
});
