const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { SecureStore } = require('../electron/store');
const { ALERT_METRIC, alertLedgerKey } = require('../electron/alert-ledger');
const { NotificationOutbox } = require('../electron/reliability');

app.whenReady().then(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-monitor-store-smoke-'));
  try {
    const oldStore = new SecureStore(directory);
    oldStore.state.accounts.push({
      id: 'fixture', name: '测试账号', username: 'fixture',
      subagentThresholds: [{ name: 'parent-01', alertStep: 100 }, { name: 'removed-fifth', path: ['a', 'b', 'c', 'd', 'removed-fifth'], alertStep: 50 }],
    });
    oldStore.save();
    const migrated = new SecureStore(directory);
    migrated.load();
    assert.equal(migrated.state.accounts[0].subagentThresholds.length, 1);
    const persisted = new SecureStore(directory);
    persisted.load();
    assert.equal(persisted.state.accounts[0].subagentThresholds.length, 1);
    assert.deepEqual(migrated.state.accounts[0].subagentThresholds[0].path, ['parent-01']);
    migrated.update((data) => {
      data.appearance.theme = 'light';
      data.accounts[0].subagentThresholds.push({
        name: 'child-01', path: ['parent-01', 'child-01'], remark: '西区', alertStep: 300,
      });
      data.accounts[0].alertHistory = {
        period: '2026-09-14/2026-09-20',
        agents: { [alertLedgerKey(['parent-01', 'child-01'], 300)]: { currentLevel: -2, positiveLastAlertLevel: 3, negativeLastAlertLevel: -2 } },
      };
    });
    const reopened = new SecureStore(directory);
    reopened.load();
    assert.deepEqual(reopened.publicState().accounts[0].subagentThresholds, [
      { name: 'parent-01', path: ['parent-01'], remark: '', alertStep: 100 },
      { name: 'child-01', path: ['parent-01', 'child-01'], remark: '西区', alertStep: 300 },
    ]);
    assert.deepEqual(reopened.state.accounts[0].alertHistory, {
      period: '2026-09-14/2026-09-20',
      agents: { [alertLedgerKey(['parent-01', 'child-01'], 300)]: { currentLevel: -2, positiveLastAlertLevel: 3, negativeLastAlertLevel: -2 } },
    });
    assert.equal(reopened.publicState().appearance.theme, 'light');
    assert.equal(reopened.publicState().accounts[0].alertHistory, undefined);
    reopened.addAlertRecord({ status: 'sent', accountId: 'fixture', accountName: '测试账号', agentName: 'child-01', agentPath: ['parent-01', 'child-01'], value: -700, level: -2, alertStep: 300, remark: '西区' });
    assert.equal(reopened.publicState().alertRecords[0].status, 'sent');
    assert.deepEqual(reopened.publicState().alertRecords[0].agentPath, ['parent-01', 'child-01']);
    reopened.update((data) => { data.accounts[0].alertHistory.metric = ALERT_METRIC; });
    const published = reopened.publicState(new Map([['fixture', {
      reportPeriod: { start: '2026-09-14', end: '2026-09-20' },
      subagents: [{ name: 'child-01', path: ['parent-01', 'child-01'], alertStep: 300, value: -700, readAt: '2026-09-19T06:00:00Z' }],
    }]]));
    assert.equal(published.accounts[0].subagents[0].alertedPositiveLevel, 3);
    assert.equal(published.accounts[0].subagents[0].alertedNegativeLevel, -2);
    assert.equal(published.accounts[0].subagents[0].lastObservedLevel, -2);
    assert.equal(published.accounts[0].subagents[0].readAt, '2026-09-19T06:00:00Z');
    assert.equal(published.alertRecords.length, 1);
    reopened.update(data => { data.telegram = { mode: 'legacy', botToken: 'fixture-token', chatId: 'fixture-chat' }; });
    const outbox = new NotificationOutbox(reopened, async () => {});
    const queued = outbox.enqueue('fixture encrypted message', 'amount');
    outbox.attach(queued, { accountId: 'fixture', agentPath: ['parent-01', 'child-01'], value: 20 });
    const restoredQueue = new SecureStore(directory);
    restoredQueue.load();
    assert.equal(restoredQueue.state.notificationOutbox[0].text, 'fixture encrypted message');
    assert.equal(restoredQueue.publicState().notificationQueue.pending, 1);
    assert.equal(restoredQueue.publicState().notificationOutbox, undefined);
    assert.equal(fs.readFileSync(restoredQueue.filePath, 'utf8').includes('fixture encrypted message'), false);
    process.stdout.write('Agent settings migration and persistence smoke test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.quit();
});
