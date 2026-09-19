const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { SecureStore } = require('./store');
const { MonitorService } = require('./monitor');
const { UpdateService } = require('./updater');
const { normalizeNavigationUrl } = require('./navigation');
const { agentPathKey } = require('./report-parser');
const { ALERT_METRIC } = require('./alert-ledger');

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
  ipcMain.handle('appearance:theme', (_event, theme) => {
    if (!['ocean', 'graphite', 'light', 'contrast'].includes(theme)) throw new Error('不支持的主题');
    store.update((data) => { data.appearance = { theme }; });
    publish();
    return { ok: true };
  });
  ipcMain.handle('alert-policy:save', (_event, input) => {
    const confirmationReads = Math.max(1, Math.min(10, Number(input.confirmationReads) || 1));
    const failureEscalation = Math.max(1, Math.min(20, Number(input.failureEscalation) || 3));
    const validTime = (value) => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const quietStart = String(input.quietStart || ''); const quietEnd = String(input.quietEnd || '');
    if (!validTime(quietStart) || !validTime(quietEnd)) throw new Error('静默时间必须是 HH:MM 格式');
    if (Boolean(quietStart) !== Boolean(quietEnd)) throw new Error('请同时填写静默开始和结束时间，或同时留空');
    store.update((data) => { data.alertPolicy = { confirmationReads, failureEscalation, quietStart, quietEnd }; });
    publish(); return { ok: true };
  });
  ipcMain.handle('support:export-diagnostics', async () => {
    const chosen = await dialog.showSaveDialog(mainWindow, { title: '导出脱敏诊断包', defaultPath: `交收监控-诊断-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePath) return { canceled: true };
    const snapshot = state();
    const diagnostic = {
      format: 'settlement-monitor-diagnostics-v1', exportedAt: new Date().toISOString(),
      app: { version: app.getVersion(), platform: process.platform }, alertPolicy: snapshot.alertPolicy,
      telegram: { mode: snapshot.telegram.mode, paired: Boolean(snapshot.telegram.pairing?.paired), hasBotToken: snapshot.telegram.hasBotToken },
      accounts: snapshot.accounts.map(({ username, hasSecurityCode, hasPassword, ...account }) => ({ ...account, username: username ? '***' : '', hasSecurityCode, hasPassword })),
      events: snapshot.events,
    };
    fs.writeFileSync(chosen.filePath, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
    return { filePath: chosen.filePath };
  });
  ipcMain.handle('support:backup-export', async () => {
    const chosen = await dialog.showSaveDialog(mainWindow, { title: '导出加密配置备份', defaultPath: `交收监控-备份-${new Date().toISOString().slice(0, 10)}.smbackup`, filters: [{ name: '交收监控备份', extensions: ['smbackup'] }] });
    if (chosen.canceled || !chosen.filePath) return { canceled: true };
    if (!fs.existsSync(store.filePath)) store.save();
    fs.writeFileSync(chosen.filePath, JSON.stringify({ format: 'settlement-monitor-encrypted-backup-v1', createdAt: new Date().toISOString(), encryptedSettings: fs.readFileSync(store.filePath, 'utf8') }), { mode: 0o600 });
    return { filePath: chosen.filePath };
  });
  ipcMain.handle('support:backup-import', async () => {
    const chosen = await dialog.showOpenDialog(mainWindow, { title: '恢复加密配置备份', properties: ['openFile'], filters: [{ name: '交收监控备份', extensions: ['smbackup'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
    const backup = JSON.parse(fs.readFileSync(chosen.filePaths[0], 'utf8'));
    if (backup.format !== 'settlement-monitor-encrypted-backup-v1' || typeof backup.encryptedSettings !== 'string') throw new Error('不是有效的交收监控加密备份文件');
    if (fs.existsSync(store.filePath)) fs.copyFileSync(store.filePath, `${store.filePath}.before-restore-${Date.now()}`);
    fs.writeFileSync(store.filePath, backup.encryptedSettings, { mode: 0o600 });
    store.load();
    monitor.runtime.clear();
    for (const account of store.state.accounts) await monitor.invalidateAccount(account.id);
    store.addEvent('success', '已恢复加密配置备份；请重新检查账号');
    publish(); return { ok: true };
  });
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
        const created = { ...clean, id: crypto.randomUUID(), securityCode: String(input.securityCode), password: String(input.password), subagentThresholds: [], alertMetricVersion: ALERT_METRIC };
        data.accounts.push(created);
        savedId = created.id;
      }
    });
    await monitor.invalidateAccount(savedId);
    store.addEvent('success', `${clean.name}：监控配置已保存`, savedId);
    publish();
    return { ok: true, id: savedId };
  });
  ipcMain.handle('account:security-code', (event, id) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权读取账号资料');
    const account = store.state.accounts.find((item) => item.id === String(id || ''));
    if (!account) throw new Error('账号不存在');
    return { securityCode: account.securityCode || '' };
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
