function normalizeNavigationUrl(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function partitionForAccount(accountId) {
  return `persist:settlement-monitor-${String(accountId)}`;
}

function isRedirectAbort(error) {
  return error?.code === 'ERR_ABORTED'
    || error?.errno === -3
    || /ERR_ABORTED|\(-3\)/i.test(error?.message || '');
}

function isTransientScriptError(error) {
  return isRedirectAbort(error)
    || /Script failed to execute|Execution context was destroyed|detached frame|frame was detached/i.test(error?.message || '');
}

function selectFastestRoute(rows) {
  const routes = (rows || [])
    .map((row) => {
      const match = String(row.label || '').match(/(\d+)\s*ms/i);
      return { text: String(row.text || '').trim(), speed: Number(match?.[1] || 99999) };
    })
    .filter((item) => /^https?:\/\//i.test(item.text))
    .sort((a, b) => a.speed - b.speed);
  return { routes, selected: routes[0] || null };
}

function loginFormScript(username, password, captcha, submitForm) {
  const literal = (value) => JSON.stringify(String(value));
  return `(() => {
    const inputs = [...document.querySelectorAll('input')].filter(el => !['button','submit','hidden'].includes(el.type));
    if (inputs.length < 3) throw new Error('登录表单输入框不足');
    const hint = el => [el.name, el.id, el.placeholder, el.getAttribute?.('aria-label')].filter(Boolean).join(' ').toLowerCase();
    const matches = (el, words) => words.some(word => hint(el).includes(word));
    const passwordInput = inputs.find(el => el.type === 'password') || inputs[1];
    const usernameInput = inputs.find(el => matches(el, ['account', 'username', 'user', 'loginname', '账号', '用户']))
      || inputs.find(el => el !== passwordInput && !matches(el, ['captcha', 'verify', 'checkcode', 'code', '验证码']))
      || inputs[0];
    const captchaInput = inputs.find(el => matches(el, ['captcha', 'verify', 'checkcode', '验证码']))
      || inputs.find(el => el !== usernameInput && el !== passwordInput)
      || inputs[2];
    if (!usernameInput || !passwordInput || !captchaInput) throw new Error('无法定位登录表单输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const set = (el, value) => {
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(usernameInput, ${literal(username)});
    set(passwordInput, ${literal(password)});
    if (${Boolean(captcha)}) set(captchaInput, ${literal(captcha)});
    if (!${Boolean(submitForm)}) {
      captchaInput.focus();
      return true;
    }
    window.__settlementMonitorLoginError = '';
    window.alert = message => { window.__settlementMonitorLoginError = String(message || '登录失败'); };
    const controls = [...document.querySelectorAll('button, input[type=submit], a')];
    const submit = controls.find(el => [...(el.innerText || el.value || '')].filter(char => char.trim()).join('') === '登录');
    if (!submit) throw new Error('没有登录按钮');
    submit.click();
  })()`;
}

function loginSubmissionScript(username, password, captcha) {
  return loginFormScript(username, password, captcha, true);
}

function loginPrefillScript(username, password) {
  return loginFormScript(username, password, '', false);
}

function selectCaptchaCandidate(candidates, expectedLength = 0) {
  const requiredLength = Number(expectedLength) >= 4 && Number(expectedLength) <= 6 ? Number(expectedLength) : 0;
  const normalized = (candidates || [])
    .map((candidate) => ({
      digits: String(candidate?.text || candidate?.digits || '').replace(/\D/g, '').slice(0, 6),
      confidence: Number(candidate?.confidence) || 0,
    }))
    .filter((candidate) => requiredLength
      ? candidate.digits.length === requiredLength
      : candidate.digits.length >= 4 && candidate.digits.length <= 6);
  const scores = new Map();
  for (const candidate of normalized) {
    const current = scores.get(candidate.digits) || { count: 0, confidence: 0 };
    current.count += 1;
    current.confidence = Math.max(current.confidence, candidate.confidence);
    scores.set(candidate.digits, current);
  }
  return [...scores.entries()]
    .sort((a, b) => (b[1].confidence + b[1].count * 40) - (a[1].confidence + a[1].count * 40))[0]?.[0] || '';
}

function isCredentialFailure(message) {
  const text = String(message || '');
  return /(账号|用户|用户名|密码).*(错误|不正确|无效|不存在|停用|冻结|锁定|不符)/.test(text)
    || /(错误|不正确|无效|不存在|停用|冻结|锁定|不符).*(账号|用户|用户名|密码)/.test(text);
}

function loginFailureScript() {
  return `(() => {
    if (window.__settlementMonitorLoginError) return String(window.__settlementMonitorLoginError).trim();
    const failureWords = ['错误', '失败', '不正确', '无效', '不存在', '过期', '锁定', '冻结', '停用', '不符', '请重新', '不能为空'];
    const selectors = '[role=alert], .error, .errors, .alert, .message, .msg, .tips, [class*=error], [class*=message]';
    const candidates = [...document.querySelectorAll(selectors)]
      .filter(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .map(el => (el.innerText || el.textContent || '').trim())
      .concat((document.body?.innerText || '').split(String.fromCharCode(10)).map(line => line.trim()))
      .filter(text => text.length >= 2 && text.length <= 120 && failureWords.some(word => text.includes(word)));
    return candidates.sort((a, b) => a.length - b.length)[0] || '';
  })()`;
}

module.exports = {
  normalizeNavigationUrl,
  partitionForAccount,
  isRedirectAbort,
  isTransientScriptError,
  selectFastestRoute,
  loginSubmissionScript,
  loginPrefillScript,
  selectCaptchaCandidate,
  isCredentialFailure,
  loginFailureScript,
};
