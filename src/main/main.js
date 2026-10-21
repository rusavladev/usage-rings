'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, nativeImage, nativeTheme, powerMonitor, ipcMain, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Store } = require('./store');
const auth = require('./auth');
const usage = require('./usage');
const openai = require('./openai');
const pin = require('./pin');
const { renderRings } = require('./rings');
const { encodePNG } = require('./png');
const { demoAccounts } = require('./demo');
const { Tracker, normalizeNotify } = require('./notify-rules');
const Shapes = require('../renderer/shapes');

const PALETTE = ['#4c8dff', '#a56bff', '#ff5fa2', '#19c8e6', '#ff8a3d', '#d4b483', '#e5e7eb', '#8bd450'];

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SMOKE_IDX = process.argv.indexOf('--smoke');
const SMOKE = SMOKE_IDX > 0; // CI self-test: create everything (with demo data), check it, write screenshots, exit
const DEMO = process.argv.includes('--demo') || SMOKE;
const SMOKE_DIR = SMOKE ? path.resolve(process.argv[SMOKE_IDX + 1] && !process.argv[SMOKE_IDX + 1].startsWith('--') ? process.argv[SMOKE_IDX + 1] : 'smoke-out') : null;
const SHOT_IDX = process.argv.indexOf('--screenshots');
const SHOT_DIR = SHOT_IDX > 0 ? path.resolve(process.argv[SHOT_IDX + 1] || 'docs/img') : null;

const REFRESH_CHOICES = [1, 2, 5, 10, 15, 30, 60]; // minutes – the usage endpoints are touchy, so default is gentle (5)
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 20 * 1000;
const POPUP_W = 400;
const HOVER_W = 272;
const USER_AGENT = `usage-rings/${require('../../package.json').version}`;
const fetchImpl = (url, opts) => net.fetch(url, opts);

if (!DEMO && !app.requestSingleInstanceLock()) app.quit();
// Keep the same data folder whether we run from source or as the packaged "Usage Rings" app.
// The project used to be called "claude-usage-rings": move its data folder (accounts + the key that
// decrypts the tokens) to the new name once, so existing sign-ins survive the rename.
function migrateLegacyData() {
  const base = app.getPath('appData');
  const oldDir = path.join(base, 'claude-usage-rings');
  const newDir = path.join(base, 'usage-rings');
  if (DEMO || fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  try {
    fs.renameSync(oldDir, newDir);
  } catch {
    try {
      fs.mkdirSync(newDir, { recursive: true });
      for (const f of ['accounts.json', 'Local State', 'usage-debug.json']) {
        if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
      }
    } catch {
      /* first run will simply start empty */
    }
  }
}
migrateLegacyData();

// Demo / smoke / screenshot runs use a throw-away data folder so they never touch (or lock) your real one.
app.setPath('userData', DEMO ? path.join(require('os').tmpdir(), 'usage-rings-demo') : path.join(app.getPath('appData'), 'usage-rings'));
const AUMID = 'UsageRings.App';
if (IS_WIN) app.setAppUserModelId(AUMID);

let store;
let popup = null;
let placeholderTray = null;
let accounts = []; // runtime accounts
const trays = new Map(); // id -> Tray
let selectedId = null;
let anchor = null; // last tray bounds
let lastHide = 0;
let loginActive = false;
let taskbarDark = true;
const tracker = new Tracker();
let pinState = { available: false, loaded: false, promoted: new Set() }; // promoted = GUIDs Windows shows on the taskbar

// ───────────────────────────── helpers ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectTaskbarDark() {
  // macOS: the menu bar follows the system appearance. Windows: the taskbar theme is its own setting.
  if (!IS_WIN) return Promise.resolve(nativeTheme.shouldUseDarkColors);
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      { windowsHide: true },
      (err, out) => {
        if (err) return resolve(nativeTheme.shouldUseDarkColors);
        const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x(\d+)/i.exec(out);
        resolve(m ? m[1] === '0' : nativeTheme.shouldUseDarkColors);
      },
    );
  });
}

