const MAX_INDIVIDUAL_ALERTS = 20;

function alertLedgerKey(path, alertStep) {
  return Buffer.from(JSON.stringify([path, Number(alertStep)])).toString('base64url');
}

function alertHistoryForPeriod(history, period) {
  if (history?.period === period && history.agents && typeof history.agents === 'object' && !Array.isArray(history.agents)) return history;
  return { period, agents: {} };
}

function deliveredMagnitude(entry, direction) {
  const value = direction > 0 ? entry?.positiveMax : entry?.negativeMax;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function pendingAlertNotifications(level, entry, maxIndividual = MAX_INDIVIDUAL_ALERTS) {
  if (!Number.isSafeInteger(level) || level === 0) return [];
  const direction = Math.sign(level);
  const previousMagnitude = deliveredMagnitude(entry, direction);
  const magnitude = Math.abs(level);
  if (magnitude <= previousMagnitude) return [];
  const count = magnitude - previousMagnitude;
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

function recordAlertLevel(entry, level) {
  const result = { positiveMax: deliveredMagnitude(entry, 1), negativeMax: deliveredMagnitude(entry, -1) };
  if (level > 0) result.positiveMax = Math.max(result.positiveMax, level);
  if (level < 0) result.negativeMax = Math.max(result.negativeMax, -level);
  return result;
}

module.exports = { MAX_INDIVIDUAL_ALERTS, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel };
