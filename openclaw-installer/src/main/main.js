// src/main/main.js
// Electron main process — creates the window and wires up IPC handlers
// for all installer actions (system check, npm install, onboard, etc.)

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const installer = require('./installer');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 860,
    minHeight: 580,
    resizable: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0A1628',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Handy during development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Open external links in the default browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC handlers (invoked from the renderer via preload) ----------

// Helper: stream log lines back to the renderer while a command runs
function makeLogger(channel = 'installer:log') {
  return (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, line);
    }
  };
}

ipcMain.handle('system:platform', () => ({
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
  arch: process.arch,
}));

ipcMain.handle('system:check-node', async () => {
  return installer.checkNode();
});

ipcMain.handle('system:open-external', async (_e, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('installer:install-openclaw', async () => {
  const log = makeLogger();
  try {
    await installer.installOpenClaw(log);
    return { ok: true };
  } catch (err) {
    log(`[error] ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('installer:save-config', async (_e, { provider, apiKey }) => {
  try {
    const configPath = await installer.writePreConfig({ provider, apiKey });
    return { ok: true, path: configPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('installer:launch-onboard', async () => {
  try {
    await installer.launchOnboardInTerminal();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('installer:launch-dashboard', async () => {
  try {
    await installer.launchDashboard();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
