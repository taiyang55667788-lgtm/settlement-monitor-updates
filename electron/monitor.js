const path = require('node:path');
const { BrowserWindow, session, nativeImage, net } = require('electron');
const { createWorker, PSM } = require('tesseract.js');
const { splitReportRows, parseSettlementTable, alertTransition, legacyAlertStep, applySubagentAlertSteps, evaluateSubagentAlertLevels } = require('./report-parser');
const {
  partitionForAccount,
  isRedirectAbort,
  isTransientScriptError,
  selectFastestRoute,
  loginSubmissionScript,
  loginPrefillScript,
  selectCaptchaCandidate,
  isCredentialFailure,
  loginFailureScript,
} = require('./navigation');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function captchaOcrVariants(image) {
  const size = image.getSize();
  const width = Math.max(180, size.width * 4);
  const height = Math.max(72, size.height * 4);
  const enlarged = image.resize({ width, height, quality: 'best' });
  const variants = [enlarged.toPNG()];
  const bitmap = enlarged.toBitmap();
  for (const inverted of [false, true]) {
    const processed = Buffer.from(bitmap);
    for (let offset = 0; offset + 3 < processed.length; offset += 4) {
      const brightness = (processed[offset] + processed[offset + 1] + processed[offset + 2]) / 3;
      const blackOrWhite = brightness < 165 ? 0 : 255;
      const value = inverted ? 255 - blackOrWhite : blackOrWhite;
      processed[offset] = value;
      processed[offset + 1] = value;
      processed[offset + 2] = value;
    }
    variants.push(nativeImage.createFromBitmap(processed, { width, height, scaleFactor: 1 }).toPNG());
  }
  return variants;
}

function jsString(value) {
  return JSON.stringify(String(value));
}

