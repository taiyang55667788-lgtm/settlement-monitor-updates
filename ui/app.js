let appState = { accounts: [], events: [], telegram: {} };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusNames = { waiting: '等待首次检查', checking: '正在检查', ok: '运行正常', triggered: '已达阈值', error: '检查失败' };
const thresholdDrafts = new Map();

const thresholdDraftKey = (accountId, subagentName) => `${accountId}\u0000${subagentName}`;

function isSubagentTriggered(subagent) {
  return (Number.isFinite(subagent.lowerThreshold) && subagent.value <= subagent.lowerThreshold)
    || (Number.isFinite(subagent.upperThreshold) && subagent.value >= subagent.upperThreshold);
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
  return account.subagents.map((subagent, index) => {
    const draft = thresholdDrafts.get(thresholdDraftKey(account.id, subagent.name));
    const lowerThreshold = draft ? draft.lowerThreshold : (Number.isFinite(subagent.lowerThreshold) ? subagent.lowerThreshold : '');
    const upperThreshold = draft ? draft.upperThreshold : (Number.isFinite(subagent.upperThreshold) ? subagent.upperThreshold : '');
    return `
    <div class="subagent-row" data-subagent-index="${index}">
      <div><strong>${escapeHtml(subagent.name)}</strong><small>${subagent.customized ? ((Number.isFinite(subagent.lowerThreshold) || Number.isFinite(subagent.upperThreshold)) ? '独立阈值' : '提醒已关闭') : '尚未设置提醒'}</small></div>
      <div class="subagent-value"><small>本周交收金额</small><strong>${money.format(subagent.value)}</strong></div>
      <label>低于提醒（≤）<input data-field="lowerThreshold" type="number" step="0.01" value="${lowerThreshold}" placeholder="关闭" /></label>
      <label>高于提醒（≥）<input data-field="upperThreshold" type="number" step="0.01" value="${upperThreshold}" placeholder="关闭" /></label>
      <button class="secondary" data-action="save-subagent">保存</button>
    </div>`;
  }).join('');
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
    subagentName: subagent.name,
    focusedField: active.dataset.field,
    lowerThreshold: subagentRow.querySelector('[data-field="lowerThreshold"]').value,
    upperThreshold: subagentRow.querySelector('[data-field="upperThreshold"]').value,
  };
}

function restoreThresholdDraft(draft, state) {
  if (!draft) return;
  const account = state.accounts?.find((item) => item.id === draft.accountId);
  const index = account?.subagents?.findIndex((item) => item.name === draft.subagentName);
  if (index < 0) return;
  const accountRow = [...document.querySelectorAll('.account-row')].find((row) => row.dataset.id === draft.accountId);
  const subagentRow = accountRow?.querySelector(`[data-subagent-index="${index}"]`);
  if (!subagentRow) return;
  subagentRow.querySelector('[data-field="lowerThreshold"]').value = draft.lowerThreshold;
  subagentRow.querySelector('[data-field="upperThreshold"]').value = draft.upperThreshold;
  subagentRow.querySelector(`[data-field="${draft.focusedField}"]`)?.focus();
}

