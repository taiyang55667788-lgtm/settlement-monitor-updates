const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardSettlementDialogs, isSettlementDialog, settlementDelay } = require('../electron/settlement-dialog');

test('only exact informational settlement alerts qualify; retry delay is bounded', () => {
  assert.ok(isSettlementDialog({ type: 'alert', message: '正在结算中，请稍等...' }));
  for (const message of ['确认结算？', '密码错误', '正在结算中，请稍等。密码错误', '账号已在其他地方登录']) {
    assert.equal(isSettlementDialog({ type: 'alert', message }), false);
  }
  for (const type of ['confirm', 'prompt', 'beforeunload']) assert.equal(isSettlementDialog({ type, message: '正在结算中，请稍等...' }), false);
  assert.deepEqual([1, 2, 3, 4, 99].map(settlementDelay), [30000, 60000, 120000, 180000, 180000]);
});

test('one guard per page closes known alerts, interrupts reads, never accepts unknown dialogs or retains payload', async () => {
  const wc = new EventEmitter(), debug = new EventEmitter(); let attached = false, notices = 0;
  const commands = [];
  debug.isAttached = () => attached; debug.attach = () => { attached = true; };
  debug.sendCommand = async (method, params) => { commands.push([method, params]); };
  wc.debugger = debug; wc.getURL = () => 'about:blank';
  const win = { webContents: wc };
  const guard = await guardSettlementDialogs(win, () => notices++);
  assert.equal(await guardSettlementDialogs(win, () => notices++), guard);
  const read = guard.run(() => new Promise(() => {}));
  debug.emit('message', {}, 'Runtime.bindingCalled', { name: commands[2][1].name, payload: 'settlement' });
  await assert.rejects(read, { code: 'SETTLEMENT_DIALOG_PENDING' });
  assert.equal(notices, 1);
  assert.deepEqual(commands.map(c => c[0]), ['Page.enable', 'Runtime.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument']);
  debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: '正在结算中，请稍等...' });
  assert.equal(commands.length, 4);
  assert.equal(JSON.stringify(guard).includes('secret'), false);
  assert.equal(guard.waiters.size, 0);
});

test('market window destruction detaches the dialog channel before destroying native contents', async () => {
  const { destroyMarketWindow } = require('../electron/settlement-dialog');
  const order = [], wc = new EventEmitter(), debug = new EventEmitter(); let attached = true;
  debug.isAttached = () => attached;
  debug.detach = () => { order.push('detach'); attached = false; debug.emit('detach'); };
  debug.sendCommand = async () => {};
  wc.debugger = debug; wc.getURL = () => 'about:blank';
  const win = { webContents: wc, isDestroyed: () => false, destroy() { order.push('destroy'); } };
  await guardSettlementDialogs(win);
  destroyMarketWindow(win);
  assert.deepEqual(order, ['detach', 'destroy']);
});


test('document bootstrap suppresses only known settlement alerts and preserves unknown dialogs', () => {
  const vm = require('node:vm');
  const { installSettlementAlert } = require('../electron/settlement-dialog');
  const forwarded = [], notices = [];
  const confirm = () => false, prompt = () => null;
  const window = { alert: (...args) => forwarded.push(args), confirm, prompt, binding: p => notices.push(p) };
  vm.runInNewContext(`(${installSettlementAlert.toString()})('binding', ${JSON.stringify('^正在结算中[，,、\\s]*请稍[等候][。.!！…\\s]*$')})`, { window });
  for (let i = 0; i < 3; i++) window.alert('正在结算中，请稍等...');
  assert.deepEqual(notices, ['settlement', 'settlement', 'settlement']);
  window.alert('密码错误');
  assert.deepEqual(forwarded, [['密码错误']]);
  assert.equal(window.confirm, confirm); assert.equal(window.prompt, prompt);
});
