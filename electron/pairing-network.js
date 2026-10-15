const { session } = require('electron');

function networkErrorCode(error) {
  const values = [error?.cause?.code, error?.code, String(error?.message || '').match(/\b(ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/)?.[1], error?.name];
  return values.find(value => value && /^(ERR_[A-Z_]+|[A-Z][A-Z_]+|TimeoutError|AbortError)$/.test(value)) || 'NETWORK_ERROR';
}

class PairingNetwork {
  constructor(baseUrl, createSession = name => session.fromPartition(name), fallbacks = []) {
    this.baseUrl = baseUrl;
    this.endpoints = [baseUrl, ...fallbacks];
    this.activeBase = baseUrl;
    this.createSession = createSession;
    this.sessions = new Map();
    this.route = 'system';
    this.lastProbeAt = 0;
    this.timeline = [];
  }

  async connection(mode) {
    if (!this.sessions.has(mode)) {
      const ready = (async () => {
        const ses = this.createSession(`settlement-notification-${mode}`);
        await ses.setProxy({ mode });
        return ses;
      })();
      this.sessions.set(mode, ready);
      ready.catch(() => this.sessions.delete(mode));
    }
    return this.sessions.get(mode);
  }

  async probe(mode, baseUrl = this.baseUrl) {
    let proxyActive = null;
    try {
      const ses = await this.connection(mode);
      if (mode === 'system') await ses.forceReloadProxyConfig();
      const proxy = await ses.resolveProxy(baseUrl).catch(() => 'UNKNOWN');
      proxyActive = proxy === 'UNKNOWN' ? null : !/^DIRECT$/i.test(proxy);
      const health = new URL(baseUrl).hostname === 'settlement-connectivity-test.pages.dev' ? '/relay/health' : '/health';
      const response = await ses.fetch(`${baseUrl}${health}`, {
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json();
      return { mode, ok: response.ok && payload?.ok === true && payload?.ready === true,
        proxyActive,
        code: response.ok ? (payload?.ready ? '' : 'SERVICE_NOT_READY') : `HTTP_${response.status}` };
    } catch (error) {
      // Never expose URLs, credentials, PAC addresses or arbitrary response text.
      const code = networkErrorCode(error);
      return { mode, ok: false, code, proxyActive };
    }
  }

  async diagnose() {
    if (this.diagnosing) return this.diagnosing;
    this.diagnosing = this.runDiagnosis();
    try { return await this.diagnosing; }
    finally { this.diagnosing = null; }
  }

  async runDiagnosis() {
    const probes = await Promise.all(this.endpoints.map(async base => {
      const [direct, system] = await Promise.all([this.probe('direct', base), this.probe('system', base)]);
      return { base, direct, system };
    }));
    const selected = probes.find(p => p.direct.ok) || probes.find(p => p.system.ok) || probes[0];
    const { direct, system } = selected;
    if (direct.ok || system.ok) this.activeBase = selected.base;
    this.lastProbeAt = Date.now();
    if (direct.ok) this.route = 'direct';
    else if (system.ok) this.route = 'system';
    const describe = result => result.ok ? '可用' : `失败（${result.code || '服务未就绪'}）`;
    const result = { direct, system, route: this.route, endpoint: this.activeBase === this.baseUrl ? 'primary' : 'fallback', checkedAt: new Date().toISOString(),
      available: probes.some(p => p.direct.ok || p.system.ok),
      candidates: probes.map(p => ({ endpoint: p.base === this.baseUrl ? 'primary' : 'fallback', direct: p.direct, system: p.system })),
      message: `中转直连：${describe(direct)}；系统代理线路：${describe(system)}。`
        + (direct.ok ? '已选择独立直连；此结果只代表本机当前网络。'
          : system.ok ? '已选择系统代理线路；当前中转入口尚不能在本机直连。'
            : '两条线路均失败；请检查系统代理是否残留或中转服务是否可达，不能据此断定网站故障。')
        + (system.code === 'ERR_PROXY_CONNECTION_FAILED' ? '系统线路报告代理连接失败，可能是代理程序已退出但设置仍残留。' : '') };
    const previous = this.lastDiagnosis;
    if (!previous || previous.available !== result.available || previous.endpoint !== result.endpoint || previous.route !== result.route) {
      const entry = { at: result.checkedAt, type: !result.available ? 'disconnected' : previous?.available === false ? 'reconnected' : 'route-selected', endpoint: result.endpoint, route: result.route, available: result.available, candidates: result.candidates, failureAt: this.lastFailure?.at || '', failureCode: this.lastFailure?.code || '', notificationId: this.lastFailure?.notificationId || '' };
      this.timeline = [...this.timeline, entry].slice(-300);
      try { this.onTransition?.(entry); } catch {}
    }
    this.lastDiagnosis = result;
    return result;
  }

  async fetch(url, init) {
    try {
      if ((this.endpoints.length > 1 && !this.lastProbeAt) || (this.lastDiagnosis?.available === false && Date.now() - this.lastProbeAt >= 15000)) await this.diagnose();
      const ses = await this.connection(this.route);
      const target = new URL(url);
      if (target.origin !== new URL(this.baseUrl).origin) throw new Error('Invalid relay origin');
      const response = await ses.fetch(this.activeBase + target.pathname + target.search, { ...init, redirect: 'error', credentials: 'omit' });
      if (response.status >= 500 && Date.now() - this.lastProbeAt >= 15000) await this.diagnose();
      return response;
    } catch (error) {
      let detail = '';
      this.lastFailure = { at: new Date().toISOString(), code: networkErrorCode(error), route: this.route, endpoint: this.activeBase === this.baseUrl ? 'primary' : 'fallback' };
      try {
        const id = JSON.parse(init?.body || '{}').notificationId;
        if (/^[0-9a-f-]{36}$/i.test(id || '')) this.lastFailure.notificationId = id;
      } catch {}
      if (Date.now() - this.lastProbeAt >= 15000) detail = (await this.diagnose()).message;
      // Do not replay POSTs or consuming GET /commands/next after ambiguous failures.
      throw new Error(`无法连接 Telegram 配对服务（${this.lastFailure.code}）；${detail || '连接检测暂缓，稍后自动重试。'}原请求未立即重发，待后续正常重试。`);
    }
  }
}

module.exports = { PairingNetwork };
