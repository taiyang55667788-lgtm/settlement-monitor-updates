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
    async send(token, message) { calls.push(['send', token, message]); },
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
  assert.deepEqual(calls.slice(0, 2), [['status', 'device-token'], ['test', 'device-token']]);
  assert.equal(calls[2][0], 'send');
  assert.match(calls[2][2], /当前档位：-200/);
  assert.match(calls[2][2], /代理层级：直属代理 \/ 下级代理/);
  assert.match(calls[2][2], /备注：西区重点/);
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
