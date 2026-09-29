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

function findMetricColumn(headers, metric) {
  const label = String(metric?.columnLabel || '应收下线');
  const matches = headers.flatMap((header, index) =>
    header.split('/').at(-1).trim() === label ? [index] : []);
  if (matches.length !== 1) throw new Error(`本周报表未找到唯一的“${label}”列，已停止提醒以免误取其他金额`);
  return matches[0];
}

function findUniqueColumn(headers, label) {
  const matches = headers.flatMap((header, index) =>
    header.split('/').at(-1).trim() === label ? [index] : []);
  if (matches.length !== 1) throw new Error(`本周总代理明细未找到唯一的“${label}”列，已停止提醒以免误取其他金额`);
  return matches[0];
}

function parseSettlementTable({ headerRows, dataRows }, metric) {
  if (!dataRows?.length) throw new Error('本周报表没有数据');
  const totalRow = [...dataRows].reverse().find((row) => normalize(row[0]).includes('合计')) || dataRows[0];
  const headers = flattenHeaders(headerRows || []);
  const label = String(metric?.columnLabel || '应收下线');
  const column = findMetricColumn(headers, metric);
  if (column >= totalRow.length) throw new Error(`“${label}”列与报表数据不对齐，已停止提醒`);
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

function parseCrownGeneralAgentTable({ headerRows, dataRows }) {
  if (!dataRows?.length) throw new Error('本周总代理明细没有数据');
  const headers = flattenHeaders(headerRows || []);
  const accountColumn = findUniqueColumn(headers, '总代理帐号');
  const resultColumn = findUniqueColumn(headers, '总代理结果');
  const turnoverColumn = findUniqueColumn(headers, '总代理实货量');
  const totalRow = dataRows.find((row) => normalize(row[accountColumn]) === '总计');
  if (!totalRow) throw new Error('本周总代理明细没有“总计”行');
  if (Math.max(resultColumn, turnoverColumn) >= totalRow.length) throw new Error('总代理结果或实货量列与报表数据不对齐，已停止提醒');
  const agents = dataRows
    .filter((row) => normalize(row[accountColumn]) && normalize(row[accountColumn]) !== '总计')
    .map((row) => ({
      name: String(row[accountColumn] || '').trim(),
      value: numericValue(row[resultColumn]),
      turnover: numericValue(row[turnoverColumn]),
    }));
  if (!agents.length) throw new Error('本周总代理明细没有可监控的总代理账号');
  if (new Set(agents.map((agent) => agent.name)).size !== agents.length) throw new Error('本周总代理明细存在重复账号，已停止提醒以免合并错误');
  return {
    value: numericValue(totalRow[resultColumn]),
    turnover: numericValue(totalRow[turnoverColumn]),
    agents,
    resultColumn,
    turnoverColumn,
    header: headers[resultColumn],
  };
}

// 皇冠当前的「报表 / 有结果」页面并非 table：左侧是帐号列，右侧是同步滚动的
// 数值列。调用方只传入已由同一帐号 ID 对齐的值，仍在这里集中做金额和重复帐号校验。
function parseCrownDashboardDetails({ total, agents }) {
  const totalCells = Array.isArray(total) ? total : [];
  if (totalCells.length < 2) throw new Error('皇冠总代理明细没有完整的总计结果和实货量');
  if (!Array.isArray(agents) || !agents.length) throw new Error('皇冠总代理明细没有可监控的总代理账号');
  const parsedAgents = agents.map((agent) => {
    const name = String(agent?.name || '').trim();
    const values = Array.isArray(agent?.values) ? agent.values : [];
    if (!name || values.length < 2) throw new Error('皇冠总代理明细帐号与结果没有一一对齐，已停止提醒');
    return { name, value: numericValue(values[0]), turnover: numericValue(values[1]) };
  });
  if (new Set(parsedAgents.map((agent) => agent.name)).size !== parsedAgents.length) {
    throw new Error('皇冠总代理明细存在重复账号，已停止提醒以免合并错误');
  }
  return {
    value: numericValue(totalCells[0]),
    turnover: numericValue(totalCells[1]),
    agents: parsedAgents,
    header: '总代理结果',
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

module.exports = { splitReportRows, flattenHeaders, findMetricColumn, parseSettlementTable, parseCrownGeneralAgentTable, parseCrownDashboardDetails, alertStepFromLegacy, alertLevel, legacyAlertStep, agentPath, agentPathKey, applySubagentAlertSteps, evaluateSubagentAlertLevels };
