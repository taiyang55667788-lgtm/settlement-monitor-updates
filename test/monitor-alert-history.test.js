const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService, settlementWeekRange } = require('../electron/monitor');

function fixture(state) {
  const alerts = [];
  const deltaAlerts = [];
  const context = {
    period: { start: '2026-09-14', end: '2026-09-20' },
    parentValue: 250,
    parentTurnover: 0,
    childValue: -350,
    childFailure: false,
    descendantReads: 0,
    descendants: null,
  };
  const store = {
    state: state || {
      accounts: [{
        id: 'account-1', name: '本级', enabled: true, intervalMinutes: 5, alertMetricVersion: 'weekly-receivable-downline-v2',
        subagentThresholds: [
          { name: 'parent', path: ['parent'], alertStep: 100, remark: '' },
          { name: 'child', path: ['parent', 'child'], alertStep: 100, remark: '' },
        ],
      }],
      telegram: {},
    },
    update(mutator) { mutator(this.state); },
    addEvent() {},
    addAlertRecord(record) {
      this.state.alertRecords ||= [];
      this.state.alertRecords.unshift({ time: new Date().toISOString(), ...record });
    },
  };
  const makeService = () => {
    const service = new MonitorService(store, () => {}, {
      createSiteClient: () => ({
        get reportPeriod() { return context.period; },
        async open() {},
        async readThisWeekSettlement() { return { value: context.parentValue, agents: [{ name: 'parent', value: context.parentValue, turnover: context.parentTurnover }] }; },
        async readDescendantSettlement(path) {
          await context.beforeDescendant?.(path, service);
          context.descendantReads += 1;
          if (context.childFailure) throw new Error('下级报表加载失败');
          if (context.descendants) return context.descendants.get(path.join('/')) || { value: 0, agents: [] };
          if (path.length > 1) return { value: 0, agents: [] };
          return { value: context.childValue, agents: [{ name: 'child', value: context.childValue }] };
        },
        async close() {},
      }),
    });
    service.sendTelegram = async (_account, _value, level, _previous, _name, _step, _remark, path) => {
      alerts.push([path.join('/'), level]);
    };
    service.sendOperationalTelegram = async (message) => { deltaAlerts.push(message); };
    return service;
  };
  return { alerts, deltaAlerts, context, store, makeService };
}

test('screenshot amounts stay in the same tier across refresh and service restart; returns from 600k alert again', async () => {
  const { store, context, makeService } = fixture();
  store.state.telegram = { mode: 'legacy', botToken: 'test', chatId: 'test' };
  store.state.accounts[0].subagentThresholds = [{ name: 'parent', path: ['parent'], alertStep: 300000 }];
  let service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  for (const value of [-346872.65, -312104.94, -599999]) { context.parentValue = value; await service.check('account-1'); }
  assert.equal(store.state.notificationOutbox.length, 1);
  service.clearAccountSession = async () => {};
  await service.invalidateAccount('account-1');
  await service.check('account-1');
  assert.equal(store.state.notificationOutbox.length, 1, 'session reset and full rescan retain the alert tier');
  service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  for (const value of [-600000, -610000, -350000, -310000]) { context.parentValue = value; await service.check('account-1'); }
  assert.deepEqual(store.state.notificationOutbox.map(item => item.record.level), [-1, -2, -1]);
  assert.deepEqual(store.state.notificationOutbox.map(item => item.record.previousLevel), [0, -1, -2]);
  assert.equal(new Set(store.state.notificationOutbox.map(item => item.record.eventId)).size, 3);
  assert.deepEqual(store.state.accounts[0].tierTransitions.map(item => [item.from, item.to]), [[0, -1], [-1, -2], [-2, -1]]);
});

