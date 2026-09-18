const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../electron/monitor');

function fixture(state) {
  const alerts = [];
  const context = {
    period: { start: '2026-09-14', end: '2026-09-20' },
    parentValue: 250,
    childValue: -350,
  };
  const store = {
    state: state || {
      accounts: [{
        id: 'account-1', name: '本级', enabled: true, intervalMinutes: 5,
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
        async readDescendantSettlement() { return { value: context.childValue, agents: [{ name: 'child', value: context.childValue }] }; },
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
