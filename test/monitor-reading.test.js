const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteClient } = require('../electron/monitor');

test('five-level chain reuses the current report and only resets for a sibling', async () => {
  const client = new SiteClient({}, {});
  client.reportPeriod = { start: '2026-09-28', end: '2026-10-04' };
  client.currentReportPath = [];
  let roots = 0;
  const clicks = [];
  client.openThisWeekReport = async () => { roots++; };
  client.drillIntoAgent = async name => { clicks.push(name); return true; };
  client.readCurrentSettlement = async () => ({ agents: [] });
  for (const path of [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
    await client.readDescendantSettlement(path);
  }
  assert.equal(roots, 0);
  assert.deepEqual(clicks, ['a', 'b', 'c', 'd']);
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
