import type { UsageReport, ToolBreakdown, ModelBreakdown, ProjectBreakdown } from './schema.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtUSD = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
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

// Vertical bars; the peak bar is drawn in ink and optionally annotated so the
// most interesting number on the chart reads without hovering.
function vBars(bars: Bar[], w: number, h: number, annotateMax?: (b: Bar) => string): string {
  const rawMax = bars.length > 0 ? Math.max(...bars.map((b) => b.value)) : 0;
  const max = Math.max(1, rawMax);
  const maxIdx = rawMax > 0 ? bars.findIndex((b) => b.value === rawMax) : -1;
  const n = Math.max(1, bars.length);
  const bw = w / n;
  const top = annotateMax ? 18 : 4;
  let grid = '';
  for (let g = 1; g <= 3; g++) {
    const y = (h - ((h - top) * g) / 4).toFixed(1);
    grid += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
  }
  const rects = bars
    .map((b, i) => {
      const bh = Math.round((b.value / max) * (h - top - 2)) + 2;
      const x = (i * bw + 1).toFixed(1);
      const y = (h - bh).toFixed(1);
      const fill = i === maxIdx ? 'var(--ink)' : 'var(--accent)';
      return `<rect data-tip="${esc(b.tip)}" x="${x}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh}" rx="1" fill="${fill}"/>`;
    })
    .join('');
  let note = '';
  if (annotateMax && maxIdx >= 0) {
    const peak = bars[maxIdx]!;
    const cx = Math.min(w - 4, Math.max(4, maxIdx * bw + bw / 2));
    const anchor = cx < 50 ? 'start' : cx > w - 50 ? 'end' : 'middle';
    note = `<text x="${cx.toFixed(1)}" y="12" text-anchor="${anchor}" font-size="11" font-weight="700" fill="var(--ink)" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(annotateMax(peak))}</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" class="bars">${grid}${rects}${note}</svg>`;
}

function barList(rows: { name: string; value: number; tip: string }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map((r) => {
      const pct = ((r.value / max) * 100).toFixed(1);
      const peak = r.value === max ? ' peak' : '';
      return `<div class="item${peak}"><span class="name">${esc(r.name)}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="val" data-tip="${esc(r.tip)}">${fmtUSD(r.value)}</span></div>`;
    })
    .join('');
}

// Accent palette. Each accent has a bright value for dark surfaces (also used
// as its swatch color) and a stepped-down pair for light surfaces: `light`
// fills bars/graphics, `lightText` holds AA contrast as inline text on white.
const ACCENTS = [
  { name: 'magenta', dark: 'oklch(70% 0.24 350)', light: 'oklch(62% 0.25 352)', lightText: 'oklch(50% 0.22 352)' },
  { name: 'lime', dark: 'oklch(86% 0.23 132)', light: 'oklch(63% 0.19 132)', lightText: 'oklch(45% 0.14 135)' },
  { name: 'cyan', dark: 'oklch(80% 0.14 200)', light: 'oklch(55% 0.13 230)', lightText: 'oklch(45% 0.12 230)' },
  { name: 'cobalt', dark: 'oklch(70% 0.17 262)', light: 'oklch(55% 0.23 262)', lightText: 'oklch(47% 0.20 262)' },
  { name: 'tangerine', dark: 'oklch(76% 0.18 50)', light: 'oklch(64% 0.19 45)', lightText: 'oklch(50% 0.15 45)' },
  { name: 'red', dark: 'oklch(68% 0.21 25)', light: 'oklch(55% 0.22 28)', lightText: 'oklch(47% 0.19 28)' },
] as const;

const ACCENT_NAMES = JSON.stringify(ACCENTS.map((a) => a.name));

// Two themes behind a toggle: dark (default) is near-black with a glowing
// accent; light keeps numerals in ink and steps the accent down to hold AA
// contrast on white. Neutrals are true grays so every accent sits cleanly.
// Structure is rule-and-grid, no cards.
const CSS = `
:root{--bg:oklch(15% 0 0);--track:oklch(25% 0 0);--grid:oklch(24% 0 0);--ink:oklch(96% 0 0);--muted:oklch(72% 0 0);--accent:${ACCENTS[0].dark};--accent-text:${ACCENTS[0].dark};--rule:oklch(96% 0 0);--glow:none;--z-dropdown:5;--z-tooltip:10;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;}
[data-theme="light"]{--bg:oklch(99% 0 0);--track:oklch(93% 0 0);--grid:oklch(94% 0 0);--ink:oklch(18% 0 0);--muted:oklch(42% 0 0);--accent:${ACCENTS[0].light};--accent-text:${ACCENTS[0].lightText};--rule:oklch(18% 0 0);--glow:none;}
${ACCENTS.map(
  (a) =>
    `[data-accent="${a.name}"]{--accent:${a.dark};--accent-text:${a.dark};--glow:0 0 70px color-mix(in oklch,${a.dark} 45%,transparent),0 0 18px color-mix(in oklch,${a.dark} 25%,transparent);}`,
).join('\n')}
${ACCENTS.map(
  (a) => `[data-theme="light"][data-accent="${a.name}"]{--accent:${a.light};--accent-text:${a.lightText};--glow:none;}`,
).join('\n')}
${ACCENTS.map((a) => `[data-accent="${a.name}"] .opt[data-pick="${a.name}"]{background:var(--track);}`).join('\n')}
*{box-sizing:border-box}
html{background:var(--bg);}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px;}
.topline{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:28px 0 0;}
.brand{font-family:var(--mono);font-weight:700;font-size:14px;color:var(--accent-text);}
.topline .right{display:flex;align-items:baseline;gap:18px;}
.genstamp{font-family:var(--mono);font-size:10.5px;color:var(--muted);}
#themetoggle{display:inline-flex;align-items:center;color:var(--ink);background:none;border:1px solid var(--muted);border-radius:4px;padding:4px 7px;cursor:pointer;transition:border-color .15s ease-out,color .15s ease-out;}
#themetoggle:hover{border-color:var(--accent-text);color:var(--accent-text);}
#themetoggle:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px;}
[data-theme="dark"] .ic-moon{display:none;}
[data-theme="light"] .ic-sun{display:none;}
.dot{width:12px;height:12px;border-radius:50%;background:var(--c);border:1px solid var(--track);flex:none;}
.dot.cur{background:var(--accent);}
.dd{position:relative;display:inline-block;}
.dd summary{list-style:none;display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink);border:1px solid var(--muted);border-radius:4px;padding:3px 9px;cursor:pointer;transition:border-color .15s ease-out,color .15s ease-out;}
.dd summary::-webkit-details-marker{display:none;}
.dd summary:hover{border-color:var(--accent-text);color:var(--accent-text);}
.dd summary:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px;}
.dd .caret{font-size:9px;color:var(--muted);}
.dd .menu{position:absolute;right:0;top:calc(100% + 6px);display:flex;flex-direction:column;gap:1px;background:var(--bg);border:1px solid var(--muted);border-radius:6px;padding:4px;min-width:11em;z-index:var(--z-dropdown);box-shadow:0 4px 8px color-mix(in oklch,var(--ink) 12%,transparent);}
.opt{display:flex;align-items:center;gap:8px;background:none;border:0;color:var(--ink);font-family:var(--mono);font-size:11px;font-weight:600;padding:6px 10px;cursor:pointer;text-align:left;border-radius:4px;}
.opt:hover{background:var(--track);}
.opt:focus-visible{outline:2px solid var(--accent-text);outline-offset:-2px;}
.opt .rnd{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;border:1px solid var(--muted);color:var(--muted);font-size:9px;flex:none;}
h1{font-size:clamp(2.2rem,6vw,3.4rem);font-weight:900;text-transform:uppercase;letter-spacing:-0.02em;line-height:.95;margin:20px 0 10px;text-wrap:balance;}
.period{font-family:var(--mono);font-weight:700;font-size:15px;color:var(--accent-text);margin-bottom:22px;}
.heroline{border-top:8px solid var(--rule);padding:26px 0 6px;}
.heroline .label{font-family:var(--mono);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;color:var(--muted);}
.big{font-size:clamp(3.4rem,11vw,6rem);font-weight:900;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums;margin:0;color:var(--accent);text-shadow:var(--glow);}
[data-theme="light"] .big{color:var(--ink);}
[data-theme="light"] .big .cur{color:var(--accent-text);}
.statgrid{display:grid;grid-template-columns:repeat(4,1fr);border-top:3px solid var(--rule);margin-top:30px;}
.statgrid .cell{padding:14px 18px 16px 0;}
.statgrid .cell+.cell{padding-left:18px;border-left:3px solid var(--rule);}
.statgrid .n{font-size:2.1rem;font-weight:900;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1.1;}
.statgrid .l{font-family:var(--mono);font-size:11px;color:var(--muted);}
.note{font-size:1.1rem;font-weight:500;margin:26px 0 0;max-width:64ch;color:var(--muted);}
.note strong{color:var(--accent-text);font-weight:800;white-space:nowrap;}
.note b{color:var(--ink);font-weight:800;white-space:nowrap;}
section.blk{border-top:3px solid var(--rule);margin-top:34px;padding-top:18px;}
h2{font-size:1rem;font-weight:900;text-transform:uppercase;letter-spacing:.01em;margin:0 0 16px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
h2 .hint{font-weight:400;text-transform:none;color:var(--muted);font-size:10.5px;font-family:var(--mono);}
.cols{display:grid;grid-template-columns:1.6fr 1fr;gap:48px;}
.lists{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:48px;}
.axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:7px;}
.axis.days span{flex:1;text-align:center;}
.barlist{display:flex;flex-direction:column;gap:10px;}
.barlist .item{display:grid;grid-template-columns:9.5em 1fr auto;gap:10px;align-items:center;font-size:12.5px;}
.barlist .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650;}
.barlist .track{height:12px;background:var(--track);}
.barlist .fill{display:block;height:100%;background:var(--accent);}
.barlist .item.peak .fill{background:var(--ink);}
.barlist .val{font-family:var(--mono);font-size:11.5px;font-weight:600;}
svg.bars rect{transition:opacity .15s ease-out;}
svg.bars rect:hover{opacity:.7;}
.tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);font-family:var(--mono);font-size:11px;padding:4px 7px;border-radius:4px;opacity:0;transform:translate(-50%,-130%);white-space:nowrap;z-index:var(--z-tooltip);}
footer.rep{border-top:8px solid var(--rule);margin-top:40px;padding:14px 0 40px;font-family:var(--mono);font-size:11px;display:flex;justify-content:space-between;color:var(--muted);}
@media (max-width:760px){.cols{grid-template-columns:1fr;gap:30px;}.statgrid{grid-template-columns:repeat(2,1fr);}.statgrid .cell:nth-child(3){border-left:0;padding-left:0;}}
@media (prefers-reduced-motion:reduce){svg.bars rect,#themetoggle{transition:none;}}
`;

// Runs in <head> so theme + accent attributes land before first paint.
// Accent defaults to a random pick per load unless one has been pinned.
const THEME_BOOT_JS = `(function(){var d=document.documentElement;var t=null;try{t=localStorage.getItem('sessions-report-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}d.setAttribute('data-theme',t);var A=${ACCENT_NAMES};var a=null;try{a=localStorage.getItem('sessions-report-accent')}catch(e){}if(A.indexOf(a)<0){a=A[Math.floor(Math.random()*A.length)];}d.setAttribute('data-accent',a);})();`;

// Delegated tooltip + theme toggle — textContent only, never innerHTML.
const JS = `(function(){var t=document.getElementById('tip');function find(e){return e.target&&e.target.closest?e.target.closest('[data-tip]'):null;}document.addEventListener('mousemove',function(e){var el=find(e);if(!el){t.style.opacity='0';return;}t.textContent=el.getAttribute('data-tip');t.style.opacity='1';t.style.left=e.clientX+'px';t.style.top=e.clientY+'px';});
var d=document.documentElement,b=document.getElementById('themetoggle');
b.addEventListener('click',function(){var next=d.getAttribute('data-theme')==='dark'?'light':'dark';d.setAttribute('data-theme',next);try{localStorage.setItem('sessions-report-theme',next)}catch(e){}});
var A=${ACCENT_NAMES};
var dd=document.getElementById('accentdd'),nm=document.getElementById('accentname');
var pinned=null;try{pinned=localStorage.getItem('sessions-report-accent')}catch(e){}
nm.textContent=A.indexOf(pinned)>=0?pinned:'random';
dd.querySelectorAll('.opt').forEach(function(el){el.addEventListener('click',function(){var p=el.getAttribute('data-pick');if(p==='random'){try{localStorage.removeItem('sessions-report-accent')}catch(e){}nm.textContent='random';p=A[Math.floor(Math.random()*A.length)];}else{try{localStorage.setItem('sessions-report-accent',p)}catch(e){}nm.textContent=p;}d.setAttribute('data-accent',p);dd.removeAttribute('open');});});
document.addEventListener('click',function(e){if(dd.hasAttribute('open')&&!dd.contains(e.target))dd.removeAttribute('open');});
document.addEventListener('keydown',function(e){if(e.key==='Escape')dd.removeAttribute('open');});
console.log('sessions report \\u2014 generated locally from your own session logs. No telemetry.');})();`;

export function renderHtml(data: UsageReport): string {
  const s = data.summary;
  const dailyBars = vBars(
    data.daily.map((d) => ({ value: d.costUSD, tip: `${d.date}: ${fmtUSD(d.costUSD)}` })),
    920,
    200,
    (b) => b.tip.slice(b.tip.indexOf('$')),
  );
  const hourBars = vBars(
    data.insights.hourCounts.map((c, h) => ({ value: c, tip: `${hourLabel(h)}: ${c} msgs` })),
    620,
    130,
    (b) => b.tip.split(':')[0]!,
  );
  const weekdayBars = vBars(
    data.insights.weekdayCounts.map((c, i) => ({ value: c, tip: `${WEEKDAYS[i]!}: ${c} msgs` })),
    320,
    130,
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

  const firstDay = data.daily[0]?.date;
  const lastDay = data.daily[data.daily.length - 1]?.date;
  const cost = fmtUSD(s.totalCostUSD);
  const streak =
    s.currentStreakDays >= 3 && s.currentStreakDays === s.longestStreakDays
      ? `<strong>${s.currentStreakDays}-day streak</strong>, longest yet`
      : `longest streak <b>${s.longestStreakDays} days</b>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Usage Report — ${esc(data.period.from)} to ${esc(data.period.to)}</title>
<script>${THEME_BOOT_JS}</script>
<style>${CSS}</style></head>
<body>
<div class="wrap">
<header>
<div class="topline"><span class="brand">sessions</span><span class="right"><span class="genstamp">generated ${esc(data.generatedAt)}</span><details class="dd" id="accentdd"><summary aria-label="Accent color"><span class="dot cur"></span><span id="accentname">random</span><span class="caret">▾</span></summary><div class="menu">${ACCENTS.map(
    (a) =>
      `<button class="opt" type="button" data-pick="${a.name}"><span class="dot" style="--c:${a.dark}"></span>${a.name}</button>`,
  ).join(
    '',
  )}<button class="opt" type="button" data-pick="random"><span class="rnd">?</span>random</button></div></details><button id="themetoggle" type="button" aria-label="Toggle light and dark theme"><svg class="ic-sun" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1"/></svg><svg class="ic-moon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button></span></div>
<h1>AI Usage Report</h1>
<div class="period">${esc(periodLabel(data.period.from, data.period.to))}</div>
</header>
<div class="heroline">
<p class="label">Total cost</p>
<div class="big"><span class="cur">$</span>${esc(cost.slice(1))}</div>
<div class="statgrid">
<div class="cell"><div class="n">${fmtTokens(s.totalTokens)}</div><div class="l">tokens</div></div>
<div class="cell"><div class="n">${fmtInt(s.sessions)}</div><div class="l">sessions</div></div>
<div class="cell"><div class="n">${fmtInt(s.messages)}</div><div class="l">messages</div></div>
<div class="cell"><div class="n">${s.activeDays}</div><div class="l">active days</div></div>
</div>
<p class="note">${streak} · busiest at <b>${esc(hourLabel(s.peakHourLocal))}</b> · top model <strong>${esc(s.favoriteModel.label)}</strong></p>
</div>
<section class="blk"><h2>Daily cost <span class="hint">USD per day</span></h2>${dailyBars}
${firstDay && lastDay ? `<div class="axis"><span>${esc(formatDate(firstDay))}</span><span>${esc(formatDate(lastDay))}</span></div>` : ''}</section>
<section class="blk cols">
<div><h2>Activity by hour <span class="hint">messages · local time</span></h2>${hourBars}<div class="axis"><span>12 AM</span><span>noon</span><span>11 PM</span></div></div>
<div><h2>By weekday <span class="hint">messages</span></h2>${weekdayBars}<div class="axis days">${WEEKDAYS.map((d) => `<span>${d[0]}</span>`).join('')}</div></div>
</section>
<section class="blk lists">
<div><h2>By tool</h2><div class="barlist">${byTool}</div></div>
<div><h2>By model</h2><div class="barlist">${byModel}</div></div>
<div><h2>By project</h2><div class="barlist">${byProject}</div></div>
</section>
<footer class="rep"><span>sessions usage report</span><span>${s.activeDays} active days</span></footer>
</div>
<div class="tip" id="tip"></div>
<script>${JS}</script>
</body></html>`;
}
