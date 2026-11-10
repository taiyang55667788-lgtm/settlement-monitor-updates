const PROFIT_METRIC = 'weekly-agent-profit-v1';
const profitMetric = { id: 'agent-profit', alertMetric: PROFIT_METRIC, label: '盈亏结果', valueLabel: '本周盈亏结果', usesSubagents: true };
function historyFields(metric) {
  return metric === PROFIT_METRIC
    ? { history: 'profitAlertHistory', delivered: 'profitDeliveredAlertHistory' }
    : { history: 'alertHistory', delivered: 'deliveredAlertHistory' };
}
function hasReminder(item) { return [item?.alertStep, item?.deltaAlertStep, item?.profitAlertStep].some(value => Number(value) > 0); }
function profitReadDue(_agent, setting) { return Number(setting?.profitAlertStep) > 0; }
function profitRequiredForPath(path, settings = []) {
  return settings.some(setting => profitReadDue(null, setting) && JSON.stringify(reminderOwnerPath(setting)) === JSON.stringify(path));
}
const OWN_PROFIT_PATH = '@profit:own';
const REPLENISHMENT_PREFIX = '@profit:replenishment:';
function specialProfitPath(kind, owner = []) { return [kind === 'own' ? OWN_PROFIT_PATH : REPLENISHMENT_PREFIX + JSON.stringify(owner)]; }
function specialProfitOwner(path) {
  if (path?.length !== 1) return null;
  if (path[0] === OWN_PROFIT_PATH) return [];
  if (!path[0]?.startsWith(REPLENISHMENT_PREFIX)) return null;
  try { const owner = JSON.parse(path[0].slice(REPLENISHMENT_PREFIX.length));
    return Array.isArray(owner) && owner.length <= 4 && owner.every(x => typeof x === 'string' && x && !x.startsWith('@profit:')) ? owner : null;
  } catch { return null; }
}
function reminderOwnerPath(item) { const path = item.path || [item.name]; return specialProfitOwner(path) ?? path; }
function displayProfitPath(path) {
  const owner = specialProfitOwner(path);
  return owner === null ? path : path[0] === OWN_PROFIT_PATH ? ['本级合计'] : [...owner, '本级补货'];
}
module.exports = { OWN_PROFIT_PATH, specialProfitPath, specialProfitOwner, reminderOwnerPath, displayProfitPath, PROFIT_METRIC, profitMetric, historyFields, hasReminder, profitReadDue, profitRequiredForPath };