// A stable GUID per tray icon lets Windows keep a per-icon record (position, pinned state).
const trayGuid = (key) => {
  // (seed kept from the project's old name on purpose: changing it would give every icon a new identity)
  const h = crypto.createHash('sha1').update('claude-usage-rings:' + key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function makeTray(image, key) {
  try {
    return new Tray(image, trayGuid(key));
  } catch (e) {
    console.error('[tray] GUID icon failed, falling back:', e.message);
    return new Tray(image);
  }
}

const hexToRgb = (h) => (/^#[0-9a-f]{6}$/i.test(h || '') ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null);
const nextColor = () => PALETTE.find((c) => !accounts.some((a) => a.color === c)) || PALETTE[accounts.length % PALETTE.length];

function fmtDur(ms) {
  if (ms == null) return '–';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function persist() {
  if (DEMO) return;
  store.accounts = accounts.map((a) => ({ id: a.id, provider: a.provider, color: a.color, shape: a.shape, notify: a.notify, label: a.label, email: a.email, plan: a.plan, tokens: a.tokens }));
  store.selectedId = selectedId;
  try {
    store.save();
  } catch (e) {
    console.error('[store]', e.message);
  }
}

function publicState() {
  return {
    demo: DEMO,
    platform: process.platform,
    pin: { available: IS_WIN && pinState.available, hidden: hiddenIconCount() },
    settings: { refreshMin: store.settings.refreshMin, launchAtLogin: store.settings.launchAtLogin, refreshChoices: REFRESH_CHOICES },
    selectedId,
    now: Date.now(),
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      color: a.color,
      shape: a.shape,
      notify: a.notify,
      label: a.label,
      email: a.email,
      plan: a.plan,
      status: a.status,
      error: a.error,
      usage: a.usage,
      fetchedAt: a.fetchedAt,
      nextRefreshAt: a.nextAt || null,
    })),
  };
}

function broadcast() {
  if (popup && !popup.isDestroyed()) popup.webContents.send('state', publicState());
  updateTrays();
  sendHover();
}

// ───────────────────────────── hover card ─────────────────────────────
// Windows' native tray tooltip is plain text, so we show our own little card with bars instead.

let hoverWin = null;
let hoverId = null;
let hoverAnchor = null;
let hoverTimer = null;

function createHover() {
  hoverWin = new BrowserWindow({
    width: HOVER_W,
    height: 150,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#1b1c22',
    webPreferences: { preload: path.join(__dirname, 'preload-hover.js'), contextIsolation: true, sandbox: true },
  });
  hoverWin.setAlwaysOnTop(true, 'pop-up-menu');
  if (IS_MAC) hoverWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hoverWin.setIgnoreMouseEvents(true); // never steal the hover from the tray icon
  hoverWin.loadFile(path.join(__dirname, '..', 'renderer', 'hover.html'));
}

function hoverPayload(acc) {
  return { id: acc.id, label: acc.label, color: acc.color, provider: acc.provider, plan: acc.plan, status: acc.status, error: acc.error, usage: acc.usage };
}

function sendHover() {
  if (!hoverWin || hoverWin.isDestroyed() || !hoverId) return;
  const acc = accounts.find((a) => a.id === hoverId);
  if (!acc) return hideHover();
  hoverWin.webContents.send('hover-data', hoverPayload(acc));
}

function showHover(acc, bounds) {
  if (!hoverWin || hoverWin.isDestroyed() || (popup && popup.isVisible())) return;
  hoverId = acc.id;
  hoverAnchor = bounds;
  sendHover();
  const h = hoverWin.getBounds().height;
  const { x, y } = position(bounds, h, HOVER_W);
  hoverWin.setBounds({ x, y, width: HOVER_W, height: h });
  hoverWin.showInactive();
}

function hideHover() {
  clearTimeout(hoverTimer);
  hoverId = null;
  if (hoverWin && !hoverWin.isDestroyed() && hoverWin.isVisible()) hoverWin.hide();
}

// Electron's tray 'mouse-enter' / 'mouse-leave' events don't fire reliably on Windows, so we watch
// the cursor instead: cheap (one point-in-rect test per icon every 100 ms) and it works everywhere.
let hoverCandidate = null; // { id, since }

function trayUnderCursor() {
  const p = screen.getCursorScreenPoint();
  for (const acc of accounts) {
    const t = trays.get(acc.id);
    if (!t || t.isDestroyed()) continue;
    const b = t.getBounds();
    if (!b || !b.width || !b.height) continue;
    // An icon that lives in the hidden-icons flyout reports the position of the "^" button – ignore those.
    if (pinState.loaded && !isPromoted(acc)) continue;
    const pad = 1;
    if (p.x >= b.x - pad && p.x < b.x + b.width + pad && p.y >= b.y - pad && p.y < b.y + b.height + pad) return { acc, bounds: b };
  }
  return null;
}

function pollHover() {
  if (SMOKE || (DEMO && SHOT_DIR)) return; // screenshot + smoke runs drive the hover card by hand
  const hit = trayUnderCursor();
  if (process.env.RINGS_DEBUG) console.log('[hover] cursor', JSON.stringify(screen.getCursorScreenPoint()), hit ? hit.acc.label : '-', JSON.stringify([...trays].map(([id, t]) => t.getBounds())));
  if (!hit || (popup && popup.isVisible())) {
    hoverCandidate = null;
    if (hoverId && !hoverLeaveTimer) hoverLeaveTimer = setTimeout(() => ((hoverLeaveTimer = null), hideHover()), 150);
    return;
  }
  clearTimeout(hoverLeaveTimer);
  hoverLeaveTimer = null;
  if (hoverId === hit.acc.id) return;
  if (!hoverCandidate || hoverCandidate.id !== hit.acc.id) hoverCandidate = { id: hit.acc.id, since: Date.now() };
  else if (Date.now() - hoverCandidate.since >= 200) showHover(hit.acc, hit.bounds);
}
let hoverLeaveTimer = null;

ipcMain.on('hover-resize', (_e, h) => {
  if (!hoverWin || hoverWin.isDestroyed()) return;
  const height = Math.max(60, Math.min(Math.round(h), 400));
  const { x, y } = position(hoverAnchor, height, HOVER_W);
  hoverWin.setBounds({ x, y, width: HOVER_W, height });
});

// ───────────────────────────── tray ─────────────────────────────

function ringsFor(acc) {
  const u = acc?.usage;
  const live = u && acc.status !== 'needs-login';
  const win = (w, ms) => ({
    pct: live ? (w ? w.pct : 0) : null,
    elapsed: live && w ? usage.elapsedFraction(w.resetsAt, w.windowMs || ms) : null,
  });
  return [win(u?.fiveHour, usage.FIVE_HOURS), win(u?.sevenDay, usage.SEVEN_DAYS)];
}

function iconFor(acc) {
  const img = nativeImage.createEmpty();
  const rings = ringsFor(acc);
  const sizes = IS_MAC ? [[1, 18], [2, 36]] : [[1, 16], [1.5, 24], [2, 32], [3, 48]];
  for (const [scale, px] of sizes) {
    const png = encodePNG(px, px, renderRings({ size: px, rings, dark: taskbarDark, accent: hexToRgb(acc?.color), shape: acc?.shape }));
    img.addRepresentation({ scaleFactor: scale, dataURL: 'data:image/png;base64,' + png.toString('base64') });
  }
  return img;
}

function tooltipFor(acc) {
  if (acc.status === 'needs-login') return `${acc.label} — sign-in expired, click to re-login`;
  const u = acc.usage;
  if (!u) return `${acc.label} — ${acc.status === 'error' ? acc.error || 'error' : 'loading…'}`;
  const now = Date.now();
  const part = (name, w) =>
    w ? `${name} ${Math.round(w.pct)}%${w.resetsAt ? ` (↻ ${fmtDur(w.resetsAt - now)})` : ''}` : `${name} –`;
  return `${acc.label}\n${part('5h', u.fiveHour)}\n${part('Week', u.sevenDay)}`.slice(0, 127);
}

function updateTrays() {
  if (DEMO && SHOT_DIR) return; // keep screenshot runs deterministic and quiet (smoke mode does create trays)
  // Remove trays for deleted accounts
  for (const [id, t] of trays) {
    if (!accounts.some((a) => a.id === id)) {
      t.destroy();
      trays.delete(id);
    }
  }
  if (accounts.length === 0) {
    if (!placeholderTray) {
      placeholderTray = makeTray(iconFor(null), 'placeholder');
      placeholderTray.on('click', () => togglePopup(placeholderTray.getBounds()));
      placeholderTray.on('right-click', () => placeholderTray.popUpContextMenu(buildMenu(null)));
    }
    placeholderTray.setImage(iconFor(null));
    placeholderTray.setToolTip('Claude Usage Rings — click to add an account');
    return;
  }
  if (placeholderTray) {
    placeholderTray.destroy();
    placeholderTray = null;
  }
  for (const acc of accounts) {
    let t = trays.get(acc.id);
    if (!t) {
      t = makeTray(iconFor(acc), acc.id);
      t.on('click', () => {
        hideHover();
        selectedId = acc.id;
        persist();
        togglePopup(t.getBounds(), true);
        popup.webContents.send('reset-view');
        broadcast();
      });
      t.on('right-click', () => {
        hideHover();
        t.popUpContextMenu(buildMenu(acc));
      });
      trays.set(acc.id, t);
    }
    t.setImage(iconFor(acc));
    t.setToolTip(''); // the hover card replaces the text tooltip
  }
}

function buildMenu(acc) {
  const items = [];
  if (acc) items.push({ label: acc.label, enabled: false }, { type: 'separator' });
  items.push(
    {
      label: 'Show details',
      click: () => {
        if (acc) selectedId = acc.id;
        togglePopup((acc ? trays.get(acc.id) : placeholderTray)?.getBounds(), true);
        popup.webContents.send('reset-view');
        broadcast();
      },
    },
    { label: 'Refresh all', click: () => accounts.forEach((a) => refreshAccount(a, { manual: true })), enabled: !DEMO },
    { label: 'Add Claude account…', click: () => addAccount('claude', 'window'), enabled: !DEMO },
    { label: 'Add ChatGPT account…', click: () => addAccount('openai', 'window'), enabled: !DEMO },
    { type: 'separator' },
    { winOnly: true, label: 'Show icons on the taskbar…', enabled: pinState.available, click: () => openTaskbarSettings() },
    { winOnly: true, label: 'Pin all icons now (restarts Explorer)…', enabled: pinState.available, click: () => pinAll() },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: store.settings.launchAtLogin,
      enabled: !DEMO,
      click: (i) => applySettings({ launchAtLogin: i.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items.filter((i) => !i.winOnly || IS_WIN));
}

// ───────────────────────────── popup window ─────────────────────────────

function createPopup() {
  popup = new BrowserWindow({
    width: POPUP_W,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#14151a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  popup.setAlwaysOnTop(true, 'pop-up-menu');
  if (IS_MAC) popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  popup.on('blur', () => {
    if (loginActive || SHOT_DIR) return;
    popup.hide();
    lastHide = Date.now();
  });
}

function position(bounds, h, w = POPUP_W) {
  const b = bounds && bounds.width ? bounds : { x: screen.getPrimaryDisplay().workArea.width - 40, y: screen.getPrimaryDisplay().workArea.height, width: 16, height: 16 };
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  let x = Math.round(b.x + b.width / 2 - w / 2);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8);
  const above = b.y > wa.y + wa.height / 2;
  let y = above ? b.y - h - 8 : b.y + b.height + 8;
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8);
  return { x, y };
}

function placePopup(h) {
  const cap = screen.getDisplayNearestPoint(anchor || screen.getCursorScreenPoint()).workArea.height - 24;
  const height = Math.max(240, Math.min(Math.round(h || popup.getBounds().height), cap));
  const { x, y } = position(anchor, height);
  popup.setBounds({ x, y, width: POPUP_W, height });
}

function togglePopup(bounds, forceShow = false) {
  if (!popup) return;
  if (bounds && bounds.width) anchor = bounds;
  if (popup.isVisible() && !forceShow) {
    popup.hide();
    return;
  }
  if (!forceShow && Date.now() - lastHide < 250) return; // the click that blurred us also hit the tray
  placePopup();
  popup.show();
  popup.focus();
  popup.webContents.send('state', publicState());
}

// ───────────────────────────── data refresh ─────────────────────────────

function scheduleNext(acc, delay) {
  clearTimeout(acc.timer);
  const jitter = delay * (0.9 + Math.random() * 0.2);
  acc.nextAt = Date.now() + jitter;
  acc.timer = setTimeout(() => refreshAccount(acc), jitter);
}

async function refreshAccount(acc, { manual = false } = {}) {
  if (DEMO || acc.busy) return;
  if (manual && Date.now() - (acc.lastAttempt || 0) < MANUAL_COOLDOWN_MS) return;
  acc.busy = true;
  acc.lastAttempt = Date.now();
  let delay = pollMs();
  try {
    const isOpenAI = acc.provider === 'openai';
    const fetchRaw = () =>
      isOpenAI ? openai.fetchUsage(fetchImpl, acc.tokens, USER_AGENT) : usage.fetchUsage(fetchImpl, acc.tokens.accessToken, USER_AGENT);
    const renew = async () => {
      acc.tokens = await auth.refresh(fetchImpl, acc.provider, acc.tokens, USER_AGENT);
      if (isOpenAI && !acc.tokens.accountId) acc.tokens.accountId = auth.openaiProfile(acc.tokens).accountId;
      persist();
    };
    if (!acc.tokens.accessToken || acc.tokens.expiresAt - Date.now() < 90_000) await renew();
    let raw;
    try {
      raw = await fetchRaw();
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      await renew();
      raw = await fetchRaw();
    }
    acc.usage = isOpenAI ? openai.parseUsage(raw) : usage.parseUsage(raw);
    dumpRawUsage(acc, raw);
    acc.fetchedAt = Date.now();
    acc.status = 'ok';
    acc.error = null;
    acc.failures = 0;
  } catch (e) {
    acc.failures = (acc.failures || 0) + 1;
    if (e.code === 'invalid_grant') {
      acc.status = 'needs-login';
      acc.error = 'Sign-in expired';
      delay = MAX_BACKOFF_MS;
    } else {
      acc.status = 'error';
      acc.error = e.status === 429 ? `Rate limited by ${acc.provider === 'openai' ? 'OpenAI' : 'Anthropic'} – backing off` : e.message || 'Network error';
      delay = Math.min(MAX_BACKOFF_MS, Math.max(e.retryAfterMs || 0, e.status ? pollMs() * 2 ** (acc.failures - 1) : Math.min(pollMs(), 15_000 * 2 ** (acc.failures - 1))));
    }
  } finally {
    acc.busy = false;
    scheduleNext(acc, delay);
    notifyFor(acc);
    broadcast();
  }
}

// Keeps the last raw usage response (percentages and reset times only – no tokens) so odd
// responses can be diagnosed without re-querying the API.
function dumpRawUsage(acc, raw) {
  try {
    const file = path.join(app.getPath('userData'), 'usage-debug.json');
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first write */
    }
    all[`${acc.provider}:${acc.id.slice(0, 8)}`] = { fetchedAt: new Date().toISOString(), raw };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    /* diagnostics only */
  }
}

function startAccount(acc) {
  acc.status = acc.usage ? acc.status : 'loading';
  refreshAccount(acc);
}

// ───────────────────────────── account management ─────────────────────────────

async function addAccount(provider, mode, reloginId = null) {
  if (DEMO) return { ok: false, error: 'Demo mode – accounts are fake.' };
  if (loginActive) return { ok: false, error: 'A sign-in is already in progress.' };
  loginActive = true;
  try {
    const relogin = reloginId ? accounts.find((a) => a.id === reloginId) : null;
    if (relogin) provider = relogin.provider;
    const result = await auth.login(fetchImpl, { provider, mode, userAgent: USER_AGENT, parent: popup?.isVisible() ? popup : undefined });
    const tokens = result.tokens;
    let profile = result.profile || {};
    if (provider === 'openai') tokens.accountId = profile.accountId;
    else {
      try {
        profile = usage.parseProfile(await usage.fetchProfile(fetchImpl, tokens.accessToken, USER_AGENT));
      } catch {
        /* profile is cosmetic */
      }
    }
    let acc = relogin;
    if (!acc && profile.email) acc = accounts.find((a) => a.email === profile.email && a.provider === provider);
    if (acc) {
      acc.tokens = tokens;
      acc.status = 'loading';
      if (profile.plan) acc.plan = profile.plan;
    } else {
      acc = {
        id: crypto.randomUUID(),
        provider,
        color: nextColor(),
        shape: store.settings.shape || 'circle',
        notify: normalizeNotify(store.settings.notify),
        label: profile.name || (profile.email ? profile.email.split('@')[0] : `Account ${accounts.length + 1}`),
        email: profile.email,
        plan: profile.plan,
        tokens,
        status: 'loading',
        usage: null,
      };
      accounts.push(acc);
    }
    selectedId = acc.id;
    persist();
    broadcast();
    refreshAccount(acc);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === 'cancelled' ? null : e.message };
  } finally {
    loginActive = false;
    if (popup && !popup.isDestroyed() && popup.isVisible()) popup.focus();
  }
}

function removeAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  clearTimeout(acc.timer);
  tracker.forget(id);
  accounts = accounts.filter((a) => a.id !== id);
  if (selectedId === id) selectedId = accounts[0]?.id ?? null;
  persist();
  broadcast();
}

