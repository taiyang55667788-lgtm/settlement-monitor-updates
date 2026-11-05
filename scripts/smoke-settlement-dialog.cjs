const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const { guardSettlementDialogs } = require('../electron/settlement-dialog');
const timeout = setTimeout(() => { console.error('Settlement dialog smoke timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  let closed = 0;
  const server = http.createServer((req, res) => res.end(req.url === '/frame' ? '<body>frame</body>' : '<body><iframe src="/frame"></iframe></body>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const guard = await guardSettlementDialogs(win, () => { closed++; });
  assert.equal(await guardSettlementDialogs(win, () => { closed++; }), guard);
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await win.webContents.executeJavaScript(`for(let i=0;i<3;i++) window.frames[0].alert('正在结算中，请稍等...'); document.body.dataset.done='yes'`);
  assert.equal(closed, 3);
  assert.equal(await win.webContents.executeJavaScript('document.body.dataset.done'), 'yes');
  await assert.rejects(guard.run(async () => 42), { code: 'SETTLEMENT_DIALOG_PENDING' });
  // Unknown prompts must not be accepted by the guard. Dismiss only in this fixture.
  const listener = (_e, method, params) => {
    if (method === 'Page.javascriptDialogOpening' && params.type === 'confirm') void win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
  };
  win.webContents.debugger.on('message', listener);
  assert.equal(await win.webContents.executeJavaScript(`confirm('是否删除数据？')`), false);
  assert.equal(closed, 3);
  win.destroy(); server.close(); clearTimeout(timeout);
  console.log('Settlement dialog smoke passed: three native alerts acknowledged, page resumed, unknown confirmation not accepted');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
