'use strict';
// Taskbar visibility of our tray icons (Windows 11).
//
// Windows keeps a record per tray icon under
//   HKCU\Control Panel\NotifyIconSettings\<id>     (ExecutablePath, IconGuid, IsPromoted)
// "IsPromoted = 1" means "show on the taskbar" (the switch in Settings → Taskbar → Other system tray
// icons). Windows only reads that value when Explorer starts, so changing it from outside takes effect
// after an Explorer restart. We never write it behind your back – only from the explicit "Pin all" action.
//
// Note: we query values selectively. A plain `reg query /s` also dumps every icon's PNG snapshot and can
// grow to many MB, which is why this module never does that.

const { execFile, spawn } = require('child_process');

const KEY = 'HKCU\\Control Panel\\NotifyIconSettings';
const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** key path -> value for one named value, across all subkeys */
async function values(name) {
  const out = await reg(['query', KEY, '/s', '/v', name]);
  if (out == null) return null;
  const map = new Map();
  let key = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      key = line.trim();
      continue;
    }
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m && m[1] === name && key) map.set(key, m[2].trim());
  }
  return map;
}

/** This app's tray-icon records: [{ key, guid, promoted }] (guid is upper-case, no braces). */
async function ownIcons(execPath = process.execPath) {
  const [exes, guids, promoted] = await Promise.all([values('ExecutablePath'), values('IconGuid'), values('IsPromoted')]);
  if (exes == null) return null; // key missing → unsupported OS
  const me = norm(execPath);
  const icons = [];
  for (const [key, exe] of exes) {
    if (norm(exe) !== me) continue;
    const g = guids && guids.get(key);
    icons.push({
      key,
      guid: g ? g.replace(/[{}]/g, '').toUpperCase() : null,
      promoted: !!promoted && /^(0x1|1)$/.test(promoted.get(key) || ''),
    });
  }
  return icons;
}

async function status() {
  const icons = await ownIcons();
  if (icons == null) return { available: false, icons: [] };
  return { available: true, icons };
}

/** Sets the "show on taskbar" flag on every one of our icon records. Effective after Explorer restarts. */
async function setPinned(pinned) {
  const icons = await ownIcons();
  if (icons == null) return false;
  for (const i of icons) await reg(['add', i.key, '/v', 'IsPromoted', '/t', 'REG_DWORD', '/d', pinned ? '1' : '0', '/f']);
  return true;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, out) => resolve(err ? '' : String(out))));

/** Restarts the Windows shell so it re-reads the per-icon flags. The taskbar flickers for a moment. */
async function restartExplorer() {
  await run('taskkill', ['/f', '/im', 'explorer.exe']);
  // Windows normally relaunches the shell on its own; give it a moment, then make sure.
  await new Promise((r) => setTimeout(r, 3000));
  const list = await run('tasklist', ['/fi', 'imagename eq explorer.exe', '/fo', 'csv', '/nh']);
  if (!/explorer\.exe/i.test(list)) spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { status, setPinned, restartExplorer, ownIcons };
