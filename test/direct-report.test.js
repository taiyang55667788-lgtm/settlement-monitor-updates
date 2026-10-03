const test = require('node:test');
const assert = require('node:assert/strict');
const { DirectReportReader, extractReportData, validateData, requestTemplate, clearDirectSession } = require('../electron/direct-report');
const period = { start: '2026-09-28', end: '2026-10-04' };
const data = () => ({ State: 1, sdate: period.start, edate: period.end, total: 2,
  orgLevel: [{ loginId: 'root', orgId: 'root-id', level: 3 }, { loginId: 'parent', orgId: 'parent-id', level: 4 }],
  sum: { Lotterys: ['A','B'], A: [{orgName:'child'}], B: [{orgName:'child'}], sumSubResult: 20, SumList: [{ orgName: 'child', subResult: 20, memAmount: 999 }] } });
const request = () => ({ url: 'https://example.test/ReportNew/Agent?identity=private', method: 'POST',
  body: new URLSearchParams({ querydata: JSON.stringify({ userid: 'parent-id', level: 4, startDate: period.start, endDate: period.end }), startIndex: '0', rows: '500000' }).toString() });
const stats = () => ({ attempts: 0, successes: 0, failures: 0, fallbacks: 0, totalMs: 0 });
const html = d => `<script>var respData = ${JSON.stringify(d)};</script>`;
function setup(fetch = async () => new Response(html(data()))) {
  const session = { fetch }; const s = stats(); const reader = new DirectReportReader(session, 'https://example.test', s, 20);
  assert.equal(reader.learn(['parent'], period, request(), data(), { value: 20, agents: [{ name: 'child', value: 20 }] }, ['root', 'parent']), true);
  return { reader, session, s };
}

test('direct parser extracts JSON without executing script and uses subResult', () => {
  const d = data(); d.sum.SumList[0].orgName = 'a"}]; throw Error("bad")';
  assert.deepEqual(extractReportData(html(d)), d);
  assert.equal(validateData(data(), period, ['root', 'parent']).agents[0].value, 20);
  for (const body of ['<form>login</form>', 'var respData = alert(1)', html(data()) + html(data()), 'var respData = {bad:1}']) assert.throws(() => extractReportData(body));
});

test('direct parser rejects stale, wrong-path, malformed, duplicate and truncated results', () => {
  for (const mutate of [d=>d.State=0, d=>d.sdate='2026-09-21', d=>d.orgLevel.reverse(),
    d=>d.sum.sumSubResult=null, d=>d.sum.SumList[0].subResult='20', d=>d.sum.SumList=[],
    d=>d.sum.SumList.push(d.sum.SumList[0]), d=>d.total=500000, d=>d.sum.A=[], d=>d.sum.B[0].orgName='missing']) {
    const d = data(); mutate(d); assert.throws(() => validateData(d, period, ['root', 'parent']));
  }
});

test('only observed same-origin complete first-page requests can be learned', () => {
  assert.ok(requestTemplate(request(), 'https://example.test', period));
  for (const change of [{ url: 'https://evil.test/ReportNew/Agent' }, { method: 'GET' }, { url: 'https://example.test/other' }, { body: 'querydata={}' }]) {
    assert.equal(requestTemplate({ ...request(), ...change }, 'https://example.test', period), null);
  }
  const { reader } = setup();
  assert.equal(reader.learn(['parent'], period, request(), data(), { value: 999, agents: [] }, ['root', 'parent']), false);
  assert.equal(reader.learn(['other'], period, request(), data(), { value: 20, agents: [{ name: 'child', value: 20 }] }, ['root', 'parent']), false);
});

test('same session reuses templates; accounts, weeks, paths, origins and cleared sessions are isolated', async () => {
  const { reader, session, s } = setup();
  assert.equal((await reader.read(['parent'], period)).value, 20);
  assert.equal(s.successes, 1);
  assert.equal(await reader.read(['sibling'], period), null);
  assert.equal(await new DirectReportReader({}, 'https://example.test', stats()).read(['parent'], period), null);
  assert.equal(await new DirectReportReader(session, 'https://other.test', stats()).read(['parent'], period), null);
  assert.equal((await new DirectReportReader(session, 'https://example.test', stats()).read(['parent'], period)).value, 20);
  clearDirectSession(session);
  assert.equal(await reader.read(['parent'], period), null);
  const next = setup();
  assert.equal(await next.reader.read(['parent'], { ...period, end: '2026-10-11' }), null);
});

test('HTTP 200 login pages, network failures and oversized responses trigger sanitized fallback', async () => {
  for (const fetch of [async()=>new Response('login'), async()=>{throw Error('secret-url-token');},
    async()=>new Response(html(data()), {status:403}), async()=>new Response('large', {headers:{'content-length':'9000000'}})]) {
    const { reader, s } = setup(fetch);
    assert.equal(await reader.read(['parent'], period), null);
    assert.equal(s.fallbacks, 1); assert.equal(reader.disabled, true);
    assert.ok(!JSON.stringify(s).includes('secret'));
  }
});

test('timeout aborts the request instead of leaving a background fetch running', async () => {
  let aborted = false;
  const { reader, s } = setup((url, options) => new Promise((resolve,reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
  }));
  assert.equal(await reader.read(['parent'], period), null);
  assert.equal(aborted, true); assert.equal(s.failures, 1);
});

test('same names with changed identity cannot reuse a learned query', async () => {
  const d = data(); d.orgLevel[1].orgId = 'different-id';
  const { reader, s } = setup(async()=>new Response(html(d)));
  assert.equal(await reader.read(['parent'],period),null);
  assert.equal(s.fallbacks,1);
});

test('templates expire without performing a network request', async () => {
  const { reader, s }=setup(); const now=Date.now;
  try { Date.now=()=>now()+31*60*1000; assert.equal(await reader.read(['parent'],period),null); }
  finally { Date.now=now; }
  assert.equal(s.attempts,0);
});
