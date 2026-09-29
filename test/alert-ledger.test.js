const test = require('node:test');
const assert = require('node:assert/strict');
const { ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel, migrateZeroTierHistory } = require('../electron/alert-ledger');

test('changing step resets the chosen ledger even when returning to a previously used interval', () => {
  const { resetChangedAlertStep } = require('../electron/alert-ledger');
  const key = alertLedgerKey(['a'], 100), other = alertLedgerKey(['b'], 100);
  const account = { alertHistory: { agents: { [key]: { currentLevel: 3 }, [other]: { currentLevel: 2 } } } };
  resetChangedAlertStep(account, ['a'], 100, 100);
  assert.equal(account.alertHistory.agents[key].currentLevel, 3);
  assert.equal(account.alertSettingChanges, undefined);
  resetChangedAlertStep(account, ['a'], 200, 100);
  assert.equal(account.alertHistory.agents[key], undefined);
  assert.equal(account.alertHistory.agents[other].currentLevel, 2);
  assert.deepEqual(pendingAlertNotifications(3, account.alertHistory.agents[key]).map(item => item.level), [1, 2, 3]);
  resetChangedAlertStep(account, ['a'], 100, null);
  resetChangedAlertStep(account, ['a'], null, 100);
  assert.equal(account.alertSettingChanges.length, 3);
});

test('each successful entry into a positive or negative tier is offered, including a return to an earlier tier', () => {
  let delivered;
  const first = pendingAlertNotifications(3, delivered);
  assert.deepEqual(first.map((item) => item.level), [1, 2, 3]);
  for (const item of first) delivered = recordAlertLevel(delivered, item.level);
  assert.deepEqual(delivered, { currentLevel: 3, positiveLastAlertLevel: 3, negativeLastAlertLevel: 0 });
  assert.deepEqual(pendingAlertNotifications(1, delivered).map((item) => item.level), [2, 1]);
  for (const item of pendingAlertNotifications(1, delivered)) delivered = recordAlertLevel(delivered, item.level);
  assert.equal(delivered.currentLevel, 1);
  assert.deepEqual(pendingAlertNotifications(0, delivered), []);
  delivered = recordAlertLevel(delivered, 0);
  assert.equal(delivered.currentLevel, 1);
  assert.deepEqual(pendingAlertNotifications(1, delivered), []);
  delivered = recordAlertLevel(delivered, 1);
  const negative = pendingAlertNotifications(-2, delivered);
  assert.deepEqual(negative.map((item) => item.level), [-1, -2]);
  for (const item of negative) delivered = recordAlertLevel(delivered, item.level);
  assert.deepEqual(pendingAlertNotifications(-1, delivered).map((item) => item.level), [-1]);
  assert.deepEqual(delivered, { currentLevel: -2, positiveLastAlertLevel: 1, negativeLastAlertLevel: -2 });
});

test('zero keeps the last nonzero tier for both signs and never sends intermediate return alerts', () => {
  for (const sign of [1, -1]) {
    const retained = recordAlertLevel(recordAlertLevel(undefined, 3 * sign), 0);
    assert.equal(retained.currentLevel, 3 * sign);
    assert.deepEqual(pendingAlertNotifications(0, retained), []);
    assert.deepEqual(pendingAlertNotifications(3 * sign, retained), []);
    assert.deepEqual(pendingAlertNotifications(sign, retained).map(item => item.level), [2 * sign, sign]);
  }
});

test('migration restores old zero entries from matching transitions without guessing ambiguous direction', () => {
  const history = { period: 'week', metric: ALERT_METRIC, agents: {
    proven: { currentLevel: 0, positiveLastAlertLevel: 2, negativeLastAlertLevel: -1 },
    single: { currentLevel: 0, positiveLastAlertLevel: 1, negativeLastAlertLevel: 0 },
    ambiguous: { currentLevel: 0, positiveLastAlertLevel: 1, negativeLastAlertLevel: -1 },
  } };
  const migrated = migrateZeroTierHistory(history, [
    { key: 'proven', period: 'week', metric: ALERT_METRIC, from: -1, to: 0 },
    { key: 'proven', period: 'older-week', metric: ALERT_METRIC, from: 2, to: 0 },
  ]);
  assert.equal(migrated.agents.proven.currentLevel, -1);
  assert.equal(migrated.agents.single.currentLevel, 1);
  assert.equal(migrated.agents.ambiguous.currentLevel, 0);
  assert.equal(history.agents.proven.currentLevel, 0);
  assert.equal(migrateZeroTierHistory(migrated), migrated);
});

test('a large upward or downward jump is combined into one message and records the reached tier', () => {
  const notifications = pendingAlertNotifications(50, { currentLevel: 2 });
  assert.deepEqual(notifications, [{ level: 50, previousLevel: 2, combined: true, count: 48 }]);
  assert.deepEqual(recordAlertLevel({ currentLevel: 2 }, 50), { currentLevel: 50, positiveLastAlertLevel: 50, negativeLastAlertLevel: 0 });
  assert.deepEqual(pendingAlertNotifications(1, { currentLevel: 50 }), [{ level: 1, previousLevel: 50, combined: true, count: 49 }]);
});

test('agent identity and interval both isolate delivered-tier histories', () => {
  assert.notEqual(alertLedgerKey(['parent-a', 'child'], 100), alertLedgerKey(['parent-b', 'child'], 100));
  assert.notEqual(alertLedgerKey(['parent-a', 'child'], 100), alertLedgerKey(['parent-a', 'child'], 200));
});

test('a new report week resets sent tiers while the same week preserves them', () => {
  const prior = { period: '2026-09-14/2026-09-20', metric: ALERT_METRIC, agents: { known: { currentLevel: 3 } } };
  assert.equal(alertHistoryForPeriod(prior, '2026-09-14/2026-09-20'), prior);
  assert.deepEqual(alertHistoryForPeriod(prior, '2026-09-21/2026-09-27'), {
    period: '2026-09-21/2026-09-27', metric: ALERT_METRIC, agents: {}, migrationPending: false,
  });
});

test('old-metric alert tiers cannot suppress receivable-downline alerts', () => {
  const old = { period: '2026-09-14/2026-09-20', agents: { known: { positiveMax: 50 } } };
  assert.deepEqual(alertHistoryForPeriod(old, old.period), {
    period: old.period, metric: ALERT_METRIC, agents: {}, migrationPending: true,
  });
  assert.deepEqual(pendingAlertNotifications(5, undefined, undefined, { initialSummary: true }), [
    { level: 5, previousLevel: 0, count: 5, combined: true, initialSummary: true },
  ]);
  assert.deepEqual(pendingAlertNotifications(-3, undefined, undefined, { initialSummary: true }), [
    { level: -3, previousLevel: 0, count: 3, combined: true, initialSummary: true },
  ]);
  assert.equal(alertHistoryForPeriod(undefined, old.period).migrationPending, true);
  assert.equal(alertHistoryForPeriod(undefined, old.period, true).migrationPending, false);
});
