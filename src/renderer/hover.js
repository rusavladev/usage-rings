'use strict';
// The small card that appears when you hover a tray icon (Windows' own tooltip is text-only).

const COLORS = { ok: '#3dd6a0', warn: '#f5b945', hot: '#ff6358', idle: '#969aa8' };
const PROVIDER = { claude: { name: 'Claude', color: '#d97757' }, openai: { name: 'ChatGPT', color: '#10a37f' } };
const FIVE_H = 5 * 3600e3;
const SEVEN_D = 7 * 24 * 3600e3;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const level = (used) => (used == null ? 'idle' : used >= 85 ? 'hot' : used >= 60 ? 'warn' : 'ok');

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.max(m, 1)}m`;
}

function row(name, w, def) {
  if (!w) return '';
  const lvl = level(w.pct);
  const ms = w.windowMs || def;
  const tl = w.resetsAt == null ? null : Math.min(1, Math.max(0, (w.resetsAt - Date.now()) / ms));
  return `<div class="row">
    <div class="top"><span>${name}</span><b style="color:${COLORS[lvl]}">${Math.max(0, Math.round(100 - w.pct))}% <small>left</small></b></div>
    <div class="bar"><div class="fill" style="width:${100 - w.pct}%;background:${COLORS[lvl]}"></div>${tl != null ? `<div class="now" style="left:${tl * 100}%"></div>` : ''}</div>
    <div class="sub">${w.resetsAt != null ? `Resets in ${fmtDur(w.resetsAt - Date.now())}` : 'No active window'}</div>
  </div>`;
}

function render(a) {
  const prov = PROVIDER[a.provider] || PROVIDER.claude;
  const u = a.usage;
  let body;
  if (a.status === 'needs-login') body = '<div class="note bad">Sign-in expired – click to sign in again.</div>';
  else if (!u) body = `<div class="note">${a.status === 'error' ? esc(a.error || 'Error') : 'Fetching usage…'}</div>`;
  else {
    body = row('5-hour session', u.fiveHour || { pct: 0, resetsAt: null }, FIVE_H) + row('Weekly limit', u.sevenDay || { pct: 0, resetsAt: null }, SEVEN_D);
    if (u.scoped && u.scoped.length) {
      body += `<div class="scoped">${u.scoped
        .map((s) => `<div class="s"><span>${esc(s.label)}</span><div class="bar"><div class="fill" style="width:${100 - s.pct}%;background:${COLORS[level(s.pct)]}"></div></div><em>${Math.max(0, Math.round(100 - s.pct))}%</em></div>`)
        .join('')}</div>`;
    }
    if (a.status === 'error') body += `<div class="note bad" style="margin-top:9px">${esc(a.error)} · showing last values</div>`;
  }
  $('#card').innerHTML = `<div class="head"><i style="background:${esc(a.color || '#888')}"></i><b>${esc(a.label)}</b><span class="chip" style="color:${prov.color};background:${prov.color}22">${prov.name}</span></div>${body}`;
  requestAnimationFrame(() => window.hover.resize(document.body.offsetHeight));
}

const $ = (s) => document.querySelector(s);
window.hover.onData(render);