// ───────────────────────────── settings & notifications ─────────────────────────────

const pollMs = () => store.settings.refreshMin * 60 * 1000;

function applyLoginItem() {
  if (DEMO || SMOKE) return;
  if (!IS_WIN && !app.isPackaged) return; // from source on macOS this would register the generic Electron app
  app.setLoginItemSettings({
    openAtLogin: !!store.settings.launchAtLogin,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

/** Per-profile customisation: ring shape + notification rules. */
function mergeNotify(cur, patch) {
  const merged = { ...cur, ...patch };
  for (const k of ['spike', 'reset', 'pace', 'auth']) merged[k] = { ...cur[k], ...(patch[k] || {}) };
  return normalizeNotify(merged);
}

function setAccountSettings(id, patch) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc || !patch || typeof patch !== 'object') return;
  if (typeof patch.shape === 'string' && Shapes.LABELS[patch.shape]) acc.shape = patch.shape;
  if (patch.notify && typeof patch.notify === 'object') acc.notify = mergeNotify(acc.notify, patch.notify);
  persist();
  broadcast();
}

function applyToAll(id) {
  const src = accounts.find((a) => a.id === id);
  if (!src) return;
  for (const a of accounts) {
    a.shape = src.shape;
    a.notify = normalizeNotify(src.notify);
  }
  persist();
  broadcast();
}

function applySettings(patch = {}) {
  const st = store.settings;
  if (REFRESH_CHOICES.includes(Number(patch.refreshMin))) st.refreshMin = Number(patch.refreshMin);
  if (typeof patch.launchAtLogin === 'boolean') st.launchAtLogin = patch.launchAtLogin;
  persist();
  if (patch.launchAtLogin !== undefined) applyLoginItem();
  if (patch.refreshMin !== undefined) {
    // re-arm timers on the new cadence (counting from the last fetch)
    for (const a of accounts) if (!a.busy) scheduleNext(a, Math.max(5_000, pollMs() - (Date.now() - (a.fetchedAt || 0))));
  }
  broadcast();
  return publicState().settings;
}

// Unpackaged apps need a registered AppUserModelID or Windows silently drops their toasts.
function registerToastIdentity() {
  if (!IS_WIN) return;
  const key = ['HKCU', 'Software', 'Classes', 'AppUserModelId', AUMID].join('\\');
  const set = (name, value) => execFile('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, () => {});
  set('DisplayName', 'Usage Rings');
  set('IconUri', path.join(__dirname, '..', '..', 'assets', 'icon.png'));
  set('IconBackgroundColor', 'FF14151A');
}

// The supported way to give an unpackaged app a proper toast name + icon: a Start-menu shortcut
// that carries our AppUserModelID. (Also makes "Usage Rings" searchable in Start.)
function ensureStartMenuShortcut() {
  if (!IS_WIN) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Usage Rings.lnk');
    shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
      description: 'Live Claude / ChatGPT usage rings in your tray',
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
      iconIndex: 0,
      appUserModelId: AUMID,
    });
  } catch (e) {
    console.error('[shortcut]', e.message);
  }
}

