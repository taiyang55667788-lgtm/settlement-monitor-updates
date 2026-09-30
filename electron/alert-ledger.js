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

function bufferedAlertLevel(value, step, entry) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const raw = Math.trunc(value / step);
  const previous = currentLevel(entry);
  if (!raw || Math.sign(raw) !== Math.sign(previous) || Math.abs(raw) >= Math.abs(previous)) return raw;
  // Falling tiers use half-step boundaries, including equality; upward tiers stay fixed.
  const magnitude = Math.min(Math.abs(previous), Math.ceil(Math.abs(value) / step + 0.5) - 1);
  return Math.sign(raw) * Math.max(1, magnitude);
}

function migrateZeroTierHistory(history, transitions = []) {
  if (!history || history.nonzeroRetention === 1) return history;
  const migrated = structuredClone(history);
  for (const [key, entry] of Object.entries(migrated.agents || {})) {
    if (entry?.currentLevel !== 0) continue;
    const last = [...transitions].reverse().find(item => item.key === key && item.period === history.period && item.metric === history.metric);
    const prior = last?.to === 0 ? last.from : last?.to;
    const positive = Number.isSafeInteger(entry.positiveLastAlertLevel) && entry.positiveLastAlertLevel > 0 ? entry.positiveLastAlertLevel : 0;
    const negative = Number.isSafeInteger(entry.negativeLastAlertLevel) && entry.negativeLastAlertLevel < 0 ? entry.negativeLastAlertLevel : 0;
    // Restore only an evidenced last tier. Two directions without chronology are ambiguous.
    const retained = Number.isSafeInteger(prior) && prior !== 0 ? prior : (positive && !negative ? positive : negative && !positive ? negative : 0);
    if (retained) entry.currentLevel = retained;
  }
  migrated.nonzeroRetention = 1;
  return migrated;
}

function pendingAlertNotifications(level, entry, maxIndividual = MAX_INDIVIDUAL_ALERTS, options = {}) {
  // Below the first tier is not a new notification tier and must not rearm it.
  if (!Number.isSafeInteger(level) || level === 0) return [];
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
  result.currentLevel = Number.isSafeInteger(level) && level !== 0 ? level : result.currentLevel;
  if (level > 0) result.positiveLastAlertLevel = level;
  if (level < 0) result.negativeLastAlertLevel = level;
  if (sentAt || entry?.lastSentAt) result.lastSentAt = sentAt || entry.lastSentAt;
  return result;
}

function resetChangedAlertStep(account, path, previousStep, nextStep, time = new Date().toISOString()) {
  if ((previousStep || null) === (nextStep || null)) return;
  const key = alertLedgerKey(path, nextStep);
  if (account.alertHistory?.agents) delete account.alertHistory.agents[key];
  account.alertSettingChanges = [...(account.alertSettingChanges || []), {
    path: [...path], previousStep: previousStep || null, nextStep: nextStep || null, time,
  }].slice(-100);
}

module.exports = { MAX_INDIVIDUAL_ALERTS, ALERT_METRIC, alertLedgerKey, alertHistoryForPeriod, pendingAlertNotifications, recordAlertLevel, migrateZeroTierHistory, resetChangedAlertStep, bufferedAlertLevel };
