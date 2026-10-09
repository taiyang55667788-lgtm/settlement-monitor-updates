const assert = require('node:assert/strict');
const http = require('node:http');
const { app, session } = require('electron');
const { PairingNetwork } = require('../electron/pairing-network');
const deadline = setTimeout(() => app.exit(1), 25000);

app.whenReady().then(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, ready: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const site = session.fromPartition('network-smoke-site');
    await site.setProxy({ mode: 'direct' });
    const network = new PairingNetwork(origin, name => {
      const ses = session.fromPartition(`smoke-${name}`);
      return {
        setProxy: config => ses.setProxy(config.mode === 'system'
          ? { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' }
          : config),
        forceReloadProxyConfig: () => ses.forceReloadProxyConfig(),
        resolveProxy: url => ses.resolveProxy(url),
        fetch: (...args) => ses.fetch(...args),
      };
    });
    const result = await network.diagnose();
    assert.equal(result.direct.ok, true);
    assert.equal(result.system.ok, false);
    assert.equal(result.route, 'direct');
    assert.equal(await site.resolveProxy(origin), 'DIRECT');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(req => req.url === '/health' && !req.authorization));
    await network.fetch(`${origin}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer fixture-only' } });
    assert.equal(requests.filter(req => req.url === '/v1/messages').length, 1);
    console.log('Notification network Electron smoke passed: direct/system isolation, dead proxy detection, credential-free probe');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(deadline);
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
