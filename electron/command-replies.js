const crypto = require('node:crypto');
const { recipientKey } = require('./reliability');

// At most one frozen reply per recipient, ten held recipients total. No polling timer.
class CommandReplies {
  constructor(store, client) { this.store = store; this.client = client; }
  current() {
    const key = recipientKey(this.store.state.telegram);
    return (this.store.state.commandReplies || []).find(item => item.recipient === key);
  }
  prepare(commandId, text, replyMarkup) {
    const recipient = recipientKey(this.store.state.telegram);
    if (!recipient || !/^[0-9a-f-]{36}$/i.test(commandId)) throw Error('无效指令编号');
    if (Buffer.byteLength(JSON.stringify(replyMarkup || null)) > 8192) throw Error('查询按钮超出大小限制');
    const existing = this.current();
    if (existing) { if (existing.commandId !== commandId) throw Error('上一条指令尚未确认'); return; }
    this.store.update(data => {
      data.commandReplies ||= [];
      if (data.commandReplies.length >= 10) throw Error('待确认指令已达上限，请先处理原设备指令');
      data.commandReplies.push({ commandId, replyId: commandId, recipient, text: String(text).slice(0, 3500), replyMarkup,
        createdAt: new Date().toISOString(), stage: 'prepared', confirmationRequired: false });
    });
  }
  update(work, change) {
    this.store.update(data => {
      const item = data.commandReplies?.find(item => item.recipient === work.recipient && item.commandId === work.commandId);
      if (!item) throw Error('待确认指令已变化');
      change(item);
    });
  }
  async resume(token) {
    let work = this.current();
    if (!work) return false;
    const recipient = work.recipient;
    if (recipientKey({ mode: 'pairing', pairing: { paired: true, token } }) !== recipient) throw Error('指令凭据已变更，原回复暂存');
    const assertRecipient = () => { if (recipientKey(this.store.state.telegram) !== recipient) throw Error('收件人已变更，原指令暂存'); };
    if (work.confirmationRequired) throw Object.assign(Error('查询回复发送结果待人工确认'), { code: 'COMMAND_CONFIRMATION_REQUIRED' });
    if (work.stage === 'prepared') {
      try {
        const receipt = await this.client.send(token, work.text, { replyMarkup: work.replyMarkup, notificationId: work.replyId,
          contentHash: crypto.createHash('sha256').update(work.text).digest('hex'), createdAt: work.createdAt });
        if (receipt?.notificationId !== work.replyId) throw Error('查询回复回执编号不匹配');
      } catch (error) {
        if (String(error.message).includes('[SEND_UNCERTAIN]')) {
          this.update(work, item => { item.confirmationRequired = true; });
          throw Object.assign(Error('查询回复发送结果待人工确认'), { code: 'COMMAND_CONFIRMATION_REQUIRED' });
        }
        throw error;
      }
      // If this write fails, the same reply id and frozen body are retried server-side.
      this.update(work, item => { item.stage = 'sent'; });
      work = this.current();
      assertRecipient();
    }
    assertRecipient();
    await this.client.ackCommand(token, work.commandId, work.replyId, work.stage === 'cancelled');
    this.store.update(data => { data.commandReplies = (data.commandReplies || []).filter(item => !(item.recipient === recipient && item.commandId === work.commandId)); });
    return true;
  }
  manage(action) {
    const work = this.current();
    if (!work || !work.confirmationRequired) throw Error('没有需要人工确认的查询回复');
    this.update(work, item => {
      if (action === 'resend') { item.replyId = crypto.randomUUID(); item.stage = 'prepared'; }
      else if (action === 'cancel') item.stage = 'cancelled';
      else throw Error('无效指令操作');
      item.confirmationRequired = false;
    });
  }
}
module.exports = { CommandReplies };
