// The invocation contract, asserted against the PRODUCTION argv.
//
// Nothing here spawns anything, and nothing here needs an agent CLI installed. The
// point is the argv itself: roast's tool table is safe only because roast feeds the
// child numbers, and distill feeds it transcript prose. If the restriction ever falls
// out of the argv — a refactor, a flag rename, someone "simplifying" the array — that
// is a prompt-injection path onto the user's machine, and it must fail here first.

import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDb } from './cache';
import { createSandbox, detectDistillTool, distillTools, REQUIRED_RESTRICTION, runDistill } from './distill';
import { closeMemoryDb } from './memory';
import { applyTestEnv } from './test-preload';
import type { RoastRunner, RoastTool, SpawnContext } from './wrapped/roast';

const PROMPT = 'a prompt with spaces and a leading-looking --flag inside it';

describe('the distill tool table only offers CLIs it can restrict', () => {
  test('pi is absent — it has no restriction flag to verify', () => {
    expect(distillTools().map((t) => t.id)).toEqual(['claude', 'codex']);
    expect(distillTools().some((t) => t.bin === 'pi')).toBe(false);
  });

  test('every offered tool carries its restricting flag', () => {
    for (const tool of distillTools()) {
      const argv = tool.args(PROMPT);
      const required = REQUIRED_RESTRICTION[tool.id as keyof typeof REQUIRED_RESTRICTION];
      expect(required).toBeDefined();
      for (const flag of required) expect(argv).toContain(flag);
    }
  });

  test('claude gets both belts: plan mode and an explicit deny list', () => {
    const claude = distillTools().find((t) => t.id === 'claude')!;
    const argv = claude.args(PROMPT);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    const denied = argv[argv.indexOf('--disallowed-tools') + 1]!.split(',');
    for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']) expect(denied).toContain(t);
  });

  test('codex gets a first-class read-only sandbox', () => {
    const codex = distillTools().find((t) => t.id === 'codex')!;
    const argv = codex.args(PROMPT);
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  // The regression that motivated this file. `--disallowed-tools` is declared variadic
  // (`<tools...>`), so `--disallowed-tools A,B "the prompt"` makes the CLI read every
  // word of the prompt as another tool name: it exits 1 with `Permission deny rule
  // "..." matches no known tool` and the model never runs. Asserting only "the flag is
  // present" cannot see that; asserting the separator can.
  test('the prompt is the last argument and is fenced off from any variadic flag', () => {
    for (const tool of distillTools()) {
      const argv = tool.args(PROMPT);
      expect(argv[argv.length - 1]).toBe(PROMPT);
      // Exactly once: a prompt that also appeared as a flag value would be ambiguous.
      expect(argv.filter((a) => a === PROMPT)).toHaveLength(1);
      const before = argv[argv.length - 2];
      // Either an option terminator, or a positional-only subcommand form with no
      // variadic option anywhere near the prompt.
      const variadic = argv.includes('--disallowed-tools');
      if (variadic) expect(before).toBe('--');
      else expect(before).not.toBe('--sandbox');
    }
  });
});

describe('the child runs somewhere it can do no harm', () => {
  test('the sandbox is an empty directory under tmp, outside the repo', () => {
    const dir = createSandbox();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(resolve(dir).startsWith(resolve(tmpdir()))).toBe(true);
      expect(resolve(dir).startsWith(resolve(process.cwd()))).toBe(false);
      expect(Array.from(new Bun.Glob('*').scanSync({ cwd: dir, dot: true }))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The assertion above only proves createSandbox() can make a directory. It says
  // nothing about whether the run USES one — and until the production path created the
  // sandbox unconditionally, it could not: an injected runner got `cwd: undefined`, so
  // deleting `cwd:` from the spawn options left every distill test green. This drives a
  // whole run and inspects the context the runner was actually handed.
  describe('and the run proves it, not just the helper', () => {
    let tmp: string;
    let seen: SpawnContext | undefined;
    const runner: RoastRunner = async (_tool: RoastTool, _prompt: string, _ms: number, ctx?: SpawnContext) => {
      seen = ctx;
      return '[]';
    };

    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'sessions-distill-sandbox-'));
      const dir = join(tmp, 'claude', 'proj');
      mkdirSync(dir, { recursive: true });
      const base = { cwd: '/sandbox-corpus/app', sessionId: 'sandboxed-1', gitBranch: 'main' };
      const at = new Date().toISOString();
      writeFileSync(
        join(dir, 'sandboxed-1.jsonl'),
        [
          {
            ...base,
            type: 'user',
            timestamp: at,
            promptSource: 'typed',
            message: { role: 'user', content: [{ type: 'text', text: 'Why does the limiter trip on checkout?' }] },
          },
          {
            ...base,
            type: 'assistant',
            timestamp: at,
            message: { role: 'assistant', content: [{ type: 'text', text: 'A stale cached budget value.' }] },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );

      closeDb();
      closeMemoryDb();
      process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
      process.env.SESSIONS_MEMORY_DB = join(tmp, 'memory.db');
      process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
      process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
      process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
      process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
      process.env.SESSIONS_REFRESH_INTERVAL_MS = '0';

      const res = await runDistill({ runner, limit: 1, log: () => {} });
      expect(res.selected).toBe(1);
    });

    afterAll(() => {
      closeDb();
      closeMemoryDb();
      // Put the preload's redirection back: leaving these pointed at a deleted temp dir
      // aims every later file in this process at whatever resolves next.
      applyTestEnv();
      rmSync(tmp, { recursive: true, force: true });
    });

    test('the spawn options carry a cwd, under tmp and outside the repo', () => {
      expect(seen).toBeDefined();
      const cwd = seen!.cwd!;
      expect(typeof cwd).toBe('string');
      expect(cwd.length).toBeGreaterThan(0);
      expect(resolve(cwd).startsWith(resolve(tmpdir()))).toBe(true);
      expect(resolve(cwd).startsWith(resolve(process.cwd()))).toBe(false);
    });

    test('the scratch directory is torn down when the run ends', () => {
      expect(existsSync(seen!.cwd!)).toBe(false);
    });
  });
});

describe('detectDistillTool', () => {
  // Bun.which reads the environment as of process start, so mutating process.env.PATH
  // cannot make it miss — the explicit PATH argument is the only working seam, and it
  // is why "no agent CLI installed" is reachable on a machine that has three.
  test('an empty PATH finds nothing rather than falling back to an unrestricted CLI', () => {
    expect(detectDistillTool(undefined, '/nonexistent-distill-probe')).toBeNull();
    expect(detectDistillTool('claude', '/nonexistent-distill-probe')).toBeNull();
  });

  test('a preferred-but-absent tool yields null, never a substitute', () => {
    const tool = detectDistillTool('codex');
    if (tool) expect(tool.id).toBe('codex');
  });
});
