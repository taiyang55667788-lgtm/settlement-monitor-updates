const crypto = require('node:crypto');
const REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'];
const TYPES = ['Browser', 'Tab', 'Utility', 'GPU', 'Unknown'];
const EVENTS = ['session-start', 'previous-session-not-clean', 'unresponsive', 'responsive', 'renderer-gone', 'child-gone', 'rebuild', 'rebuild-failed', 'recovery-limited', 'ui-load-failed', 'clean-exit', 'ui-verified', 'verify-timeout', 'verify-renderer-exited', 'verify-unresponsive', 'verify-load-failed'];
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
function retainedHealth(value = {}, now = Date.now()) {
  return {
    session: value.session && typeof value.session.id === 'string' && /^[a-f0-9-]{36}$/.test(value.session.id) ? {
      id: value.session.id, startedAt: Number.isFinite(Date.parse(value.session.startedAt)) ? new Date(value.session.startedAt).toISOString() : '',
      cleanExit: value.session.cleanExit === true,
    } : null,
    events: (Array.isArray(value.events) ? value.events : []).filter(x => x && EVENTS.includes(x.type) && now - Date.parse(x.at) >= 0 && now - Date.parse(x.at) < 7 * 86400000).slice(-100).map(x => ({
      at: new Date(x.at).toISOString(), type: x.type,
      reason: REASONS.includes(x.reason) ? x.reason : '', exitCode: Number.isInteger(x.exitCode) ? x.exitCode : null,
      processType: TYPES.includes(x.processType) ? x.processType : 'Unknown',
    })),
    samples: (Array.isArray(value.samples) ? value.samples : []).filter(x => x && now - Date.parse(x.at) >= 0 && now - Date.parse(x.at) < 86400000).slice(-120).map(x => ({
      at: new Date(x.at).toISOString(), mainRssBytes: finite(x.mainRssBytes),
      processes: (Array.isArray(x.processes) ? x.processes : []).slice(0, 16).map(p => ({
        type: TYPES.includes(p.type) ? p.type : 'Unknown', workingSetSize: finite(p.workingSetSize),
        cpuPercent: finite(p.cpuPercent),
      })),
    })),
  };
}

