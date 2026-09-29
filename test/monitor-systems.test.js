const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SYSTEM_166,
  SYSTEM_CROWN,
  CROWN_URLS,
  accountSystemId,
  accountBaseUrl,
  crownLoginEntry,
  crownUrl,
  metricForAccount,
} = require('../electron/monitor-systems');

test('legacy accounts remain on the 166 system while Crown results migrate to Crown', () => {
  assert.equal(accountSystemId({}), SYSTEM_166);
  assert.equal(accountSystemId({ monitorMetric: 'general-agent-result' }), SYSTEM_CROWN);
  assert.equal(accountBaseUrl({ systemType: SYSTEM_166 }), 'https://166.tt');
});

test('Crown allows only the three configured hosts', () => {
  assert.equal(crownUrl('https://ag.hga030.com/path'), 'https://ag.hga030.com');
  assert.equal(crownUrl('https://ag.hga030.com.attacker.example'), CROWN_URLS[0]);
  assert.equal(crownUrl('https://unknown.example'), CROWN_URLS[0]);
});

test('all Crown login entries read the same general-agent detail metric', () => {
  assert.equal(crownLoginEntry('login-1').label, '登入一');
  assert.deepEqual(crownLoginEntry('login-1').aliases, ['登入一', '登录一', '登入1', '登录1']);
  assert.equal(metricForAccount({ systemType: SYSTEM_CROWN, crownLoginEntry: 'login-1' }).id, 'general-agent-result');
  assert.equal(metricForAccount({ systemType: SYSTEM_CROWN, crownLoginEntry: 'login-2' }).id, 'general-agent-result');
  assert.equal(metricForAccount({ systemType: SYSTEM_CROWN, crownLoginEntry: 'login-3' }).id, 'general-agent-result');
});
