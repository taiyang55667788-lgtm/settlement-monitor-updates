const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readSummary, failureCategory, failedBranch, operationalDiagnostic } = require('../electron/runtime-health');
const { UpdateService } = require('../electron/updater');

test('24h summaries exclude old samples and compute weighted query timing', () => {
  const now = Date.now();
  const samples = [
    {at:new Date(now-86400001).toISOString(),status:'ok',durationMs:999},
    {at:new Date(now-2000).toISOString(),status:'partial',durationMs:1000,direct:{attempts:3,successes:2,totalMs:400,fallbacks:1},sessionLost:true},
    {at:new Date(now-1000).toISOString(),status:'ok',durationMs:3000,direct:{attempts:1,successes:1,totalMs:500},recovery:true},
  ];
  const s=readSummary(samples,now);
  assert.equal(s.rounds,2);assert.equal(s.successRate,.5);assert.equal(s.averageMs,2000);
  assert.equal(s.directRate,.75);assert.equal(s.directAverageMs,300);assert.equal(s.fallbacks,1);
  assert.equal(s.sessionLosses,1);assert.equal(s.recoveries,1);
  assert.equal(readSummary([]).directRate,null);
});

test('failure categories distinguish expired login from timeout and captcha', () => {
  assert.equal(failureCategory(Error('登录状态已失效，网络请求拒绝')),'登录状态');
  assert.equal(failureCategory(Error('登录会话检查超时')),'网络或加载超时');
  assert.equal(failureCategory(Error('验证码识别失败')),'验证码');
  assert.equal(failureCategory(Error('密码错误')),'账号凭据');
  assert.equal(failureCategory(Error('报表日期不一致')),'报表读取或校验');
});

test('per-branch backoff respects interval and caps waiting', () => {
  const first=failedBranch(null,5,0);assert.equal(first.nextAt,300000);
  assert.equal(failedBranch(first,5,0).nextAt,600000);
  assert.equal(failedBranch({failures:9},5,0).nextAt,1800000);
  assert.equal(failedBranch({failures:9},60,0).nextAt,3600000);
});

test('automatic update diagnostic excludes account, URL, messages and secrets', () => {
  const at=new Date().toISOString();
  const secret='sensitive-marker';
  const accounts=[{id:'a',name:secret,username:secret,password:secret,securityCode:secret,navUrl:secret,enabled:true,intervalMinutes:5}];
  const runtime=new Map([['a',{status:'ok',error:secret,agentPath:secret,readSamples:[{at,status:'ok',durationMs:200,error:secret,direct:{attempts:1,successes:1,totalMs:200,lastFailure:secret,url:secret}}]}]]);
  const result=operationalDiagnostic(accounts,runtime,'1.0.31','test');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.accounts[0].summary.directSuccesses,1);
});

function updater(save) {
  const engine=new EventEmitter();engine.quitAndInstall=()=>{engine.installed=true;};
  const u=new UpdateService({state:{}},()=>{},save,{engine,app:{getVersion:()=> 'test',isPackaged:true}});
  u.runtime.status='ready';return {u,engine};
}
test('updater saves once before installing and never installs when save fails', async () => {
  let saves=0;
  const {u,engine}=updater(()=>{assert.ok(!engine.installed);saves++;return 'saved.json';});
  u.install();assert.equal(saves,1);assert.equal(engine.installed,undefined);
  u.prepareInstall();assert.equal(saves,1);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(engine.installed,true);
  const failed=updater(()=>{throw Error('disk full');});
  assert.throws(()=>failed.u.install(),/尚未安装/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(failed.engine.installed,undefined);
  failed.u.disableAutomaticInstall();assert.equal(failed.engine.autoInstallOnAppQuit,false);
});
