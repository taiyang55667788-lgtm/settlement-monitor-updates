const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettledDraw, observeSettledDraw, parseReportSettlementDraw, parseDrawStateResponse, DRAW_STALE_MS } = require('../electron/draw-trigger');
const { MonitorService, SiteClient } = require('../electron/monitor');

test('parses only an explicitly settled PC28 draw, not the current betting draw', () => {
  assert.equal(parseSettledDraw('<b>3491985期</b> 距封盘：00:44 <span>3491984期开奖：3 0 0</span>'), '3491984');
  assert.equal(parseSettledDraw('3491984期 已开奖 3 0 0'), '3491984');
  assert.equal(parseSettledDraw('3491985期 距封盘 00:44'), null);
});

test('first draw is a baseline; a newer draw schedules once and a reset does not', () => {
  const baseline = observeSettledDraw(null, '3491984', 100, 10);
  assert.equal(baseline.baseline, true);
  const next = observeSettledDraw(baseline.state, '3491985', 200, 10);
  assert.deepEqual({ changed: next.changed, dueAt: next.dueAt }, { changed: true, dueAt: 210 });
  const reset = observeSettledDraw(next.state, '3491900', 300, 10);
  assert.equal(reset.changed, false);
  assert.equal(reset.reset, true);
});

test('site client reads the settled draw from the existing authenticated session only', async () => {
  const client = new SiteClient({ id: 'pc28', systemType: 'system-166' }, { agentUrl: 'https://market.example/Member/Index' });
  const requests = [];
  client.window = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => 'https://market.example/Home/Index',
      session: { fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, text: async () => '<span>3491984期开奖：3 0 0</span>' };
      } },
    },
  };
  assert.equal(await client.readLatestSettledDraw(), '3491984');
  assert.equal(requests[0].url, 'https://market.example/Home/Index');
  assert.equal(requests[0].init.credentials, 'include');
});

test('site client prefers the visible PC28 header before making a fallback request', async () => {
  const client = new SiteClient({ id: 'pc28', systemType: 'system-166' }, { agentUrl: 'https://market.example/Home/Index' });
  let fetched = false;
  client.window = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => 'https://market.example/Home/Index',
      executeJavaScript: async () => '3491985期 距封盘：00:44 3491984期开奖：3 0 0',
      session: { fetch: async () => { fetched = true; throw new Error('should not fetch'); } },
    },
  };
  assert.equal(await client.readLatestSettledDraw(), '3491984');
  assert.equal(fetched, false);
});

test('settled draw in a nested authenticated frame is read without a request', async () => {
  const vm = require('node:vm');
  const frame = text => ({ isDestroyed: () => false, executeJavaScript: async script => vm.runInNewContext(script, { location: { pathname: '/Home/Index' }, document: { body: { innerText: text } } }) });
  const main = frame('本周报表'); main.framesInSubtree = [main, frame('3491985期 距封盘：00:44 3491984期开奖：3 0 0')];
  const status = {};
  const client = new SiteClient({ id: 'pc28', systemType: 'system-166' }, status);
  client.window = { isDestroyed: () => false, webContents: { mainFrame: main, executeJavaScript: async () => { throw Error('main fallback should not run'); } } };
  assert.equal(await client.readLatestSettledDraw(), '3491984');
  assert.equal(status.drawSource, '已登录页面框架');
});

test('dynamic home detection uses a separate window with the same session and is cleaned on suspend', async () => {
  const store = fixture(); const sharedSession = {}; let loaded = ''; let destroyed = false; let options;
  const report = { isDestroyed: () => false, webContents: { getURL: () => 'https://market.example/ReportNew/Agent', session: sharedSession } };
  const source = 'https://market.example/IntimeSheet/Index?uid=test-session&loginId=test&page=ALLSetting&lotteryType=JND282';
  const home = { isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, loadURL: async url => { loaded = url; }, webContents: { getURL: () => loaded, mainFrame: { isDestroyed: () => false, executeJavaScript: async () => source }, stop() {}, setWindowOpenHandler() {} } };
  const service = new MonitorService(store, () => {}, { createDrawWindow: config => { options = config; return home; } });
  const client = { window: report, async readLatestSettledDraw() { if (this.window === report) throw Object.assign(Error('no draw'), { code: 'DRAW_NOT_FOUND' }); return '3491984'; } };
  assert.equal(await service.readDrawState(client, store.state.accounts[0], report), '3491984');
  assert.equal(options.webPreferences.session, sharedSession);
  assert.equal(options.show, false);
  assert.equal(loaded, source);
  assert.match(home.settlementDrawQuery.url, /\/IntimeSheet\/GetCurrentInstall/);
  service.suspend();
  assert.equal(destroyed, true); assert.equal(service.drawWindows.size, 0);
});

