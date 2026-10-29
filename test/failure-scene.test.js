const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { captureFailureScene, retainedScenes, safeLocation, sceneLoginReason } = require('../electron/failure-scene');

test('only explicit scene messages determine login-loss reason', () => {
  assert.match(sceneLoginReason({ hints: ['other-login'] }), /明确提示其他地方/);
  assert.match(sceneLoginReason({ hints: ['session-expired'] }), /登录超时/);
  assert.equal(sceneLoginReason({ document: 'login-form', hints: [] }), '');
  const scene = retainedScenes([{ at: new Date().toISOString(), phase: 'before-navigation' }])[0];
  assert.equal(scene.phase, 'before-navigation');
});

test('scene capture transfers only categories, never body/title/input secrets or URL tokens', async () => {
  const secret = 'password-secret-91055-report-123456';
  const win = { isDestroyed: () => false, webContents: {
    getURL: () => `https://user:pass@site.example/Member/Login?token=${secret}#${secret}`,
    isLoading: () => true,
    mainFrame: { executeJavaScript: async script => vm.runInNewContext(script, { document: {
      title: `管理员登录 ${secret}`, body: { innerText: `其他地方登录 验证码错误 ${secret}` },
      querySelector: () => ({ value: secret }),
    } }) },
  } };
  const scene = await captureFailureScene(win);
  assert.equal(scene.capture, 'ok'); assert.equal(scene.document, 'login-form');
  assert.equal(scene.title, 'login'); assert.deepEqual(scene.hints, ['other-login', 'captcha-rejected']);
  assert.equal(scene.location, 'https://site.example/Member/Login');
  assert.ok(!JSON.stringify(scene).includes(secret)); assert.ok(!JSON.stringify(scene).includes('user:pass'));
});
test('unresponsive or destroyed windows remain bounded and do not pretend blank-page evidence', async () => {
  const win = { webContents: { getURL: () => 'https://site.example', mainFrame: { executeJavaScript: () => new Promise(() => {}) } } };
  assert.equal((await captureFailureScene(win, { timeoutMs: 5 })).capture, 'timeout');
  assert.equal((await captureFailureScene({ isDestroyed: () => true })).capture, 'unavailable');
});
test('scene storage strictly caps ten records and seven days and drops unknown raw fields', () => {
  const now = Date.now();
  const scenes = Array.from({ length: 13 }, (_, index) => ({ at: new Date(now - index * 1000).toISOString(), location: 'https://site.example/token-secret?password=x', title: 'raw-secret', hints: ['raw-secret', 'service-error'], body: 'raw-secret', phase: 'secret' }));
  scenes.push({ at: new Date(now - 8 * 86400000).toISOString() });
  const retained = retainedScenes(scenes, now);
  assert.equal(retained.length, 10); assert.equal(retained[0].location, 'https://site.example/[path-hidden]');
  assert.ok(!JSON.stringify(retained).includes('secret'));
  assert.equal(safeLocation('file:///Users/private/path'), 'non-web-page');
});
