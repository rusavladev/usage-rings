'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rings', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onResetView: (cb) => ipcRenderer.on('reset-view', () => cb()),
  select: (id) => ipcRenderer.send('select', id),
  addAccount: (provider, mode) => ipcRenderer.invoke('add-account', provider, mode),
  rename: (id, label) => ipcRenderer.send('rename', id, label),
  setColor: (id, color) => ipcRenderer.send('set-color', id, color),
  openTaskbarSettings: () => ipcRenderer.invoke('open-taskbar-settings'),
  pinAll: () => ipcRenderer.invoke('pin-all'),
  relogin: (id) => ipcRenderer.invoke('relogin', id),
  remove: (id) => ipcRenderer.send('remove', id),
  refresh: (id) => ipcRenderer.send('refresh', id),
  resize: (h) => ipcRenderer.send('resize', h),
  setAccountSettings: (id, patch) => ipcRenderer.send('set-account-settings', id, patch),
  applyToAll: (id) => ipcRenderer.send('apply-all', id),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  testNotification: () => ipcRenderer.send('test-notification'),
  quit: () => ipcRenderer.send('quit'),
});
