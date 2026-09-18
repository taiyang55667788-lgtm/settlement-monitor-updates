const test = require('node:test');
const assert = require('node:assert/strict');
const { ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel } = require('../electron/alert-ledger');

test('each positive and negative tier is offered only once, even after a value falls and returns', () => {
  let delivered;
  const first = pendingAlertNotifications(3, delivered);
  assert.deepEqual(first.map((item) => item.level), [1, 2, 3]);
  for (const item of first) delivered = recordAlertLevel(delivered, item.level);
  assert.deepEqual(delivered, { positiveMax: 3, negativeMax: 0 });
  assert.deepEqual(pendingAlertNotifications(1, delivered), []);
  assert.deepEqual(pendingAlertNotifications(0, delivered), []);
  assert.deepEqual(pendingAlertNotifications(3, delivered), []);
  assert.deepEqual(pendingAlertNotifications(4, delivered).map((item) => item.level), [4]);
  const negative = pendingAlertNotifications(-2, delivered);
  assert.deepEqual(negative.map((item) => item.level), [-1, -2]);
  for (const item of negative) delivered = recordAlertLevel(delivered, item.level);
  assert.deepEqual(pendingAlertNotifications(-1, delivered), []);
  assert.deepEqual(pendingAlertNotifications(-2, delivered), []);
  assert.deepEqual(delivered, { positiveMax: 3, negativeMax: 2 });
});

test('a large jump is combined into one message and recorded through the reached tier', () => {
  const notifications = pendingAlertNotifications(50, { positiveMax: 2, negativeMax: 0 });
  assert.deepEqual(notifications, [{ level: 50, previousLevel: 2, combined: true, count: 48 }]);
  assert.deepEqual(recordAlertLevel({ positiveMax: 2, negativeMax: 0 }, 50), { positiveMax: 50, negativeMax: 0 });
});

test('agent identity and interval both isolate delivered-tier histories', () => {
  assert.notEqual(alertLedgerKey(['parent-a', 'child'], 100), alertLedgerKey(['parent-b', 'child'], 100));
  assert.notEqual(alertLedgerKey(['parent-a', 'child'], 100), alertLedgerKey(['parent-a', 'child'], 200));
});

test('a new report week resets sent tiers while the same week preserves them', () => {
  const prior = { period: '2026-09-14/2026-09-20', metric: ALERT_METRIC, agents: { known: { positiveMax: 3, negativeMax: 1 } } };
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