function fixture() {
  return {
    state: {
      telegram: { mode: 'off' }, alertPolicy: {}, accounts: [{ id: 'pc28', name: 'PC28', enabled: true, systemType: 'system-166', intervalMinutes: 5 }], alertRecords: [],
    },
    update(fn) { fn(this.state); }, addEvent() {}, addAlertRecord(item) { this.state.alertRecords.push(item); },
  };
}

test('draw monitor waits for a later settled draw then triggers one report read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 18, 12) });
  const store = fixture(); let draw = '3491984'; const calls = [];
  const service = new MonitorService(store, () => {}, {
    drawReadDelayMs: 0,
    createSiteClient: () => ({ readLatestSettledDraw: async () => draw }),
  });
  service.viewWindows.set('pc28', { isDestroyed: () => false });
  service.check = async id => calls.push(id);
  await service.pollDraws();
  assert.equal(calls.length, 0);
  assert.equal(service.status('pc28').nextCheckAt, null);
  draw = '3491985';
  await service.pollDraws();
  await service.pollDraws();
  assert.deepEqual(calls, ['pc28']);
  assert.equal(service.status('pc28').drawTrigger.latestDraw, '3491985');
});

test('draw monitor retains fixed-interval fallback if the settled-draw state is unavailable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 18, 12) });
  const store = fixture();
  const service = new MonitorService(store, () => {}, {
    createSiteClient: () => ({ readLatestSettledDraw: async () => { throw new Error('unavailable'); } }),
  });
  service.viewWindows.set('pc28', { isDestroyed: () => false });
  await service.pollDraws();
  const status = service.status('pc28');
  assert.equal(status.drawTrigger.fallback, true);
  assert.ok(Date.parse(status.nextCheckAt) > Date.now());
});

test('successful but frozen draw polling uses fallback without postponing its timer; new draw recovers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 12) });
  const store = fixture(); let draw = '3491984';
  const service = new MonitorService(store, () => {}, { createSiteClient: () => ({ readLatestSettledDraw: async () => draw }) });
  service.viewWindows.set('pc28', { isDestroyed: () => false });
  await service.pollDraws();
  t.mock.timers.tick(DRAW_STALE_MS);
  await service.pollDraws();
  const status = service.status('pc28');
  assert.equal(status.drawTrigger.fallback, true);
  const due = status.nextCheckAt;
  t.mock.timers.tick(5000);
  await service.pollDraws();
  assert.equal(status.nextCheckAt, due);
  draw = '3491985';
  await service.pollDraws();
  assert.equal(status.drawTrigger.fallback, false);
  assert.equal(status.nextCheckAt, null);
  assert.ok(status.drawTrigger.nextReadAt);
});

test('backward draw cannot lower the baseline or look like a later new draw', () => {
  const previous = observeSettledDraw(null, '3491984', 100).state;
  const reset = observeSettledDraw(previous, '3491000', 200);
  assert.equal(reset.reset, true);
  assert.equal(reset.state.drawId, previous.drawId);
  assert.equal(observeSettledDraw(reset.state, '3491001', 300).changed, false);
});

test('settlement evidence requires an explicit accounting period, not a draw header or amount', () => {
  assert.equal(parseReportSettlementDraw('3491984期开奖：3 0 0 本周应收 200000'), null);
  assert.equal(parseReportSettlementDraw('账目已结算至：第3491984期'), '3491984');
  assert.equal(parseReportSettlementDraw('已结算期号：3491984 已结算期号：3491983'), null);
});