function sendNotification(n, acc) {
  if (!Notification.isSupported()) {
    console.error('[notify] notifications are not supported here');
    return;
  }
  const png = encodePNG(64, 64, renderRings({ size: 64, rings: ringsFor(acc), dark: true, accent: hexToRgb(acc?.color), shape: acc?.shape }));
  const note = new Notification({
    title: n.title,
    body: n.body,
    icon: nativeImage.createFromBuffer(png),
    silent: n.kind === 'reset',
  });
  note.on('click', () => {
    if (acc) selectedId = acc.id;
    const t = acc ? trays.get(acc.id) : null;
    togglePopup(t ? t.getBounds() : anchor, true);
    popup.webContents.send('reset-view');
    broadcast();
  });
  note.on('failed', (_e, err) => console.error('[notify] failed:', err));
  note.show();
}

function notifyFor(acc) {
  if (DEMO) return;
  for (const n of tracker.evaluate(acc, acc.notify)) sendNotification(n, acc);
}

// ───────────────────────────── pin to taskbar ─────────────────────────────

// GUIDs are stored upper-case without braces in Windows' records
const guidOf = (id) => trayGuid(id).toUpperCase();
const isPromoted = (acc) => pinState.promoted.has(guidOf(acc.id));
const hiddenIconCount = () => (!IS_WIN || DEMO || !pinState.loaded ? 0 : accounts.filter((a) => !isPromoted(a)).length);

