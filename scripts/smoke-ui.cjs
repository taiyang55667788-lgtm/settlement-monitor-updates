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
      const poll = () => document.querySelectorAll('.subagent-row').length === 2 ? resolve() : Date.now() > deadline ? reject(new Error('代理列表未显示')) : setTimeout(poll, 25);
      poll();
    })`);
    const initial = await win.webContents.executeJavaScript(`({
      tableCount: document.querySelectorAll('.agent-table').length,
      headings: [...document.querySelectorAll('.agent-table th')].map(cell => cell.textContent.trim()),
      visible: [...document.querySelectorAll('.subagent-row')].map(row => getComputedStyle(row).display !== 'none'),
      remarks: [...document.querySelectorAll('.subagent-row [data-field="remark"]')].map(input => input.value),
      tiers: [...document.querySelectorAll('.subagent-row .notified-tiers')].map(cell => cell.textContent.trim()),
      readTimes: [...document.querySelectorAll('.subagent-row .subagent-name')].map(cell => cell.textContent),
      valueColors: [...document.querySelectorAll('.subagent-value')].map(cell => getComputedStyle(cell).color),
    })`);
    assert.equal(initial.tableCount, 1);
    assert.deepEqual(initial.headings, ['代理层级 / 最后成功读取', '本周应收下线', '本周已提醒档位', '备注（同步通知）', '提醒间隔（正负）', '操作']);
    assert.deepEqual(initial.visible, [true, true]);
    assert.deepEqual(initial.remarks, ['直属备注', '二级备注']);
    assert.match(initial.tiers[0], /\+100～\+500（5 档）/);
    assert.match(initial.tiers[1], /−200（1 档）/);
    assert.equal(initial.readTimes.every((text) => text.includes('最后成功读取：')), true);
    assert.notEqual(initial.valueColors[0], initial.valueColors[1]);
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
    const collapsed = await win.webContents.executeJavaScript(`document.querySelector('.child-group').hidden`);
    assert.equal(collapsed, true);
    const childHidden = await win.webContents.executeJavaScript(`document.querySelector('.second-level').getClientRects().length === 0`);
    assert.equal(childHidden, true);
    await win.webContents.executeJavaScript(`document.querySelector('.tree-toggle').click()`);
    const childVisible = await win.webContents.executeJavaScript(`document.querySelector('.second-level').getClientRects().length > 0`);
    assert.equal(childVisible, true);
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
    process.stdout.write('Two-level UI smoke test passed\n');
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
