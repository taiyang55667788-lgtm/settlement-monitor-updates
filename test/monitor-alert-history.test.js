const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../electron/monitor');

function fixture(state) {
  const alerts = [];
  const context = {
    period: { start: '2026-09-14', end: '2026-09-20' },
    parentValue: 250,
    childValue: -350,
    childFailure: false,
  };
  const store = {
    state: state || {
      accounts: [{
        id: 'account-1', name: '本级', enabled: true, intervalMinutes: 5, alertMetricVersion: 'weekly-receivable-downline-v1',
        subagentThresholds: [
          { name: 'parent', path: ['parent'], alertStep: 100, remark: '' },
          { name: 'child', path: ['parent', 'child'], alertStep: 100, remark: '' },
        ],
      }],
      telegram: {},
    },
    update(mutator) { mutator(this.state); },
    addEvent() {},
  };
  const makeService = () => {
    const service = new MonitorService(store, () => {}, {
      createSiteClient: () => ({
        get reportPeriod() { return context.period; },
        async open() {},
        async readThisWeekSettlement() { return { value: context.parentValue, agents: [{ name: 'parent', value: context.parentValue }] }; },
        async readDescendantSettlement() {
          if (context.childFailure) throw new Error('下级报表加载失败');
          return { value: context.childValue, agents: [{ name: 'child', value: context.childValue }] };
        },
        async close() {},
      }),
    });
    service.sendTelegram = async (_account, _value, level, _previous, _name, _step, _remark, path) => {
      alerts.push([path.join('/'), level]);
    };
    return service;
  };
  return { alerts, context, store, makeService };
}

test('monitor sends each weekly tier once across fluctuations and service restart', async () => {
  const { alerts, context, store, makeService } = fixture();
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(alerts, [
    ['parent', 1], ['parent', 2],
    ['parent/child', -1], ['parent/child', -2], ['parent/child', -3],
  ]);
  assert.equal(service.status('account-1').status, 'triggered');
  context.parentValue = 50;
  context.childValue = -50;
  await service.check('account-1');
  context.parentValue = 250;
  context.childValue = -350;
  await service.check('account-1');
  assert.equal(alerts.length, 5);

  const afterRestart = fixture(structuredClone(store.state));
  await afterRestart.makeService().check('account-1');
  assert.deepEqual(afterRestart.alerts, []);
  afterRestart.context.period = { start: '2026-09-21', end: '2026-09-27' };
  await afterRestart.makeService().check('account-1');
  assert.equal(afterRestart.alerts.length, 5);
});

test('failed delivery retries only unsent tiers', async () => {
  const { alerts, makeService } = fixture();
  const service = makeService();
  const send = service.sendTelegram;
  let failOnce = true;
  service.sendTelegram = async (...args) => {
    if (args[7].join('/') === 'parent' && args[2] === 2 && failOnce) {
      failOnce = false;
      throw new Error('network failed');
    }
    return send(...args);
  };
  await service.check('account-1');
  assert.equal(service.status('account-1').status, 'error');
  await service.check('account-1');
  assert.deepEqual(alerts.filter(([path]) => path === 'parent'), [['parent', 1], ['parent', 2]]);
});

test('metric change archives old tiers and sends one initial summary per agent', async () => {
  const { alerts, store, makeService } = fixture();
  delete store.state.accounts[0].alertMetricVersion;
  store.state.accounts[0].alertHistory = {
    period: '2026-09-14/2026-09-20',
    agents: { old: { positiveMax: 100, negativeMax: 100 } },
  };
  const service = makeService();
  await service.check('account-1');
  assert.deepEqual(alerts, [['parent', 2], ['parent/child', -3]]);
  assert.equal(store.state.accounts[0].alertHistoryArchive[0].metric, 'upper-level-settlement-v1');
  assert.equal(store.state.accounts[0].alertHistory.migrationPending, false);
  assert.equal(store.state.accounts[0].alertMetricVersion, 'weekly-receivable-downline-v1');
  assert.equal(service.status('account-1').subagents.every((agent) => Boolean(agent.readAt)), true);
  assert.equal(store.state.accounts[0].agentSnapshot.agents.length, 2);
  const restored = fixture(structuredClone(store.state)).makeService();
  assert.equal(restored.status('account-1').subagents.every((agent) => agent.stale), true);
  assert.equal(restored.status('account-1').subagents.every((agent) => Boolean(agent.readAt)), true);
});

test('an older account with no alert history still receives only one initial summary', async () => {
  const { alerts, store, makeService } = fixture();
  delete store.state.accounts[0].alertMetricVersion;
  await makeService().check('account-1');
  assert.deepEqual(alerts, [['parent', 2], ['parent/child', -3]]);
  assert.equal(store.state.accounts[0].alertHistory.migrationPending, false);
});

test('failed descendant read retains its last successful value but does not alert on stale data', async () => {
  const { alerts, context, makeService } = fixture();
  const service = makeService();
  await service.check('account-1');
  const childReadAt = service.status('account-1').subagents.find((agent) => agent.name === 'child').readAt;
  context.childFailure = true;
  context.childValue = -550;
  await service.check('account-1');
  const child = service.status('account-1').subagents.find((agent) => agent.name === 'child');
  assert.equal(child.stale, true);
  assert.equal(child.readAt, childReadAt);
  assert.equal(child.value, -350);
  assert.equal(alerts.length, 5);
});

test('confirmation policy holds a new tier until it is read consecutively, while saving a trend point', async () => {
  const { alerts, store, makeService } = fixture();
  store.state.alertPolicy = { confirmationReads: 2, quietStart: '', quietEnd: '', failureEscalation: 3 };
  const service = makeService();
  await service.check('account-1');
  assert.equal(alerts.length, 0);
  assert.equal(store.state.accounts[0].agentTrend.length, 1);
  await service.check('account-1');
  assert.equal(alerts.length, 5);
  assert.equal(store.state.accounts[0].agentTrend.length, 2);
  assert.equal(service.status('account-1').consecutiveFailures, 0);
  assert.ok(service.status('account-1').lastSuccessAt);
});
