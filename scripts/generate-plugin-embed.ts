import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const pluginDir = join(import.meta.dir, '..', 'plugin');
const outPath = join(import.meta.dir, '..', 'src', 'plugin-files.ts');

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

const files = walk(pluginDir);
let out = '// Auto-generated from plugin/ directory. Do not edit manually.\n';
out += '// Regenerate with: bun run generate-plugin-embed\n\n';
out += 'export const PLUGIN_FILES: Record<string, string> = {\n';

for (const f of files.sort()) {
  const rel = relative(pluginDir, f);
  const content = readFileSync(f, 'utf-8');
  out += `  ${JSON.stringify(rel)}: ${JSON.stringify(content)},\n`;
}

out += '};\n';
writeFileSync(outPath, out);
process.stderr.write(`Generated ${outPath} (${files.length} files)\n`);
