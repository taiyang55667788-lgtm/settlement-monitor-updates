function normalize(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function numericValue(text) {
  const match = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`无法读取金额：${text}`);
  return Number(match[0]);
}

function flattenHeaders(headerRows) {
  const grid = [];
  headerRows.forEach((row, rowIndex) => {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    let column = 0;
    row.forEach((cell) => {
      while (grid[rowIndex][column] !== undefined) column += 1;
      const colspan = Math.max(1, Number(cell.colspan || 1));
      const rowspan = Math.max(1, Number(cell.rowspan || 1));
      for (let y = rowIndex; y < rowIndex + rowspan; y += 1) {
        if (!grid[y]) grid[y] = [];
        for (let x = column; x < column + colspan; x += 1) grid[y][x] = normalize(cell.text);
      }
      column += colspan;
    });
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => {
    const labels = grid.map((row) => row[column]).filter(Boolean);
    return [...new Set(labels)].join(' / ');
  });
}

function findSettlementColumn(headers, dataWidth) {
  let index = headers.findIndex((header) => header.includes('交收金额'));
  if (index >= 0) return index;
  index = headers.findIndex((header) => header.includes('上级交收') && !header.endsWith('盈亏结果'));
  if (index >= 0) return index;
  if (dataWidth >= 2) return dataWidth - 2;
  throw new Error('报表里没有找到“交收金额”列');
}

function parseSettlementTable({ headerRows, dataRows }) {
  if (!dataRows?.length) throw new Error('本周报表没有数据');
  const totalRow = [...dataRows].reverse().find((row) => normalize(row[0]).includes('合计')) || dataRows[0];
  const headers = flattenHeaders(headerRows || []);
  const column = findSettlementColumn(headers, totalRow.length);
  return {
    value: numericValue(totalRow[column]),
    column,
    header: headers[column] || '上级交收 / 交收金额',
    raw: totalRow[column],
  };
}

function thresholdMet(value, operator, threshold) {
  return operator === 'lte' ? value <= threshold : value >= threshold;
}

module.exports = { flattenHeaders, parseSettlementTable, thresholdMet };
