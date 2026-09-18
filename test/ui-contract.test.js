const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');

test('security code is visibly entered', () => {
  assert.match(html, /name="securityCode" type="text"/);
  assert.doesNotMatch(html, /name="securityCode" type="password"/);
});

test('from-zero interval inputs exist only on discovered subagents', () => {
  assert.doesNotMatch(html, /name="lowerThreshold"/);
  assert.doesNotMatch(html, /name="upperThreshold"/);
  assert.doesNotMatch(client, /data-field="lowerThreshold"/);
  assert.doesNotMatch(client, /data-field="upperThreshold"/);
  assert.match(client, /data-field="alertStep"/);
  assert.match(client, /提醒从 0 起，正负每档每周各一次/);
  assert.match(html, /读取直属代理及直属代理的下级/);
  assert.match(client, /data-field="remark"/);
  assert.match(client, /data-action="expand-subagent"/);
  assert.match(client, /<table class="agent-table">/);
  assert.match(client, /<tbody class="child-group"/);
  assert.match(client, /getAccountSecurityCode\(account\.id\)/);
});

test('account form clearly starts recognition after saving', () => {
  assert.match(html, />保存并开始识别</);
  assert.match(html, /id="route-preview"/);
});

test('offers in-app viewing for manual captcha login', () => {
  assert.match(html, /id="view-account"[^>]*>盘内查看</);
  assert.match(client, /data-action="view"/);
  assert.match(client, /openAccountView/);
});

test('Telegram test sends the currently entered form values', () => {
  assert.match(client, /testTelegram\(values\)/);
  assert.match(html, /id="pair-start"/);
  assert.match(html, /id="telegram-form"/);
});
