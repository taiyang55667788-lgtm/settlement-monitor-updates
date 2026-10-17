const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../electron/monitor');

function setup() {
  const events = [];
  const calls = [];
  const store = {
    state: { telegram: { mode: 'legacy', botToken: 'old-token', chatId: 'old-chat', pairing: null }, accounts: [] },
    update(change) { change(this.state); },
    addEvent(...args) { events.push(args); },
  };
  const pairingClient = {
    async start() { return { token: 'device-token', code: 'ABCDEFGHJK', expiresAt: Date.now() + 600000, botUsername: 'SampleMonitorBot' }; },
    async status(token) { calls.push(['status', token]); return { paired: true }; },
    async test(token) { calls.push(['test', token]); },
    async send(token, message, options) { calls.push(['send', token, message, options]); return { notificationId: options?.notificationId }; },
    async ackCommand() { return { ok: true }; },
    async unlink(token) { calls.push(['unlink', token]); },
  };
  const service = new MonitorService(store, () => {}, { pairingClient });
  return { store, service, events, calls };
}

test('command polling backs off separately from delivery and reports recovery once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 18) });
  const { store, service, events } = setup();
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: 'test-token' } };
  let calls = 0;
  service.pairingClient.nextCommand = async () => { calls++; throw Object.assign(Error('private response'), { status: 503 }); };
  const delivery = structuredClone(service.outbox.health);
  await service.pollTelegramCommands(); await service.pollTelegramCommands();
  assert.equal(calls, 1); assert.equal(service.commandHealth.code, 'HTTP_503');
  t.mock.timers.tick(30000); await service.pollTelegramCommands();
  assert.equal(calls, 2); assert.equal(service.commandHealth.consecutiveFailures, 2);
  assert.equal(events.filter(event => event[0] === 'error').length, 1);
  assert.ok(!JSON.stringify(service.commandHealth).includes('private'));
  t.mock.timers.tick(60000);
  service.pairingClient.nextCommand = async () => ({ command: null });
  await service.pollTelegramCommands(); await service.pollTelegramCommands();
  assert.equal(service.commandHealth.state, 'ok'); assert.equal(service.commandHealth.nextPollAt, '');
  assert.equal(events.filter(event => event[0] === 'success').length, 1);
  assert.deepEqual(service.outbox.health, delivery);
});

test('changing pairing token does not inherit a prior recipient polling backoff', async () => {
  const { store, service } = setup();
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: 'first' } };
  service.pairingClient.nextCommand = async () => { throw Error('network'); };
  await service.pollTelegramCommands();
  store.state.telegram.pairing.token = 'second';
  service.pairingClient.nextCommand = async () => ({ command: null });
  await service.pollTelegramCommands();
  assert.equal(service.commandHealth.state, 'ok');
});

test('monitor resumes a frozen reply and acknowledgement without re-reading the report', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 18, 12) });
  const { store, service } = setup(); const id = '11111111-2222-4333-8444-555555555555';
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: 'device-token' } };
  store.state.accounts = [{ id: 'a', name: 'a', enabled: true }];
  let reads = 0, polls = 0, sends = 0, acks = 0;
  service.check = async () => { reads++; };
  service.status = () => ({ status: 'ok', subagents: [] });
  service.pairingClient.nextCommand = async () => { polls++; return { id, command: { type: 'report' } }; };
  service.pairingClient.send = async (_, __, options) => { sends++; if (sends === 1) throw Error('lost receipt'); return { notificationId: options.notificationId }; };
  service.pairingClient.ackCommand = async () => { acks++; if (acks === 1) throw Object.assign(Error('service'), { status: 503 }); };
  await service.pollTelegramCommands(); assert.equal(service.commandReplies.current().stage, 'prepared');
  t.mock.timers.tick(30000); await service.pollTelegramCommands();
  assert.equal(service.commandHealth.phase, 'ack'); assert.equal(service.commandReplies.current().stage, 'sent');
  t.mock.timers.tick(60000); await service.pollTelegramCommands();
  assert.equal(reads, 1); assert.equal(polls, 1); assert.equal(sends, 2); assert.equal(acks, 2);
  assert.equal(service.commandReplies.current(), undefined);
});

test('pairing activates only after Telegram confirms, and routes alerts through the server', async () => {
  const { store, service, calls } = setup();
  const code = await service.startTelegramPairing();
  assert.equal(code.code, 'ABCDEFGHJK');
  assert.equal(store.state.telegram.mode, 'legacy');
  assert.equal(store.state.telegram.pairing.paired, false);
  assert.deepEqual(await service.checkTelegramPairing(), { paired: true });
  assert.equal(store.state.telegram.mode, 'pairing');
  await service.testTelegram();
  await service.sendTelegram({ name: '主账号' }, -200, -2, -1, '下级代理', 100, '西区重点', ['直属代理', '下级代理']);
  await service.outbox.flush();
  assert.deepEqual(calls.slice(0, 2), [['status', 'device-token'], ['test', 'device-token']]);
  assert.equal(calls[2][0], 'send');
  assert.match(calls[2][2], /上一次档位：-100/);
  assert.match(calls[2][2], /代理层级：直属代理 \/ 下级代理（西区重点）/);
  assert.doesNotMatch(calls[2][2], /当前档位|备注：|报表区间/);
});

