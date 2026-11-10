// Templates are learned from this account's own successful UI requests, never
// fabricated from row IDs. They live only in memory, outside exported status.
const caches = new WeakMap();
const MAX_TEMPLATES = 1000;
const TTL = 30 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
function invalid() { return new Error('直接报表结构、日期或代理路径校验失败'); }

function extractReportData(html) {
  const matches = [...String(html).matchAll(/\bvar\s+respData\s*=\s*/g)];
  if (matches.length !== 1) throw invalid();
  const start = matches[0].index + matches[0][0].length;
  if (html[start] !== '{') throw invalid();
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { throw invalid(); }
      }
    }
  }
  throw invalid();
}

function identity(data) {
  return data.orgLevel.map(x => [String(x.orgId), String(x.level)]);
}

function validateData(data, period, fullPath, expectedIdentity) {
  if (data?.State !== 1 || data.sdate !== period.start || data.edate !== period.end
    || !Array.isArray(data.orgLevel) || !fullPath.length
    || JSON.stringify(data.orgLevel.map(x => x.loginId)) !== JSON.stringify(fullPath)
    || !Array.isArray(data.sum?.SumList) || !Number.isFinite(data.sum.sumSubResult)) throw invalid();
  if (expectedIdentity && JSON.stringify(identity(data)) !== JSON.stringify(expectedIdentity)) throw invalid();
  const agents = data.sum.SumList.map(row => {
    if (typeof row.orgName !== 'string' || !row.orgName.trim() || !Number.isFinite(row.subResult)) throw invalid();
    return { name: row.orgName.trim(), value: row.subResult };
  });
  // Until empty/paged reports have been verified, leave those to the UI reader.
  // `total` counts lottery-specific records, not unique SumList agents.
  if (!agents.length || !Number.isInteger(data.total) || data.total < agents.length || data.total >= 500000
    || new Set(agents.map(x => x.name)).size !== agents.length) throw invalid();
  const categories = data.sum.Lotterys;
  if (!Array.isArray(categories) || !categories.length || categories.length > 100
    || new Set(categories).size !== categories.length
    || categories.some(key => typeof key !== 'string' || !Object.hasOwn(data.sum, key) || !Array.isArray(data.sum[key]))) throw invalid();
  const categoryRows = categories.flatMap(key => data.sum[key]);
  const names = [...new Set(categoryRows.map(row => row.orgName))].sort();
  const owner = data.orgLevel.at(-1);
  const ownReplenishment = row => row && row.isBuHuo === 1 && typeof row.orgName === 'string'
    && row.orgId !== undefined && owner.orgId !== undefined
    && /[（(]补货[）)]$/.test(row.orgName.trim())
    && row.orgName.trim().replace(/[（(]补货[）)]$/, '').trim() === owner.loginId
    && String(row.orgId) === String(owner.orgId);
  const supplementary = data.sum.SumList_buhuo;
  if (supplementary !== undefined && (!Array.isArray(supplementary) || supplementary.length > 1 || supplementary.some(row => !ownReplenishment(row)))) throw invalid();
  const replenishmentRows = categories.flatMap(key => {
    const rows = data.sum[key + '_buhuo'];
    if (rows === undefined) return [];
    if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => !ownReplenishment(row))) throw invalid();
    return rows;
  });
  if (replenishmentRows.length && (!supplementary?.length || replenishmentRows.some(row => row.orgName !== supplementary[0].orgName))) throw invalid();
  if (supplementary?.length && !replenishmentRows.length) throw invalid();
  if (categoryRows.length + replenishmentRows.length !== data.total || JSON.stringify(names) !== JSON.stringify(agents.map(x => x.name).sort())) throw invalid();
  return { value: data.sum.sumSubResult, agents, header: '应收下线' };
}

function learnProfitMapping(data, displayed) {
  if (!Number.isFinite(displayed.profitValue) || !displayed.agents?.length) return null;
  const totals = Object.keys(data.sum).filter(key => Number.isFinite(data.sum[key]) && data.sum[key] === displayed.profitValue);
  const rows = data.sum.SumList;
  const displayedByName = new Map(displayed.agents.map(row => [row.name, row.profitRowValue]));
  if (rows.some(row => !Number.isFinite(displayedByName.get(row.orgName)))) return null;
  const fields = Object.keys(rows[0]).filter(key => rows.every(row => Number.isFinite(row[key]) && row[key] === displayedByName.get(row.orgName)));
  // Equal zero/same-valued fields are ambiguous. Stay on the validated DOM.
  if (totals.length !== 1 || fields.length !== 1 || totals[0] === 'sumSubResult' || fields[0] === 'subResult') return null;
  const supplementary = data.sum.SumList_buhuo || [];
  const shown = displayed.replenishments || [];
  if (supplementary.length !== shown.length || supplementary.some(item => !shown.some(x => x.name === item.orgName && Number.isFinite(x.profitValue) && x.profitValue === item[fields[0]]))) return null;
  return { total: totals[0], row: fields[0] };
}