async function refreshPinState() {
  if (DEMO || !IS_WIN) return;
  const st = await pin.status();
  const before = hiddenIconCount();
  pinState = { available: st.available, loaded: true, promoted: new Set(st.icons.filter((i) => i.promoted && i.guid).map((i) => i.guid)) };
  if (before !== hiddenIconCount() || !before) broadcast();
}

function openTaskbarSettings() {
  shell.openExternal('ms-settings:taskbar');
}

// Windows only reads the per-icon "show on taskbar" flag when Explorer starts, so applying it right away
// means restarting Explorer (taskbar flickers, open File Explorer windows close). Always ask first.
async function pinAll() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Pin icons to the taskbar',
    message: 'Show all Usage Rings icons on the taskbar?',
    detail: 'Windows applies this by restarting Explorer: the taskbar flickers for a few seconds and any open File Explorer windows close. Your other apps are not affected.',
    buttons: ['Restart Explorer and pin', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  await pin.setPinned(true);
  await pin.restartExplorer();
  setTimeout(refreshPinState, 6000);
  return true;
}

// ───────────────────────────── IPC ─────────────────────────────

ipcMain.handle('get-state', () => publicState());
ipcMain.on('select', (_e, id) => {
  if (accounts.some((a) => a.id === id)) {
    selectedId = id;
    persist();
    broadcast();
  }
});
ipcMain.handle('add-account', (_e, provider, mode) => addAccount(provider === 'openai' ? 'openai' : 'claude', mode === 'browser' ? 'browser' : 'window'));
ipcMain.handle('relogin', (_e, id) => addAccount(null, 'window', id));
ipcMain.on('rename', (_e, id, label) => {
  const acc = accounts.find((a) => a.id === id);
  const name = typeof label === 'string' ? label.trim().slice(0, 40) : '';
  if (!acc || !name) return;
  acc.label = name;
  persist();
  broadcast();
});
ipcMain.on('set-color', (_e, id, color) => {
  const acc = accounts.find((a) => a.id === id);
  if (acc && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    acc.color = color;
    persist();
    broadcast();
  }
});
ipcMain.on('set-account-settings', (_e, id, patch) => setAccountSettings(id, patch));
ipcMain.on('apply-all', (_e, id) => applyToAll(id));
ipcMain.handle('set-settings', (_e, patch) => applySettings(patch && typeof patch === 'object' ? patch : {}));
ipcMain.on('test-notification', () => {
  const acc = accounts.find((a) => a.id === selectedId) || accounts[0];
  sendNotification({ kind: 'test', title: `${acc ? acc.label : 'Usage Rings'}: test notification`, body: 'Notifications are working. Click me to open the details.' }, acc);
});
ipcMain.handle('open-taskbar-settings', () => openTaskbarSettings());
ipcMain.handle('pin-all', () => pinAll());
ipcMain.on('remove', (_e, id) => removeAccount(id));
ipcMain.on('refresh', (_e, id) => {
  const list = id ? accounts.filter((a) => a.id === id) : accounts;
  list.forEach((a) => refreshAccount(a, { manual: true }));
});
ipcMain.on('resize', (_e, h) => {
  if (popup && !popup.isDestroyed()) placePopup(h);
});
ipcMain.on('quit', () => app.quit());