test('verified PC28 response selects the settled previous draw and uses countdown only for polling', () => {
  const observed = { Installments: '3494518', PreInstallments: '3494517', PreLotteryResult: '7,5,1', OpenTimeStamp: 112, TemplateCode: 'JNDPCDD' };
  assert.deepEqual(parseDrawStateResponse(observed), { drawId: '3494517', currentDraw: '3494518', nextPollMs: 60000 });
  assert.equal(parseDrawStateResponse({ ...observed, OpenTimeStamp: 8 }).nextPollMs, 5000);
  assert.equal(parseDrawStateResponse({ ...observed, PreInstallments: observed.Installments }), null);
  assert.equal(parseDrawStateResponse({ ...observed, PreLotteryResult: '' }), null);
  assert.equal(parseDrawStateResponse({ ...observed, TemplateCode: 'other' }), null);
  assert.equal(parseDrawStateResponse('<form>login</form>'), null);
});

test('verified instant header reads spanQishu instead of the current betting period', async () => {
  const vm = require('node:vm'); const status = {};
  const header = { textContent: '3494517期开奖: 7 5 1', querySelector: selector => selector === '#spanQishu' ? { textContent: '3494517' } : null };
  const client = new SiteClient({ id: 'pc28', systemType: 'system-166' }, status);
  client.window = { isDestroyed: () => false, webContents: { mainFrame: {
    isDestroyed: () => false,
    executeJavaScript: async script => vm.runInNewContext(script, { URL, location: { pathname: '/IntimeSheet/Index', href: 'https://market.example/IntimeSheet/Index?lotteryType=JND282' }, document: { body: { innerText: '3494518期 距封盘 00:20' }, querySelector: selector => selector === '#drawLotterInfo' ? header : null } }),
  } } };
  assert.equal(await client.readLatestSettledDraw(), '3494517');
  assert.equal(status.drawSource, '即时注单开奖标题（JND282）');
});

test('dedicated draw query uses the authenticated observed request and returns no account data', async () => {
  const status = {}; const client = new SiteClient({ id: 'pc28' }, status); let request;
  client.window = { webContents: { session: { fetch: async (url, init) => {
    request = { url, init };
    return Response.json({ Installments: '3494518', PreInstallments: '3494517', PreLotteryResult: '7,5,1', OpenTimeStamp: 112, TemplateCode: 'JNDPCDD', TodayWinLost: 999 });
  } } } };
  const query = { url: 'https://market.example/IntimeSheet/GetCurrentInstall?uid=private', referrer: 'https://market.example/IntimeSheet/Index?uid=private', body: 'lotteryType=JND282&temaType=0&organizationId=' };
  assert.equal(await client.readSettledDrawQuery(query), '3494517');
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'include');
  assert.equal(request.init.referrer, query.referrer); assert.equal(request.init.referrerPolicy, 'same-origin');
  assert.equal(request.init.headers.Referer, query.referrer);
  await assert.rejects(client.readSettledDrawQuery({ ...query, referrer: 'https://other.example' }), error => error.code === 'DRAW_SOURCE_MISMATCH');
  assert.equal(status.drawSuggestedPollMs, 60000);
  assert.ok(!JSON.stringify(status).includes('private')); assert.ok(!JSON.stringify(status).includes('999'));
});

test('countdown polling still waits fifteen seconds after confirmed draw change before reading', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12) });
  const store = fixture(); let draw = '3494517'; let reads = 0;
  const service = new MonitorService(store, () => {}, { createSiteClient: (_, status) => ({ async readLatestSettledDraw() { status.drawSuggestedPollMs = 60000; return draw; } }) });
  service.viewWindows.set('pc28', { isDestroyed: () => false }); service.check = async () => { reads++; };
  await service.pollDraws(); draw = '3494518';
  t.mock.timers.tick(59000); await service.pollDraws(); assert.equal(reads, 0);
  t.mock.timers.tick(1000); await service.pollDraws(); assert.equal(reads, 0);
  t.mock.timers.tick(14000); await service.pollDraws(); assert.equal(reads, 0);
  t.mock.timers.tick(1000); await service.pollDraws(); assert.equal(reads, 1);
});

