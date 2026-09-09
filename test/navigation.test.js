const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNavigationUrl, isRedirectAbort } = require('../electron/navigation');

test('adds https to a bare navigation domain', () => {
  assert.equal(normalizeNavigationUrl('166.tt'), 'https://166.tt');
  assert.equal(normalizeNavigationUrl(' http://example.test/path '), 'http://example.test/path');
});

test('recognizes Chromium redirect abort errors', () => {
  assert.equal(isRedirectAbort({ code: 'ERR_ABORTED' }), true);
  assert.equal(isRedirectAbort({ errno: -3 }), true);
  assert.equal(isRedirectAbort(new Error('ERR_ABORTED (-3) loading URL')), true);
  assert.equal(isRedirectAbort(new Error('ERR_NAME_NOT_RESOLVED')), false);
});