// ───────────────────────────── smoke test (CI) ─────────────────────────────

// Starts everything for real (demo data), checks that it all came up on this OS and writes
// screenshots. Used by the CI workflow on Windows and macOS.
async function runSmoke(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = (m) => fs.appendFileSync(path.join(dir, 'smoke-log.txt'), `${new Date().toISOString()} ${m}\n`);
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);
  log('start');
  const problems = [];
  const check = (ok, what) => {
    if (!ok) problems.push(what);
  };
  check(trays.size === accounts.length, `expected ${accounts.length} tray icons, got ${trays.size}`);
  for (const [id, t] of trays) {
    check(!t.isDestroyed(), 'tray destroyed');
    const b = t.getBounds();
    check(b && typeof b.x === 'number', 'tray bounds unavailable for ' + id);
  }
  check(popup && !popup.isDestroyed(), 'popup window missing');
  check(hoverWin && !hoverWin.isDestroyed(), 'hover window missing');

  const first = accounts[0];
  selectedId = first.id;
  popup.show();
  broadcast();
  await sleep(1500);
  const text = await popup.webContents.executeJavaScript('document.body.innerText');
  check(text.includes(first.label), 'popup did not render the selected account');
  fs.writeFileSync(path.join(dir, 'smoke-popup.png'), (await withTimeout(popup.webContents.capturePage(), 8000, 'popup capture')).toPNG());
  log('popup captured');
  popup.hide();

  hoverId = first.id;
  hoverAnchor = { x: 200, y: 200, width: 18, height: 18 };
  hoverWin.setBounds({ x: 200, y: 200, width: HOVER_W, height: 150 });
  hoverWin.showInactive();
  sendHover();
  await sleep(900);
  log('hover shown, visible=' + hoverWin.isVisible());
  const hoverText = await withTimeout(hoverWin.webContents.executeJavaScript('document.body.innerText'), 5000, 'hover text');
  check(hoverText.includes(first.label), 'hover card did not render the account');
  try {
    fs.writeFileSync(path.join(dir, 'smoke-hover.png'), (await withTimeout(hoverWin.webContents.capturePage(), 5000, 'hover capture')).toPNG());
    log('hover captured');
  } catch (e) {
    log('hover screenshot skipped: ' + e.message); // best effort – the text check above is the real test
  }

  const icon = iconFor(first);
  check(!icon.isEmpty(), 'tray icon image is empty');
  fs.writeFileSync(path.join(dir, 'smoke-tray-icon.png'), icon.toPNG());

  const result = { platform: process.platform, arch: process.arch, electron: process.versions.electron, trays: trays.size, problems };
  console.log('SMOKE_RESULT ' + JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'smoke-result.json'), JSON.stringify(result, null, 2));
  app.exit(problems.length ? 1 : 0);
}

