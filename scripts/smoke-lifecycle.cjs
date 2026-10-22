const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { AppExit } = require('../electron/app-exit');
const { SafeMaintenance, CACHE_LIMIT } = require('../electron/safe-maintenance');
const deadline = setTimeout(() => { console.error('Lifecycle smoke timed out'); app.exit(1); }, 15000);
let root, server;
app.whenReady().then(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-lifecycle-smoke-'));
  server = http.createServer((req, res) => { res.setHeader('cache-control', 'public,max-age=3600'); res.end('<html><body>safe cleanup fixture</body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition(`lifecycle-smoke-${Date.now()}`);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(origin);
  await ses.cookies.set({ url: origin, name: 'loginFixture', value: 'retain' });
  await win.webContents.executeJavaScript(`localStorage.setItem('reminderFixture', 'retain')`);
  const protectedState = { accounts: [{ password: 'fixture', alertHistory: { currentLevel: 3 } }], notificationOutbox: [{ id: 'pending' }], commandReplies: [{ text: 'pending reply' }] };
  const store = { state: structuredClone(protectedState), update(fn) { fn(this.state); }, addEvent() {}, save() { this.saved = structuredClone(this.state); } };
  const cleanup = new SafeMaintenance({ userData: root, store, idle: () => true, sessions: () => [{ getCacheSize: async () => CACHE_LIMIT + 1, clearCache: () => ses.clearCache() }] });
  await cleanup.run();
  assert.equal(store.state.safeMaintenance.caches, 1);
  assert.equal((await ses.cookies.get({ url: origin, name: 'loginFixture' }))[0].value, 'retain');
  assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem('reminderFixture')`), 'retain');
  for (const key of Object.keys(protectedState)) assert.deepEqual(store.state[key], protectedState[key]);
  const hidden = new BrowserWindow({ show: false }); const draw = new BrowserWindow({ show: false });
  let stopped = false;
  const exit = new AppExit({ app, monitor: { stop() { stopped = true; } }, updater: { stop() {} }, store,
    windows: () => BrowserWindow.getAllWindows(), confirm: () => ({ response: 0, checkboxChecked: true }), error: message => { throw Error(message); } });
  exit.attach(win);
  app.on('will-quit', () => {
    assert.equal(stopped, true); assert.equal(exit.quitting, true); assert.equal(hidden.isDestroyed(), true); assert.equal(draw.isDestroyed(), true);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    for (const key of Object.keys(protectedState)) assert.deepEqual(store.saved[key], protectedState[key]);
    clearTimeout(deadline); server.close(); fs.rmSync(root, { recursive: true, force: true });
    console.log('Safe maintenance and complete-exit desktop smoke passed: cookies, site storage, pending replies and alert state preserved; hidden windows destroyed');
  });
  win.close();
}).catch(error => { console.error(error.stack); clearTimeout(deadline); server?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); app.exit(1); });