async function waitUntil(win, test, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${test})`, true)) return true;
    } catch (error) {
      if (!isTransientScriptError(error)) lastError = error;
    }
    await sleep(400);
  }
  if (lastError) throw lastError;
  return false;
}

async function executePageAction(win, script) {
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (error) {
    if (isTransientScriptError(error)) return undefined;
    if (/Script failed to execute/i.test(error?.message || '') && win.webContents.isLoading()) return undefined;
    throw error;
  }
}

function liveFrames(win) {
  const mainFrame = win.webContents.mainFrame;
  return (mainFrame?.framesInSubtree || [mainFrame]).filter((frame) => frame && !frame.isDestroyed());
}

async function executeInFrames(win, script, accept = Boolean) {
  for (const frame of liveFrames(win)) {
    try {
      const result = await frame.executeJavaScript(script, true);
      if (accept(result)) return result;
    } catch (error) {
      if (!isTransientScriptError(error) && !frame.isDestroyed()) throw error;
    }
  }
  return undefined;
}

async function waitUntilAnyFrame(win, test, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await executeInFrames(win, `Boolean(${test})`).catch(() => false);
    if (found) return true;
    await sleep(400);
  }
  return false;
}

async function load(win, url) {
  try {
    await win.loadURL(url);
  } catch (error) {
    if (!isRedirectAbort(error)) throw error;
    await new Promise((resolve) => {
      if (!win.webContents.isLoading()) return resolve();
      const timer = setTimeout(resolve, 12000);
      win.webContents.once('did-stop-loading', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const finalUrl = win.webContents.getURL();
    if (!/^https?:\/\//i.test(finalUrl)) throw error;
  }
  await sleep(350);
}

class SiteClient {
  constructor(account, status) {
    this.account = account;
    this.status = status;
    this.window = null;
    this.ocr = null;
  }

  async open() {
    const partition = partitionForAccount(this.account.id);
    this.window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(({ url }) => ({ action: 'deny' }));
  }

  async discoverAgentUrl() {
    this.status.stage = '正在打开导航网址';
    await load(this.window, this.account.navUrl);
    this.status.stage = '正在填写安全码';
    const inputFound = await waitUntil(this.window, `document.querySelectorAll('input').length > 0`, 12000);
    if (!inputFound) throw new Error('导航页没有找到安全码输入框');
    await executePageAction(this.window, `(() => {
      const input = [...document.querySelectorAll('input')].find(el => !['button','submit','hidden'].includes(el.type));
      if (!input) throw new Error('没有安全码输入框');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${jsString(this.account.securityCode)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const controls = [...document.querySelectorAll('button, input[type=submit], a')];
      const submit = controls.find(el => /搜索一下|进入|提交|确定/.test(el.innerText || el.value || ''));
      if (!submit) throw new Error('没有安全码提交按钮');
      submit.click();
    })()`, true);
    const routeReady = await waitUntil(this.window, `/线路选择|代理线路/.test(document.body.innerText)`, 15000);
    if (!routeReady) throw new Error('安全码未通过或线路页加载超时');
    await waitUntil(this.window, `[...document.querySelectorAll('tr')].some(row => /代理线路/.test(row.innerText) && /\\d+\\s*ms/i.test(row.innerText))`, 15000);
    const routeRows = await this.window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('tr')]
      .filter(row => /代理线路/.test(row.innerText))
      .map(row => ({ text: (row.querySelector('a')?.innerText || '').trim(), label: row.innerText })))()`, true);
    const { routes, selected } = selectFastestRoute(routeRows);
    if (!selected?.text) throw new Error('线路页没有可用的代理网址');
    this.status.routes = routes;
    this.status.routeSpeed = selected.speed < 99999 ? selected.speed : null;
    this.status.routeHost = new URL(selected.text).host;
    this.status.stage = `已选择最快线路 ${this.status.routeSpeed ?? '—'}ms`;
    return selected.text;
  }

  async isLoggedIn() {
    return this.window.webContents.executeJavaScript(`/报表查询/.test(document.body.innerText) && !/管理员登录/.test(document.body.innerText)`, true);
  }

  async readCaptcha() {
    const info = await this.window.webContents.executeJavaScript(`(() => {
      const images = [...document.images];
      const sized = img => {
        const r = img.getBoundingClientRect();
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80;
      };
      const image = images.find(img => sized(img) && /captcha|verify|checkcode|validcode/i.test([img.src, img.id, img.className, img.alt].join(' ')))
        || images.find(img => {
        const r = img.getBoundingClientRect();
        const context = img.closest('li, tr, div')?.innerText || '';
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80 && /验证码/.test(context);
      }) || images.find(sized);
      if (!image) return null;
      const r = image.getBoundingClientRect();
      const inputs = [...document.querySelectorAll('input')].filter(el => !['button','submit','hidden','password'].includes(el.type));
      const hint = el => [el.name, el.id, el.placeholder].filter(Boolean).join(' ').toLowerCase();
      const captchaInput = inputs.find(el => /captcha|verify|checkcode|验证码/.test(hint(el))) || inputs[inputs.length - 1];
      const expectedLength = Number(captchaInput?.maxLength);
      return {
        rect: { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) },
        expectedLength: expectedLength >= 4 && expectedLength <= 6 ? expectedLength : 0,
      };
    })()`, true);
    if (!info?.rect) throw new Error('找不到验证码图片');
    const image = await this.window.webContents.capturePage(info.rect);
    if (!this.ocr) {
      const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
      this.ocr = await createWorker('eng', 1, { langPath, gzip: true, logger: () => {} });
      await this.ocr.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_WORD });
    }
    const candidates = [];
    for (const variant of captchaOcrVariants(image)) {
      const result = await this.ocr.recognize(variant);
      candidates.push({ text: result.data.text, confidence: result.data.confidence });
    }
    return selectCaptchaCandidate(candidates, info.expectedLength);
  }

  async refreshCaptcha() {
    await executePageAction(this.window, `(() => {
      const images = [...document.images];
      const sized = img => {
        const r = img.getBoundingClientRect();
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80;
      };
      const image = images.find(img => sized(img) && /captcha|verify|checkcode|validcode/i.test([img.src, img.id, img.className, img.alt].join(' ')))
        || images.find(img => sized(img) && /验证码/.test(img.closest('li, tr, div')?.innerText || ''))
        || images.find(sized);
      image?.click();
    })()`);
    await sleep(800);
  }

  async readLoginFailure() {
    return this.window.webContents.executeJavaScript(loginFailureScript(), true).catch(() => '');
  }

  async waitForLoginOutcome(timeoutMs = 10000, ignoredFailure = '') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isLoggedIn().catch(() => false)) return { loggedIn: true, failure: '' };
      const failure = await this.readLoginFailure();
      if (failure && failure !== ignoredFailure) return { loggedIn: false, failure };
      await sleep(350);
    }
    return { loggedIn: false, failure: '' };
  }

  async login(agentUrl) {
    this.status.stage = '正在打开代理登录页';
    await load(this.window, agentUrl);
    if (await this.isLoggedIn()) {
      this.status.stage = '登录状态有效';
      return;
    }
    const formReady = await waitUntil(this.window, `document.querySelectorAll('input').length >= 3`, 12000);
    if (!formReady) throw new Error('代理登录页加载失败');
    let lastFailure = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.status.stage = `正在识别验证码（第 ${attempt}/3 次）`;
      const captcha = await this.readCaptcha();
      if (captcha.length < 4) {
        lastFailure = '验证码图片无法识别';
        await this.refreshCaptcha();
        continue;
      }
      const baselineFailure = await this.readLoginFailure();
      await executePageAction(this.window, loginSubmissionScript(this.account.username, this.account.password, captcha));
      const outcome = await this.waitForLoginOutcome(10000, baselineFailure);
      if (outcome.loggedIn) {
        this.status.stage = '账号登录成功';
        return;
      }
      lastFailure = outcome.failure || '网站未进入报表页面';
      if (isCredentialFailure(lastFailure)) throw new Error(`网站提示：${lastFailure}`);
      this.status.stage = `验证码未通过，正在更换（第 ${attempt}/3 次）`;
      await this.refreshCaptcha();
    }
    throw new Error(`验证码自动识别连续三次未通过${lastFailure ? `（${lastFailure}）` : ''}；请点击“盘内查看”手动输入验证码并登录`);
  }

  async reportUrl() {
    const href = await this.window.webContents.executeJavaScript(`(() => {
      const link = [...document.querySelectorAll('a')].find(el => /报表查询/.test(el.innerText));
      return link?.href || '';
    })()`, true);
    if (!href) throw new Error('登录后没有找到报表查询入口');
    return href;
  }

  async readThisWeekSettlement() {
    let agentUrl = this.status.agentUrl;
    if (!agentUrl) agentUrl = await this.discoverAgentUrl();
    this.status.agentUrl = agentUrl;
    try {
      await this.login(agentUrl);
    } catch (error) {
      agentUrl = await this.discoverAgentUrl();
      this.status.agentUrl = agentUrl;
      await this.login(agentUrl);
    }
    this.status.stage = '正在打开报表查询';
    await executePageAction(this.window, `(() => {
      const link = [...document.querySelectorAll('a')].find(el => /报表查询/.test(el.innerText));
      if (!link) throw new Error('登录后没有找到报表查询入口');
      const frame = document.querySelector('iframe#frame, iframe[name=frame]');
      if (frame) frame.src = link.href;
      else link.click();
    })()`);
    const reportReady = await waitUntilAnyFrame(
      this.window,
      `[...document.querySelectorAll('button, input, a')].some(el => /本星期/.test(el.innerText || el.value || ''))`,
      15000,
    );
    if (!reportReady) throw new Error('报表查询页面加载超时');
    this.status.stage = '正在查询本周报表';
    const weekSelected = await executeInFrames(this.window, `(() => {
      const control = [...document.querySelectorAll('button, input, a')]
        .find(el => /本星期/.test(el.innerText || el.value || ''));
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!weekSelected) throw new Error('没有本星期按钮');
    await sleep(250);
    const querySubmitted = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const control = [...document.querySelectorAll('button, input, a')]
        .find(el => compact(el.innerText || el.value) === '查询');
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!querySubmitted) throw new Error('没有查询按钮');
    const ready = await waitUntilAnyFrame(this.window, `[...document.querySelectorAll('tr')].some(row => /合计/.test(row.innerText))`, 15000);
    if (!ready) throw new Error('本周报表加载超时');
    const rawRows = await executeInFrames(this.window, `(() => {
      const tables = [...document.querySelectorAll('table')];
      const table = tables.find(t => /交收|上级交收/.test(t.innerText) && /合计/.test(t.innerText))
        || tables.sort((a,b) => b.querySelectorAll('td').length - a.querySelectorAll('td').length)[0];
      if (!table) return null;
      const rows = [...table.querySelectorAll('tr')];
      return rows.map(row => [...row.cells].map(cell => ({
        text: cell.innerText,
        colspan: cell.colSpan,
        rowspan: cell.rowSpan,
      })));
    })()`, Array.isArray);
    if (!rawRows) throw new Error('没有报表表格');
    this.status.stage = '本周报表读取成功';
    return parseSettlementTable(splitReportRows(rawRows));
  }

  async close() {
    if (this.ocr) await this.ocr.terminate().catch(() => {});
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

class MonitorService {
  constructor(store, onChange, network = {}) {
    this.store = store;
    this.onChange = onChange;
    this.telegramFetch = network.fetch || ((...args) => net.fetch(...args));
    this.resolveTelegramProxy = network.resolveProxy || ((url) => session.defaultSession.resolveProxy(url));
    this.runtime = new Map();
    this.inFlight = new Set();
    this.revisions = new Map();
    this.resetRequested = new Set();
    this.rerunRequested = new Set();
    this.viewWindows = new Map();
    this.openingViews = new Set();
    this.timer = null;
  }

  async telegramRequest(botToken, method, init = {}) {
    const token = String(botToken || '').trim();
    if (!token) throw new Error('请先填写 Bot Token');
    try {
      return await this.telegramFetch(`https://api.telegram.org/bot${token}/${method}`, {
        ...init,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      let proxy = '';
      try {
        proxy = String(await this.resolveTelegramProxy('https://api.telegram.org') || '');
      } catch {}
      const proxyHint = !proxy || /^DIRECT$/i.test(proxy)
        ? '当前为网络直连；如果服务器无法访问 Telegram，请在 Clash Verge 开启“系统代理”后重试'
        : `已使用 Windows 系统代理（${proxy}），请确认代理程序正在运行`;
      const code = error?.cause?.code || error?.code;
      throw new Error(`Telegram 网络连接失败：${proxyHint}${code ? `（${code}）` : ''}`);
    }
  }

  async telegramJson(botToken, method, init = {}) {
    const response = await this.telegramRequest(botToken, method, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const description = String(payload?.description || '').trim();
      throw new Error(`Telegram 请求失败（${response.status}）${description ? `：${description}` : ''}`);
    }
    return payload;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 10000);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const windows = [...this.viewWindows.values()];
    this.viewWindows.clear();
    this.openingViews.clear();
    for (const win of windows) {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async openAccountView(accountId) {
    const account = this.store.state.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('账号不存在');
    const existing = this.viewWindows.get(accountId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    if (this.inFlight.has(accountId)) throw new Error('账号正在自动检查，请等待本次检查完成后再打开盘内查看');
    if (this.openingViews.has(accountId)) throw new Error('正在打开盘内查看，请稍候');
    const viewRevision = this.revisions.get(accountId) || 0;
    this.openingViews.add(accountId);
    try {
      const status = this.status(accountId);
      let targetUrl = status.agentUrl;
      if (!targetUrl) {
        const resolver = new SiteClient(structuredClone(account), status);
        try {
          await resolver.open();
          targetUrl = await resolver.discoverAgentUrl();
          status.agentUrl = targetUrl;
        } finally {
          await resolver.close();
        }
      }
      if (!this.store.state.accounts.some((item) => item.id === accountId) || (this.revisions.get(accountId) || 0) !== viewRevision) {
        throw new Error('账号配置已经变化，请重新打开盘内查看');
      }
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        title: `${account.name} - 盘内查看`,
        webPreferences: {
          partition: partitionForAccount(accountId),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.viewWindows.set(accountId, win);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => {
        const wasCurrent = this.viewWindows.get(accountId) === win;
        if (wasCurrent) this.viewWindows.delete(accountId);
        const current = this.store.state.accounts.find((item) => item.id === accountId);
        if (wasCurrent && current?.enabled) setImmediate(() => void this.check(accountId));
      });
      try {
        await load(win, targetUrl);
        if (!await win.webContents.executeJavaScript(`/报表查询/.test(document.body.innerText) && !/管理员登录/.test(document.body.innerText)`, true)) {
          const ready = await waitUntil(win, `document.querySelectorAll('input').length >= 3`, 12000);
          if (!ready) throw new Error('盘内登录页加载失败');
          await executePageAction(win, loginPrefillScript(account.username, account.password));
        }
        win.show();
        win.focus();
        status.stage = '盘内查看已打开；可手动输入验证码';
        this.onChange();
      } catch (error) {
        this.viewWindows.delete(accountId);
        if (!win.isDestroyed()) win.destroy();
        throw error;
      }
    } finally {
      this.openingViews.delete(accountId);
    }
  }

  status(accountId) {
    if (!this.runtime.has(accountId)) {
      this.runtime.set(accountId, { status: 'waiting', subagentAlertLevels: {}, subagents: [] });
    }
    return this.runtime.get(accountId);
  }

  updateSubagentAlertStep(accountId, name, alertStep) {
    const status = this.status(accountId);
    const subagent = status.subagents?.find((item) => item.name === name);
    if (subagent) Object.assign(subagent, { alertStep, customized: true });
    delete status.subagentAlertLevels[Buffer.from(name).toString('base64url')];
  }

  async clearAccountSession(accountId) {
    const partition = partitionForAccount(accountId);
    await session.fromPartition(partition).clearStorageData();
  }

  async invalidateAccount(accountId) {
    const view = this.viewWindows.get(accountId);
    this.viewWindows.delete(accountId);
    this.openingViews.delete(accountId);
    if (view && !view.isDestroyed()) view.destroy();
    this.revisions.set(accountId, (this.revisions.get(accountId) || 0) + 1);
    if (this.inFlight.has(accountId)) {
      this.resetRequested.add(accountId);
      return;
    }
    await this.clearAccountSession(accountId).catch(() => {});
    this.runtime.delete(accountId);
  }

  requestRecheck(accountId) {
    this.revisions.set(accountId, (this.revisions.get(accountId) || 0) + 1);
    if (this.inFlight.has(accountId)) {
      this.rerunRequested.add(accountId);
      return;
    }
    const current = this.store.state.accounts.find((item) => item.id === accountId);
    if (current?.enabled) setImmediate(() => void this.check(accountId));
  }

  isCurrentCheck(accountId, revision) {
    const current = this.store.state.accounts.find((item) => item.id === accountId);
    return Boolean(current?.enabled) && (this.revisions.get(accountId) || 0) === revision;
  }

  async tick() {
    const now = Date.now();
    const due = this.store.state.accounts.filter((account) => {
      const status = this.status(account.id);
      return account.enabled && !this.viewWindows.has(account.id) && !this.openingViews.has(account.id) && !status.running && (!status.nextCheckAt || Date.parse(status.nextCheckAt) <= now);
    });
    await Promise.allSettled(due.map((account) => this.check(account.id)));
  }

  async check(accountId) {
    const storedAccount = this.store.state.accounts.find((item) => item.id === accountId);
    if (!storedAccount) throw new Error('账号不存在');
    if (!storedAccount.enabled) return;
    if (this.viewWindows.has(accountId) || this.openingViews.has(accountId)) return;
    if (this.inFlight.has(accountId)) return;
    this.inFlight.add(accountId);
    const revision = this.revisions.get(accountId) || 0;
    const account = structuredClone(storedAccount);
    const status = this.status(accountId);
    status.running = true;
    status.status = 'checking';
    status.error = '';
    status.stage = '准备检查';
    this.onChange();
    const client = new SiteClient(account, status);
    try {
      await client.open();
      const report = await client.readThisWeekSettlement();
      if (!this.isCurrentCheck(accountId, revision)) return;
      let configuredSubagents = Array.isArray(account.subagentThresholds) ? account.subagentThresholds : [];
      const legacyStep = legacyAlertStep(account);
      if (!configuredSubagents.length && report.agents.length && legacyStep !== null) {
        configuredSubagents = report.agents.map((agent) => ({ name: agent.name, alertStep: legacyStep }));
        account.subagentThresholds = configuredSubagents;
        this.store.update((data) => {
          const stored = data.accounts.find((item) => item.id === account.id);
          if (stored && !(stored.subagentThresholds || []).length) stored.subagentThresholds = configuredSubagents;
        });
        this.store.addEvent('success', `${account.name}：旧版提醒条件已迁移到 ${configuredSubagents.length} 个下级代理`, account.id);
      }
      status.subagents = applySubagentAlertSteps(report.agents, configuredSubagents);
      status.subagentCount = status.subagents.length;
      status.totalValue = report.value;
      status.lastCheckedAt = new Date().toISOString();
      let anyTriggered = false;
      const notificationFailures = [];
      for (const { subagent, level } of evaluateSubagentAlertLevels(status.subagents)) {
        if (!this.isCurrentCheck(accountId, revision)) return;
        const alertKey = Buffer.from(subagent.name).toString('base64url');
        const previousLevel = Number(status.subagentAlertLevels[alertKey] || 0);
        const transition = alertTransition(previousLevel, level);
        if (level !== 0) anyTriggered = true;
        if (transition.shouldNotify) {
          try {
            await this.sendTelegram(account, subagent.value, level, previousLevel, subagent.name, subagent.alertStep);
            if (!this.isCurrentCheck(accountId, revision)) return;
            status.subagentAlertLevels[alertKey] = level;
            status.lastAlertAt = new Date().toISOString();
            this.store.addEvent('alert', `${account.name} / ${subagent.name}：交收金额进入 ${level > 0 ? '+' : ''}${(level * subagent.alertStep).toLocaleString('zh-CN')} 档位`, account.id);
          } catch (error) {
            const message = `${subagent.name}：${error.message || String(error)}`;
            notificationFailures.push(message);
            this.store.addEvent('error', `${account.name} / ${message}`, account.id);
          }
        } else if (level === 0) {
          status.subagentAlertLevels[alertKey] = 0;
        }
      }
      status.status = anyTriggered ? 'triggered' : 'ok';
      status.error = notificationFailures.length ? `Telegram 提醒失败：${notificationFailures.join('；')}` : '';
    } catch (error) {
      status.status = 'error';
      const detail = error.message || String(error);
      status.error = isTransientScriptError(error)
        ? '网页正在跳转，程序将在下次检查时自动重试'
        : `${status.stage || '检查过程'}：${detail}`;
      status.lastCheckedAt = new Date().toISOString();
      this.store.addEvent('error', `${account.name}：${status.error}`, account.id);
    } finally {
      await client.close();
      const shouldReset = this.resetRequested.has(accountId);
      if (shouldReset) {
        do {
          this.resetRequested.delete(accountId);
          await this.clearAccountSession(accountId).catch(() => {});
        } while (this.resetRequested.has(accountId));
        this.rerunRequested.delete(accountId);
        this.runtime.delete(accountId);
      }
      status.running = false;
      this.inFlight.delete(accountId);
      if (shouldReset) {
        this.onChange();
        const current = this.store.state.accounts.find((item) => item.id === accountId);
        if (current?.enabled) setImmediate(() => void this.check(accountId));
      } else if (this.rerunRequested.delete(accountId)) {
        status.nextCheckAt = null;
        this.onChange();
        const current = this.store.state.accounts.find((item) => item.id === accountId);
        if (current?.enabled) setImmediate(() => void this.check(accountId));
      } else {
        status.nextCheckAt = new Date(Date.now() + Math.max(1, Number(account.intervalMinutes)) * 60000).toISOString();
        this.onChange();
      }
    }
  }

  async sendTelegram(account, value, level, previousLevel, subagentName, alertStep) {
    const { botToken, chatId } = this.store.state.telegram;
    if (!botToken || !chatId) throw new Error('请先设置 Telegram Bot Token 和 Chat ID');
    if (!subagentName || !Number.isFinite(alertStep) || alertStep <= 0) throw new Error('下级代理提醒资料不完整');
    const milestone = level * alertStep;
    const previousMilestone = previousLevel * alertStep;
    const crossedCount = Math.abs(level - previousLevel);
    const text = [
      '🔔 交收金额提醒',
      `账号：${account.name}`,
      `下级代理：${subagentName}`,
      `本周交收金额：${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `当前档位：${milestone > 0 ? '+' : ''}${milestone.toLocaleString('zh-CN')}（从 0 起）`,
      `提醒间隔：每 ${alertStep.toLocaleString('zh-CN')} 一档`,
      previousLevel ? `上次档位：${previousMilestone > 0 ? '+' : ''}${previousMilestone.toLocaleString('zh-CN')}` : '上次档位：0',
      crossedCount > 1 ? `本次跨越：${crossedCount} 个档位` : '',
      `时间：${new Date().toLocaleString('zh-CN')}`,
    ].filter(Boolean).join('\n');
    await this.telegramJson(botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  async testTelegram(input = {}) {
    const botToken = String(input.botToken || this.store.state.telegram.botToken || '').trim();
    const chatId = String(input.chatId || this.store.state.telegram.chatId || '').trim();
    if (!botToken || !chatId) throw new Error('请先填写 Bot Token 和 Chat ID');
    await this.telegramJson(botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ 交收监控：Telegram 通知测试成功' }),
    });
    this.store.addEvent('success', 'Telegram 测试消息已发送');
    this.onChange();
  }

  async discoverTelegramChatId(inputToken = '') {
    const botToken = String(inputToken || this.store.state.telegram.botToken || '').trim();
    if (!botToken) throw new Error('请先填写 Bot Token');
    const payload = await this.telegramJson(botToken, 'getUpdates?offset=-1&limit=1&timeout=0');
    const chats = (payload.result || [])
      .map((update) => update.message?.chat || update.channel_post?.chat || update.edited_message?.chat)
      .filter(Boolean);
    const latest = chats[chats.length - 1];
    if (!latest?.id) throw new Error('没有找到聊天：请先在 Telegram 给机器人发送一条消息');
    return String(latest.id);
  }
}

module.exports = { MonitorService };
