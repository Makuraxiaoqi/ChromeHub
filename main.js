const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeImage
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { StateStore } = require('./lib/store');
const { BrowserRuntime } = require('./lib/runtime');
const { importExtensionFromPath } = require('./lib/extensions');
const { parseUserScript } = require('./lib/scripts');
const { chromiumStatus, installChromium } = require('./lib/chromium');
const { ensureDir } = require('./lib/util');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.makura.chromehub');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let mainWindow = null;
let tray = null;
let store = null;
let runtime = null;
let isQuitting = false;
let installingBrowser = false;
let balloonShown = false;

const userDataDir = app.getPath('userData');
const extensionsRoot = path.join(userDataDir, 'extensions');
const profilesRoot = path.join(userDataDir, 'profiles');

function iconPath() {
  const png = path.join(__dirname, 'assets', 'icon.png');
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  if (process.platform === 'linux') {
    if (fs.existsSync(png)) return png;
    if (fs.existsSync(ico)) return ico;
    return '';
  }
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return '';
}

function sendRuntimeStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:status', status);
  }
  updateTray(status);
}

function runningCount(status = runtime?.status() || []) {
  return status.filter((item) => item.state === 'running' || item.state === 'starting').length;
}

function updateTray(status) {
  if (!tray) return;
  const count = runningCount(status);
  tray.setToolTip(count ? `ChromeHub · ${count} 个浏览器运行中` : 'ChromeHub 多开管家');
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    const iconFile = iconPath();
    const image = iconFile ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip('ChromeHub 多开管家');
    const menu = Menu.buildFromTemplate([
      { label: '显示主界面', click: showMainWindow },
      {
        label: '停止全部浏览器',
        click: async () => {
          await runtime.stopAll();
        }
      },
      { type: 'separator' },
      {
        label: '退出 ChromeHub',
        click: async () => {
          isQuitting = true;
          await runtime.stopAll();
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  } catch (error) {
    tray = null;
    console.warn(`托盘不可用：${error.message}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    title: 'ChromeHub 多开管家',
    show: false,
    autoHideMenuBar: true,
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (runningCount() > 0 && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!balloonShown) {
        balloonShown = true;
        if (process.platform === 'win32') {
          try {
            tray.displayBalloon({
              title: 'ChromeHub 仍在运行',
              content: '窗口已收进托盘，浏览器页面和脚本会继续常驻运行。'
            });
          } catch {
            /* ignore */
          }
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: 'ChromeHub',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    paths: {
      userData: userDataDir,
      extensions: extensionsRoot,
      profiles: profilesRoot,
      state: path.join(userDataDir, 'state.json')
    },
    browser: chromiumStatus(),
    runtime: runtime.status()
  }));

  ipcMain.handle('state:load', () => store.get());
  ipcMain.handle('state:save', async (_event, state) => {
    const saved = await store.save(state);
    return saved;
  });

  ipcMain.handle('ext:import-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 CRX / ZIP 扩展',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Chrome 扩展', extensions: ['crx', 'zip'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled) return { extensions: [], errors: [] };
    return importExtensions(result.filePaths);
  });

  ipcMain.handle('ext:import-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入已解压的扩展文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled) return { extensions: [], errors: [] };
    return importExtensions(result.filePaths);
  });

  ipcMain.handle('ext:delete', async (_event, id) => {
    const ext = store.get().extensions.find((item) => item.id === id);
    if (ext?.path && ext.path.startsWith(extensionsRoot)) {
      await fsp.rm(ext.path, { recursive: true, force: true });
    }
    return true;
  });

  ipcMain.handle('ext:open', async (_event, id) => {
    const ext = store.get().extensions.find((item) => item.id === id);
    if (ext?.path) await shell.openPath(ext.path);
    return true;
  });

  ipcMain.handle('script:import-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入用户脚本',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '用户脚本', extensions: ['js'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled) return [];
    const scripts = [];
    for (const file of result.filePaths) {
      try {
        const text = await fsp.readFile(file, 'utf8');
        scripts.push({ ...parseUserScript(text, path.basename(file)), sourceFile: file });
      } catch {
        /* ignore unreadable */
      }
    }
    return scripts;
  });

  ipcMain.handle('script:parse', (_event, text, fallbackName) => {
    return parseUserScript(text, fallbackName || '未命名脚本');
  });

  ipcMain.handle('profile:launch', async (_event, id) => {
    const status = await runtime.launch(id);
    return status;
  });
  ipcMain.handle('profile:stop', async (_event, id) => {
    await runtime.stop(id);
    return true;
  });
  ipcMain.handle('profile:stop-all', async () => {
    await runtime.stopAll();
    return true;
  });
  ipcMain.handle('runtime:status', () => runtime.status());
  ipcMain.handle('runtime:metrics', () => runtime.metricsAll());

  ipcMain.handle('profile:open-data', async (_event, id) => {
    const dir = ensureDir(runtime.profileDir(id));
    await shell.openPath(dir);
    return true;
  });
  ipcMain.handle('profile:open-downloads', async (_event, id) => {
    const dir = ensureDir(runtime.downloadsDir(id));
    await shell.openPath(dir);
    return true;
  });
  ipcMain.handle('profile:clear-data', async (_event, id) => {
    await runtime.stop(id);
    await fsp.rm(runtime.profileDir(id), { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('browser:status', () => chromiumStatus());
  ipcMain.handle('browser:install', async (_event, force) => {
    if (installingBrowser) throw new Error('浏览器内核正在安装中');
    installingBrowser = true;
    try {
      if (force) await runtime.stopAll();
      return await installChromium((progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser:install-progress', progress);
        }
      }, { force: !!force });
    } finally {
      installingBrowser = false;
    }
  });
  ipcMain.handle('browser:open-cache', async () => {
    const status = chromiumStatus();
    await shell.openPath(status.cacheDir);
    return true;
  });

  ipcMain.handle('shell:open-path', async (_event, target) => {
    if (typeof target === 'string' && target) await shell.openPath(target);
    return true;
  });
  ipcMain.handle('shell:show-item', (_event, target) => {
    if (typeof target === 'string' && target) shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('app:open-user-data', async () => {
    await shell.openPath(userDataDir);
    return true;
  });
  ipcMain.handle('app:copy-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
}

async function importExtensions(paths) {
  const state = store.get();
  const imported = [];
  const errors = [];
  for (const source of paths) {
    try {
      const meta = importExtensionFromPath(source, extensionsRoot);
      const existing = state.extensions.find((item) => item.name === meta.name && item.version === meta.version);
      if (existing) {
        await fsp.rm(meta.path, { recursive: true, force: true });
        imported.push({ ...existing, duplicate: true });
      } else {
        imported.push(meta);
      }
    } catch (error) {
      errors.push({ source, message: error.message });
    }
  }
  return { extensions: imported, errors };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
    if (mainWindow) mainWindow.webContents.send('app:open-profile', '');
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    ensureDir(userDataDir);
    ensureDir(extensionsRoot);
    ensureDir(profilesRoot);
    store = new StateStore(userDataDir);
    store.load();
    runtime = new BrowserRuntime({
      getState: () => store.get(),
      userDataDir,
      onEvent: (event) => {
        if (event.type === 'status') sendRuntimeStatus(event.status);
      }
    });
    registerIpc();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    try {
      await runtime?.stopAll();
    } finally {
      app.exit(0);
    }
  });

  app.on('window-all-closed', () => {
    if (isQuitting) return;
    if (tray && runningCount() > 0) return;
    app.quit();
  });
}
