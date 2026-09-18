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
      .map((row) => row.flatMap((cell) => {
        const values = [String(cell.text || '').trim()];
        const colspan = Math.max(1, Number(cell.colspan || 1));
        return values.concat(Array.from({ length: colspan - 1 }, () => ''));
      })),
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

function findReceivableColumn(headers) {
  const matches = headers.flatMap((header, index) =>
    header.split('/').at(-1).trim() === '应收下线' ? [index] : []);
  if (matches.length !== 1) throw new Error('本周报表未找到唯一的“应收下线”列，已停止提醒以免误取其他金额');
  return matches[0];
}

function parseSettlementTable({ headerRows, dataRows }) {
  if (!dataRows?.length) throw new Error('本周报表没有数据');
  const totalRow = [...dataRows].reverse().find((row) => normalize(row[0]).includes('合计')) || dataRows[0];
  const headers = flattenHeaders(headerRows || []);
  const column = findReceivableColumn(headers);
  if (column >= totalRow.length) throw new Error('“应收下线”列与报表数据不对齐，已停止提醒');
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
    header: headers[column],
    raw: totalRow[column],
  };
}

function alertStepFromLegacy(configuration) {
  if (Number.isFinite(configuration?.alertStep) && configuration.alertStep > 0) return configuration.alertStep;
  const candidates = [configuration?.lowerThreshold, configuration?.upperThreshold, configuration?.threshold]
    .filter(Number.isFinite)
    .map(Math.abs)
    .filter((value) => value > 0);
  return candidates.length ? Math.min(...candidates) : null;
}

function alertLevel(value, alertStep) {
  if (!Number.isFinite(value) || !Number.isFinite(alertStep) || alertStep <= 0) return 0;
  const level = Math.trunc(value / alertStep);
  return Object.is(level, -0) ? 0 : level;
}

function legacyAlertStep(account) {
  return alertStepFromLegacy(account);
}

function agentPath(agent) {
  if (Array.isArray(agent?.path) && agent.path.length) return agent.path.map((part) => String(part).trim()).filter(Boolean);
  return agent?.name ? [String(agent.name).trim()] : [];
}

function agentPathKey(path) {
  return JSON.stringify(path);
}

function applySubagentAlertSteps(agents, configurations) {
  const configured = Array.isArray(configurations) ? configurations : [];
  return (agents || []).map((agent) => {
    const path = agentPath(agent);
    const custom = configured.find((item) => agentPathKey(agentPath(item)) === agentPathKey(path));
    return {
      ...agent,
      path,
      remark: String(custom?.remark || '').trim(),
      alertStep: alertStepFromLegacy(custom),
      customized: Boolean(custom),
    };
  });
}

function evaluateSubagentAlertLevels(subagents) {
  return (subagents || []).map((subagent) => ({
    subagent,
    level: alertLevel(subagent.value, subagent.alertStep),
  }));
}

module.exports = { splitReportRows, flattenHeaders, parseSettlementTable, alertStepFromLegacy, alertLevel, legacyAlertStep, agentPath, agentPathKey, applySubagentAlertSteps, evaluateSubagentAlertLevels };