function render(state) {
  const thresholdDraft = captureThresholdDraft();
  appState = state;
  const accounts = state.accounts || [];
  $('#total-count').textContent = accounts.length;
  $('#ok-count').textContent = accounts.filter((a) => a.status === 'ok').length;
  $('#alert-count').textContent = accounts.reduce((count, account) => count + (account.subagents || []).filter(isSubagentTriggered).length, 0);
  $('#error-count').textContent = accounts.filter((a) => a.status === 'error').length;
  $('#empty').classList.toggle('show', accounts.length === 0);
  $('#accounts').innerHTML = accounts.map((account) => {
    const checked = account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查';
    const statusDetail = account.error || (account.status === 'checking' ? account.stage : '') || checked;
    const configuredCount = (account.subagents || []).filter((subagent) => subagent.customized && (Number.isFinite(subagent.lowerThreshold) || Number.isFinite(subagent.upperThreshold))).length;
    return `<article class="account-row" data-id="${account.id}">
      <div class="account-main"><div class="account-avatar">${escapeHtml(account.name.slice(0,1))}</div><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.username)}${account.routeSpeed ? ` · 最快线路 ${account.routeSpeed}ms` : ''} · 下级代理 ${Number.isFinite(account.subagentCount) ? account.subagentCount : '待读取'} 个</small></div></div>
      <div class="metric"><small>下级代理数量</small><strong>${Number.isFinite(account.subagentCount) ? account.subagentCount : '—'}</strong></div>
      <div class="threshold"><small>已设置提醒</small><strong>${configuredCount} 个代理</strong></div>
      <div class="status-wrap"><span class="status ${account.status || 'waiting'}">${statusNames[account.status] || statusNames.waiting}</span><small title="${escapeHtml(statusDetail)}">${escapeHtml(statusDetail)}</small></div>
      <div class="actions"><button data-action="view" title="打开盘口；验证码失败时可手动登录">盘内查看</button><button data-action="check" title="立即检查">刷新</button><button data-action="toggle">${account.enabled ? '暂停' : '启用'}</button><button data-action="edit">编辑</button><button data-action="remove">删除</button></div>
      <div class="subagents"><div class="subagents-head"><strong>下级代理与独立提醒</strong><small>只监控这些下级代理；每个代理分别设置低于和高于提醒。</small></div>${subagentList(account)}</div>
    </article>`;
  }).join('');
  restoreThresholdDraft(thresholdDraft, state);
  $('#events').innerHTML = (state.events || []).map((event) => `<div class="event ${event.type}"><i></i><time>${new Date(event.time).toLocaleString('zh-CN')}</time><span>${escapeHtml(event.message)}</span></div>`).join('') || '<div class="empty show"><p>暂无运行记录</p></div>';
  $('#telegram-form').elements.chatId.value = state.telegram?.chatId || '';
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

function openAccount(account) {
  const form = $('#account-form');
  form.reset();
  form.elements.navUrl.value = account?.navUrl || 'https://166.tt';
  form.elements.intervalMinutes.value = account?.intervalMinutes || 5;
  form.elements.enabled.checked = account?.enabled !== false;
  for (const key of ['id','name','username']) form.elements[key].value = account?.[key] ?? '';
  $('#route-preview').innerHTML = routePreview(account);
  $('#dialog-title').textContent = account ? '编辑监控账号' : '添加监控账号';
  $('#view-account').hidden = !account;
  $('#account-dialog').showModal();
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${button.dataset.view}-view`));
  $('#page-title').textContent = button.textContent.trim();
  $('#add-account').style.display = button.dataset.view === 'dashboard' ? '' : 'none';
}));

$('#add-account').addEventListener('click', () => openAccount());
$$('.add-trigger').forEach((button) => button.addEventListener('click', () => openAccount()));
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => $('#account-dialog').close()));

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
      name: subagent.name,
      lowerThreshold: subagentRow.querySelector('[data-field="lowerThreshold"]').value,
      upperThreshold: subagentRow.querySelector('[data-field="upperThreshold"]').value,
    };
    action(async () => {
      await window.monitorApi.saveSubagentThreshold(settings);
      thresholdDrafts.delete(thresholdDraftKey(account.id, subagent.name));
    }, `${subagent.name} 的提醒条件已保存`);
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
  thresholdDrafts.set(thresholdDraftKey(account.id, subagent.name), {
    lowerThreshold: subagentRow.querySelector('[data-field="lowerThreshold"]').value,
    upperThreshold: subagentRow.querySelector('[data-field="upperThreshold"]').value,
  });
});

$('#telegram-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  action(() => window.monitorApi.saveTelegram(values), 'Telegram 设置已保存');
});
$('#test-telegram').addEventListener('click', () => {
  const values = Object.fromEntries(new FormData($('#telegram-form')).entries());
  action(() => window.monitorApi.testTelegram(values), '测试消息已发送');
});
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