test('step changes rearm old intervals and persist explainable triggers across service restart', async () => {
  const { resetChangedAlertStep } = require('../electron/alert-ledger');
  const { store, context, makeService } = fixture();
  store.state.telegram = { mode: 'legacy', botToken: 'test', chatId: 'test' };
  const account = store.state.accounts[0];
  account.subagentThresholds = [{ name: 'parent', path: ['parent'], alertStep: 300000 }];
  let service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  service.processStartedAt = '2026-09-01T00:00:00.000Z';
  context.parentValue = 350000;
  await service.check(account.id);
  assert.equal(store.state.notificationOutbox[0].record.trigger.reason, '本周首次进入非零档位');
  context.parentValue = 650000;
  await service.check(account.id);
  assert.equal(store.state.notificationOutbox.at(-1).record.trigger.previousTransitionValue, 350000);
  service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  context.parentValue = 350000;
  await service.check(account.id);
  assert.equal(store.state.notificationOutbox.at(-1).record.trigger.reason, '回落到较低档位');
  assert.equal(store.state.notificationOutbox.at(-1).record.trigger.processChangedSincePrevious, true);
  for (const step of [200000, 300000]) {
    resetChangedAlertStep(account, ['parent'], account.subagentThresholds[0].alertStep, step);
    account.subagentThresholds[0].alertStep = step;
    service.updateSubagentAlertStep(account.id, ['parent'], step);
    await service.check(account.id);
    assert.equal(store.state.notificationOutbox.at(-1).record.trigger.reason, '修改间隔后按新档位提醒');
  }
  assert.equal(store.state.notificationOutbox.length, 5);
  await service.check(account.id);
  assert.equal(store.state.notificationOutbox.length, 5);
});

test('half-step buffer suppresses screenshot oscillation across restart and confirms a real return', async () => {
  for (const sign of [1, -1]) {
    const { store, context, makeService } = fixture();
    store.state.telegram = { mode: 'legacy', botToken: 'test', chatId: 'test' };
    store.state.alertPolicy = { confirmationReads: 2 };
    store.state.accounts[0].subagentThresholds = [{ name: 'parent', path: ['parent'], alertStep: 100000 }];
    let service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
    const read = async value => { context.parentValue = sign * value; await service.check('account-1'); };
    await read(343429.43); await read(343429.43);
    const initialCount = store.state.notificationOutbox.length;
    for (const value of [294868, 294868, 301103.33, 301103.33, 282139.86, 282139.86]) await read(value);
    assert.equal(store.state.notificationOutbox.length, initialCount);
    service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
    await read(282139.86); await read(282139.86);
    assert.equal(store.state.notificationOutbox.length, initialCount);
    await read(250000); await read(250001); await read(250000);
    assert.equal(store.state.notificationOutbox.length, initialCount, 'rebound resets falling confirmation');
    await read(250000);
    assert.equal(store.state.notificationOutbox.at(-1).record.level, sign * 2);
    assert.equal(store.state.notificationOutbox.length, initialCount + 1);
    await read(299999); await read(299999);
    assert.equal(store.state.notificationOutbox.length, initialCount + 1);
    await read(300000); await read(300000);
    assert.equal(store.state.notificationOutbox.at(-1).record.level, sign * 3);
    assert.equal(store.state.notificationOutbox.length, initialCount + 2);
    context.period = { start: '2026-09-21', end: '2026-09-27' };
    await read(282139.86); await read(282139.86);
    assert.equal(store.state.notificationOutbox.at(-1).record.level, sign * 2);
    assert.equal(store.state.notificationOutbox.at(-1).record.trigger.downwardBufferRatio, 0.5);
  }
});

test('unchanged tiers do not rewrite the encrypted ledger for every agent', async () => {
  const { store, makeService } = fixture();
  const account = store.state.accounts[0]; const service = makeService();
  const metric = require('../electron/monitor-systems').metricForAccount(account);
  const batch = Array.from({ length: 200 }, (_, i) => ({ name: `agent-${i}`, path: [`agent-${i}`], value: 1, alertStep: 100 }));
  const status = service.status(account.id), period = { start: '2026-09-14', end: '2026-09-20' };
  await service.processFreshBatch(account, status, period, metric, 0, batch, []);
  let writes = 0; const update = store.update.bind(store);
  store.update = fn => { writes++; return update(fn); };
  await service.processFreshBatch(account, status, period, metric, 0, batch, []);
  assert.equal(writes, 0, '200 unchanged tiers require no persistent state update');
});

test('neither an unconfirmed nor a confirmed zero-tier reading rearms the same tier', async () => {
  const { store, context, alerts, makeService } = fixture();
  store.state.alertPolicy = { confirmationReads: 2 };
  store.state.accounts[0].subagentThresholds = [{ name: 'parent', path: ['parent'], alertStep: 300000 }];
  const service = makeService();
  for (const value of [350000, 350000, 290000, 350000, 350000]) { context.parentValue = value; await service.check('account-1'); }
  assert.deepEqual(alerts, [['parent', 1]]);
  for (const value of [290000, 290000, 350000, 350000]) { context.parentValue = value; await service.check('account-1'); }
  assert.deepEqual(alerts, [['parent', 1]]);
});

test('300k to 200k to 300k stays silent across restart; 600k and return to 300k notify for both signs', async () => {
  for (const sign of [1, -1]) {
    const { store, context, makeService } = fixture();
    store.state.telegram = { mode: 'legacy', botToken: 'test', chatId: 'test' };
    store.state.accounts[0].subagentThresholds = [{ path: ['parent'], alertStep: 300000 }];
    let service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
    for (const value of [300000, 200000, 0, -200000]) { context.parentValue = value * sign; await service.check('account-1'); }
    assert.deepEqual(store.state.notificationOutbox.map(item => item.record.level), [sign]);
    service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
    for (const value of [300000, 450000, 600000, 650000, 300000, 350000]) { context.parentValue = value * sign; await service.check('account-1'); }
    assert.deepEqual(store.state.notificationOutbox.map(item => item.record.level), [sign, 2 * sign, sign]);
    context.period = { start: '2026-09-21', end: '2026-09-27' };
    await service.check('account-1');
    assert.deepEqual(store.state.notificationOutbox.map(item => item.record.level), [sign, 2 * sign, sign, sign]);
  }
});

test('diagnostic sequence below 100k no longer rearms the alert; confirms a later opposite tier', async () => {
  const { store, context, alerts, makeService } = fixture();
  store.state.alertPolicy = { confirmationReads: 2 };
  store.state.accounts[0].subagentThresholds = [{ path: ['parent'], alertStep: 100000 }];
  const service = makeService();
  for (const value of [107337.26, 107337.26, 94129.57, 94129.57, 91125.36, 89899.59, 89899.59, 95389.84, 95389.84, 71594.83, 71594.83, 72679.88, 72164.49, 72164.49, 107027.79, 107027.79]) {
    context.parentValue = value; await service.check('account-1');
  }
  assert.deepEqual(alerts, [['parent', 1]]);
  for (const value of [-107000, -107000, -90000, -90000, -107000, -107000]) {
    context.parentValue = value; await service.check('account-1');
  }
  assert.deepEqual(alerts, [['parent', 1], ['parent', -1]]);
});

test('upgrade restores an old zeroed tier without requeuing its notification', async () => {
  const { alertLedgerKey, ALERT_METRIC } = require('../electron/alert-ledger');
  const { store, context, alerts, makeService } = fixture();
  store.state.accounts[0].subagentThresholds = [{ path: ['parent'], alertStep: 300000 }];
  store.state.accounts[0].alertHistory = { period: '2026-09-14/2026-09-20', metric: ALERT_METRIC, agents: {
    [alertLedgerKey(['parent'], 300000)]: { currentLevel: 0, positiveLastAlertLevel: 1, negativeLastAlertLevel: 0 },
  } };
  context.parentValue = 350000;
  await makeService().check('account-1');
  assert.deepEqual(alerts, []);
  assert.equal(store.state.accounts[0].alertHistory.agents[alertLedgerKey(['parent'], 300000)].currentLevel, 1);
});

test('threshold edits do not invalidate in-flight work and next batch uses the new settings', async () => {
  const { store, context, alerts, makeService } = fixture();
  const service = makeService();
  context.beforeDescendant = async path => {
    if (path.length !== 1) return;
    store.state.accounts[0].subagentThresholds[1].alertStep = 1000;
    service.updateSubagentAlertStep('account-1', ['parent', 'child'], 1000);
    assert.equal(service.revisions.get('account-1') || 0, 0);
    assert.equal(service.rerunRequested.has('account-1'), true);
    // Keep this test bounded rather than letting the queued follow-up run.
    service.rerunRequested.clear();
  };
  await service.check('account-1');
  assert.equal(alerts.some(([path]) => path === 'parent/child'), false);
  assert.equal(service.status('account-1').subagents.find(item => item.name === 'child').alertStep, 1000);
});

test('failed full scans resume completed non-focus branches after restart without using cached amounts for alerts', async () => {
  const { store, context, makeService } = fixture();
  store.state.accounts[0].subagentThresholds = [];
  context.descendants = new Map([
    ['parent', { agents: [{ name: 'bad', value: 1 }, { name: 'good', value: 2 }] }],
    ['parent/good', { agents: [{ name: 'leaf', value: 3 }] }],
  ]);
  let fail = true; const reads = [];
  context.beforeDescendant = async path => { reads.push(path.join('/')); if (fail && path.join('/') === 'parent/bad') throw new Error('branch offline'); };
  await makeService().check('account-1');
  assert.ok(store.state.accounts[0].scanCheckpoint.completed['["parent","good"]']);
  reads.length = 0; fail = false;
  const service = makeService(); await service.check('account-1');
  assert.deepEqual(reads, ['parent', 'parent/bad']);
  assert.equal(store.state.accounts[0].scanCheckpoint, undefined);
  assert.equal(service.status('account-1').subagents.find(item => item.name === 'leaf').stale, true);
});

test('confirmed terminal branches expire and manual full scan bypasses the cache', async () => {
  const { store, context, makeService } = fixture();
  store.state.accounts[0].subagentThresholds = [];
  context.descendants = new Map();
  const service = makeService(); await service.check('account-1');
  context.descendantReads = 0;
  await service.check('account-1'); assert.equal(context.descendantReads, 0);
  store.state.accounts[0].leafCache.paths['["parent"]'] = Date.now() - 7 * 3600000;
  await service.check('account-1'); assert.equal(context.descendantReads, 1);
  service.requestRecheck = () => {};
  service.requestFullScan('account-1');
  await service.check('account-1'); assert.equal(context.descendantReads, 2);
});

test('long full scans interleave fresh priority reads serially before finishing structure', async () => {
  const { store, context, alerts, makeService } = fixture();
  store.state.accounts[0].intervalMinutes = 1;
  store.state.accounts[0].subagentThresholds = [{ path: ['parent'], alertStep: 100 }];
  const now = Date.now; let elapsed = 0; const started = now();
  Date.now = () => started + elapsed;
  try {
    context.beforeDescendant = async path => { if (path.length === 1) { elapsed = 61000; context.parentValue = 350; } };
    await makeService().check('account-1');
    assert.deepEqual(alerts, [['parent', 1], ['parent', 2], ['parent', 3]]);
  } finally { Date.now = now; }
});

