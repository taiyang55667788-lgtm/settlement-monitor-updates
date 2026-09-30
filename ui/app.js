let appState = { accounts: [], events: [], telegram: {} };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const statusNames = { waiting: '等待首次检查', checking: '读取中', ok: '运行正常', triggered: '运行正常', error: '读取异常', partial: '部分读取失败', stale: '数据过期', recovering: '正在恢复', manual: '需要手动处理', paused: '已暂停' };
const thresholdDrafts = new Map();
const collapsedAgentPaths = new Set();
const reminderOnlyAccounts = new Set();
const filteredCollapsedPaths = new Set();
const MAX_AGENT_DEPTH = 4;
let readingDetailsAccountId = null;
let previousAccountMarkup = '';
let queuePage = 0;

function renderQueue() {
  if (!$('#notification-dialog').open) return;
  const items = appState.notificationQueue?.items || [];
  queuePage = Math.min(queuePage, Math.max(0, Math.ceil(items.length / 20) - 1));
  $('#notification-items').innerHTML = items.slice(queuePage * 20, queuePage * 20 + 20).map(item => `<article class="queued-message">
    <strong>${item.held ? '收件人变更，暂存中' : '等待发送'} · ${escapeHtml(item.id.slice(0, 8))}</strong>
    <small>原始时间：${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))} · 已尝试 ${Number(item.attempts) || 0} 次</small>
    <pre>${escapeHtml(item.text)}</pre><p class="child-error">${escapeHtml(item.error)}</p>
    <button class="secondary" data-queue-action="retry" data-queue-id="${escapeHtml(item.id)}" ${item.held ? 'disabled' : ''}>立即重试</button>
    <button class="secondary" data-queue-action="cancel" data-queue-id="${escapeHtml(item.id)}">取消此条</button></article>`).join('') || '<p>暂无待发通知</p>';
  $('#queue-page').textContent = `${queuePage + 1} / ${Math.max(1, Math.ceil(items.length / 20))}`;
  $('#queue-prev').disabled = queuePage === 0;
  $('#queue-next').disabled = (queuePage + 1) * 20 >= items.length;
}

function staleLabel(agent) {
  if (agent.staleReason === 'waiting') return '本轮尚未读到，等待更新';
  if (agent.staleReason === 'checkpoint') return '结构已扫描，金额等待按需更新';
  if (agent.notRefreshed || agent.staleReason === 'on-demand') return '未设置提醒，按需更新（保留上次数据）';
  return '读取失败，保留旧数据';
}

function dataAge(agent) {
  if (!(Number(agent.alertStep) > 0 || Number(agent.deltaAlertStep) > 0)) return '';
  const time = Date.parse(agent.readAt || '');
  return `<small class="read-time">重点数据：${Number.isFinite(time) ? `${Math.max(0, Math.floor((Date.now() - time) / 60000))} 分钟前更新` : '尚未成功更新'}</small>`;
}

function refreshReadingDetails() {
  if (!$('#reading-dialog').open) return;
  const account = appState.accounts.find(item => item.id === readingDetailsAccountId);
  $('#reading-details-content').textContent = account ? [
    `账号：${account.name}`, `状态：${statusNames[account.status] || '等待读取'}`,
    `过程：${account.stage || '尚未开始'}`, `模式：${account.scanMode || '首次扫描'}`,
    `已读取：${account.readProgress?.read || 0} 个代理；待查分支：${account.readProgress?.pendingBranches ?? '—'}`,
    `最近成功：${account.lastSuccessAt ? new Date(account.lastSuccessAt).toLocaleString('zh-CN') : '尚未成功'}`,
    `上轮耗时：${Number.isFinite(account.durationMs) ? (account.durationMs / 1000).toFixed(1) + ' 秒' : '—'}`,
    `最近本周报表查询：${Number.isFinite(account.lastQueryMs) ? (account.lastQueryMs / 1000).toFixed(1) + ' 秒' : '—'}`,
    `下次检查：${account.nextCheckAt ? new Date(account.nextCheckAt).toLocaleString('zh-CN') : '待安排'}`,
    `异常：${account.error || '无'}`,
    `过期重点代理：${(account.staleTargets || []).map(path => path.join(' / ')).join('；') || '无'}`,
    `通知队列：待发 ${appState.notificationQueue?.pending || 0} 条；失败待重试 ${appState.notificationQueue?.failed || 0} 条；收件人已变更暂存 ${appState.notificationQueue?.held || 0} 条`,
    ...(account.phaseTimings?.branches || []).map(item => `${item.path.join(' / ')}：${(item.durationMs / 1000).toFixed(1)} 秒${item.error ? ' · ' + item.error : ''}`),
  ].join('\n') : '账号已删除';
}

