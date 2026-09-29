let appState = { accounts: [], events: [], telegram: {} };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const statusNames = { waiting: '等待首次检查', checking: '正在检查', ok: '运行正常', triggered: '运行正常', error: '检查失败', paused: '已暂停' };
const thresholdDrafts = new Map();
const collapsedAgentPaths = new Set();
const selectedAgentPaths = new Map();

const monitorMetrics = {
  'receivable-downline': { label: '应收下线', sectionLabel: '两级代理应收下线', valueLabel: '本周应收下线', usesSubagents: true },
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
  if (subagent.stale) return '本次未成功读取，暂停该行提醒';
  if (!Number.isFinite(subagent.alertStep) || subagent.alertStep <= 0) return '未设置提醒间隔';
  if (subagent.alertError) return `通知失败：${subagent.alertError}`;
  const level = Math.trunc(subagent.value / subagent.alertStep);
  if (!level) return '尚未达到首档';
  return level === subagent.lastObservedLevel ? '当前档位已通知' : '新档位待通知';
}

function thresholdProgress(subagent) {
  if (subagent.stale || !Number.isFinite(subagent.alertStep) || subagent.alertStep <= 0 || !Number.isFinite(subagent.value)) return '';
  const step = subagent.alertStep;
  if (subagent.value >= 0) {
    const next = (Math.trunc(subagent.value / step) + 1) * step;
    return `<small class="threshold-progress positive">下一档 +${compactMoney.format(next)} · 差 ${compactMoney.format(next - subagent.value)}</small>`;
  }
  const next = (Math.trunc(subagent.value / step) - 1) * step;
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

function batchEditor(account) {
  const selected = selectedAgentPaths.get(account.id) || new Set();
  return `<details class="batch-editor" ${selected.size ? 'open' : ''}><summary><strong>批量设置</strong><small>已选 ${selected.size} 个代理</small></summary><form data-batch-account="${escapeHtml(account.id)}"><p>留空表示不修改；清除操作只作用于已勾选代理。</p><input name="alertStep" type="number" min="0.01" step="0.01" placeholder="金额档位；留空不改" /><input name="deltaAlertStep" type="number" min="0.01" step="0.01" placeholder="变化阈值；留空不改" /><label class="batch-remark"><input name="updateRemark" type="checkbox" /> 同步备注</label><input name="remark" maxlength="100" placeholder="备注（可留空清除）" /><label><input name="clearAlertStep" type="checkbox" /> 关闭金额提醒</label><label><input name="clearDeltaAlertStep" type="checkbox" /> 关闭变动提醒</label><button class="secondary" type="submit" ${selected.size ? '' : 'disabled'}>应用到已选代理</button></form></details>`;
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
    <td><div class="subagent-name"><input class="batch-select" data-path="${escapeHtml(pathKey(path))}" type="checkbox" ${selectedAgentPaths.get(account.id)?.has(pathKey(path)) ? 'checked' : ''} /><span class="tree-leaf" aria-hidden="true">◆</span><div><strong>${escapeHtml(metric.label)}</strong><small>本周交收总额</small><small class="read-time" title="${escapeHtml(readAtFull)}">最后成功读取：${escapeHtml(readAt)}</small>${target.stale ? '<small class="child-error">数据已过期</small>' : ''}</div></div></td>
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
    return '<div class="subagent-empty">登录并完成首次检查后，这里会显示下级代理。</div>';
  }
  if (!account.subagents?.length) return '<div class="subagent-empty">本级账号下暂未发现代理。</div>';
  const indexed = account.subagents.map((subagent, index) => ({ subagent, index }));
  const renderRow = ({ subagent, index }, depth, expanded = false) => {
    const path = subagent.path || [subagent.name];
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
    return `<tr class="subagent-row ${depth ? 'second-level' : 'first-level'} ${subagent.stale ? 'stale' : ''} ${dirty ? 'has-unsaved' : ''}" data-subagent-index="${index}">
      <td><div class="subagent-name"><input class="batch-select" data-path="${escapeHtml(pathKey(path))}" type="checkbox" ${selectedAgentPaths.get(account.id)?.has(pathKey(path)) ? 'checked' : ''} />${depth === 0 && readsDescendants ? `<button type="button" class="tree-toggle" data-action="expand-subagent" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(subagent.name)} 的下级代理" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button>` : (depth ? '<span class="tree-leaf" aria-hidden="true">↳</span>' : '<span class="tree-leaf" aria-hidden="true">◆</span>')}<div><strong title="${escapeHtml(path.join(' / '))}">${escapeHtml(subagent.name)}</strong><small>${depth ? `二级代理 · 上级 ${escapeHtml(path[0])}` : readsDescendants ? `${agentLabel}${Number.isFinite(subagent.childCount) ? ` · 下级 ${subagent.childCount} 个` : ''}` : `${agentLabel} · 提醒只按总代理结果`}</small><small class="read-time" title="${escapeHtml(readAtFull)}">最后成功读取：${escapeHtml(readAt)}</small>${subagent.stale ? '<small class="child-error">数据已过期</small>' : ''}${subagent.childError ? `<small class="child-error">下级读取失败：${escapeHtml(subagent.childError)}</small>` : ''}</div></div></td>
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
  const branches = indexed.filter(({ subagent }) => (subagent.path || [subagent.name]).length === 1).map((parent) => {
    const parentPath = parent.subagent.path || [parent.subagent.name];
    const expanded = (account.expandedAgentPaths || []).some((item) => pathKey(item) === pathKey(parentPath))
      && !collapsedAgentPaths.has(thresholdDraftKey(account.id, parentPath));
    const children = indexed.filter(({ subagent }) => {
      const path = subagent.path || [subagent.name];
      return path.length === 2 && path[0] === parentPath[0];
    });
    const childContent = children.length ? children.map((child) => renderRow(child, 1)).join('')
      : `<tr class="child-placeholder"><td colspan="${columns}">${parent.subagent.childError ? '下级读取失败，请刷新重试' : Number.isFinite(parent.subagent.childCount) ? '暂无下级代理' : '正在读取下级代理…'}</td></tr>`;
    return `<tbody class="agent-branch">${renderRow(parent, 0, expanded)}</tbody><tbody class="child-group" ${expanded ? '' : 'hidden'}>${childContent}</tbody>`;
  }).join('');
  return `<div class="agent-table-scroll"><table class="${tableClass}">${header}${branches}</table></div>`;
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
  $('#error-count').textContent = accounts.filter((a) => a.status === 'error').length;
  $('#empty').classList.toggle('show', accounts.length === 0);
  $('#accounts').innerHTML = accounts.map((account) => {
    const metric = monitorMetric(account);
    const agentLabel = metric.agentLabel || '直属代理';
    const checked = account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查';
    const statusDetail = account.error || (account.status === 'checking' ? account.stage : '') || checked;
    const nextCheck = account.nextCheckAt ? new Date(account.nextCheckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '待安排';
    const health = account.consecutiveFailures ? `连续失败 ${account.consecutiveFailures} 次` : account.lastSuccessAt ? `最近成功 ${new Date(account.lastSuccessAt).toLocaleString('zh-CN')}` : '等待首次成功读取';
    const configuredAgents = (account.subagents || []).filter((subagent) => subagent.customized && Number.isFinite(subagent.alertStep) && subagent.alertStep > 0);
    const configuredCount = configuredAgents.length || (account.subagentThresholds || []).filter((subagent) => Number.isFinite(subagent.alertStep) && subagent.alertStep > 0).length;
    const reachedCount = configuredAgents.filter(isSubagentTriggered).length;
    const thresholdState = !configuredCount ? '未设置提醒' : !account.subagents?.length ? '等待首次读取' : reachedCount ? `已达阈值：${reachedCount} 个${agentLabel}` : '未达阈值';
    const period = account.reportPeriod;
    const periodText = period?.start && period?.end ? `${period.start}—${period.end}` : '待读取';
    const periodLabel = !period?.start ? '报表日期' : ['ok', 'triggered'].includes(account.status) ? '已核对本周日期' : '上次报表日期';
    return `<article class="account-row" data-id="${account.id}">
      <div class="account-main"><div class="account-avatar">${escapeHtml(account.name.slice(0,1))}</div><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.username)} · ${escapeHtml(systemLabel(account))}${account.routeSpeed ? ` · 最快线路 ${account.routeSpeed}ms` : ''} · ${metric.usesSubagents ? `${agentLabel} ${Number.isFinite(account.subagentCount) ? account.subagentCount : '待读取'} 个` : metric.label}</small></div></div>
      <div class="metric"><small>${metric.usesSubagents ? `${agentLabel}数量` : '监控口径'}</small><strong>${metric.usesSubagents ? (Number.isFinite(account.subagentCount) ? account.subagentCount : '—') : escapeHtml(metric.label)}</strong></div>
      <div class="threshold"><small>已设置提醒</small><strong>${metric.usesSubagents ? `${configuredCount} 个${agentLabel}` : (configuredCount ? '已设置' : '未设置')}</strong><small class="threshold-state ${reachedCount ? '' : 'clear'}">${escapeHtml(thresholdState)}</small></div>
      <div class="status-wrap"><span class="status ${!account.enabled ? 'paused' : (account.status || 'waiting')}">${!account.enabled ? statusNames.paused : (statusNames[account.status] || statusNames.waiting)}</span><small title="${escapeHtml(statusDetail)}">${escapeHtml(statusDetail)}</small><small class="health-detail" title="${escapeHtml(health)}">${escapeHtml(health)} · 下次 ${escapeHtml(nextCheck)}</small></div>
      <div class="actions"><button data-action="view" title="打开盘口；图形验证或验证码时可手动登录">盘内查看</button><button data-action="check" title="立即检查">刷新</button><button data-action="toggle">${account.enabled ? '暂停' : '启用'}</button><button data-action="edit">编辑</button><button data-action="remove">删除</button></div>
      <div class="subagents"><div class="subagents-head"><strong>${metric.sectionLabel}</strong><small>${periodLabel}：${escapeHtml(periodText)} · 提醒从 0 起，跨入新档或从高档返回低档都会提醒；${metric.readsDescendants !== false ? '点击直属代理展开下级。' : metric.usesSubagents ? `${agentLabel}的提醒只按“${metric.valueLabel}”计算。` : `仅读取“${metric.label}”总额。`}</small></div>${batchEditor(account)}${subagentList(account)}</div>
    </article>`;
  }).join('');
  restoreThresholdDraft(thresholdDraft, state);
  $('#events').innerHTML = (state.events || []).map((event) => `<div class="event ${event.type}"><i></i><time>${new Date(event.time).toLocaleString('zh-CN')}</time><span>${escapeHtml(event.message)}</span></div>`).join('') || '<div class="empty show"><p>暂无运行记录</p></div>';
  $('#alert-records').innerHTML = (state.alertRecords || []).map((record) => {
    const value = Number(record.value);
    const tier = Number(record.level) * Number(record.alertStep);
    const agent = record.agentPath?.join(' / ') || record.agentName || '—';
    const result = record.status === 'sent' ? 'Telegram 已发送' : `发送失败：${record.error || '未知错误'}`;
    const detail = record.alertType === 'delta' ? `变化 ${record.change > 0 ? '+' : ''}${compactMoney.format(Math.abs(record.change || 0))} / 阈值 ${compactMoney.format(record.alertStep)}` : (Number.isFinite(tier) ? `${tier > 0 ? '+' : '−'}${compactMoney.format(Math.abs(tier))} 档` : '—');
    return `<article class="alert-record"><time>${new Date(record.time).toLocaleString('zh-CN')}</time><strong class="${record.status === 'sent' ? 'sent' : 'failed'}">${record.status === 'sent' ? '已发送' : '发送失败'}</strong><div><strong>${escapeHtml(record.accountName || '未知账号')}</strong><small title="${escapeHtml(agent)}">${escapeHtml(agent)}${record.remark ? ` · ${escapeHtml(record.remark)}` : ''}</small></div><strong class="${value < 0 ? 'negative' : value > 0 ? 'positive' : ''}">${Number.isFinite(value) ? `${value > 0 ? '+' : ''}${money.format(value)}` : '—'}</strong><span>${escapeHtml(detail)}</span><small class="${record.status === 'sent' ? 'sent' : 'failed'}">${escapeHtml(result)}</small></article>`;
  }).join('') || '<div class="empty show"><p>暂无金额提醒记录</p></div>';
  $('#telegram-form').elements.chatId.value = state.telegram?.chatId || '';
  const pairing = state.telegram?.pairing;
  const pairingExpired = pairing?.expiresAt && Date.now() >= pairing.expiresAt;
  $('#pair-status').textContent = !state.telegram?.pairingAvailable
    ? '配对服务正在准备中，可继续使用下方高级设置'
    : pairing?.paired ? '✅ 已绑定 Telegram'
      : pairing && !pairingExpired ? '等待在 Telegram 机器人中发送配对码…'
        : pairingExpired ? '配对码已过期，请重新生成' : '尚未绑定';
  $('#pair-code').textContent = pairing?.paired ? '已配对' : pairing && !pairingExpired ? pairing.code : '—';
  $('#pair-expiry').textContent = pairing && !pairing.paired && !pairingExpired
    ? `配对码有效至 ${new Date(pairing.expiresAt).toLocaleTimeString('zh-CN')}，只可使用一次。`
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

$('#accounts').addEventListener('change', (event) => {
  if (!event.target.matches('.batch-select')) return;
  const accountId = event.target.closest('.account-row')?.dataset.id; if (!accountId) return;
  const selected = selectedAgentPaths.get(accountId) || new Set();
  if (event.target.checked) selected.add(event.target.dataset.path); else selected.delete(event.target.dataset.path);
  selectedAgentPaths.set(accountId, selected); render(appState);
});

$('#accounts').addEventListener('submit', (event) => {
  if (!event.target.matches('.batch-editor form')) return; event.preventDefault();
  const accountId = event.target.dataset.batchAccount; const account = appState.accounts.find((item) => item.id === accountId);
  const paths = [...(selectedAgentPaths.get(accountId) || [])].map((key) => JSON.parse(key));
  const values = Object.fromEntries(new FormData(event.target).entries()); values.accountId = accountId; values.paths = paths;
  values.updateRemark = event.target.elements.updateRemark.checked; values.clearAlertStep = event.target.elements.clearAlertStep.checked; values.clearDeltaAlertStep = event.target.elements.clearDeltaAlertStep.checked;
  action(async () => { const result = await window.monitorApi.saveSubagentThresholdBatch(values); selectedAgentPaths.delete(accountId); return result; }, `已批量更新 ${paths.length} 个代理`);
});

$('#telegram-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  action(() => window.monitorApi.saveTelegram(values), 'Telegram 设置已保存');
});
$('#pair-start').addEventListener('click', () => action(() => window.monitorApi.startTelegramPairing(), '配对码已生成，请发送给机器人'));
$('#pair-open-bot').addEventListener('click', () => action(() => window.monitorApi.openTelegramPairingBot()));
$('#pair-check').addEventListener('click', () => action(async () => {
  const result = await window.monitorApi.checkTelegramPairing();
  toast(result.paired ? 'Telegram 已绑定' : '还未收到配对码，请先在机器人中发送');
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

window.monitorApi.onState(render);
window.monitorApi.getState().then(render).catch((error) => toast(error.message));
