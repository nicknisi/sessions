import { describe, expect, test } from 'bun:test';
import { previewArgv } from './select';

describe('previewArgv', () => {
  test('compiled binary: re-enters the binary itself, not bun', () => {
    // In compiled binaries argv[0] is "bun" and argv[1] is the virtual
    // /$bunfs/root/... entry path; execPath is the real binary on disk.
    expect(previewArgv('/$bunfs/root/index', '/opt/homebrew/bin/sessions')).toEqual([
      '/opt/homebrew/bin/sessions',
      '--preview',
    ]);
  });

  test('run from source: re-enters via the runtime and script', () => {
    expect(previewArgv('/home/user/sessions/index.ts', '/usr/local/bin/bun')).toEqual([
      '/usr/local/bin/bun',
      '/home/user/sessions/index.ts',
      '--preview',
    ]);
  });

  test('extension-less script path is treated as compiled', () => {
    expect(previewArgv('/usr/local/bin/sessions', '/usr/local/bin/sessions')).toEqual([
      '/usr/local/bin/sessions',
      '--preview',
    ]);
  });
});
