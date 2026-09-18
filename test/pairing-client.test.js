const test = require('node:test');
const assert = require('node:assert/strict');
const { PairingClient } = require('../electron/pairing');

test('desktop sends only its random device token and alert text to the pairing service', async () => {
  const requests = [];
  const client = new PairingClient('https://pair.example/', {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ ok: true });
    },
  });
  await client.send('device-token', '提醒文字');
  assert.equal(requests[0].url, 'https://pair.example/v1/messages');
  assert.equal(requests[0].init.headers.authorization, 'Bearer device-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: '提醒文字' });
});

test('unconfigured service never claims pairing is available', async () => {
  const client = new PairingClient('');
  assert.equal(client.enabled, false);
  await assert.rejects(client.start(), /配对服务正在准备中/);
});
