const test = require('node:test');
const assert = require('node:assert/strict');
const { PairingNetwork } = require('../electron/pairing-network');

function fixture(fails = []) {
  const calls = [];
  const network = new PairingNetwork('https://relay.example', name => {
    const mode = name.endsWith('-direct') ? 'direct' : 'system';
    return {
      async setProxy(config) { calls.push(['proxy', mode, config.mode]); },
      async forceReloadProxyConfig() {},
      async resolveProxy() { return mode === 'system' ? 'PROXY 127.0.0.1:7890' : 'DIRECT'; },
      async fetch(url, init) {
        calls.push(['fetch', mode, url, init]);
        if (fails.includes(mode)) throw Object.assign(new Error('secret token URL'), { code: 'ERR_PROXY_CONNECTION_FAILED' });
        return Response.json({ ok: true, ready: true });
      },
    };
  });
  return { network, calls };
}

test('fallback is health-selected before sending and old device credentials remain unchanged', async () => {
  const calls=[];
  const network=new PairingNetwork('https://primary.example', () => ({
    async setProxy(){},async forceReloadProxyConfig(){},async resolveProxy(){return 'DIRECT';},
    async fetch(url,init){calls.push([url,init]);if(url.startsWith('https://primary.example'))throw Error('offline');return Response.json({ok:true,ready:true});}
  }), ['https://backup.example']);
  await network.fetch('https://primary.example/v1/messages',{method:'POST',headers:{authorization:'Bearer unchanged'},body:'{}'});
  const sends=calls.filter(c=>c[0].endsWith('/v1/messages'));
  assert.equal(sends.length,1);assert.equal(sends[0][0],'https://backup.example/v1/messages');
  assert.equal(sends[0][1].headers.authorization,'Bearer unchanged');
  assert.equal(network.lastDiagnosis.endpoint,'fallback');
});

test('notification sessions are isolated and health probes carry no device credentials', async () => {
  const { network, calls } = fixture(['system']);
  const result = await network.diagnose();
  assert.equal(result.direct.ok, true);
  assert.equal(result.system.ok, false);
  assert.equal(result.route, 'direct');
  assert.ok(!result.message.includes('127.0.0.1'));
  assert.ok(!result.message.includes('secret'));
  for (const call of calls.filter(c => c[0] === 'fetch')) {
    assert.equal(call[2], 'https://relay.example/health');
    assert.equal(call[3].headers, undefined);
    assert.equal(call[3].credentials, 'omit');
  }
});

test('ambiguous failed send is not replayed; healthy direct route is used on the next request', async () => {
  const { network, calls } = fixture(['system']);
  const init = { method: 'POST', headers: { authorization: 'Bearer private-token' }, body: '{}' };
  await assert.rejects(network.fetch('https://relay.example/v1/messages', init), /原请求未立即重发/);
  assert.equal(calls.filter(c => c[2]?.endsWith('/v1/messages')).length, 1);
  await network.fetch('https://relay.example/v1/messages', init);
  assert.equal(calls.filter(c => c[2]?.endsWith('/v1/messages')).at(-1)[1], 'direct');
});

test('proxy-only reachability stays on system route and both-failed probe never claims direct availability', async () => {
  const { network } = fixture(['direct']);
  assert.equal((await network.diagnose()).route, 'system');
  const result = await fixture(['direct', 'system']).network.diagnose();
  assert.equal(result.direct.ok, false);
  assert.equal(result.system.ok, false);
  assert.match(result.message, /两条线路均失败/);
});

test('network codes embedded by Chromium are retained without exposing URLs or tokens', async () => {
  const network = new PairingNetwork('https://relay.example', () => ({
    async setProxy() {}, async forceReloadProxyConfig() {}, async resolveProxy() { return 'DIRECT'; },
    async fetch() { throw Error('net::ERR_CONNECTION_RESET https://secret.example/?token=private'); },
  }));
  const result = await network.diagnose();
  assert.equal(result.direct.code, 'ERR_CONNECTION_RESET');
  assert.equal(result.available, false);
  assert.equal(result.candidates.length, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('secret.example'));
});

test('an outage is re-probed and switches to the healthy backup without replaying the failed request', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12) });
  let primaryOffline = false; const sends = [];
  const network = new PairingNetwork('https://primary.example', () => ({
    async setProxy() {}, async forceReloadProxyConfig() {}, async resolveProxy() { return 'DIRECT'; },
    async fetch(url) {
      if (url.endsWith('/v1/messages')) sends.push(url);
      if (primaryOffline && url.startsWith('https://primary.example')) throw Error('net::ERR_CONNECTION_RESET');
      return Response.json({ ok: true, ready: true });
    },
  }), ['https://backup.example']);
  await network.fetch('https://primary.example/v1/messages', { method: 'POST' });
  primaryOffline = true; t.mock.timers.tick(15000);
  await assert.rejects(network.fetch('https://primary.example/v1/messages', { method: 'POST' }), /原请求未立即重发/);
  assert.equal(sends.length, 2);
  assert.equal(network.lastFailure.code, 'ERR_CONNECTION_RESET');
  assert.equal(network.lastDiagnosis.candidates.length, 2);
  await network.fetch('https://primary.example/v1/messages', { method: 'POST' });
  assert.equal(sends.at(-1), 'https://backup.example/v1/messages');
  assert.equal(network.lastDiagnosis.endpoint, 'fallback');
});
