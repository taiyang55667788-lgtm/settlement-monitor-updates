const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettledDraw, observeSettledDraw, parseReportSettlementDraw, DRAW_STALE_MS } = require('../electron/draw-trigger');
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

function fixture() {
  return {
    state: {
      telegram: { mode: 'off' }, alertPolicy: {}, accounts: [{ id: 'pc28', name: 'PC28', enabled: true, systemType: 'system-166', intervalMinutes: 5 }], alertRecords: [],
    },
    update(fn) { fn(this.state); }, addEvent() {}, addAlertRecord(item) { this.state.alertRecords.push(item); },
  };
}

test('draw monitor waits for a later settled draw then triggers one report read', async () => {
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

test('draw monitor retains fixed-interval fallback if the settled-draw state is unavailable', async () => {
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

test('daily hidden-page maintenance runs once, preserving account configuration and leaving visible pages alone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 6, 30) });
  const store = fixture(); const service = new MonitorService(store, () => {});
  const before = structuredClone(store.state);
  let destroyed = 0;
  service.viewWindows.set('pc28', { isDestroyed: () => false, isVisible: () => true, destroy: () => destroyed++ });
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  assert.equal(destroyed, 0);
  service.viewWindows.set('pc28', { isDestroyed: () => false, isVisible: () => false, destroy: () => destroyed++, webContents: {} });
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  service.pauseForMarket(store.state.accounts[0], service.status('pc28'));
  assert.equal(destroyed, 1);
  assert.deepEqual(store.state, before);
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
