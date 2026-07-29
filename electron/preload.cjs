const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerNative', {
  library: {
    importDocuments: () => ipcRenderer.invoke('library:import'),
    exportNotes: (payload) => ipcRenderer.invoke('library:export', payload),
    deleteDocument: (payload) => ipcRenderer.invoke('library:delete', payload),
  },
  weread: {
    open: (bounds) => ipcRenderer.invoke('weread:open', bounds),
    hide: () => ipcRenderer.invoke('weread:hide'),
    setBounds: (bounds) => ipcRenderer.invoke('weread:set-bounds', bounds),
    login: () => ipcRenderer.invoke('weread:login'),
    importCookie: (payload) => ipcRenderer.invoke('weread:import-cookie', payload),
    logout: () => ipcRenderer.invoke('weread:logout'),
    status: () => ipcRenderer.invoke('weread:status'),
    setAssist: (settings) => ipcRenderer.invoke('weread:set-assist', settings),
    assistAction: (action) => ipcRenderer.invoke('weread:assist-action', action),
    onAssistDiagnostics: (listener) => {
      const wrapped = (_event, value) => listener(value);
      ipcRenderer.on('weread:assist-diagnostics', wrapped);
      ipcRenderer.invoke('weread:get-assist-diagnostics').then(listener).catch(() => undefined);
      return () => ipcRenderer.removeListener('weread:assist-diagnostics', wrapped);
    },
  },
});
