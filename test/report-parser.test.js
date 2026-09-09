const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenHeaders, parseSettlementTable, thresholdBand } = require('../electron/report-parser');

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
  assert.deepEqual(result.agents, [{ name: 'abc', value: 12345.67 }]);
});

test('supports simultaneous lower and upper thresholds', () => {
  assert.equal(thresholdBand(-100, -100, 100), 'lower');
  assert.equal(thresholdBand(100, -100, 100), 'upper');
  assert.equal(thresholdBand(0, -100, 100), null);
  assert.equal(thresholdBand(80, null, 100), null);
  assert.equal(thresholdBand(101, null, 100), 'upper');
  assert.equal(thresholdBand(-101, -100, null), 'lower');
});
