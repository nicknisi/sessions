// Index-backed content stats for wrapped — the fun-metric raw material that
// only message text can provide. All queries go through getIndexDb() (which
// refreshes first) and scope to the wrapped period by joining message_fts to
// sessions on file_path. Phrase counts use LIKE, never MATCH: porter stemming
// makes phrase queries fuzzy ("wait" matches "waiting") and MATCH counts rows
// anyway — LIKE over stored text is exact and case-insensitive for ASCII.

import type { Database } from 'bun:sqlite';
import { z } from 'zod';

import { getIndexDb } from '../cache.ts';
import { significanceScore, isTrivia, hasArtifact } from '../significance.ts';
import { resolveProject } from '../report/project.ts';
import { junkCwdSql } from './exclude.ts';
import type { PhraseStat, WrappedContentStats, WrappedSessionOfYear } from './types.ts';

/** Named SQLite bind parameters: keys are `$name` placeholders. */
interface SqlParams {
  [name: string]: string;
}

/** Index tool names ('claude') differ from report ToolIds ('claude-code'). */
interface IndexToolNames {
  [toolId: string]: string;
}
const INDEX_TOOL: IndexToolNames = { 'claude-code': 'claude', codex: 'codex', pi: 'pi', opencode: 'opencode' };

interface PhraseSpec {
  id: string;
  role: 'user' | 'assistant';
  /** OR-composed LIKE patterns. */
  patterns: string[];
}

// Messages-containing counts (not occurrences) — dispute-proof and cheap.
// user rows in message_fts are genuine turns only; msg_index >= 0 excludes
// subagent sentinel rows.
const PHRASES: PhraseSpec[] = [
  { id: 'absolutelyRight', role: 'assistant', patterns: ['%absolutely right%'] },
  { id: 'interrupts', role: 'user', patterns: ['%request interrupted%'] },
  { id: 'please', role: 'user', patterns: ['%please%'] },
  { id: 'thanks', role: 'user', patterns: ['%thanks%', '%thank you%'] },
  { id: 'actually', role: 'user', patterns: ['%actually%'] },
  { id: 'tryAgain', role: 'user', patterns: ['%try again%'] },
  { id: 'noWait', role: 'user', patterns: ['%no, wait%', '%no wait%', '%actually wait%'] },
  { id: 'swears', role: 'user', patterns: ['%fuck%', '%shit%', '%wtf%', '%damn%'] },
  { id: 'userSorry', role: 'user', patterns: ['%sorry%', '%apolog%'] },
  { id: 'assistantApology', role: 'assistant', patterns: ['%apolog%'] },
  { id: 'ultrathink', role: 'user', patterns: ['%ultrathink%'] },
  { id: 'quickQuestion', role: 'user', patterns: ['%quick question%', '%real quick%', '%just a quick%'] },
  { id: 'oneMoreThing', role: 'user', patterns: ['%one more thing%', '%one last thing%'] },
  { id: 'shouldWork', role: 'user', patterns: ['%should work%'] },
  {
    id: 'stillBroken',
    role: 'user',
    patterns: ['%still not working%', '%still broken%', '%still failing%', '%same error%'],
  },
  { id: 'areYouSure', role: 'user', patterns: ['%are you sure%'] },
  { id: 'hallucinate', role: 'user', patterns: ['%hallucinat%'] },
  { id: 'perfectExclaim', role: 'assistant', patterns: ['%perfect!%'] },
];

// Vocabulary mining: words we never crown. Common English + generic dev terms —
// the survivors are the user's own vocabulary, which is the whole joke.
const STOPWORDS = new Set(
  (
    'the and for that this with have from what when where which will would could should there their they them then than ' +
    'been being because before after about above below into over under again further once here both each more most other ' +
    'some such only same very just also them these those your yours ours mine hers his its our you are was were has had ' +
    'does did doing done can cannot cant dont wont isnt arent wasnt didnt doesnt shouldnt couldnt wouldnt not but who whom ' +
    'why how all any few nor too own so as of in on at by to up if or an is it be do we me my no us am let lets like want ' +
    'need make makes made making sure look looks looking looked see seen saw says said say going goes went get gets got ' +
    'getting give gives gave take takes took keep keeps kept still right left good great okay yes yeah nope now new old ' +
    'one two three first second next last thing things something anything everything nothing way ways use uses used using ' +
    'work works worked working well better best actually please thanks thank sorry wait maybe probably think thought ' +
    'know known knows knew come comes came back down out off between through during without within instead really always ' +
    'never sometimes often already currently point start starts started end ends ended run runs ran running ' +
    // dev-generic — true for every developer, so never distinctive
    'file files code test tests testing function functions error errors bug bugs fix fixes fixed line lines change ' +
    'changes changed update updates updated add adds added remove removes removed delete deleted create creates created ' +
    'build builds built command commands branch commit commits push pull merge main master repo repository project ' +
    'projects folder directory path paths name names type types value values string number list array object data ' +
    'component components page pages user users server client api call calls called check checks checked version case ' +
    'issue issues problem problems result results output input example examples question questions answer time times ' +
    'true false null undefined const import export return async await class method methods module script json html css ' +
    'text item items set sets setting settings config options option flag flags default logic implement implementation ' +
    'implemented feature features support supported supports current existing based instead different single multiple ' +
    'able available actual specific proper properly correct correctly wrong empty missing invalid valid every each ' +
    // agent-era plumbing — true of every heavy agent user, so never distinctive.
    // These are the tools and nouns of the medium itself, not the user's subject,
    // including the assistant/model names that show up in nearly every transcript.
    'read write edit grep bash tool tools agent agents subagent skill skills task tasks context summary session ' +
    'sessions review prompt prompts message messages model models token tokens directory search output plan mode ' +
    'claude codex opus sonnet haiku gemini anthropic openai full'
  )
    .split(/\s+/)
    .filter(Boolean),
);

