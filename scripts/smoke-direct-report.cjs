const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { SiteClient, settlementWeekRange } = require('../electron/monitor');
const { loadLoginPage } = require('../electron/login-page-load');
const { captureFailureScene } = require('../electron/failure-scene');
let phase = 'startup';
const deadline = setTimeout(() => { console.error(`Direct report smoke timed out: ${phase}`); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const week = settlementWeekRange(); let failDirect = false; let calls = 0;
  const table = (name, amount) => {
    const row = (name, value) => `<tr><td onclick="child('${name}')">${name}</td><td>代理</td>${[1,1,1,1,2,2,2,value,...Array(10).fill(0)].map(x=>`<td>${x}</td>`).join('')}</tr>`;
    return `<table id="mytable"><tr>${['代理账号','名称','笔数','会员数','下注金额','有效金额','输赢','退水','盈亏结果','应收下线',...Array(10).fill('其他')].map(x=>`<th>${x}</th>`).join('')}</tr>${row(name,amount)}${row('合计',amount)}</table>`;
  };
  const server = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.url === '/slow-login') {
      res.setHeader('Set-Cookie', 'loginReadyCookie=yes; HttpOnly; SameSite=Lax; Path=/');
      res.end('<input><input type="password"><input><img width="80" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><iframe src="/slow-child"></iframe>'); return;
    }
    if (req.url === '/slow-child') {
      const timer = setTimeout(() => res.end('late resource'), 5000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    if (req.url === '/IntimeSheet/GetCurrentInstall') {
      if (req.method !== 'POST' || !req.headers.cookie?.includes('fixtureSession=yes')) { res.statusCode = 403; res.end('login'); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(new URLSearchParams(body).get('lotteryType'), 'JND282');
      if (!req.headers.referer?.endsWith('/IntimeSheet/Index')) { res.statusCode = 403; res.end('missing request context'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Installments: '3494518', PreInstallments: '3494517', PreLotteryResult: '7,5,1', OpenTimeStamp: 112, TemplateCode: 'JNDPCDD' })); return;
    }
    if (req.url === '/Home/Index') {
      res.setHeader('Set-Cookie', 'fixtureSession=yes; HttpOnly; SameSite=Lax; Path=/');
      res.end('<a href="/query">报表查询</a><div id="navAgentReport"><span id="dates"></span><div id="AgentReportNav"></div></div><iframe id="frame"></iframe>'); return;
    }
    if (req.url === '/query') {
      res.end(`<input id="txtStartTime"><input id="txtEndTime"><button id="thisWeek" onclick="document.querySelector('#txtStartTime').value='${week.start}';document.querySelector('#txtEndTime').value='${week.end}'">本星期</button><button id="btnSelect" onclick="run([])">查询</button><div id="report"></div><script>
        var respData; var active=[];
        async function run(path) {
          const querydata=JSON.stringify({path,userid:'id-'+(path.at(-1)||'fixture'),level:3+path.length,startDate:document.querySelector('#txtStartTime').value,endDate:document.querySelector('#txtEndTime').value});
          const r=await fetch('/ReportNew/Agent',{method:'POST',body:new URLSearchParams({querydata,startIndex:'0',rows:'500000'})});
          const html=await r.text(); const marker='var respData = '; const start=html.indexOf(marker)+marker.length;
          respData=JSON.parse(html.slice(start,html.indexOf(';<'+'/'+'script>',start)));
          document.querySelector('#report').innerHTML=html.slice(0,html.indexOf('<script>'));
          active=path;
          parent.document.querySelector('#dates').textContent=respData.sdate+'—'+respData.edate;
          parent.document.querySelector('#AgentReportNav').innerHTML=respData.orgLevel.map(x=>'<a>代理('+x.loginId+')</a>').join('');
        }
        function child(name){ run([...active,name]); }
      </script>`); return;
    }
    if (req.url === '/ReportNew/Agent') {
      calls++;
      if (!req.headers.cookie?.includes('fixtureSession=yes')) { res.statusCode=403;res.end('login');return; }
      let body=''; for await(const chunk of req) body+=chunk;
      const q=JSON.parse(new URLSearchParams(body).get('querydata'));
      if(failDirect && req.headers['x-requested-with']) {res.end('<form>login</form>'); return;}
      const name=['first','second','third','fourth'][q.path.length];
      const value=100*(q.path.length+1);
      const d={State:1,total:2,sdate:q.startDate,edate:q.endDate,orgLevel:['fixture',...q.path].map((loginId,i)=>({loginId,orgId:'id-'+loginId,level:3+i})),sum:{Lotterys:['A','B'],A:[{orgName:name}],B:[{orgName:name}],sumSubResult:value,SumList:[{orgName:name,subResult:value}]}};
      res.end(table(name,value)+`<script>var respData = ${JSON.stringify(d)};</script>`); return;
    }
    res.statusCode=404;res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const isolated=session.fromPartition('direct-report-smoke-'+Date.now());
  const win=new BrowserWindow({show:false,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  let client;
  const create=()=>{const c=new SiteClient({id:'direct-fixture'}, {agentUrl:origin+'/Home/Index'});c.window=win;c.ownsWindow=false;return c;};
  try {
    phase='learning four levels from rendered reports';
    await win.loadURL(origin+'/Home/Index');client=create();
    assert.equal((await client.readThisWeekSettlement()).value,100);
    for(const path of [['first'],['first','second'],['first','second','third']]) assert.equal((await client.readDescendantSettlement(path)).value,(path.length+1)*100);
    assert.equal(client.status.directRead.learned,4);
    assert.equal(client.status.directRead.attempts,0);
    await client.close();
    phase='reading a new round without page navigation using the same Electron cookie session';
    client=create(); const before=calls;
    assert.equal((await client.readThisWeekSettlement()).value,100);
    for(const path of [['first'],['first','second'],['first','second','third']]) assert.equal((await client.readDescendantSettlement(path)).value,(path.length+1)*100);
    assert.equal(calls-before,4); assert.equal(client.status.directRead.successes,4);
    assert.equal(client.currentReportPath,null);
    await client.close();
    phase='falling back from HTTP 200 login content to a fresh webpage';
    client=create();failDirect=true;
    assert.equal((await client.readThisWeekSettlement()).value,100);
    assert.equal(client.status.directRead.fallbacks,1);
    assert.equal((await client.readDescendantSettlement(['first'])).value,200);
    assert.equal(client.status.directRead.attempts,1,'failing direct transport stays disabled this round');
    await assert.rejects(client.readDescendantSettlement(['first','second','third','fourth']),/四级/);
    await client.close(); failDirect=false;
    phase='relearning after fallback and safely recovering a failed direct child';
    client=create(); await client.readThisWeekSettlement(); await client.readDescendantSettlement(['first']); await client.close();
    client=create(); await client.readThisWeekSettlement();
    assert.equal(client.status.directRead.successes,1);
    failDirect=true;
    assert.equal((await client.readDescendantSettlement(['first'])).value,200);
    assert.equal(client.status.directRead.fallbacks,1);
    assert.deepEqual(client.currentReportPath,['first']);
    phase='reading the verified draw response through Electron session.fetch';
    assert.equal(await client.readSettledDrawQuery({ url: origin + '/IntimeSheet/GetCurrentInstall', referrer: origin + '/IntimeSheet/Index', body: 'lotteryType=JND282&temaType=0&organizationId=' }), '3494517');
    assert.equal(client.status.drawSuggestedPollMs, 60000);
    phase='accepting a validated login form without waiting for a slow iframe';
    const loginWin = new BrowserWindow({ show: false, webPreferences: { partition: 'login-readiness-smoke', nodeIntegration: false, contextIsolation: true } });
    try {
      const started = Date.now();
      await loadLoginPage(loginWin, origin + '/slow-login', { timeoutMs: 3000 });
      assert.ok(Date.now() - started < 3000);
      assert.equal(await loginWin.webContents.executeJavaScript('Boolean(document.querySelector("input[type=password]"))'), true);
      assert.ok((await loginWin.webContents.session.cookies.get({ name: 'loginReadyCookie' })).some(cookie => cookie.value === 'yes'));
      await loginWin.webContents.executeJavaScript('document.body.append("验证码错误 fixture-private-value"); document.title="管理员登录 fixture-private-value"');
      const scene = await captureFailureScene(loginWin);
      assert.equal(scene.document, 'login-form'); assert.equal(scene.title, 'login');
      assert.ok(scene.hints.includes('captcha-rejected'));
      assert.ok(!JSON.stringify(scene).includes('fixture-private-value'));
      phase='refreshing a synthetic captcha only after changed pixels are loaded';
      const freshImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><rect width="80" height="30" fill="red"/></svg>');
      await loginWin.webContents.executeJavaScript(`(() => { const img=document.querySelector('img'); img.id='captcha'; window.refreshClicks=0; img.onclick=()=>{window.refreshClicks++;img.src=${JSON.stringify(freshImage)}}; })()`);
      const captchaClient = new SiteClient({}, {}); captchaClient.window = loginWin;
      const refreshed = await captchaClient.refreshCaptcha();
      assert.ok(refreshed.ready && refreshed.fingerprint);
      assert.equal(await loginWin.webContents.executeJavaScript('window.refreshClicks'), 1);
      await loginWin.webContents.executeJavaScript('document.body.append("其他地方登录")');
      await captchaClient.rememberLoginScene();
      assert.match(captchaClient.status.sessionRecoveryReason, /明确提示其他地方/);
      await loginWin.loadURL('about:blank');
      assert.equal((await captureFailureScene(loginWin)).document, 'blank');
    } finally { loginWin.destroy(); }
    console.log('Direct report Electron smoke passed: UI learning, four-level session.fetch, cookie isolation, safe fallback, PC28 draw response, content-ready login');
  } catch(error) {console.error(`${phase}: ${error.stack}`); process.exitCode=1;}
  finally {await client?.close();win.destroy();server.close();clearTimeout(deadline);app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
