const PROFIT_METRIC = 'weekly-agent-profit-v1';
const PROFIT_REFRESH_MS = 10 * 60000;
const profitMetric = { id: 'agent-profit', alertMetric: PROFIT_METRIC, label: '盈亏结果', valueLabel: '本周盈亏结果', usesSubagents: true };
function historyFields(metric) {
  return metric === PROFIT_METRIC
    ? { history: 'profitAlertHistory', delivered: 'profitDeliveredAlertHistory' }
    : { history: 'alertHistory', delivered: 'deliveredAlertHistory' };
}
function hasReminder(item) { return [item?.alertStep, item?.deltaAlertStep, item?.profitAlertStep].some(value => Number(value) > 0); }
function profitReadDue(agent, setting, now = Date.now()) {
  if (Number(setting?.profitAlertStep) > 0) return true;
  const checked = Date.parse(agent?.profitCheckedAt || agent?.profitReadAt || '');
  return !Number.isFinite(checked) || now < checked || now - checked >= PROFIT_REFRESH_MS;
}
module.exports = { PROFIT_METRIC, PROFIT_REFRESH_MS, profitMetric, historyFields, hasReminder, profitReadDue };
