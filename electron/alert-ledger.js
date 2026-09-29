const MAX_INDIVIDUAL_ALERTS = 20;
const ALERT_METRIC = 'weekly-receivable-downline-v2';

function alertLedgerKey(path, alertStep) {
  return Buffer.from(JSON.stringify([path, Number(alertStep)])).toString('base64url');
}

function alertHistoryForPeriod(history, period, metric = ALERT_METRIC, metricInitialized = false) {
  if (typeof metric === 'boolean') {
    metricInitialized = metric;
    metric = ALERT_METRIC;
  }
  if (history?.period === period && history.metric === metric
    && history.agents && typeof history.agents === 'object' && !Array.isArray(history.agents)) return history;
  return {
    period,
    metric,
    agents: {},
    migrationPending: history?.migrationPending === true
      || (history?.metric !== metric && (Boolean(history) || !metricInitialized)),
  };
}

function currentLevel(entry) {
  return Number.isSafeInteger(entry?.currentLevel) ? entry.currentLevel : 0;
}

function pendingAlertNotifications(level, entry, maxIndividual = MAX_INDIVIDUAL_ALERTS, options = {}) {
  if (!Number.isSafeInteger(level)) return [];
  const previousLevel = currentLevel(entry);
  if (level === previousLevel) return [];
  if (options.initialSummary && !entry && level !== 0) {
    return [{ level, previousLevel: 0, combined: Math.abs(level) > 1, count: Math.abs(level), initialSummary: true }];
  }
  const change = level - previousLevel;
  const crossed = Array.from({ length: Math.abs(change) }, (_, index) => {
    const nextLevel = previousLevel + Math.sign(change) * (index + 1);
    return { level: nextLevel, previousLevel: nextLevel - Math.sign(change) };
  }).filter((item) => item.level !== 0);
  if (crossed.length > maxIndividual) {
    return [{ level, previousLevel, combined: true, count: crossed.length }];
  }
  return crossed.map((item) => ({ ...item, combined: false, count: 1 }));
}

function recordAlertLevel(entry, level, sentAt = '') {
  const result = {
    currentLevel: currentLevel(entry),
    positiveLastAlertLevel: Number.isSafeInteger(entry?.positiveLastAlertLevel) ? entry.positiveLastAlertLevel : 0,
    negativeLastAlertLevel: Number.isSafeInteger(entry?.negativeLastAlertLevel) ? entry.negativeLastAlertLevel : 0,
  };
  result.currentLevel = Number.isSafeInteger(level) ? level : result.currentLevel;
  if (level > 0) result.positiveLastAlertLevel = level;
  if (level < 0) result.negativeLastAlertLevel = level;
  if (sentAt || entry?.lastSentAt) result.lastSentAt = sentAt || entry.lastSentAt;
  return result;
}

module.exports = { MAX_INDIVIDUAL_ALERTS, ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel };
