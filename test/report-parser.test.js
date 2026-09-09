const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenHeaders, parseSettlementTable, thresholdMet } = require('../electron/report-parser');

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
});

test('supports both threshold directions', () => {
  assert.equal(thresholdMet(100, 'gte', 100), true);
  assert.equal(thresholdMet(99, 'gte', 100), false);
  assert.equal(thresholdMet(80, 'lte', 80), true);
  assert.equal(thresholdMet(81, 'lte', 80), false);
});