// Reuse keyed account/agent DOM nodes to preserve focus, expanded rows and scroll.
function patchChildren(parent, next) {
  const key = node => node.nodeType === 1 ? node.dataset.id || node.dataset.agentKey || node.id || '' : '';
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const wantedKey = key(desired);
    let current = wantedKey ? [...parent.childNodes].find(node => key(node) === wantedKey) : cursor;
    if (!current || current.nodeType !== desired.nodeType || current.nodeName !== desired.nodeName || key(current) !== wantedKey) {
      current = desired.cloneNode(true);
      parent.insertBefore(current, cursor);
    } else {
      if (current !== cursor) parent.insertBefore(current, cursor);
      if (current.nodeType === 3) { if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue; }
      else if (current.nodeType === 1) {
        for (const attr of [...current.attributes]) if (!desired.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of desired.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        if (current instanceof HTMLInputElement && current !== document.activeElement && current.value !== desired.value) current.value = desired.value;
        patchChildren(current, desired);
      }
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const nextNode = cursor.nextSibling; cursor.remove(); cursor = nextNode; }
}

const monitorMetrics = {
  'receivable-downline': { label: '应收下线', sectionLabel: '代理应收下线', valueLabel: '本周应收下线', usesSubagents: true },
  'general-agent-result': { label: '总代理明细', sectionLabel: '本周总代理明细', valueLabel: '总代理结果', usesSubagents: true, readsDescendants: false, agentLabel: '总代理', hasTurnover: true, turnoverLabel: '总代理实货量' },
  'agent-result': { label: '代理商结果', sectionLabel: '本周代理商交收', valueLabel: '本周代理商交收', usesSubagents: false },
  'member-result': { label: '会员结果', sectionLabel: '本周会员交收', valueLabel: '本周会员交收', usesSubagents: false },
};

function monitorMetric(account) {
  return monitorMetrics[account?.monitorMetric] || monitorMetrics['receivable-downline'];
}

function systemLabel(account) {
  if (account?.systemType !== 'crown') return '166 系统';
  const entries = { 'login-1': '登入一', 'login-2': '登入二', 'login-3': '登入三' };
  return `皇冠 · ${entries[account.crownLoginEntry] || '登入一'}`;
}

const pathKey = (path) => JSON.stringify(path);
const thresholdDraftKey = (accountId, path) => `${accountId}\u0000${pathKey(path)}`;

function isSubagentTriggered(subagent) {
  return !subagent.stale && Number.isFinite(subagent.alertStep) && subagent.alertStep > 0 && Math.abs(subagent.value) >= subagent.alertStep;
}

function notifiedRange(level, step, direction) {
  if (!Number.isSafeInteger(level) || level === 0 || !Number.isFinite(step) || step <= 0) return '未提醒';
  const sign = direction > 0 ? '+' : '−';
  return `${sign}${compactMoney.format(Math.abs(level) * step)}（最近）`;
}

function alertReason(subagent) {
  if (subagent.pendingNotifications) return `通知待发送 ${subagent.pendingNotifications} 条`;
  if (subagent.stale) return `${staleLabel(subagent)}；暂停该行提醒`;
  if (!Number.isFinite(subagent.alertStep) || subagent.alertStep <= 0) return '未设置提醒间隔';
  if (subagent.alertError) return `通知失败：${subagent.alertError}`;
  const level = Math.trunc(subagent.value / subagent.alertStep);
  if (!level) return subagent.lastObservedLevel
    ? `未达首档；保留 ${compactMoney.format(subagent.lastObservedLevel * subagent.alertStep)} 档记录`
    : '尚未达到首档';
  if (level !== subagent.lastObservedLevel && subagent.effectiveAlertLevel === subagent.lastObservedLevel) {
    return `回落缓冲中；降档线 ${compactMoney.format(Math.sign(level) * (Math.abs(subagent.lastObservedLevel) - 0.5) * subagent.alertStep)}`;
  }
  return level === subagent.lastObservedLevel ? '当前档位已通知' : '新档位待通知';
}

function thresholdProgress(subagent) {
  if (subagent.stale || !Number.isFinite(subagent.alertStep) || subagent.alertStep <= 0 || !Number.isFinite(subagent.value)) return '';
  const step = subagent.alertStep;
  if (subagent.value >= 0) {
    const next = (Math.max(Math.trunc(subagent.value / step), subagent.effectiveAlertLevel || 0) + 1) * step;
    return `<small class="threshold-progress positive">下一档 +${compactMoney.format(next)} · 差 ${compactMoney.format(next - subagent.value)}</small>`;
  }
  const next = (Math.min(Math.trunc(subagent.value / step), subagent.effectiveAlertLevel || 0) - 1) * step;
  return `<small class="threshold-progress negative">下一档 −${compactMoney.format(Math.abs(next))} · 差 ${compactMoney.format(Math.abs(next - subagent.value))}</small>`;
}

function sameOptionalThreshold(value, configured) {
  const input = String(value ?? '').trim();
  if (!input) return !(Number.isFinite(configured) && configured > 0);
  return Number.isFinite(Number(input)) && Number(input) === configured;
}

function hasUnsavedThresholdChange(subagent, draft) {
  if (!draft) return false;
  return !sameOptionalThreshold(draft.alertStep, subagent.alertStep)
    || !sameOptionalThreshold(draft.deltaAlertStep, subagent.deltaAlertStep)
    || String(draft.remark ?? '') !== String(subagent.remark ?? '');
}

function recentAlert(subagent) {
  if (!subagent.lastAlertAt) return '';
  return `<small class="recent-alert">最近提醒：${escapeHtml(new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(subagent.lastAlertAt)))}</small>`;
}

function hasReminder(agent) {
  return Number(agent.alertStep) > 0 || Number(agent.deltaAlertStep) > 0;
}

function agentToolbar(account) {
  if (!monitorMetric(account).usesSubagents) return '';
  const only = reminderOnlyAccounts.has(account.id);
  const descendants = monitorMetric(account).readsDescendants !== false;
  return `<div class="agent-toolbar"><button class="secondary" data-action="filter-reminders" aria-pressed="${only}">${only ? '显示全部代理' : '只看已设置提醒'}</button>${descendants ? '<button class="secondary" data-action="collapse-agents">收起全部</button><button class="secondary" data-action="full-scan" title="重新发现最多四级代理并刷新全部金额">全量扫描</button>' : ''}<small>${descendants ? `${escapeHtml(account.scanMode || '首次全量扫描')} · 日常读前两级及深层提醒分支` : ''}${only ? ' · 仅显示提醒代理及上级路径' : ''}</small></div>`;
}

function reminderSettings(name, alertStep, deltaAlertStep) {
  return `<td class="reminder-settings"><label><span>金额档位</span><input data-field="alertStep" type="number" min="0.01" step="0.01" value="${alertStep}" placeholder="留空关闭" aria-label="${escapeHtml(name)}的金额档位提醒" /></label><label><span>变化阈值</span><input data-field="deltaAlertStep" type="number" min="0.01" step="0.01" value="${deltaAlertStep}" placeholder="留空关闭" aria-label="${escapeHtml(name)}的变化量提醒" /></label></td>`;
}

function trendChart(trend, path) {
  const key = pathKey(path);
  const values = (trend || []).map((point) => point.agents?.find((agent) => pathKey(agent.path) === key)?.value).filter(Number.isFinite).slice(-80);
  if (values.length < 2) return '<span class="trend-empty">趋势数据积累中</span>';
  const low = Math.min(...values); const high = Math.max(...values); const range = high - low || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1) * 100).toFixed(1)},${(26 - ((value - low) / range * 22)).toFixed(1)}`).join(' ');
  const delta = values.at(-1) - values[0];
  return `<span class="trend-chart ${delta < 0 ? 'down' : 'up'}" title="最近 ${values.length} 次成功读取：最低 ${compactMoney.format(low)}，最高 ${compactMoney.format(high)}，变化 ${delta > 0 ? '+' : ''}${compactMoney.format(delta)}"><svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" /></svg><small>${delta > 0 ? '+' : ''}${compactMoney.format(delta)}</small></span>`;
}