class DesktopHealth {
  constructor({ store, metrics = () => [], memory = () => process.memoryUsage(), rebuild, quitting = () => false, now = Date.now, schedule = setTimeout, cancel = clearTimeout, verificationTimeoutMs = 20000, verified = () => {}, verificationFailed = () => {} }) {
    Object.assign(this, { store, metrics, memory, rebuild, quitting, now, schedule, cancel, verificationTimeoutMs, verified, verificationFailed });
    this.data = retainedHealth(store.state.desktopDiagnostics, now());
    this.recoveries = []; this.lastSampleAt = -Infinity; this.timer = null; this.stopped = false; this.persistenceError = false;
  }
  persist() {
    this.data = retainedHealth(this.data, this.now());
    try { this.store.update(data => { data.desktopDiagnostics = structuredClone(this.data); }); this.persistenceError = false; }
    catch { this.persistenceError = true; }
  }
  record(type, details = {}) {
    this.data.events.push({ at: new Date(this.now()).toISOString(), type, reason: details.reason, exitCode: details.exitCode, processType: details.type });
    this.persist();
  }
  start() {
    this.previousUnclean = Boolean(this.data.session && !this.data.session.cleanExit);
    if (this.previousUnclean) this.record('previous-session-not-clean');
    this.data.session = { id: crypto.randomUUID(), startedAt: new Date(this.now()).toISOString(), cleanExit: false };
    this.record('session-start'); this.sample();
  }
  sample() {
    if (this.stopped || this.now() - this.lastSampleAt < 60000) return;
    this.lastSampleAt = this.now();
    try {
      this.data.samples.push({ at: new Date(this.now()).toISOString(), mainRssBytes: this.memory().rss,
        processes: this.metrics().slice(0, 16).map(p => ({ type: p.type, workingSetSize: p.memory?.workingSetSize, cpuPercent: p.cpu?.percentCPUUsage })) });
      this.persist();
    } catch { /* Metrics availability must not affect monitoring. */ }
  }
  attach(win) {
    this.clearVerification();
    this.current = win;
    if (this.verificationTimeoutMs > 0) {
      this.pending = { win, token: crypto.randomUUID(), loaded: false, stateServed: false, acknowledged: false };
      this.verificationTimer = this.schedule(() => this.failVerification('verify-timeout'), this.verificationTimeoutMs);
    }
    win.webContents.on('did-finish-load', () => {
      if (this.pending?.win !== win) return;
      this.pending.loaded = true; this.finishVerification();
    });
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (this.pending?.win === win && isMainFrame && code !== -3) this.failVerification('verify-load-failed');
    });
    win.on('unresponsive', () => {
      if (win !== this.current || this.stopped || this.quitting()) return;
      this.record('unresponsive');
      if (this.pending?.win === win) this.failVerification('verify-unresponsive'); else this.recover(false);
    });
    win.on('responsive', () => {
      if (win !== this.current || this.stopped) return;
      this.record('responsive'); if (this.timer !== null) this.cancel(this.timer); this.timer = null;
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (win !== this.current || this.stopped || this.quitting()) return;
      this.record('renderer-gone', details);
      if (this.pending?.win === win) this.failVerification('verify-renderer-exited'); else this.recover(false);
    });
  }
  clearVerification() {
    if (this.verificationTimer !== undefined) this.cancel(this.verificationTimer);
    this.verificationTimer = undefined; this.pending = null;
  }
  challenge(contents) { return this.pending?.win?.webContents === contents ? this.pending.token : ''; }
  stateServed(contents) {
    if (this.pending?.win?.webContents !== contents) return;
    this.pending.stateServed = true; this.finishVerification();
  }
  acknowledge(contents, token) {
    if (!this.pending || this.pending.win.webContents !== contents || typeof token !== 'string' || token !== this.pending.token || !this.pending.stateServed) return false;
    this.pending.acknowledged = true; this.finishVerification(); return true;
  }
  finishVerification() {
    if (!this.pending?.loaded || !this.pending.stateServed || !this.pending.acknowledged || this.stopped || this.quitting()) return;
    this.clearVerification(); this.autoBlocked = false; this.record('ui-verified'); this.verified();
  }
  failVerification(type) {
    if (!this.pending || this.stopped || this.quitting()) return;
    this.clearVerification(); this.autoBlocked = true;
    if (this.timer !== null) this.cancel(this.timer); this.timer = null;
    this.record(type); this.verificationFailed();
  }
  childGone(details) {
    if (this.stopped || this.quitting()) return;
    this.record('child-gone', details);
    if (details.type === 'GPU' && details.reason !== 'clean-exit') this.recover(false);
  }
  recover(manual = true) {
    if (this.stopped || this.quitting() || this.timer !== null || this.pending || (!manual && this.autoBlocked)) return;
    this.recoveries = this.recoveries.filter(at => this.now() - at < 10 * 60000);
    if (!manual && this.recoveries.length >= 2) { this.record('recovery-limited'); return; }
    const previous = this.current;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.stopped || this.quitting() || previous !== this.current) return;
      this.recoveries.push(this.now()); this.record('rebuild');
      try { this.rebuild(previous); } catch {
        this.clearVerification(); this.autoBlocked = true; this.record('rebuild-failed'); this.verificationFailed();
      }
    }, manual ? 0 : 1500);
  }
  end() {
    this.stop(); if (this.data.session) this.data.session.cleanExit = true;
    this.record('clean-exit');
  }
  stop() { this.stopped = true; if (this.timer !== null) this.cancel(this.timer); this.timer = null; this.clearVerification(); }
  snapshot() { return { ...retainedHealth(this.data, this.now()), persistenceError: this.persistenceError, verification: { pending: Boolean(this.pending), loaded: Boolean(this.pending?.loaded), stateServed: Boolean(this.pending?.stateServed), acknowledged: Boolean(this.pending?.acknowledged), automaticPaused: Boolean(this.autoBlocked) }, recoveryLimit: '2 automatic rebuilds per 10 minutes', memoryUnit: 'Electron workingSetSize as reported; mainRssBytes in bytes' }; }
  summary() {
    const recovered = this.data.events.some(x => x.type === 'rebuild' && Date.parse(x.at) >= Date.parse(this.data.session?.startedAt || ''));
    return { readyToken: this.challenge(this.current?.webContents), warning: this.persistenceError ? '桌面诊断保存失败，请检查磁盘空间或权限'
      : this.autoBlocked ? '主界面未确认恢复，自动重建已暂停；可使用原生界面菜单手动重建或文件菜单保存退出'
      : this.pending ? '正在验证主界面加载与状态显示，监控未因此重新启动'
      : recovered ? '主界面已通过加载与状态显示校验；监控未因此重新启动'
        : this.previousUnclean ? '上次未记录正常退出，具体原因尚未确认；可导出诊断检查' : '' };
  }
}
module.exports = { DesktopHealth, retainedHealth };
