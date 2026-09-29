const crypto = require('node:crypto');
const { alertLedgerKey, recordAlertLevel } = require('./alert-ledger');

function recipientKey(telegram = {}) {
  const identity = telegram.mode === 'pairing' && telegram.pairing?.paired && telegram.pairing.token
    ? ['pairing', telegram.pairing.token]
    : telegram.mode === 'legacy' && telegram.botToken && telegram.chatId
      ? ['legacy', telegram.botToken, telegram.chatId] : null;
  return identity ? crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex') : '';
}

function importantBranch(path, settings = []) {
  return settings.some(item => (Number(item.alertStep) > 0 || Number(item.deltaAlertStep) > 0)
    && (item.path || [item.name]).length >= path.length
    && path.every((part, i) => part === (item.path || [item.name])[i]));
}

function staleTargets(account, agents, since, now = Date.now()) {
  const limit = Math.max(5 * 60000, (Number(account.intervalMinutes) || 5) * 3 * 60000);
  return (account.subagentThresholds || []).filter(item => Number(item.alertStep) > 0 || Number(item.deltaAlertStep) > 0)
    .map(item => item.path || [item.name]).filter(path => {
      const agent = agents.find(item => JSON.stringify(item.path) === JSON.stringify(path));
      const readAt = Date.parse(agent?.readAt || since);
      return !Number.isFinite(readAt) || now - readAt >= limit;
    });
}

// Reject first only after the old page has been destroyed; callers may then recover safely.
async function boundedOperation(operation, timeoutMs, cancel, signal) {
  let timer;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      const stop = () => { try { cancel(); } catch {} };
      abort = () => { stop(); reject(Object.assign(new Error('读取已中断，等待恢复'), { code: 'READ_INTERRUPTED' })); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        stop();
        reject(Object.assign(new Error('读取操作超时，已关闭卡住的页面'), { code: 'READ_WATCHDOG' }));
      }, timeoutMs);
      Promise.resolve().then(() => {
        if (signal?.aborted) return;
        return operation();
      }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

class NotificationOutbox {
  constructor(store, send, { quiet = () => false, changed = () => {}, now = Date.now } = {}) {
    this.store = store; this.send = send; this.quiet = quiet; this.changed = changed; this.now = now;
    this.running = false;
  }
  enqueue(text, kind = 'operational') {
    const recipient = recipientKey(this.store.state.telegram);
    if (!recipient) throw new Error('请先绑定 Telegram');
    const item = { id: crypto.randomUUID(), recipient, text, kind, createdAt: new Date(this.now()).toISOString(), attempts: 0, nextAttemptAt: 0 };
    this.store.update(data => {
      data.notificationOutbox ||= [];
      if (data.notificationOutbox.length >= 2000) throw new Error('通知待发队列已满，请恢复 Telegram 连接');
      data.notificationOutbox.push(item);
    });
    this.changed();
    return { queued: true, queueId: item.id };
  }
  attach(receipt, record) {
    this.store.update(data => {
      const item = data.notificationOutbox?.find(item => item.id === receipt.queueId);
      if (item) item.record = record;
    });
  }
  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 10; i++) {
        const recipient = recipientKey(this.store.state.telegram);
        const item = this.store.state.notificationOutbox?.find(entry => entry.recipient === recipient
          && !(entry.kind === 'amount' && this.quiet()));
        if (!item || item.nextAttemptAt > this.now()) break;
        try {
          const delayed = item.attempts > 0 || this.now() - Date.parse(item.createdAt) > 60000;
          await this.send(item.text + (delayed ? `\n⏱ 延迟补发，原始时间：${item.createdAt}` : ''));
          this.store.update(data => {
            data.notificationOutbox = data.notificationOutbox.filter(entry => entry.id !== item.id);
            const record = item.record;
            const account = data.accounts?.find(account => account.id === record?.accountId);
            if (account && record?.period && record.alertType !== 'delta') {
              const period = `${record.period.start}/${record.period.end}`;
              if (account.deliveredAlertHistory?.period !== period || account.deliveredAlertHistory?.metric !== record.metric) {
                account.deliveredAlertHistory = { period, metric: record.metric, agents: {} };
              }
              const key = alertLedgerKey(record.agentPath, record.alertStep);
              account.deliveredAlertHistory.agents[key] = recordAlertLevel(account.deliveredAlertHistory.agents[key], record.level, new Date(this.now()).toISOString());
            }
          });
          if (item.record) this.store.addAlertRecord?.({ ...item.record, status: 'sent', queuedAt: item.createdAt });
        } catch (error) {
          this.store.update(data => {
            const pending = data.notificationOutbox?.find(entry => entry.id === item.id);
            if (pending) {
              pending.attempts++;
              pending.error = String(error.message || error);
              pending.nextAttemptAt = this.now() + Math.min(300000, 10000 * 2 ** Math.min(pending.attempts - 1, 5));
            }
          });
          if (item.record) this.store.addAlertRecord?.({ ...item.record, status: 'failed', error: String(error.message || error) });
          if (item.attempts === 1) this.store.addEvent?.('error', `Telegram 通知暂未送达，已保留并自动重试：${error.message || error}`);
          break;
        }
      }
    } finally { this.running = false; this.changed(); }
  }
}

module.exports = { recipientKey, importantBranch, staleTargets, boundedOperation, NotificationOutbox };
