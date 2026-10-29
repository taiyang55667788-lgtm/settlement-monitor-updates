const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadLoginPage } = require('../electron/login-page-load');
function fixture({ ready = true, commit = true, target = 'https://site.example/login', hangProbe = false } = {}) {
  const webContents = new EventEmitter();
  let stopped = false, probes = 0;
  webContents.getURL = () => target;
  webContents.executeJavaScript = async () => { probes++; return hangProbe ? new Promise(() => {}) : ready; };
  webContents.stop = () => { stopped = true; };
  return { webContents, loadURL() {
    if (commit) { webContents.emit('did-navigate', {}, target); webContents.emit('dom-ready'); }
    return new Promise(() => {});
  }, stats: () => ({ stopped, probes }) };
}
test('validated committed login content proceeds despite hanging subresource completion', async () => {
  const win = fixture();
  await loadLoginPage(win, 'https://site.example/login', { timeoutMs: 40, pollMs: 2 });
  assert.equal(win.stats().stopped, true);
  assert.equal(win.webContents.listenerCount('did-navigate'), 0);
});
test('blank, old, foreign and unresponsive documents cannot pass readiness', async () => {
  for (const options of [{ ready: false }, { commit: false }, { target: 'https://foreign.example' }, { hangProbe: true }]) {
    const win = fixture(options);
    await assert.rejects(loadLoginPage(win, 'https://site.example/login', { timeoutMs: 10, pollMs: 2 }), { code: 'LOGIN_PAGE_TIMEOUT' });
    assert.equal(win.stats().stopped, true);
    assert.equal(win.webContents.listenerCount('did-navigate'), 0);
  }
});
test('navigation errors terminate promptly and clean up readiness listeners', async () => {
  const win = fixture(); win.loadURL = async () => { throw new Error('ERR_CONNECTION_REFUSED'); };
  await assert.rejects(loadLoginPage(win, 'https://site.example/login'), /ERR_CONNECTION_REFUSED/);
  assert.equal(win.webContents.listenerCount('did-navigate'), 0);
});
