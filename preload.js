// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('py', {
  send: (cmd, data = {}) => ipcRenderer.invoke('py:send', { cmd, ...data }),
  saveTemp: (arrayBuffer, ext = 'mp4') => ipcRenderer.invoke('py:saveTemp', { arrayBuffer, ext }),
  onEvent: (handler) => {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('py:event', listener);
    return () => ipcRenderer.off('py:event', listener);
  }
});

// System helpers
contextBridge.exposeInMainWorld('sys', {
  chooseSave: (opts = {}) => ipcRenderer.invoke('sys:chooseSave', opts),
  chooseOpen: (opts = {}) => ipcRenderer.invoke('sys:chooseOpen', opts),
  chooseDir:  (opts = {}) => ipcRenderer.invoke('sys:chooseDir', opts),
  getSettings: () => ipcRenderer.invoke('sys:getSettings'),
  setSettings: (partial = {}) => ipcRenderer.invoke('sys:setSettings', partial),
  pathJoin: (a, b) => ipcRenderer.invoke('sys:pathJoin', a, b),
  fsStat: (p) => ipcRenderer.invoke('sys:fsStat', p),
  showInFolder: (path) => ipcRenderer.invoke('sys:showInFolder', path),
  openFile: (path) => ipcRenderer.invoke('sys:openFile', path),
});