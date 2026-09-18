const { contextBridge, ipcRenderer } = require('electron');

const state = {
  accounts: [{
    id: 'fixture-account', name: '测试账号', username: 'fixture', enabled: true,
    status: 'ok', subagentCount: 1, reportPeriod: { start: '2026-09-14', end: '2026-09-20' }, expandedAgentPaths: [['parent-01']],
    subagents: [
      { name: 'parent-01', path: ['parent-01'], value: 540, readAt: '2026-09-19T06:00:00.000Z', childCount: 1, remark: '直属备注', alertStep: 100, customized: true, alertedPositiveMax: 5, alertedNegativeMax: 0 },
      { name: 'child-01', path: ['parent-01', 'child-01'], value: -230, readAt: '2026-09-19T06:01:00.000Z', remark: '二级备注', alertStep: 200, customized: true, alertedPositiveMax: 0, alertedNegativeMax: 1 },
    ],
  }],
  events: [], telegram: {}, update: {}, updater: {}, appearance: { theme: 'ocean' },
};

contextBridge.exposeInMainWorld('monitorApi', {
  getState: async () => state,
  getAccountSecurityCode: async () => ({ securityCode: '75454' }),
  onState: () => () => {},
  saveSubagentThreshold: async (settings) => { ipcRenderer.send('smoke:save', settings); },
  saveTheme: async (theme) => { ipcRenderer.send('smoke:theme', theme); },
  expandSubagent: async () => {},
});
