const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeNavigationUrl,
  partitionForAccount,
  isRedirectAbort,
  isTransientScriptError,
  selectFastestRoute,
  loginSubmissionScript,
  loginPrefillScript,
  selectCaptchaCandidate,
  isCredentialFailure,
  loginFailureScript,
} = require('../electron/navigation');

test('adds https to a bare navigation domain', () => {
  assert.equal(normalizeNavigationUrl('166.tt'), 'https://166.tt');
  assert.equal(normalizeNavigationUrl(' http://example.test/path '), 'http://example.test/path');
});

test('gives every main account an isolated persistent browser session', () => {
  assert.equal(partitionForAccount('account-a'), 'persist:settlement-monitor-account-a');
  assert.notEqual(partitionForAccount('account-a'), partitionForAccount('account-b'));
});

test('recognizes page navigation script interruptions', () => {
  assert.equal(isTransientScriptError(new Error('Script failed to execute, this normally means an error was thrown')), false);
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
    constructor(type = 'text', name = '') { this.type = type; this.name = name; this.storedValue = ''; }
    set value(value) { this.storedValue = value; }
    get value() { return this.storedValue; }
    dispatchEvent() {}
    getAttribute() { return ''; }
    focus() { this.focused = true; }
  }
  const inputs = [new MockInput('text', 'captcha'), new MockInput('password', 'password'), new MockInput('text', 'username')];
  let clicked = false;
  const button = { innerText: '登 录', click: () => { clicked = true; } };
  const document = { querySelectorAll: (selector) => selector === 'input' ? inputs : [button] };
  const FakeEvent = class {};
  const fakeWindow = { alert() {} };
  const run = new Function('document', 'window', 'HTMLInputElement', 'Event', `return ${loginSubmissionScript('agent01', 'pass01', '4821')};`);
  run(document, fakeWindow, MockInput, FakeEvent);
  assert.deepEqual(inputs.map((input) => input.value), ['4821', 'pass01', 'agent01']);
  assert.equal(clicked, true);
});

test('submits through the real input type=button login control', () => {
  class MockInput {
    constructor(type, name, value = '') { this.type = type; this.name = name; this.value = value; }
    dispatchEvent() {}
    getAttribute() { return ''; }
  }
  const inputs = [new MockInput('text', 'account'), new MockInput('password', 'password'), new MockInput('text', 'code')];
  let clicked = false;
  const login = { type: 'button', value: '登 录', innerText: '', click: () => { clicked = true; } };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === 'input') return inputs;
      assert.match(selector, /input\[type=button\]/);
      return [login];
    },
  };
  const run = new Function('document', 'window', 'HTMLInputElement', 'Event', `return ${loginSubmissionScript('agent01', 'pass01', '4821')};`);
  run(document, {}, MockInput, class {});
  assert.equal(clicked, true);
});

test('prefills credentials without submitting for manual in-app viewing', () => {
  class MockInput {
    constructor(type, name) { this.type = type; this.name = name; this.storedValue = ''; }
    set value(value) { this.storedValue = value; }
    get value() { return this.storedValue; }
    dispatchEvent() {}
    getAttribute() { return ''; }
    focus() { this.focused = true; }
  }
  const inputs = [new MockInput('text', 'username'), new MockInput('password', 'password'), new MockInput('text', 'captcha')];
  let clicked = false;
  const document = { querySelectorAll: (selector) => selector === 'input' ? inputs : [{ innerText: '登录', click: () => { clicked = true; } }] };
  const run = new Function('document', 'HTMLInputElement', 'Event', `return ${loginPrefillScript('agent01', 'pass01')};`);
  run(document, MockInput, class {});
  assert.deepEqual(inputs.map((input) => input.value), ['agent01', 'pass01', '']);
  assert.equal(inputs[2].focused, true);
  assert.equal(clicked, false);
});

test('chooses captcha OCR consensus and respects the expected length', () => {
  assert.equal(selectCaptchaCandidate([
    { text: '12 34', confidence: 45 },
    { text: '1234', confidence: 40 },
    { text: '1284', confidence: 80 },
  ], 4), '1234');
  assert.equal(selectCaptchaCandidate([{ text: '12345', confidence: 99 }, { text: '4321', confidence: 50 }], 4), '4321');
  assert.equal(selectCaptchaCandidate([{ text: '12', confidence: 99 }]), '');
});

test('distinguishes credential errors from captcha errors', () => {
  assert.equal(isCredentialFailure('账号或密码错误'), true);
  assert.equal(isCredentialFailure('该用户已被锁定'), true);
  assert.equal(isCredentialFailure('验证码错误，请重新输入'), false);
});

test('reads a visible website login failure message', () => {
  const message = {
    innerText: '验证码错误，请重新输入',
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const document = {
    body: { innerText: '账号\n密码\n验证码错误，请重新输入' },
    querySelectorAll: () => [message],
  };
  const run = new Function('document', 'window', 'getComputedStyle', `return ${loginFailureScript()};`);
  const result = run(document, {}, () => ({ display: 'block', visibility: 'visible' }));
  assert.equal(result, '验证码错误，请重新输入');
});
