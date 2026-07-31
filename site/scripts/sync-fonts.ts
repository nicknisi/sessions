/**
 * Copy the five self-hosted faces out of the @fontsource packages into
 * public/fonts.
 *
 * The site makes no external requests — that rule is inherited from the report
 * and wrapped HTML, which are single files you can open with no network at all.
 * Fonts are the only asset that would otherwise reach for a CDN, so they are
 * vendored into the build output instead and the packages stay devDependencies.
 *
 * Run after `bun install`, or any time the font packages are bumped:
 *   bun run fonts
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(siteRoot, 'public', 'fonts');

/** [package, source basename, destination basename] */
const FACES: [string, string, string][] = [
  ['space-grotesk', 'space-grotesk-latin-400-normal.woff2', 'space-grotesk-400.woff2'],
  ['space-grotesk', 'space-grotesk-latin-500-normal.woff2', 'space-grotesk-500.woff2'],
  ['space-grotesk', 'space-grotesk-latin-700-normal.woff2', 'space-grotesk-700.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono-400.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-700-normal.woff2', 'jetbrains-mono-700.woff2'],
];

mkdirSync(out, { recursive: true });

let bytes = 0;
for (const [pkg, from, to] of FACES) {
  const src = join(siteRoot, 'node_modules', '@fontsource', pkg, 'files', from);
  if (!existsSync(src)) {
    // Fail loudly. A missing face silently falls back to system-ui, which looks
    // almost right and is exactly the kind of drift this repo keeps getting bitten by.
    throw new Error(`missing font file: ${src}\nRun \`bun install\` in site/ first.`);
  }
  copyFileSync(src, join(out, to));
  bytes += statSync(src).size;
}

console.log(`${FACES.length} faces → public/fonts (${(bytes / 1024).toFixed(1)} KB)`);
