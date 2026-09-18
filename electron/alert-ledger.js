const MAX_INDIVIDUAL_ALERTS = 20;
const ALERT_METRIC = 'weekly-receivable-downline-v1';

function alertLedgerKey(path, alertStep) {
  return Buffer.from(JSON.stringify([path, Number(alertStep)])).toString('base64url');
}

function alertHistoryForPeriod(history, period, metricInitialized = false) {
  if (history?.period === period && history.metric === ALERT_METRIC
    && history.agents && typeof history.agents === 'object' && !Array.isArray(history.agents)) return history;
  return {
    period,
    metric: ALERT_METRIC,
    agents: {},
    migrationPending: history?.migrationPending === true
      || (history?.metric !== ALERT_METRIC && (Boolean(history) || !metricInitialized)),
  };
}

function deliveredMagnitude(entry, direction) {
  const value = direction > 0 ? entry?.positiveMax : entry?.negativeMax;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function pendingAlertNotifications(level, entry, maxIndividual = MAX_INDIVIDUAL_ALERTS, options = {}) {
  if (!Number.isSafeInteger(level) || level === 0) return [];
  const direction = Math.sign(level);
  const previousMagnitude = deliveredMagnitude(entry, direction);
  const magnitude = Math.abs(level);
  if (magnitude <= previousMagnitude) return [];
  const count = magnitude - previousMagnitude;
  if (options.initialSummary && !entry) {
    return [{ level, previousLevel: 0, combined: count > 1, count, initialSummary: true }];
  }
  if (count > maxIndividual) {
    return [{ level, previousLevel: direction * previousMagnitude, combined: true, count }];
  }
  return Array.from({ length: count }, (_, index) => ({
    level: direction * (previousMagnitude + index + 1),
    previousLevel: direction * (previousMagnitude + index),
    combined: false,
    count: 1,
  }));
}

function recordAlertLevel(entry, level, sentAt = '') {
  const result = { positiveMax: deliveredMagnitude(entry, 1), negativeMax: deliveredMagnitude(entry, -1) };
  if (level > 0) result.positiveMax = Math.max(result.positiveMax, level);
  if (level < 0) result.negativeMax = Math.max(result.negativeMax, -level);
  if (sentAt || entry?.lastSentAt) result.lastSentAt = sentAt || entry.lastSentAt;
  return result;
}

module.exports = { MAX_INDIVIDUAL_ALERTS, ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel };
