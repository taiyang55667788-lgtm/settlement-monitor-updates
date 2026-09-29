const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationOutbox, recipientKey, importantBranch, staleTargets, boundedOperation } = require('../electron/reliability');
const { MonitorService } = require('../electron/monitor');

function fixture() {
  return { state: { telegram: { mode: 'legacy', botToken: 'test', chatId: 'chat' }, accounts: [], alertRecords: [] },
    update(fn) { fn(this.state); }, addEvent() {}, addAlertRecord(item) { this.state.alertRecords.push(item); } };
}

test('queue metadata and tier mutation are committed together before any delivery', () => {
  const store = fixture(); let writes = 0;
  store.update = fn => { const draft = structuredClone(store.state); fn(draft); store.state = draft; writes++; };
  const box = new NotificationOutbox(store, async () => {});
  box.enqueue('amount', 'amount', { record: { level: 1 }, commit: data => { data.testLevel = 1; } });
  assert.equal(writes, 1); assert.equal(store.state.testLevel, 1);
  assert.equal(store.state.notificationOutbox[0].record.level, 1);
  assert.throws(() => box.enqueue('bad', 'amount', { commit() { throw new Error('save failed'); } }), /save failed/);
  assert.equal(store.state.notificationOutbox.length, 1);
});

test('confirmed delivery with failed local commit retries persistence without resending', async () => {
  const store = fixture(); let calls = 0; let failSave = false;
  store.update = fn => { const draft = structuredClone(store.state); fn(draft); if (failSave) throw new Error('disk'); store.state = draft; };
  const box = new NotificationOutbox(store, async () => { calls++; failSave = true; });
  box.enqueue('amount', 'amount', { record: { accountId: 'a', level: 1 } });
  await box.flush(); assert.equal(calls, 1); assert.equal(store.state.notificationOutbox.length, 1);
  failSave = false; await box.flush();
  assert.equal(calls, 1); assert.equal(store.state.notificationOutbox.length, 0);
  assert.equal(store.state.alertRecords.length, 1); assert.equal(store.state.alertRecords[0].status, 'sent');
});

test('queue supports specific retry and cancellation, but not reassignment or cancellation in flight', async () => {
  const store = fixture(); let release; const delivered = [];
  const box = new NotificationOutbox(store, text => { delivered.push(text); return new Promise(resolve => { release = resolve; }); });
  const first = box.enqueue('first'); const second = box.enqueue('second');
  const flushing = box.flush(second.queueId);
  assert.throws(() => box.manage(second.queueId, 'cancel'), /正在发送/);
  release(); await flushing;
  assert.deepEqual(delivered, ['second']);
  store.state.telegram.chatId = 'new';
  assert.throws(() => box.manage(first.queueId, 'retry'), /收件人/);
  box.manage(first.queueId, 'cancel');
  assert.equal(store.state.notificationOutbox.length, 0);
});

test('automatic checks are staggered rather than all started together', async () => {
  const store = fixture(); store.state.accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
  const service = new MonitorService(store, () => {}); const calls = [];
  service.check = async id => { calls.push(id); service.status(id).nextCheckAt = new Date(Date.now() + 60000).toISOString(); };
  await service.tick(); await service.tick(); assert.deepEqual(calls, ['a']);
  service.nextAutomaticStartAt = 0; await service.tick(); assert.deepEqual(calls, ['a', 'b']);
});

test('outbox persists before delivery, survives restart, backs off, and records only attempts', async () => {
  const store = fixture(); let now = Date.now(); let calls = 0;
  const box = new NotificationOutbox(store, async () => { calls++; throw new Error('offline'); }, { now: () => now });
  const receipt = box.enqueue('original', 'amount');
  box.attach(receipt, { accountId: 'a', value: 20 });
  assert.equal(calls, 0); assert.equal(store.state.alertRecords.length, 0);
  await box.flush(); await box.flush();
  assert.equal(calls, 1); assert.equal(store.state.notificationOutbox.length, 1);
  assert.equal(store.state.alertRecords[0].status, 'failed');
  store.state = JSON.parse(JSON.stringify(store.state)); now += 10001;
  const sent = [];
  const restarted = new NotificationOutbox(store, async text => sent.push(text), { now: () => now });
  await restarted.flush();
  assert.match(sent[0], /延迟补发，原始时间/);
  assert.equal(store.state.notificationOutbox.length, 0);
  assert.equal(store.state.alertRecords[0].status, 'sent');
});

test('outbox respects quiet hours and never transfers messages to a newly paired recipient', async () => {
  const store = fixture(); let quiet = true; const sent = [];
  const box = new NotificationOutbox(store, async text => sent.push(text), { quiet: () => quiet });
  box.enqueue('amount', 'amount'); box.enqueue('operational');
  await box.flush(); assert.deepEqual(sent, ['operational']);
  store.state.telegram.chatId = 'another'; quiet = false;
  await box.flush(); assert.equal(sent.length, 1);
  store.state.telegram.chatId = 'chat';
  await Promise.all([box.flush(), box.flush()]);
  assert.deepEqual(sent, ['operational', 'amount']);
  assert.doesNotMatch(recipientKey(store.state.telegram), /test|chat/);
});

