'use strict';

const FIVE_H = 5 * 3600e3;
const SEVEN_D = 7 * 24 * 3600e3;
const COLORS = { ok: '#3dd6a0', warn: '#f5b945', hot: '#ff6358', idle: '#969aa8' };
const PALETTE = ['#4c8dff', '#a56bff', '#ff5fa2', '#19c8e6', '#ff8a3d', '#d4b483', '#e5e7eb', '#8bd450'];
const PROVIDER = { claude: { name: 'Claude', color: '#d97757' }, openai: { name: 'ChatGPT', color: '#10a37f' } };

let state = { platform: 'win32', accounts: [], selectedId: null, demo: false, pin: { available: false, hidden: 0 }, settings: null };
let bannerDismissed = false;
let forceAdd = false; // screenshots only
let view = 'main'; // 'main' | 'settings'
let showAdd = false;
let showColors = false;
let editingName = null; // account id while its name is being edited
let pendingRender = false;
let addError = null;
let armedRemove = null;
let busyAdd = false;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ───────── formatting ─────────
// Everything is stored as "% used"; the UI shows what is LEFT.
const level = (used) => (used == null ? 'idle' : used >= 85 ? 'hot' : used >= 60 ? 'warn' : 'ok');
const left = (used) => Math.max(0, Math.round(100 - used));

function fmtDur(ms, live = false) {
  if (ms == null) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (live && s < 300) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.max(m, s > 0 ? 1 : 0)}m`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts - Date.now() > 20 * 3600e3) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return time;
}

const winMs = (w, def) => (w && w.windowMs) || def;
const elapsedOf = (w, def) => (w && w.resetsAt != null ? Math.min(1, Math.max(0, 1 - (w.resetsAt - Date.now()) / winMs(w, def))) : null);

// ───────── rings ─────────
// Geometry comes from shapes.js (shared with the tray-icon rasteriser) so both always match.
// Thinner rings than the tray icon (which needs thick strokes to stay legible at 16px).
const svgLayout = (shape) => Shapes.layout(shape || 'circle', 100, 2, { thick: 0.09, gap: 0.04, hole: 0.27, edge: 0.03 });

// Arcs animate only when their value actually changes (or when first shown). Every re-render
// starts from the dash length that was on screen last time, so clicking around doesn't replay the fill.
const arcShown = new Map();

function ring(L, i, w, def, key) {
  const g = L.rings[i];
  const d = Shapes.pathD(L, i);
  const used = w ? w.pct : null;
  const el = elapsedOf(w, def);
  const tl = el == null ? null : 1 - el; // fraction of TIME left
  const col = COLORS[level(used)];
  const base = `d="${d}" pathLength="100" fill="none" stroke-width="${g.thick.toFixed(2)}" stroke-linejoin="miter"`;
  let s = `<path ${base} stroke="#fff" stroke-opacity="${tl == null ? 0.12 : 0.07}"/>`;
  if (tl != null && tl > 0) s += `<path ${base} stroke="#fff" stroke-opacity="0.13" stroke-dasharray="${(tl * 100).toFixed(2)} 100"/>`;
  const rem = used == null ? 0 : 100 - used;
  if (rem > 0.4) {
    const target = `${rem.toFixed(2)} 100`;
    const from = arcShown.get(key) || '0 100';
    arcShown.set(key, target);
    s += `<path class="arc" ${base} stroke="${col}" stroke-linecap="round" stroke-dasharray="${from}" data-d="${target}"/>`;
  } else {
    arcShown.delete(key);
  }
  if (tl != null) {
    const P = Shapes.pointOnRing(L, i, tl);
    const h = g.thick / 2 + 1.5;
    s += `<line x1="${(P.x - P.ux * h).toFixed(2)}" y1="${(P.y - P.uy * h).toFixed(2)}" x2="${(P.x + P.ux * h).toFixed(2)}" y2="${(P.y + P.uy * h).toFixed(2)}" stroke="#fff" stroke-opacity="0.95" stroke-width="1.7" stroke-linecap="round"/>`;
  }
  return s;
}

function ringsSVG(size, a, dot = false) {
  const u = a.usage;
  const stale = a.status === 'needs-login';
  const f = stale || !u ? null : u.fiveHour || { pct: 0, resetsAt: null };
  const w = stale || !u ? null : u.sevenDay || { pct: 0, resetsAt: null };
  const L = svgLayout(a.shape);
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}">${ring(L, 0, f, FIVE_H, `${a.id}:${size}:${a.shape}:0`)}${ring(L, 1, w, SEVEN_D, `${a.id}:${size}:${a.shape}:1`)}${dot ? `<circle cx="${L.cx.toFixed(2)}" cy="${L.cy.toFixed(2)}" r="${Math.min(9, L.dot).toFixed(2)}" fill="${esc(a.color || '#888')}"/>` : ''}</svg>`;
}

