const crypto = require('node:crypto');
const guards = new WeakMap();
const settlementPattern = /^正在结算中[，,、\s]*请稍[等候][。.!！…\s]*$/;
function isSettlementDialog(params) {
  return params?.type === 'alert' && settlementPattern.test(String(params.message || '').trim());
}
function settlementDelay(attempt) { return Math.min(180000, 30000 * 2 ** Math.min(3, Math.max(0, attempt - 1))); }
function settlementError() { return Object.assign(new Error('等待盘口结算'), { code: 'SETTLEMENT_DIALOG_PENDING' }); }

// Runs before site scripts in each new document, including frames.
function installSettlementAlert(binding, pattern) {
  const original = window.alert;
  const known = new RegExp(pattern);
  window.alert = function (message) {
    if (typeof message === 'string' && known.test(message.trim())) {
      window[binding]('settlement');
      return;
    }
    return original.apply(this, arguments);
  };
}
async function guardSettlementDialogs(win, onSettlement = () => {}) {
  const wc = win?.webContents;
  if (!wc?.debugger) return null;
  const existing = guards.get(wc);
  if (existing) { existing.onSettlement = onSettlement; return existing; }
  // Initialize Chromium's target before installing protection and loading a site.
  if (!wc.getURL()) await win.loadURL('about:blank');
  const debug = wc.debugger;
  const binding = '__smSettlement' + crypto.randomBytes(12).toString('hex');
  const guard = { onSettlement, pending: false, waiters: new Set(),
    dispose() {
      guard.unavailable = true;
      try { if (debug.isAttached()) debug.detach(); } catch {}
    },
    async run(operation) {
      if (guard.unavailable) throw new Error('结算弹框保护连接中断');
      if (guard.pending) throw settlementError();
      let rejectWait;
      const interrupted = new Promise((_, reject) => { rejectWait = reject; guard.waiters.add(reject); });
      try { return await Promise.race([Promise.resolve().then(operation), interrupted]); }
      finally { guard.waiters.delete(rejectWait); }
    },
  };
  guards.set(wc, guard);
  win.once?.('close', () => guard.dispose());
  try {
    if (!debug.isAttached()) debug.attach('1.3');
    debug.on('message', (_event, method, params) => {
      if (method !== 'Runtime.bindingCalled' || params.name !== binding || params.payload !== 'settlement') return;
      guard.pending = true;
      guard.onSettlement();
      for (const reject of guard.waiters) reject(settlementError());
    });
    debug.on('detach', () => { guard.unavailable = true; });
    wc.once('destroyed', () => { guard.waiters.clear(); });
    await debug.sendCommand('Page.enable');
    await debug.sendCommand('Runtime.enable');
    await debug.sendCommand('Runtime.addBinding', { name: binding });
    const source = `(${installSettlementAlert.toString()})(${JSON.stringify(binding)},${JSON.stringify(settlementPattern.source)})`;
    await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
  } catch {
    guard.dispose(); guards.delete(wc);
    throw new Error('结算弹框保护初始化失败');
  }
  return guard;
}
function destroyMarketWindow(win) {
  if (!win || win.isDestroyed()) return;
  guards.get(win.webContents)?.dispose();
  win.destroy();
}
module.exports = { guardSettlementDialogs, destroyMarketWindow, isSettlementDialog, settlementDelay, settlementError, installSettlementAlert };
