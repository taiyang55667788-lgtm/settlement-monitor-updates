const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

test('security code is visibly entered and both threshold directions are present', () => {
  assert.match(html, /name="securityCode" type="text"/);
  assert.doesNotMatch(html, /name="securityCode" type="password"/);
  assert.match(html, /name="lowerThreshold"/);
  assert.match(html, /name="upperThreshold"/);
});

test('account form clearly starts recognition after saving', () => {
  assert.match(html, />保存并开始识别</);
  assert.match(html, /id="route-preview"/);
});
