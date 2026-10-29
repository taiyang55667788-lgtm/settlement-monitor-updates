const READY = `(() => {
  if (!document.body) return false;
  const visible = el => Boolean(el && el.getClientRects().length);
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const captcha = [...document.images].some(img => {
    const r = img.getBoundingClientRect();
    return img.complete && img.naturalWidth > 0 && r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80;
  });
  return (password && inputs.length >= 3 && captcha)
    || (/报表查询/.test(document.body.innerText) && !/管理员登录/.test(document.body.innerText));
})()`;

// Operation-scoped readiness checks only; no network requests or persistent timers.
async function loadLoginPage(win, url, { timeoutMs = 15000, pollMs = 250 } = {}) {
  const contents = win.webContents;
  const origin = new URL(url).origin;
  let deadline, poll, finished = false, committed = false, domReady = false, probing = false;
  let complete, fail;
  const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const finish = error => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline); clearTimeout(poll);
    contents.removeListener('did-navigate', navigated);
    contents.removeListener('dom-ready', ready);
    if (error) fail(error); else complete();
  };
  const navigated = (_event, target) => {
    domReady = false;
    try { committed = new URL(target).origin === origin; } catch { committed = false; }
  };
  const ready = () => { domReady = true; };
  const probe = async () => {
    if (finished) return;
    if (committed && domReady && !probing) {
      probing = true;
      try {
        // webContents.executeJavaScript can wait for did-finish-load; the live
        // main frame can inspect DOM-ready content while an iframe is still loading.
        const frame = contents.mainFrame || contents;
        if (new URL(contents.getURL()).origin === origin && await frame.executeJavaScript(READY, true) && !finished) {
          // Release later webContents login probes from the unfinished page load.
          // The committed DOM and cookies remain; no login submission is made here.
          finish();
          try { contents.stop(); } catch {}
        }
      } catch {} finally { probing = false; }
    }
    if (!finished) poll = setTimeout(probe, pollMs);
  };
  contents.on('did-navigate', navigated);
  contents.on('dom-ready', ready);
  deadline = setTimeout(() => {
    finish(Object.assign(new Error(`登录页加载超时：${url}`), { code: 'LOGIN_PAGE_TIMEOUT' }));
    try { contents.stop(); } catch {}
  }, timeoutMs);
  try {
    Promise.resolve(win.loadURL(url)).then(() => finish(), error => {
      // A redirect may abort the initial URL; only validated committed content can recover it.
      if (!/ERR_ABORTED/.test(String(error?.message || error))) finish(error);
    });
    void probe();
  } catch (error) { finish(error); }
  return result;
}

module.exports = { loadLoginPage };
