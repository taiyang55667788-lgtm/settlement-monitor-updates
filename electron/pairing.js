const { PairingNetwork } = require('./pairing-network');
const { PAIRING_SERVICE_URL, PAIRING_FALLBACK_URL } = require('./pairing-config');

class PairingClient {
  constructor(baseUrl = PAIRING_SERVICE_URL, network = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.network = network.fetch ? null : new PairingNetwork(this.baseUrl, undefined,
      this.baseUrl === PAIRING_SERVICE_URL ? [PAIRING_FALLBACK_URL] : []);
    this.fetch = network.fetch || ((...args) => this.network.fetch(...args));
  }

  get enabled() {
    return /^https:\/\//.test(this.baseUrl);
  }

  async request(method, path, token = '', body) {
    if (!this.enabled) throw new Error('配对服务正在准备中，请暂时使用下方高级设置');
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (this.network) throw error;
      throw new Error('无法连接 Telegram 配对服务，请检查网络后重试');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `配对服务请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  start() { return this.request('POST', '/v1/pairings'); }
  diagnose() { return this.network.diagnose(); }
  status(token) { return this.request('GET', '/v1/pairings/status', token); }
  test(token) { return this.request('POST', '/v1/messages/test', token); }
  send(token, text, { replyMarkup, notificationId, contentHash, createdAt } = {}) { return this.request('POST', '/v1/messages', token, { text, ...(notificationId ? { notificationId, contentHash, createdAt } : {}), ...(replyMarkup ? { replyMarkup } : {}) }); }
  async nextCommand(token) {
    const result = await this.request('GET', '/v1/commands/pending', token);
    if (!result || !Object.hasOwn(result, 'command') || (result.command !== null && typeof result.command !== 'string' && (typeof result.command !== 'object' || Array.isArray(result.command)))) {
      throw Object.assign(new Error('指令同步返回无效数据'), { status: 502 });
    }
    if (result.command !== null && !/^[0-9a-f-]{36}$/i.test(result.id || '')) throw Object.assign(new Error('指令确认协议尚未就绪'), { status: 502 });
    return result;
  }
  ackCommand(token, id, replyId, cancel = false) { return this.request('POST', '/v1/commands/ack', token, { id, replyId, ...(cancel ? { cancel: true } : {}) }); }
  unlink(token) { return this.request('DELETE', '/v1/pairings', token); }
}

module.exports = { PairingClient };