test('daily hidden-page maintenance runs once, preserving account configuration and leaving visible pages alone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 6, 30) });
  const store = fixture(); const service = new MonitorService(store, () => {});
  const before = structuredClone(store.state);
  let destroyed = 0;
  service.viewWindows.set('pc28', { isDestroyed: () => false, isVisible: () => true, destroy: () => destroyed++ });
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  assert.equal(destroyed, 0);
  const status = service.status('pc28');
  assert.equal(status.waitingForDraw, false); assert.equal(status.drawNextProbeAt, 0);
  assert.equal(status.drawTrigger.nextReadAt, ''); assert.equal(status.drawTrigger.nextProbeAt, '');
  assert.match(status.drawTrigger.state, /停盘/);
  service.viewWindows.set('pc28', { isDestroyed: () => false, isVisible: () => false, destroy: () => destroyed++, webContents: {} });
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  assert.equal(destroyed, 1);
  assert.deepEqual(store.state, before);
});

test('draw API rejects unsafe shapes with only categorical error codes', () => {
  const { drawStateFailure } = require('../electron/draw-trigger');
  assert.equal(drawStateFailure('<form action="/Member/Login"><input type="password"></form>'), 'DRAW_API_LOGIN_PAGE');
  assert.equal(drawStateFailure('<html>private</html>'), 'DRAW_API_HTML');
  assert.equal(drawStateFailure('private'), 'DRAW_API_NOT_JSON');
  assert.equal(drawStateFailure([]), 'DRAW_API_SHAPE');
  assert.equal(drawStateFailure({ TemplateCode: 'other-private' }), 'DRAW_API_TEMPLATE');
  assert.equal(drawStateFailure({ TemplateCode: 'JNDPCDD' }), 'DRAW_API_PERIOD');
  assert.equal(drawStateFailure({ TemplateCode: 'JNDPCDD', Installments: '3494518', PreInstallments: '3494517', PreLotteryResult: 'invalid' }), 'DRAW_API_RESULT');
});

test('invalid draw API cools down while title remains usable, then valid response clears error', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 18, 10) });
  const store = fixture(); const service = new MonitorService(store, () => {});
  const win = { isDestroyed: () => false, settlementDrawQuery: { url: 'https://private.example', body: 'secret' } };
  service.drawWindows.set('pc28', win);
  let attempts = 0;
  const client = { readSettledDrawQuery: async () => { attempts++; throw Object.assign(Error('secret'), { code: 'DRAW_API_TEMPLATE' }); }, readLatestSettledDraw: async () => '3494517' };
  assert.equal(await service.readDrawState(client, store.state.accounts[0], win), '3494517');
  assert.equal(await service.readDrawState(client, store.state.accounts[0], win), '3494517');
  assert.equal(attempts, 1); assert.equal(service.status('pc28').drawApiError, 'DRAW_API_TEMPLATE');
  assert.ok(!JSON.stringify(service.status('pc28')).includes('secret'));
  t.mock.timers.tick(600000);
  client.readSettledDrawQuery = async () => { attempts++; return '3494518'; };
  assert.equal(await service.readDrawState(client, store.state.accounts[0], win), '3494518');
  assert.equal(attempts, 2); assert.equal(service.status('pc28').drawApiError, '');
  assert.equal(service.status('pc28').drawApiRetryAt, '');
});

test('branch watchdog destroys only its stalled page and reports a branch failure', async () => {
  const client = new SiteClient({ id: 'pc28' }, {});
  let destroyed = 0;
  client.window = { isDestroyed: () => false, destroy: () => destroyed++ };
  client.branchTimeoutMs = 5;
  client.readDescendantSettlement = () => new Promise(() => {});
  await assert.rejects(client.readBranchWithRecovery(['slow']), error => error.code === 'BRANCH_TIMEOUT');
  assert.equal(destroyed, 1);
  assert.equal(client.branchPageLost, true);
});

