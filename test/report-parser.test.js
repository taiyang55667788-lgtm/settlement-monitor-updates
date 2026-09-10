const test = require('node:test');
const assert = require('node:assert/strict');
const { splitReportRows, flattenHeaders, parseSettlementTable, thresholdBand, isValidThresholdRange, legacyThresholdPair, applySubagentThresholds, evaluateSubagentThresholds } = require('../electron/report-parser');

test('flattens grouped table headers', () => {
  const headers = flattenHeaders([
    [
      { text: '账号', rowspan: 2 },
      { text: '上级交收', colspan: 2 },
    ],
    [
      { text: '交收金额' },
      { text: '盈亏结果' },
    ],
  ]);
  assert.deepEqual(headers, ['账号', '上级交收 / 交收金额', '上级交收 / 盈亏结果']);
});

test('splits real-width DOM rows when a subagent name contains Chinese characters', () => {
  const cell = (text) => ({ text, colspan: 1, rowspan: 1 });
  const table = splitReportRows([
    ['账号', '投注', '有效', '输赢', '本级', '结果', '上级交收', '盈亏', '备注'].map(cell),
    ['中文代理', '1', '2', '3', '4', '5', '123.00', '7', '8'].map(cell),
    ['合计', '1', '2', '3', '4', '5', '123.00', '7', '8'].map(cell),
  ]);
  assert.equal(table.headerRows.length, 1);
  assert.deepEqual(table.dataRows.map((row) => row[0]), ['中文代理', '合计']);
});

test('reads settlement amount from total row', () => {
  const result = parseSettlementTable({
    headerRows: [
      [{ text: '账号', rowspan: 2 }, { text: '上级交收', colspan: 2 }],
      [{ text: '交收金额' }, { text: '盈亏结果' }],
    ],
    dataRows: [
      ['abc', '12,345.67', '-10.00'],
      ['合计：1行', '33,973,023.35', '-21,841.08'],
    ],
  });
  assert.equal(result.value, 33973023.35);
  assert.deepEqual(result.agents, [{ name: 'abc', value: 12345.67 }]);
});

test('prefers upper-level settlement when more than one settlement amount exists', () => {
  const result = parseSettlementTable({
    headerRows: [[
      { text: '账号' },
      { text: '本级交收 / 交收金额' },
      { text: '上级交收 / 交收金额' },
    ]],
    dataRows: [
      ['中文代理', '888.00', '123.00'],
      ['合计', '888.00', '123.00'],
    ],
  });
  assert.equal(result.value, 123);
  assert.deepEqual(result.agents, [{ name: '中文代理', value: 123 }]);
});

test('supports simultaneous lower and upper thresholds', () => {
  assert.equal(thresholdBand(-100, -100, 100), 'lower');
  assert.equal(thresholdBand(100, -100, 100), 'upper');
  assert.equal(thresholdBand(0, -100, 100), null);
  assert.equal(thresholdBand(80, null, 100), null);
  assert.equal(thresholdBand(101, null, 100), 'upper');
  assert.equal(thresholdBand(-101, -100, null), 'lower');
  assert.equal(isValidThresholdRange(-100, 100), true);
  assert.equal(isValidThresholdRange(100, 100), false);
  assert.equal(isValidThresholdRange(0, null), true);
});

test('only configured subagents receive thresholds', () => {
  const agents = applySubagentThresholds(
    [{ name: 'agent-a', value: 20 }, { name: 'agent-b', value: 30 }],
    [{ name: 'agent-b', lowerThreshold: -100, upperThreshold: 100 }],
  );
  assert.deepEqual(agents, [
    { name: 'agent-a', value: 20, lowerThreshold: null, upperThreshold: null, customized: false },
    { name: 'agent-b', value: 30, lowerThreshold: -100, upperThreshold: 100, customized: true },
  ]);
  assert.equal(thresholdBand(1000, agents[0].lowerThreshold, agents[0].upperThreshold), null);
  assert.deepEqual(evaluateSubagentThresholds(agents).map((item) => item.band), [null, null]);
});

test('converts old account-level thresholds for one-time subagent migration', () => {
  assert.deepEqual(legacyThresholdPair({ operator: 'gte', threshold: 88 }), { lowerThreshold: null, upperThreshold: 88 });
  assert.deepEqual(legacyThresholdPair({ operator: 'lte', threshold: -50 }), { lowerThreshold: -50, upperThreshold: null });
  assert.deepEqual(legacyThresholdPair({ lowerThreshold: -10, upperThreshold: 10 }), { lowerThreshold: -10, upperThreshold: 10 });
});

test('evaluates each subagent independently', () => {
  const evaluated = evaluateSubagentThresholds([
    { name: 'agent-a', value: -20, lowerThreshold: -10, upperThreshold: 10 },
    { name: 'agent-b', value: 5, lowerThreshold: 0, upperThreshold: 20 },
    { name: 'agent-c', value: 30, lowerThreshold: null, upperThreshold: 25 },
  ]);
  assert.deepEqual(evaluated.map(({ subagent, band }) => [subagent.name, band]), [
    ['agent-a', 'lower'], ['agent-b', null], ['agent-c', 'upper'],
  ]);
});
