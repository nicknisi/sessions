import { basename } from 'node:path';
import { parseArgs, getRepoRoot } from './src/cli';
import { C } from './src/colors';
import { scanSessions } from './src/scanner';
import { formatLine } from './src/display';
import { selectSession } from './src/select';
import { copyToClipboard } from './src/clipboard';

if (Bun.argv.includes('--clear-cache')) {
  const { clearCache } = await import('./src/cache');
  clearCache();
  process.exit(0);
}

if (Bun.argv.includes('--mcp')) {
  const { startMcpServer } = await import('./src/mcp');
  await startMcpServer();
  await new Promise(() => {});
}

if (Bun.argv.includes('setup')) {
  const { runSetup } = await import('./src/setup');
  runSetup();
  process.exit(0);
}

if (Bun.argv.includes('uninstall')) {
  const { runUninstall } = await import('./src/setup');
  runUninstall();
  process.exit(0);
}

const args = parseArgs(Bun.argv.slice(2));
const repoRoot = getRepoRoot(args.scopeHere);

if (args.searchQuery) {
  process.stderr.write(`${C.dim}  searching sessions...${C.reset}`);
}

const results = await scanSessions(repoRoot, args.toolFilter, args.searchQuery);

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

let resumeCmd = '';
if (tool === 'claude') {
  resumeCmd = `cd ${fullPath} && claude --resume ${sessionId}`;
} else if (tool === 'pi' || tool === 'codex') {
  resumeCmd = `cd ${fullPath}`;
}

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
