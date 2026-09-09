function normalizeNavigationUrl(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
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

function loginSubmissionScript(username, password, captcha) {
  const literal = (value) => JSON.stringify(String(value));
  return `(() => {
    const inputs = [...document.querySelectorAll('input')].filter(el => !['button','submit','hidden'].includes(el.type));
    if (inputs.length < 3) throw new Error('登录表单输入框不足');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const set = (el, value) => {
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(inputs[0], ${literal(username)});
    set(inputs[1], ${literal(password)});
    set(inputs[2], ${literal(captcha)});
    const controls = [...document.querySelectorAll('button, input[type=submit], a')];
    const submit = controls.find(el => [...(el.innerText || el.value || '')].filter(char => char.trim()).join('') === '登录');
    if (!submit) throw new Error('没有登录按钮');
    submit.click();
  })()`;
}

module.exports = { normalizeNavigationUrl, isRedirectAbort, isTransientScriptError, selectFastestRoute, loginSubmissionScript };
