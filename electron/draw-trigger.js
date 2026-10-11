const DRAW_POLL_MS = 5000;
const DRAW_READ_DELAY_MS = 10000;

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
  const state = { drawId: String(drawId), observedAt: now };
  if (!previous?.drawId) return { state, changed: false, baseline: true };
  const comparison = compareDrawId(drawId, previous.drawId);
  if (comparison <= 0) return { state, changed: false, reset: comparison < 0 };
  return { state, changed: true, dueAt: now + delayMs };
}

module.exports = { DRAW_POLL_MS, DRAW_READ_DELAY_MS, compactText, parseSettledDraw, compareDrawId, observeSettledDraw };
