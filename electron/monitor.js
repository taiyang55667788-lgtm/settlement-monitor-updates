const path = require('node:path');
const { BrowserWindow, session } = require('electron');
const { createWorker, PSM } = require('tesseract.js');
const { parseSettlementTable, thresholdMet } = require('./report-parser');
const { isRedirectAbort } = require('./navigation');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      lastError = error;
    }
    await sleep(400);
  }
  if (lastError) throw lastError;
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
    const partition = `persist:settlement-monitor-${this.account.id}`;
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
    await load(this.window, this.account.navUrl);
    const inputFound = await waitUntil(this.window, `document.querySelectorAll('input').length > 0`, 12000);
    if (!inputFound) throw new Error('导航页没有找到安全码输入框');
    await this.window.webContents.executeJavaScript(`(() => {
      const input = [...document.querySelectorAll('input')].find(el => !['button','submit','hidden'].includes(el.type));
      if (!input) throw new Error('没有安全码输入框');
      input.value = ${jsString(this.account.securityCode)};
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
    const selected = await this.window.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('tr')]
        .filter(row => /代理线路/.test(row.innerText))
        .map(row => {
          const link = row.querySelector('a');
          const text = (link?.innerText || '').trim();
          const speed = Number((row.innerText.match(/(\d+)ms/i) || [])[1] || 99999);
          return { text, speed };
        })
        .filter(item => /^https?:\/\//i.test(item.text));
      rows.sort((a, b) => a.speed - b.speed);
      return rows[0] || null;
    })()`, true);
    if (!selected?.text) throw new Error('线路页没有可用的代理网址');
    this.status.routeSpeed = selected.speed < 99999 ? selected.speed : null;
    this.status.routeHost = new URL(selected.text).host;
    return selected.text;
  }

  async isLoggedIn() {
    return this.window.webContents.executeJavaScript(`/报表查询/.test(document.body.innerText) && !/管理员登录/.test(document.body.innerText)`, true);
  }

  async readCaptcha() {
    const rect = await this.window.webContents.executeJavaScript(`(() => {
      const images = [...document.images];
      const image = images.find(img => {
        const r = img.getBoundingClientRect();
        const context = img.closest('li, tr, div')?.innerText || '';
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80 && /验证码/.test(context);
      }) || images.find(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80;
      });
      if (!image) return null;
      const r = image.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`, true);
    if (!rect) throw new Error('找不到验证码图片');
    const image = await this.window.webContents.capturePage(rect);
    if (!this.ocr) {
      const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
      this.ocr = await createWorker('eng', 1, { langPath, gzip: true, logger: () => {} });
      await this.ocr.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_WORD });
    }
    const result = await this.ocr.recognize(image.toPNG());
    return String(result.data.text || '').replace(/\D/g, '').slice(0, 6);
  }

  async login(agentUrl) {
    await load(this.window, agentUrl);
    if (await this.isLoggedIn()) return;
    const formReady = await waitUntil(this.window, `document.querySelectorAll('input').length >= 3`, 12000);
    if (!formReady) throw new Error('代理登录页加载失败');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const captcha = await this.readCaptcha();
      if (captcha.length < 4) {
        await this.window.webContents.executeJavaScript(`document.images[document.images.length - 1]?.click()`, true);
        await sleep(500);
        continue;
      }
      await this.window.webContents.executeJavaScript(`(() => {
        const inputs = [...document.querySelectorAll('input')].filter(el => !['button','submit','hidden'].includes(el.type));
        const set = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set(inputs[0], ${jsString(this.account.username)});
        set(inputs[1], ${jsString(this.account.password)});
        set(inputs[2], ${jsString(captcha)});
        const controls = [...document.querySelectorAll('button, input[type=submit], a')];
        const submit = controls.find(el => /^登录$/.test((el.innerText || el.value || '').replace(/\s/g,'')));
        if (!submit) throw new Error('没有登录按钮');
        submit.click();
      })()`, true);
      const loggedIn = await waitUntil(this.window, `/报表查询/.test(document.body.innerText)`, 10000);
      if (loggedIn) return;
      await sleep(500);
    }
    throw new Error('连续三次无法通过验证码，请稍后重试');
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
    const reportUrl = await this.reportUrl();
    await load(this.window, reportUrl);
    await waitUntil(this.window, `/本星期/.test(document.body.innerText)`, 12000);
    await this.window.webContents.executeJavaScript(`(() => {
      const control = [...document.querySelectorAll('button, input, a')]
        .find(el => /本星期/.test(el.innerText || el.value || ''));
      control?.click();
    })()`, true);
    await sleep(250);
    await this.window.webContents.executeJavaScript(`(() => {
      const control = [...document.querySelectorAll('button, input, a')]
        .find(el => /^查询$/.test((el.innerText || el.value || '').trim()));
      if (!control) throw new Error('没有查询按钮');
      control.click();
    })()`, true);
    const ready = await waitUntil(this.window, `[...document.querySelectorAll('tr')].some(row => /合计/.test(row.innerText))`, 15000);
    if (!ready) throw new Error('本周报表加载超时');
    const tableData = await this.window.webContents.executeJavaScript(`(() => {
      const tables = [...document.querySelectorAll('table')];
      const table = tables.find(t => /交收|上级交收/.test(t.innerText) && /合计/.test(t.innerText))
        || tables.sort((a,b) => b.querySelectorAll('td').length - a.querySelectorAll('td').length)[0];
      if (!table) throw new Error('没有报表表格');
      const rows = [...table.querySelectorAll('tr')];
      const firstData = rows.findIndex(row => {
        const first = row.cells[0]?.innerText?.trim() || '';
        return /^合计/.test(first) || (/^[a-zA-Z0-9_-]+$/.test(first) && row.cells.length > 8);
      });
      const headerRows = rows.slice(0, Math.max(1, firstData)).map(row => [...row.cells].map(cell => ({
        text: cell.innerText,
        colspan: cell.colSpan,
        rowspan: cell.rowSpan,
      })));
      const dataRows = rows.slice(Math.max(0, firstData)).filter(row => row.cells.length > 8)
        .map(row => [...row.cells].map(cell => cell.innerText.trim()));
      return { headerRows, dataRows };
    })()`, true);
    return parseSettlementTable(tableData).value;
  }

  async close() {
    if (this.ocr) await this.ocr.terminate().catch(() => {});
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

class MonitorService {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.runtime = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 10000);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  status(accountId) {
    if (!this.runtime.has(accountId)) this.runtime.set(accountId, { status: 'waiting', alerted: false });
    return this.runtime.get(accountId);
  }

  async tick() {
    const now = Date.now();
    const due = this.store.state.accounts.filter((account) => {
      const status = this.status(account.id);
      return account.enabled && !status.running && (!status.nextCheckAt || Date.parse(status.nextCheckAt) <= now);
    });
    await Promise.allSettled(due.map((account) => this.check(account.id)));
  }

  async check(accountId) {
    const account = this.store.state.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('账号不存在');
    const status = this.status(accountId);
    if (status.running) return;
    status.running = true;
    status.status = 'checking';
    status.error = '';
    this.onChange();
    const client = new SiteClient(account, status);
    try {
      await client.open();
      const value = await client.readThisWeekSettlement();
      const met = thresholdMet(value, account.operator, Number(account.threshold));
      status.currentValue = value;
      status.lastCheckedAt = new Date().toISOString();
      status.status = met ? 'triggered' : 'ok';
      if (met && !status.alerted) {
        await this.sendTelegram(account, value);
        status.alerted = true;
        status.lastAlertAt = new Date().toISOString();
        this.store.addEvent('alert', `${account.name}：交收金额 ${value.toLocaleString('zh-CN')} 已达到提醒条件`, account.id);
      } else if (!met) {
        status.alerted = false;
      }
    } catch (error) {
      status.status = 'error';
      const detail = error.message || String(error);
      status.error = /ERR_ABORTED|\(-3\)/i.test(detail)
        ? '导航跳转尚未完成，程序将在下次检查时自动重试'
        : detail;
      status.lastCheckedAt = new Date().toISOString();
      this.store.addEvent('error', `${account.name}：${status.error}`, account.id);
    } finally {
      await client.close();
      status.running = false;
      status.nextCheckAt = new Date(Date.now() + Math.max(1, Number(account.intervalMinutes)) * 60000).toISOString();
      this.onChange();
    }
  }

  async sendTelegram(account, value) {
    const { botToken, chatId } = this.store.state.telegram;
    if (!botToken || !chatId) throw new Error('请先设置 Telegram Bot Token 和 Chat ID');
    const comparison = account.operator === 'lte' ? '≤' : '≥';
    const text = [
      '🔔 交收金额提醒',
      `账号：${account.name}`,
      `本周交收金额：${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `触发条件：${comparison} ${Number(account.threshold).toLocaleString('zh-CN')}`,
      `时间：${new Date().toLocaleString('zh-CN')}`,
    ].join('\n');
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Telegram 发送失败（${response.status}）：${detail.slice(0, 160)}`);
    }
  }

  async testTelegram() {
    const { botToken, chatId } = this.store.state.telegram;
    if (!botToken || !chatId) throw new Error('请先填写 Bot Token 和 Chat ID');
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ 交收监控：Telegram 通知测试成功' }),
    });
    if (!response.ok) throw new Error(`Telegram 测试失败（${response.status}）`);
    this.store.addEvent('success', 'Telegram 测试消息已发送');
    this.onChange();
  }
}

module.exports = { MonitorService };