test('durable queue captures upward and downward crossings offline without blocking reads or replaying tiers', async () => {
  const { store, context, makeService } = fixture();
  store.state.telegram = { mode: 'legacy', botToken: 'test', chatId: 'test' };
  store.state.accounts[0].subagentThresholds = [{ name: 'parent', path: ['parent'], alertStep: 20 }];
  let service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  for (const value of [20, 40, 20]) { context.parentValue = value; await service.check('account-1'); }
  assert.deepEqual(store.state.notificationOutbox.map(item => item.record.level), [1, 2, 1]);
  assert.equal(store.state.alertRecords?.length || 0, 0, 'queue acceptance is not delivery');
  service = makeService(); service.sendTelegram = MonitorService.prototype.sendTelegram;
  await service.check('account-1');
  assert.equal(store.state.notificationOutbox.length, 3, 'restart does not recreate already queued crossings');
  let sent = 0; service.deliverOperationalTelegram = async () => { sent++; };
  await service.outbox.flush();
  assert.equal(sent, 3); assert.equal(store.state.alertRecords.length, 3);
});

test('important branches run first and a failed branch is retried only after other branches', async () => {
  const { store, context, makeService } = fixture();
  store.state.accounts[0].subagentThresholds = [{ path: ['parent', 'important', 'leaf'], alertStep: 20 }];
  context.descendants = new Map([['parent', { agents: [{ name: 'important', value: 0 }, { name: 'other', value: 0 }], value: 0 }]]);
  const reads = []; let failed = false;
  context.beforeDescendant = async path => {
    reads.push(path.join('/'));
    if (path.join('/') === 'parent/important' && !failed) { failed = true; throw new Error('本周报表加载超时'); }
  };
  const service = makeService(); await service.check('account-1');
  assert.deepEqual(reads, ['parent', 'parent/important', 'parent/other', 'parent/important']);
  assert.equal(service.status('account-1').status, 'ok');
});

test('publishes and alerts the first layer before a slow descendant finishes, once per check', async () => {
  const { alerts, context, store, makeService } = fixture();
  store.state.alertPolicy = { confirmationReads: 2 };
  const service = makeService();
  await service.check('account-1');
  assert.equal(alerts.length, 0);
  context.beforeDescendant = async (path) => {
    if (path.length !== 1) return;
    assert.deepEqual(alerts, [['parent', 1], ['parent', 2]]);
    const status = service.status('account-1');
    assert.equal(status.running, true);
    assert.equal(status.subagents.find(a => a.name === 'parent').stale, undefined);
    assert.equal(status.subagents.find(a => a.name === 'child').stale, true);
  };
  await service.check('account-1');
  assert.equal(alerts.length, 5);
  assert.equal(service.status('account-1').status, 'triggered');
  assert.ok(service.status('account-1').phaseTimings.branches.length > 0);
});

test('keeps the 166 session window for the next check without hiding a manually opened window', async () => {
  const { makeService } = fixture();
  const service = makeService();
  let opens = 0, hides = 0, closes = 0;
  const win = { isDestroyed: () => false, once() {}, hide() { hides++; } };
  const factory = service.createSiteClient;
  service.createSiteClient = (...args) => {
    const client = factory(...args);
    client.ownsWindow = true;
    client.open = async () => { opens++; client.window = win; };
    client.close = async () => { if (client.ownsWindow) closes++; };
    return client;
  };
  await service.check('account-1');
  await service.check('account-1');
  assert.equal(opens, 1);
  assert.equal(closes, 0);
  assert.equal(hides, 1);
  assert.equal(service.viewWindows.get('account-1'), win);
});

test('schedules from the start of the check, accounting for time spent reading', async () => {
  const { context, store, makeService } = fixture();
  store.state.accounts[0].intervalMinutes = 1;
  const realNow = Date.now;
  const started = realNow();
  let elapsed = 0;
  Date.now = () => started + elapsed;
  try {
    context.beforeDescendant = async () => { elapsed = 20000; };
    const service = makeService();
    await service.check('account-1');
    assert.equal(Date.parse(service.status('account-1').nextCheckAt), started + 60000);
    assert.equal(service.status('account-1').durationMs, 20000);
  } finally {
    Date.now = realNow;
  }
});

