const DRAW_POLL_MS = 5000;
const DRAW_READ_DELAY_MS = 15000;
const DRAW_STALE_MS = 8 * 60000;

function drawStateFailure(value) {
  if (typeof value === 'string' && /^\s*</.test(value)) return /(?:Member\/Login|type\s*=\s*["']?password)/i.test(value) ? 'DRAW_API_LOGIN_PAGE' : 'DRAW_API_HTML';
  let data;
  try { data = typeof value === 'string' ? JSON.parse(value) : value; } catch { return 'DRAW_API_NOT_JSON'; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'DRAW_API_SHAPE';
  if (data.TemplateCode !== 'JNDPCDD') return 'DRAW_API_TEMPLATE';
  if (!/^\d{5,}$/.test(String(data.Installments || '')) || !/^\d{5,}$/.test(String(data.PreInstallments || ''))
    || compareDrawId(data.PreInstallments, data.Installments) >= 0) return 'DRAW_API_PERIOD';
  if (!/^\d,\d,\d$/.test(String(data.PreLotteryResult || ''))) return 'DRAW_API_RESULT';
  return '';
}

function parseDrawStateResponse(value) {
  if (drawStateFailure(value)) return null;
  let data;
  try { data = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  if (!data || data.TemplateCode !== 'JNDPCDD' || !/^\d{5,}$/.test(String(data.Installments || '')) || !/^\d{5,}$/.test(String(data.PreInstallments || ''))
    || compareDrawId(data.PreInstallments, data.Installments) >= 0 || !/^\d,\d,\d$/.test(String(data.PreLotteryResult || ''))) return null;
  const countdown = Number(data.OpenTimeStamp);
  return { drawId: String(data.PreInstallments), currentDraw: String(data.Installments),
    // This is a hint for polling only. A countdown never authorizes a report read.
    nextPollMs: Number.isFinite(countdown) && countdown > 0 && countdown <= 300 ? Math.max(5000, Math.min(60000, (countdown - 5) * 1000)) : 5000 };
}

function parseReportSettlementDraw(text) {
  // Require an explicit accounting label, never the site's generic draw header.
  const matches = [...compactText(text).matchAll(/(?:账目已结算至|报表已结算至|结算截止期号|已结算期号)\s*[:：]?\s*(?:第)?(\d{5,})\s*期?/g)];
  const ids = [...new Set(matches.map(item => item[1]))];
  return ids.length === 1 ? ids[0] : null;
}

function compactText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only accept an explicitly settled draw.  The current betting draw also
// contains a period number, so accepting a bare number would create false reads.
function parseSettledDraw(value) {
  const text = compactText(value);
  const matches = [...text.matchAll(/(?:第)?(\d{5,})\s*期\s*(?:已)?开奖(?:结果|号码)?(?=[:：\s]|$)/g)];
  if (matches.length) return matches[matches.length - 1][1];
  // A few 166 themes put the period after the settled-label rather than
  // before it.  Keep the explicit settled wording so the current betting
  // period/countdown can never trigger a read.
  const reverse = [...text.matchAll(/(?:上期|上一期|最近一期)(?:开奖(?:结果|号码)?)?[^\d]{0,16}(\d{5,})\s*期?/g)];
  return reverse.length ? reverse[reverse.length - 1][1] : null;
}

function compareDrawId(left, right) {
  try {
    const a = BigInt(String(left || '0'));
    const b = BigInt(String(right || '0'));
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return 0;
  }
}

function observeSettledDraw(previous, drawId, now = Date.now(), delayMs = DRAW_READ_DELAY_MS) {
  const state = { drawId: String(drawId), observedAt: now, changedAt: now };
  if (!previous?.drawId) return { state, changed: false, baseline: true };
  const comparison = compareDrawId(drawId, previous.drawId);
  if (comparison <= 0) return { state: { ...state, drawId: previous.drawId, changedAt: previous.changedAt ?? previous.observedAt }, changed: false, reset: comparison < 0 };
  return { state, changed: true, dueAt: now + delayMs };
}

module.exports = { DRAW_POLL_MS, DRAW_READ_DELAY_MS, DRAW_STALE_MS, compactText, parseSettledDraw, parseReportSettlementDraw, parseDrawStateResponse, drawStateFailure, compareDrawId, observeSettledDraw };
