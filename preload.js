const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  getInfo: () => ipcRenderer.invoke('app:info'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),

  importExtensionFiles: () => ipcRenderer.invoke('ext:import-files'),
  importExtensionFolder: () => ipcRenderer.invoke('ext:import-folder'),
  deleteExtension: (id) => ipcRenderer.invoke('ext:delete', id),
  openExtension: (id) => ipcRenderer.invoke('ext:open', id),

  importScriptFile: () => ipcRenderer.invoke('script:import-file'),
  parseScript: (text, fallbackName) => ipcRenderer.invoke('script:parse', text, fallbackName),

  launchProfile: (id) => ipcRenderer.invoke('profile:launch', id),
  stopProfile: (id) => ipcRenderer.invoke('profile:stop', id),
  stopAllProfiles: () => ipcRenderer.invoke('profile:stop-all'),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  getMetrics: () => ipcRenderer.invoke('runtime:metrics'),
  openProfileData: (id) => ipcRenderer.invoke('profile:open-data', id),
  openProfileDownloads: (id) => ipcRenderer.invoke('profile:open-downloads', id),
  clearProfileData: (id) => ipcRenderer.invoke('profile:clear-data', id),

  getBrowserStatus: () => ipcRenderer.invoke('browser:status'),
  installBrowser: (force) => ipcRenderer.invoke('browser:install', !!force),
  openBrowserCache: () => ipcRenderer.invoke('browser:open-cache'),

  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
  showItem: (target) => ipcRenderer.invoke('shell:show-item', target),
  openUserData: () => ipcRenderer.invoke('app:open-user-data'),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),

  onRuntimeStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
  onBrowserInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('browser:install-progress', listener);
    return () => ipcRenderer.removeListener('browser:install-progress', listener);
  },
  onOpenProfile: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('app:open-profile', listener);
    return () => ipcRenderer.removeListener('app:open-profile', listener);
  }
});