interface CountRow {
  n: number;
}

// "Sessions started within the period." Overlap semantics would import an
// entire December-spanning session into the new year (message_fts rows carry
// no timestamps to filter individually), and would let a prior-year session
// win session-of-the-year. The explicit '?' guard documents intent even though
// lexical comparison already excludes the sentinel. Known skew, disclosed in
// docs: these are UTC-sliced dates while event stats bucket in local tz.
//
// message_count > 0 drops empty sessions (a launched-then-quit shell, or a
// menu-bar app's health-check probe) — they carry no content but would still
// count as "drive-bys" and inflate the indexedSessions denominator. junkCwdSql
// drops automated probe/eval/throwaway sessions that aren't the user's own
// coding (see exclude.ts). Both apply to every content query, so the per-session
// tables (drive-bys, abandoned, errors, files, commands) and the FTS censuses
// (phrases, monologue, vocabulary) all count the same real sessions.
const PERIOD_WHERE =
  `s.created_at >= $from AND s.created_at <= $to AND s.created_at != '?' AND s.message_count > 0` + junkCwdSql('s.cwd');

function phraseCounts(db: Database, from: string, to: string, tool: string | null): PhraseStat[] {
  const out: PhraseStat[] = [];
  for (const spec of PHRASES) {
    const likes = spec.patterns.map((_, i) => `m.text LIKE $p${i}`).join(' OR ');
    const params: SqlParams = { $from: from, $to: to, $role: spec.role };
    spec.patterns.forEach((p, i) => {
      params[`$p${i}`] = p;
    });
    let sql =
      `SELECT COUNT(*) AS n FROM message_fts m JOIN sessions s ON s.file_path = m.file_path ` +
      `WHERE ${PERIOD_WHERE} AND m.role = $role AND m.msg_index >= 0 AND (${likes})`;
    if (tool) {
      sql += ` AND s.tool = $tool`;
      params['$tool'] = tool;
    }
    const row = db.query<CountRow, Record<string, string>>(sql).get(params);
    out.push({ id: spec.id, role: spec.role, count: row?.n ?? 0 });
  }
  return out;
}

