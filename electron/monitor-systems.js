const { RECEIVABLE_DOWNLINE, GENERAL_AGENT_RESULT, AGENT_RESULT, MEMBER_RESULT, monitorMetric } = require('./monitor-metrics');

const SYSTEM_166 = 'system-166';
const SYSTEM_CROWN = 'crown';
const FIXED_166_URL = 'https://166.tt';
const CROWN_URLS = ['https://ag.hga050.com', 'https://ag.hga030.com', 'https://ag.mos011.com'];

const CROWN_LOGIN_ENTRIES = {
  'login-1': { id: 'login-1', label: '登入一', aliases: ['登入一', '登录一', '登入1', '登录1'], metric: GENERAL_AGENT_RESULT },
  'login-2': { id: 'login-2', label: '登入二', aliases: ['登入二', '登录二', '登入2', '登录2'], metric: GENERAL_AGENT_RESULT },
  'login-3': { id: 'login-3', label: '登入三', aliases: ['登入三', '登录三', '登入3', '登录3'], metric: GENERAL_AGENT_RESULT },
};

function crownUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return CROWN_URLS.find((candidate) => new URL(candidate).host === url.host) || CROWN_URLS[0];
  } catch {
    return CROWN_URLS[0];
  }
}

function accountSystemId(account = {}) {
  if (account.systemType === SYSTEM_CROWN) return SYSTEM_CROWN;
  if (account.systemType === SYSTEM_166) return SYSTEM_166;
  return [GENERAL_AGENT_RESULT, AGENT_RESULT, MEMBER_RESULT].includes(account.monitorMetric) ? SYSTEM_CROWN : SYSTEM_166;
}

function crownLoginEntryId(value, metric) {
  if (CROWN_LOGIN_ENTRIES[value]) return value;
  if (metric === AGENT_RESULT) return 'login-2';
  if (metric === MEMBER_RESULT) return 'login-3';
  return 'login-1';
}

function crownLoginEntry(value, metric) {
  return CROWN_LOGIN_ENTRIES[crownLoginEntryId(value, metric)];
}

function metricForAccount(account = {}) {
  if (accountSystemId(account) === SYSTEM_CROWN) {
    return monitorMetric(crownLoginEntry(account.crownLoginEntry, account.monitorMetric).metric);
  }
  return monitorMetric(RECEIVABLE_DOWNLINE);
}

function accountBaseUrl(account = {}) {
  return accountSystemId(account) === SYSTEM_CROWN ? crownUrl(account.crownDomain || account.navUrl) : FIXED_166_URL;
}

module.exports = {
  SYSTEM_166,
  SYSTEM_CROWN,
  FIXED_166_URL,
  CROWN_URLS,
  accountSystemId,
  crownLoginEntryId,
  crownLoginEntry,
  metricForAccount,
  accountBaseUrl,
  crownUrl,
};
