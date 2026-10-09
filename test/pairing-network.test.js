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
