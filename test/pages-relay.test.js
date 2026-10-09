const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
async function worker() {
  const source = readFileSync(require('node:path').join(__dirname, '../relay-connectivity-test/public/_worker.js'));
  return (await import('data:text/javascript;base64,' + source.toString('base64'))).default;
}
test('Pages relay preserves credentials only to fixed upstream and never forwards webhook or arbitrary URL', async () => {
  const w = await worker(); const calls = [];
  const fetcher = async (url, init) => { calls.push({url,init}); return Response.json({ok:true,ready:true}); };
  const r = await w.fetch(new Request('https://pages.example/v1/messages?target=https://evil.example', {
    method:'POST', headers:{authorization:'Bearer test-device',cookie:'secret-cookie','content-type':'application/json'},body:'{"text":"test"}'
  }), {}, {}, fetcher);
  assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(calls[0].url,'https://settlement-monitor-pairing.taiyang55667788.workers.dev/v1/messages');
  assert.equal(calls[0].init.headers.get('authorization'),'Bearer test-device');
  assert.equal(calls[0].init.headers.get('cookie'),null);
  assert.equal(calls[0].init.redirect,'manual');
  assert.equal(await new Response(calls[0].init.body).text(),'{"text":"test"}');
  const denied=await w.fetch(new Request('https://pages.example/v1/telegram/webhook',{method:'POST'}),{},{},fetcher);
  assert.equal(denied.status,404); assert.equal(calls.length,1);
});
test('Pages relay health tests real upstream; upstream failure is explicit and not retried', async () => {
  const w=await worker();let count=0;
  const r=await w.fetch(new Request('https://pages.example/relay/health'),{},{},async url=>{
    count++; assert.ok(url.endsWith('/health'));throw Error('private details');
  });
  assert.equal(r.status,502);assert.equal(count,1);assert.ok(!(await r.text()).includes('private'));
});
test('Pages uses internal service binding and rejects redirects without leaking upstream headers', async () => {
 const w=await worker();let count=0;
 const r=await w.fetch(new Request('https://pages.example/relay/health'),{PAIRING:{async fetch(){count++;return new Response(null,{status:302,headers:{location:'https://evil.example'}});}}},{},()=>{throw Error('public fetch must not run');});
 assert.equal(count,1);assert.equal(r.status,502);assert.equal(r.headers.get('location'),null);
});
