const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  request: (payload) => ipcRenderer.invoke('py:request', payload),
  onProgress: (fn) => ipcRenderer.on('py:progress', (_e, data) => fn(data))
});
