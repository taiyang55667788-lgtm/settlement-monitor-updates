function readSummary(samples = [], now = Date.now()) {
  const rows = samples.filter(x => now - Date.parse(x.at) >= 0 && now - Date.parse(x.at) < 86400000);
  const successful = rows.filter(x => ['ok', 'triggered'].includes(x.status)).length;
  const sum = key => rows.reduce((n, x) => n + (Number(x.direct?.[key]) || 0), 0);
  const directAttempts = sum('attempts'); const directSuccesses = sum('successes');
  return { rounds: rows.length, successful, partial: rows.filter(x => x.status === 'partial').length,
    successRate: rows.length ? successful / rows.length : null,
    averageMs: rows.length ? rows.reduce((n,x)=>n+(Number(x.durationMs)||0),0) / rows.length : null,
    directAttempts, directSuccesses, directRate: directAttempts ? directSuccesses / directAttempts : null,
    directAverageMs: directSuccesses ? sum('totalMs') / directSuccesses : null,
    fallbacks: sum('fallbacks'), sessionLosses: rows.filter(x => x.sessionLost).length,
    recoveries: rows.filter(x => x.recovery && ['ok','triggered'].includes(x.status)).length,
    since: rows[0]?.at || '' };
}

function failureCategory(error) {
  const message = String(error?.message || error);
  if (error?.code === 'CROWN_HUMAN_VERIFICATION_REQUIRED' || /验证码|图形验证/.test(message)) return '验证码';
  if (/密码错误|账号.*错误|账户.*错误|密码不正确|账号不存在|用户名.*错误/i.test(message)) return '账号凭据';
  if (error?.code === 'SESSION_EXPIRED' || /登录状态已失效|登陆状态已失效|会话.*失效|登录已过期/.test(message)) return '登录状态';
  if (/ERR_|超时|网络|fetch failed|offline|ECONN|ENOTFOUND/i.test(message)) return '网络或加载超时';
  if (/登录|登陆|会话/.test(message)) return '登录状态';
  return '报表读取或校验';
}

function failedBranch(previous, intervalMinutes, now = Date.now()) {
  const failures = Math.min(10, (Number(previous?.failures) || 0) + 1);
  const base = Math.max(1, Number(intervalMinutes) || 5) * 60000;
  return { failures, nextAt: now + Math.min(Math.max(base, 1800000), base * 2 ** Math.min(failures - 1, 5)) };
}

// Deliberate allowlist: automatic files contain only operational aggregates.
function operationalDiagnostic(accounts, runtime, version, platform, now = Date.now()) {
  return { format: 'settlement-monitor-operational-diagnostics-v1', exportedAt: new Date(now).toISOString(),
    app: { version, platform }, accounts: accounts.map((account, index) => {
      const live = runtime.get(account.id) || {};
      const samples = (live.readSamples || []).filter(x => now - Date.parse(x.at) < 86400000).slice(-2000).map(x => ({
        at: x.at, status: x.status, durationMs: x.durationMs, failureKind: x.failureKind || '',
        sessionLost: Boolean(x.sessionLost), recovery: Boolean(x.recovery),
        direct: x.direct ? { attempts: x.direct.attempts, successes: x.direct.successes, failures: x.direct.failures,
          fallbacks: x.direct.fallbacks, totalMs: x.direct.totalMs, learned: x.direct.learned } : null,
      }));
      return { account: index + 1, enabled: Boolean(account.enabled), status: live.status || 'waiting',
        intervalMinutes: account.intervalMinutes, lastSuccessAt: live.lastSuccessAt || '',
        summary: readSummary(samples, now), readSamples: samples };
    }) };
}

module.exports = { readSummary, failureCategory, failedBranch, operationalDiagnostic };