function shapeIcon(id, on) {
  const L = Shapes.layout(id, 100, 1, { thick: 0.1, hole: 0.05, edge: 0.04 });
  return `<button class="shp ${on ? 'on' : ''}" data-action="set-shape" data-shape="${id}" title="${Shapes.LABELS[id]}"><svg viewBox="0 0 100 100" width="34" height="34"><path d="${Shapes.pathD(L, 0)}" fill="none" stroke="currentColor" stroke-width="${L.rings[0].thick.toFixed(1)}" stroke-linejoin="miter"/></svg><span>${Shapes.LABELS[id]}</span></button>`;
}

// ───────── pace ─────────
function pace(w, def) {
  if (!w) return { cls: 'idle', text: 'No data yet' };
  if (w.resetsAt == null) return { cls: 'idle', text: 'No active window – it starts with your next message' };
  const now = Date.now();
  const ms = winMs(w, def);
  const el = elapsedOf(w, def);
  if (w.pct >= 99.5) return { cls: 'hot', text: `Limit reached – resets in ${fmtDur(w.resetsAt - now)}` };
  if (el < 0.03 || w.pct < 0.5) return { cls: 'ok', text: 'Fresh window – plenty of room' };
  const hitIn = ((100 - w.pct) / w.pct) * el * ms;
  if (hitIn < w.resetsAt - now) return { cls: 'hot', text: `At this pace you run out in ${fmtDur(hitIn)}` };
  const delta = w.pct - el * 100;
  if (delta > 5) return { cls: 'warn', text: `Burning ${Math.round(delta)}% faster than time – but you should make it` };
  if (delta < -5) return { cls: 'ok', text: `${Math.round(-delta)}% ahead of the clock – room to spare` };
  return { cls: 'ok', text: 'Right on pace' };
}

// ───────── main view ─────────
function limitBlock(title, w, def) {
  const lvl = level(w ? w.pct : null);
  const el = elapsedOf(w, def);
  const tl = el == null ? null : 1 - el;
  const p = pace(w, def);
  const remaining = w ? left(w.pct) : null;
  return `<div class="limit">
    <div class="row"><span class="title"><i style="background:${COLORS[lvl]}"></i>${title}</span><span class="pct" style="color:${COLORS[lvl]}">${remaining == null ? '–' : remaining + '% <small>left</small>'}</span></div>
    <div class="bar"><div class="fill" style="width:${w ? 100 - w.pct : 0}%;background:${COLORS[lvl]}"></div>${tl != null ? `<div class="now" style="left:${tl * 100}%"></div>` : ''}</div>
    <div class="meta"><span>${w && w.resetsAt != null ? `Resets in <b data-reset="${w.resetsAt}">${fmtDur(w.resetsAt - Date.now(), true)}</b>` : 'Not running'}</span><span>${w && w.resetsAt != null ? fmtClock(w.resetsAt) : ''}</span></div>
    <div class="pace ${p.cls}">${esc(p.text)}</div>
  </div>`;
}

