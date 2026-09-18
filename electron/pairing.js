const { net } = require('electron');
const { PAIRING_SERVICE_URL } = require('./pairing-config');

class PairingClient {
  constructor(baseUrl = PAIRING_SERVICE_URL, network = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.fetch = network.fetch || ((...args) => net.fetch(...args));
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
    } catch {
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
  status(token) { return this.request('GET', '/v1/pairings/status', token); }
  test(token) { return this.request('POST', '/v1/messages/test', token); }
  send(token, text) { return this.request('POST', '/v1/messages', token, { text }); }
  unlink(token) { return this.request('DELETE', '/v1/pairings', token); }
}

module.exports = { PairingClient };
