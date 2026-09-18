const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { SecureStore } = require('./store');
const { MonitorService } = require('./monitor');
const { UpdateService } = require('./updater');
const { normalizeNavigationUrl } = require('./navigation');
const { agentPathKey } = require('./report-parser');

let mainWindow;
let store;
let monitor;
let updater;

function optionalAmount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : NaN;
}

function state() {
  const current = store.publicState(monitor.runtime);
  current.telegram.pairingAvailable = monitor.pairingClient.enabled;
  return { ...current, updater: updater?.runtime };
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
      data.telegram.mode = 'legacy';
    });
    publish();
    return { ok: true };
  });
  ipcMain.handle('telegram:test', async (_event, input) => {
    await monitor.testTelegram(input);
    return { ok: true };
  });
  ipcMain.handle('telegram:discover-chat', async (_event, input) => ({
    ok: true,
    chatId: await monitor.discoverTelegramChatId(input?.botToken),
  }));
  ipcMain.handle('telegram:pair:start', () => monitor.startTelegramPairing());
  ipcMain.handle('telegram:pair:status', () => monitor.checkTelegramPairing());
  ipcMain.handle('telegram:pair:unlink', () => monitor.unlinkTelegramPairing());
  ipcMain.handle('telegram:pair:open-bot', () => {
    const pairing = store.state.telegram.pairing;
    if (!pairing || !/^[A-Za-z0-9_]{5,32}$/.test(pairing.botUsername) || !/^[A-HJ-NP-Z2-9]{10}$/.test(pairing.code)) {
      throw new Error('请先生成有效配对码');
    }
    return shell.openExternal(`https://t.me/${pairing.botUsername}?start=${pairing.code}`);
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
  ipcMain.handle('account:save', async (_event, input) => {
    const clean = {
      name: String(input.name || '').trim(),
      navUrl: normalizeNavigationUrl(input.navUrl),
      username: String(input.username || '').trim(),
      intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 5),
      enabled: input.enabled !== false,
    };
    if (!clean.name || !clean.navUrl || !clean.username) {
      throw new Error('请完整填写账号名称、导航网址和登录账号');
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
        const created = { ...clean, id: crypto.randomUUID(), securityCode: String(input.securityCode), password: String(input.password), subagentThresholds: [] };
        data.accounts.push(created);
        savedId = created.id;
      }
    });
    await monitor.invalidateAccount(savedId);
    store.addEvent('success', `${clean.name}：监控配置已保存`, savedId);
    publish();
    return { ok: true, id: savedId };
  });
  ipcMain.handle('subagent-threshold:save', (_event, input) => {
    const alertStep = optionalAmount(input.alertStep);
    if (Number.isNaN(alertStep) || (alertStep !== null && alertStep <= 0)) throw new Error('提醒间隔必须是大于 0 的金额，留空表示关闭');
    const path = Array.isArray(input.path) ? input.path.map((part) => String(part).trim()) : [String(input.name || '').trim()];
    if (!path.length || path.some((part) => !part) || path.length > 2) throw new Error('只支持往下两级代理');
    const name = path.at(-1);
    const remark = String(input.remark || '').trim();
    if (remark.length > 100) throw new Error('备注最多 100 个字');
    const accountId = String(input.accountId || '');
    store.update((data) => {
      const account = data.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账号不存在');
      if (!Array.isArray(account.subagentThresholds)) account.subagentThresholds = [];
      const existing = account.subagentThresholds.find((item) => agentPathKey(item.path || [item.name]) === agentPathKey(path));
      const values = { name, path, remark, alertStep };
      if (existing) {
        Object.assign(existing, values);
        delete existing.lowerThreshold;
        delete existing.upperThreshold;
      }
      else account.subagentThresholds.push(values);
    });
    monitor.updateSubagentAlertStep(accountId, path, alertStep, remark);
    monitor.requestRecheck(accountId);
    store.addEvent('success', `${path.join(' / ')}：备注和提醒设置已保存`, accountId);
    publish();
    return { ok: true };
  });
  ipcMain.handle('subagent:expand', (_event, input) => {
    const accountId = String(input.accountId || '');
    const path = Array.isArray(input.path) ? input.path.map((part) => String(part).trim()) : [];
    if (path.length !== 1 || path.some((part) => !part)) throw new Error('只能展开直属代理，读取第二级代理');
    const known = monitor.status(accountId).subagents?.some((item) => agentPathKey(item.path) === agentPathKey(path));
    if (!known) throw new Error('请先刷新报表，再查看该代理的下级');
    store.update((data) => {
      const account = data.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账号不存在');
      if (!Array.isArray(account.expandedAgentPaths)) account.expandedAgentPaths = [];
      if (!account.expandedAgentPaths.some((item) => agentPathKey(item) === agentPathKey(path))) account.expandedAgentPaths.push(path);
    });
    publish();
    return { ok: true };
  });
  ipcMain.handle('account:remove', async (_event, id) => {
    store.update((data) => { data.accounts = data.accounts.filter((account) => account.id !== id); });
    await monitor.invalidateAccount(id);
    publish();
    return { ok: true };
  });
  ipcMain.handle('account:toggle', async (_event, { id, enabled }) => {
    store.update((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (account) account.enabled = Boolean(enabled);
    });
    if (enabled) void monitor.check(id);
    else await monitor.invalidateAccount(id);
    publish();
    return { ok: true };
  });
  ipcMain.handle('account:check', async (_event, id) => {
    void monitor.check(id);
    return { ok: true };
  });
  ipcMain.handle('account:view', async (_event, id) => {
    await monitor.openAccountView(id);
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
