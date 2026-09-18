const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveTelegram: (settings) => ipcRenderer.invoke('telegram:save', settings),
  testTelegram: (settings) => ipcRenderer.invoke('telegram:test', settings),
  discoverTelegramChatId: (botToken) => ipcRenderer.invoke('telegram:discover-chat', { botToken }),
  startTelegramPairing: () => ipcRenderer.invoke('telegram:pair:start'),
  checkTelegramPairing: () => ipcRenderer.invoke('telegram:pair:status'),
  unlinkTelegramPairing: () => ipcRenderer.invoke('telegram:pair:unlink'),
  openTelegramPairingBot: () => ipcRenderer.invoke('telegram:pair:open-bot'),
  saveUpdateSettings: (settings) => ipcRenderer.invoke('update:save', settings),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  saveAccount: (account) => ipcRenderer.invoke('account:save', account),
  saveSubagentThreshold: (settings) => ipcRenderer.invoke('subagent-threshold:save', settings),
  expandSubagent: (accountId, path) => ipcRenderer.invoke('subagent:expand', { accountId, path }),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  toggleAccount: (id, enabled) => ipcRenderer.invoke('account:toggle', { id, enabled }),
  checkAccount: (id) => ipcRenderer.invoke('account:check', id),
  openAccountView: (id) => ipcRenderer.invoke('account:view', id),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
