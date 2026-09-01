const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workerDesktop', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  clearStoredToken: () => ipcRenderer.invoke('token:clear'),
  checkRuntime: (config) => ipcRenderer.invoke('runtime:check', config),
  getRuntimePolicy: (config) => ipcRenderer.invoke('runtime:policy', config),
  getRuntimeModels: (config) => ipcRenderer.invoke('runtime:models', config),
  prepareRuntime: (payload) => ipcRenderer.invoke('runtime:prepare', payload),
  startWorker: (config) => ipcRenderer.invoke('worker:start', config),
  stopWorker: () => ipcRenderer.invoke('worker:stop'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  showWindow: () => ipcRenderer.invoke('app:show-window'),
  updateTrayHubStatus: (payload) => ipcRenderer.invoke('app:update-tray-status', payload),
  getTrayStatus: () => ipcRenderer.invoke('app:get-tray-status'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  getStatus: () => ipcRenderer.invoke('worker:status'),
  getWorkerOverview: (config) => ipcRenderer.invoke('worker:overview', config),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onLog: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('worker:log', listener);
    return () => ipcRenderer.removeListener('worker:log', listener);
  },
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('worker:status', listener);
    return () => ipcRenderer.removeListener('worker:status', listener);
  },
  onCloseToTrayHint: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:close-to-tray-hint', listener);
    return () => ipcRenderer.removeListener('app:close-to-tray-hint', listener);
  },
  onLifecycleEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:lifecycle', listener);
    return () => ipcRenderer.removeListener('app:lifecycle', listener);
  },
});
