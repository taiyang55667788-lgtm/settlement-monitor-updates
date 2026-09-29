const { contextBridge, ipcRenderer } = require('electron');

let stateListener = () => {};
const state = {
  accounts: [{
    id: 'fixture-account', name: '测试账号', username: 'fixture', enabled: true,
    status: 'ok', subagentCount: 1, reportPeriod: { start: '2026-09-14', end: '2026-09-20' }, expandedAgentPaths: [['parent-01'], ['parent-01', 'child-01'], ['parent-01', 'child-01', 'third-01']],
    subagents: [
      { name: 'parent-01', path: ['parent-01'], value: 540, readAt: '2026-09-19T06:00:00.000Z', childCount: 1, remark: '直属备注', alertStep: 100, customized: true, alertedPositiveLevel: 5, alertedNegativeLevel: 0, lastObservedLevel: 5, lastAlertAt: '2026-09-19T06:03:00.000Z' },
      { name: 'child-01', path: ['parent-01', 'child-01'], value: -230, readAt: '2026-09-19T06:01:00.000Z', childCount: 1, remark: '二级备注', alertStep: 200, customized: true, alertedPositiveLevel: 0, alertedNegativeLevel: -1, lastObservedLevel: -1 },
      { name: 'third-01', path: ['parent-01', 'child-01', 'third-01'], value: 330, readAt: '2026-09-19T06:02:00.000Z', childCount: 1, remark: '三级备注', alertStep: 100, customized: true, alertedPositiveLevel: 3, alertedNegativeLevel: 0, lastObservedLevel: 3 },
      { name: 'fourth-01', path: ['parent-01', 'child-01', 'third-01', 'fourth-01'], value: -430, readAt: '2026-09-19T06:03:00.000Z', childCount: 1, remark: '四级备注', alertStep: 100, customized: true, alertedPositiveLevel: 0, alertedNegativeLevel: -4, lastObservedLevel: -4 },
    ],
  }],
  events: [], alertRecords: [{ time: '2026-09-19T06:03:00.000Z', status: 'sent', accountName: '测试账号', agentPath: ['parent-01'], value: 540, level: 5, alertStep: 100, remark: '直属备注' }], telegram: {}, update: {}, updater: {}, appearance: { theme: 'ocean' },
};

contextBridge.exposeInMainWorld('monitorApi', {
  getState: async () => state,
  getAccountSecurityCode: async () => ({ securityCode: '75454' }),
  onState: (callback) => {
    stateListener = callback;
    return () => { stateListener = () => {}; };
  },
  __smokeEmitState: (next) => stateListener(next),
  saveSubagentThreshold: async (settings) => { ipcRenderer.send('smoke:save', settings); },
  saveTheme: async (theme) => { ipcRenderer.send('smoke:theme', theme); },
  openLatestDownloadPage: async () => { ipcRenderer.send('smoke:open-latest-download'); },
  copyLatestDownloadUrl: async () => { ipcRenderer.send('smoke:copy-latest-download'); return { url: 'https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest' }; },
  expandSubagent: async () => {},
  fullScanAccount: async (id) => { ipcRenderer.send('smoke:full-scan', id); },
});
