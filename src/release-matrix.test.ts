import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// Guards the release build matrix so a target or artifact name can never
// silently drop or drift. mise's `github:` backend selects an asset by the
// os/arch tokens in its filename, so every compile target must ship a tarball
// named `sessions-<os>-<arch>` with the tokens mise recognizes.
const workflow = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');

// (bun compile target, published artifact base name)
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['bun-darwin-arm64', 'sessions-darwin-arm64'],
  ['bun-darwin-x64', 'sessions-darwin-x86_64'],
  ['bun-linux-x64', 'sessions-linux-x86_64'],
  ['bun-linux-arm64', 'sessions-linux-arm64'],
];

describe('release matrix', () => {
  for (const [target, artifact] of EXPECTED) {
    test(`${target} -> ${artifact}`, () => {
      expect(workflow).toContain(`target: ${target}`);
      expect(workflow).toContain(`artifact: ${artifact}`);
    });
  }

  test('every matrix target has exactly one artifact', () => {
    const targets = [...workflow.matchAll(/^\s*target: (\S+)/gm)].map((m) => m[1]);
    const artifacts = [...workflow.matchAll(/^\s*artifact: (\S+)/gm)].map((m) => m[1]);
    expect(targets.sort()).toEqual(EXPECTED.map(([t]) => t).sort());
    expect(artifacts.sort()).toEqual(EXPECTED.map(([, a]) => a).sort());
  });

  test('linux arm64 counterpart matches x86_64 naming convention', () => {
    const linux = EXPECTED.filter(([, a]) => a.startsWith('sessions-linux-'));
    expect(linux.map(([, a]) => a).sort()).toEqual(['sessions-linux-arm64', 'sessions-linux-x86_64']);
  });
});

// Guards the Homebrew tap update step. The formula sha256 for each artifact is
// keyed by the exact published tarball name, and every substitution must match
// exactly once so a missing tap branch (e.g. the coordinated Linux ARM64
// branch) fails the release instead of silently publishing a stale checksum.
describe('homebrew formula update', () => {
  const TARBALLS = EXPECTED.map(([, a]) => `${a}.tar.gz`);

  test('computes a sha256 for every published artifact', () => {
    for (const tarball of TARBALLS) {
      expect(workflow).toContain(`shasum -a 256 ${tarball}`);
    }
  });

  test('maps each exact artifact filename to its checksum', () => {
    for (const tarball of TARBALLS) {
      expect(workflow).toContain(`'${tarball}': os.environ[`);
    }
    // Exactly four artifact keys, no broad arch/os regex that could collide.
    const keys = [...workflow.matchAll(/'(sessions-[^']+\.tar\.gz)':/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...TARBALLS].sort());
  });

  test('requires exactly one substitution per artifact', () => {
    expect(workflow).toContain('if n != 1:');
    expect(workflow).toContain('pattern.subn(');
  });

  test('accepts the coordinated Linux ARM64 placeholder', () => {
    expect(workflow).toContain('PLACEHOLDER_');
    expect(workflow).toContain('SHA_LINUX_ARM64');
    expect(workflow).toContain('sessions-linux-arm64.tar.gz');
  });
});
