const test = require('node:test');
const assert = require('node:assert/strict');
const { splitReportRows, flattenHeaders, parseSettlementTable, alertStepFromLegacy, alertLevel, alertTransition, legacyAlertStep, applySubagentAlertSteps, evaluateSubagentAlertLevels } = require('../electron/report-parser');

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

test('keeps the real colspan total row aligned with the upper-level settlement column', () => {
  const cell = (text, colspan = 1, rowspan = 1) => ({ text, colspan, rowspan });
  const table = splitReportRows([
    [
      cell('代理账号', 1, 2), cell('名称', 1, 2), cell('笔数', 1, 2), cell('会员数', 1, 2),
      cell('下注金额', 1, 2), cell('有效金额', 1, 2), cell('会员输赢', 3), cell('代理 输赢', 9),
      cell('上交货量', 1, 2), cell('上级交收', 1, 2),
    ],
    ['输赢', '退水', '盈亏结果', '应收下线', '占成', '实占金额', '实占结果', '实占退水', '赚水', '赚赔', '占货比', '盈亏结果'].map((text) => cell(text)),
    ['agent01', '代理一', '1', '2', '3', '4', '5', '6', '7', '8', '5%', '10', '11', '12', '13', '14', '100%', '15', '16', '-1234.56'].map((text) => cell(text)),
    [cell('合计：1行', 2), ...['1', '2', '3', '4', '5', '6', '7', '8', '', '10', '11', '12', '13', '14', '100%', '15', '16', '-1234.56'].map((text) => cell(text))],
  ]);
  const result = parseSettlementTable(table);
  assert.equal(result.column, 19);
  assert.equal(result.value, -1234.56);
  assert.deepEqual(result.agents, [{ name: 'agent01', value: -1234.56 }]);
});

test('calculates positive and negative alert levels from zero', () => {
  assert.equal(alertLevel(0, 100), 0);
  assert.equal(alertLevel(99.99, 100), 0);
  assert.equal(alertLevel(100, 100), 1);
  assert.equal(alertLevel(299, 100), 2);
  assert.equal(alertLevel(-99.99, 100), 0);
  assert.equal(alertLevel(-100, 100), -1);
  assert.equal(alertLevel(-399, 100), -3);
  assert.equal(alertLevel(1000, null), 0);
});

test('notifies once whenever the amount enters a different non-zero level', () => {
  assert.deepEqual(alertTransition(0, 1), { previousLevel: 0, currentLevel: 1, crossedCount: 1, shouldNotify: true });
  assert.equal(alertTransition(1, 2).shouldNotify, true);
  assert.equal(alertTransition(2, 2).shouldNotify, false);
  assert.equal(alertTransition(3, 1).shouldNotify, true);
  assert.equal(alertTransition(1, 0).shouldNotify, false);
  assert.equal(alertTransition(0, -1).shouldNotify, true);
  assert.equal(alertTransition(-1, -3).crossedCount, 2);
});

test('only configured subagents receive alert steps', () => {
  const agents = applySubagentAlertSteps(
    [{ name: 'agent-a', value: 20 }, { name: 'agent-b', value: 30 }],
    [{ name: 'agent-b', alertStep: 100 }],
  );
  assert.deepEqual(agents, [
    { name: 'agent-a', value: 20, path: ['agent-a'], remark: '', alertStep: null, customized: false },
    { name: 'agent-b', value: 30, path: ['agent-b'], remark: '', alertStep: 100, customized: true },
  ]);
  assert.deepEqual(evaluateSubagentAlertLevels(agents).map((item) => item.level), [0, 0]);
});

test('same-named second-level agents keep independent remarks and alert steps', () => {
  const agents = applySubagentAlertSteps(
    [
      { name: 'child', path: ['parent-a', 'child'], value: 120 },
      { name: 'child', path: ['parent-b', 'child'], value: -220 },
    ],
    [
      { name: 'child', path: ['parent-a', 'child'], remark: '东区', alertStep: 100 },
      { name: 'child', path: ['parent-b', 'child'], remark: '西区', alertStep: 200 },
    ],
  );
  assert.deepEqual(agents.map(({ path, remark, alertStep }) => [path, remark, alertStep]), [
    [['parent-a', 'child'], '东区', 100],
    [['parent-b', 'child'], '西区', 200],
  ]);
  assert.deepEqual(evaluateSubagentAlertLevels(agents).map(({ level }) => level), [1, -1]);
});

test('converts old thresholds into a positive from-zero alert step', () => {
  assert.equal(legacyAlertStep({ operator: 'gte', threshold: 88 }), 88);
  assert.equal(legacyAlertStep({ operator: 'lte', threshold: -50 }), 50);
  assert.equal(alertStepFromLegacy({ lowerThreshold: -100, upperThreshold: 100 }), 100);
  assert.equal(alertStepFromLegacy({ alertStep: 25, lowerThreshold: -100 }), 25);
});

test('evaluates each subagent independently', () => {
  const evaluated = evaluateSubagentAlertLevels([
    { name: 'agent-a', value: -220, alertStep: 100 },
    { name: 'agent-b', value: 5, alertStep: 20 },
    { name: 'agent-c', value: 330, alertStep: 100 },
  ]);
  assert.deepEqual(evaluated.map(({ subagent, level }) => [subagent.name, level]), [
    ['agent-a', -2], ['agent-b', 0], ['agent-c', 3],
  ]);
});
