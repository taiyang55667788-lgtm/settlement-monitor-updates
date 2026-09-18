const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { SiteClient } = require('../electron/monitor');
let phase = 'waiting for Electron';
const deadline = setTimeout(() => {
  process.stderr.write(`Two-level report DOM smoke test timed out while ${phase}\n`);
  app.exit(1);
}, 45000);

function row(name, value, clickable = false) {
  const cellAction = clickable ? ` class="account" onclick="showChildren('${name}')" style="cursor:pointer"` : '';
  return `<tr><td${cellAction}>${name}</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>${value}</td><td>7</td><td>8</td></tr>`;
}

function table(rows) {
  return `<table id="mytable"><tr><th>代理账号</th><th>投注</th><th>有效</th><th>输赢</th><th>本级</th><th>结果</th><th>上级交收 交收金额</th><th>盈亏</th><th>备注</th></tr>${rows}</table>`;
}

app.whenReady().then(async () => {
  phase = 'preparing fixture';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-monitor-report-smoke-'));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const client = new SiteClient({ id: 'fixture' }, { stage: '' });
  client.window = win;
  try {
    const childTableA = table(row('child-01', -230) + row('合计', -230));
    const childTableB = table(row('child-01', 310) + row('合计', 310));
    const rootTable = table(row('parent-01', 540, true) + row('parent-02', 620, true) + row('合计', 1160));
    const queryHtml = `<input id="txtStartTime" value="2026-09-18"><input id="txtEndTime" value="2026-09-18"><button id="thisWeek" onclick="selectWeek()">本星期</button><button id="btnSelect" onclick="showRoot()">查 询</button><main id="report"></main><script>
      function range() { return [document.querySelector('#txtStartTime').value, document.querySelector('#txtEndTime').value]; }
      function selectWeek() {
        if (window.parent.forceTodayOnWeekButton) return;
        document.querySelector('#txtStartTime').value = '2026-09-14';
        document.querySelector('#txtEndTime').value = '2026-09-20';
      }
      function showRoot() {
        const [start, end] = range();
        window.parent.setReportPeriod(window.parent.forceTodayOnQuery ? '2026-09-18' : start, window.parent.forceTodayOnQuery ? '2026-09-18' : end, ['fixture']);
        document.querySelector('#report').innerHTML = ${JSON.stringify(rootTable)};
      }
      function showChildren(agent) {
        const [start, end] = range();
        window.parent.setReportPeriod(start, end, ['fixture', agent]);
        document.querySelector('#report').innerHTML = agent === 'parent-01' ? ${JSON.stringify(childTableA)} : ${JSON.stringify(childTableB)};
      }
    </script>`;
    fs.writeFileSync(path.join(directory, 'query.html'), queryHtml);
    fs.writeFileSync(path.join(directory, 'index.html'), `<a href="./query.html">报表查询</a><div id="navAgentReport"><span class="date"></span><div id="AgentReportNav"></div></div><iframe id="frame" name="frame"></iframe><script>
      window.setReportPeriod = (start, end, path) => {
        document.querySelector('#navAgentReport .date').textContent = '[' + start + '——' + end + ']';
        document.querySelector('#AgentReportNav').innerHTML = path.map(name => '<a>' + name + '</a>').join('');
      };
    </script>`);
    phase = 'loading fixture';
    await win.loadFile(path.join(directory, 'index.html'));
    phase = 'opening root report';
    await client.openThisWeekReport();
    assert.deepEqual(client.reportPeriod, { start: '2026-09-14', end: '2026-09-20' });
    phase = 'reading root report';
    const root = await client.readCurrentSettlement();
    assert.deepEqual(root.agents, [{ name: 'parent-01', value: 540 }, { name: 'parent-02', value: 620 }]);
    phase = 'reading first child report';
    const childrenA = await client.readDescendantSettlement(['parent-01']);
    assert.deepEqual(client.reportPeriod, { start: '2026-09-14', end: '2026-09-20' });
    phase = 'reading second child report';
    const childrenB = await client.readDescendantSettlement(['parent-02']);
    assert.deepEqual(childrenA.agents, [{ name: 'child-01', value: -230 }]);
    assert.deepEqual(childrenB.agents, [{ name: 'child-01', value: 310 }]);
    await win.webContents.executeJavaScript('window.forceTodayOnWeekButton = true');
    await assert.rejects(client.readDescendantSettlement(['parent-01']), /未设定完整一周的日期/);
    await win.webContents.executeJavaScript('window.forceTodayOnWeekButton = false; window.forceTodayOnQuery = true');
    await assert.rejects(client.openThisWeekReport(), /报表日期或代理层级与本周/);
    process.stdout.write('Two-level report DOM smoke test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  clearTimeout(deadline);
  app.exit(1);
});