test('discovers all four levels once, then selects only reminder branches and preserves unread data', async () => {
  const { context, store, alerts, makeService } = fixture();
  context.descendants = new Map([
    ['parent', { agents: [{ name: 'child', value: 10 }, { name: 'other', value: 20 }] }],
    ['parent/child', { agents: [{ name: 'third', value: 30 }] }],
    ['parent/child/third', { agents: [{ name: 'fourth', value: 40 }] }],
    ['parent/child/third/fourth', { agents: [{ name: 'fifth', value: 50 }] }],
    ['parent/other', { agents: [{ name: 'third', value: 99 }] }],
  ]);
  const reads = [];
  context.beforeDescendant = async path => reads.push(path.join('/'));
  let service = makeService();
  await service.check('account-1');
  assert.ok(reads.includes('parent/other'));
  assert.ok(reads.includes('parent/child/third'));
  assert.equal(store.state.accounts[0].agentSnapshot.structureVersion, 1);
  reads.length = 0;
  service = makeService(); // structure survives restart
  await service.check('account-1');
  assert.deepEqual(reads, ['parent']);
  assert.equal(service.status('account-1').subagents.find(a => a.name === 'fourth').notRefreshed, true);
  const leafPath = ['parent', 'child', 'third', 'fourth'];
  store.state.accounts[0].subagentThresholds.push({ name: 'fourth', path: leafPath, deltaAlertStep: 10 });
  reads.length = 0;
  await service.check('account-1');
  assert.deepEqual(reads, ['parent', 'parent/child', 'parent/child/third']);
  assert.equal(Boolean(service.status('account-1').subagents.find(a => a.name === 'fourth').stale), false);
  assert.equal(service.status('account-1').subagents.find(a => a.path.join('/') === 'parent/other/third').notRefreshed, true);
  store.state.accounts[0].subagentThresholds.at(-1).deltaAlertStep = null;
  reads.length = 0;
  const sent = alerts.length;
  await service.check('account-1');
  assert.deepEqual(reads, ['parent']);
  assert.equal(alerts.length, sent);
  let scheduled = false;
  service.requestRecheck = () => { scheduled = true; };
  service.requestFullScan('account-1');
  assert.equal(scheduled, true);
  reads.length = 0;
  await service.check('account-1');
  assert.ok(reads.includes('parent/other'));
  assert.ok(reads.includes('parent/child/third'));
  assert.equal(service.fullScanRequested.has('account-1'), false);
});

test('partial initial discovery retries fully and removed parents prune cached descendants', async () => {
  const { context, store, makeService } = fixture();
  const service = makeService();
  context.childFailure = true;
  await service.check('account-1');
  assert.notEqual(store.state.accounts[0].agentSnapshot.structureVersion, 1);
  context.childFailure = false;
  context.descendants = new Map([
    ['parent', { agents: [{ name: 'child', value: 10 }] }],
    ['parent/child', { agents: [{ name: 'third', value: 30 }] }],
  ]);
  await service.check('account-1');
  assert.equal(store.state.accounts[0].agentSnapshot.structureVersion, 1);
  context.descendants.set('parent', { agents: [] });
  await service.check('account-1');
  assert.deepEqual(service.status('account-1').subagents.map(a => a.name), ['parent']);
});

test('monitor repeats alerts when values return to an earlier tier, while retaining state across restart', async () => {
  const { alerts, context, store, makeService } = fixture();
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(alerts, [
    ['parent', 1], ['parent', 2],
    ['parent/child', -1], ['parent/child', -2], ['parent/child', -3],
  ]);
  assert.equal(service.status('account-1').status, 'triggered');
  context.parentValue = 50;
  context.childValue = -50;
  await service.check('account-1');
  context.parentValue = 250;
  context.childValue = -350;
  await service.check('account-1');
  assert.equal(alerts.length, 5);

  const afterRestart = fixture(structuredClone(store.state));
  await afterRestart.makeService().check('account-1');
  assert.deepEqual(afterRestart.alerts, []);
  afterRestart.context.period = { start: '2026-09-21', end: '2026-09-27' };
  await afterRestart.makeService().check('account-1');
  assert.equal(afterRestart.alerts.length, 5);
});

