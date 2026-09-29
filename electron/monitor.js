const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, session, nativeImage, net } = require('electron');
const { createWorker, PSM } = require('tesseract.js');
const { splitReportRows, parseSettlementTable, parseCrownGeneralAgentTable, parseCrownDashboardDetails, legacyAlertStep, agentPathKey, applySubagentAlertSteps, evaluateSubagentAlertLevels } = require('./report-parser');
const { ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel } = require('./alert-ledger');
const { accountSystemId, crownLoginEntry, metricForAccount, CROWN_URLS } = require('./monitor-systems');
const { PairingClient } = require('./pairing');
const MAX_DESCENDANT_DEPTH = 5;
const {
  partitionForAccount,
  isRedirectAbort,
  isTransientScriptError,
  selectFastestRoute,
  loginSubmissionScript,
  loginPrefillScript,
  crownLoginSubmissionScript,
  crownLoginPrefillScript,
  selectCaptchaCandidateDetails,
  isCredentialFailure,
  loginFailureScript,
} = require('./navigation');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function failureKind(error) {
  const text = String(error?.message || error);
  if (error?.code === 'CROWN_HUMAN_VERIFICATION_REQUIRED' || /验证码|图形验证/.test(text)) return '验证码';
  if (isCredentialFailure(text)) return '账号凭据';
  if (/ERR_|超时|网络|fetch failed/i.test(text)) return '网络或加载超时';
  if (/登录|登陆|会话/.test(text)) return '登录状态';
  return '报表读取或校验';
}
// 皇冠会在登录后的报表请求中拒绝 Electron 默认 UA；使用桌面 Chrome 标识，
// 与用户在 Chrome 中可正常查看盘口的环境保持一致。
const CROWN_BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function settlementWeekRange(now = new Date()) {
  const date = new Date(now);
  const day = date.getDay();
  const beforeMondayCutoff = day === 1 && date.getHours() < 6;
  date.setDate(date.getDate() - ((day + 6) % 7) - (beforeMondayCutoff ? 7 : 0));
  const format = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const start = format(date); date.setDate(date.getDate() + 6);
  return { start, end: format(date) };
}

function inQuietHours(policy, now = new Date()) {
  const start = String(policy?.quietStart || '');
  const end = String(policy?.quietEnd || '');
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const from = minutes(start); const to = minutes(end);
  return from < to ? current >= from && current < to : current >= from || current < to;
}

function deltaHistoryForPeriod(history, period, metric) {
  return history?.period === period && history?.metric === metric && history.agents && typeof history.agents === 'object'
    ? history : { period, metric, agents: {} };
}

function captchaOcrVariants(image) {
  const size = image.getSize();
  const width = Math.max(180, size.width * 4);
  const height = Math.max(72, size.height * 4);
  const enlarged = image.resize({ width, height, quality: 'best' });
  const variants = [enlarged.toPNG()];
  const bitmap = enlarged.toBitmap();
  const presets = [
    { threshold: 118, inverted: false },
    { threshold: 145, inverted: false },
    { threshold: 172, inverted: false },
    { threshold: 145, inverted: true },
  ];
  for (const { threshold, inverted } of presets) {
    const processed = Buffer.from(bitmap);
    for (let offset = 0; offset + 3 < processed.length; offset += 4) {
      const brightness = (processed[offset] * 0.299) + (processed[offset + 1] * 0.587) + (processed[offset + 2] * 0.114);
      const blackOrWhite = brightness < threshold ? 0 : 255;
      const value = inverted ? 255 - blackOrWhite : blackOrWhite;
      processed[offset] = value;
      processed[offset + 1] = value;
      processed[offset + 2] = value;
    }
    variants.push(nativeImage.createFromBitmap(processed, { width, height, scaleFactor: 1 }).toPNG());
  }
  return variants;
}

function captchaFingerprint(image) {
  return crypto.createHash('sha256').update(image.toPNG()).digest('hex');
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function crownReportPeriodScript() {
  return `(() => {
    const matches = [...(document.body.innerText || '').matchAll(/(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})\\s*~\\s*(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})/g)];
    const toDate = (year, month, day) => Date.UTC(Number(year), Number(month) - 1, Number(day));
    const match = matches.find(item => toDate(item[4], item[5], item[6]) - toDate(item[1], item[2], item[3]) === 6 * 86400000);
    if (!match) return null;
    const format = (year, month, day) => [year, month, day].map((part, index) => index ? String(part).padStart(2, '0') : part).join('-');
    return { start: format(match[1], match[2], match[3]), end: format(match[4], match[5], match[6]) };
  })()`;
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
  let timeout;
  try {
    const navigation = win.loadURL(url);
    // 某些皇冠备用域名不会报错也不会完成加载。给每次跳转设上限，让调用方
    // 有机会改用下一个允许域名，不能让整次登录永远卡在“正在打开”。
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        win.webContents.stop();
        reject(new Error(`网页加载超时：${url}`));
      }, 15000);
    });
    await Promise.race([navigation, deadline]);
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
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await sleep(350);
}

class SiteClient {
  constructor(account, status) {
    this.account = account;
    this.status = status;
    this.metric = metricForAccount(account);
    this.window = null;
    this.ocr = null;
    this.ownsWindow = true;
  }

  async open() {
    const partition = partitionForAccount(this.account.id);
    const crown = accountSystemId(this.account) === 'crown';
    this.window = new BrowserWindow({
      // 皇冠首页会在 document.visibilityState 为 hidden 时延后创建报表卡片。
      // 第一次读取先让真实窗口完成渲染，成功后由 MonitorService 隐藏并复用它。
      show: crown,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    if (crown) {
      this.window.webContents.setUserAgent(CROWN_BROWSER_USER_AGENT);
      // 此持久会话只用于皇冠账户。系统代理会令 mos011 返回空响应；
      // 只在该皇冠分区内直连，不触碰 macOS / Clash 的全局代理设置，
      // 也不会影响 166、Telegram 或 Codex / GPT 的网络线路。
      await this.window.webContents.session.setProxy({ mode: 'direct' });
    }
    this.window.webContents.setWindowOpenHandler(({ url }) => ({ action: 'deny' }));
  }

  async discoverAgentUrl() {
    if (accountSystemId(this.account) === 'crown') return this.account.navUrl;
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
    if (accountSystemId(this.account) === 'crown') {
      return Boolean(await executeInFrames(this.window, `Boolean(document.querySelector('#left_dsearch_user_type, #date_div_600, #dashboard_main, .dashboard_main, #data_right_scroll, .data_right_scroll')) || /绩效概况/.test(document.body.innerText)`));
    }
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
        source: image.currentSrc || image.src || '',
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
    const candidate = selectCaptchaCandidateDetails(candidates, info.expectedLength);
    return { ...candidate, fingerprint: captchaFingerprint(image), source: info.source };
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
    const ready = await waitUntil(this.window, `(() => {
      const image = [...document.images].find(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80;
      });
      return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    })()`, 3000);
    if (!ready) throw new Error('验证码刷新后图片未完成加载');
    await sleep(350);
  }

  async crownHumanVerificationRequired() {
    return Boolean(await executePageAction(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const inputHint = input => [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), input.closest('label, .form-group, .input-group, .field')?.innerText]
        .filter(Boolean).join(' ').toLowerCase();
      const hasCaptchaInput = [...document.querySelectorAll('input')].some(input => /captcha|verify|checkcode|validcode|验证码|图形验证|人机验证/.test(inputHint(input)));
      const hasChallengeText = /图形验证|验证码|人机验证|滑动验证|拖动滑块|相关的图案|排序点击/.test(compact(document.body.innerText));
      return hasCaptchaInput || hasChallengeText;
    })()`));
  }

  async loadCrownLoginPage(agentUrl) {
    // 历史检查状态可能保留已失效的备用域名。手动盘内查看和重新登录应
    // 优先采用用户当前保存的皇冠域名，不能先被旧线路的证书错误卡住。
    const configuredUrl = CROWN_URLS.find((url) => {
      try { return new URL(url).host === new URL(this.account.crownDomain || this.account.navUrl).host; } catch { return false; }
    }) || CROWN_URLS[0];
    // 本地 DOM 烟雾测试传入 file:// 夹具；不能为了测试去访问真实盘口域名。
    // 生产环境仍然只尝试已配置或白名单中的皇冠线路。
    const candidates = String(agentUrl || '').startsWith('file:')
      ? [agentUrl]
      : [configuredUrl, ...CROWN_URLS, agentUrl]
        .filter((url, index, values) => url && values.indexOf(url) === index);
    const entryAliases = JSON.stringify(crownLoginEntry(this.account.crownLoginEntry, this.account.monitorMetric).aliases);
    let lastError;
    const failures = [];
    for (const candidate of candidates) {
      try {
        await load(this.window, candidate);
        // 皇冠首页可能在已登录内容的下方保留一段“网络问题”提示；只要
        // 登录表单或已登录的页面已经存在，就应继续使用该有效会话，而不是
        // 因这段附带文案错误切到另一条线路。
        const ready = await waitUntilAnyFrame(this.window, `(() => {
          const hasLoginForm = Boolean(document.querySelector('input[type="password"]'));
          const hasLoggedInPage = Boolean(document.querySelector('#left_dsearch_user_type, #date_div_600, #dashboard_main, .dashboard_main'))
            || /绩效概况/.test(document.body.innerText || '');
          const aliases = ${entryAliases};
          const normalize = value => String(value || '').replace(/\s+/g, '').toLowerCase();
          const hasLoginEntry = [...document.querySelectorAll('a, button, li, [role="button"]')]
            .some(node => aliases.some(alias => normalize(node.innerText).includes(normalize(alias))));
          return hasLoginForm || hasLoggedInPage || hasLoginEntry;
        })()`, 15000);
        if (ready) {
          this.status.routeHost = new URL(candidate).host;
          return candidate;
        }
        lastError = new Error(`${new URL(candidate).host} 未显示可用的登录页`);
        failures.push(lastError.message);
      } catch (error) {
        lastError = error;
        failures.push(`${new URL(candidate).host}：${error?.message || error}`);
      }
    }
    throw new Error(`皇冠登录页无法加载（${failures.join('；') || lastError?.message || '三个允许域名均不可用'}）`);
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
    if (accountSystemId(this.account) === 'crown') return this.loginCrown(agentUrl);
    if (await this.isLoggedIn().catch(() => false)) return;
    if (!this.ownsWindow && this.window.isVisible()) {
      const error = new Error('等待你在“盘内查看”完成验证码登录');
      error.code = 'MANUAL_LOGIN_REQUIRED';
      throw error;
    }
    this.status.stage = '正在打开代理登录页';
    await load(this.window, agentUrl);
    if (await this.isLoggedIn()) {
      this.status.stage = '登录状态有效';
      return;
    }
    const formReady = await waitUntil(this.window, `document.querySelectorAll('input').length >= 3`, 12000);
    if (!formReady) throw new Error('代理登录页加载失败');
    let lastFailure = '';
    let previousCaptchaFingerprint = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.status.stage = `正在识别验证码（第 ${attempt}/3 次）`;
      const recognition = await this.readCaptcha();
      if (recognition.fingerprint === previousCaptchaFingerprint) {
        lastFailure = '验证码图片未刷新，已停止重复提交';
        await this.refreshCaptcha();
        continue;
      }
      previousCaptchaFingerprint = recognition.fingerprint;
      if (recognition.digits.length < 4) {
        lastFailure = '验证码图片无法识别';
        await this.refreshCaptcha();
        continue;
      }
      if (!recognition.decisive) {
        lastFailure = `验证码识别置信度不足（${recognition.votes} 组一致，最高 ${Math.round(recognition.confidence)}%）`;
        this.status.stage = `${lastFailure}，正在更换图片（第 ${attempt}/3 次）`;
        await this.refreshCaptcha();
        continue;
      }
      const captcha = recognition.digits;
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

  async selectCrownLoginEntry() {
    const entry = crownLoginEntry(this.account.crownLoginEntry, this.account.monitorMetric);
    this.status.stage = `正在打开皇冠${entry.label}`;
    // 皇冠首次打开默认就是登入一；不等待 SPA 标签渲染，避免延迟页面被误判为
    // “找不到登入一”并关闭用户正在使用的登录窗口。
    if (entry.id === 'login-1') return;
    const aliases = JSON.stringify(entry.aliases);
    const selected = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const names = ${aliases}.map(compact);
      const controls = [...document.querySelectorAll('button, input[type=button], input[type=submit], a, label, [role=tab], li')];
      const control = controls.find(el => names.includes(compact(el.innerText || el.value || el.textContent)));
      if (!control) return false;
      control.click();
      return true;
    })()`, Boolean);
    if (!selected) throw new Error(`皇冠首页未找到“${entry.label}”入口，已停止登录`);
    const ready = await waitUntilAnyFrame(this.window, `document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])').length >= 2 || Boolean(document.querySelector('#left_dsearch_user_type, #date_div_600')) || /绩效概况/.test(document.body.innerText)`, 12000);
    if (!ready) throw new Error(`皇冠${entry.label}登录页加载超时`);
  }

