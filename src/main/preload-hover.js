'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hover', {
  onData: (cb) => ipcRenderer.on('hover-data', (_e, a) => cb(a)),
  resize: (h) => ipcRenderer.send('hover-resize', h),
});
