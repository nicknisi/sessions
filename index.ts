import { basename } from 'node:path';
import { version } from './package.json';
import { parseArgs, getRepoRoot, toSearchOptions } from './src/cli';
import { C } from './src/colors';
import { scanSessions } from './src/scanner';
import { formatLine } from './src/display';
import { selectSession } from './src/select';
import { copyToClipboard } from './src/clipboard';
import { buildResumeCommand } from './src/search-format';
import type { Tool } from './src/types';

if (Bun.argv.includes('--version') || Bun.argv.includes('-v')) {
  process.stdout.write(`sessions ${version}\n`);
  process.exit(0);
}

if (Bun.argv.includes('--clear-cache')) {
  const { clearCache } = await import('./src/cache');
  clearCache();
  process.exit(0);
}

// Commands dispatch on the positional word only. Matching anywhere in argv
// (the old behavior) let a flag VALUE fire a command — `sessions wrapped
// --out cleanup` would have uninstalled the plugin and wiped the index.
const command = Bun.argv[2];

if (command === 'cleanup') {
  const { clearCache } = await import('./src/cache');
  const { runUninstall } = await import('./src/setup');
  runUninstall();
  clearCache();
  process.exit(0);
}

if (Bun.argv.includes('--mcp')) {
  const { startMcpServer } = await import('./src/mcp');
  await startMcpServer();
  await new Promise(() => {});
}

if (command === 'setup') {
  const { runSetup } = await import('./src/setup');
  runSetup({ hooks: Bun.argv.includes('--hooks') });
  process.exit(0);
}

if (command === 'uninstall') {
  const { runUninstall } = await import('./src/setup');
  runUninstall();
  process.exit(0);
}

if (command === 'report') {
  const { parseReportArgs, runReport } = await import('./src/report/index.ts');
  const opts = parseReportArgs(Bun.argv.slice(3));
  const res = await runReport(opts);
  if (!opts.stdout) {
    if (res.jsonPath) process.stderr.write(`wrote ${res.jsonPath}\n`);
    if (res.htmlPath) process.stderr.write(`wrote ${res.htmlPath}\n`);
  }
  if (res.htmlPath && !opts.out && !opts.stdout) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    Bun.spawnSync([opener, res.htmlPath]);
  }
  process.exit(0);
}

if (command === 'wrapped') {
  const { parseWrappedArgs, runWrapped } = await import('./src/wrapped/index.ts');
  const opts = parseWrappedArgs(Bun.argv.slice(3));
  const res = await runWrapped(opts);
  if (res.htmlPath) process.stderr.write(`wrote ${res.htmlPath}\n`);
  if (res.htmlPath && !opts.out && !opts.stdout) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    Bun.spawnSync([opener, res.htmlPath]);
  }
  process.exit(0);
}

if (command === 'context') {
  const { parseContextArgs, runContext } = await import('./src/context.ts');
  await runContext(parseContextArgs(Bun.argv.slice(3)));
  process.exit(0);
}

if (command === 'digest') {
  const { parseDigestArgs, runDigest } = await import('./src/digest.ts');
  await runDigest(parseDigestArgs(Bun.argv.slice(3)));
  process.exit(0);
}

if (command === 'memory') {
  const { runMemory } = await import('./src/memory/cli.ts');
  await runMemory(Bun.argv.slice(3));
  process.exit(0);
}

const args = parseArgs(Bun.argv.slice(2));
const repoRoot = getRepoRoot(args.scopeHere);

if (args.searchQuery) {
  process.stderr.write(`${C.dim}  searching sessions...${C.reset}`);
}

const { searchSessions } = await import('./src/cache');
const { query, opts } = toSearchOptions(args, repoRoot);
let results;
try {
  results = await searchSessions(query, opts);
} catch {
  results = await scanSessions(repoRoot, args.toolFilter, args.searchQuery); // no-index fallback
}

if (results.length === 0) {
  if (args.searchQuery) process.stderr.write('\r\x1b[K');
  process.stderr.write(`${C.dim}No sessions found.${C.reset}\n`);
  process.exit(0);
}

const cols = parseInt(process.env.COLUMNS ?? '80', 10);
const lines = results.map((r) => formatLine(r, cols));

if (args.searchQuery) process.stderr.write('\r\x1b[K');

const selection = await selectSession(lines);
if (!selection) process.exit(0);

const parts = selection.split('\t');
const fullPath = parts[0]!;
const tool = parts[1]!;
const sessionId = parts[2]!;
const exists = parts[3]!;
const prompt = parts[4]!;
const dirName = basename(fullPath);

process.stderr.write('\n');
process.stderr.write(`  ${C.bold}${dirName}${C.reset} ${C.dim}(${tool})${C.reset}\n`);
if (prompt) {
  process.stderr.write(`  ${C.dim}${prompt}${C.reset}\n`);
}
process.stderr.write('\n');

const resumeCmd = buildResumeCommand(tool as Tool, fullPath, sessionId);

if (exists === 'deleted') {
  process.stderr.write(`  ${C.red}○${C.reset} ${C.bold}${fullPath}${C.reset} no longer exists\n`);
  process.stderr.write(`  ${C.dim}Recreate the directory first, then resume:${C.reset}\n`);
  process.stderr.write('\n');
}

process.stderr.write(`  ${C.cyan}${resumeCmd}${C.reset}\n`);

const copied = await copyToClipboard(resumeCmd);
if (copied) {
  process.stderr.write(`  ${C.dim}(copied to clipboard)${C.reset}\n`);
}

process.stderr.write('\n');
