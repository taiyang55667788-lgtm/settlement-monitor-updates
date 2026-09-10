function normalize(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function numericValue(text) {
  const match = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`无法读取金额：${text}`);
  return Number(match[0]);
}

function splitReportRows(rows, minColumns = 9) {
  const source = Array.isArray(rows) ? rows : [];
  const firstData = source.findIndex((row) => {
    const first = normalize(row?.[0]?.text);
    const numericCells = (row || []).slice(1).filter((cell) => /[0-9]/.test(String(cell.text || ''))).length;
    return first.includes('合计') || (first && row.length >= minColumns && numericCells >= 3);
  });
  if (firstData < 0) throw new Error('报表里没有识别到下级代理数据行');
  return {
    headerRows: source.slice(0, Math.max(1, firstData)),
    dataRows: source.slice(firstData)
      .filter((row) => row.length >= minColumns)
      .map((row) => row.map((cell) => String(cell.text || '').trim())),
  };
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
  let index = headers.findIndex((header) => header.includes('上级交收') && header.includes('交收金额'));
  if (index >= 0) return index;
  index = headers.findIndex((header) => header.includes('交收金额'));
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
  const agents = dataRows
    .filter((row) => !normalize(row[0]).includes('合计'))
    .map((row) => {
      try {
        return { name: String(row[0] || '').trim(), value: numericValue(row[column]) };
      } catch {
        return null;
      }
    })
    .filter((agent) => agent?.name);
  return {
    value: numericValue(totalRow[column]),
    agents,
    column,
    header: headers[column] || '上级交收 / 交收金额',
    raw: totalRow[column],
  };
}

function thresholdBand(value, lowerThreshold, upperThreshold) {
  if (Number.isFinite(lowerThreshold) && value <= lowerThreshold) return 'lower';
  if (Number.isFinite(upperThreshold) && value >= upperThreshold) return 'upper';
  return null;
}

function isValidThresholdRange(lowerThreshold, upperThreshold) {
  return !Number.isFinite(lowerThreshold) || !Number.isFinite(upperThreshold) || lowerThreshold < upperThreshold;
}

function legacyThresholdPair(account) {
  const directLower = Number.isFinite(account?.lowerThreshold) ? account.lowerThreshold : null;
  const directUpper = Number.isFinite(account?.upperThreshold) ? account.upperThreshold : null;
  if (directLower !== null || directUpper !== null) return { lowerThreshold: directLower, upperThreshold: directUpper };
  if (!Number.isFinite(account?.threshold)) return { lowerThreshold: null, upperThreshold: null };
  return account.operator === 'lte'
    ? { lowerThreshold: account.threshold, upperThreshold: null }
    : { lowerThreshold: null, upperThreshold: account.threshold };
}

function applySubagentThresholds(agents, configurations) {
  const configured = Array.isArray(configurations) ? configurations : [];
  return (agents || []).map((agent) => {
    const custom = configured.find((item) => item.name === agent.name);
    return {
      ...agent,
      lowerThreshold: custom?.lowerThreshold ?? null,
      upperThreshold: custom?.upperThreshold ?? null,
      customized: Boolean(custom),
    };
  });
}

function evaluateSubagentThresholds(subagents) {
  return (subagents || []).map((subagent) => ({
    subagent,
    band: thresholdBand(subagent.value, subagent.lowerThreshold, subagent.upperThreshold),
  }));
}

module.exports = { splitReportRows, flattenHeaders, parseSettlementTable, thresholdBand, isValidThresholdRange, legacyThresholdPair, applySubagentThresholds, evaluateSubagentThresholds };
