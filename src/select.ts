import { which } from 'bun';
import { C } from './colors';

export async function selectSession(lines: string[]): Promise<string | null> {
  if (which('fzf')) {
    return selectWithFzf(lines);
  }
  return selectBuiltin(lines);
}

async function selectWithFzf(lines: string[]): Promise<string | null> {
  // --preview runs the binary's hidden --preview subcommand on field 1 (filePath).
  // {1:q} shell-quotes the path so spaces/special chars don't break the command.
  const previewCmd = buildPreviewShellCommand();
  const proc = Bun.spawn(
    [
      'fzf',
      '--exact',
      '--ansi',
      '--header=Select a session  ● exists  ○ deleted  · ctrl-p preview',
      '--with-nth=7..',
      '--delimiter=\t',
      '--reverse',
      '--height=~60%',
      '--no-info',
      '--preview-window=hidden:wrap',
      '--bind=ctrl-p:toggle-preview',
      `--preview=${previewCmd}`,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  for (const line of lines) {
    proc.stdin.write(line + '\n');
  }
  proc.stdin.flush();
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;

  const output = await new Response(proc.stdout).text();
  return output.trim() || null;
}

/** The argv prefix that re-enters this binary: `bun index.ts` when run from source,
 *  the compiled binary itself otherwise. fzf --preview runs it via `sh -c`.
 *  In a compiled binary argv[0] is literally "bun" and argv[1] is the virtual
 *  /$bunfs/root/... entry path — process.execPath is the real binary. Using argv[0]
 *  made the preview command `bun --preview <file>`, and bun then tried to run the
 *  session's JSONL as a script, flooding the pane with parse errors. */
export function previewArgv(script = process.argv[1] ?? '', exe = process.execPath): string[] {
  const fromSource = !script.includes('$bunfs') && /\.(ts|js|mjs|cjs)$/.test(script);
  return fromSource ? [exe, script, '--preview'] : [exe, '--preview'];
}

/** Preview command string for fzf `--preview`. {1} is fzf's field-1 placeholder —
 *  fzf auto single-quotes the expansion, so no manual quoting of the path is needed.
 *  The exe/script paths come from this process's own argv and carry no spaces in
 *  practice (homebrew / install dirs), so they're passed bare. */
function buildPreviewShellCommand(): string {
  return [...previewArgv(), '{1}'].join(' ');
}

async function selectBuiltin(lines: string[]): Promise<string | null> {
  const maxDisplay = Math.min(lines.length, 20);

  process.stderr.write(`${C.bold}Select a session${C.reset}  ● exists  ○ deleted\n\n`);

  for (let i = 0; i < maxDisplay; i++) {
    const display = lines[i]!.split('\t').slice(6).join('\t');
    process.stderr.write(`  ${C.dim}${String(i + 1).padStart(2)}${C.reset}  ${display}\n`);
  }
  if (lines.length > maxDisplay) {
    process.stderr.write(
      `  ${C.dim}... and ${lines.length - maxDisplay} more (install fzf for full search)${C.reset}\n`,
    );
  }

  process.stderr.write(
    `\n${C.bold}Enter number (1-${maxDisplay})${C.reset}, or ${C.cyan}<num>p${C.reset} to preview: `,
  );

  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();

  if (!value) return null;
  const input = new TextDecoder().decode(value).trim();
  const previewMatch = input.match(/^(\d+)p$/i);
  if (previewMatch) {
    const num = parseInt(previewMatch[1]!, 10);
    if (isNaN(num) || num < 1 || num > maxDisplay) return null;
    await showBuiltinPreview(lines[num - 1]!);
    return selectBuiltin(lines); // re-prompt after previewing
  }

  const num = parseInt(input, 10);
  if (isNaN(num) || num < 1 || num > maxDisplay) return null;

  return lines[num - 1] ?? null;
}

/** Shell out to the hidden --preview subcommand and print its output above the next prompt. */
async function showBuiltinPreview(line: string): Promise<void> {
  const filePath = line.split('\t')[0]!;
  process.stderr.write('\n');
  const proc = Bun.spawn([...previewArgv(), filePath], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const text = await new Response(proc.stdout).text();
  process.stderr.write(text);
  process.stderr.write(`\n${C.dim}──────────${C.reset}\n\n`);
}