test('full outbox reports an error without dropping older messages', () => {
  const store = fixture(); store.state.notificationOutbox = Array(2000).fill({ text: 'keep' });
  const box = new NotificationOutbox(store, async () => {});
  assert.throws(() => box.enqueue('new'), /已满/);
  assert.equal(store.state.notificationOutbox.length, 2000);
});

test('important paths include required ancestors; freshness uses last success, not current runtime', () => {
  const account = { intervalMinutes: 1, subagentThresholds: [{ path: ['a', 'b'], alertStep: 20 }] };
  assert.equal(importantBranch(['a'], account.subagentThresholds), true);
  assert.equal(importantBranch(['c'], account.subagentThresholds), false);
  const now = Date.now(); const since = new Date(now - 301000).toISOString();
  assert.deepEqual(staleTargets(account, [], since, now), [['a', 'b']]);
  assert.deepEqual(staleTargets(account, [{ path: ['a', 'b'], readAt: new Date(now).toISOString() }], since, now), []);
});

test('watchdog closes old work before rejecting and abort does not start work', async () => {
  let closed = false;
  await assert.rejects(boundedOperation(() => new Promise(() => {}), 5, () => { closed = true; }), /超时/);
  assert.equal(closed, true);
  const controller = new AbortController(); controller.abort(); let started = false;
  await assert.rejects(boundedOperation(() => { started = true; }, 20, () => {}, controller.signal), /中断/);
  assert.equal(started, false);
});

test('partial failure persists across restart and only one recovery is queued after full success', async () => {
  const store = fixture(); const account = { id: 'a', enabled: true }; store.state.accounts.push(account);
  let service = new MonitorService(store, () => {}); let status = service.status('a'); status.error = 'branch failed';
  await service.updateHealth(account, status, true);
  service = new MonitorService(store, () => {}); status = service.status('a');
  await service.updateHealth(account, status, true);
  assert.equal(store.state.notificationOutbox.length, 1);
  await service.updateHealth(account, status, false); await service.updateHealth(account, status, false);
  assert.equal(store.state.notificationOutbox.length, 2);
  assert.match(store.state.notificationOutbox[1].text, /恢复正常/);
});

test('freshness sends once while running, then one recovery after fresh data arrives', async () => {
  const store = fixture(); const account = { id: 'a', enabled: true, intervalMinutes: 1, subagentThresholds: [{ path: ['p'], alertStep: 20 }] };
  store.state.accounts.push(account); const service = new MonitorService(store, () => {});
  const status = service.status('a'); status.running = true; status.freshnessSince = new Date(Date.now() - 301000).toISOString();
  await service.checkFreshness(account); await service.checkFreshness(account);
  assert.equal(store.state.notificationOutbox.length, 1);
  status.subagents = [{ path: ['p'], readAt: new Date().toISOString() }];
  await service.checkFreshness(account);
  assert.equal(store.state.notificationOutbox.length, 2);
});

test('a stuck read releases inFlight and suspend prevents new work', async () => {
  const store = fixture(); store.state.accounts.push({ id: 'a', enabled: true }); let opened = 0;
  const service = new MonitorService(store, () => {}, { operationTimeoutMs: 5,
    createSiteClient: () => ({ async open() { opened++; }, readThisWeekSettlement: () => new Promise(() => {}), async close() {} }) });
  await service.check('a');
  assert.equal(service.inFlight.size, 0); assert.match(service.status('a').error, /超时/);
  service.suspend(); await service.check('a'); assert.equal(opened, 1);
  service.stop(); service.resume(); assert.equal(service.stopped, true);
});

test('suspend aborts old reading; resume coalesces requests and never starts concurrent account work', async () => {
  const store = fixture(); store.state.accounts.push({ id: 'a', enabled: true, intervalMinutes: 1 });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let reads = 0;
  const service = new MonitorService(store, () => {}, { operationTimeoutMs: 1000, createSiteClient: () => ({
    async open() {}, readThisWeekSettlement() { reads++; entered(); return new Promise(() => {}); }, async close() {},
  }) });
  const checking = service.check('a'); await started;
  service.suspend(); service.resume(); service.resume();
  // Finish the interrupted check before allowing any scheduled rerun in the test.
  service.stop(); await checking;
  assert.equal(reads, 1); assert.equal(service.inFlight.size, 0);
  assert.equal(service.status('a').consecutiveFailures, 0, 'sleep is not a website failure');
});

test('credential failures require manual action and are not repeatedly submitted by timer or network recovery', async () => {
  const store = fixture(); store.state.accounts.push({ id: 'a', enabled: true }); let calls = 0;
  const service = new MonitorService(store, () => {}, { createSiteClient: () => ({
    async open() {}, async readThisWeekSettlement() { calls++; throw new Error('密码错误'); }, async close() {},
  }) });
  await service.check('a');
  assert.equal(service.status('a').status, 'manual');
  await service.tick(); service.resume();
  assert.equal(calls, 1);
  service.stop();
});
