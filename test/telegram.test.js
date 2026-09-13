const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../electron/monitor');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createService(fetch, saved = { botToken: 'saved-token', chatId: 'saved-chat' }, resolveProxy = async () => 'DIRECT') {
  const events = [];
  const store = {
    state: { telegram: saved, accounts: [] },
    addEvent: (...args) => events.push(args),
  };
  return {
    events,
    service: new MonitorService(store, () => {}, { fetch, resolveProxy }),
  };
}

test('Telegram test uses the values currently entered in the form', async () => {
  const requests = [];
  const { service, events } = createService(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  });

  await service.testTelegram({ botToken: 'current-token', chatId: 'current-chat' });

  assert.match(requests[0].url, /botcurrent-token\/sendMessage$/);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    chat_id: 'current-chat',
    text: '✅ 交收监控：Telegram 通知测试成功',
  });
  assert.equal(events[0][1], 'Telegram 测试消息已发送');
});

test('Chat ID discovery returns the latest chat from Telegram updates', async () => {
  let requestedUrl = '';
  const { service } = createService(async (url) => {
    requestedUrl = url;
    return jsonResponse({
      ok: true,
      result: [{ update_id: 2, channel_post: { chat: { id: -202 } } }],
    });
  });

  assert.equal(await service.discoverTelegramChatId('current-token'), '-202');
  assert.match(requestedUrl, /getUpdates\?offset=-1&limit=1&timeout=0$/);
});

test('Telegram network errors explain whether the Windows system proxy is active', async () => {
  const { service } = createService(
    async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); },
    undefined,
    async () => 'PROXY 127.0.0.1:7890',
  );

  await assert.rejects(
    service.discoverTelegramChatId('current-token'),
    /已使用 Windows 系统代理（PROXY 127\.0\.0\.1:7890）.*ETIMEDOUT/,
  );
});

test('Telegram API errors retain the useful description', async () => {
  const { service } = createService(async () => jsonResponse({ ok: false, description: 'Bad Request: chat not found' }, 400));

  await assert.rejects(
    service.testTelegram({ botToken: 'current-token', chatId: 'wrong-chat' }),
    /Telegram 请求失败（400）：Bad Request: chat not found/,
  );
});

test('amount alerts describe the from-zero interval and crossed levels', async () => {
  let message = '';
  const { service } = createService(async (_url, init) => {
    message = JSON.parse(init.body).text;
    return jsonResponse({ ok: true, result: { message_id: 2 } });
  });

  await service.sendTelegram({ name: 'main-account' }, 350, 3, 1, 'subagent-a', 100);

  assert.match(message, /当前档位：\+300（从 0 起）/);
  assert.match(message, /提醒间隔：每 100 一档/);
  assert.match(message, /上次档位：\+100/);
  assert.match(message, /本次跨越：2 个档位/);
});
