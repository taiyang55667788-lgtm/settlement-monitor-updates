const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');

test('security code is visibly entered', () => {
  assert.match(html, /name="securityCode" type="text"/);
  assert.doesNotMatch(html, /name="securityCode" type="password"/);
  assert.match(html, /id="security-code-site-slot"/);
  assert.match(html, /id="security-code-login-slot"/);
  assert.match(client, /皇冠登录安全码/);
  assert.match(client, /166 线路安全码/);
});

test('from-zero interval inputs are shared across both systems', () => {
  assert.doesNotMatch(html, /name="lowerThreshold"/);
  assert.doesNotMatch(html, /name="upperThreshold"/);
  assert.doesNotMatch(client, /data-field="lowerThreshold"/);
  assert.doesNotMatch(client, /data-field="upperThreshold"/);
  assert.match(client, /data-field="alertStep"/);
  assert.match(client, /提醒从 0 起，正负每档每周各一次/);
  assert.match(html, /name="systemType"/);
  assert.match(html, /value="crown"/);
  assert.match(html, /name="crownDomain"/);
  assert.match(html, /name="crownLoginEntry"/);
  assert.match(html, /<option value="login-1">登入一<\/option>/);
  assert.match(html, /<option value="login-2">登入二<\/option>/);
  assert.match(html, /<option value="login-3">登入三<\/option>/);
  assert.match(html, /固定读取本周总代理明细/);
  assert.match(client, /总代理结果/);
  assert.match(client, /总代理实货量/);
  assert.match(client, /data-field="remark"/);
  assert.match(client, /data-action="expand-subagent"/);
  assert.match(client, /<table class="agent-table">/);
  assert.match(client, /<tbody class="child-group"/);
  assert.match(client, /getAccountSecurityCode\(account\.id\)/);
  assert.match(client, /updateSystemFields/);
});

test('account form clearly starts recognition after saving', () => {
  assert.match(html, />保存并开始识别</);
  assert.match(html, /id="route-preview"/);
});

test('offers in-app viewing for manual captcha login', () => {
  assert.match(html, /id="view-account"[^>]*>盘内查看</);
  assert.match(client, /图形验证或验证码时可手动登录/);
  assert.match(client, /data-action="view"/);
  assert.match(client, /openAccountView/);
});

test('Telegram test sends the currently entered form values', () => {
  assert.match(client, /testTelegram\(values\)/);
  assert.match(html, /id="pair-start"/);
  assert.match(html, /id="telegram-form"/);
});

test('exposes alert policy, trend, diagnostics, and encrypted backup controls', () => {
  assert.match(html, /id="alert-policy-form"/);
  assert.match(html, /name="quietStart" type="time"/);
  assert.match(html, /id="export-diagnostics"/);
  assert.match(html, /id="export-backup"/);
  assert.match(html, /id="import-backup"/);
  assert.match(client, /trendChart/);
  assert.match(client, /saveAlertPolicy/);
});
