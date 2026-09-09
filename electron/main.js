const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { SecureStore } = require('./store');
const { MonitorService } = require('./monitor');
const { UpdateService } = require('./updater');
const { normalizeNavigationUrl } = require('./navigation');

let mainWindow;
let store;
let monitor;
let updater;

function state() {
  return { ...store.publicState(monitor.runtime), updater: updater?.runtime };
}

function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:changed', state());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 650,
    title: '交收监控',
    backgroundColor: '#09111f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

app.whenReady().then(() => {
  store = new SecureStore(app.getPath('userData'));
  store.load();
  monitor = new MonitorService(store, publish);
  updater = new UpdateService(store, publish);
  createWindow();
  monitor.start();
  updater.start();

  ipcMain.handle('state:get', () => state());
  ipcMain.handle('telegram:save', (_event, input) => {
    store.update((data) => {
      data.telegram.chatId = String(input.chatId || '').trim();
      if (String(input.botToken || '').trim()) data.telegram.botToken = String(input.botToken).trim();
    });
    publish();
    return { ok: true };
  });
  ipcMain.handle('telegram:test', async () => {
    await monitor.testTelegram();
    return { ok: true };
  });
  ipcMain.handle('update:save', (_event, input) => {
    store.update((data) => {
      data.update = {
        feedUrl: String(input.feedUrl || '').trim(),
        autoCheck: input.autoCheck !== false,
      };
    });
    updater.start();
    publish();
    return { ok: true };
  });
  ipcMain.handle('update:check', async () => {
    await updater.check(false);
    return { ok: true };
  });
  ipcMain.handle('update:install', () => {
    updater.install();
    return { ok: true };
  });
  ipcMain.handle('account:save', (_event, input) => {
    const clean = {
      name: String(input.name || '').trim(),
      navUrl: normalizeNavigationUrl(input.navUrl),
      username: String(input.username || '').trim(),
      operator: input.operator === 'lte' ? 'lte' : 'gte',
      threshold: Number(input.threshold),
      intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 5),
      enabled: input.enabled !== false,
    };
    if (!clean.name || !clean.navUrl || !clean.username || !Number.isFinite(clean.threshold)) {
      throw new Error('请完整填写账号名称、导航网址、账号和提醒金额');
    }
    let savedId;
    store.update((data) => {
      const existing = data.accounts.find((account) => account.id === input.id);
      if (existing) {
        Object.assign(existing, clean);
        if (String(input.securityCode || '')) existing.securityCode = String(input.securityCode);
        if (String(input.password || '')) existing.password = String(input.password);
        if (!existing.securityCode || !existing.password) throw new Error('安全码和密码不能为空');
        savedId = existing.id;
      } else {
        if (!input.securityCode || !input.password) throw new Error('安全码和密码不能为空');
        const created = { ...clean, id: crypto.randomUUID(), securityCode: String(input.securityCode), password: String(input.password) };
        data.accounts.push(created);
        savedId = created.id;
      }
    });
    monitor.runtime.delete(savedId);
    store.addEvent('success', `${clean.name}：监控配置已保存`, savedId);
    publish();
    return { ok: true, id: savedId };
  });
  ipcMain.handle('account:remove', (_event, id) => {
    store.update((data) => { data.accounts = data.accounts.filter((account) => account.id !== id); });
    monitor.runtime.delete(id);
    publish();
    return { ok: true };
  });
  ipcMain.handle('account:toggle', (_event, { id, enabled }) => {
    store.update((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (account) account.enabled = Boolean(enabled);
    });
    publish();
    return { ok: true };
  });
  ipcMain.handle('account:check', async (_event, id) => {
    void monitor.check(id);
    return { ok: true };
  });
});

app.on('window-all-closed', () => {
  monitor?.stop();
  updater?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