test('monitor notifies 20, 40, 20, and 40 again as a value changes direction', async () => {
  const { alerts, context, store, makeService } = fixture();
  store.state.accounts[0].subagentThresholds[0].alertStep = 20;
  context.parentValue = 20;
  context.childValue = 0;
  const service = makeService();
  await service.check('account-1');
  context.parentValue = 40;
  await service.check('account-1');
  context.parentValue = 20;
  await service.check('account-1');
  context.parentValue = 40;
  await service.check('account-1');
  assert.deepEqual(alerts.filter(([path]) => path === 'parent'), [
    ['parent', 1], ['parent', 2], ['parent', 1], ['parent', 2],
  ]);
});

test('failed delivery retries only unsent tiers', async () => {
  const { alerts, store, makeService } = fixture();
  const service = makeService();
  const send = service.sendTelegram;
  let failOnce = true;
  service.sendTelegram = async (...args) => {
    if (args[7].join('/') === 'parent' && args[2] === 2 && failOnce) {
      failOnce = false;
      throw new Error('network failed');
    }
    return send(...args);
  };
  await service.check('account-1');
  assert.equal(service.status('account-1').status, 'error');
  assert.equal(store.state.alertRecords.some((record) => record.status === 'failed' && record.error === 'network failed'), true);
  await service.check('account-1');
  assert.deepEqual(alerts.filter(([path]) => path === 'parent'), [['parent', 1], ['parent', 2]]);
  assert.equal(store.state.alertRecords.some((record) => record.status === 'sent' && record.level === 2), true);
});

test('metric change archives old tiers and sends one initial summary per agent', async () => {
  const { alerts, store, makeService } = fixture();
  delete store.state.accounts[0].alertMetricVersion;
  store.state.accounts[0].alertHistory = {
    period: '2026-09-14/2026-09-20',
    agents: { old: { positiveMax: 100, negativeMax: 100 } },
  };
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(alerts, [['parent', 2], ['parent/child', -3]]);
  assert.equal(store.state.accounts[0].alertHistoryArchive[0].metric, 'upper-level-settlement-v1');
  assert.equal(store.state.accounts[0].alertHistory.migrationPending, false);
  assert.equal(store.state.accounts[0].alertMetricVersion, 'weekly-receivable-downline-v2');
  assert.equal(service.status('account-1').subagents.every((agent) => Boolean(agent.readAt)), true);
  assert.equal(store.state.accounts[0].agentSnapshot.agents.length, 2);
  const restored = fixture(structuredClone(store.state)).makeService();
  assert.equal(restored.status('account-1').subagents.every((agent) => agent.stale), true);
  assert.equal(restored.status('account-1').subagents.every((agent) => Boolean(agent.readAt)), true);
});

test('an older account with no alert history still receives only one initial summary', async () => {
  const { alerts, store, makeService } = fixture();
  delete store.state.accounts[0].alertMetricVersion;
  await makeService().check('account-1');
  assert.deepEqual(alerts, [['parent', 2], ['parent/child', -3]]);
  assert.equal(store.state.accounts[0].alertHistory.migrationPending, false);
});

test('failed descendant read retains its last successful value but does not alert on stale data', async () => {
  const { alerts, context, makeService } = fixture();
  const service = makeService();
  await service.check('account-1');
  const childReadAt = service.status('account-1').subagents.find((agent) => agent.name === 'child').readAt;
  context.childFailure = true;
  context.childValue = -550;
  await service.check('account-1');
  const child = service.status('account-1').subagents.find((agent) => agent.name === 'child');
  assert.equal(child.stale, true);
  assert.equal(child.readAt, childReadAt);
  assert.equal(child.value, -350);
  assert.equal(alerts.length, 5);
});