function scopedBlock(list) {
  if (!list || !list.length) return '';
  return `<div class="scoped">${list
    .map((s) => `<div class="s"><span>${esc(s.label)} · week</span><div class="bar"><div class="fill" style="width:${100 - s.pct}%;background:${COLORS[level(s.pct)]}"></div></div><span>${left(s.pct)}%</span></div>`)
    .join('')}</div>`;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function colorPopover(a) {
  return `<div class="popover" role="dialog" aria-label="Account colour">
    <div class="ptitle">Account colour</div>
    <div class="swatches">${PALETTE.map((c) => `<button class="sw ${c.toLowerCase() === String(a.color).toLowerCase() ? 'on' : ''}" data-action="set-color" data-id="${esc(a.id)}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
    <label class="custom"><span>Custom</span><input type="color" id="color-input" data-id="${esc(a.id)}" value="${/^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#888888'}" /></label>
  </div>`;
}

function detailView(a) {
  const u = a.usage;
  const five = u ? u.fiveHour || { pct: 0, resetsAt: null } : null;
  const week = u ? u.sevenDay || { pct: 0, resetsAt: null } : null;
  const heroTime = five && five.resetsAt != null ? fmtDur(five.resetsAt - Date.now(), true) : u ? 'idle' : '…';
  const lvl5 = level(five ? five.pct : null);
  const prov = PROVIDER[a.provider] || PROVIDER.claude;
  const hole = svgLayout(a.shape).rings[1].dIn * 1.48; // inner hole radius in px at hero size
  const heroFont = Math.max(9, Math.min(21, hole * 0.52));
  let notice = '';
  if (a.status === 'needs-login') notice = `<div class="notice">Sign-in expired. <button class="link" data-action="relogin" data-id="${esc(a.id)}">Sign in again</button></div>`;
  else if (a.status === 'error') notice = `<div class="notice soft">${esc(a.error)}${u ? ' · showing last known values' : ''}</div>`;
  else if (a.status === 'loading' && !u) notice = `<div class="notice soft">Fetching usage…</div>`;

  return `<div class="hero">
      <div class="ring-wrap">${ringsSVG(148, a)}
        <div class="ring-center" style="transform:translate(${((svgLayout(a.shape).cx - 50) * 1.48).toFixed(1)}px,${((svgLayout(a.shape).cy - 50) * 1.48).toFixed(1)}px)"><b data-reset="${five && five.resetsAt != null ? five.resetsAt : ''}" style="color:${COLORS[lvl5]};font-size:${heroFont.toFixed(1)}px">${heroTime}</b>${heroFont >= 16 ? `<small>until ${five && five.windowMs && five.windowMs !== FIVE_H ? 'reset' : '5h reset'}</small>` : ''}</div>
      </div>
      <div class="who">
        <h2><button class="swatch" data-action="toggle-colors" title="Change account colour" style="background:${esc(a.color || '#888')}"></button>${
          editingName === a.id
            ? `<input class="name-input" id="name-input" maxlength="40" spellcheck="false" value="${esc(a.label)}" aria-label="Profile name" />`
            : `<span class="nm" data-action="rename" title="Click to rename">${esc(a.label)}</span><button class="pencil" data-action="rename" title="Rename" aria-label="Rename"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg></button>`
        }</h2>
        ${showColors ? colorPopover(a) : ''}
        <div class="email">${esc(a.email || '')}</div>
        <div class="chips"><span class="chip" style="color:${prov.color};background:${prov.color}22">${prov.name}</span>${a.plan ? `<span class="chip plan">${esc(a.plan)}</span>` : ''}</div>
        <div class="legend">
          <span><i style="background:${COLORS[lvl5]}"></i>Arc · quota left</span>
          <span><i style="background:#fff"></i>Tick · time left</span>
          <span><i style="background:${esc(a.color || '#888')}"></i>Dot · account colour</span>
        </div>
      </div>
    </div>
    ${notice}
    ${limitBlock('5-hour session', five, FIVE_H)}
    ${limitBlock('Weekly limit', week, SEVEN_D)}
    ${scopedBlock(u && u.scoped)}
    <div class="foot">
      <span>Updated ${ago(a.fetchedAt)}</span>
      <span class="btns">
        <button data-action="refresh" data-id="${esc(a.id)}">Refresh</button>
        <button class="danger ${armedRemove === a.id ? 'armed' : ''}" data-action="remove" data-id="${esc(a.id)}">${armedRemove === a.id ? 'Click again to remove' : 'Remove'}</button>
      </span>
    </div>`;
}

function addPanel() {
  const row = (provider, hint) => `<div class="prov"><div class="ptitle"><span class="chip" style="color:${PROVIDER[provider].color};background:${PROVIDER[provider].color}22">${PROVIDER[provider].name}</span><small>${hint}</small></div>
    <div class="pbtns"><button class="opt" data-action="add" data-provider="${provider}" data-mode="window"><b>Sign in here</b><span>Clean window – best for extra accounts</span></button>
    <button class="opt" data-action="add" data-provider="${provider}" data-mode="browser"><b>Use my browser</b><span>For Google / SSO sign-in</span></button></div></div>`;
  return `<div><b>Add an account</b>
    ${row('claude', 'Claude Pro / Max / Team')}
    ${row('openai', 'ChatGPT Plus / Pro / Team (Codex limits)')}
    ${busyAdd ? '<div class="err" style="color:var(--muted)">Waiting for sign-in to finish…</div>' : ''}
    ${addError ? `<div class="err">${esc(addError)}</div>` : ''}
  </div>`;
}

function emptyView() {
  return `<div class="empty">
    <svg viewBox="0 0 100 100" width="96" height="96"><circle cx="50" cy="50" r="44" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="9"/><circle cx="50" cy="50" r="31" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="9"/></svg>
    <h2>No accounts yet</h2>
    <p>Connect a Claude or ChatGPT account to see its 5-hour and weekly usage as live rings in your ${state.platform === 'darwin' ? 'menu bar' : 'system tray'}.</p>
    <button class="cta" data-action="toggle-add">Add account</button>
  </div>`;
}

// ───────── settings view ─────────
function toggle(path, on, label, sub = '', disabled = false) {
  return `<label class="tg ${disabled ? 'off' : ''}"><span class="tgl"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    <button class="sw-toggle ${on ? 'on' : ''}" role="switch" aria-checked="${on}" ${disabled ? 'disabled' : ''} data-action="toggle-setting" data-path="${path}"><i></i></button></label>`;
}

function select(path, value, options, suffix = '') {
  return `<select data-path="${path}">${options.map((o) => `<option value="${o}" ${Number(value) === o ? 'selected' : ''}>${o}${suffix}</option>`).join('')}</select>`;
}

function settingsView() {
  const st = state.settings;
  const acc = state.accounts.find((a) => a.id === state.selectedId) || state.accounts[0];
  if (!st) return '';
  const thr = [50, 75, 90, 95, 100];
  let html = `<div class="card">
    <div class="sec"><h3>General · all profiles</h3>
      <div class="line"><span class="tgl"><b>Refresh every</b><small>Shorter than 5 min can trigger rate limits</small></span>${select('refreshMin', st.refreshMin, st.refreshChoices, ' min')}</div>
      ${toggle('launchAtLogin', st.launchAtLogin, state.platform === 'darwin' ? 'Open at login' : 'Start with Windows', `Launches quietly in the ${state.platform === 'darwin' ? 'menu bar' : 'tray'}; sign-ins are remembered`)}
      ${state.platform === 'win32' ? `<div class="line col"><span class="tgl"><b>Icons on the taskbar</b><small>${state.pin.available ? (state.pin.hidden ? state.pin.hidden + ' icon(s) are hidden in the tray flyout' : 'All icons are on the taskbar') : 'Taskbar icon settings were not found on this PC'}</small></span><div class="btnrow"><button class="ghost" data-action="pin" ${state.pin.available ? '' : 'disabled'}>Open Windows settings</button><button class="ghost" data-action="pin-all" ${state.pin.available ? '' : 'disabled'}>Pin all (restarts Explorer)</button></div></div>` : ''}
    </div>`;
  if (!acc) return html + '</div>';
  const n = acc.notify;
  const curShape = acc.shape || 'circle';
  html += `<div class="profbar" style="--acc:${esc(acc.color || '#888')}"><i></i><span><b>${esc(acc.label)}</b><small>Appearance and notifications below apply to this profile only – pick another profile above to edit it</small></span></div>
    <div class="sec"><h3>Appearance</h3>
      <div class="line col"><span class="tgl"><b>Ring shape</b><small>Used in this profile's tray icon and in this window</small></span>
        <div class="shapes">${Shapes.IDS.map((id) => shapeIcon(id, id === curShape)).join('')}</div></div>
    </div>
    <div class="sec"><h3>Notifications</h3>
      ${toggle('notify.enabled', n.enabled, 'Enable notifications')}
      <div class="${n.enabled ? '' : 'dimmed'}">
        <div class="line col"><span class="tgl"><b>When usage reaches</b><small>Per ring, once per window</small></span>
          <div class="chipsel">${thr.map((t) => `<button class="cs ${n.thresholds.includes(t) ? 'on' : ''}" data-action="thr" data-value="${t}">${t}%</button>`).join('')}</div></div>
        ${toggle('notify.spike.enabled', n.spike.enabled, 'Heavy usage burst', 'A lot of quota gone in a short time')}
        <div class="line sub ${n.spike.enabled ? '' : 'dimmed'}"><span>Alert when</span>${select('notify.spike.pct', n.spike.pct, [5, 10, 15, 20, 30, 50], '%')}<span>is used within</span>${select('notify.spike.minutes', n.spike.minutes, [5, 10, 15, 30, 60], ' min')}</div>
        ${toggle('notify.pace.enabled', n.pace.enabled, 'Running out early', 'At your current pace you will not reach the reset')}
        <div class="line sub ${n.pace.enabled ? '' : 'dimmed'}"><span>Alert when it would run out within</span>${select('notify.pace.minutes', n.pace.minutes, [15, 30, 60, 120], ' min')}</div>
        ${toggle('notify.reset.enabled', n.reset.enabled, 'Window reset', 'Tell me when a 5h / weekly window starts fresh')}
        ${toggle('notify.auth.enabled', n.auth.enabled, 'Sign-in problems', 'This account needs to be signed in again')}
      </div>
      <div class="line"><button class="ghost" data-action="apply-all" ${state.accounts.length < 2 ? 'disabled' : ''}>Copy to all profiles</button><button class="ghost" data-action="test-notification">Send test notification</button></div>
    </div>
  </div>`;
  return html;
}

// ───────── render ─────────
function render() {
  if (editingName) {
    pendingRender = true; // never rebuild the DOM under the user's cursor
    return;
  }
  $('#demo-badge').hidden = !state.demo;
  const accs = state.accounts;
  const isSettings = view === 'settings';
  $('#btn-settings').classList.toggle('active', isSettings);
  const pinBtn = $('#btn-pin');
  pinBtn.hidden = state.platform !== 'win32'; // taskbar pinning is a Windows concept
  pinBtn.classList.toggle('active', state.pin.hidden > 0);
  pinBtn.disabled = !state.pin.available;
  pinBtn.title = !state.pin.available ? 'Taskbar icon settings were not found on this PC' : 'Show icons on the taskbar (opens Windows settings)';

  const banner = $('#banner');
  const showBanner = state.pin.available && state.pin.hidden > 0 && !bannerDismissed && !state.demo && !isSettings;
  banner.hidden = !showBanner;
  banner.innerHTML = showBanner
    ? `<div class="notice soft banner"><span>${state.pin.hidden === state.accounts.length ? 'Your icons are' : state.pin.hidden + ' of your ' + state.accounts.length + ' icons are'} hidden in Windows' tray flyout.</span><span class="bbtns"><button class="link" data-action="pin-all">Pin all (restarts Explorer)</button><button class="link" data-action="pin">Open Windows settings</button><button class="link" data-action="dismiss-banner" aria-label="Dismiss">✕</button></span></div>`
    : '';

  const panel = $('#add-panel');
  panel.hidden = !showAdd || isSettings;
  panel.innerHTML = showAdd ? (state.demo && !forceAdd ? '<div class="err" style="color:var(--muted)">Demo mode uses fake accounts – run <code>npm start</code> to add real ones.</div>' : addPanel()) : '';

  $('#strip').hidden = !accs.length;
  $('#detail').hidden = isSettings;
  $('#settings').hidden = !isSettings;

  const sel = accs.find((a) => a.id === state.selectedId) || accs[0];
  // the strip is shown (and kept in sync) in both views so you can switch profile from Settings too
  $('#strip').innerHTML = accs
    .map(
      (a) => `<button class="tile ${sel && a.id === sel.id ? 'sel' : ''} ${a.status === 'needs-login' ? 'dim' : ''}" data-action="select" data-id="${esc(a.id)}" style="--acc:${esc(a.color || '#d97757')}">${ringsSVG(52, a, true)}<span class="name"><i style="background:${esc(a.color || '#888')}"></i>${esc(a.label)}</span></button>`,
    )
    .join('');
  if (isSettings) $('#settings').innerHTML = settingsView();
  else $('#detail').innerHTML = sel ? detailView(sel) : emptyView();

  // grow arcs in
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelectorAll('.arc[data-d]').forEach((el) => (el.style.strokeDasharray = el.dataset.d))),
  );
  requestAnimationFrame(() => window.rings.resize(document.body.offsetHeight));
}

