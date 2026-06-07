// VENDORED VERBATIM from tokenmaxing/src/parsers/util.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function* walkJsonl(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.isFile() && full.endsWith('.jsonl')) {
      yield full;
    }
  }
}

export async function* readJsonlLines(path: string): AsyncGenerator<unknown> {
  const file = Bun.file(path);
  const text = await file.text();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip malformed line
    }
  }
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
const hourFmtCache = new Map<string, Intl.DateTimeFormat>();

function dateFmt(tz: string) {
  let f = dateFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFmtCache.set(tz, f);
  }
  return f;
}

function hourFmt(tz: string) {
  let f = hourFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    });
    hourFmtCache.set(tz, f);
  }
  return f;
}

export function localDate(isoUtc: string, tz: string): string {
  return dateFmt(tz).format(new Date(isoUtc));
}

export function localHour(isoUtc: string, tz: string): number {
  const parts = hourFmt(tz).formatToParts(new Date(isoUtc));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h) % 24;
}

// ISO-style week ending on Sunday in the given tz
export function weekEnding(localYmd: string): string {
  const [y, m, d] = localYmd.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = date.getUTCDay();
  const daysToSunday = (7 - dow) % 7;
  date.setUTCDate(date.getUTCDate() + daysToSunday);
  return date.toISOString().slice(0, 10);
}