function routePreview(account) {
  if (!account?.routes?.length) return '<span>保存后将自动测速并显示代理线路</span>';
  return account.routes.map((route, index) => {
    let host = route.text;
    try { host = new URL(route.text).host; } catch {}
    return `<div class="route-item"><code>${escapeHtml(host)}</code><strong>${route.speed < 99999 ? `${route.speed}ms` : '待测速'}${index === 0 ? ' · 最快' : ''}</strong></div>`;
  }).join('');
}

function totalSettlementList(account) {
  const metric = monitorMetric(account);
  const target = account.subagents?.[0];
  if (!Number.isFinite(account.subagentCount)) return `<div class="subagent-empty">登录并完成首次检查后，这里会显示${metric.label}。</div>`;
  if (!target) return `<div class="subagent-empty">本次未能读取${metric.label}。</div>`;
  const path = target.path || [target.name];
  const draft = thresholdDrafts.get(thresholdDraftKey(account.id, path));
  const alertStep = draft ? draft.alertStep : (Number.isFinite(target.alertStep) ? target.alertStep : '');
  const deltaAlertStep = draft ? draft.deltaAlertStep : (Number.isFinite(target.deltaAlertStep) ? target.deltaAlertStep : '');
  const remark = draft ? draft.remark : (target.remark || '');
  const dirty = hasUnsavedThresholdChange(target, draft);
  const readAtFull = target.readAt ? new Date(target.readAt).toLocaleString('zh-CN') : '尚未成功读取';
  const readAt = target.readAt ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(target.readAt)) : '尚未成功读取';
  const positiveRange = notifiedRange(target.alertedPositiveLevel, target.alertStep, 1);
  const negativeRange = notifiedRange(target.alertedNegativeLevel, target.alertStep, -1);
  const lastAlert = target.lastAlertAt ? ` · 最近通知：${new Date(target.lastAlertAt).toLocaleString('zh-CN')}` : '';
  return `<div class="agent-table-scroll"><table class="agent-table"><thead><tr><th scope="col">监控项 / 最后成功读取</th><th scope="col">${metric.valueLabel}</th><th scope="col">提醒状态</th><th scope="col">备注（同步通知）</th><th scope="col">提醒设置</th><th scope="col">操作</th></tr></thead><tbody><tr class="subagent-row ${target.stale ? 'stale' : ''} ${dirty ? 'has-unsaved' : ''}" data-subagent-index="0">
    <td><div class="subagent-name"><span class="tree-leaf" aria-hidden="true">◆</span><div><strong>${escapeHtml(metric.label)}</strong><small>本周交收总额</small><small class="read-time" title="${escapeHtml(readAtFull)}">最后成功读取：${escapeHtml(readAt)}</small>${dataAge(target)}${target.stale ? `<small class="child-error">${staleLabel(target)}</small>` : ''}</div></div></td>
    <td class="subagent-value ${target.value < 0 ? 'negative' : target.value > 0 ? 'positive' : 'zero'}">${target.value > 0 ? '+' : ''}${money.format(target.value)}${trendChart(account.trend, path)}</td>
    <td class="notified-tiers" title="正向：${escapeHtml(positiveRange)}；负向：${escapeHtml(negativeRange)}${escapeHtml(lastAlert)}"><span class="tier-positive">🔵 ${escapeHtml(positiveRange)}</span><span class="tier-negative">🔴 ${escapeHtml(negativeRange)}</span><small title="${escapeHtml(alertReason(target))}">${escapeHtml(alertReason(target))}</small>${thresholdProgress(target)}${recentAlert(target)}</td>
    <td><input data-field="remark" type="text" maxlength="100" value="${escapeHtml(remark)}" placeholder="备注同步到 Telegram" aria-label="${escapeHtml(metric.label)}的备注" /></td>
    ${reminderSettings(metric.label, alertStep, deltaAlertStep)}
    <td><button class="secondary ${dirty ? 'has-unsaved' : ''}" data-action="save-subagent">${dirty ? '保存修改' : '保存'}</button><small class="unsaved-hint" ${dirty ? '' : 'hidden'}>未保存</small></td>
  </tr></tbody></table></div>`;
}

