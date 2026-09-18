const { contextBridge, ipcRenderer } = require('electron');

const state = {
  accounts: [{
    id: 'fixture-account', name: '测试账号', username: 'fixture', enabled: true,
    status: 'ok', subagentCount: 1, reportPeriod: { start: '2026-09-14', end: '2026-09-20' }, expandedAgentPaths: [['parent-01']],
    subagents: [
      { name: 'parent-01', path: ['parent-01'], value: 540, childCount: 1, remark: '直属备注', alertStep: 100, customized: true },
      { name: 'child-01', path: ['parent-01', 'child-01'], value: -230, remark: '二级备注', alertStep: 200, customized: true },
    ],
  }],
  events: [], telegram: {}, update: {}, updater: {},
};

contextBridge.exposeInMainWorld('monitorApi', {
  getState: async () => state,
  getAccountSecurityCode: async () => ({ securityCode: '75454' }),
  onState: () => () => {},
  saveSubagentThreshold: async (settings) => { ipcRenderer.send('smoke:save', settings); },
  expandSubagent: async () => {},
});
