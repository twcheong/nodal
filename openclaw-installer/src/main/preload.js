// src/main/preload.js
// Safely exposes a small, typed API to the renderer via contextBridge.
// The renderer NEVER gets direct access to Node.js — only these methods.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openclaw', {
  // One-shot queries
  getPlatform: () => ipcRenderer.invoke('system:platform'),
  checkNode: () => ipcRenderer.invoke('system:check-node'),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),

  // Installer actions
  installOpenClaw: () => ipcRenderer.invoke('installer:install-openclaw'),
  saveConfig: (payload) => ipcRenderer.invoke('installer:save-config', payload),
  launchOnboard: () => ipcRenderer.invoke('installer:launch-onboard'),
  launchDashboard: () => ipcRenderer.invoke('installer:launch-dashboard'),

  // Streamed logs from long-running commands
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('installer:log', listener);
    return () => ipcRenderer.removeListener('installer:log', listener);
  },
});
