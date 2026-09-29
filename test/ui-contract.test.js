const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

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
  assert.match(client, /提醒从 0 起，跨入新档或从高档返回低档都会提醒/);
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
  assert.match(client, /MAX_AGENT_DEPTH = 4/);
  assert.match(client, /第\$\{depth\}级代理/);
  assert.match(main, /MAX_DESCENDANT_DEPTH/);
  assert.match(main, /前 \$\{MAX_DESCENDANT_DEPTH\} 级代理/);
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
  assert.match(html, /\/pair 配对码/);
  assert.match(html, /Cloudflare 服务转发/);
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

test('separates operational status from alert visibility and exposes alert records', () => {
  assert.match(client, /triggered: '运行正常'/);
  assert.match(client, /已达阈值：\$\{reachedCount\} 个/);
  assert.match(client, /thresholdProgress/);
  assert.match(client, /recentAlert/);
  assert.match(html, /data-view="alerts"/);
  assert.match(html, /id="alert-records"/);
});

test('offers a stable latest-version download page in software update settings', () => {
  const url = 'https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest';
  assert.match(html, /id="latest-download-url"/);
  assert.match(html, /id="open-latest-download"/);
  assert.match(html, /id="copy-latest-download"/);
  assert.ok(html.includes(url));
  assert.match(client, /openLatestDownloadPage/);
  assert.match(client, /copyLatestDownloadUrl/);
  assert.match(preload, /update:open-download-page/);
  assert.match(preload, /update:copy-download-url/);
  assert.ok(main.includes(url));
});