// ───────────────────────────── screenshots (docs) ─────────────────────────────

async function runScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const save = (name, buf) => fs.writeFileSync(path.join(dir, name), buf);
  anchor = null;
  const names = ['popup-personal', 'popup-work', 'popup-side-project'];
  popup.show();
  for (let i = 0; i < 3; i++) {
    selectedId = accounts[i].id;
    broadcast();
    await sleep(1200);
    save(`${names[i]}.png`, (await popup.webContents.capturePage()).toPNG());
  }

  await popup.webContents.executeJavaScript('window.__setView("settings")');
  await sleep(1200);
  save('popup-settings.png', (await popup.webContents.capturePage()).toPNG());
  await popup.webContents.executeJavaScript('window.__setView("main")');
  for (const id of ['hexagon', 'star']) {
    const acc = accounts[id === 'hexagon' ? 1 : 0];
    acc.shape = id;
    selectedId = acc.id;
    broadcast();
    await sleep(1200);
    save(`popup-${id}.png`, (await popup.webContents.capturePage()).toPNG());
    acc.shape = 'circle';
  }
  broadcast();
  await sleep(300);

  selectedId = accounts[0].id;
  broadcast();
  await sleep(600);
  await popup.webContents.executeJavaScript("document.querySelector('.swatch').click()");
  await sleep(700);
  save('popup-colors.png', (await popup.webContents.capturePage()).toPNG());
  await popup.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await sleep(300);

  for (const i of [0, 2]) {
    hoverAnchor = { x: 900, y: 700, width: 16, height: 16 };
    hoverId = accounts[i].id;
    hoverWin.setBounds({ x: 200, y: 200, width: HOVER_W, height: 150 });
    hoverWin.showInactive();
    sendHover();
    await sleep(900);
    save(`hover-${i === 0 ? 'personal' : 'side-project'}.png`, (await hoverWin.webContents.capturePage()).toPNG());
  }
  hideHover();

  // add-account panel
  selectedId = accounts[0].id;
  broadcast();
  await popup.webContents.executeJavaScript('window.__showAdd()');
  await sleep(900);
  save('popup-add.png', (await popup.webContents.capturePage()).toPNG());
  await popup.webContents.executeJavaScript('window.__hideAdd()');
  await sleep(300);

  // individual tray icons (transparent) for the README hero image
  accounts.forEach((a, i) => {
    const px = 96;
    save(`tray-${i}.png`, encodePNG(px, px, renderRings({ size: px, rings: ringsFor(a), dark: true, roundCaps: true, accent: hexToRgb(a.color), shape: a.shape })));
  });

  // annotated "how to read a ring" picture for the README
  save('ring-big.png', encodePNG(420, 420, renderRings({ size: 420, rings: ringsFor(accounts[0]), dark: true, roundCaps: true, accent: hexToRgb(accounts[0].color), shape: 'circle' })));
  const anat = new BrowserWindow({ width: 1000, height: 520, show: true, frame: false, useContentSize: true, backgroundColor: '#0d0e12', webPreferences: { sandbox: true, contextIsolation: true } });
  await anat.loadFile(path.join(__dirname, '..', '..', 'scripts', 'anatomy.html'));
  await sleep(1200);
  save('anatomy.png', (await anat.webContents.capturePage()).toPNG());
  anat.destroy();

  // README hero: popups + hover card + tray icons on a mock taskbar
  const hero = new BrowserWindow({ width: 1600, height: 900, show: true, frame: false, useContentSize: true, backgroundColor: '#0d0e12', webPreferences: { sandbox: true, contextIsolation: true } });
  await hero.loadFile(path.join(__dirname, '..', '..', 'scripts', 'hero.html'));
  await sleep(1500);
  save('hero.png', (await hero.webContents.capturePage()).toPNG());
  hero.destroy();

  // Tray strip: the icons as they appear on a dark taskbar, enlarged.
  const size = 128;
  const pad = 28;
  const W = pad + accounts.length * (size + pad);
  const Hh = size + pad * 2;
  const bg = [32, 32, 32, 255];
  const canvas = Buffer.alloc(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) bg.forEach((v, k) => (canvas[i * 4 + k] = v));
  accounts.forEach((a, idx) => {
    const icon = renderRings({ size, rings: ringsFor(a), dark: true, roundCaps: true, accent: hexToRgb(a.color), shape: a.shape });
    const ox = pad + idx * (size + pad);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4;
        const d = ((y + pad) * W + ox + x) * 4;
        const al = icon[s + 3] / 255;
        for (let k = 0; k < 3; k++) canvas[d + k] = Math.round(icon[s + k] * al + canvas[d + k] * (1 - al));
      }
    }
  });
  save('tray-strip.png', encodePNG(W, Hh, canvas));
  save('logo.png', encodePNG(512, 512, renderRings({ size: 512, rings: [{ pct: 28, elapsed: 0.55 }, { pct: 62, elapsed: 0.3 }], dark: true, accent: [76, 141, 255] })));
  app.quit();
}

