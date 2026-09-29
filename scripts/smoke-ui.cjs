const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 820,
    webPreferences: { preload: path.join(__dirname, 'smoke-ui-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => document.querySelectorAll('.subagent-row').length === 4 ? resolve() : Date.now() > deadline ? reject(new Error('四级代理列表未显示')) : setTimeout(poll, 25);
      poll();
    })`);
    const initial = await win.webContents.executeJavaScript(`({
      tableCount: document.querySelectorAll('.agent-table').length,
      headings: [...document.querySelectorAll('.agent-table th')].map(cell => cell.textContent.trim()),
      visible: [...document.querySelectorAll('.subagent-row')].map(row => getComputedStyle(row).display !== 'none'),
      remarks: [...document.querySelectorAll('.subagent-row [data-field="remark"]')].map(input => input.value),
      tiers: [...document.querySelectorAll('.subagent-row .notified-tiers')].map(cell => cell.textContent.trim()),
      progress: [...document.querySelectorAll('.threshold-progress')].map(cell => cell.textContent.trim()),
      reminderLabels: [...document.querySelectorAll('.subagent-row .reminder-settings')].map(cell => [...cell.querySelectorAll('label > span')].map(label => label.textContent.trim())),
      batchRemoved: !document.querySelector('.batch-editor, .batch-select'),
      visibleUnsavedHints: [...document.querySelectorAll('.unsaved-hint')].filter(hint => !hint.hidden && getComputedStyle(hint).display !== 'none').length,
      recentAlerts: [...document.querySelectorAll('.recent-alert')].map(cell => cell.textContent.trim()),
      status: document.querySelector('.status-wrap .status').textContent.trim(),
      thresholdState: document.querySelector('.threshold-state').textContent.trim(),
      readTimes: [...document.querySelectorAll('.subagent-row .subagent-name')].map(cell => cell.textContent),
      valueColors: [...document.querySelectorAll('.subagent-value')].map(cell => getComputedStyle(cell).color),
      depths: [...document.querySelectorAll('.subagent-row')].map(row => Number(row.dataset.depth)),
    })`);
    assert.equal(initial.tableCount, 1);
    assert.deepEqual(initial.headings, ['代理层级 / 最后成功读取', '本周应收下线', '提醒状态', '备注（同步通知）', '提醒设置', '操作']);
    assert.deepEqual(initial.visible, [true, true, true, true]);
    assert.deepEqual(initial.depths, [1, 2, 3, 4]);
    assert.deepEqual(initial.remarks, ['直属备注', '二级备注', '三级备注', '四级备注']);
    assert.match(initial.tiers[0], /\+500（最近）/);
    assert.match(initial.tiers[1], /−200（最近）/);
    assert.deepEqual(initial.progress, ['下一档 +600 · 差 60', '下一档 −400 · 差 170', '下一档 +400 · 差 70', '下一档 −500 · 差 70']);
    assert.deepEqual(initial.reminderLabels, Array.from({ length: 4 }, () => ['金额档位', '变化阈值']));
    assert.equal(initial.batchRemoved, true);
    assert.equal(initial.visibleUnsavedHints, 0);
    assert.equal(initial.recentAlerts.length, 1);
    assert.match(initial.recentAlerts[0], /^最近提醒：09\/19 \d{2}:03$/);
    assert.equal(initial.status, '运行正常');
    assert.equal(initial.thresholdState, '已达阈值：4 个下级代理');
    assert.equal(initial.readTimes.every((text) => text.includes('最后成功读取：')), true);
    assert.notEqual(initial.valueColors[0], initial.valueColors[1]);
    const stableStatus = await win.webContents.executeJavaScript(`(async () => {
      const original = structuredClone(await window.monitorApi.getState());
      const field = document.querySelector('.subagent-row input[data-field="remark"]');
      field.focus();
      const beforeHeight = document.querySelector('.status-wrap').getBoundingClientRect().height;
      const next = structuredClone(original);
      next.accounts[0].status = 'checking';
      next.accounts[0].stage = '当前代理详细路径/'.repeat(30);
      next.accounts[0].readProgress = { read: 75, pendingBranches: 7 };
      render(next);
      const result = { sameNode: field === document.querySelector('.subagent-row input[data-field="remark"]'), focused: document.activeElement === field, beforeHeight, afterHeight: document.querySelector('.status-wrap').getBoundingClientRect().height, text: document.querySelector('.status-wrap').textContent };
      document.querySelector('[data-action="reading-details"]').click();
      result.details = document.querySelector('#reading-details-content').textContent;
      result.open = document.querySelector('#reading-dialog').open;
      document.querySelector('#close-reading-details').click();
      render(original);
      return result;
    })()`);
    assert.equal(stableStatus.sameNode, true);
    assert.equal(stableStatus.focused, true);
    assert.equal(stableStatus.beforeHeight, stableStatus.afterHeight);
    assert.doesNotMatch(stableStatus.text, /75|待查分支|当前代理详细路径/);
    assert.equal(stableStatus.open, true);
    assert.match(stableStatus.details, /75 个代理；待查分支：7/);
    const queue = await win.webContents.executeJavaScript(`(async () => {
      const original = structuredClone(await window.monitorApi.getState());
      const next = structuredClone(original);
      next.startupCheck = { status: 'warning', message: '首次读取未完成：测试账号' };
      next.notificationQueue = { pending: 2, failed: 1, held: 1, items: [
        { id: 'test-message-1', text: '模拟待发消息 <script>不会执行</script>', createdAt: new Date().toISOString(), attempts: 1, error: '模拟断网' },
        { id: 'test-message-2', text: '旧收件人消息', createdAt: new Date().toISOString(), held: true }
      ] };
      next.accounts[0].subagents[0].stale = true;
      next.accounts[0].subagents[0].staleReason = 'waiting';
      render(next);
      document.querySelector('#open-notification-queue').click();
      return { open: document.querySelector('#notification-dialog').open,
        count: document.querySelectorAll('.queued-message').length,
        unsafeScripts: document.querySelectorAll('#notification-items script').length,
        heldRetryDisabled: document.querySelector('[data-queue-id="test-message-2"][data-queue-action="retry"]').disabled,
        waiting: document.querySelector('.subagent-name').textContent,
        startup: document.querySelector('#startup-check').textContent };
    })()`);
    assert.equal(queue.open, true); assert.equal(queue.count, 2); assert.equal(queue.unsafeScripts, 0);
    assert.equal(queue.heldRetryDisabled, true);
    assert.match(queue.waiting, /本轮尚未读到/); assert.match(queue.startup, /首次读取未完成/);
    const retried = new Promise(resolve => ipcMain.once('smoke:queue-action', (_event, result) => resolve(result)));
    await win.webContents.executeJavaScript(`document.querySelector('[data-queue-id="test-message-1"][data-queue-action="retry"]').click()`);
    assert.deepEqual(await retried, { id: 'test-message-1', action: 'retry' });
    const cancelled = new Promise(resolve => ipcMain.once('smoke:queue-action', (_event, result) => resolve(result)));
    await win.webContents.executeJavaScript(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('[data-queue-id="test-message-1"][data-queue-action="cancel"]').click(); window.confirm = original; })()`);
    assert.deepEqual(await cancelled, { id: 'test-message-1', action: 'cancel' });
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (process.env.SMOKE_QUEUE_DIALOG_SCREENSHOT) fs.writeFileSync(process.env.SMOKE_QUEUE_DIALOG_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(async () => { document.querySelector('#close-notification-queue').click(); render(await window.monitorApi.getState()); })()`);
    if (process.env.SMOKE_SCREENSHOT) {
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        document.querySelector('.subagents').scrollIntoView({ block: 'start' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      fs.writeFileSync(process.env.SMOKE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#theme-select');
      select.value = 'light';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const light = await win.webContents.executeJavaScript(`({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      valueColors: [...document.querySelectorAll('.subagent-value')].map(cell => getComputedStyle(cell).color),
    })`);
    assert.equal(light.theme, 'light');
    assert.equal(light.background, 'rgb(243, 247, 252)');
    assert.notEqual(light.valueColors[0], light.valueColors[1]);
    await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (process.env.SMOKE_SCREENSHOT_LIGHT) fs.writeFileSync(process.env.SMOKE_SCREENSHOT_LIGHT, (await win.webContents.capturePage()).toPNG());
    const otherThemes = await win.webContents.executeJavaScript(`(() => ['graphite','contrast'].map(theme => {
      document.documentElement.dataset.theme = theme;
      return { theme, background: getComputedStyle(document.body).backgroundColor,
        positive: getComputedStyle(document.querySelector('.subagent-value.positive')).color,
        negative: getComputedStyle(document.querySelector('.subagent-value.negative')).color };
    }))()`);
    assert.deepEqual(otherThemes.map((item) => item.background), ['rgb(16, 17, 20)', 'rgb(0, 0, 0)']);
    assert.equal(otherThemes.every((item) => item.positive !== item.negative), true);
    await win.webContents.executeJavaScript(`document.querySelector('.tree-toggle').click()`);
    const collapsed = await win.webContents.executeJavaScript(`document.querySelectorAll('.subagent-row').length === 1`);
    assert.equal(collapsed, true);
    const childHidden = await win.webContents.executeJavaScript(`!document.querySelector('.level-2')`);
    assert.equal(childHidden, true);
    await win.webContents.executeJavaScript(`document.querySelector('.tree-toggle').click()`);
    const childVisible = await win.webContents.executeJavaScript(`document.querySelectorAll('.subagent-row').length === 4 && Boolean(document.querySelector('.level-4'))`);
    assert.equal(childVisible, true);
    const filter = await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-action="filter-reminders"]').click();
      return { rows: document.querySelectorAll('.subagent-row').length, pressed: document.querySelector('[data-action="filter-reminders"]').getAttribute('aria-pressed') };
    })()`);
    assert.equal(filter.rows, 4);
    assert.equal(filter.pressed, 'true');
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="filter-reminders"]').click()`);
    const pending = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.subagent-row')[1];
      const input = row.querySelector('[data-field="alertStep"]');
      input.value = '300';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { dirty: row.classList.contains('has-unsaved'), button: row.querySelector('[data-action="save-subagent"]').textContent, hint: row.querySelector('.unsaved-hint').textContent };
    })()`);
    assert.deepEqual(pending, { dirty: true, button: '保存修改', hint: '未保存' });
    const saved = new Promise((resolve) => ipcMain.once('smoke:save', (_event, settings) => resolve(settings)));
    await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.subagent-row')[1];
      row.querySelector('[data-field="remark"]').value = '西区';
      row.querySelector('[data-field="alertStep"]').value = '300';
      row.querySelector('[data-action="save-subagent"]').click();
    })()`);
    const settings = await saved;
    assert.deepEqual(settings.path, ['parent-01', 'child-01']);
    assert.equal(settings.remark, '西区');
    assert.equal(settings.alertStep, '300');
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="edit"]').click()`);
    const editCode = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => document.querySelector('#account-dialog').open
        ? resolve(document.querySelector('#account-form').elements.securityCode.value)
        : Date.now() > deadline ? reject(new Error('编辑弹窗未打开')) : setTimeout(poll, 20);
      poll();
    })`);
    assert.equal(editCode, '75454');
    await win.webContents.executeJavaScript(`document.querySelector('.close-dialog').click()`);
    await win.webContents.executeJavaScript(`window.monitorApi.__smokeEmitState({
      accounts: [{
        id: 'total-account', name: '总盘账号', username: 'total', enabled: true, systemType: 'crown', crownLoginEntry: 'login-1', monitorMetric: 'general-agent-result',
        status: 'triggered', subagentCount: 1, reportPeriod: { start: '2026-09-21', end: '2026-09-27' },
        subagents: [{ name: 'general-a', path: ['general-a'], value: -1250, turnover: 3000, readAt: '2026-09-22T06:00:00.000Z', remark: '总盘', alertStep: 500, customized: true, alertedPositiveLevel: 0, alertedNegativeLevel: -2, lastObservedLevel: -2 }],
      }], events: [], alertRecords: [{ time: '2026-09-22T06:00:00.000Z', status: 'sent', accountName: '总盘账号', agentPath: ['general-a'], value: -1250, level: -2, alertStep: 500 }], telegram: {}, update: {}, updater: {}, appearance: { theme: 'ocean' }, alertPolicy: {},
    })`);
    const totalResult = await win.webContents.executeJavaScript(`({
      heading: document.querySelector('.agent-table th:nth-child(2)').textContent.trim(),
      label: document.querySelector('.subagents-head strong').textContent.trim(),
      rows: document.querySelectorAll('.subagent-row').length,
      treeToggle: Boolean(document.querySelector('.tree-toggle')),
      value: document.querySelector('.subagent-value').textContent,
      turnover: document.querySelector('.subagent-turnover').textContent,
    })`);
    assert.deepEqual(totalResult, { heading: '总代理结果', label: '本周总代理明细', rows: 1, treeToggle: false, value: '-1,250.00趋势数据积累中', turnover: '3,000.00' });
    await win.webContents.executeJavaScript(`document.querySelector('#add-account').click()`);
    const crownFields = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        const dialog = document.querySelector('#account-dialog');
        if (!dialog.open) return Date.now() > deadline ? reject(new Error('添加账号弹窗未打开')) : setTimeout(poll, 20);
        const form = document.querySelector('#account-form');
        form.elements.systemType.value = 'crown';
        form.elements.systemType.dispatchEvent(new Event('change', { bubbles: true }));
        resolve({
          securityVisible: !form.elements.securityCode.closest('label').hidden,
          securitySection: form.elements.securityCode.closest('.config-section').querySelector('.config-title strong').textContent,
          securityLabel: form.elements.securityCode.closest('label').querySelector('.security-code-label').textContent,
          routeHidden: document.querySelector('#route-preview').hidden,
          domainVisible: !form.elements.crownDomain.closest('[data-system-field]').hidden,
          entryVisible: !form.elements.crownLoginEntry.closest('[data-system-field]').hidden,
        });
      };
      poll();
    })`);
    assert.deepEqual(crownFields, { securityVisible: true, securitySection: '盘口账号登录', securityLabel: '皇冠登录安全码（登录界面必填；编辑时明文显示）', routeHidden: true, domainVisible: true, entryVisible: true });
    await win.webContents.executeJavaScript(`document.querySelector('.close-dialog').click()`);
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="alerts"]').click()`);
    const alertPage = await win.webContents.executeJavaScript(`({
      visible: document.querySelector('#alerts-view').classList.contains('active'),
      record: document.querySelector('.alert-record')?.textContent.trim(),
    })`);
    assert.equal(alertPage.visible, true);
    assert.match(alertPage.record, /Telegram 已发送/);
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="update"]').click()`);
    const downloadPage = await win.webContents.executeJavaScript(`({
      visible: document.querySelector('#update-view').classList.contains('active'),
      url: document.querySelector('#latest-download-url').textContent.trim(),
    })`);
    assert.equal(downloadPage.visible, true);
    assert.equal(downloadPage.url, 'https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest');
    const openedDownload = new Promise((resolve) => ipcMain.once('smoke:open-latest-download', resolve));
    await win.webContents.executeJavaScript(`document.querySelector('#open-latest-download').click()`);
    await openedDownload;
    const copiedDownload = new Promise((resolve) => ipcMain.once('smoke:copy-latest-download', resolve));
    await win.webContents.executeJavaScript(`document.querySelector('#copy-latest-download').click()`);
    await copiedDownload;
    const filtered = await win.webContents.executeJavaScript(`(async () => {
      const next = structuredClone(await window.monitorApi.getState());
      const account = next.accounts[0];
      account.expandedAgentPaths = [];
      for (const agent of account.subagents) { agent.alertStep = null; agent.deltaAlertStep = null; }
      account.subagents.at(-1).deltaAlertStep = 10;
      account.subagents[2].stale = true;
      account.subagents[2].notRefreshed = true;
      account.subagents.push({ name: 'unrelated', path: ['unrelated'], value: 0 });
      render(next);
      const defaultRows = document.querySelectorAll('.subagent-row').length;
      document.querySelector('[data-action="filter-reminders"]').click();
      return { defaultRows, names: [...document.querySelectorAll('.subagent-name strong')].map(el => el.textContent), stale: document.querySelector('.level-3').textContent };
    })()`);
    assert.equal(filtered.defaultRows, 2);
    assert.deepEqual(filtered.names, ['parent-01', 'child-01', 'third-01', 'fourth-01']);
    assert.match(filtered.stale, /按需更新/);
    const fullScan = new Promise(resolve => ipcMain.once('smoke:full-scan', (_event, id) => resolve(id)));
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="full-scan"]').click()`);
    assert.equal(await fullScan, 'fixture-account');
    const reliability = await win.webContents.executeJavaScript(`(() => {
      const next = structuredClone(appState);
      next.accounts[0].status = 'partial';
      next.accounts[0].subagents[0].pendingNotifications = 2;
      next.notificationQueue = { pending: 2, failed: 1, held: 1 };
      render(next);
      document.querySelector('[data-view="alerts"]').click();
      return {
        status: document.querySelector('.status-wrap .status').textContent,
        errors: document.querySelector('#error-count').textContent,
        queue: document.querySelector('#notification-queue').textContent,
        reason: alertReason(next.accounts[0].subagents[0]),
      };
    })()`);
    assert.equal(reliability.status, '部分读取失败');
    assert.equal(reliability.errors, '1');
    assert.match(reliability.queue, /待发送 2 条.*失败待重试 1 条.*暂存 1 条/);
    assert.equal(reliability.reason, '通知待发送 2 条');
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (process.env.SMOKE_QUEUE_SCREENSHOT) fs.writeFileSync(process.env.SMOKE_QUEUE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    process.stdout.write('Four-level UI smoke test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.exit(process.exitCode || 0);
});