test('an older explicit accounting period blocks publication even when the amount is valid', async () => {
  const status = { expectedDraw: '3491985' };
  const client = new SiteClient({ id: 'pc28', systemType: 'system-166' }, status);
  const rows = [['账号', '投注', '有效', '输赢', '本级', '结果', '备注', '其他', '应收下线'], ['p', '1', '2', '3', '4', '5', '', '', '100'], ['合计', '1', '2', '3', '4', '5', '', '', '100']].map(row => row.map(text => ({ text, colspan: 1, rowspan: 1 })));
  let accountingDraw = '3491984';
  client.window = { webContents: { mainFrame: { isDestroyed: () => false, executeJavaScript: async script => script.includes('return rows.map') ? rows : `报表已结算至：${accountingDraw}` } } };
  client.learnDirectReport = async () => {};
  await assert.rejects(client.readCurrentSettlement(), error => error.code === 'SETTLEMENT_PENDING');
  accountingDraw = '3491985';
  assert.equal((await client.readCurrentSettlement()).value, 100);
  assert.equal(status.settlementCheck.supported, true);
  client.currentReportPath = ['child'];
  accountingDraw = '';
  assert.equal((await client.readCurrentSettlement()).value, 100, 'a child without evidence must not inherit its parent capability');
  client.currentReportPath = [];
  await assert.rejects(client.readCurrentSettlement(), error => error.code === 'SETTLEMENT_PENDING', 'missing evidence still blocks a path previously known to support it');
});

test('healthy draw waiting cannot trigger the timer loop, but explicit scheduled refresh can', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 12) });
  const store = fixture();
  const service = new MonitorService(store, () => {}, { createSiteClient: () => ({ readLatestSettledDraw: async () => '3491984' }) });
  service.viewWindows.set('pc28', { isDestroyed: () => false });
  let reads = 0; service.check = async () => { reads++; };
  const status = service.status('pc28'); status.status = 'ok';
  await service.pollDraws(); await service.tick();
  t.mock.timers.tick(10000);
  await service.pollDraws(); await service.tick();
  assert.equal(reads, 0);
  status.recheckRequested = true; status.nextCheckAt = new Date(Date.now() + 1000).toISOString();
  await service.pollDraws();
  t.mock.timers.tick(1000); await service.tick();
  assert.equal(reads, 1);
  status.recheckRequested = false; status.nextCheckAt = null;
  service.viewWindows.delete('pc28');
  await service.pollDraws();
  t.mock.timers.tick(3000); await service.tick();
  assert.equal(reads, 2, 'lost browser windows must resume session recovery rather than waiting forever for a draw');
});

test('draw polling and new draw respect an existing failed-read backoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 12) });
  const store = fixture(); let draw = '3491984';
  const service = new MonitorService(store, () => {}, { drawReadDelayMs: 0, createSiteClient: () => ({ readLatestSettledDraw: async () => draw }) });
  service.viewWindows.set('pc28', { isDestroyed: () => false });
  let reads = 0; service.check = async () => { reads++; };
  const status = service.status('pc28'); status.status = 'error';
  status.nextCheckAt = new Date(Date.now() + 300000).toISOString(); const due = status.nextCheckAt;
  await service.pollDraws(); draw = '3491985'; await service.pollDraws(); await service.tick();
  assert.equal(reads, 0); assert.equal(status.nextCheckAt, due);
  t.mock.timers.tick(300000); await service.tick();
  assert.equal(reads, 1);
});

test('manual intervention survives maintenance and cannot auto-resume at opening', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 6, 30) });
  const store = fixture(); const service = new MonitorService(store, () => {});
  const status = service.status('pc28'); status.status = 'manual'; status.stage = '等待手动完成验证';
  let reads = 0; service.check = async () => { reads++; };
  await service.tick();
  assert.equal(status.status, 'market-closed');
  t.mock.timers.tick(30 * 60000 + 30000);
  await service.tick();
  assert.equal(status.status, 'manual'); assert.equal(status.stage, '等待手动完成验证');
  assert.equal(reads, 0);
});
