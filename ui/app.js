let appState = { accounts: [], events: [], telegram: {} };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusNames = { waiting: '等待首次检查', checking: '正在检查', ok: '运行正常', triggered: '已达阈值', error: '检查失败' };

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

function render(state) {
  appState = state;
  const accounts = state.accounts || [];
  $('#total-count').textContent = accounts.length;
  $('#ok-count').textContent = accounts.filter((a) => a.status === 'ok').length;
  $('#alert-count').textContent = accounts.filter((a) => a.status === 'triggered').length;
  $('#error-count').textContent = accounts.filter((a) => a.status === 'error').length;
  $('#empty').classList.toggle('show', accounts.length === 0);
  $('#accounts').innerHTML = accounts.map((account) => {
    const comparison = account.operator === 'lte' ? '≤' : '≥';
    const value = Number.isFinite(account.currentValue) ? money.format(account.currentValue) : '—';
    const checked = account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查';
    return `<article class="account-row" data-id="${account.id}">
      <div class="account-main"><div class="account-avatar">${escapeHtml(account.name.slice(0,1))}</div><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.username)}${account.routeSpeed ? ` · 最快线路 ${account.routeSpeed}ms` : ''}</small></div></div>
      <div class="metric"><small>本周交收金额</small><strong>${value}</strong></div>
      <div class="threshold"><small>提醒条件</small><strong>${comparison} ${money.format(account.threshold)}</strong></div>
      <div class="status-wrap"><span class="status ${account.status || 'waiting'}">${statusNames[account.status] || statusNames.waiting}</span><small title="${escapeHtml(account.error || '')}">${escapeHtml(account.error || checked)}</small></div>
      <div class="actions"><button data-action="check" title="立即检查">刷新</button><button data-action="toggle">${account.enabled ? '暂停' : '启用'}</button><button data-action="edit">编辑</button><button data-action="remove">删除</button></div>
    </article>`;
  }).join('');
  $('#events').innerHTML = (state.events || []).map((event) => `<div class="event ${event.type}"><i></i><time>${new Date(event.time).toLocaleString('zh-CN')}</time><span>${escapeHtml(event.message)}</span></div>`).join('') || '<div class="empty show"><p>暂无运行记录</p></div>';
  $('#telegram-form').elements.chatId.value = state.telegram?.chatId || '';
  const updater = state.updater || {};
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
  form.elements.operator.value = account?.operator || 'gte';
  form.elements.enabled.checked = account?.enabled !== false;
  for (const key of ['id','name','username','threshold']) form.elements[key].value = account?.[key] ?? '';
  $('#dialog-title').textContent = account ? '编辑监控账号' : '添加监控账号';
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
    await window.monitorApi.saveAccount(account);
    $('#account-dialog').close();
  }, '账号已保存');
});

$('#accounts').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const row = event.target.closest('[data-id]');
  if (!button || !row) return;
  const account = appState.accounts.find((item) => item.id === row.dataset.id);
  if (button.dataset.action === 'edit') openAccount(account);
  if (button.dataset.action === 'check') action(() => window.monitorApi.checkAccount(account.id), '已开始检查');
  if (button.dataset.action === 'toggle') action(() => window.monitorApi.toggleAccount(account.id, !account.enabled));
  if (button.dataset.action === 'remove' && confirm(`确定删除“${account.name}”吗？`)) action(() => window.monitorApi.removeAccount(account.id), '账号已删除');
});

$('#telegram-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  action(() => window.monitorApi.saveTelegram(values), 'Telegram 设置已保存');
});
$('#test-telegram').addEventListener('click', () => action(() => window.monitorApi.testTelegram(), '测试消息已发送'));
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