test('unlink turns notifications off even when old manual credentials remain', async () => {
  const { store, service, calls } = setup();
  await service.startTelegramPairing();
  await service.checkTelegramPairing();
  await service.unlinkTelegramPairing();
  assert.equal(store.state.telegram.mode, 'off');
  assert.equal(store.state.telegram.pairing, null);
  assert.equal(store.state.telegram.botToken, 'old-token');
  assert.deepEqual(calls.at(-1), ['unlink', 'device-token']);
  await assert.rejects(service.sendTelegram({ name: '主账号' }, 100, 1, 0, '下级代理', 100), /请先绑定 Telegram/);
});

test('paired mode never falls back to old manual token on pairing failure', async () => {
  const { store, service } = setup();
  store.state.telegram.mode = 'pairing';
  await assert.rejects(service.testTelegram(), /配对尚未完成/);
});

test('revoked device token clears stale pairing without restoring old manual credentials', async () => {
  const { store, service } = setup();
  await service.startTelegramPairing();
  service.pairingClient.status = async () => { throw Object.assign(new Error('invalid device'), { status: 401 }); };
  assert.deepEqual(await service.checkTelegramPairing(), { paired: false, invalidated: true });
  assert.equal(store.state.telegram.mode, 'off');
  assert.equal(store.state.telegram.pairing, null);
});

test('report reply identifies retained stale values after the requested refresh fails', async () => {
  const { store, service, calls } = setup();
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: 'device-token' } };
  store.state.accounts = [{ id: 'account-1', name: '一号盘', enabled: true }];
  service.pairingClient.nextCommand = async () => ({ id: '11111111-2222-4333-8444-555555555555', command: { type: 'report' } });
  service.check = async () => {};
  service.status = () => ({
    status: 'error', error: '登录状态失效', reportPeriod: { start: '2026-09-28', end: '2026-10-04' },
    subagents: [{ path: ['总代理', '下级代理'], value: 120000, stale: true }],
  });

  await service.pollTelegramCommands();

  const reply = calls.find((entry) => entry[0] === 'send')?.[2];
  assert.match(reply, /本次刷新失败：登录状态失效/);
  assert.match(reply, /上次成功读取，已过期/);
  assert.match(reply, /下级代理 \+120000/);
});

test('account selector creates source-isolated buttons and refreshes only the selected account', async () => {
  const { store, service, calls } = setup();
  const deviceId = '11111111-2222-4333-8444-555555555555';
  const firstId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const secondId = 'ffffffff-1111-4222-8333-444444444444';
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: `${deviceId}.secret` } };
  store.state.accounts = [{ id: firstId, name: '一号盘', enabled: true }, { id: secondId, name: '二号盘', enabled: true }];
  service.pairingClient.nextCommand = async () => ({ id: '11111111-2222-4333-8444-555555555555', command: { type: 'accounts' } });
  await service.pollTelegramCommands();
  const selector = calls.find((entry) => entry[0] === 'send');
  assert.match(selector[3].replyMarkup.inline_keyboard[0][0].callback_data, /^q:check:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{22}$/);

  const checked = [];
  service.pairingClient.nextCommand = async () => ({ id: '11111111-2222-4333-8444-555555555555', command: { type: 'check', accountId: secondId } });
  service.check = async (id) => { checked.push(id); };
  service.status = () => ({ status: 'ok', reportPeriod: null, subagents: [], error: '' });
  await service.pollTelegramCommands();
  assert.deepEqual(checked, [secondId]);
  assert.match(calls.at(-1)[2], /二号盘/);
});

test('status command is read-only and returns the query panel', async () => {
  const { store, service, calls } = setup();
  store.state.telegram = { mode: 'pairing', pairing: { paired: true, token: 'device-token' } };
  store.state.accounts = [{ id: 'account-1', name: '一号盘', enabled: true }];
  service.pairingClient.nextCommand = async () => ({ id: '11111111-2222-4333-8444-555555555555', command: { type: 'status' } });
  service.check = async () => { throw new Error('status must not refresh'); };
  service.status = () => ({ status: 'ok', lastSuccessAt: '2026-10-04T01:00:00.000Z', error: '' });
  await service.pollTelegramCommands();
  assert.match(calls.at(-1)[2], /交收监控状态[\s\S]*一号盘：正常/);
  assert.equal(calls.at(-1)[3].replyMarkup.inline_keyboard[2][0].callback_data, 'q:accounts');
});
