import { describe, test, expect } from 'bun:test';
import { extractFiles, extractFilesRead, MAX_FILES } from './extract-files';
import type { JsonObject, JsonValue } from './extract-util';

function jsonl(...objs: JsonObject[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

function claudeToolUse(name: string, input: JsonObject): JsonObject {
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
  function applyPatch(input: string): JsonObject {
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

describe('extractFiles — opencode', () => {
  function ocAssistant(...content: JsonObject[]): JsonObject {
    return { type: 'message', message: { role: 'assistant', content } };
  }
  function tool(name: string, input: JsonObject): JsonObject {
    return { type: 'tool', tool: name, state: { status: 'completed', input } };
  }

  test('collects edit/write filePaths and patch file lists, deduped', () => {
    const lines = jsonl(
      ocAssistant(
        tool('edit', { filePath: '/repo/a.ts' }),
        tool('write', { filePath: '/repo/b.ts' }),
        { type: 'patch', files: ['/repo/a.ts', '/repo/c.ts'] }, // a.ts is a duplicate
      ),
    );
    expect(extractFiles(lines, 'opencode')).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  });

  test('parses apply_patch headers like codex', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: /repo/new.ts',
      '+export const x = 1;',
      '*** Update File: /repo/existing.ts',
      '*** End Patch',
    ].join('\n');
    expect(extractFiles(jsonl(ocAssistant(tool('apply_patch', { patchText }))), 'opencode')).toEqual([
      '/repo/new.ts',
      '/repo/existing.ts',
    ]);
  });

  test('read targets: read filePath, grep/glob path or pattern (not edited files)', () => {
    const lines = jsonl(
      ocAssistant(
        tool('read', { filePath: '/repo/read.ts' }),
        tool('grep', { pattern: 'foo', path: '/repo/src' }),
        tool('glob', { pattern: 'packages/**/x*' }),
        tool('edit', { filePath: '/repo/edited.ts' }),
      ),
    );
    expect(extractFilesRead(lines, 'opencode')).toEqual(['/repo/read.ts', '/repo/src', 'packages/**/x*']);
    expect(extractFiles(lines, 'opencode')).toEqual(['/repo/edited.ts']);
  });
});

describe('extractFiles — pi', () => {
  // Fixture blocks are sanitized lines lifted from a real ~/.pi/agent/sessions log
  // (2026-08-04): assistant `type:'message'` lines whose content[] carry
  // `{type:'toolCall', name, arguments:{path}}` blocks.
  function piAssistant(...content: JsonObject[]): JsonObject {
    return { type: 'message', message: { role: 'assistant', content } };
  }
  function toolCall(name: string, args: JsonObject): JsonObject {
    return { type: 'toolCall', id: `${name}_1`, name, arguments: args };
  }

  test('collects edit + write arguments.path, deduped and in first-seen order', () => {
    const lines = jsonl(
      piAssistant(
        { type: 'text', text: 'fixing' },
        toolCall('edit', { path: '/Users/x/Developer/arc/src/cli.ts', edits: [] }),
      ),
      piAssistant(toolCall('write', { path: '/Users/x/Developer/arc/package.json', content: '{}' })),
      piAssistant(toolCall('edit', { path: '/Users/x/Developer/arc/src/cli.ts', edits: [] })), // duplicate
    );
    expect(extractFiles(lines, 'pi')).toEqual([
      '/Users/x/Developer/arc/src/cli.ts',
      '/Users/x/Developer/arc/package.json',
    ]);
  });

  test('accepts toolName as well as name (result-block key)', () => {
    const lines = jsonl(
      piAssistant({ type: 'toolCall', id: 'edit_1', toolName: 'edit', arguments: { path: '/repo/a.ts' } }),
    );
    expect(extractFiles(lines, 'pi')).toEqual(['/repo/a.ts']);
  });

  test('ignores read/other tools and malformed blocks (no arguments)', () => {
    const lines = jsonl(
      piAssistant(
        toolCall('read', { path: '/repo/read.ts' }),
        toolCall('bash', { command: 'ls' }),
        { type: 'toolCall', id: 'edit_2', name: 'edit' }, // no arguments
      ),
    );
    expect(extractFiles(lines, 'pi')).toEqual([]);
  });

  test('caps the result at MAX_FILES', () => {
    const lines = Array.from({ length: MAX_FILES + 10 }, (_, i) =>
      JSON.stringify(piAssistant(toolCall('edit', { path: `/repo/f${i}.ts` }))),
    );
    expect(extractFiles(lines, 'pi')).toHaveLength(MAX_FILES);
  });

  test('read targets: the read tool arguments.path, separate from edited files', () => {
    const lines = jsonl(
      piAssistant(
        toolCall('read', { path: '/repo/read.ts' }),
        toolCall('edit', { path: '/repo/edited.ts', edits: [] }),
      ),
    );
    expect(extractFilesRead(lines, 'pi')).toEqual(['/repo/read.ts']);
    expect(extractFiles(lines, 'pi')).toEqual(['/repo/edited.ts']);
  });
});

test('read: claude Read/Grep targets, separate from edited files', () => {
  const j = (o: JsonValue): string => JSON.stringify(o);
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/cache.ts' } }],
      },
    }),
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/parser.ts' } }],
      },
    }),
  ];
  expect(extractFilesRead(lines, 'claude')).toEqual(['/repo/src/cache.ts']);
  expect(extractFiles(lines, 'claude')).toEqual(['/repo/src/parser.ts']);
});
