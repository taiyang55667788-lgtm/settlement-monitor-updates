const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveTelegram: (settings) => ipcRenderer.invoke('telegram:save', settings),
  testTelegram: () => ipcRenderer.invoke('telegram:test'),
  discoverTelegramChatId: (botToken) => ipcRenderer.invoke('telegram:discover-chat', { botToken }),
  saveUpdateSettings: (settings) => ipcRenderer.invoke('update:save', settings),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  saveAccount: (account) => ipcRenderer.invoke('account:save', account),
  saveSubagentThreshold: (settings) => ipcRenderer.invoke('subagent-threshold:save', settings),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  toggleAccount: (id, enabled) => ipcRenderer.invoke('account:toggle', { id, enabled }),
  checkAccount: (id) => ipcRenderer.invoke('account:check', id),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
