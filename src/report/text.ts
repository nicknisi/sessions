// Plain-text rendering of a UsageReport for `sessions report --format text`.
// No colour and no box drawing: this is meant to be readable in a terminal, in a
// pipe, and inside an agent's tool result without an escape-code tax.
import type { UsageReport } from './schema.ts';

const WIDTH = 66;

const fmtUSD = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const fmtInt = (n: number): string => n.toLocaleString('en-US');

const pct = (frac: number): string => (frac * 100).toFixed(1) + '%';

function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

const rule = (ch = '-'): string => ch.repeat(WIDTH) + '\n';

// name ......... value, right-aligned so a column of costs stays scannable.
function row(name: string, value: string, indent = 2): string {
  const left = ' '.repeat(indent) + name;
  const pad = Math.max(1, WIDTH - left.length - value.length);
  return left + ' '.repeat(pad) + value + '\n';
}

function section(title: string): string {
  return rule() + `  ${title}\n` + rule();
}

/** Truncate an identifier — a model id, branch, or path — keeping the tail, which
 *  is the part that distinguishes it. */
function fit(label: string, max: number): string {
  return label.length <= max ? label : '…' + label.slice(label.length - (max - 1));
}

/** Truncate prose, keeping the head. A sentence read from the end is noise. */
function head(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

export function renderText(r: UsageReport): string {
  const s = r.summary;
  let out = '\n';
  out += rule('=');
  const period = r.period.from === r.period.to ? r.period.from : `${r.period.from} → ${r.period.to}`;
  out += `  sessions usage  ${period}\n`;
  out += rule('=');

  out += row('Total cost', fmtUSD(s.totalCostUSD));
  out += row('Billable tokens', fmtTokens(s.totalTokens));
  out += row('Sessions / messages', `${s.sessions.toLocaleString('en-US')} / ${s.messages.toLocaleString('en-US')}`);
  out += row('Active days', `${s.activeDays} (streak ${s.currentStreakDays}, longest ${s.longestStreakDays})`);
  out += row('Peak hour', hourLabel(s.peakHourLocal));

  if (r.burn) {
    const b = r.burn;
    out += section('Pace');
    out += row('Per active day', fmtUSD(b.dailyMeanUSD));
    if (b.inProgress) out += row(`Projected (day ${b.elapsedDays} of ${b.periodDays})`, fmtUSD(b.projectedUSD));
    if (b.priorPeriodUSD !== null) {
      const delta = b.changePct === null ? '' : `  (${b.changePct >= 0 ? '+' : ''}${(b.changePct * 100).toFixed(0)}%)`;
      out += row(`Prior ${b.periodDays} days`, `${fmtUSD(b.priorPeriodUSD)}${delta}`);
    }
  }

  // Cache: the volume the headline token count deliberately leaves out, plus
  // what the cache is actually buying.
  out += section('Cache');
  out += row('Hit rate', pct(r.cache.hitRate));
  out += row('Cache read', `${fmtTokens(r.cache.cacheReadTokens)} (saved ${fmtUSD(r.cache.savedUSD)})`);
  out += row('Cache write', fmtTokens(r.cache.cacheWriteTokens));
  out += row('Input / output', `${fmtTokens(r.cache.inputTokens)} / ${fmtTokens(r.cache.outputTokens)}`);

  if (r.subagents.dispatches > 0) {
    out += section('Subagents');
    out += row(
      'Spend',
      `${fmtUSD(r.subagents.costUSD)} — ${pct(r.subagents.shareOfCost)} of total, ${r.subagents.dispatches} dispatches`,
    );
    for (const t of r.subagents.byType.slice(0, 8)) {
      out += row(fit(t.agentType, 30), `${fmtUSD(t.costUSD)}  ${t.dispatches}× @ ${fmtUSD(t.costPerDispatchUSD)}`, 4);
    }
    const hidden = r.subagents.byType.length - 8;
    if (hidden > 0) out += `    … ${hidden} more type${hidden === 1 ? '' : 's'}\n`;
  }

  if (r.sessionDistribution.count > 0) {
    const d = r.sessionDistribution;
    out += section('Session spend');
    out += row('Median / p90 / max', `${fmtUSD(d.medianUSD)} / ${fmtUSD(d.p90USD)} / ${fmtUSD(d.maxUSD)}`);
    // Lower than the header's figure, which re-counts a session on each day it
    // touched. Labelled so the difference does not read as a bug.
    out += row('Distinct sessions', fmtInt(d.count));
  }

  if (r.topSessions.length > 0) {
    out += section('Most expensive sessions');
    for (const s of r.topSessions.slice(0, 8)) {
      out += row(s.intent ? head(s.intent, 44) : s.sessionId.slice(0, 8), fmtUSD(s.costUSD), 2);
      out += `      ${s.project}${s.branch ? ` · ${s.branch}` : ''} · ${s.date}\n`;
    }
  }

  if (r.byModel.length > 0) {
    out += section('By model');
    for (const m of r.byModel.slice(0, 8)) {
      out += row(fit(m.label, 34), `${fmtUSD(m.costUSD)}  ${fmtTokens(m.tokens)}`, 2);
    }
  }

  if (r.byProject.length > 0) {
    out += section('By project');
    for (const p of r.byProject.slice(0, 8)) {
      out += row(fit(p.label, 34), `${fmtUSD(p.costUSD)}  ${p.sessions} sess`, 2);
    }
  }

  if (r.modelWeekly.length > 1) {
    out += section('Model mix by week');
    const top = r.modelOrder.slice(0, 4);
    for (const w of r.modelWeekly.slice(-6)) {
      const split = top
        .filter((m) => (w.byModel[m] ?? 0) > 0)
        .map((m) => `${m.replace(/^claude-/, '')} ${fmtUSD(w.byModel[m] ?? 0)}`)
        .join('  ');
      out += row(w.weekEnding, fmtUSD(w.totalUSD));
      if (split) out += `      ${split}\n`;
    }
  }

  if (r.warnings.length > 0) {
    out += section('Pricing warnings');
    for (const w of r.warnings) {
      const how = w.pricedAs ? `estimated as ${w.pricedAs}` : 'NOT PRICED — cost understated';
      out += row(fit(w.model, 30), `${fmtTokens(w.tokens)}  ${how}`, 2);
    }
  }

  out += rule('=');
  return out;
}