function subagentList(account) {
  const metric = monitorMetric(account);
  if (!metric.usesSubagents) return totalSettlementList(account);
  const readsDescendants = metric.readsDescendants !== false;
  const hasTurnover = metric.hasTurnover === true;
  const agentLabel = metric.agentLabel || '直属代理';
  if (!Number.isFinite(account.subagentCount)) {
    return '<div class="subagent-empty">登录并完成首次检查后，这里会显示最多四级下级代理。</div>';
  }
  if (!account.subagents?.length) return '<div class="subagent-empty">本级账号下暂未发现代理。</div>';
  const only = reminderOnlyAccounts.has(account.id);
  const targets = account.subagents.filter(hasReminder).map(agent => agent.path || [agent.name]);
  const indexed = account.subagents.map((subagent, index) => ({ subagent, index })).filter(({subagent}) => {
    const path = subagent.path || [subagent.name];
    return !only || targets.some(target => target.length >= path.length && path.every((part, index) => target[index] === part));
  });
  if (!indexed.length) return '<div class="subagent-empty">暂无已设置提醒的代理；点击“显示全部代理”进行设置。</div>';
  const childrenOf = (parentPath) => indexed.filter(({ subagent }) => {
    const path = subagent.path || [subagent.name];
    return path.length === parentPath.length + 1 && parentPath.every((part, index) => path[index] === part);
  });
  const isExpanded = (path) => only ? !filteredCollapsedPaths.has(thresholdDraftKey(account.id, path)) : (account.expandedAgentPaths || []).some((item) => pathKey(item) === pathKey(path))
    && !collapsedAgentPaths.has(thresholdDraftKey(account.id, path));
  const renderRow = ({ subagent, index }, expanded = false, childCount = 0) => {
    const path = subagent.path || [subagent.name];
    const depth = path.length;
    const canExpand = readsDescendants && depth < MAX_AGENT_DEPTH
      && (childCount > 0 || Number(subagent.childCount) > 0 || Boolean(subagent.childError));
    const draft = thresholdDrafts.get(thresholdDraftKey(account.id, path));
    const alertStep = draft ? draft.alertStep : (Number.isFinite(subagent.alertStep) ? subagent.alertStep : '');
    const deltaAlertStep = draft ? draft.deltaAlertStep : (Number.isFinite(subagent.deltaAlertStep) ? subagent.deltaAlertStep : '');
    const remark = draft ? draft.remark : (subagent.remark || '');
    const dirty = hasUnsavedThresholdChange(subagent, draft);
    const readAtFull = subagent.readAt ? new Date(subagent.readAt).toLocaleString('zh-CN') : '尚未成功读取';
    const readAt = subagent.readAt ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(subagent.readAt)) : '尚未成功读取';
    const positiveRange = notifiedRange(subagent.alertedPositiveLevel, subagent.alertStep, 1);
    const negativeRange = notifiedRange(subagent.alertedNegativeLevel, subagent.alertStep, -1);
    const lastAlert = subagent.lastAlertAt ? ` · 最近通知：${new Date(subagent.lastAlertAt).toLocaleString('zh-CN')}` : '';
    return `<tr class="subagent-row level-${depth} ${depth === 1 ? 'first-level' : 'nested-level'} ${subagent.stale ? 'stale' : ''} ${dirty ? 'has-unsaved' : ''}" data-subagent-index="${index}" data-agent-key="${escapeHtml(pathKey(path))}" data-depth="${depth}" style="--tree-depth:${depth}">
      <td><div class="subagent-name">${canExpand ? `<button type="button" class="tree-toggle" data-action="expand-subagent" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(subagent.name)} 的下级代理" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button>` : (depth > 1 ? '<span class="tree-leaf" aria-hidden="true">↳</span>' : '<span class="tree-leaf" aria-hidden="true">◆</span>')}<div><strong title="${escapeHtml(path.join(' / '))}">${escapeHtml(subagent.name)}</strong><small>${readsDescendants ? `第${depth}级代理${depth > 1 ? ` · 上级 ${escapeHtml(path.at(-2))}` : ''}${Number.isFinite(subagent.childCount) ? ` · 下级 ${subagent.childCount} 个` : ''}` : `${agentLabel} · 提醒只按总代理结果`}</small><small class="read-time" title="${escapeHtml(readAtFull)}">最后成功读取：${escapeHtml(readAt)}</small>${dataAge(subagent)}${subagent.stale ? `<small class="child-error">${staleLabel(subagent)}</small>` : ''}${subagent.childError ? `<small class="child-error">下级读取失败：${escapeHtml(subagent.childError)}</small>` : ''}</div></div></td>
      <td class="subagent-value ${subagent.value < 0 ? 'negative' : subagent.value > 0 ? 'positive' : 'zero'}">${subagent.value > 0 ? '+' : ''}${money.format(subagent.value)}${trendChart(account.trend, path)}</td>
      ${hasTurnover ? `<td class="subagent-turnover">${Number.isFinite(subagent.turnover) ? money.format(subagent.turnover) : '—'}</td>` : ''}
      <td class="notified-tiers" title="正向：${escapeHtml(positiveRange)}；负向：${escapeHtml(negativeRange)}${escapeHtml(lastAlert)}"><span class="tier-positive">🔵 ${escapeHtml(positiveRange)}</span><span class="tier-negative">🔴 ${escapeHtml(negativeRange)}</span><small title="${escapeHtml(alertReason(subagent))}">${escapeHtml(alertReason(subagent))}</small>${thresholdProgress(subagent)}${recentAlert(subagent)}</td>
      <td><input data-field="remark" type="text" maxlength="100" value="${escapeHtml(remark)}" placeholder="备注同步到 Telegram" aria-label="${escapeHtml(subagent.name)} 的备注" /></td>
      ${reminderSettings(subagent.name, alertStep, deltaAlertStep)}
      <td><button class="secondary ${dirty ? 'has-unsaved' : ''}" data-action="save-subagent">${dirty ? '保存修改' : '保存'}</button><small class="unsaved-hint" ${dirty ? '' : 'hidden'}>未保存</small></td>
    </tr>`;
  };
  const columns = hasTurnover ? 7 : 6;
  const header = `<thead><tr><th scope="col">${readsDescendants ? '代理层级' : agentLabel} / 最后成功读取</th><th scope="col">${metric.valueLabel}</th>${hasTurnover ? `<th scope="col">本周${metric.turnoverLabel}</th>` : ''}<th scope="col">提醒状态</th><th scope="col">备注（同步通知）</th><th scope="col">提醒设置</th><th scope="col">操作</th></tr></thead>`;
  const tableClass = `agent-table${hasTurnover ? ' has-turnover' : ''}`;
  if (!readsDescendants) return `<div class="agent-table-scroll"><table class="${tableClass}">${header}<tbody>${indexed.filter(({ subagent }) => (subagent.path || [subagent.name]).length === 1).map((item) => renderRow(item, 0)).join('')}</tbody></table></div>`;
  const renderBranch = (item) => {
    const path = item.subagent.path || [item.subagent.name];
    const children = childrenOf(path);
    const expanded = isExpanded(path);
    const canExpand = path.length < MAX_AGENT_DEPTH && (children.length || Number(item.subagent.childCount) > 0 || Boolean(item.subagent.childError));
    const row = renderRow(item, expanded, children.length);
    if (!canExpand || !expanded) return row;
    if (!children.length) return `${row}<tr class="child-placeholder"><td colspan="${columns}">${item.subagent.childError ? '下级读取失败，请刷新重试' : '暂无下级代理'}</td></tr>`;
    return `${row}${children.map(renderBranch).join('')}`;
  };
  const roots = indexed.filter(({ subagent }) => (subagent.path || [subagent.name]).length === 1);
  return `<div class="agent-table-scroll"><table class="${tableClass}">${header}<tbody>${roots.map(renderBranch).join('')}</tbody></table></div>`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

async function action(task, success) {
  try { await task(); if (success) toast(success); }
  catch (error) { toast(error.message || String(error)); }
}

function captureThresholdDraft() {
  const active = document.activeElement;
  if (!active?.matches('.subagent-row input[data-field]')) return null;
  const accountRow = active.closest('.account-row');
  const subagentRow = active.closest('.subagent-row');
  const account = appState.accounts.find((item) => item.id === accountRow?.dataset.id);
  const subagent = account?.subagents?.[Number(subagentRow?.dataset.subagentIndex)];
  if (!account || !subagent) return null;
  const draft = {
    accountId: account.id,
    path: subagent.path || [subagent.name],
    focusedField: active.dataset.field,
    alertStep: subagentRow.querySelector('[data-field="alertStep"]').value,
    deltaAlertStep: subagentRow.querySelector('[data-field="deltaAlertStep"]').value,
    remark: subagentRow.querySelector('[data-field="remark"]').value,
  };
  const key = thresholdDraftKey(account.id, draft.path);
  if (!hasUnsavedThresholdChange(subagent, draft)) {
    thresholdDrafts.delete(key);
    return null;
  }
  thresholdDrafts.set(key, draft);
  return draft;
}

function updateUnsavedThresholdState(subagentRow, subagent, draft) {
  const dirty = hasUnsavedThresholdChange(subagent, draft);
  subagentRow.classList.toggle('has-unsaved', dirty);
  const button = subagentRow.querySelector('[data-action="save-subagent"]');
  if (button) {
    button.classList.toggle('has-unsaved', dirty);
    button.textContent = dirty ? '保存修改' : '保存';
  }
  const hint = subagentRow.querySelector('.unsaved-hint');
  if (hint) hint.hidden = !dirty;
  return dirty;
}

function restoreThresholdDraft(draft, state) {
  if (!draft) return;
  const account = state.accounts?.find((item) => item.id === draft.accountId);
  const index = account?.subagents?.findIndex((item) => pathKey(item.path || [item.name]) === pathKey(draft.path));
  if (index < 0) return;
  const accountRow = [...document.querySelectorAll('.account-row')].find((row) => row.dataset.id === draft.accountId);
  const subagentRow = accountRow?.querySelector(`[data-subagent-index="${index}"]`);
  if (!subagentRow) return;
  subagentRow.querySelector('[data-field="alertStep"]').value = draft.alertStep;
  subagentRow.querySelector('[data-field="deltaAlertStep"]').value = draft.deltaAlertStep || '';
  subagentRow.querySelector('[data-field="remark"]').value = draft.remark;
  subagentRow.querySelector(`[data-field="${draft.focusedField}"]`)?.focus();
}

function render(state) {
  const thresholdDraft = captureThresholdDraft();
  appState = state;
  const theme = ['ocean', 'graphite', 'light', 'contrast'].includes(state.appearance?.theme) ? state.appearance.theme : 'ocean';
  document.documentElement.dataset.theme = theme;
  $('#theme-select').value = theme;
  const accounts = state.accounts || [];
  $('#total-count').textContent = accounts.length;
  $('#ok-count').textContent = accounts.filter((a) => a.enabled !== false && ['ok', 'triggered'].includes(a.status)).length;
  $('#alert-count').textContent = accounts.reduce((count, account) => count + (account.subagents || []).filter(isSubagentTriggered).length, 0);
  $('#error-count').textContent = accounts.filter((a) => ['error', 'partial', 'stale', 'manual'].includes(a.status)).length;
  $('#empty').classList.toggle('show', accounts.length === 0);
  const accountMarkup = accounts.map((account) => {
    const metric = monitorMetric(account);
    const agentLabel = metric.agentLabel || '直属代理';
    const alertAgentLabel = metric.readsDescendants !== false ? '下级代理' : agentLabel;
    const configuredAgents = (account.subagents || []).filter((subagent) => subagent.customized && Number.isFinite(subagent.alertStep) && subagent.alertStep > 0);
    const configuredCount = configuredAgents.length || (account.subagentThresholds || []).filter((subagent) => Number.isFinite(subagent.alertStep) && subagent.alertStep > 0).length;
    const reachedCount = configuredAgents.filter(isSubagentTriggered).length;
    const thresholdState = !configuredCount ? '未设置提醒' : !account.subagents?.length ? '等待首次读取' : reachedCount ? `已达阈值：${reachedCount} 个${alertAgentLabel}` : '未达阈值';
    const period = account.reportPeriod;
    const periodText = period?.start && period?.end ? `${period.start}—${period.end}` : '待读取';
    const periodLabel = !period?.start ? '报表日期' : ['ok', 'triggered'].includes(account.status) ? '已核对本周日期' : '上次报表日期';
    return `<article class="account-row" data-id="${account.id}">
      <div class="account-main"><div class="account-avatar">${escapeHtml(account.name.slice(0,1))}</div><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.username)} · ${escapeHtml(systemLabel(account))}${account.routeSpeed ? ` · 最快线路 ${account.routeSpeed}ms` : ''} · ${metric.usesSubagents ? `${agentLabel} ${Number.isFinite(account.subagentCount) ? account.subagentCount : '待读取'} 个` : metric.label}</small></div></div>
      <div class="metric"><small>${metric.usesSubagents ? `${agentLabel}数量` : '监控口径'}</small><strong>${metric.usesSubagents ? (Number.isFinite(account.subagentCount) ? account.subagentCount : '—') : escapeHtml(metric.label)}</strong></div>
      <div class="threshold"><small>已设置提醒</small><strong>${metric.usesSubagents ? `${configuredCount} 个${alertAgentLabel}` : (configuredCount ? '已设置' : '未设置')}</strong><small class="threshold-state ${reachedCount ? '' : 'clear'}">${escapeHtml(thresholdState)}</small></div>
      <div class="status-wrap"><span class="status ${!account.enabled ? 'paused' : (account.status || 'waiting')}">${!account.enabled ? statusNames.paused : (statusNames[account.status] || statusNames.waiting)}</span><small class="health-detail">最近成功：${account.lastSuccessAt ? escapeHtml(new Date(account.lastSuccessAt).toLocaleTimeString('zh-CN', { hour12: false })) : '尚未成功'}</small><button class="secondary reading-detail-button" data-action="reading-details">查看详情</button></div>
      <div class="actions"><button data-action="view" title="打开盘口；图形验证或验证码时可手动登录">盘内查看</button><button data-action="check" title="立即检查">刷新</button><button data-action="toggle">${account.enabled ? '暂停' : '启用'}</button><button data-action="edit">编辑</button><button data-action="remove">删除</button></div>
      <div class="subagents"><div class="subagents-head"><strong>${metric.sectionLabel}</strong><small>${periodLabel}：${escapeHtml(periodText)} · 提醒从 0 起，跨入新档或从高档返回低档都会提醒；${metric.readsDescendants !== false ? '自动识别最多四级下级代理；点击任一有下级的代理可展开或收起。' : metric.usesSubagents ? `${agentLabel}的提醒只按“${metric.valueLabel}”计算。` : `仅读取“${metric.label}”总额。`}</small></div>${agentToolbar(account)}${subagentList(account)}</div>
    </article>`;
  }).join('');
  if (accountMarkup !== previousAccountMarkup) {
    const nextAccounts = document.createElement('template');
    nextAccounts.innerHTML = accountMarkup;
    patchChildren($('#accounts'), nextAccounts.content);
    previousAccountMarkup = accountMarkup;
  }
  refreshReadingDetails();
  renderQueue();
  $('#startup-check').textContent = state.startupCheck?.message || '等待启动自检';
  $('#startup-check').className = ['error', 'warning'].includes(state.startupCheck?.status) ? 'child-error' : '';
  $('#persistence-error').textContent = state.persistenceError || '';
  $('#persistence-error').hidden = !state.persistenceError;
  $('#startup-warning').hidden = !state.persistenceError && !['error', 'warning'].includes(state.startupCheck?.status);
  $('#startup-warning-text').textContent = state.persistenceError || state.startupCheck?.message || '';
  $('#resume-after-recovery').hidden = !state.startupCheck?.reviewRequired;
  restoreThresholdDraft(thresholdDraft, state);
  $('#events').innerHTML = (state.events || []).map((event) => `<div class="event ${event.type}"><i></i><time>${new Date(event.time).toLocaleString('zh-CN')}</time><span>${escapeHtml(event.message)}</span></div>`).join('') || '<div class="empty show"><p>暂无运行记录</p></div>';
  $('#notification-queue').textContent = `待发送 ${state.notificationQueue?.pending || 0} 条 · 失败待重试 ${state.notificationQueue?.failed || 0} 条 · 收件人变更暂存 ${state.notificationQueue?.held || 0} 条（暂存消息不会发送给新收件人）`;
  $('#alert-records').innerHTML = (state.alertRecords || []).map((record) => {
    const value = Number(record.value);
    const tier = Number(record.level) * Number(record.alertStep);
    const agent = record.agentPath?.join(' / ') || record.agentName || '—';
    const trigger = record.trigger;
    const explanation = trigger ? [trigger.reason,
      `档位 ${trigger.previousLevel * record.alertStep} → ${trigger.level * record.alertStep}`,
      `上次档位转换金额 ${trigger.previousTransitionValue ?? '无记录'} → 本次金额 ${trigger.value}`,
      `连续确认 ${trigger.confirmationReads} 次`,
      `进程启动 ${trigger.processStartedAt}`,
      `与上次转换相比进程变化：${trigger.processChangedSincePrevious === null ? '无记录' : trigger.processChangedSincePrevious ? '是' : '否'}`,
      trigger.settingChange ? `最近修改间隔：${trigger.settingChange.previousStep ?? '关闭'} → ${trigger.settingChange.nextStep ?? '关闭'}（${trigger.settingChange.time}）` : '无间隔修改记录',
      `通知编号：${record.eventId || '无记录'}`,
    ].join('\n') : '旧记录无触发详情';
    const result = record.status === 'sent' ? 'Telegram 已发送' : `发送失败：${record.error || '未知错误'}`;
    const detail = record.alertType === 'delta' ? `变化 ${record.change > 0 ? '+' : ''}${compactMoney.format(Math.abs(record.change || 0))} / 阈值 ${compactMoney.format(record.alertStep)}` : (Number.isFinite(tier) ? `${tier > 0 ? '+' : '−'}${compactMoney.format(Math.abs(tier))} 档` : '—');
    return `<article class="alert-record"><time>${new Date(record.time).toLocaleString('zh-CN')}</time><strong class="${record.status === 'sent' ? 'sent' : 'failed'}">${record.status === 'sent' ? '已发送' : '发送失败'}</strong><div><strong>${escapeHtml(record.accountName || '未知账号')}</strong><small title="${escapeHtml(agent)}">${escapeHtml(agent)}${record.remark ? ` · ${escapeHtml(record.remark)}` : ''}</small></div><strong class="${value < 0 ? 'negative' : value > 0 ? 'positive' : ''}">${Number.isFinite(value) ? `${value > 0 ? '+' : ''}${money.format(value)}` : '—'}</strong><span>${escapeHtml(detail)}</span><small class="${record.status === 'sent' ? 'sent' : 'failed'}">${escapeHtml(result)}</small><details class="alert-trigger"><summary>触发详情</summary><pre>${escapeHtml(explanation)}</pre></details></article>`;
  }).join('') || '<div class="empty show"><p>暂无金额提醒记录</p></div>';
  $('#telegram-form').elements.chatId.value = state.telegram?.chatId || '';
  const pairing = state.telegram?.pairing;
  const pairingExpired = pairing?.expiresAt && Date.now() >= pairing.expiresAt;
  $('#pair-status').textContent = !state.telegram?.pairingAvailable
    ? '配对服务正在准备中，可继续使用下方高级设置'
    : pairing?.paired ? '✅ 已绑定 Telegram 通知目的地'
      : pairing && !pairingExpired ? '等待在 Telegram 私聊发送配对码，或由群管理员发送 /pair 配对码…'
        : pairingExpired ? '配对码已过期，请重新生成' : '尚未绑定';
  $('#pair-code').textContent = pairing?.paired ? '已配对' : pairing && !pairingExpired ? pairing.code : '—';
  $('#pair-expiry').textContent = pairing && !pairing.paired && !pairingExpired
    ? `配对码有效至 ${new Date(pairing.expiresAt).toLocaleTimeString('zh-CN')}，只可使用一次；群聊请由群管理员发送 /pair 配对码。`
    : '';
  $('#pair-start').disabled = !state.telegram?.pairingAvailable || pairing?.paired;
  $('#pair-open-bot').hidden = !pairing?.code || pairing?.paired || pairingExpired;
  $('#pair-check').hidden = !pairing?.code || pairing?.paired || pairingExpired;
  $('#pair-unlink').hidden = !pairing?.paired;
  $('#test-telegram').hidden = state.telegram?.mode !== 'pairing' && !(state.telegram?.mode === 'legacy' && state.telegram?.hasBotToken && state.telegram?.chatId);
  const updater = state.updater || {};
  $('#header-version').textContent = updater.currentVersion ? `v${updater.currentVersion}` : '版本未知';
  $('#current-version').textContent = updater.currentVersion ? `v${updater.currentVersion}` : '—';
  $('#update-message').textContent = updater.message || '等待检查';
  $('#update-time').textContent = updater.lastCheckedAt ? `上次检查：${new Date(updater.lastCheckedAt).toLocaleString('zh-CN')}` : '尚未检查';
  $('.update-status').className = `update-status ${updater.status || 'idle'}`;
  $('#update-progress').classList.toggle('show', updater.status === 'downloading');
  $('#update-progress i').style.width = `${updater.progress || 0}%`;
  $('#install-update').hidden = updater.status !== 'ready';
  $('#update-form').elements.feedUrl.value = state.update?.feedUrl || '';
  $('#update-form').elements.autoCheck.checked = state.update?.autoCheck !== false;
  const policy = state.alertPolicy || {};
  $('#alert-policy-form').elements.confirmationReads.value = policy.confirmationReads || 1;
  $('#alert-policy-form').elements.failureEscalation.value = policy.failureEscalation || 3;
  $('#alert-policy-form').elements.quietStart.value = policy.quietStart || '';
  $('#alert-policy-form').elements.quietEnd.value = policy.quietEnd || '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}

function updateSystemFields(form = $('#account-form')) {
  const systemType = form.elements.systemType.value;
  $$('[data-system-field]').forEach((field) => { field.hidden = field.dataset.systemField !== systemType; });
  const securityField = $('#security-code-field');
  const securityLabel = securityField.querySelector('.security-code-label');
  const securitySlot = systemType === 'crown' ? $('#security-code-login-slot') : $('#security-code-site-slot');
  if (securityField.parentElement !== securitySlot) securitySlot.append(securityField);
  securityLabel.textContent = systemType === 'crown'
    ? '皇冠登录安全码（登录界面必填；编辑时明文显示）'
    : '166 线路安全码（必填；编辑时明文显示）';
  $('#route-preview').hidden = systemType === 'crown';
}

let accountDialogGeneration = 0;
async function openAccount(account) {
  const generation = ++accountDialogGeneration;
  const form = $('#account-form');
  form.reset();
  form.elements.systemType.value = account?.systemType || 'system-166';
  form.elements.navUrl.value = 'https://166.tt';
  form.elements.crownDomain.value = account?.crownDomain || 'https://ag.hga050.com';
  form.elements.crownLoginEntry.value = account?.crownLoginEntry || 'login-1';
  form.elements.intervalMinutes.value = account?.intervalMinutes || 5;
  form.elements.enabled.checked = account?.enabled !== false;
  for (const key of ['id','name','username']) form.elements[key].value = account?.[key] ?? '';
  $('#route-preview').innerHTML = routePreview(account);
  $('#dialog-title').textContent = account ? '编辑监控账号' : '添加监控账号';
  $('#view-account').hidden = !account;
  updateSystemFields(form);
  if (account) {
    try {
      const details = await window.monitorApi.getAccountSecurityCode(account.id);
      if (generation !== accountDialogGeneration) return;
      form.elements.securityCode.value = details.securityCode || '';
    } catch (error) {
      toast(`读取安全码失败：${error.message || error}`);
      return;
    }
  }
  if (generation !== accountDialogGeneration) return;
  $('#account-dialog').showModal();
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${button.dataset.view}-view`));
  $('#page-title').textContent = button.textContent.trim();
  $('#add-account').style.display = button.dataset.view === 'dashboard' ? '' : 'none';
}));