function requestTemplate(request, origin, period) {
  try {
    const url = new URL(request.url);
    if (url.origin !== origin || url.pathname !== '/ReportNew/Agent' || request.method !== 'POST') return null;
    const form = new URLSearchParams(request.body);
    if (form.getAll('querydata').length !== 1 || form.get('startIndex') !== '0' || form.get('rows') !== '500000') return null;
    const q = JSON.parse(form.get('querydata'));
    if (q.startDate !== period.start || q.endDate !== period.end) return null;
    return { url: url.href, body: request.body };
  } catch { return null; }
}

function sessionCache(session) {
  if (!caches.has(session)) caches.set(session, new Map());
  return caches.get(session);
}
function clearDirectSession(session) { if (session) caches.delete(session); }

class DirectReportReader {
  constructor(session, origin, stats, timeoutMs = 8000) {
    this.session = session; this.origin = origin; this.stats = stats; this.timeoutMs = timeoutMs;
  }
  key(path) { return JSON.stringify([this.origin, path]); }
  learn(path, period, request, data, displayed, fullPath) {
    try {
      const template = requestTemplate(request, this.origin, period);
      if (!template || fullPath.length !== path.length + 1 || JSON.stringify(fullPath.slice(1)) !== JSON.stringify(path)) return false;
      const report = validateData(data, period, fullPath);
      const query = JSON.parse(new URLSearchParams(template.body).get('querydata'));
      const last = data.orgLevel.at(-1);
      if (data.orgLevel.some(x => x.orgId === undefined || x.orgId === null || !String(x.orgId) || x.level === undefined)
        || String(query.userid) !== String(last.orgId) || String(query.level) !== String(last.level)) return false;
      const displayedByName = new Map(displayed.agents.map(agent => [agent.name, agent.value]));
      if (report.value !== displayed.value || report.agents.length !== displayed.agents.length
        || report.agents.some(agent => displayedByName.get(agent.name) !== agent.value)) return false;
      const cache = sessionCache(this.session);
      const key = this.key(path);
      cache.delete(key);
      cache.set(key, { ...template, profitMapping: learnProfitMapping(data, displayed), period: { ...period }, fullPath: [...fullPath], identity: identity(data), learnedAt: Date.now() });
      if (cache.size > MAX_TEMPLATES) cache.delete(cache.keys().next().value);
      return true;
    } catch { return false; }
  }
  async read(path, period, { requireProfit = false } = {}) {
    const cache = sessionCache(this.session); const key = this.key(path); const template = cache.get(key);
    if (!template) return null;
    if (requireProfit && !template.profitMapping) return null;
    if (Date.now() - template.learnedAt > TTL || template.period.start !== period.start || template.period.end !== period.end) {
      cache.delete(key); return null;
    }
    const started = Date.now();
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.stats.attempts++;
    try {
      const response = await this.session.fetch(template.url, {
        method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: template.body,
      });
      if (response.status !== 200 || Number(response.headers.get('content-length')) > MAX_BYTES) throw invalid();
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) throw invalid();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const data = extractReportData(Buffer.concat(chunks).toString('utf8'));
      const result = validateData(data, period, template.fullPath, template.identity);
      if (template.profitMapping) {
        const { total, row } = template.profitMapping;
        if (!Number.isFinite(data.sum[total]) || data.sum.SumList.some(item => !Number.isFinite(item[row]))) throw invalid();
        if ((data.sum.SumList_buhuo || []).some(item => !Number.isFinite(item[row]))) throw invalid();
        result.replenishments = (data.sum.SumList_buhuo || []).map(item => ({ name: item.orgName, profitValue: item[row] }));
        result.profitValue = data.sum[total]; result.profitSupported = true; result.profitIssue = '';
        result.agents = result.agents.map((agent, index) => ({ ...agent, profitRowValue: data.sum.SumList[index][row] }));
      }
      if (controller.signal.aborted) throw invalid();
      this.stats.successes++; this.stats.lastMs = Date.now() - started;
      this.stats.totalMs += this.stats.lastMs;
      return result;
    } catch {
      const interrupted = controller.signal.aborted;
      controller.abort();
      cache.clear(); // Stop a failing transport for the remainder of this round.
      this.disabled = true;
      this.stats.failures++; this.stats.fallbacks++;
      this.stats.lastFailure = interrupted ? '直接读取超时或中断，回退网页' : '直接读取未通过校验，回退网页';
      return null;
    } finally { clearTimeout(timer); this.controller = null; }
  }
  cancel() { this.controller?.abort(); }
}

module.exports = { DirectReportReader, clearDirectSession, extractReportData, validateData, requestTemplate };
