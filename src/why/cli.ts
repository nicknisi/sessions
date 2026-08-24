import { C, disableColors } from '../colors';
import { why, type WhyEvidence, type WhySessionEvidence } from './correlate';

function help(): never {
  process.stderr.write(`${C.bold}sessions why${C.reset} — why does this code exist?

Correlate a file, line, commit, or topic to the AI coding sessions behind it.
Read-only on git and the session index — nothing is ever written to any repo.

${C.bold}Usage:${C.reset}
  sessions why <path>              Commits that last touched a file, and their sessions
  sessions why <path>:<line>       The commit that last changed one line (git blame)
  sessions why <commit-ish>        One commit and the sessions that produced it
  sessions why "<free text>"       Sessions in this repo matching a topic (no git)

${C.bold}Options:${C.reset}
  --json           Emit the structured evidence as JSON
  --no-color       Disable ANSI color
  -h, --help       Show this help
`);
  process.exit(0);
}

function die(msg: string): never {
  process.stderr.write(`${C.red}error:${C.reset} ${msg}\n`);
  process.exit(1);
}

function render(evidence: WhyEvidence): void {
  const w = process.stdout;
  if (evidence.commit) {
    const c = evidence.commit;
    w.write(`${C.bold}${c.sha.slice(0, 12)}${C.reset} ${c.subject}\n`);
    w.write(`${C.dim}${c.authoredAt}${C.reset}\n`);
    if (c.merge) {
      w.write(`${C.dim}merge — the merge that landed this; the change itself is in its parents${C.reset}\n`);
    }
    if (c.trailers.length) w.write(`${C.dim}${c.trailers.join('; ')}${C.reset}\n`);
    w.write('\n');
  }

  if (evidence.sessions.length === 0 && evidence.unlandedAttempts.length === 0) {
    w.write(`${C.dim}No sessions correlate to this.${C.reset}\n`);
    return;
  }

  for (const s of evidence.sessions) renderSession(s);

  if (evidence.unlandedAttempts.length) {
    const n = evidence.unlandedAttempts.length;
    w.write(
      `${C.yellow}${n} session${n === 1 ? '' : 's'} touched this file with no commit in its history — possible abandoned attempt${C.reset}\n\n`,
    );
    for (const s of evidence.unlandedAttempts) renderSession(s);
  }
}

function renderSession(s: WhySessionEvidence): void {
  const w = process.stdout;
  const tag = s.confidence === 'files+time' ? `${C.green}files+time${C.reset}` : `${C.yellow}time-only${C.reset}`;
  w.write(`${C.bold}${s.headline || '(no title)'}${C.reset} ${C.dim}(${s.tool})${C.reset} [${tag}]\n`);
  w.write(`  ${C.dim}${s.startedAt || '?'} → ${s.endedAt ?? '?'}${C.reset}\n`);
  if (s.overlappingFiles.length) {
    w.write(`  ${C.dim}files: ${s.overlappingFiles.join(', ')}${C.reset}\n`);
  }
  for (const e of s.excerpts) {
    w.write(`  ${C.dim}${e.role}:${C.reset} ${e.text}\n`);
  }
  w.write(`  ${C.cyan}${s.resume}${C.reset}\n\n`);
}

export async function runWhy(argv: string[]): Promise<void> {
  let json = false;
  let target = '';
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') help();
    else if (arg === '--json') json = true;
    else if (arg === '--no-color') disableColors();
    else if (arg.startsWith('-')) die(`unknown option: ${arg}`);
    else if (!target) target = arg;
  }

  if (!target) die('a target is required — a path, path:line, commit-ish, or "free text"');

  const outcome = await why(target, process.cwd());
  if (outcome.kind === 'error') die(outcome.message);

  if (json) {
    process.stdout.write(JSON.stringify(outcome.evidence, null, 2) + '\n');
    return;
  }
  render(outcome.evidence);
}