$('#theme-select').addEventListener('change', (event) => {
  const theme = event.target.value;
  document.documentElement.dataset.theme = theme;
  action(() => window.monitorApi.saveTheme(theme), '主题已保存');
});

$('#add-account').addEventListener('click', () => openAccount());
$$('.add-trigger').forEach((button) => button.addEventListener('click', () => openAccount()));
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => { accountDialogGeneration += 1; $('#account-dialog').close(); }));

$('#account-form').elements.systemType.addEventListener('change', (event) => updateSystemFields(event.currentTarget.form));

$('#account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const account = Object.fromEntries(form.entries());
  account.enabled = event.currentTarget.elements.enabled.checked;
  action(async () => {
    const result = await window.monitorApi.saveAccount(account);
    $('#account-dialog').close();
    if (account.enabled) await window.monitorApi.checkAccount(result.id);
  }, account.systemType === 'crown' ? '皇冠账号已保存，正在测试登录' : '账号已保存，正在识别线路并测试登录');
});

$('#accounts').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const row = event.target.closest('[data-id]');
  if (!button || !row) return;
  const account = appState.accounts.find((item) => item.id === row.dataset.id);
  if (button.dataset.action === 'save-subagent') {
    const subagentRow = button.closest('[data-subagent-index]');
    const subagent = account.subagents[Number(subagentRow.dataset.subagentIndex)];
    const settings = {
      accountId: account.id,
      path: subagent.path || [subagent.name],
      remark: subagentRow.querySelector('[data-field="remark"]').value,
      alertStep: subagentRow.querySelector('[data-field="alertStep"]').value,
      deltaAlertStep: subagentRow.querySelector('[data-field="deltaAlertStep"]').value,
    };
    action(async () => {
      await window.monitorApi.saveSubagentThreshold(settings);
      thresholdDrafts.delete(thresholdDraftKey(account.id, settings.path));
      updateUnsavedThresholdState(subagentRow, subagent, settings);
    }, `${subagent.name} 的备注和提醒已保存`);
    return;
  }
  if (button.dataset.action === 'expand-subagent') {
    const subagentRow = button.closest('[data-subagent-index]');
    const subagent = account.subagents[Number(subagentRow.dataset.subagentIndex)];
    const path = subagent.path || [subagent.name];
    const branchKey = thresholdDraftKey(account.id, path);
    if (reminderOnlyAccounts.has(account.id)) {
      if (filteredCollapsedPaths.has(branchKey)) filteredCollapsedPaths.delete(branchKey);
      else filteredCollapsedPaths.add(branchKey);
      render(appState);
      return;
    }
    if ((account.expandedAgentPaths || []).some((item) => pathKey(item) === pathKey(path))) {
      if (collapsedAgentPaths.has(branchKey)) collapsedAgentPaths.delete(branchKey);
      else collapsedAgentPaths.add(branchKey);
      render(appState);
    } else {
      action(() => window.monitorApi.expandSubagent(account.id, path));
    }
    return;
  }
  if (button.dataset.action === 'edit') openAccount(account);
  if (button.dataset.action === 'reading-details') {
    readingDetailsAccountId = account.id;
    $('#reading-dialog').showModal();
    refreshReadingDetails();
  }
  if (button.dataset.action === 'filter-reminders') {
    if (reminderOnlyAccounts.has(account.id)) reminderOnlyAccounts.delete(account.id);
    else reminderOnlyAccounts.add(account.id);
    render(appState);
  }
  if (button.dataset.action === 'collapse-agents') {
    for (const agent of account.subagents || []) {
      const key = thresholdDraftKey(account.id, agent.path || [agent.name]);
      collapsedAgentPaths.add(key);
      filteredCollapsedPaths.add(key);
    }
    render(appState);
  }
  if (button.dataset.action === 'full-scan') action(() => window.monitorApi.fullScanAccount(account.id), '已安排全量扫描');
  if (button.dataset.action === 'view') action(() => window.monitorApi.openAccountView(account.id), '正在打开盘内查看');
  if (button.dataset.action === 'check') action(() => window.monitorApi.checkAccount(account.id), '已开始检查');
  if (button.dataset.action === 'toggle') action(() => window.monitorApi.toggleAccount(account.id, !account.enabled));
  if (button.dataset.action === 'remove' && confirm(`确定删除“${account.name}”吗？`)) action(() => window.monitorApi.removeAccount(account.id), '账号已删除');
});

