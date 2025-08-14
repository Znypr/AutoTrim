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