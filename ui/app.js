let appState = { accounts: [], events: [], telegram: {} };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const statusNames = { waiting: '等待首次检查', checking: '正在检查', ok: '运行正常', triggered: '已达阈值', error: '检查失败' };
const thresholdDrafts = new Map();
const collapsedAgentPaths = new Set();

const pathKey = (path) => JSON.stringify(path);
const thresholdDraftKey = (accountId, path) => `${accountId}\u0000${pathKey(path)}`;

function isSubagentTriggered(subagent) {
  return !subagent.stale && Number.isFinite(subagent.alertStep) && subagent.alertStep > 0 && Math.abs(subagent.value) >= subagent.alertStep;
}

function notifiedRange(max, step, direction) {
  if (!Number.isSafeInteger(max) || max <= 0 || !Number.isFinite(step) || step <= 0) return '未提醒';
  const sign = direction > 0 ? '+' : '−';
  const first = `${sign}${compactMoney.format(step)}`;
  return max === 1 ? `${first}（1 档）` : `${first}～${sign}${compactMoney.format(max * step)}（${max} 档）`;
}

function alertReason(subagent) {
  if (subagent.stale) return '本次未成功读取，暂停该行提醒';
  if (!Number.isFinite(subagent.alertStep) || subagent.alertStep <= 0) return '未设置提醒间隔';
  if (subagent.alertError) return `通知失败：${subagent.alertError}`;
  const level = Math.trunc(subagent.value / subagent.alertStep);
  if (!level) return '尚未达到首档';
  const delivered = level > 0 ? subagent.alertedPositiveMax : subagent.alertedNegativeMax;
  return Math.abs(level) <= delivered ? '当前档位本周已通知' : '新档位待通知';
}

function routePreview(account) {
  if (!account?.routes?.length) return '<span>保存后将自动测速并显示代理线路</span>';
  return account.routes.map((route, index) => {
    let host = route.text;
    try { host = new URL(route.text).host; } catch {}
    return `<div class="route-item"><code>${escapeHtml(host)}</code><strong>${route.speed < 99999 ? `${route.speed}ms` : '待测速'}${index === 0 ? ' · 最快' : ''}</strong></div>`;
  }).join('');
}