/** Strip the noise that isn't the user's own voice before mining vocabulary. */
export function cleanForMining(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ') // fenced code
      .replace(/`[^`]*`/g, ' ') // inline code
      .replace(/<[^>\n]{1,80}>/g, ' ') // tags/markers
      .replace(/\[request interrupted[^\]]*\]/gi, ' ')
      .replace(/https?:\/\/\S+/g, ' ') // urls
      // Paths. Segments are bounded: an unbounded [\w.-]+ prefix backtracks
      // quadratically on long slash-free runs (unfenced base64url/hex pastes).
      .replace(/[\w.-]{1,256}\/[\w./-]{1,512}/g, ' ')
  );
}

export function mineWords(
  texts: { text: string; file: string }[],
  limit: number,
): { word: string; count: number; sessions: number }[] {
  const counts = new Map<string, { count: number; files: Set<string> }>();
  for (const { text, file } of texts) {
    const words = cleanForMining(text.toLowerCase()).match(/[a-z][a-z'-]{3,}/g);
    if (!words) continue;
    // Count each word at most once per message. cleanForMining strips fenced/
    // inline code and paths, but an unfenced log or stack-trace paste still leaks
    // its vocabulary wholesale — dedup-per-message so one dump can't crown a word
    // it repeats 200 times. `count` is therefore "messages containing the word".
    const seen = new Set<string>();
    for (const raw of words) {
      const w = raw.replace(/['-]/g, '');
      if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      let e = counts.get(w);
      if (!e) {
        e = { count: 0, files: new Set() };
        counts.set(w, e);
      }
      e.count++;
      e.files.add(file);
    }
  }
  return [...counts.entries()]
    .map(([word, e]) => ({ word, count: e.count, sessions: e.files.size }))
    .filter((w) => w.count >= 10 && w.sessions >= 5) // spread across sessions, not one rant
    .sort((a, b) => b.count - a.count || b.sessions - a.sessions)
    .slice(0, limit);
}

// Agent plumbing — commands every transcript is full of regardless of the
// human's habits. Filtering them makes "featuring: git status" possible;
// "featuring: ls" says nothing about anyone.
const PLUMBING = new Set([
  'ls',
  'cd',
  'cat',
  'find',
  'grep',
  'rg',
  'echo',
  'pwd',
  'head',
  'tail',
  'wc',
  'which',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'touch',
  'sed',
  'awk',
  'sort',
  'uniq',
  'tr',
  'cut',
  'xargs',
  'chmod',
  'true',
  'test',
  'sleep',
  'date',
  'env',
  'export',
]);

/** Normalize a shell command to its "family": first two tokens (`git status`),
 *  or one for bare commands. Keeps `git status -sb` and `git status` together. */
export function commandFamily(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';
  if (!first) return '';
  if (!second || second.startsWith('-') || second.includes('/') || second.includes('=')) return first;
  return `${first} ${second}`;
}

interface SessionRow {
  file_path: string;
  cwd: string;
  session_id: string;
  created_at: string;
  date: string;
  first_prompt: string;
  custom_title: string;
  message_count: number;
  files_touched: string;
  commands: string;
  errored: number;
  error_count: number;
  closing_user: string;
  closing_assistant: string;
}

// Stored arrays were written by this index from string columns, but the JSON
// is untrusted at read time: non-string elements degrade to null and drop out.
const stringListSchema = z.array(z.string().nullable().catch(null)).catch([]);

function parseArr(json: string): string[] {
  try {
    return stringListSchema.parse(JSON.parse(json)).filter((x): x is string => x !== null);
  } catch {
    return [];
  }
}

export interface ContentOptions {
  from: string;
  to: string;
  /** Report ToolId; mapped to the index's tool naming. */
  tool?: string;
  /** Days of silence before a project counts as abandoned. */
  abandonedAfterDays?: number;
}

export async function computeContentStats(opts: ContentOptions): Promise<
  WrappedContentStats & {
    sessionOfYear: WrappedSessionOfYear | null;
  }
> {
  const db = await getIndexDb();
  const tool = opts.tool ? (INDEX_TOOL[opts.tool] ?? opts.tool) : null;
  const params: SqlParams = { $from: opts.from, $to: opts.to };
  let toolWhere = '';
  if (tool) {
    toolWhere = ' AND s.tool = $tool';
    params['$tool'] = tool;
  }

  const rows = db
    .query<SessionRow, Record<string, string>>(
      `SELECT file_path, cwd, session_id, created_at, date, first_prompt, custom_title, message_count,
              files_touched, commands, errored, error_count, closing_user, closing_assistant
       FROM sessions s WHERE ${PERIOD_WHERE}${toolWhere}`,
    )
    .all(params);

  const phrases = phraseCounts(db, opts.from, opts.to, tool);

  // Monologue asymmetry — the data picks the punchline, copy must not assume a direction.
  const mono = db
    .query<{ role: string; avg: number; max: number }, Record<string, string>>(
      `SELECT m.role AS role, AVG(LENGTH(m.text)) AS avg, MAX(LENGTH(m.text)) AS max
       FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
       WHERE ${PERIOD_WHERE}${toolWhere} AND m.msg_index >= 0 GROUP BY m.role`,
    )
    .all(params);
  const user = mono.find((r) => r.role === 'user');
  const assistant = mono.find((r) => r.role === 'assistant');

  // Vocabulary mining over genuine user prompts.
  const userTexts = db
    .query<{ text: string; file_path: string }, Record<string, string>>(
      `SELECT m.text AS text, m.file_path AS file_path
       FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
       WHERE ${PERIOD_WHERE}${toolWhere} AND m.role = 'user' AND m.msg_index >= 0`,
    )
    .all(params);
  const words = mineWords(
    userTexts.map((r) => ({ text: r.text, file: r.file_path })),
    5,
  );

  // Per-session JSON columns → league tables.
  const fileCounts = new Map<string, number>();
  const commandCounts = new Map<string, number>();
  const projectAgg = new Map<string, { sessions: number; lastSeen: string }>();
  const errByWeekday = Array.from({ length: 7 }, () => 0);
  let sessionsErrored = 0;
  let totalErrors = 0;
  let driveBys = 0;
  let best: { score: number; row: SessionRow; files: number } | null = null;
  const messageCounts: number[] = [];

  for (const r of rows) {
    // Depth measures engaged sessions; drive-bys would drag a bimodal median
    // into the trivia lobe and describe neither mode.
    if (r.message_count > 2) messageCounts.push(r.message_count);
    if (r.message_count <= 2) driveBys++;
    if (r.errored) sessionsErrored++;
    totalErrors += r.error_count;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.created_at)) {
      const wd = new Date(`${r.created_at}T00:00:00Z`).getUTCDay();
      errByWeekday[wd] = errByWeekday[wd]! + r.error_count;
    }

    for (const f of new Set(parseArr(r.files_touched))) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
    for (const c of new Set(parseArr(r.commands).map(commandFamily))) {
      if (c && !PLUMBING.has(c.split(' ')[0]!)) commandCounts.set(c, (commandCounts.get(c) ?? 0) + 1);
    }

    // Key by resolved project (repo), not raw cwd — otherwise a stale worktree
    // or subdir (…/cli/some-branch) reads as the whole repo being abandoned even
    // when …/cli/main is active. Repo granularity matches the projects card.
    const projName = resolveProject(r.cwd);
    const proj = projectAgg.get(projName);
    if (!proj) {
      projectAgg.set(projName, { sessions: 1, lastSeen: r.date });
    } else {
      proj.sessions++;
      if (r.date > proj.lastSeen) proj.lastSeen = r.date;
    }

    const scorable = {
      messageCount: r.message_count,
      filesTouchedCount: parseArr(r.files_touched).length,
      closingText: `${r.closing_user} ${r.closing_assistant}`,
      createdAt: r.created_at,
    };
    if (!isTrivia(scorable)) {
      const score = significanceScore(scorable);
      if (!best || score > best.score) best = { score, row: r, files: scorable.filesTouchedCount };
    }
  }

  // Most-abandoned: meaningfully used, then silent for 90+ days before period end.
  const cutoff = new Date(Date.parse(`${opts.to}T00:00:00Z`) - (opts.abandonedAfterDays ?? 90) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let abandoned: { name: string; sessions: number; lastSeen: string } | null = null;
  for (const [name, agg] of projectAgg) {
    if (agg.sessions >= 10 && agg.lastSeen < cutoff) {
      if (!abandoned || agg.sessions > abandoned.sessions) {
        abandoned = { name, sessions: agg.sessions, lastSeen: agg.lastSeen };
      }
    }
  }

  const top = <K>(m: Map<K, number>, n: number): { name: K; sessions: number }[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, sessions]) => ({ name, sessions }));

  const maxErr = Math.max(...errByWeekday);
  messageCounts.sort((a, b) => a - b);
  const mid = Math.floor(messageCounts.length / 2);
  const depthMedian =
    messageCounts.length === 0
      ? null
      : messageCounts.length % 2 === 1
        ? messageCounts[mid]!
        : (messageCounts[mid - 1]! + messageCounts[mid]!) / 2;

  const sessionOfYear: WrappedSessionOfYear | null = best
    ? {
        title: cleanTitle(best.row.custom_title || best.row.first_prompt || 'untitled'),
        project: resolveProject(best.row.cwd),
        date: best.row.created_at,
        messageCount: best.row.message_count,
        filesTouched: best.files,
        shipped: hasArtifact(`${best.row.closing_user} ${best.row.closing_assistant}`),
      }
    : null;

  return {
    indexedSessions: rows.length,
    phrases,
    monologue: user
      ? {
          userAvg: Math.round(user.avg),
          assistantAvg: Math.round(assistant?.avg ?? 0),
          longestUser: user.max,
        }
      : null,
    driveBys: rows.length > 0 ? { count: driveBys, total: rows.length } : null,
    abandoned,
    errors:
      rows.length > 0
        ? {
            sessionsErrored,
            totalErrors,
            cursedWeekday: maxErr > 0 ? errByWeekday.indexOf(maxErr) : null,
            cursedCount: maxErr > 0 ? maxErr : 0,
          }
        : null,
    topFiles: top(fileCounts, 5).map((f) => ({ name: shortPath(f.name), sessions: f.sessions })),
    topCommands: top(commandCounts, 5),
    words,
    depthMedian,
    sessionOfYear,
  };
}

/** First prompts arrive as raw markdown; a display title shouldn't. */
export function cleanTitle(raw: string): string {
  const cleaned = raw
    .replace(/[#*`>_|]+/g, ' ')
    .replace(/[\u2600-\u27bf]|\ufe0f/gu, ' ') // status emoji (checkmarks, warnings) + variation selector
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 72).trimEnd()}…` : cleaned || 'untitled';
}

/** Last two path segments — enough to recognize a file without the noise. */
export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
