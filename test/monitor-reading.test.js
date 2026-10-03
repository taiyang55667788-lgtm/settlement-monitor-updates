const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteClient } = require('../electron/monitor');

test('blank windows skip JavaScript login probing entirely', async () => {
  for (const url of ['', 'about:blank']) {
    const client = new SiteClient({}, {});
    client.window = { webContents: { getURL: () => url, executeJavaScript() { throw new Error('must not probe blank document'); } } };
    assert.equal(await client.isLoggedIn(), false);
  }
});

test('an unresponsive session probe has its own timeout and is not swallowed by login', async () => {
  const client = new SiteClient({}, {}); client.sessionCheckTimeoutMs = 5;
  client.window = { webContents: { getURL: () => 'https://example.com', executeJavaScript: () => new Promise(() => {}) } };
  await assert.rejects(client.login('https://example.com'), { code: 'SESSION_CHECK_TIMEOUT' });
  assert.equal(client.status.stage, '正在检查登录会话');
});

test('session timeout destroys the old page before rebuilding, with only one retry', async () => {
  for (const alwaysFail of [false, true]) {
    const client = new SiteClient({}, {}); const sequence = []; let calls = 0;
    client.window = { isDestroyed: () => false, destroy() { sequence.push('destroy'); } };
    client.open = async () => { sequence.push('open'); client.window = { isDestroyed: () => false, destroy() {} }; };
    client.readThisWeekSettlementAttempt = async () => {
      sequence.push('read'); calls++;
      if (calls === 1 || alwaysFail) throw Object.assign(new Error('session timeout'), { code: 'SESSION_CHECK_TIMEOUT' });
      return { agents: [] };
    };
    if (alwaysFail) await assert.rejects(client.readThisWeekSettlement(), { code: 'SESSION_CHECK_TIMEOUT' });
    else assert.deepEqual(await client.readThisWeekSettlement(), { agents: [] });
    assert.deepEqual(sequence, ['read', 'destroy', 'open', 'read']);
    assert.equal(client.ownsWindow, true);
  }
});

test('cancelled reads cannot rebuild a page after their outer watchdog fires', async () => {
  const client = new SiteClient({}, {});
  client.readThisWeekSettlementAttempt = async () => {
    client.cancelled = true;
    throw Object.assign(new Error('timeout'), { code: 'SESSION_CHECK_TIMEOUT' });
  };
  client.open = () => { throw new Error('must not resurrect cancelled read'); };
  await assert.rejects(client.readThisWeekSettlement(), { code: 'SESSION_CHECK_TIMEOUT' });
});

test('recovery loads the known site before the second session probe', async () => {
  const client = new SiteClient({}, { agentUrl: 'https://example.com/report' });
  let url = ''; let calls = 0;
  client.window = { isDestroyed: () => false, destroy() {} };
  client.open = async () => {
    client.window = { async loadURL(target) { url = target; }, webContents: { getURL: () => url } };
  };
  client.readThisWeekSettlementAttempt = async () => {
    if (++calls === 1) throw Object.assign(new Error('timeout'), { code: 'SESSION_CHECK_TIMEOUT' });
    assert.equal(url, 'https://example.com/report');
    return { agents: [] };
  };
  await client.readThisWeekSettlement();
  assert.equal(calls, 2);
});

test('report wait fails promptly on a visible login form rather than waiting thirty seconds', async () => {
  const client = new SiteClient({}, {});
  const frame = { isDestroyed: () => false, executeJavaScript: async script => script.includes('input[type=password]') };
  client.window = { webContents: { mainFrame: frame } };
  await assert.rejects(client.waitForReportResult('false'), /登录状态已失效/);
});

test('unchanged healthy report retries once then ends the branch, but errors and logout remain failures', async () => {
  const realNow = Date.now;
  let tick = 0;
  Date.now = () => (tick += 13000);
  try {
    for (const scenario of ['healthy', 'logout', 'loading', 'site-error']) {
      const client = new SiteClient({}, {});
      let clicks = 0;
      const frame = { isDestroyed: () => false, executeJavaScript: async script => {
        if (script.includes('control.click()')) { clicks++; return { before: 'unchanged report' }; }
        return true;
      } };
      client.window = { webContents: { mainFrame: frame, isLoading: () => scenario === 'loading' } };
      client.readLoginFailure = async () => scenario === 'site-error' ? '系统错误' : '';
      client.isLoggedIn = async () => scenario !== 'logout';
      client.verifyReportPeriod = async depth => assert.equal(depth, 1);
      if (scenario === 'healthy') {
        assert.equal(await client.drillIntoAgent('a', 2), false);
        assert.equal(clicks, 2);
      } else {
        await assert.rejects(client.drillIntoAgent('a', 2));
        assert.equal(clicks, 1);
      }
    }
  } finally { Date.now = realNow; }
});

test('four-level chain reuses the current report and only resets for a sibling', async () => {
  const client = new SiteClient({}, {});
  client.reportPeriod = { start: '2026-09-28', end: '2026-10-04' };
  client.currentReportPath = [];
  let roots = 0;
  const clicks = [];
  client.openThisWeekReport = async () => { roots++; };
  client.drillIntoAgent = async name => { clicks.push(name); return true; };
  client.readCurrentSettlement = async () => ({ agents: [] });
  for (const path of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
    await client.readDescendantSettlement(path);
  }
  assert.equal(roots, 0);
  assert.deepEqual(clicks, ['a', 'b', 'c']);
  await client.readDescendantSettlement(['sibling']);
  assert.equal(roots, 1);
  assert.deepEqual(client.currentReportPath, ['sibling']);
});

test('failed drill invalidates navigation path before the next branch', async () => {
  const client = new SiteClient({}, {});
  client.currentReportPath = [];
  let roots = 0;
  client.openThisWeekReport = async () => { roots++; };
  client.drillIntoAgent = async () => { throw new Error('页面超时'); };
  await assert.rejects(client.readDescendantSettlement(['a']), /超时/);
  assert.equal(client.currentReportPath, null);
  client.drillIntoAgent = async () => false;
  await client.readDescendantSettlement(['b']);
  assert.equal(roots, 1);
});

test('valid 166 session skips navigation to the login page', async () => {
  const client = new SiteClient({}, {});
  client.isLoggedIn = async () => true;
  client.window = { loadURL() { throw new Error('不应重复加载登录页'); } };
  await client.login('https://example.com');
});

test('network timeout on a report retries without another login or route discovery', async () => {
  const client=new SiteClient({}, {agentUrl:'https://example.com'});let logins=0;let queries=0;
  client.login=async()=>{logins++;};client.discoverAgentUrl=async()=>{throw Error('不应切换线路');};
  client.openThisWeekReport=async()=>{if(++queries===1)throw Error('本周报表网络超时');};
  client.readCurrentSettlement=async()=>({value:0,agents:[]});
  await client.readThisWeekSettlement();assert.equal(logins,1);assert.equal(queries,2);
});

test('captcha or credential errors do not trigger route discovery and another login', async () => {
  for (const message of ['验证码自动识别连续三次未通过', '密码错误']) {
    const client = new SiteClient({}, { agentUrl: 'https://example.com' });
    let discoveries = 0;
    client.login = async () => { throw new Error(message); };
    client.discoverAgentUrl = async () => { discoveries++; };
    await assert.rejects(client.readThisWeekSettlement(), { message });
    assert.equal(discoveries, 0);
  }
});