$('#view-account').addEventListener('click', () => {
  const id = $('#account-form').elements.id.value;
  if (!id) return;
  $('#account-dialog').close();
  action(() => window.monitorApi.openAccountView(id), '正在打开盘内查看');
});
$('#close-reading-details').addEventListener('click', () => $('#reading-dialog').close());

$('#accounts').addEventListener('input', (event) => {
  if (!event.target.matches('.subagent-row input[data-field]')) return;
  const accountRow = event.target.closest('.account-row');
  const subagentRow = event.target.closest('.subagent-row');
  const account = appState.accounts.find((item) => item.id === accountRow?.dataset.id);
  const subagent = account?.subagents?.[Number(subagentRow?.dataset.subagentIndex)];
  if (!account || !subagent) return;
  const draft = {
    alertStep: subagentRow.querySelector('[data-field="alertStep"]').value,
    deltaAlertStep: subagentRow.querySelector('[data-field="deltaAlertStep"]').value,
    remark: subagentRow.querySelector('[data-field="remark"]').value,
  };
  const key = thresholdDraftKey(account.id, subagent.path || [subagent.name]);
  if (updateUnsavedThresholdState(subagentRow, subagent, draft)) thresholdDrafts.set(key, draft);
  else thresholdDrafts.delete(key);
});

