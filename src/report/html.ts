import type { UsageReport, ToolBreakdown, ModelBreakdown, ProjectBreakdown } from './schema.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtUSD = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const fmtInt = (n: number): string => n.toLocaleString('en-US');

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? h + ' AM' : h - 12 + ' PM';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

function periodLabel(from: string, to: string): string {
  return from === to ? formatDate(from) : `${formatDate(from)} → ${formatDate(to)}`;
}

interface Bar {
  value: number;
  tip: string;
}

function vBars(bars: Bar[], w: number, h: number): string {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const n = Math.max(1, bars.length);
  const bw = w / n;
  const rects = bars
    .map((b, i) => {
      const bh = Math.round((b.value / max) * (h - 6)) + 2;
      const x = (i * bw + 0.5).toFixed(1);
      const y = (h - bh).toFixed(1);
      const op = (0.45 + (b.value / max) * 0.55).toFixed(2);
      return `<rect data-tip="${esc(b.tip)}" x="${x}" y="${y}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh}" rx="1.5" fill="var(--accent)" opacity="${op}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${rects}</svg>`;
}

function areaChart(points: Bar[], w: number, h: number): string {
  if (points.length === 0) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"></svg>`;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const xOf = (i: number): number => (n === 1 ? w / 2 : (i / (n - 1)) * (w - 8) + 4);
  const yOf = (v: number): number => h - 4 - (v / max) * (h - 12);
  const pts = points.map((p, i) => [xOf(i), yOf(p.value)] as [number, number]);
  const line = 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  const area =
    `M${xOf(0).toFixed(1)},${h} L` +
    pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') +
    ` L${xOf(n - 1).toFixed(1)},${h} Z`;
  const dots = pts
    .map(
      (p, i) =>
        `<circle data-tip="${esc(points[i]!.tip)}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="var(--accent)"/>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><path d="${area}" fill="var(--accent)" opacity="0.12"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}</svg>`;
}

function barList(rows: { name: string; value: number; tip: string }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map((r) => {
      const pct = ((r.value / max) * 100).toFixed(1);
      return `<div class="item"><span class="name">${esc(r.name)}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="val" data-tip="${esc(r.tip)}">${fmtUSD(r.value)}</span></div>`;
    })
    .join('');
}

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#16181d;--muted:#6b7280;--line:#e6e8ec;--accent:#6d5efc;--grid:#eef0f3;--shadow:0 1px 2px rgba(16,24,40,.04),0 4px 16px rgba(16,24,40,.05);--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f13;--panel:#16181d;--ink:#e8eaed;--muted:#9aa1ad;--line:#262a31;--grid:#20242b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35);}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;}
.wrap{max-width:1080px;margin:0 auto;padding:28px 24px 60px;}
header.rep{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:22px;}
header.rep h1{font-size:20px;margin:0;}
.period{font-family:var(--mono);font-size:16px;font-weight:600;color:var(--accent);margin-top:6px;}
.genstamp{color:var(--muted);font-size:11px;font-family:var(--mono);}
.hero{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px;}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow);}
.stat .k,.ministat .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);}
.stat .v{font-family:var(--mono);font-size:24px;font-weight:600;margin-top:4px;}
.ministats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:22px;}
.ministat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:var(--shadow);}
.ministat .v{font-family:var(--mono);font-size:15px;font-weight:600;margin-top:2px;}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow);margin-bottom:14px;}
.panel h2{font-size:13px;margin:0 0 14px;display:flex;justify-content:space-between;}
.panel h2 .hint{font-weight:400;color:var(--muted);font-size:11px;font-family:var(--mono);}
.row2{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;}.row3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}.rowins{display:grid;grid-template-columns:1.4fr 1fr;gap:14px;}
.barlist{display:flex;flex-direction:column;gap:9px;}
.barlist .item{display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center;font-size:12px;}
.barlist .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.barlist .track{height:8px;background:var(--grid);border-radius:99px;overflow:hidden;}
.barlist .fill{height:100%;border-radius:99px;background:var(--accent);}
.barlist .val{font-family:var(--mono);color:var(--muted);font-size:11px;}
.tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);font-family:var(--mono);font-size:11px;padding:4px 7px;border-radius:6px;opacity:0;transform:translate(-50%,-130%);white-space:nowrap;z-index:9;}
footer.rep{margin-top:24px;color:var(--muted);font-size:11px;font-family:var(--mono);text-align:center;}
`;

// Delegated tooltip — textContent only, never innerHTML.
const JS = `(function(){var t=document.getElementById('tip');function find(e){return e.target&&e.target.closest?e.target.closest('[data-tip]'):null;}document.addEventListener('mousemove',function(e){var el=find(e);if(!el){t.style.opacity='0';return;}t.textContent=el.getAttribute('data-tip');t.style.opacity='1';t.style.left=e.clientX+'px';t.style.top=e.clientY+'px';});})();`;

export function renderHtml(data: UsageReport): string {
  const s = data.summary;
  const dailyBars = vBars(
    data.daily.map((d) => ({ value: d.costUSD, tip: `${d.date}: ${fmtUSD(d.costUSD)}` })),
    620,
    150,
  );
  const weeklyArea = areaChart(
    data.insights.weekly.map((w) => ({ value: w.tokens, tip: `${w.weekEnding}: ${fmtTokens(w.tokens)} tokens` })),
    320,
    150,
  );
  const hourBars = vBars(
    data.insights.hourCounts.map((c, h) => ({ value: c, tip: `${hourLabel(h)}: ${c} msgs` })),
    620,
    110,
  );
  const weekdayBars = vBars(
    data.insights.weekdayCounts.map((c, i) => ({ value: c, tip: `${WEEKDAYS[i]!}: ${c} msgs` })),
    320,
    110,
  );
  const byTool = barList(
    data.byTool.map((t: ToolBreakdown) => ({
      name: t.label,
      value: t.costUSD,
      tip: `${fmtTokens(t.tokens)} tokens · ${t.sessions} sessions`,
    })),
  );
  const byModel = barList(
    data.byModel.slice(0, 6).map((m: ModelBreakdown) => ({
      name: m.label,
      value: m.costUSD,
      tip: `${fmtTokens(m.tokens)} tokens · ${m.messages} msgs`,
    })),
  );
  const byProject = barList(
    data.byProject.slice(0, 8).map((p: ProjectBreakdown) => ({
      name: p.label,
      value: p.costUSD,
      tip: `${fmtTokens(p.tokens)} tokens · ${p.sessions} sessions`,
    })),
  );

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Usage Report — ${esc(data.period.from)} to ${esc(data.period.to)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
<header class="rep"><div><h1>AI Usage Report</h1>
<div class="period">${esc(periodLabel(data.period.from, data.period.to))}</div></div>
<div class="genstamp">generated ${esc(data.generatedAt)}</div></header>
<div class="hero">
<div class="stat"><div class="k">Total cost</div><div class="v">${fmtUSD(s.totalCostUSD)}</div></div>
<div class="stat"><div class="k">Total tokens</div><div class="v">${fmtTokens(s.totalTokens)}</div></div>
<div class="stat"><div class="k">Sessions</div><div class="v">${fmtInt(s.sessions)}</div></div>
<div class="stat"><div class="k">Messages</div><div class="v">${fmtInt(s.messages)}</div></div>
</div>
<div class="ministats">
<div class="ministat"><div class="k">Active days</div><div class="v">${s.activeDays}</div></div>
<div class="ministat"><div class="k">Current streak</div><div class="v">${s.currentStreakDays}d</div></div>
<div class="ministat"><div class="k">Longest streak</div><div class="v">${s.longestStreakDays}d</div></div>
<div class="ministat"><div class="k">Peak hour</div><div class="v">${esc(hourLabel(s.peakHourLocal))}</div></div>
<div class="ministat"><div class="k">Top model</div><div class="v" style="font-size:12px">${esc(s.favoriteModel.label)}</div></div>
</div>
<div class="row2">
<div class="panel"><h2>Daily cost <span class="hint">per day</span></h2>${dailyBars}</div>
<div class="panel"><h2>Weekly tokens <span class="hint">trend</span></h2>${weeklyArea}</div>
</div>
<div class="row3">
<div class="panel"><h2>By tool</h2><div class="barlist">${byTool}</div></div>
<div class="panel"><h2>By model</h2><div class="barlist">${byModel}</div></div>
<div class="panel"><h2>By project</h2><div class="barlist">${byProject}</div></div>
</div>
<div class="rowins">
<div class="panel"><h2>Activity by hour <span class="hint">messages</span></h2>${hourBars}</div>
<div class="panel"><h2>By weekday</h2>${weekdayBars}</div>
</div>
<footer class="rep">sessions usage report · ${s.activeDays} active days</footer>
</div>
<div class="tip" id="tip"></div>
<script>${JS}</script>
</body></html>`;
}