// ───────────────────────────── lifecycle ─────────────────────────────

app.on('second-instance', () => {
  const first = [...trays.values()][0] || placeholderTray;
  if (first) togglePopup(first.getBounds(), true);
});

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide(); // menu-bar app: no Dock icon
  taskbarDark = await detectTaskbarDark();
  store = new Store(app.getPath('userData'));

  if (DEMO) {
    accounts = demoAccounts().map((a) => ({ ...a, shape: 'circle', notify: normalizeNotify(null) }));
  } else {
    store.load();
    accounts = store.accounts.map((a) => ({ ...a, status: 'loading', usage: null }));
    accounts.forEach((a) => {
      if (!a.color) a.color = nextColor();
    });
  }
  selectedId = (DEMO ? null : store.selectedId) || accounts[0]?.id || null;

  registerToastIdentity();
  if (!DEMO) ensureStartMenuShortcut();
  if (!DEMO) persist(); // writes migrated per-profile settings back to disk
  if (!DEMO) {
    // first run → start with Windows by default (can be switched off in settings)
    applyLoginItem();
  }
  createPopup();
  createHover();
  updateTrays();
  setInterval(pollHover, 100);
  if (IS_WIN) {
    setTimeout(refreshPinState, 3000);
    setInterval(refreshPinState, 8000); // pick up changes made in Windows Settings
  }
  nativeTheme.on('updated', async () => {
    taskbarDark = await detectTaskbarDark();
    updateTrays();
  });

  // Keep the icons' "time elapsed" markers and tooltips fresh without hitting the API.
  setInterval(updateTrays, 60 * 1000);
  // Wake-from-sleep: refresh immediately instead of waiting for the next poll.
  powerMonitor.on('resume', () => accounts.forEach((a) => refreshAccount(a, { manual: false })));

  accounts.forEach((a, i) => setTimeout(() => startAccount(a), i * 1500));
  if (process.argv.includes('--hover-test')) setTimeout(() => showHover(accounts[0], { x: 2200, y: 1395, width: 16, height: 16 }), 5000);
  if (process.argv.includes('--notify-test')) setTimeout(() => ipcMain.emit('test-notification'), 6000);

  if (SMOKE) setTimeout(() => runSmoke(SMOKE_DIR).catch((e) => { console.error('SMOKE_FAIL', e); app.exit(1); }), 6000);

  if (SHOT_DIR) {
    popup.webContents.once('did-finish-load', () => setTimeout(() => runScreenshots(SHOT_DIR).catch((e) => { console.error(e); app.quit(); }), 800));
  }
});

app.on('window-all-closed', (e) => e.preventDefault()); // tray app: stay alive