function subagentList(account) {
  if (!Number.isFinite(account.subagentCount)) {
    return '<div class="subagent-empty">登录并完成首次检查后，这里会显示下级代理。</div>';
  }
  if (!account.subagents?.length) return '<div class="subagent-empty">本级账号下暂未发现代理。</div>';
  const indexed = account.subagents.map((subagent, index) => ({ subagent, index }));
  const renderRow = ({ subagent, index }, depth, expanded = false) => {
    const path = subagent.path || [subagent.name];
    const draft = thresholdDrafts.get(thresholdDraftKey(account.id, path));
    const alertStep = draft ? draft.alertStep : (Number.isFinite(subagent.alertStep) ? subagent.alertStep : '');
    const remark = draft ? draft.remark : (subagent.remark || '');
    const readAtFull = subagent.readAt ? new Date(subagent.readAt).toLocaleString('zh-CN') : '尚未成功读取';
    const readAt = subagent.readAt ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(subagent.readAt)) : '尚未成功读取';
    const positiveRange = notifiedRange(subagent.alertedPositiveMax, subagent.alertStep, 1);
    const negativeRange = notifiedRange(subagent.alertedNegativeMax, subagent.alertStep, -1);
    const lastAlert = subagent.lastAlertAt ? ` · 最近通知：${new Date(subagent.lastAlertAt).toLocaleString('zh-CN')}` : '';
    return `<tr class="subagent-row ${depth ? 'second-level' : 'first-level'} ${subagent.stale ? 'stale' : ''}" data-subagent-index="${index}">
      <td><div class="subagent-name">${depth === 0 ? `<button type="button" class="tree-toggle" data-action="expand-subagent" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(subagent.name)} 的下级代理" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button>` : '<span class="tree-leaf" aria-hidden="true">↳</span>'}<div><strong title="${escapeHtml(path.join(' / '))}">${escapeHtml(subagent.name)}</strong><small>${depth ? `二级代理 · 上级 ${escapeHtml(path[0])}` : `直属代理${Number.isFinite(subagent.childCount) ? ` · 下级 ${subagent.childCount} 个` : ''}`}</small><small class="read-time" title="${escapeHtml(readAtFull)}">最后成功读取：${escapeHtml(readAt)}</small>${subagent.stale ? '<small class="child-error">数据已过期</small>' : ''}${subagent.childError ? `<small class="child-error">下级读取失败：${escapeHtml(subagent.childError)}</small>` : ''}</div></div></td>
      <td class="subagent-value ${subagent.value < 0 ? 'negative' : subagent.value > 0 ? 'positive' : 'zero'}">${subagent.value > 0 ? '+' : ''}${money.format(subagent.value)}</td>
      <td class="notified-tiers" title="正向：${escapeHtml(positiveRange)}；负向：${escapeHtml(negativeRange)}${escapeHtml(lastAlert)}"><span class="tier-positive">🔵 ${escapeHtml(positiveRange)}</span><span class="tier-negative">🔴 ${escapeHtml(negativeRange)}</span><small title="${escapeHtml(alertReason(subagent))}">${escapeHtml(alertReason(subagent))}</small></td>
      <td><input data-field="remark" type="text" maxlength="100" value="${escapeHtml(remark)}" placeholder="备注同步到 Telegram" aria-label="${escapeHtml(subagent.name)} 的备注" /></td>
      <td><input data-field="alertStep" type="number" min="0.01" step="0.01" value="${alertStep}" placeholder="例如 100；留空关闭" aria-label="${escapeHtml(subagent.name)} 的提醒间隔" /></td>
      <td><button class="secondary" data-action="save-subagent">保存</button></td>
    </tr>`;
  };
  const branches = indexed.filter(({ subagent }) => (subagent.path || [subagent.name]).length === 1).map((parent) => {
    const parentPath = parent.subagent.path || [parent.subagent.name];
    const expanded = (account.expandedAgentPaths || []).some((item) => pathKey(item) === pathKey(parentPath))
      && !collapsedAgentPaths.has(thresholdDraftKey(account.id, parentPath));
    const children = indexed.filter(({ subagent }) => {
      const path = subagent.path || [subagent.name];
      return path.length === 2 && path[0] === parentPath[0];
    });
    const childContent = children.length ? children.map((child) => renderRow(child, 1)).join('')
      : `<tr class="child-placeholder"><td colspan="6">${parent.subagent.childError ? '下级读取失败，请刷新重试' : Number.isFinite(parent.subagent.childCount) ? '暂无下级代理' : '正在读取下级代理…'}</td></tr>`;
    return `<tbody class="agent-branch">${renderRow(parent, 0, expanded)}</tbody><tbody class="child-group" ${expanded ? '' : 'hidden'}>${childContent}</tbody>`;
  }).join('');
  return `<div class="agent-table-scroll"><table class="agent-table"><thead><tr><th scope="col">代理层级 / 最后成功读取</th><th scope="col">本周应收下线</th><th scope="col">本周已提醒档位</th><th scope="col">备注（同步通知）</th><th scope="col">提醒间隔（正负）</th><th scope="col">操作</th></tr></thead>${branches}</table></div>`;
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
  return {
    accountId: account.id,
    path: subagent.path || [subagent.name],
    focusedField: active.dataset.field,
    alertStep: subagentRow.querySelector('[data-field="alertStep"]').value,
    remark: subagentRow.querySelector('[data-field="remark"]').value,
  };
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
  $('#ok-count').textContent = accounts.filter((a) => a.status === 'ok').length;
  $('#alert-count').textContent = accounts.reduce((count, account) => count + (account.subagents || []).filter(isSubagentTriggered).length, 0);
  $('#error-count').textContent = accounts.filter((a) => a.status === 'error').length;
  $('#empty').classList.toggle('show', accounts.length === 0);
  $('#accounts').innerHTML = accounts.map((account) => {
    const checked = account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查';
    const statusDetail = account.error || (account.status === 'checking' ? account.stage : '') || checked;
    const configuredCount = (account.subagents || []).filter((subagent) => subagent.customized && Number.isFinite(subagent.alertStep)).length;
    const period = account.reportPeriod;
    const periodText = period?.start && period?.end ? `${period.start}—${period.end}` : '待读取';
    const periodLabel = !period?.start ? '报表日期' : ['ok', 'triggered'].includes(account.status) ? '已核对本周日期' : '上次报表日期';
    return `<article class="account-row" data-id="${account.id}">
      <div class="account-main"><div class="account-avatar">${escapeHtml(account.name.slice(0,1))}</div><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.username)}${account.routeSpeed ? ` · 最快线路 ${account.routeSpeed}ms` : ''} · 直属代理 ${Number.isFinite(account.subagentCount) ? account.subagentCount : '待读取'} 个</small></div></div>
      <div class="metric"><small>直属代理数量</small><strong>${Number.isFinite(account.subagentCount) ? account.subagentCount : '—'}</strong></div>
      <div class="threshold"><small>已设置提醒</small><strong>${configuredCount} 个代理</strong></div>
      <div class="status-wrap"><span class="status ${account.status || 'waiting'}">${statusNames[account.status] || statusNames.waiting}</span><small title="${escapeHtml(statusDetail)}">${escapeHtml(statusDetail)}</small></div>
      <div class="actions"><button data-action="view" title="打开盘口；验证码失败时可手动登录">盘内查看</button><button data-action="check" title="立即检查">刷新</button><button data-action="toggle">${account.enabled ? '暂停' : '启用'}</button><button data-action="edit">编辑</button><button data-action="remove">删除</button></div>
      <div class="subagents"><div class="subagents-head"><strong>两级代理应收下线</strong><small>${periodLabel}：${escapeHtml(periodText)} · 提醒从 0 起，正负每档每周各一次；点击直属代理展开下级。</small></div>${subagentList(account)}</div>
    </article>`;
  }).join('');
  restoreThresholdDraft(thresholdDraft, state);
  $('#events').innerHTML = (state.events || []).map((event) => `<div class="event ${event.type}"><i></i><time>${new Date(event.time).toLocaleString('zh-CN')}</time><span>${escapeHtml(event.message)}</span></div>`).join('') || '<div class="empty show"><p>暂无运行记录</p></div>';
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
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}

let accountDialogGeneration = 0;
async function openAccount(account) {
  const generation = ++accountDialogGeneration;
  const form = $('#account-form');
  form.reset();
  form.elements.navUrl.value = account?.navUrl || 'https://166.tt';
  form.elements.intervalMinutes.value = account?.intervalMinutes || 5;
  form.elements.enabled.checked = account?.enabled !== false;
  for (const key of ['id','name','username']) form.elements[key].value = account?.[key] ?? '';
  $('#route-preview').innerHTML = routePreview(account);
  $('#dialog-title').textContent = account ? '编辑监控账号' : '添加监控账号';
  $('#view-account').hidden = !account;
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

$('#account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const account = Object.fromEntries(form.entries());
  account.enabled = event.currentTarget.elements.enabled.checked;
  action(async () => {
    const result = await window.monitorApi.saveAccount(account);
    $('#account-dialog').close();
    if (account.enabled) await window.monitorApi.checkAccount(result.id);
  }, '账号已保存，正在识别线路并测试登录');
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
    };
    action(async () => {
      await window.monitorApi.saveSubagentThreshold(settings);
      thresholdDrafts.delete(thresholdDraftKey(account.id, settings.path));
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
  thresholdDrafts.set(thresholdDraftKey(account.id, subagent.path || [subagent.name]), {
    alertStep: subagentRow.querySelector('[data-field="alertStep"]').value,
    remark: subagentRow.querySelector('[data-field="remark"]').value,
  });
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

window.monitorApi.onState(render);
window.monitorApi.getState().then(render).catch((error) => toast(error.message));