$('#telegram-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  action(() => window.monitorApi.saveTelegram(values), 'Telegram 设置已保存');
});
$('#pair-start').addEventListener('click', () => action(() => window.monitorApi.startTelegramPairing(), '配对码已生成：私聊直接发送；群聊由管理员发送 /pair 配对码'));
$('#pair-open-bot').addEventListener('click', () => action(() => window.monitorApi.openTelegramPairingBot()));
$('#pair-check').addEventListener('click', () => action(async () => {
  const result = await window.monitorApi.checkTelegramPairing();
  toast(result.paired ? 'Telegram 已绑定' : '还未收到配对码：私聊直接发送，或由群管理员发送 /pair 配对码');
}));
$('#pair-unlink').addEventListener('click', () => {
  if (confirm('确定解除这台电脑的 Telegram 通知绑定吗？')) {
    action(() => window.monitorApi.unlinkTelegramPairing(), 'Telegram 已解除绑定');
  }
});
$('#test-telegram').addEventListener('click', () => {
  const values = Object.fromEntries(new FormData($('#telegram-form')).entries());
  action(() => window.monitorApi.testTelegram(values), '测试消息已发送');
});
setInterval(() => {
  const pairing = appState.telegram?.pairing;
  if (document.querySelector('#telegram-view.active') && pairing && !pairing.paired && Date.now() < pairing.expiresAt) {
    window.monitorApi.checkTelegramPairing().catch(() => {});
  }
}, 5000);
$('#discover-chat').addEventListener('click', () => action(async () => {
  const form = $('#telegram-form');
  const result = await window.monitorApi.discoverTelegramChatId(form.elements.botToken.value);
  form.elements.chatId.value = result.chatId;
}, '已自动填写 Chat ID'));
$('#update-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  values.autoCheck = event.currentTarget.elements.autoCheck.checked;
  action(() => window.monitorApi.saveUpdateSettings(values), '更新设置已保存');
});
$('#check-update').addEventListener('click', () => action(() => window.monitorApi.checkForUpdates()));
$('#install-update').addEventListener('click', () => action(() => window.monitorApi.installUpdate()));
$('#open-latest-download').addEventListener('click', () => action(() => window.monitorApi.openLatestDownloadPage(), '已打开最新版下载页'));
$('#copy-latest-download').addEventListener('click', () => action(async () => {
  const result = await window.monitorApi.copyLatestDownloadUrl();
  return result;
}, '下载网址已复制'));
$('#alert-policy-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(() => window.monitorApi.saveAlertPolicy(Object.fromEntries(new FormData(event.currentTarget).entries())), '提醒策略已保存');
});
$('#export-diagnostics').addEventListener('click', () => action(async () => {
  const result = await window.monitorApi.exportDiagnostics();
  if (!result.canceled) toast('脱敏诊断包已导出');
}));
$('#export-backup').addEventListener('click', () => action(async () => {
  const result = await window.monitorApi.exportBackup();
  if (!result.canceled) toast('加密配置备份已导出');
}));
$('#import-backup').addEventListener('click', () => {
  if (confirm('恢复会覆盖当前配置，并保留一份恢复前备份。确定继续吗？')) action(async () => {
    const result = await window.monitorApi.importBackup();
    if (!result.canceled) toast('配置已恢复，请重新检查账号');
  });
});

$('#open-notification-queue').addEventListener('click', () => { queuePage = 0; $('#notification-dialog').showModal(); renderQueue(); });
$('#resume-after-recovery').addEventListener('click', () => {
  if (confirm('已核对备份中的账号、提醒档位和待发消息？恢复后会继续读取与发送。')) action(() => window.monitorApi.resumeAfterRecovery(), '已恢复监控调度');
});
$('#close-notification-queue').addEventListener('click', () => $('#notification-dialog').close());
$('#queue-prev').addEventListener('click', () => { queuePage--; renderQueue(); });
$('#queue-next').addEventListener('click', () => { queuePage++; renderQueue(); });
$('#notification-items').addEventListener('click', event => {
  const button = event.target.closest('[data-queue-action]'); if (!button) return;
  const operation = button.dataset.queueAction;
  if (operation === 'cancel' && !confirm('确定取消这条待发通知？不会撤回已发送消息，也不会清空档位记录。')) return;
  action(() => window.monitorApi.manageNotification(button.dataset.queueId, operation), operation === 'cancel' ? '通知已取消' : '已安排重试（静默时间仍有效）');
});

window.monitorApi.onState(render);
window.monitorApi.getState().then(render).catch((error) => toast(error.message));
