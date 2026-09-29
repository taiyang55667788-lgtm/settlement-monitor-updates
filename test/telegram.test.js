const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../electron/monitor');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createService(fetch, saved = { botToken: 'saved-token', chatId: 'saved-chat', mode: 'legacy' }, resolveProxy = async () => 'DIRECT') {
  const events = [];
  const store = {
    state: { telegram: saved, accounts: [] },
    update(change) { change(this.state); },
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

test('amount alerts show inline remarks and previous tier without redundant fields', async () => {
  let message = '';
  const { service } = createService(async (_url, init) => {
    message = JSON.parse(init.body).text;
    return jsonResponse({ ok: true, result: { message_id: 2 } });
  });

  const period = { start: '2026-09-14', end: '2026-09-20' };
  await service.sendTelegram({ name: 'main-account' }, 350, 3, 1, 'subagent-a', 100, '独霸', ['parent', 'subagent-a'], period);
  await service.outbox.flush();

  assert.match(message, /代理层级：parent \/ subagent-a（独霸）/);
  assert.match(message, /🔵 本周应收下线提醒/);
  assert.match(message, /🔵 本周应收下线：\+350\.00/);
  assert.match(message, /提醒间隔：每 100 一档/);
  assert.match(message, /上一次档位：\+100/);
  assert.match(message, /本次跨越：\+200 至 \+300，共 2 档/);
  assert.doesNotMatch(message, /报表区间|当前档位|上次确认档位|备注：/);
  assert.match(message, /通知编号：/);
  assert.match(message, /时间：/);
  const record = service.store.state.alertRecords.at(-1);
  assert.deepEqual(record.period, period);
  assert.equal(record.level, 3);
  assert.equal(record.previousLevel, 1);
  assert.equal(record.remark, '独霸');
});

test('negative receivable-downline uses red marker and migration summary label', async () => {
  let message = '';
  const { service } = createService(async (_url, init) => {
    message = JSON.parse(init.body).text;
    return jsonResponse({ ok: true, result: { message_id: 3 } });
  });
  await service.sendTelegram({ name: 'main-account' }, -350, -3, 0, 'subagent-a', 100, '', ['subagent-a'],
    { start: '2026-09-14', end: '2026-09-20' }, { initialSummary: true });
  await service.outbox.flush();
  assert.match(message, /🔴 本周应收下线提醒（首次读取汇总）/);
  assert.match(message, /🔴 本周应收下线：-350\.00/);
  assert.match(message, /共 3 档（已合并为一条消息）/);
  assert.match(message, /上一次档位：无（首次提醒）/);
  assert.match(message, /^代理层级：subagent-a$/m);
  assert.doesNotMatch(message, /报表区间|当前档位|备注：|（）/);
});

test('downward returns display the previous negative tier', async () => {
  let message = '';
  const { service } = createService(async (_url, init) => {
    message = JSON.parse(init.body).text;
    return jsonResponse({ ok: true, result: { message_id: 5 } });
  });
  await service.sendTelegram({ name: 'main-account' }, -350000, -1, -2, 'agent', 300000, '喜力', ['agent'],
    { start: '2026-09-14', end: '2026-09-20' });
  await service.outbox.flush();
  assert.match(message, /代理层级：agent（喜力）/);
  assert.match(message, /上一次档位：-600,000/);
  assert.match(message, /本周应收下线：-350,000\.00/);
  assert.doesNotMatch(message, /报表区间|当前档位|备注：/);
});

test('general-agent detail alerts use only the general-agent result label', async () => {
  let message = '';
  const { service } = createService(async (_url, init) => {
    message = JSON.parse(init.body).text;
    return jsonResponse({ ok: true, result: { message_id: 4 } });
  });
  await service.sendTelegram({ name: 'main-account', systemType: 'crown', crownLoginEntry: 'login-1' }, 250, 2, 0, 'general-a', 100, '总代理备注', ['general-a'],
    { start: '2026-09-14', end: '2026-09-20' });
  await service.outbox.flush();
  assert.match(message, /🔵 总代理结果提醒/);
  assert.match(message, /总代理：general-a（总代理备注）/);
  assert.match(message, /🔵 总代理结果：\+250\.00/);
  assert.doesNotMatch(message, /实货量/);
});
