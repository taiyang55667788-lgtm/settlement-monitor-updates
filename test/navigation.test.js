const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNavigationUrl, partitionForAccount, isRedirectAbort, isTransientScriptError, selectFastestRoute, loginSubmissionScript } = require('../electron/navigation');

test('adds https to a bare navigation domain', () => {
  assert.equal(normalizeNavigationUrl('166.tt'), 'https://166.tt');
  assert.equal(normalizeNavigationUrl(' http://example.test/path '), 'http://example.test/path');
});

test('gives every main account an isolated persistent browser session', () => {
  assert.equal(partitionForAccount('account-a'), 'persist:settlement-monitor-account-a');
  assert.notEqual(partitionForAccount('account-a'), partitionForAccount('account-b'));
});

test('recognizes page navigation script interruptions', () => {
  assert.equal(isTransientScriptError(new Error('Script failed to execute, this normally means an error was thrown')), true);
  assert.equal(isTransientScriptError(new Error('Execution context was destroyed')), true);
  assert.equal(isTransientScriptError(new Error('real selector error')), false);
});

test('recognizes Chromium redirect abort errors', () => {
  assert.equal(isRedirectAbort({ code: 'ERR_ABORTED' }), true);
  assert.equal(isRedirectAbort({ errno: -3 }), true);
  assert.equal(isRedirectAbort(new Error('ERR_ABORTED (-3) loading URL')), true);
  assert.equal(isRedirectAbort(new Error('ERR_NAME_NOT_RESOLVED')), false);
});

test('selects the fastest proxy route from the real page text shape', () => {
  const result = selectFastestRoute([
    { text: 'https://slow.example', label: '代理线路1 https://slow.example 130ms' },
    { text: 'https://fast.example', label: '代理线路2 https://fast.example 40ms' },
    { text: 'javascript:void(0)', label: '代理线路3 10ms' },
  ]);
  assert.deepEqual(result.selected, { text: 'https://fast.example', speed: 40 });
});

test('fills the three login fields and recognizes a spaced login button', () => {
  class MockInput {
    constructor() { this.type = 'text'; this.storedValue = ''; }
    set value(value) { this.storedValue = value; }
    get value() { return this.storedValue; }
    dispatchEvent() {}
  }
  const inputs = [new MockInput(), new MockInput(), new MockInput()];
  let clicked = false;
  const button = { innerText: '登 录', click: () => { clicked = true; } };
  const document = { querySelectorAll: (selector) => selector === 'input' ? inputs : [button] };
  const FakeEvent = class {};
  const run = new Function('document', 'HTMLInputElement', 'Event', `return ${loginSubmissionScript('agent01', 'pass01', '4821')};`);
  run(document, MockInput, FakeEvent);
  assert.deepEqual(inputs.map((input) => input.value), ['agent01', 'pass01', '4821']);
  assert.equal(clicked, true);
});
