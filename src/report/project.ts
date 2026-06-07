// VENDORED VERBATIM from tokenmaxing/src/project.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
import { basename } from 'node:path';

// Match /<anything>/Developer/<repo>(/...) -> <repo>.
// Falls back to basename(path) for paths outside ~/Developer or for empty input.
const DEV_RE = /^\/[^/]+\/[^/]+\/Developer\/([^/]+)/;

export function resolveProject(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  const m = DEV_RE.exec(cwd);
  if (m && m[1]) return m[1];
  const b = basename(cwd);
  return b || 'unknown';
}
