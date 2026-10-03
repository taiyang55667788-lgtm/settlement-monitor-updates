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
    async send(token, message, options) { calls.push(['send', token, message, options]); },
    async unlink(token) { calls.push(['unlink', token]); },
  };
  const service = new MonitorService(store, () => {}, { pairingClient });
  return { store, service, events, calls };
}

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
  service.pairingClient.nextCommand = async () => ({ command: { type: 'report' } });
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
  service.pairingClient.nextCommand = async () => ({ command: { type: 'accounts' } });
  await service.pollTelegramCommands();
  const selector = calls.find((entry) => entry[0] === 'send');
  assert.match(selector[3].replyMarkup.inline_keyboard[0][0].callback_data, /^q:check:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{22}$/);

  const checked = [];
  service.pairingClient.nextCommand = async () => ({ command: { type: 'check', accountId: secondId } });
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
  service.pairingClient.nextCommand = async () => ({ command: { type: 'status' } });
  service.check = async () => { throw new Error('status must not refresh'); };
  service.status = () => ({ status: 'ok', lastSuccessAt: '2026-10-04T01:00:00.000Z', error: '' });
  await service.pollTelegramCommands();
  assert.match(calls.at(-1)[2], /交收监控状态[\s\S]*一号盘：正常/);
  assert.equal(calls.at(-1)[3].replyMarkup.inline_keyboard[2][0].callback_data, 'q:accounts');
});
