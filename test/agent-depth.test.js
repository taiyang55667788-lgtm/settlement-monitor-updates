const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneDeepAgents } = require('../electron/agent-depth');
const { alertLedgerKey } = require('../electron/alert-ledger');
test('migration removes fifth-level settings, cached data and ledgers without changing four-level settings', () => {
  const fourth = { name: 'fourth', path: ['a', 'b', 'c', 'fourth'], alertStep: 20 };
  const fifth = { name: 'fifth', path: [...fourth.path, 'fifth'], alertStep: 40 };
  const fourthKey = alertLedgerKey(fourth.path, 20), fifthKey = alertLedgerKey(fifth.path, 40);
  const account = { subagentThresholds: [fourth, fifth], expandedAgentPaths: [fourth.path, fifth.path],
    agentSnapshot: { agents: [fourth, fifth] }, agentTrend: [{ agents: [fourth, fifth] }],
    alertHistory: { agents: { [fourthKey]: { currentLevel: 2 }, [fifthKey]: { currentLevel: 3 } } },
    alertCandidates: { [fifthKey]: { count: 2 } }, deltaHistory: { agents: { [JSON.stringify(fifth.path)]: {} } },
  };
  pruneDeepAgents(account);
  assert.deepEqual(account.subagentThresholds, [fourth]);
  assert.deepEqual(account.agentSnapshot.agents, [fourth]);
  assert.deepEqual(account.agentTrend[0].agents, [fourth]);
  assert.deepEqual(account.expandedAgentPaths, []);
  assert.deepEqual(Object.keys(account.alertHistory.agents), [fourthKey]);
  assert.deepEqual(account.alertCandidates, {});
  assert.deepEqual(account.deltaHistory.agents, {});
});
