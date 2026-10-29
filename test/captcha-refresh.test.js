const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshLoadedCaptcha } = require('../electron/captcha-refresh');

test('refresh waits for loaded changed pixels, not merely an old complete image', async () => {
  let calls = 0, clicks = 0, waits = 0;
  const result = await refreshLoadedCaptcha({
    snapshot: async () => ++calls < 3 ? { ready: true, fingerprint: 'old' } : calls === 3 ? { ready: false } : { ready: true, fingerprint: 'new' },
    click: async () => { clicks++; }, wait: async () => { waits++; },
  });
  assert.equal(result.fingerprint, 'new'); assert.equal(clicks, 1); assert.equal(waits, 3);
});
test('loading failure refreshes only a finite number of times and yields a network-load code', async () => {
  let clicks = 0;
  await assert.rejects(refreshLoadedCaptcha({ snapshot: async () => ({ ready: false }), click: async () => { clicks++; }, wait: async () => {}, polls: 2 }), { code: 'CAPTCHA_IMAGE_LOAD_TIMEOUT' });
  assert.equal(clicks, 3);
});
test('unchanged images are never accepted or submitted, cancellation stops refresh', async () => {
  await assert.rejects(refreshLoadedCaptcha({ snapshot: async () => ({ ready: true, fingerprint: 'same' }), click: async () => {}, wait: async () => {}, polls: 1 }), { code: 'CAPTCHA_IMAGE_LOAD_TIMEOUT' });
  let clicks = 0;
  await assert.rejects(refreshLoadedCaptcha({ snapshot: async () => ({}), click: async () => { clicks++; }, wait: async () => {}, cancelled: () => true }), { code: 'READ_INTERRUPTED' });
  assert.equal(clicks, 0);
});
