const test = require('node:test');
const assert = require('node:assert/strict');
const { scanState, branchHasTarget, priorityPaths, retryDelay, startupCheck, CACHE_MS } = require('../electron/continuous-monitor');

test('checkpoint scope expires and is isolated by metric and settlement week', () => {
  const saved = scanState(null, 'a', 'week', 100);
  assert.equal(scanState(saved, 'a', 'week', 200), saved);
  for (const args of [['b', 'week', 200], ['a', 'next', 200], ['a', 'week', CACHE_MS + 101]]) assert.notEqual(scanState(saved, ...args), saved);
});
test('priority ancestry is unique and never exceeds four levels', () => {
  const settings = [{ path: ['a', 'b', 'c', 'd'], alertStep: 20 }, { path: ['a', 'b'], deltaAlertStep: 50 }, { path: ['z'], alertStep: null }];
  assert.deepEqual(priorityPaths(settings), [['a'], ['a', 'b'], ['a', 'b', 'c']]);
  assert.equal(branchHasTarget(['a', 'b'], settings), true);
  assert.equal(branchHasTarget(['a', 'b', 'c', 'd'], settings), false);
});
test('backoff respects configured interval, increases after repeated failures, and recovers', () => {
  assert.deepEqual([0, 1, 2, 3, 8].map(n => retryDelay({ intervalMinutes: 5 }, n)), [300000, 300000, 600000, 1200000, 1800000]);
  assert.equal(retryDelay({ intervalMinutes: 60 }, 5), 3600000);
});
test('startup cannot claim recovery based on pre-restart last-success timestamps', () => {
  const accounts = [{ id: 'a', name: '账号', enabled: true }]; const runtime = new Map();
  runtime.set('a', { lastSuccessAt: new Date(10).toISOString() });
  assert.equal(startupCheck(accounts, runtime, 100, 'loaded', true, true).status, 'checking');
  runtime.set('a', { lastSuccessAt: new Date(200).toISOString() });
  assert.equal(startupCheck(accounts, runtime, 100, 'loaded', true, true).status, 'ok');
  assert.equal(startupCheck(accounts, runtime, 100, 'failed', true).status, 'error');
  assert.equal(startupCheck(accounts, runtime, 100, 'recovered', true).status, 'warning');
  assert.equal(startupCheck(accounts, runtime, 100, 'loaded', false).status, 'error');
  assert.equal(startupCheck([], runtime, 100, 'loaded', true).status, 'idle');
});