test('monitor discovers each downline level through level four without reading a fifth level', async () => {
  const { context, makeService } = fixture();
  context.descendants = new Map([
    ['parent', { value: -200, agents: [{ name: 'child', value: -200 }] }],
    ['parent/child', { value: 300, agents: [{ name: 'third', value: 300 }] }],
    ['parent/child/third', { value: -400, agents: [{ name: 'fourth', value: -400 }] }],
    ['parent/child/third/fourth', { value: 500, agents: [{ name: 'fifth', value: 500 }] }],
    ['parent/child/third/fourth/fifth', { value: 600, agents: [{ name: 'sixth', value: 600 }] }],
  ]);
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(service.status('account-1').subagents.map((agent) => agent.path), [
    ['parent'], ['parent', 'child'], ['parent', 'child', 'third'], ['parent', 'child', 'third', 'fourth'],
  ]);
  assert.equal(context.descendantReads, 3);
});

test('confirmation policy holds a new tier until it is read consecutively, while saving a trend point', async () => {
  const { alerts, store, makeService } = fixture();
  store.state.alertPolicy = { confirmationReads: 2, quietStart: '', quietEnd: '', failureEscalation: 3 };
  const service = makeService();
  await service.check('account-1');
  assert.equal(alerts.length, 0);
  assert.equal(store.state.accounts[0].agentTrend.length, 1);
  await service.check('account-1');
  assert.equal(alerts.length, 5);
  assert.equal(store.state.accounts[0].agentTrend.length, 2);
  assert.equal(service.status('account-1').consecutiveFailures, 0);
  assert.ok(service.status('account-1').lastSuccessAt);
});

test('single-read change alert waits for a baseline, then records a delivered delta', async () => {
  const { context, store, deltaAlerts, makeService } = fixture();
  store.state.accounts[0].subagentThresholds[0].deltaAlertStep = 100;
  context.childValue = 0;
  const service = makeService();
  await service.check('account-1');
  assert.equal(deltaAlerts.length, 0);
  context.parentValue = 400;
  await service.check('account-1');
  assert.equal(deltaAlerts.length, 1);
  assert.match(deltaAlerts[0], /本次变化：\+150/);
  assert.equal(store.state.alertRecords.some((record) => record.alertType === 'delta' && record.status === 'sent'), true);
});

test('settlement week switches at Monday 06:00, not midnight', () => {
  assert.deepEqual(settlementWeekRange(new Date(2026, 8, 21, 5, 59)), { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(settlementWeekRange(new Date(2026, 8, 21, 6, 0)), { start: '2026-09-21', end: '2026-09-27' });
});

test('Crown general-agent details alert each general agent by result without reading descendants', async () => {
  const { alerts, context, store, makeService } = fixture({
    accounts: [{
      id: 'account-1', name: '本级', enabled: true, intervalMinutes: 5,
      systemType: 'crown', crownLoginEntry: 'login-1', alertMetricVersion: 'weekly-crown-general-agent-details-v2',
      subagentThresholds: [{ name: 'parent', path: ['parent'], alertStep: 100, remark: '总盘' }],
    }],
    telegram: {},
  });
  context.parentValue = -250;
  context.parentTurnover = 99999;
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(alerts, [['parent', -1], ['parent', -2]]);
  assert.equal(service.status('account-1').subagentCount, 1);
  assert.equal(service.status('account-1').subagents[0].value, -250);
  assert.equal(service.status('account-1').subagents[0].turnover, 99999);
  assert.equal(context.descendantReads, 0);
  assert.equal(store.state.accounts[0].agentSnapshot.metric, 'general-agent-result');
  assert.equal(store.state.accounts[0].agentSnapshot.agents[0].turnover, 99999);
});
