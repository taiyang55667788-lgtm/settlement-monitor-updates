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

// Only a successfully validated, complete parent report can prove absence.
// Missing rows are not zero balances and must never participate in alerts.
function addNoDataTargets(agents, settings, refreshedParents, readAt) {
  const known = new Set(agents.map(agent => JSON.stringify(agent.path)));
  for (const setting of settings || []) {
    const path = setting.path || [setting.name];
    const missing = path.findIndex((_, index) => !known.has(JSON.stringify(path.slice(0, index + 1))));
    if (missing < 0 || !refreshedParents.has(JSON.stringify(path.slice(0, missing)))) continue;
    for (let depth = missing + 1; depth <= path.length; depth++) {
      const prefix = path.slice(0, depth);
      const key = JSON.stringify(prefix);
      if (known.has(key)) continue;
      agents.push({ name: prefix.at(-1), path: prefix, value: null, noData: true,
        readAt, stale: false, staleReason: '', notRefreshed: false });
      known.add(key);
      refreshedParents.add(key);
    }
  }
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
    this.acknowledged = new Set();
    this.health = { state: 'unknown', lastSuccessAt: '', lastFailureAt: '', error: '' };
  }
  enqueue(text, kind = 'operational', { record, commit } = {}) {
    const recipient = recipientKey(this.store.state.telegram);
    if (!recipient) throw new Error('请先绑定 Telegram');
    const item = { id: crypto.randomUUID(), recipient, text, kind, createdAt: new Date(this.now()).toISOString(), attempts: 0, nextAttemptAt: 0 };
    if (record) item.record = { ...record, eventId: item.id };
    this.store.update(data => {
      data.notificationOutbox ||= [];
      if (data.notificationOutbox.length >= 2000) throw new Error('通知待发队列已满，请恢复 Telegram 连接');
      data.notificationOutbox.push(item);
      data.notificationTimeline = [...(data.notificationTimeline || []), { at: item.createdAt, type: 'queued', notificationId: item.id, pending: data.notificationOutbox.length }].slice(-2000);
      commit?.(data, item);
    });
    this.changed();
    return { queued: true, queueId: item.id };
  }
  attach(receipt, record) {
    if (this.store.state.notificationOutbox?.find(item => item.id === receipt.queueId)?.record) return;
    this.store.update(data => {
      const item = data.notificationOutbox?.find(item => item.id === receipt.queueId);
      if (item) item.record = record;
    });
  }
  manage(id, action) {
    if (this.activeId === id) throw new Error('这条消息正在发送，请稍后操作');
    this.store.update(data => {
      const item = data.notificationOutbox?.find(entry => entry.id === id);
      if (!item) throw new Error('消息已发送或已取消，请刷新列表');
      if (action === 'retry') {
        if (item.recipient !== recipientKey(data.telegram)) throw new Error('收件人已变更，不能发给新收件人');
        item.nextAttemptAt = 0;
        if (item.confirmationRequired) {
          const originalId = item.id;
          item.id = crypto.randomUUID();
          item.originalNotificationId ||= originalId;
          item.confirmationRequired = false;
          item.error = '';
          item.attempts = 0;
          data.notificationTimeline = [...(data.notificationTimeline || []), { at: new Date(this.now()).toISOString(), type: 'confirmed-resend', notificationId: item.id, originalNotificationId: originalId, pending: data.notificationOutbox.length }].slice(-2000);
        }
      } else if (action === 'cancel') {
        data.notificationOutbox = data.notificationOutbox.filter(entry => entry.id !== id);
      } else throw new Error('无效队列操作');
    });
    this.store.addEvent?.('info', `通知 ${id.slice(0, 8)}：${action === 'retry' ? '已安排重试' : '用户已取消，档位记录保留'}`);
    this.changed();
  }
  async flush(requestedId) {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 10; i++) {
        const recipient = recipientKey(this.store.state.telegram);
        const item = this.store.state.notificationOutbox?.find(entry => entry.recipient === recipient
          && !entry.confirmationRequired
          && (!requestedId || entry.id === requestedId)
          && !(entry.kind === 'amount' && this.quiet()));
        if (!item || item.nextAttemptAt > this.now()) break;
        this.activeId = item.id;
        try {
          const delayed = item.attempts > 0 || this.now() - Date.parse(item.createdAt) > 60000;
          if (!this.acknowledged.has(item.id)) {
            const receipt = await this.send(item.text + `\n通知编号：${item.id}` + (item.originalNotificationId ? `\n原通知编号：${item.originalNotificationId}` : '') + (delayed ? `\n⏱ 延迟补发，原始时间：${item.createdAt}` : ''), {
              notificationId: item.id, contentHash: crypto.createHash('sha256').update(item.text).digest('hex'), createdAt: item.createdAt,
            });
            if (receipt?.notificationId && receipt.notificationId !== item.id) throw new Error('中转回执通知编号不匹配');
            this.receipts ||= new Map();
            this.receipts.set(item.id, receipt?.notificationId ? { notificationId: receipt.notificationId, receivedAt: receipt.receivedAt, confirmedAt: receipt.confirmedAt, telegramMessageId: receipt.telegramMessageId, deduplicated: Boolean(receipt.deduplicated) } : null);
            this.health = { ...this.health, state: 'ok', lastSuccessAt: new Date(this.now()).toISOString(), error: '' };
            this.acknowledged.add(item.id);
          }
          this.store.update(data => {
            data.notificationOutbox = data.notificationOutbox.filter(entry => entry.id !== item.id);
            data.notificationTimeline = [...(data.notificationTimeline || []), { at: new Date(this.now()).toISOString(), type: item.attempts ? 'recovered-send' : 'sent', notificationId: item.id, pending: data.notificationOutbox.length, attempts: item.attempts }].slice(-2000);
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
            if (record) data.alertRecords = [{ ...record, notificationId: item.id, originalNotificationId: item.originalNotificationId, relayReceipt: this.receipts?.get(item.id) || null, id: crypto.randomUUID(), time: new Date(this.now()).toISOString(), status: 'sent', queuedAt: item.createdAt }, ...(data.alertRecords || [])].slice(0, 500);
          });
          this.acknowledged.delete(item.id);
          this.receipts?.delete(item.id);
          if (requestedId) break;
        } catch (error) {
          if (this.acknowledged.has(item.id)) {
            // Retry only the local commit after an acknowledged send. A crash before
            // commit remains ambiguous, but a live process must not resend it.
            this.store.addEvent?.('error', `通知 ${item.id.slice(0, 8)} 已送达，本机保存失败；将重试保存：${error.message}`);
            break;
          }
          this.health = { ...this.health, state: 'failed', lastFailureAt: new Date(this.now()).toISOString(), error: String(error.message || error) };
          this.store.update(data => {
            const pending = data.notificationOutbox?.find(entry => entry.id === item.id);
            if (pending) {
              pending.attempts++;
              pending.error = String(error.message || error);
              pending.confirmationRequired = pending.error.includes('[SEND_UNCERTAIN]');
              pending.nextAttemptAt = this.now() + Math.min(300000, 10000 * 2 ** Math.min(pending.attempts - 1, 5));
              if (pending.attempts === 1 || pending.confirmationRequired) data.notificationTimeline = [...(data.notificationTimeline || []), { at: new Date(this.now()).toISOString(), type: pending.confirmationRequired ? 'uncertain' : 'send-failed', notificationId: pending.id, pending: data.notificationOutbox.length }].slice(-2000);
            }
          });
          if (item.record) this.store.addAlertRecord?.({ ...item.record, status: 'failed', error: String(error.message || error) });
          if (item.attempts === 1) this.store.addEvent?.('error', `Telegram 通知暂未送达，已保留并自动重试：${error.message || error}`);
          break;
        }
      }
    } finally { this.activeId = null; this.running = false; this.changed(); }
  }
}

module.exports = { recipientKey, importantBranch, addNoDataTargets, staleTargets, boundedOperation, NotificationOutbox };