function startRename(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  editingName = id;
  $('#detail').innerHTML = detailView(acc); // render once with the input; later renders wait
  const input = $('#name-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function finishRename(commit) {
  const id = editingName;
  if (!id) return;
  const input = $('#name-input');
  const value = input ? input.value.trim() : '';
  editingName = null;
  if (commit && value) window.rings.rename(id, value);
  pendingRender = false;
  render();
}

// ───────── events ─────────
const selAcc = () => state.accounts.find((a) => a.id === state.selectedId) || state.accounts[0];

// global settings live on state.settings; everything else belongs to the selected profile
function savePath(path, value) {
  if (path === 'refreshMin' || path === 'launchAtLogin') window.rings.setSettings(setPath({}, path, value));
  else window.rings.setAccountSettings(selAcc().id, setPath({}, path, value));
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
  o[keys[keys.length - 1]] = value;
  return obj;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

document.addEventListener('change', (e) => {
  const el = e.target.closest('select[data-path]');
  if (!el) return;
  savePath(el.dataset.path, Number(el.value));
});

// close the colour popover when clicking anywhere else, or pressing Escape
document.addEventListener('mousedown', (e) => {
  if (showColors && !e.target.closest('.popover') && !e.target.closest('.swatch')) {
    showColors = false;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'name-input') {
    if (e.key === 'Enter') finishRename(true);
    else if (e.key === 'Escape') finishRename(false);
  } else if (e.key === 'Escape' && showColors) {
    showColors = false;
    render();
  }
});

document.addEventListener('focusout', (e) => {
  if (e.target.id === 'name-input' && editingName) finishRename(true);
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'color-input') window.rings.setColor(e.target.dataset.id, e.target.value);
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id, mode, provider } = el.dataset;
  switch (action) {
    case 'select':
      showAdd = false;
      state.selectedId = id;
      armedRemove = null;
      showColors = false;
      render();
      window.rings.select(id);
      break;
    case 'refresh-all':
      window.rings.refresh();
      break;
    case 'refresh':
      window.rings.refresh(id);
      break;
    case 'pin':
      window.rings.openTaskbarSettings();
      break;
    case 'pin-all':
      window.rings.pinAll();
      break;
    case 'dismiss-banner':
      bannerDismissed = true;
      render();
      break;
    case 'toggle-add':
      view = 'main';
      showAdd = !showAdd;
      addError = null;
      render();
      break;
    case 'toggle-settings':
      view = view === 'settings' ? 'main' : 'settings';
      showAdd = false;
      render();
      break;
    case 'rename':
      showColors = false;
      startRename(state.selectedId);
      break;
    case 'toggle-colors':
      showColors = !showColors;
      render();
      break;
    case 'set-color':
      showColors = false;
      window.rings.setColor(id, el.dataset.color);
      break;
    case 'toggle-setting': {
      const path = el.dataset.path;
      const cur = path === 'launchAtLogin' ? state.settings.launchAtLogin : getPath(selAcc(), path);
      savePath(path, !cur);
      break;
    }
    case 'thr': {
      const v = Number(el.dataset.value);
      const cur = selAcc().notify.thresholds;
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      window.rings.setAccountSettings(state.selectedId, { notify: { thresholds: next } });
      break;
    }
    case 'set-shape':
      window.rings.setAccountSettings(state.selectedId, { shape: el.dataset.shape });
      break;
    case 'apply-all':
      window.rings.applyToAll(state.selectedId);
      break;
    case 'test-notification':
      window.rings.testNotification();
      break;
    case 'add':
    case 'relogin': {
      busyAdd = true;
      addError = null;
      if (action === 'add') render();
      const res = await (action === 'add' ? window.rings.addAccount(provider, mode) : window.rings.relogin(id));
      busyAdd = false;
      if (res.ok) showAdd = false;
      else addError = res.error;
      render();
      break;
    }
    case 'remove':
      if (armedRemove === id) {
        armedRemove = null;
        window.rings.remove(id);
      } else {
        armedRemove = id;
        render();
        setTimeout(() => {
          if (armedRemove === id) {
            armedRemove = null;
            render();
          }
        }, 3000);
      }
      break;
    case 'quit':
      window.rings.quit();
      break;
  }
});

window.rings.onState((s) => {
  const hadSel = state.selectedId;
  state = s;
  if (hadSel !== s.selectedId) {
    armedRemove = null;
    showColors = false;
  }
  render();
});
window.rings.onResetView(() => {
  view = 'main';
  showAdd = false;
  showColors = false;
  render();
});
window.rings.getState().then((s) => {
  state = s;
  render();
});

// live countdowns (cheap) + periodic full refresh so the "now" ticks creep along
setInterval(() => {
  document.querySelectorAll('[data-reset]').forEach((el) => {
    const t = Number(el.dataset.reset);
    if (t) el.textContent = fmtDur(t - Date.now(), true);
  });
}, 1000);
setInterval(() => {
  if (document.hidden || busyAdd || view === 'settings' || document.activeElement?.tagName === 'SELECT') return;
  render();
}, 30000);

window.__showAdd = () => {
  forceAdd = true;
  showAdd = true;
  view = 'main';
  render();
};
window.__hideAdd = () => {
  forceAdd = false;
  showAdd = false;
  render();
};
// screenshot helper: ?view=settings
window.__setView = (v) => {
  view = v;
  showAdd = false;
  render();
};
