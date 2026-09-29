const CACHE_MS = 6 * 60 * 60 * 1000;

function scanState(previous, metric, period, now = Date.now()) {
  if (previous?.metric === metric && previous.period === period && now - previous.startedAt < CACHE_MS) return previous;
  return { metric, period, startedAt: now, completed: {} };
}

function branchHasTarget(path, settings) {
  return settings.some(item => (Number(item.alertStep) > 0 || Number(item.deltaAlertStep) > 0)
    && (item.path || [item.name]).length > path.length
    && path.every((part, i) => part === (item.path || [item.name])[i]));
}

function priorityPaths(settings) {
  const paths = new Map();
  for (const item of settings) {
    if (!(Number(item.alertStep) > 0 || Number(item.deltaAlertStep) > 0)) continue;
    const target = item.path || [item.name];
    for (let depth = 1; depth < target.length && depth < 4; depth++) {
      const path = target.slice(0, depth); paths.set(JSON.stringify(path), path);
    }
  }
  return [...paths.values()].sort((a, b) => a.length - b.length);
}

function retryDelay(account, failures = 0) {
  const base = Math.max(1, Number(account.intervalMinutes) || 5) * 60000;
  return Math.min(Math.max(base, 30 * 60000), base * 2 ** Math.min(Math.max(0, failures - 1), 5));
}

function startupCheck(accounts, runtime, startedAt, loadStatus, running, upgraded = false) {
  if (loadStatus === 'failed') return { status: 'error', message: '配置加载失败，请恢复备份，监控尚未恢复' };
  if (loadStatus === 'recovered') return { status: 'warning', message: '已恢复加密备份，请核对账号、提醒设置和通知记录' };
  const enabled = accounts.filter(item => item.enabled);
  if (!enabled.length) return { status: 'idle', message: '配置已加载，但没有启用的监控账号' };
  if (!running) return { status: 'error', message: '监控调度未启动' };
  const pending = enabled.filter(item => Date.parse(runtime.get(item.id)?.lastSuccessAt || '') < startedAt || !runtime.get(item.id)?.lastSuccessAt);
  if (!pending.length) return { status: 'ok', message: upgraded ? '升级完成，全部启用账号已成功读取，监控已恢复' : '启动自检通过，全部启用账号已成功读取' };
  const failed = pending.filter(item => ['error', 'partial', 'manual'].includes(runtime.get(item.id)?.status));
  return { status: failed.length ? 'warning' : 'checking', message: `${failed.length ? '首次读取未完成，请查看账号详情' : '等待首次成功读取'}：${pending.map(item => item.name).join('、')}` };
}

module.exports = { CACHE_MS, scanState, branchHasTarget, priorityPaths, retryDelay, startupCheck };
