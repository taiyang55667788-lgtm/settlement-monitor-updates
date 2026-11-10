const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureStore } = require('../electron/store');
const { PROFIT_METRIC } = require('../electron/agent-profit');
const { ALERT_METRIC, alertLedgerKey, resetChangedAlertStep } = require('../electron/alert-ledger');
const { applySubagentAlertSteps } = require('../electron/report-parser');
const { branchHasTarget, priorityPaths } = require('../electron/continuous-monitor');
const { staleTargets } = require('../electron/reliability');

test('profit setting resets only the chosen metric, disable clears stale settings and deep profit paths stay scheduled', () => {
  const path = ['a', 'b', 'c', 'd'], key = alertLedgerKey(path, 100);
  const account = { alertHistory: { agents: { [key]: { currentLevel: 2 } } }, profitAlertHistory: { agents: { [key]: { currentLevel: -2 } } } };
  resetChangedAlertStep(account, path, 200, 100, 'now', 'profitAlertHistory', PROFIT_METRIC);
  assert.equal(account.alertHistory.agents[key].currentLevel, 2);
  assert.equal(account.profitAlertHistory.agents[key], undefined);
  const settings = [{ path, profitAlertStep: 100 }];
  assert.equal(branchHasTarget(path, settings), true);
  assert.deepEqual(priorityPaths(settings).at(-1), path);
  assert.equal(applySubagentAlertSteps([{ path, profitAlertStep: 100 }], [{ path, profitAlertStep: null }])[0].profitAlertStep, null);
  const now = Date.now();
  assert.deepEqual(staleTargets({ intervalMinutes: 1, subagentThresholds: settings }, [{ path, readAt: new Date(now).toISOString(), profitReadAt: new Date(now - 400000).toISOString() }], new Date(now).toISOString(), now), [path]);
});

test('public profit reminder state and pending/sent history never mix with receivable state', () => {
  const store = new SecureStore('/tmp/unused-profit-public-state');
  const path = ['agent'], step = 100, key = alertLedgerKey(path, step), period = { start: '2026-11-09', end: '2026-11-15' }, week = period.start + '/' + period.end;
  store.state.accounts = [{ id: 'a', notificationLedgerVersion: 1,
    alertHistory: { period: week, metric: ALERT_METRIC, agents: { [key]: { currentLevel: 2 } } },
    profitAlertHistory: { period: week, metric: PROFIT_METRIC, agents: { [key]: { currentLevel: -3 } } },
    deliveredAlertHistory: { period: week, metric: ALERT_METRIC, agents: { [key]: { positiveLastAlertLevel: 2 } } },
    profitDeliveredAlertHistory: { period: week, metric: PROFIT_METRIC, agents: { [key]: { negativeLastAlertLevel: -3 } } },
  }];
  const record = { accountId: 'a', agentPath: path, status: 'sent' };
  store.state.alertRecords = [{ ...record, metric: PROFIT_METRIC, time: 'profit-time' }, { ...record, metric: ALERT_METRIC, time: 'receivable-time' }];
  store.state.notificationOutbox = [{ record: { ...record, metric: PROFIT_METRIC } }];
  const publicState = store.publicState(new Map([['a', { reportPeriod: period, subagents: [{ path, value: 250, stale: true, alertStep: step, profitValue: -350, profitStale: false, profitAlertStep: step }] }]]));
  const row = publicState.accounts[0].subagents[0];
  assert.equal(row.lastObservedLevel, 2); assert.equal(row.pendingNotifications, 0); assert.equal(row.lastAlertAt, 'receivable-time');
  assert.equal(row.profitAlert.lastObservedLevel, -3); assert.equal(row.profitAlert.pendingNotifications, 1); assert.equal(row.profitAlert.lastAlertAt, 'profit-time');
  assert.equal(row.profitAlert.alertedNegativeLevel, -3);
  assert.equal(row.profitAlert.stale, false, 'fresh own profit does not inherit stale receivable status');
});

test('dedicated profit reads depend on enabled reminders, never on elapsed time or zero and missing values', () => {
  const { profitReadDue, profitRequiredForPath, specialProfitPath } = require('../electron/agent-profit');
  for (const agent of [{}, {profitValue:0}, {profitValue:null}, {profitCheckedAt:'bad'}, {profitReadAt:'2020-01-01T00:00:00Z'}]) {
    assert.equal(profitReadDue(agent, {}), false);
    assert.equal(profitReadDue(agent, {alertStep:100}), false);
    assert.equal(profitReadDue(agent, {profitAlertStep:100}), true);
    assert.equal(profitReadDue(agent, {profitAlertStep:null}), false);
  }
  assert.equal(profitRequiredForPath([], [{path:specialProfitPath('own'),profitAlertStep:100}]),true);
  assert.equal(profitRequiredForPath([], [{path:specialProfitPath('replenishment'),profitAlertStep:100}]),true);
  const deep=['a','b','c','d'];
  assert.equal(profitRequiredForPath(deep,[{path:specialProfitPath('replenishment',deep),profitAlertStep:100}]),true);
  assert.equal(profitRequiredForPath(deep,[{path:deep,alertStep:100}]),false);
});
