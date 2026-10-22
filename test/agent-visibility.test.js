const test = require('node:test'); const assert = require('node:assert/strict');
const { confirmedNoData, visibleParent } = require('../ui/agent-visibility');
test('only confirmed no-data is hidden; stale/unread data and zero values remain visible', () => {
  assert.equal(confirmedNoData({ noData: true }), true);
  for (const agent of [{ noData: true, stale: true }, { noData: true, notRefreshed: true }, { value: 0 }, { value: 100, stale: true }]) assert.equal(confirmedNoData(agent), false);
});
test('visible descendants retain paths when an intermediate no-data row is hidden', () => {
  const rows = [{ subagent: { path: ['root'] } }, { subagent: { path: ['root', 'hidden', 'child'] } }];
  assert.deepEqual(visibleParent(['root', 'hidden', 'child'], rows), ['root']);
  assert.deepEqual(visibleParent(['hidden', 'child'], rows), []);
});