  async loginCrown(agentUrl) {
    this.status.stage = '正在打开皇冠登录页';
    if (await this.isLoggedIn()) {
      this.status.stage = '登录状态有效';
      return;
    }
    // 盘内查看窗口由用户完成图形验证。后台轮询绝不能在用户输入时 reload
    // 或提交表单，否则会反复清空输入并把窗口误关成一次登录失败。
    const manualFormOpen = !this.ownsWindow && this.window.isVisible() && await executeInFrames(this.window, `(() => {
      const inputs = [...document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])')];
      return inputs.some(input => input.type === 'password') && inputs.some(input => input.type !== 'password');
    })()`, Boolean);
    if (manualFormOpen) {
      const error = new Error('皇冠等待你在“盘内查看”完成安全码和图形验证；后台不会刷新或自动提交登录表单');
      error.code = 'CROWN_HUMAN_VERIFICATION_REQUIRED';
      throw error;
    }
    await this.loadCrownLoginPage(agentUrl);
    if (await this.isLoggedIn()) {
      this.status.stage = '登录状态有效';
      return;
    }
    const entry = crownLoginEntry(this.account.crownLoginEntry, this.account.monitorMetric);
    const defaultLoginFormVisible = entry.id === 'login-1' && await executeInFrames(this.window, `(() => {
      const inputs = [...document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])')];
      return inputs.some(input => input.type === 'password') && inputs.some(input => input.type !== 'password');
    })()`, Boolean).catch(() => false);
    if (defaultLoginFormVisible) this.status.stage = '皇冠登入一登录页已就绪';
    else await this.selectCrownLoginEntry();
    if (await this.isLoggedIn()) {
      this.status.stage = '登录状态有效';
      return;
    }
    const hasSecurityCode = Boolean(String(this.account.securityCode || ''));
    const formReady = await waitUntilAnyFrame(this.window, `document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])').length >= ${hasSecurityCode ? 3 : 2}`, 12000);
    if (!formReady) throw new Error(hasSecurityCode ? '皇冠登录页没有找到账号、密码和安全代码输入框' : '皇冠登录页没有找到账号和密码输入框');
    if (await this.crownHumanVerificationRequired()) {
      const error = new Error('皇冠登录需要你完成安全码和图形验证；已暂停自动提交并打开“盘内查看”');
      error.code = 'CROWN_HUMAN_VERIFICATION_REQUIRED';
      throw error;
    }
    const baselineFailure = await this.readLoginFailure();
    await executeInFrames(this.window, crownLoginSubmissionScript(this.account.username, this.account.password, this.account.securityCode), () => true);
    const outcome = await this.waitForLoginOutcome(10000, baselineFailure);
    if (outcome.loggedIn) {
      this.status.stage = '皇冠账号登录成功';
      return;
    }
    throw new Error(`皇冠登录未完成${outcome.failure ? `（${outcome.failure}）` : ''}`);
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
    // 皇冠首页可能直接展示旧报表；保留会话的同时重新加载页面以获取本轮数据。
    if (accountSystemId(this.account) === 'crown' && await this.isLoggedIn().catch(() => false)) {
      await load(this.window, this.window.webContents.getURL());
    }
    try {
      await this.login(agentUrl);
    } catch (error) {
      if (failureKind(error) !== '网络或加载超时') throw error;
      agentUrl = await this.discoverAgentUrl();
      this.status.agentUrl = agentUrl;
      await this.login(agentUrl);
    }
    const crownRoutes = accountSystemId(this.account) === 'crown'
      ? [agentUrl, ...CROWN_URLS].filter((url, index, values) => url && values.indexOf(url) === index)
      : [];
    let crownRouteIndex = 0;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.status.stage = attempt === 1 ? `正在查询本周${this.metric.label}` : `本周${this.metric.label}校验异常，正在重试（${attempt}/3）`;
        await this.openThisWeekReport();
        this.currentReportPath = [];
        this.status.stage = '本周报表读取成功';
        return await this.readCurrentSettlement();
      } catch (error) {
        lastError = error;
        if (error?.code === 'CROWN_ROUTE_ERROR' && crownRouteIndex + 1 < crownRoutes.length) {
          crownRouteIndex += 1;
          agentUrl = crownRoutes[crownRouteIndex];
          this.status.agentUrl = agentUrl;
          this.status.stage = `皇冠报表线路异常，正在切换 ${new URL(agentUrl).host}`;
          await this.loginCrown(agentUrl);
          continue;
        }
        if (!/报表日期或代理层级|结算周|本周报表/.test(error.message || '') || attempt === 3) throw error;
        await sleep(800);
      }
    }
    throw lastError;
  }

  async openThisWeekReport() {
    if (accountSystemId(this.account) === 'crown' && this.metric.id === 'general-agent-result') return this.openCrownGeneralAgentReport();
    this.previousReportText = '';
    this.status.stage = '正在打开报表查询';
    await executePageAction(this.window, `(() => new Promise((resolve, reject) => {
      const link = [...document.querySelectorAll('a')].find(el => /报表查询/.test(el.innerText));
      if (!link) throw new Error('登录后没有找到报表查询入口');
      const frame = document.querySelector('iframe#frame, iframe[name=frame]');
      if (!frame) { link.click(); resolve(true); return; }
      const timeout = setTimeout(() => reject(new Error('报表查询页面重新加载超时')), 15000);
      frame.addEventListener('load', () => { clearTimeout(timeout); resolve(true); }, { once: true });
      frame.src = link.href;
    }))()`);
    const reportReady = await waitUntilAnyFrame(
      this.window,
      `Boolean(document.querySelector('#txtStartTime') && document.querySelector('#txtEndTime') && document.querySelector('#thisWeek'))`,
      15000,
    );
    if (!reportReady) throw new Error('报表查询页面加载超时');
    this.status.stage = '正在查询本周报表';
    const weekSelected = await executeInFrames(this.window, `(() => {
      const control = document.querySelector('#thisWeek') || [...document.querySelectorAll('button, input, a')]
        .find(el => /本星期/.test(el.innerText || el.value || ''));
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!weekSelected) throw new Error('没有本星期按钮');
    const weekReady = await waitUntilAnyFrame(this.window, `(() => {
      const start = document.querySelector('#txtStartTime')?.value;
      const end = document.querySelector('#txtEndTime')?.value;
      return /^\\d{4}-\\d{2}-\\d{2}$/.test(start || '') && /^\\d{4}-\\d{2}-\\d{2}$/.test(end || '')
        && (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) === 6 * 86400000;
    })()`, 5000);
    if (!weekReady) throw new Error('本星期按钮未设定完整一周的日期，已停止读取以免误取今日数据');
    const weekRange = await executeInFrames(this.window, `(() => {
      const start = document.querySelector('#txtStartTime')?.value;
      const end = document.querySelector('#txtEndTime')?.value;
      return start && end ? { start, end } : null;
    })()`, Boolean);
    if (!weekRange) throw new Error('无法确认本周报表日期');
    const settlementPeriod = settlementWeekRange();
    if (weekRange.start !== settlementPeriod.start || weekRange.end !== settlementPeriod.end) {
      throw new Error(`盘口本周日期应为 ${settlementPeriod.start}—${settlementPeriod.end}（周一 06:00 切换），当前为 ${weekRange.start}—${weekRange.end}`);
    }
    await this.selectReportOption();
    const querySubmitted = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const control = document.querySelector('#btnSelect') || [...document.querySelectorAll('button, input, a')]
        .find(el => compact(el.innerText || el.value) === '查询');
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!querySubmitted) throw new Error('没有查询按钮');
    const ready = await waitUntilAnyFrame(this.window, `Boolean(document.querySelector('#mytable') && /合计/.test(document.querySelector('#mytable').innerText))`, 15000);
    if (!ready) throw new Error('本周报表加载超时');
    this.reportPeriod = weekRange;
    await this.verifyReportPeriod(this.metric.usesSubagents ? 1 : null);
  }

  async dismissCrownSecurityPrompt() {
    // 登录后皇冠有时会展示「账户安全 / 双重验证」的介绍弹窗。它遮住了
    // 「本周有结果」入口；这里只寻找弹窗右上角的关闭控件，绝不触发
    // 「启用双重验证」或改动任何账号安全设置。
    const dismissed = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const dialogs = [...document.querySelectorAll('[role="dialog"], .modal, .dialog, .popup, div')]
        .filter(el => {
          const text = compact(el.innerText || el.textContent);
          return text.includes('账户安全') && (text.includes('双重验证') || text.includes('2FA'));
        });
      const dialog = dialogs.sort((left, right) => (left.innerText || '').length - (right.innerText || '').length)[0];
      if (!dialog) return false;
      const controls = [...dialog.querySelectorAll('button, a, [role="button"], [aria-label], [title]')];
      const close = controls.find(el => /关闭|close/i.test(el.getAttribute('aria-label') || '')
        || /关闭|close/i.test(el.getAttribute('title') || '')
        || ['×', 'x'].includes(compact(el.innerText || el.textContent)))
        || controls.find(el => {
          const label = compact(el.innerText || el.textContent);
          return !label && Boolean(el.querySelector('svg, i, img'));
        });
      if (!close) return false;
      close.click();
      return true;
    })()`, Boolean).catch(() => false);
    if (dismissed) await sleep(250);
    return dismissed;
  }

  async openCrownGeneralAgentReport() {
    this.status.stage = '正在打开皇冠本周总代理报表';
    await this.dismissCrownSecurityPrompt();
    const dashboardReady = await executeInFrames(this.window, `(() => {
      const panel = document.querySelector('#data_right_scroll, .data_right_scroll');
      const text = panel?.innerText || '';
      return Boolean(panel && text.includes('总代理结果') && text.includes('总代理实货量')
        && panel.querySelector('[id^="accid_"]') && document.querySelector('[id^="td_"][id$="_fixed"]'));
    })()`);
    if (dashboardReady) {
      const period = await executeInFrames(this.window, crownReportPeriodScript(), value => Boolean(value?.start && value?.end));
      const expected = settlementWeekRange();
      if (!period || period.start !== expected.start || period.end !== expected.end) {
        throw new Error(`皇冠当前报表日期应为 ${expected.start}—${expected.end}（周一 06:00 切换），已停止读取`);
      }
      this.reportPeriod = period;
      return;
    }
    const reportEntryReady = await waitUntilAnyFrame(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      return [...document.querySelectorAll('button, input[type=button], input[type=submit], a, label, [role=button], [role=tab], [onclick], li, div')]
        .some(el => ['本周有结果', '常用报表', '报表'].includes(compact(el.innerText || el.value || el.textContent)));
    })()`, 15000);
    if (!reportEntryReady) {
      const visibleActions = await executeInFrames(this.window, `(() => {
        const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
        return [...document.querySelectorAll('button, input[type=button], input[type=submit], a, label, [role=button], [role=tab], [onclick], li, div')]
          .map(el => compact(el.innerText || el.value || el.textContent)).filter(Boolean).slice(0, 12);
      })()`, Array.isArray);
      const summary = visibleActions?.length ? visibleActions.join('、') : '无可点击报表项';
      const error = new Error(`皇冠首页报表入口加载超时（当前可见项：${summary}），已停止读取`);
      if (/加载此页面时遇到问题吗？|网络问题或是您使用不支持的浏览/.test(summary)) error.code = 'CROWN_ROUTE_ERROR';
      throw error;
    }
    const reportsOpened = await executeInFrames(this.window, `(() => {
      if (document.querySelector('#result_type_div_600, #date_div_600')) return true;
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const control = [...document.querySelectorAll('button, input[type=button], input[type=submit], a, label, [role=button], [role=tab], [onclick], li, div')]
        .find(el => ['本周有结果', '常用报表', '报表'].includes(compact(el.innerText || el.value || el.textContent)));
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!reportsOpened) throw new Error('皇冠首页未找到“常用报表”入口，已停止读取');
    const crownReportPageReady = await waitUntilAnyFrame(this.window, `(() => {
      const text = document.body.innerText || '';
      return (text.includes('股东结果') || text.includes('总代理结果'))
        || Boolean(document.querySelector('#result_type_div_600, #date_div_600'));
    })()`, 15000);
    if (!crownReportPageReady) throw new Error('皇冠报表页面加载超时，未出现股东或总代理结果栏');
    const otherReportReady = await executeInFrames(this.window, `Boolean(document.querySelector('#result_type_div_600, #date_div_600')) || document.body.innerText.includes('股东结果')`, Boolean);
    const spaDetailsReady = !otherReportReady && await waitUntilAnyFrame(this.window, `(() => {
      const panel = document.querySelector('#data_right_scroll, .data_right_scroll');
      const text = panel?.innerText || '';
      return Boolean(panel && text.includes('总代理结果') && text.includes('总代理实货量')
        && panel.querySelector('[id^="accid_"]') && document.querySelector('[id^="td_"][id$="_fixed"]'));
    })()`, 15000);
    if (spaDetailsReady) {
      const period = await executeInFrames(this.window, crownReportPeriodScript(), value => Boolean(value?.start && value?.end));
      const expected = settlementWeekRange();
      if (!period || period.start !== expected.start || period.end !== expected.end) {
        throw new Error(`皇冠当前报表日期应为 ${expected.start}—${expected.end}（周一 06:00 切换），已停止读取`);
      }
      this.reportPeriod = period;
      return;
    }
    // 皇冠的新报表先显示「股东」汇总。总代理结果和实货量在点击当前股东帐号后
    // 才会出现；不能把这一层的股东结果误当成总代理结果。
    const shareholderDrilldown = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const panel = document.querySelector('#data_right_scroll, .data_right_scroll') || document.body;
      const text = panel.innerText || '';
      if (!text.includes('股东结果') || text.includes('总代理结果')) return { needed: false };
      const expected = compact(${jsString(this.account.username)});
      const account = [...document.querySelectorAll('[id^="td_"][id$="_fixed"], a, button, [onclick], [role="button"], td, div')]
        .find(el => compact(el.innerText || el.textContent) === expected && el !== panel);
      if (!account) return { needed: true, opened: false };
      account.click();
      return { needed: true, opened: true, before: text };
    })()`, value => value !== undefined && value !== null);
    if (shareholderDrilldown?.needed) {
      if (!shareholderDrilldown.opened) throw new Error('皇冠股东汇总未找到可进入的股东帐号，已停止读取以免把股东结果当总代理结果');
      const drilled = await waitUntilAnyFrame(this.window, `(() => {
        const panel = document.querySelector('#data_right_scroll, .data_right_scroll') || document.body;
        return (panel.innerText || '').includes('总代理结果') && (panel.innerText || '').includes('总代理实货量');
      })()`, 15000);
      if (!drilled) throw new Error('皇冠股东帐号未进入总代理明细，已停止读取以免误取股东结果');
    }
    const drilledDetailsReady = await executeInFrames(this.window, `(() => {
      const panel = document.querySelector('#data_right_scroll, .data_right_scroll');
      const text = panel?.innerText || '';
      return Boolean(panel && text.includes('总代理结果') && text.includes('总代理实货量')
        && panel.querySelector('[id^="accid_"]') && document.querySelector('[id^="td_"][id$="_fixed"]'));
    })()`);
    if (drilledDetailsReady) {
      const period = await executeInFrames(this.window, crownReportPeriodScript(), value => Boolean(value?.start && value?.end));
      const expected = settlementWeekRange();
      if (!period || period.start !== expected.start || period.end !== expected.end) {
        throw new Error(`皇冠当前报表日期应为 ${expected.start}—${expected.end}（周一 06:00 切换），已停止读取`);
      }
      this.reportPeriod = period;
      return;
    }
    const ready = await waitUntilAnyFrame(this.window, `Boolean(document.querySelector('#result_type_div_600') && document.querySelector('#date_div_600'))`, 15000);
    if (!ready) throw new Error('皇冠常用报表页面加载超时');
    const week = settlementWeekRange();
    this.status.stage = '正在查询皇冠本周总代理明细';
    const selected = await executeInFrames(this.window, `(() => {
      const fire = element => { element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); };
      const values = [['#result_type_div_600', 'Y'], ['#date_div_600', 'tw'], ['#gtype_div_600', 'ALL']];
      for (const [selector, value] of values) {
        const control = document.querySelector(selector);
        if (!control) { if (selector === '#gtype_div_600') continue; return false; }
        control.value = value; fire(control);
      }
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const query = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')]
        .find(el => compact(el.innerText || el.value || el.textContent) === '查询');
      if (!query) return false;
      query.click();
      return true;
    })()`);
    if (!selected) throw new Error('皇冠常用报表缺少本周、有结果或查询控件，已停止读取');
    const [startYear, startMonth, startDay] = week.start.split('-').map(Number);
    const [endYear, endMonth, endDay] = week.end.split('-').map(Number);
    const expectedPeriod = `${startYear}/${startMonth}/${startDay} ~ ${endYear}/${endMonth}/${endDay}`;
    const queried = await waitUntilAnyFrame(this.window, `document.body.innerText.includes(${jsString(expectedPeriod)}) && [...document.querySelectorAll('button, input[type=button], input[type=submit], a')].some(el => [...String(el.innerText || el.value || el.textContent || '')].filter(char => char.trim()).join('') === '观看总代理')`, 15000);
    if (!queried) throw new Error(`皇冠本周报表未显示 ${expectedPeriod} 或“观看总代理”入口，已停止读取`);
    const opened = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const control = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')]
        .find(el => compact(el.innerText || el.value || el.textContent) === '观看总代理');
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (!opened) throw new Error('皇冠本周报表未找到“观看总代理”入口');
    const detailsReady = await waitUntilAnyFrame(this.window, `(() => [...document.querySelectorAll('table')].some(table => {
      const text = table.innerText || '';
      const rows = [...table.querySelectorAll('tr')];
      const hasHeaders = text.includes('总代理帐号') && text.includes('总代理结果') && text.includes('总代理实货量');
      const total = rows.find(row => row.cells?.[0]?.innerText?.trim() === '总计');
      return hasHeaders && total && !/\\*[A-Z_0-9]+\\*/.test(total.innerText || '');
    }))()`, 15000);
    if (!detailsReady) throw new Error('皇冠总代理明细未加载完成，已停止读取以免误取模板数据');
    this.reportPeriod = week;
  }

  async selectReportOption() {
    if (!this.metric.reportOption) return;
    this.status.stage = `正在选择“${this.metric.reportOption}”`;
    const option = jsString(this.metric.reportOption);
    const selected = await executeInFrames(this.window, `(() => {
      const compact = value => [...String(value || '')].filter(char => char.trim()).join('');
      const expected = compact(${option});
      const fire = element => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      for (const select of document.querySelectorAll('select')) {
        const choice = [...select.options].find(item => compact(item.textContent) === expected);
        if (choice) { select.value = choice.value; fire(select); return true; }
      }
      const controls = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
      const control = controls.find((item) => {
        const labels = item.labels ? [...item.labels].map(label => label.innerText || label.textContent).join(' ') : '';
        const wrapper = item.closest('label, li, td, div')?.innerText || '';
        return compact(labels) === expected || compact(wrapper) === expected;
      });
      if (control) { control.checked = true; fire(control); return true; }
      const action = [...document.querySelectorAll('button, input[type=button], a, label')]
        .find(item => compact(item.innerText || item.value || item.textContent) === expected);
      if (action) { action.click(); return true; }
      return false;
    })()`, Boolean);
    if (!selected) throw new Error(`本周交收页面未找到“${this.metric.reportOption}”选项，已停止读取以免误取其他结果`);
  }

  async verifyReportPeriod(expectedDepth) {
    const { start, end } = this.reportPeriod || {};
    if (!start || !end) throw new Error('无法确认本周报表日期');
    const valid = await waitUntilAnyFrame(this.window, `(() => {
      const nav = document.querySelector('#navAgentReport');
      const links = nav?.querySelectorAll('#AgentReportNav a').length;
      return Boolean(nav && nav.innerText.includes(${jsString(start)}) && nav.innerText.includes(${jsString(end)})
        && (${expectedDepth === null ? 'true' : `links === ${Number(expectedDepth)}`}));
    })()`, 8000);
    if (!valid) throw new Error(`报表日期或代理层级与本周 ${start}—${end} 不符，已停止读取以免误报`);
  }

  async readCurrentSettlement() {
    if (accountSystemId(this.account) === 'crown' && this.metric.id === 'general-agent-result') return this.readCrownGeneralAgentSettlement();
    const priorText = this.previousReportText || '';
    const header = jsString(this.metric.columnLabel);
    const rawRows = await executeInFrames(this.window, `(() => {
      const tables = [...document.querySelectorAll('table')];
      const table = [document.querySelector('#mytable'), ...tables].filter(Boolean)
        .find(t => t.innerText.includes(${header}) && /合计/.test(t.innerText) && (!${Boolean(priorText)} || t.innerText !== ${jsString(priorText)}));
      if (!table) return null;
      const rows = [...table.querySelectorAll('tr')];
      return rows.map(row => [...row.cells].map(cell => ({
        text: cell.innerText,
        colspan: cell.colSpan,
        rowspan: cell.rowSpan,
      })));
    })()`, Array.isArray);
    if (!rawRows) throw new Error('没有报表表格');
    return parseSettlementTable(splitReportRows(rawRows), this.metric);
  }

  async readCrownGeneralAgentSettlement() {
    const dashboard = await executeInFrames(this.window, `(() => {
      const panel = document.querySelector('#data_right_scroll, .data_right_scroll');
      if (!panel || !panel.innerText.includes('总代理结果') || !panel.innerText.includes('总代理实货量')) return null;
      const numberTokens = text => (String(text || '').match(/-?[\\d,]+(?:\\.\\d+)?/g) || []);
      const rows = [...panel.querySelectorAll('[id^="accid_"]')].map(node => {
        const id = node.id.slice('accid_'.length);
        const accountCell = document.getElementById('td_' + id + '_fixed');
        const name = String(accountCell?.innerText || '').trim().split(/\\s+/)[0];
        return { name, values: numberTokens(node.innerText) };
      });
      if (!rows.length || rows.some(row => !row.name || row.values.length < 2)) return null;
      const firstRow = panel.querySelector('[id^="accid_"]');
      const totalNode = firstRow?.previousElementSibling;
      const total = numberTokens(totalNode?.innerText);
      if (total.length < 2) return null;
      return { total, agents: rows };
    })()`, value => Boolean(value));
    if (dashboard) return parseCrownDashboardDetails(dashboard);
    const rawRows = await executeInFrames(this.window, `(() => {
      const table = [...document.querySelectorAll('table')].find(candidate => {
        const text = candidate.innerText || '';
        const rows = [...candidate.querySelectorAll('tr')];
        const total = rows.find(row => row.cells?.[0]?.innerText?.trim() === '总计');
        return text.includes('总代理帐号') && text.includes('总代理结果') && text.includes('总代理实货量')
          && total && !/\\*[A-Z_0-9]+\\*/.test(total.innerText || '');
      });
      if (!table) return null;
      return [...table.querySelectorAll('tr')].map(row => [...row.cells].map(cell => ({ text: cell.innerText, colspan: cell.colSpan, rowspan: cell.rowSpan })));
    })()`);
    if (!rawRows) throw new Error('皇冠总代理明细表格不存在或仍是模板数据');
    return parseCrownGeneralAgentTable(splitReportRows(rawRows, 16));
  }

  async drillIntoAgent(name, expectedDepth) {
    const target = jsString(name);
    const clicked = await executeInFrames(this.window, `(() => {
      const tables = [...document.querySelectorAll('table')];
      const table = [document.querySelector('#mytable'), ...tables].filter(Boolean)
        .find(t => /应收下线/.test(t.innerText) && /合计/.test(t.innerText));
      if (!table) return null;
      const row = [...table.querySelectorAll('tr')].find(tr => tr.cells?.[0]?.innerText?.trim() === ${target});
      if (!row) return null;
      const first = row.cells[0];
      const control = first.querySelector('a,button,[role="button"]')
        || (first.hasAttribute('onclick') ? first : null)
        || (row.hasAttribute('onclick') ? row : null);
      if (!control) return { noDescendants: true };
      const before = table.innerText;
      control.click();
      return { before };
    })()`, (result) => result !== null && result !== undefined);
    if (!clicked) throw new Error(`报表中找不到代理“${name}”`);
    if (clicked.noDescendants) return false;
    const changed = await waitUntilAnyFrame(this.window, `(() => {
      const table = [document.querySelector('#mytable'), ...document.querySelectorAll('table')].filter(Boolean)
        .find(t => /应收下线/.test(t.innerText) && /合计/.test(t.innerText));
      return Boolean(table && table.innerText !== ${jsString(clicked.before)});
    })()`, 12000);
    if (!changed) throw new Error('点击代理后报表没有切换到下级；请提供点击前后的盘口截图');
    await this.verifyReportPeriod(expectedDepth);
    this.previousReportText = clicked.before;
    return true;
  }

  async readDescendantSettlement(path) {
    const expectedPeriod = this.reportPeriod ? `${this.reportPeriod.start}/${this.reportPeriod.end}` : '';
    const current = this.currentReportPath;
    const canContinue = Array.isArray(current) && current.length <= path.length && current.every((name, index) => path[index] === name);
    if (!canContinue) {
      await this.openThisWeekReport();
      this.currentReportPath = [];
    }
    if (expectedPeriod && `${this.reportPeriod.start}/${this.reportPeriod.end}` !== expectedPeriod) {
      throw new Error('读取下级时本周日期范围发生变化，已停止读取');
    }
    for (const [index, name] of path.entries()) {
      if (index < this.currentReportPath.length) continue;
      this.status.stage = `正在读取 ${path.join(' / ')} 的下级`;
      this.currentReportPath = null;
      const drilled = await this.drillIntoAgent(name, index + 2);
      this.currentReportPath = path.slice(0, drilled ? index + 1 : index);
      if (!drilled) return { value: 0, agents: [] };
    }
    return this.readCurrentSettlement();
  }

  async close() {
    if (this.ocr) await this.ocr.terminate().catch(() => {});
    if (this.ownsWindow && this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

class MonitorService {
  constructor(store, onChange, network = {}) {
    this.store = store;
    this.onChange = onChange;
    this.telegramFetch = network.fetch || ((...args) => net.fetch(...args));
    this.resolveTelegramProxy = network.resolveProxy || ((url) => session.defaultSession.resolveProxy(url));
    this.pairingClient = network.pairingClient || new PairingClient();
    this.createSiteClient = network.createSiteClient || ((account, status) => new SiteClient(account, status));
    this.runtime = new Map();
    this.inFlight = new Set();
    this.revisions = new Map();
    this.resetRequested = new Set();
    this.rerunRequested = new Set();
    this.viewWindows = new Map();
    this.openingViews = new Set();
    this.timer = null;
    this.commandTimer = null;
    this.commandPollRunning = false;
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

  async startTelegramPairing() {
    if (this.store.state.telegram.pairing?.paired) throw new Error('请先解除当前绑定，再重新配对');
    const oldToken = this.store.state.telegram.pairing?.token;
    if (oldToken) await this.pairingClient.unlink(oldToken).catch(() => {});
    const pairing = await this.pairingClient.start();
    this.store.update((data) => {
      data.telegram.pairing = {
        token: pairing.token,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        botUsername: pairing.botUsername,
        paired: false,
      };
    });
    this.onChange();
    return { code: pairing.code, expiresAt: pairing.expiresAt, botUsername: pairing.botUsername };
  }

  async checkTelegramPairing() {
    const pairing = this.store.state.telegram.pairing;
    if (!pairing?.token) return { paired: false };
    let result;
    try {
      result = await this.pairingClient.status(pairing.token);
    } catch (error) {
      if (error.status !== 401) throw error;
      this.store.update((data) => {
        data.telegram.pairing = null;
        data.telegram.mode = 'off';
      });
      this.store.addEvent('error', 'Telegram 配对已失效，请重新生成配对码');
      this.onChange();
      return { paired: false, invalidated: true };
    }
    if (result.paired && !pairing.paired) {
      this.store.update((data) => {
        data.telegram.pairing.paired = true;
        data.telegram.mode = 'pairing';
      });
      this.store.addEvent('success', 'Telegram 已通过配对码绑定');
      this.onChange();
    }
    return { paired: Boolean(result.paired) };
  }

  async unlinkTelegramPairing() {
    const token = this.store.state.telegram.pairing?.token;
    if (!token) return;
    try {
      await this.pairingClient.unlink(token);
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    this.store.update((data) => {
      data.telegram.pairing = null;
      data.telegram.mode = 'off';
    });
    this.store.addEvent('success', 'Telegram 配对已解除');
    this.onChange();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 10000);
    this.commandTimer = setInterval(() => void this.pollTelegramCommands(), 15000);
    void this.tick();
    setTimeout(() => void this.pollTelegramCommands(), 3000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.commandTimer);
    this.timer = null;
    const windows = [...this.viewWindows.values()];
    this.viewWindows.clear();
    this.openingViews.clear();
    for (const win of windows) {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async pollTelegramCommands() {
    if (this.commandPollRunning) return;
    const pairing = this.store.state.telegram.pairing;
    if (this.store.state.telegram.mode !== 'pairing' || !pairing?.paired || !pairing.token) return;
    this.commandPollRunning = true;
    try {
      const command = await this.pairingClient.nextCommand(pairing.token);
      if (!command?.command) return;
      const request = typeof command.command === 'string' ? { type: command.command } : command.command;
      const enabled = this.store.state.accounts.filter((account) => account.enabled);
      const requested = request.type === 'check' && request.argument
        ? enabled.filter((account) => account.name === request.argument) : enabled;
      if (request.type === 'check' && request.argument && !requested.length) {
        await this.pairingClient.send(pairing.token, `未找到启用账号：${request.argument}`); return;
      }
      if (['report', 'top', 'check'].includes(request.type)) await Promise.allSettled(requested.map((account) => this.check(account.id)));
      if (request.type === 'alerts') {
        const rows = (this.store.state.alertRecords || []).slice(0, 10).map((item) => `${item.status === 'sent' ? '✅' : '❌'} ${item.accountName} / ${(item.agentPath || []).join(' / ')} · ${item.alertType === 'delta' ? `变化 ${item.change > 0 ? '+' : ''}${item.change}` : `金额 ${item.value > 0 ? '+' : ''}${item.value}`} · ${new Date(item.time).toLocaleString('zh-CN')}`);
        await this.pairingClient.send(pairing.token, `🧾 最近提醒记录\n${rows.join('\n') || '暂无记录'}`); return;
      }
      if (request.type === 'top') {
        const rows = requested.flatMap((account) => this.status(account.id).subagents.filter((agent) => !agent.stale).map((agent) => ({ account: account.name, agent, value: agent.value }))).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 10).map((item, index) => `${index + 1}. ${item.account} / ${item.agent.path.join(' / ')}：${item.value > 0 ? '+' : ''}${item.value.toLocaleString('zh-CN')}`);
        await this.pairingClient.send(pairing.token, `🏆 当前金额前 10 名\n${rows.join('\n') || '暂无成功读取的数据'}`); return;
      }
      const rows = this.store.state.accounts.map((account) => {
        const status = this.status(account.id);
        const period = status.reportPeriod ? `${status.reportPeriod.start}—${status.reportPeriod.end}` : '未读取';
        const values = (status.subagents || []).filter((agent) => !agent.stale).map((agent) => `${agent.path.join(' / ')} ${agent.value > 0 ? '+' : ''}${agent.value}`).slice(0, 12);
        return [`账号：${account.name} · ${period}`, status.status === 'error' ? `读取失败：${status.error}` : (values.join('\n') || '暂无成功读取的数据')].join('\n');
      });
      await this.pairingClient.send(pairing.token, `${request.type === 'check' ? '🔄 刷新完成' : '📊 当前盘口报表'}\n${rows.join('\n\n')}`.slice(0, 3400));
      this.store.addEvent('success', `已响应 Telegram /${request.type} 指令`); this.onChange();
    } catch (error) {
      this.store.addEvent('error', `Telegram 指令处理失败：${error.message || error}`); this.onChange();
    } finally { this.commandPollRunning = false; }
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
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      if (accountSystemId(account) === 'crown') {
        win.webContents.setUserAgent(CROWN_BROWSER_USER_AGENT);
        // 与后台读取使用同一皇冠专属分区；见 SiteClient.open 中的说明。
        await win.webContents.session.setProxy({ mode: 'direct' });
      }
      this.viewWindows.set(accountId, win);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => {
        const wasCurrent = this.viewWindows.get(accountId) === win;
        if (wasCurrent) this.viewWindows.delete(accountId);
        const current = this.store.state.accounts.find((item) => item.id === accountId);
        if (wasCurrent && current?.enabled) setImmediate(() => void this.check(accountId));
      });
      try {
        const crown = accountSystemId(account) === 'crown';
        // 盘内查看必须和自动检查一样避开已失效的备用域名；否则会把一次
        // hga030 的证书错误留在状态中，之后无法打开用户刚登录的有效会话。
        let viewClient = null;
        if (crown) {
          viewClient = new SiteClient(account, status);
          viewClient.window = win;
          targetUrl = await viewClient.loadCrownLoginPage(targetUrl);
          status.agentUrl = targetUrl;
        } else {
          await load(win, targetUrl);
        }
        const crownLoggedIn = `Boolean(document.querySelector('#left_dsearch_user_type, #date_div_600')) || /绩效概况/.test(document.body.innerText)`;
        let crownHumanVerification = false;
        if (crown && !await executeInFrames(win, crownLoggedIn, Boolean)) {
          await viewClient.selectCrownLoginEntry();
        }
        if (!await (crown
          ? executeInFrames(win, crownLoggedIn, Boolean)
          : win.webContents.executeJavaScript(`/报表查询/.test(document.body.innerText) && !/管理员登录/.test(document.body.innerText)`, true))) {
          const crownSecurityCode = crown && Boolean(String(account.securityCode || ''));
          const ready = crown
            ? await waitUntilAnyFrame(win, `document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])').length >= ${crownSecurityCode ? 3 : 2}`, 12000)
            : await waitUntil(win, `document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=hidden])').length >= 3`, 12000);
          if (!ready) throw new Error('盘内登录页加载失败');
          if (crown) await executeInFrames(win, crownLoginPrefillScript(account.username, account.password, account.securityCode), () => true);
          else await executePageAction(win, loginPrefillScript(account.username, account.password));
          if (crown && viewClient) crownHumanVerification = await viewClient.crownHumanVerificationRequired();
        }
        win.show();
        win.focus();
        status.stage = crownHumanVerification ? '皇冠图形验证已检测；已预填资料，请完成验证后登录' : crown ? '皇冠盘内查看已打开；已预填登录资料，可手动登录' : '盘内查看已打开；可手动输入验证码';
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
      const account = this.store.state.accounts.find((item) => item.id === accountId);
      const snapshot = account?.agentSnapshot;
      const metric = metricForAccount(account);
      const snapshotMatchesMetric = snapshot?.metric === metric.id || (!snapshot?.metric && metric.id === 'receivable-downline');
      const cached = snapshotMatchesMetric && Array.isArray(snapshot?.agents) ? snapshot.agents : [];
      this.runtime.set(accountId, {
        status: 'waiting',
        subagents: applySubagentAlertSteps(cached.map((agent) => ({ ...agent, stale: true })), account?.subagentThresholds),
        subagentCount: snapshotMatchesMetric ? cached.filter((agent) => agent.path?.length === 1).length : null,
        reportPeriod: snapshotMatchesMetric ? snapshot?.period || null : null,
        consecutiveFailures: account?.monitorHealth?.consecutiveFailures || 0,
        lastSuccessAt: account?.monitorHealth?.lastSuccessAt || '',
      });
    }
    return this.runtime.get(accountId);
  }

  updateSubagentAlertStep(accountId, path, alertStep, remark = '', deltaAlertStep = null) {
    const status = this.status(accountId);
    const key = agentPathKey(path);
    const subagent = status.subagents?.find((item) => agentPathKey(item.path) === key);
    if (subagent) Object.assign(subagent, { alertStep, remark, deltaAlertStep, customized: true });
  }

  async processDeltaAlerts(account, status, period, metric, quiet, notificationFailures) {
    const periodKey = `${period.start}/${period.end}`;
    const stored = this.store.state.accounts.find((item) => item.id === account.id);
    const history = deltaHistoryForPeriod(stored?.deltaHistory, periodKey, metric.id);
    for (const subagent of status.subagents.filter((item) => !item.stale && Number.isFinite(item.value))) {
      const key = agentPathKey(subagent.path);
      const previous = history.agents[key];
      const baseline = { value: subagent.value, readAt: subagent.readAt || new Date().toISOString() };
      const change = Number.isFinite(previous?.value) ? subagent.value - previous.value : null;
      const shouldSend = !quiet && Number.isFinite(subagent.deltaAlertStep) && subagent.deltaAlertStep > 0 && Number.isFinite(change) && Math.abs(change) >= subagent.deltaAlertStep;
      if (shouldSend) {
        try {
          const sign = change > 0 ? '+' : '';
          await this.sendOperationalTelegram([
            `↕️ ${metric.valueLabel}变化量提醒`, `账号：${account.name}`,
            metric.usesSubagents ? `${metric.agentLabel || '代理层级'}：${subagent.path.join(' / ')}` : `监控项：${metric.label}`,
            subagent.remark ? `备注：${subagent.remark}` : '', `报表区间：${periodKey.replace('/', '—')}`,
            `上次成功读取：${previous.value > 0 ? '+' : ''}${previous.value.toLocaleString('zh-CN')}`,
            `当前值：${subagent.value > 0 ? '+' : ''}${subagent.value.toLocaleString('zh-CN')}`,
            `本次变化：${sign}${change.toLocaleString('zh-CN')}`, `变化提醒阈值：${subagent.deltaAlertStep.toLocaleString('zh-CN')}`,
            `时间：${new Date().toLocaleString('zh-CN')}`,
          ].filter(Boolean).join('\n'));
          this.recordAlertAttempt({ status: 'sent', alertType: 'delta', accountId: account.id, accountName: account.name, agentName: subagent.name, agentPath: subagent.path, value: subagent.value, change, alertStep: subagent.deltaAlertStep, remark: subagent.remark, period });
          this.store.addEvent('alert', `${account.name} / ${subagent.path.join(' / ')}：本次变化 ${sign}${change.toLocaleString('zh-CN')} 已发送 Telegram 提醒`, account.id);
        } catch (error) {
          const message = `${subagent.name}：变化量提醒发送失败：${error.message || error}`;
          notificationFailures.push(message); subagent.alertError = error.message || String(error);
          this.recordAlertAttempt({ status: 'failed', alertType: 'delta', accountId: account.id, accountName: account.name, agentPath: subagent.path, value: subagent.value, change, alertStep: subagent.deltaAlertStep, remark: subagent.remark, error: subagent.alertError, period });
          this.store.addEvent('error', `${account.name} / ${message}`, account.id); continue;
        }
      }
      this.store.update((data) => {
        const current = data.accounts.find((item) => item.id === account.id); if (!current) return;
        const currentHistory = deltaHistoryForPeriod(current.deltaHistory, periodKey, metric.id);
        currentHistory.agents[key] = baseline; current.deltaHistory = currentHistory;
      });
    }
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
      return account.enabled && !this.openingViews.has(account.id) && !status.running && (!status.nextCheckAt || Date.parse(status.nextCheckAt) <= now);
    });
    await Promise.allSettled(due.map((account) => this.check(account.id)));
  }

  async check(accountId) {
    const storedAccount = this.store.state.accounts.find((item) => item.id === accountId);
    if (!storedAccount) throw new Error('账号不存在');
    if (!storedAccount.enabled) return;
    if (this.openingViews.has(accountId)) return;
    if (this.inFlight.has(accountId)) return;
    this.inFlight.add(accountId);
    const checkStarted = Date.now();
    const revision = this.revisions.get(accountId) || 0;
    const account = structuredClone(storedAccount);
    const metric = metricForAccount(account);
    const status = this.status(accountId);
    status.running = true;
    status.status = 'checking';
    status.error = '';
    status.failureKind = '';
    status.phaseTimings = null;
    status.readProgress = null;
    status.stage = '准备检查';
    this.onChange();
    const client = this.createSiteClient(account, status);
    const activeView = this.viewWindows.get(accountId);
    if (activeView && !activeView.isDestroyed()) {
      client.window = activeView;
      client.ownsWindow = false;
    }
    let manualCrownVerification = false;
    try {
      if (!client.window) await client.open();
      const report = await client.readThisWeekSettlement();
      if (!this.isCurrentCheck(accountId, revision)) return;
      status.reportPeriod = client.reportPeriod;
      const rootReadAt = new Date().toISOString();
      const periodKey = `${client.reportPeriod.start}/${client.reportPeriod.end}`;
      const cachedSnapshot = this.store.state.accounts.find((item) => item.id === accountId)?.agentSnapshot;
      const cachedAgents = cachedSnapshot?.period?.start === client.reportPeriod.start
        && cachedSnapshot?.period?.end === client.reportPeriod.end && cachedSnapshot.metric === metric.id ? cachedSnapshot.agents || [] : [];
      const agents = metric.usesSubagents
        ? report.agents.map((agent) => ({ ...agent, path: [agent.name], readAt: rootReadAt }))
        : [{ name: metric.label, path: [metric.label], value: report.value, readAt: rootReadAt }];
      let configuredSubagents = Array.isArray(account.subagentThresholds) ? account.subagentThresholds : [];
      const legacyStep = legacyAlertStep(account);
      if (metric.usesSubagents && !configuredSubagents.length && report.agents.length && legacyStep !== null) {
        configuredSubagents = report.agents.map((agent) => ({ name: agent.name, alertStep: legacyStep }));
        account.subagentThresholds = configuredSubagents;
        this.store.update((data) => {
          const stored = data.accounts.find((item) => item.id === account.id);
          if (stored && !(stored.subagentThresholds || []).length) stored.subagentThresholds = configuredSubagents;
        });
        this.store.addEvent('success', `${account.name}：旧版提醒条件已迁移到 ${configuredSubagents.length} 个下级代理`, account.id);
      }
      let anyTriggered = false;
      const notificationFailures = [];
      status.failureKind = '';
      status.phaseTimings = { loginAndRootMs: Date.now() - checkStarted, branches: [] };
      const publishBatch = async (fresh) => {
        if (!this.isCurrentCheck(accountId, revision)) return;
        const unread = cachedAgents.filter(old => !agents.some(item => agentPathKey(item.path) === agentPathKey(old.path))).map(old => ({ ...old, stale: true }));
        status.subagents = applySubagentAlertSteps([...agents, ...unread], configuredSubagents);
        status.readProgress = { read: agents.filter(a => !a.stale).length };
        status.subagentCount = report.agents.length;
        status.totalValue = report.value;
        status.stage = '已读取 ' + agents.filter(a => !a.stale).length + ' 个代理，继续读取下级';
        this.onChange();
        const batch = applySubagentAlertSteps(fresh, configuredSubagents);
        anyTriggered = await this.processFreshBatch(account, status, client.reportPeriod, metric, revision, batch, notificationFailures) || anyTriggered;
        for (const item of batch) {
          const source = agents.find(agent => agentPathKey(agent.path) === agentPathKey(item.path));
          if (source && item.alertError) source.alertError = item.alertError;
        }
        this.onChange();
      };
      await publishBatch(agents.slice());
      const childErrors = [];
      const branches = metric.readsDescendants !== false ? report.agents.map((agent) => [agent.name]) : [];
      while (branches.length) {
        const path = branches.pop();
        if (path.length >= MAX_DESCENDANT_DEPTH) continue;
        if (!this.isCurrentCheck(accountId, revision)) return;
        const parent = agents.find((agent) => agentPathKey(agent.path) === agentPathKey(path));
        if (!parent) continue;
        status.readProgress = { read: agents.filter(a => !a.stale).length, pendingBranches: branches.length + 1 };
        status.stage = `已读取 ${status.readProgress.read} 个代理；正在读取第 ${path.length + 1} 级：${path.join(' / ')}`;
        this.onChange();
        const branchStarted = Date.now();
        try {
          const fresh = [];
          const childReport = await client.readDescendantSettlement(path);
          if (!this.isCurrentCheck(accountId, revision)) return;
          const childReadAt = new Date().toISOString();
          parent.childCount = childReport.agents.length;
          for (const child of childReport.agents) {
            const childPath = [...path, child.name];
            if (!agents.some((item) => agentPathKey(item.path) === agentPathKey(childPath))) {
              const item = { ...child, path: childPath, readAt: childReadAt };
              agents.push(item);
              fresh.push(item);
              if (childPath.length < MAX_DESCENDANT_DEPTH) branches.push(childPath);
            }
          }
          await publishBatch(fresh);
        } catch (error) {
          client.currentReportPath = null;
          parent.childError = error.message || String(error);
          childErrors.push(`${path.join(' / ')}：${parent.childError}`);
          for (const cached of cachedAgents.filter((item) => item.path?.length > path.length && path.every((part, index) => item.path[index] === part))) {
            if (!agents.some((item) => agentPathKey(item.path) === agentPathKey(cached.path))) agents.push({ ...cached, stale: true });
          }
        } finally {
          status.phaseTimings.branches.push({ path: [...path], durationMs: Date.now() - branchStarted, error: parent.childError || '' });
        }
      }
      status.stage = metric.readsDescendants !== false ? `最多 ${MAX_DESCENDANT_DEPTH} 级代理报表读取完成` : metric.usesSubagents ? '皇冠总代理明细读取完成' : '报表读取完成';
      status.subagents = applySubagentAlertSteps(agents, configuredSubagents);
      status.subagentCount = metric.usesSubagents ? report.agents.length : 1;
      status.totalValue = report.value;
      status.lastCheckedAt = new Date().toISOString();
      status.lastSuccessAt = status.lastCheckedAt;
      status.consecutiveFailures = 0;
      const recovered = Boolean(status.failureNotified);
      status.failureNotified = false;
      this.store.update((data) => {
        const current = data.accounts.find((item) => item.id === accountId);
        if (current) {
          current.agentSnapshot = {
            period: client.reportPeriod,
            metric: metric.id,
            agents: agents.map(({ name, path, value, turnover, readAt, childCount }) => ({ name, path, value, ...(Number.isFinite(turnover) ? { turnover } : {}), readAt, ...(Number.isFinite(childCount) ? { childCount } : {}) })),
          };
          current.monitorHealth = { lastSuccessAt: status.lastSuccessAt, consecutiveFailures: 0 };
          const point = { time: status.lastSuccessAt, metric: metric.id, agents: agents.filter((item) => !item.stale).map(({ path, value }) => ({ path, value })) };
          current.agentTrend = [...(Array.isArray(current.agentTrend) ? current.agentTrend : []), point]
            .filter((item) => Date.parse(item.time) >= Date.now() - 7 * 86400000).slice(-2016);
        }
      });
      if (recovered) await this.sendOperationalTelegram(`✅ 交收监控恢复正常\n账号：${account.name}\n时间：${new Date().toLocaleString('zh-CN')}`).catch(() => {});
      if (!childErrors.length && !notificationFailures.length && this.store.state.accounts.find((item) => item.id === accountId)?.alertHistory?.migrationPending) {
        this.store.update((data) => {
          const current = data.accounts.find((item) => item.id === accountId);
          if (current?.alertHistory?.period === periodKey) {
            current.alertHistory.migrationPending = false;
            current.alertMetricVersion = metric.alertMetric || ALERT_METRIC;
          }
        });
      }
      status.status = childErrors.length || notificationFailures.length ? 'error' : anyTriggered ? 'triggered' : 'ok';
      status.readProgress = { read: agents.filter(a => !a.stale).length, pendingBranches: 0 };
      status.failureKind = childErrors.length ? '部分报表读取或校验' : notificationFailures.length ? 'Telegram 发送' : '';
      status.error = [
        childErrors.length ? `部分下级代理读取失败：${childErrors.slice(0, 3).join('；')}${childErrors.length > 3 ? `；共 ${childErrors.length} 个代理失败` : ''}` : '',
        notificationFailures.length ? `Telegram 提醒失败：${notificationFailures.join('；')}` : '',
      ].filter(Boolean).join('；');
      if (client.window && !client.window.isDestroyed()) {
        const crownSessionWindow = activeView && !activeView.isDestroyed() ? activeView : client.window;
        this.viewWindows.set(accountId, crownSessionWindow);
        client.ownsWindow = false;
        if (activeView !== crownSessionWindow) crownSessionWindow.once('closed', () => {
          if (this.viewWindows.get(accountId) === crownSessionWindow) this.viewWindows.delete(accountId);
        });
        if (!activeView) crownSessionWindow.hide();
      }
    } catch (error) {
      manualCrownVerification = error?.code === 'CROWN_HUMAN_VERIFICATION_REQUIRED';
      status.status = 'error';
      const detail = error.message || String(error);
      status.failureKind = failureKind(error);
      status.error = isTransientScriptError(error)
        ? '网页正在跳转，程序将在下次检查时自动重试'
        : `${status.stage || '检查过程'}：${detail}`;
      status.lastCheckedAt = new Date().toISOString();
      status.consecutiveFailures = Number(status.consecutiveFailures || 0) + 1;
      status.subagents = (status.subagents || []).map((agent) => ({ ...agent, stale: true }));
      this.store.addEvent('error', `${account.name}：${status.error}`, account.id);
      const policy = this.store.state.alertPolicy || {};
      const escalation = Math.max(1, Number(policy.failureEscalation) || 3);
      this.store.update((data) => {
        const current = data.accounts.find((item) => item.id === accountId);
        if (current) current.monitorHealth = { lastSuccessAt: status.lastSuccessAt || '', consecutiveFailures: status.consecutiveFailures };
      });
      if (status.consecutiveFailures === 1 || status.consecutiveFailures === escalation) {
        try {
          const label = status.consecutiveFailures === 1 ? '读取失败' : '连续失败升级';
          await this.sendOperationalTelegram(`⚠️ 交收监控${label}\n账号：${account.name}\n连续失败：${status.consecutiveFailures} 次\n位置：${status.error}\n时间：${new Date().toLocaleString('zh-CN')}`);
          status.failureNotified = true;
          this.store.addEvent('alert', `${account.name}：${label}已发送 Telegram 通知`, account.id);
        } catch (noticeError) {
          this.store.addEvent('error', `${account.name}：连续失败升级通知发送失败：${noticeError.message || noticeError}`, account.id);
        }
      }
    } finally {
      status.durationMs = Date.now() - checkStarted;
      const timings = status.phaseTimings;
      const slowest = timings?.branches.reduce((max, item) => !max || item.durationMs > max.durationMs ? item : max, null);
      this.store.addEvent('info', `${account.name}：本轮耗时 ${(status.durationMs / 1000).toFixed(1)} 秒${timings ? `；登录及首层 ${(timings.loginAndRootMs / 1000).toFixed(1)} 秒；分支 ${timings.branches.length} 个` : ''}${slowest ? `；最慢分支 ${slowest.path.join(' / ')} ${(slowest.durationMs / 1000).toFixed(1)} 秒` : ''}${status.failureKind ? `；故障类型：${status.failureKind}` : ''}`, accountId);
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
      } else if (manualCrownVerification) {
        status.nextCheckAt = null;
        this.onChange();
        setImmediate(() => void this.openAccountView(accountId).catch((error) => {
          status.error = `无法打开皇冠盘内查看：${error.message || error}`;
          this.store.addEvent('error', `${account.name}：${status.error}`, account.id);
          this.onChange();
        }));
      } else if (this.rerunRequested.delete(accountId)) {
        status.nextCheckAt = null;
        this.onChange();
        const current = this.store.state.accounts.find((item) => item.id === accountId);
        if (current?.enabled) setImmediate(() => void this.check(accountId));
      } else {
        status.nextCheckAt = new Date(Math.max(Date.now() + 1000, checkStarted + Math.max(1, Number(account.intervalMinutes)) * 60000)).toISOString();
        this.onChange();
      }
    }
  }

  async processFreshBatch(account, status, period, metric, revision, batch, notificationFailures) {
    const accountId = account.id;
    const periodKey = `${period.start}/${period.end}`;
    const persistedAccount = this.store.state.accounts.find((item) => item.id === accountId);
    const alertMetric = metric.alertMetric || ALERT_METRIC;
    if (alertHistoryForPeriod(persistedAccount?.alertHistory, periodKey, alertMetric, persistedAccount?.alertMetricVersion === alertMetric) !== persistedAccount?.alertHistory) {
      this.store.update((data) => {
        const current = data.accounts.find((item) => item.id === accountId);
        if (!current) return;
        if (current.alertHistory?.period && current.alertHistory.metric !== alertMetric) {
          current.alertHistoryArchive = [...(current.alertHistoryArchive || []), {
            ...current.alertHistory,
            metric: current.alertHistory.metric || 'upper-level-settlement-v1',
            archivedAt: new Date().toISOString(),
          }].slice(-12);
        }
        current.alertHistory = alertHistoryForPeriod(current.alertHistory, periodKey, alertMetric, current.alertMetricVersion === alertMetric);
      });
    }
    let anyTriggered = false;
    const policy = this.store.state.alertPolicy || {};
    const confirmationReads = Math.max(1, Math.min(10, Number(policy.confirmationReads) || 1));
    const quiet = inQuietHours(policy);
    for (const { subagent, level } of evaluateSubagentAlertLevels(batch.filter((agent) => !agent.stale))) {
      if (!this.isCurrentCheck(accountId, revision)) return;
      const alertKey = alertLedgerKey(subagent.path, subagent.alertStep);
      const history = this.store.state.accounts.find((item) => item.id === accountId)?.alertHistory;
      let confirmed = true;
      this.store.update((data) => {
        const current = data.accounts.find((item) => item.id === accountId);
        if (!current) return;
        current.alertCandidates ||= {};
        const previous = current.alertCandidates[alertKey];
        const count = previous?.level === level ? Number(previous.count || 0) + 1 : 1;
        current.alertCandidates[alertKey] = { level, count, updatedAt: new Date().toISOString() };
        confirmed = level === 0 || count >= confirmationReads;
      });
      const pending = !confirmed || quiet ? [] : pendingAlertNotifications(level, history?.agents?.[alertKey], undefined, {
        initialSummary: history?.migrationPending === true,
      });
      if (level !== 0) anyTriggered = true;
      let notificationFailed = false;
      for (const notification of pending) {
        if (!this.isCurrentCheck(accountId, revision)) return;
        try {
          await this.sendTelegram(account, subagent.value, notification.level, notification.previousLevel, subagent.name, subagent.alertStep, subagent.remark, subagent.path, period, notification);
          this.store.update((data) => {
            const current = data.accounts.find((item) => item.id === accountId);
            if (!current || current.alertHistory?.period !== periodKey) throw new Error('提醒已发送，但报表周期记录发生变化；请检查运行记录');
            current.alertHistory.agents[alertKey] = recordAlertLevel(current.alertHistory.agents[alertKey], notification.level, new Date().toISOString());
          });
          this.recordAlertAttempt({
            status: 'sent', accountId: account.id, accountName: account.name,
            agentName: subagent.name, agentPath: subagent.path, value: subagent.value,
            level: notification.level, alertStep: subagent.alertStep, remark: subagent.remark,
            period,
          });
          if (!this.isCurrentCheck(accountId, revision)) return;
          status.lastAlertAt = new Date().toISOString();
          this.store.addEvent('alert', `${account.name} / ${subagent.path.join(' / ')}${subagent.remark ? `（${subagent.remark}）` : ''}：进入 ${notification.level > 0 ? '+' : ''}${(notification.level * subagent.alertStep).toLocaleString('zh-CN')} 档位${notification.combined ? `（合并 ${notification.count} 档）` : ''}`, account.id);
        } catch (error) {
          notificationFailed = true;
          const message = `${subagent.name}：${error.message || String(error)}`;
          subagent.alertError = error.message || String(error);
          notificationFailures.push(message);
          this.recordAlertAttempt({
            status: 'failed', accountId: account.id, accountName: account.name,
            agentName: subagent.name, agentPath: subagent.path, value: subagent.value,
            level: notification.level, alertStep: subagent.alertStep, remark: subagent.remark,
            error: subagent.alertError, period,
          });
          this.store.addEvent('error', `${account.name} / ${message}`, account.id);
          break;
        }
      }
      if (confirmed && !quiet && !notificationFailed) {
        this.store.update((data) => {
          const current = data.accounts.find((item) => item.id === accountId);
          if (current?.alertHistory?.period === periodKey) {
            current.alertHistory.agents[alertKey] = recordAlertLevel(current.alertHistory.agents[alertKey], level);
          }
        });
      }
    }
    await this.processDeltaAlerts(account, { ...status, subagents: batch }, period, metric, quiet, notificationFailures);
    return anyTriggered;
  }

  recordAlertAttempt(record) {
    if (typeof this.store.addAlertRecord === 'function') this.store.addAlertRecord(record);
  }

  async sendTelegram(account, value, level, previousLevel, subagentName, alertStep, remark = '', path = [subagentName], period = null, notification = {}) {
    const { botToken, chatId, mode, pairing } = this.store.state.telegram;
    if (mode === 'pairing' && !pairing?.paired) throw new Error('Telegram 配对尚未完成');
    if (mode !== 'pairing' && (!botToken || !chatId || mode !== 'legacy')) throw new Error('请先绑定 Telegram');
    const metric = metricForAccount(account);
    if (!subagentName || !Number.isFinite(alertStep) || alertStep <= 0) throw new Error(`${metric.label}提醒资料不完整`);
    const milestone = level * alertStep;
    const previousMilestone = previousLevel * alertStep;
    const crossedCount = Math.abs(level - previousLevel);
    const firstNewMilestone = (previousLevel + Math.sign(level - previousLevel || level)) * alertStep;
    const direction = value < 0 ? '🔴' : '🔵';
    const signedValue = `${value > 0 ? '+' : ''}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const text = [
      `${direction} ${metric.valueLabel}提醒${notification.initialSummary ? '（首次读取汇总）' : ''}`,
      `账号：${account.name}`,
      metric.usesSubagents ? `${metric.agentLabel || '代理层级'}：${path.join(' / ')}` : `监控项：${metric.label}`,
      remark ? `备注：${remark}` : '',
      period ? `报表区间：${period.start}—${period.end}` : '',
      `${direction} ${metric.valueLabel}：${signedValue}`,
      `当前档位：${milestone > 0 ? '+' : ''}${milestone.toLocaleString('zh-CN')}（从 0 起）`,
      `提醒间隔：每 ${alertStep.toLocaleString('zh-CN')} 一档`,
      previousLevel ? `上次已提醒档位：${previousMilestone > 0 ? '+' : ''}${previousMilestone.toLocaleString('zh-CN')}` : '上次已提醒档位：0',
      crossedCount > 1 ? `本次跨越：${firstNewMilestone > 0 ? '+' : ''}${firstNewMilestone.toLocaleString('zh-CN')} 至 ${milestone > 0 ? '+' : ''}${milestone.toLocaleString('zh-CN')}，共 ${crossedCount} 档（已合并为一条消息）` : '已进入此档位',
      `时间：${new Date().toLocaleString('zh-CN')}`,
    ].filter(Boolean).join('\n');
    if (mode === 'pairing') return this.pairingClient.send(pairing.token, text);
    await this.telegramJson(botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  async sendOperationalTelegram(text) {
    const { botToken, chatId, mode, pairing } = this.store.state.telegram;
    if (mode === 'pairing' && pairing?.paired && pairing.token) return this.pairingClient.send(pairing.token, text);
    if (mode === 'legacy' && botToken && chatId) return this.telegramJson(botToken, 'sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
    });
    throw new Error('Telegram 尚未绑定');
  }

  async testTelegram(input = {}) {
    const pairing = this.store.state.telegram.pairing;
    if (this.store.state.telegram.mode === 'pairing') {
      if (!pairing?.paired || !pairing.token) throw new Error('Telegram 配对尚未完成');
      await this.pairingClient.test(pairing.token);
      this.store.addEvent('success', 'Telegram 测试消息已发送');
      this.onChange();
      return;
    }
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

module.exports = { MonitorService, SiteClient, settlementWeekRange, MAX_DESCENDANT_DEPTH };
