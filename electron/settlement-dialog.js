// Only a known informational alert is acknowledged. Never accept confirm/prompt.
const guards = new WeakMap();
function isSettlementDialog(params) {
  return params?.type === 'alert' && /^正在结算中[，,、\s]*请稍[等候][。.!！…\s]*$/.test(String(params.message || '').trim());
}
function settlementDelay(attempt) { return Math.min(180000, 30000 * 2 ** Math.min(3, Math.max(0, attempt - 1))); }
function settlementError() { return Object.assign(new Error('等待盘口结算'), { code: 'SETTLEMENT_DIALOG_PENDING' }); }

async function guardSettlementDialogs(win, onSettlement = () => {}) {
  const wc = win?.webContents;
  if (!wc?.debugger) return null; // Test clients may not own a real browser.
  const existing = guards.get(wc);
  if (existing) { existing.onSettlement = onSettlement; return existing; }
  const debug = wc.debugger;
  const guard = { onSettlement, pending: false, waiters: new Set(),
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
  try {
    if (!debug.isAttached()) debug.attach('1.3');
    debug.on('message', (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || !isSettlementDialog(params)) return;
      guard.pending = true;
      // Raw text, dialog URL and page contents are not retained.
      void debug.sendCommand('Page.handleJavaScriptDialog', { accept: true }).then(() => {
        guard.onSettlement();
        for (const reject of guard.waiters) reject(settlementError());
      }).catch(() => {
        for (const reject of guard.waiters) reject(settlementError());
      });
    });
    wc.once('destroyed', () => { guard.waiters.clear(); });
    debug.on('detach', () => { guard.unavailable = true; });
    // Chromium may not acknowledge Page.enable until the first navigation.
    // Queue it before loadURL without waiting for that future navigation here.
    guard.ready = debug.sendCommand('Page.enable').catch(() => {
      guard.unavailable = true;
      for (const reject of guard.waiters) reject(new Error('结算弹框保护连接中断'));
    });
  } catch (error) { guards.delete(wc); throw new Error('结算弹框保护初始化失败'); }
  return guard;
}
module.exports = { guardSettlementDialogs, isSettlementDialog, settlementDelay, settlementError };
