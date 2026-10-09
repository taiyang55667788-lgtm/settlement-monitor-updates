const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettledDraw, observeSettledDraw } = require('../electron/draw-trigger');
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
