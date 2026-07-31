/**
 * Locate the sessions repo root from the build's working directory.
 *
 * `import.meta.url` is not usable for this: Astro bundles these modules into
 * dist/.prerender/chunks/, so a path relative to the source file resolves
 * somewhere that does not exist. Walking up from cwd for the marketplace
 * manifest works in `astro dev` and `astro build` alike, and fails loudly
 * rather than silently reading nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find the sessions repo root above ${process.cwd()} ` +
      '(looked for .claude-plugin/marketplace.json). The site reads src/, ' +
      'plugin/ and package.json from there at build time.',
  );
}

/** A path inside the repo, e.g. repoPath('src', 'mcp.ts'). */
export const repoPath = (...parts: string[]): string => join(repoRoot(), ...parts);

/** Read a repo file as UTF-8, with the path in the error when it is missing. */
export function readRepoFile(...parts: string[]): string {
  const path = repoPath(...parts);
  if (!existsSync(path)) {
    throw new Error(`the site expected to read ${parts.join('/')} at build time, but ${path} does not exist`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * The released version, from the package.json release-please bumps.
 *
 * Read at build time rather than hardcoded, so the badge in the header cannot
 * drift from what `brew install` actually gives you. Throws rather than
 * falling back to a placeholder: a wrong version is worse than a failed build.
 */
export function readVersion(): string {
  const manifest = JSON.parse(readRepoFile('package.json'));
  if (typeof manifest.version !== 'string') {
    throw new Error('package.json has no string "version"');
  }
  return manifest.version;
}
