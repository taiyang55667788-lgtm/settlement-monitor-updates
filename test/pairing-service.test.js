const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function service({ webhookFails = false } = {}) {
  const { handleRequest } = await import('../pairing-service/src/index.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'pairing-service', 'schema.sql'), 'utf8'));
  const binding = {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = db.prepare(sql);
          return {
            first: async () => statement.get(...args) || null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } }),
          };
        },
      };
    },
  };
  const sent = [];
  const webhookCalls = [];
  const pending = [];
  const env = { DB: binding, BOT_TOKEN: 'server-only-token', WEBHOOK_SECRET: 'webhook-secret', BOT_USERNAME: 'SampleMonitorBot' };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const fetcher = async (url, init) => {
    if (url.endsWith('/setWebhook')) {
      webhookCalls.push(JSON.parse(init.body));
      if (webhookFails) return Response.json({ ok: false }, { status: 401 });
      return Response.json({ ok: true, result: true });
    }
    sent.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  const call = (method, pathname, { token, body, webhookSecret } = {}) => handleRequest(new Request(`https://worker.example${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(webhookSecret ? { 'x-telegram-bot-api-secret-token': webhookSecret } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx, fetcher);
  return { db, env, sent, webhookCalls, pending, call };
}

test('one-time code pairs a private Telegram chat and allows authenticated test delivery', async () => {
  const { call, sent, webhookCalls, pending } = await service();
  const created = await (await call('POST', '/v1/pairings')).json();
  assert.deepEqual(webhookCalls, [{
    url: 'https://worker.example/v1/telegram/webhook',
    secret_token: 'webhook-secret',
    allowed_updates: ['message'],
  }]);
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.match(created.token, /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  assert.equal(created.botUsername, 'SampleMonitorBot');
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: created.token })).json(), { paired: false });

  const webhook = await call('POST', '/v1/telegram/webhook', {
    webhookSecret: 'webhook-secret',
    body: { message: { chat: { id: 12345, type: 'private' }, text: `/start ${created.code}` } },
  });
  assert.equal(webhook.status, 200);
  await Promise.all(pending);
  assert.match(sent[0].text, /已配对/);
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: created.token })).json(), { paired: true });

  const testResponse = await call('POST', '/v1/messages/test', { token: created.token });
  assert.equal(testResponse.status, 200);
  assert.equal(sent[1].chat_id, '12345');
  assert.match(sent[1].text, /通知测试成功/);
  assert.equal((await call('POST', '/v1/messages/test', { token: `${created.token}wrong` })).status, 401);
});

test('does not create a pairing code when Telegram rejects webhook setup', async () => {
  const { call, db } = await service({ webhookFails: true });
  const response = await call('POST', '/v1/pairings');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Bot Token/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairings').get().count, 0);
});

test('webhook rejects wrong secret, group chats, and reused codes', async () => {
  const { call, sent, pending } = await service();
  const { code, token } = await (await call('POST', '/v1/pairings')).json();
  const body = { message: { chat: { id: -900, type: 'group' }, text: code } };
  assert.equal((await call('POST', '/v1/telegram/webhook', { webhookSecret: 'wrong', body })).status, 401);
  assert.equal((await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body })).status, 200);
  assert.equal(sent.length, 0);
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token })).json(), { paired: false });

  body.message.chat = { id: 900, type: 'private' };
  await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body });
  await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body });
  await Promise.all(pending);
  assert.equal(sent.filter((message) => /已配对/.test(message.text)).length, 1);
});

test('expired pairing code cannot bind, and unlink revokes a device', async () => {
  const { call, db, pending } = await service();
  const first = await (await call('POST', '/v1/pairings')).json();
  db.exec('UPDATE pairings SET expires_at = 0');
  await call('POST', '/v1/telegram/webhook', {
    webhookSecret: 'webhook-secret',
    body: { message: { chat: { id: 10, type: 'private' }, text: first.code } },
  });
  await Promise.all(pending);
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: first.token })).json(), { paired: false });
  assert.equal((await call('DELETE', '/v1/pairings', { token: first.token })).status, 200);
  assert.equal((await call('GET', '/v1/pairings/status', { token: first.token })).status, 401);
});

test('the first private Telegram chat becomes the owner for every computer', async () => {
  const { call, pending } = await service();
  const first = await (await call('POST', '/v1/pairings')).json();
  const second = await (await call('POST', '/v1/pairings')).json();
  const third = await (await call('POST', '/v1/pairings')).json();
  for (const [code, chatId] of [[first.code, 101], [second.code, 202], [third.code, 101]]) {
    await call('POST', '/v1/telegram/webhook', {
      webhookSecret: 'webhook-secret',
      body: { message: { chat: { id: chatId, type: 'private' }, text: code } },
    });
  }
  await Promise.all(pending);
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: first.token })).json(), { paired: true });
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: second.token })).json(), { paired: false });
  assert.deepEqual(await (await call('GET', '/v1/pairings/status', { token: third.token })).json(), { paired: true });
});

test('only the bot owner can queue a report command for paired computers', async () => {
  const { call, pending } = await service();
  const created = await (await call('POST', '/v1/pairings')).json();
  await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body: { message: { chat: { id: 101, type: 'private' }, text: created.code } } });
  await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body: { message: { chat: { id: 202, type: 'private' }, text: '/report' } } });
  assert.deepEqual(await (await call('GET', '/v1/commands/next', { token: created.token })).json(), { command: null });
  await call('POST', '/v1/telegram/webhook', { webhookSecret: 'webhook-secret', body: { message: { chat: { id: 101, type: 'private' }, text: '/报表' } } });
  assert.deepEqual(await (await call('GET', '/v1/commands/next', { token: created.token })).json(), { command: 'report' });
  assert.deepEqual(await (await call('GET', '/v1/commands/next', { token: created.token })).json(), { command: null });
  await Promise.all(pending);
});
