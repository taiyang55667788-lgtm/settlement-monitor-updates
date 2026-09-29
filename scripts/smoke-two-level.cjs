const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { SiteClient, settlementWeekRange } = require('../electron/monitor');
let phase = 'waiting for Electron';
const deadline = setTimeout(() => {
  process.stderr.write(`Four-level report DOM smoke test timed out while ${phase}\n`);
  app.exit(1);
}, 45000);

function row(name, value, clickable = false) {
  const cellAction = clickable ? ` class="account" onclick="showChildren('${name}')" style="cursor:pointer"` : '';
  const agentCells = name === '合计' ? '<td colspan="2">合计</td>' : `<td${cellAction}>${name}</td><td>代理</td>`;
  const otherCells = [...Array(4).fill('1'), ...Array(3).fill('2'), value, ...Array(8).fill('3'), '4', '999999'];
  return `<tr>${agentCells}${otherCells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function table(rows) {
  return `<table id="mytable"><tr><th rowspan="2">代理账号</th><th rowspan="2">名称</th><th rowspan="2">笔数</th><th rowspan="2">会员数</th><th rowspan="2">下注金额</th><th rowspan="2">有效金额</th><th colspan="3">会员输赢</th><th colspan="9">代理 输赢</th><th rowspan="2">上交货量</th><th rowspan="2">上级交收</th></tr><tr>${['输赢','退水','盈亏结果','应收下线','占成','实占金额','实占结果','实占退水','赚水','赚赔','占货比','盈亏结果'].map((label) => `<th>${label}</th>`).join('')}</tr>${rows}</table>`;
}

app.whenReady().then(async () => {
  phase = 'preparing fixture';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-monitor-report-smoke-'));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const client = new SiteClient({ id: 'fixture' }, { stage: '' });
  const week = settlementWeekRange();
  client.window = win;
  try {
    const childTableA = table(row('child-01', -230, true) + row('合计', -230));
    const childTableB = table(row('child-01', 310) + row('合计', 310));
    const thirdTable = table(row('third-01', 330, true) + row('合计', 330));
    const fourthTable = table(row('fourth-01', -430, true) + row('合计', -430));
    const fifthTable = table(row('fifth-01', 530) + row('合计', 530));
    const rootTable = table(row('parent-01', 540, true) + row('parent-02', 620, true) + row('合计', 1160));
    const tables = { 'parent-01': childTableA, 'parent-02': childTableB, 'parent-01/child-01': thirdTable, 'parent-01/child-01/third-01': fourthTable, 'parent-01/child-01/third-01/fourth-01': fifthTable };
    const queryHtml = `<input id="txtStartTime" value="${week.start}"><input id="txtEndTime" value="${week.start}"><button id="thisWeek" onclick="selectWeek()">本星期</button><button id="btnSelect" onclick="showRoot()">查 询</button><main id="report"></main><script>
      const tables = ${JSON.stringify(tables)}; let reportPath = [];
      function range() { return [document.querySelector('#txtStartTime').value, document.querySelector('#txtEndTime').value]; }
      function selectWeek() {
        if (window.parent.forceTodayOnWeekButton) return;
        document.querySelector('#txtStartTime').value = ${JSON.stringify(week.start)};
        document.querySelector('#txtEndTime').value = ${JSON.stringify(week.end)};
      }
      function showRoot() {
        const [start, end] = range();
        reportPath = [];
        window.parent.setReportPeriod(window.parent.forceTodayOnQuery ? '2026-09-18' : start, window.parent.forceTodayOnQuery ? '2026-09-18' : end, ['fixture']);
        document.querySelector('#report').innerHTML = ${JSON.stringify(rootTable)};
      }
      function showChildren(agent) {
        const [start, end] = range();
        reportPath = [...reportPath, agent];
        window.parent.setReportPeriod(start, end, ['fixture', ...reportPath]);
        document.querySelector('#report').innerHTML = tables[reportPath.join('/')] || ${JSON.stringify(table(row('合计', 0)))};
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
    assert.deepEqual(client.reportPeriod, week);
    phase = 'reading root report';
    const root = await client.readCurrentSettlement();
    assert.deepEqual(root.agents, [{ name: 'parent-01', value: 540 }, { name: 'parent-02', value: 620 }]);
    phase = 'reading first child report';
    const childrenA = await client.readDescendantSettlement(['parent-01']);
    assert.deepEqual(client.reportPeriod, week);
    phase = 'reading second child report';
    const childrenB = await client.readDescendantSettlement(['parent-02']);
    assert.deepEqual(childrenA.agents, [{ name: 'child-01', value: -230 }]);
    assert.deepEqual(childrenB.agents, [{ name: 'child-01', value: 310 }]);
    phase = 'reading level three report';
    const third = await client.readDescendantSettlement(['parent-01', 'child-01']);
    phase = 'reading level four report';
    const fourth = await client.readDescendantSettlement(['parent-01', 'child-01', 'third-01']);
    phase = 'reading level five report';
    await assert.rejects(client.readDescendantSettlement(['parent-01', 'child-01', 'third-01', 'fourth-01']), /最多读取四级/);
    assert.deepEqual(third.agents, [{ name: 'third-01', value: 330 }]);
    assert.deepEqual(fourth.agents, [{ name: 'fourth-01', value: -430 }]);
    await win.webContents.executeJavaScript('window.forceTodayOnWeekButton = true');
    await assert.rejects(client.readDescendantSettlement(['parent-01']), /未设定完整一周的日期/);
    await win.webContents.executeJavaScript('window.forceTodayOnWeekButton = false; window.forceTodayOnQuery = true');
    await assert.rejects(client.openThisWeekReport(), /报表日期或代理层级与本周/);
    const displayPeriod = (() => { const [sy, sm, sd] = week.start.split('-').map(Number); const [ey, em, ed] = week.end.split('-').map(Number); return `${sy}/${sm}/${sd} ~ ${ey}/${em}/${ed}`; })();
    const crownDetails = `<table><tr>${['总代理帐号', '名称', '总代理结果', '总代理实货量', ...Array(12).fill('其他栏位')].map(label => `<th>${label}</th>`).join('')}</tr><tr>${['总计', '', '-1250', '6000', ...Array(12).fill('0')].map(value => `<td>${value}</td>`).join('')}</tr><tr>${['general-a', '总代 A', '-250', '3000', ...Array(12).fill('0')].map(value => `<td>${value}</td>`).join('')}</tr><tr>${['general-b', '总代 B', '500', '2000', ...Array(12).fill('0')].map(value => `<td>${value}</td>`).join('')}</tr></table>`;
    const crownReportHtml = `<ul><li onclick="openReports()">常用 报表</li></ul><main id="content"></main><script>
      function openReports() { document.querySelector('#content').innerHTML = '<select id="result_type_div_600"><option value="N">无结果</option><option value="Y">有结果</option></select><select id="date_div_600"><option value="td">今天</option><option value="tw">本周</option></select><select id="gtype_div_600"><option value="ALL">全部</option></select><button onclick="query()">查询</button>'; }
      function query() { document.querySelector('#content').innerHTML = '<div>${displayPeriod}</div><button onclick="view()">观看总代理</button>'; }
      function view() { document.querySelector('#content').innerHTML = ${JSON.stringify(crownDetails)}; }
    </script>`;
    fs.writeFileSync(path.join(directory, 'crown-report.html'), crownReportHtml);
    phase = 'reading Crown general-agent details';
    const crownReportClient = new SiteClient({ id: 'crown-report', systemType: 'crown', crownLoginEntry: 'login-2' }, { stage: '' });
    crownReportClient.window = win;
    await win.loadFile(path.join(directory, 'crown-report.html'));
    await crownReportClient.openThisWeekReport();
    const crownReport = await crownReportClient.readCurrentSettlement();
    assert.deepEqual(crownReport.agents, [{ name: 'general-a', value: -250, turnover: 3000 }, { name: 'general-b', value: 500, turnover: 2000 }]);
    assert.equal(crownReport.value, -1250);
    assert.equal(crownReport.turnover, 6000);
    const crownHtml = `<input name="username"><input type="password" name="password"><input name="securityCode"><button onclick="complete()">登⼊</button><script>
      function complete() { window.crownInputs = [...document.querySelectorAll('input')].map(input => input.value); document.body.innerHTML = '<div id="left_dsearch_user_type"></div><div>绩效概况</div>'; }
    </script>`;
    fs.writeFileSync(path.join(directory, 'crown.html'), crownHtml);
    phase = 'testing Crown login entry';
    const crownClient = new SiteClient({ id: 'crown-fixture', systemType: 'crown', crownLoginEntry: 'login-1', navUrl: `file://${path.join(directory, 'crown.html')}`, username: 'crown-user', password: 'crown-pass', securityCode: 'crown-code' }, { stage: '' });
    crownClient.window = win;
    await crownClient.loginCrown(`file://${path.join(directory, 'crown.html')}`);
    phase = 'checking Crown login result';
    assert.equal(await win.webContents.executeJavaScript(`/绩效概况/.test(document.body.innerText)`), true);
    assert.deepEqual(await win.webContents.executeJavaScript('window.crownInputs'), ['crown-user', 'crown-pass', 'crown-code']);
    const crownDefaultHtml = `<input name="username"><input type="password" name="password"><input type="password" name="securityCode"><button onclick="complete()">登⼊</button><script>
      function complete() { window.defaultInputs = [...document.querySelectorAll('input')].map(input => input.value); document.body.innerHTML = '<div id="left_dsearch_user_type"></div><div>绩效概况</div>'; }
    </script>`;
    fs.writeFileSync(path.join(directory, 'crown-default.html'), crownDefaultHtml);
    phase = 'testing Crown default login-one form';
    const crownDefaultClient = new SiteClient({ id: 'crown-default', systemType: 'crown', crownLoginEntry: 'login-1', username: 'crown-user', password: 'crown-pass', securityCode: 'crown-code' }, { stage: '' });
    crownDefaultClient.window = win;
    await win.loadFile(path.join(directory, 'crown-default.html'));
    await crownDefaultClient.loginCrown(`file://${path.join(directory, 'crown-default.html')}`);
    assert.deepEqual(await win.webContents.executeJavaScript('window.defaultInputs'), ['crown-user', 'crown-pass', 'crown-code']);
    const crownVerificationHtml = `<label>登录账号<input name="username"></label><label>密码<input type="password" name="password"></label><label>安全码<input name="securityCode"></label><label>图形验证<input name="verifyCode"></label><button>登录</button>`;
    fs.writeFileSync(path.join(directory, 'crown-verification.html'), crownVerificationHtml);
    phase = 'detecting Crown human verification';
    const crownVerificationClient = new SiteClient({ id: 'crown-verification', systemType: 'crown', crownLoginEntry: 'login-1', username: 'crown-user', password: 'crown-pass', securityCode: 'crown-code' }, { stage: '' });
    crownVerificationClient.window = win;
    await win.loadFile(path.join(directory, 'crown-verification.html'));
    await assert.rejects(crownVerificationClient.loginCrown(`file://${path.join(directory, 'crown-verification.html')}`), /图形验证/);
    process.stdout.write('Four-level report DOM smoke test passed\n');
  } catch (error) {
    process.stderr.write(`${phase}: ${error.stack || error}\n`);
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
