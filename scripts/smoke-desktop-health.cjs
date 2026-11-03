const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { SecureStore } = require('../electron/store');
const { DesktopHealth } = require('../electron/desktop-health');
const { AppExit } = require('../electron/app-exit');
let root, health;
const deadline = setTimeout(() => { console.error('Desktop crash recovery smoke timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-desktop-health-'));
  const store = new SecureStore(root);
  const protectedState = { notificationOutbox: [{ id: 'pending', text: 'fixture' }], commandReplies: [{ id: 'reply' }], accounts: [] };
  Object.assign(store.state, structuredClone(protectedState)); store.save();
  let stops = 0, rebuilds = 0, current, recovered, firstVerified, verificationFailed, omitAck = false;
  const recovery = new Promise(resolve => { recovered = resolve; });
  const initialVerification = new Promise(resolve => { firstVerified = resolve; });
  const failedVerification = new Promise(resolve => { verificationFailed = resolve; });
  ipcMain.handle('state:get', event => {
    assert.equal(event.sender, current.webContents);
    health.stateServed(event.sender);
    return { readyToken: health.challenge(event.sender) };
  });
  ipcMain.handle('desktop:ready', (event, token) => health.acknowledge(event.sender, token));
  const exit = new AppExit({ app, monitor: { stop() { stops++; } }, updater: { stop() {} }, store,
    windows: () => BrowserWindow.getAllWindows(), confirm: () => ({ response: 0 }), error: message => { throw Error(message); }, onExitPrepared: () => health.end() });
  function create() {
    current = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    exit.attach(current); health.attach(current);
    const win = current;
    const html = `<body><div id="state"></div><script>window.monitorApi.getState().then(state => {document.querySelector('#state').textContent='fixture state rendered'; if (${!omitAck}) requestAnimationFrame(() => requestAnimationFrame(() => window.monitorApi.confirmDesktopReady(state.readyToken)));});</script></body>`;
    const ready = win.loadURL('data:text/html,' + encodeURIComponent(html));
    return { win, ready };
  }
  health = new DesktopHealth({ store, metrics: () => app.getAppMetrics(), quitting: () => exit.quitting,
    verified: () => { if (rebuilds) recovered(current); else firstVerified(); },
    verificationFailed: () => verificationFailed(),
    rebuild: previous => {
      rebuilds++; const next = create(); previous.destroy();
      next.ready.catch(error => { console.error(error); app.exit(1); });
    } });
  health.start();
  const first = create(); await first.ready; await initialVerification;
  const oldPid = first.win.webContents.getOSProcessId();
  first.win.webContents.forcefullyCrashRenderer();
  const replacement = await recovery;
  assert.equal(rebuilds, 1); assert.equal(stops, 0);
  assert.notEqual(replacement.webContents.getOSProcessId(), oldPid);
  assert.ok(health.snapshot().events.some(event => event.type === 'renderer-gone'));
  for (const key of Object.keys(protectedState)) assert.deepEqual(store.state[key], protectedState[key]);
  const reopened = new SecureStore(root); reopened.load();
  assert.ok(reopened.state.desktopDiagnostics.events.some(event => event.type === 'renderer-gone'));
  assert.ok(!fs.readFileSync(store.filePath, 'utf8').includes('renderer-gone'));
  assert.equal(health.pending, null);
  assert.equal(await replacement.webContents.executeJavaScript('document.querySelector("#state").textContent'), 'fixture state rendered');
  omitAck = true; health.verificationTimeoutMs = 250; health.recover(true);
  await failedVerification;
  assert.equal(health.autoBlocked, true); assert.equal(rebuilds, 2);
  health.recover(false); assert.equal(health.timer, null);
  await current.webContents.executeJavaScript('window.onbeforeunload = () => false; void 0');
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [{ label: '保存并退出监控', click: () => exit.requestExit({ destroyMain: true }) }] }]));
  app.on('will-quit', () => {
    assert.equal(stops, 1); assert.equal(BrowserWindow.getAllWindows().length, 0);
    const final = new SecureStore(root); final.load();
    assert.equal(final.state.desktopDiagnostics.session.cleanExit, true);
    for (const key of Object.keys(protectedState)) assert.deepEqual(final.state[key], protectedState[key]);
    clearTimeout(deadline); fs.rmSync(root, { recursive: true, force: true });
    console.log('Desktop health smoke passed: native renderer crash, bounded UI-only replacement, encrypted restart evidence, native exit ignoring renderer beforeunload, queues retained');
  });
  Menu.getApplicationMenu().items[0].submenu.items[0].click();
}).catch(error => { console.error(error.stack); health?.stop(); clearTimeout(deadline); if (root) fs.rmSync(root, { recursive: true, force: true }); app.exit(1); });
