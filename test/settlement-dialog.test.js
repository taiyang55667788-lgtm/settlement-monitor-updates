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
  wc.debugger = debug;
  const win = { webContents: wc };
  const guard = await guardSettlementDialogs(win, () => notices++);
  assert.equal(await guardSettlementDialogs(win, () => notices++), guard);
  const read = guard.run(() => new Promise(() => {}));
  debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: '正在结算中，请稍等...', url: 'https://secret.invalid/?token=secret' });
  await assert.rejects(read, { code: 'SETTLEMENT_DIALOG_PENDING' });
  assert.equal(notices, 1);
  assert.deepEqual(commands, [['Page.enable', undefined], ['Page.handleJavaScriptDialog', { accept: true }]]);
  debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: '正在结算中，请稍等...' });
  assert.equal(commands.length, 2);
  assert.equal(JSON.stringify(guard).includes('secret'), false);
  assert.equal(guard.waiters.size, 0);
});

test('market window destruction detaches the dialog channel before destroying native contents', async () => {
  const { destroyMarketWindow } = require('../electron/settlement-dialog');
  const order = [], wc = new EventEmitter(), debug = new EventEmitter(); let attached = true;
  debug.isAttached = () => attached;
  debug.detach = () => { order.push('detach'); attached = false; debug.emit('detach'); };
  debug.sendCommand = async () => {};
  wc.debugger = debug;
  const win = { webContents: wc, isDestroyed: () => false, destroy() { order.push('destroy'); } };
  await guardSettlementDialogs(win);
  destroyMarketWindow(win);
  assert.deepEqual(order, ['detach', 'destroy']);
});
