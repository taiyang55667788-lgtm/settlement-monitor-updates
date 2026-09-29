const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_MINUTE = 30;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function randomCode(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求内容为空');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('请求内容过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('请求内容不是有效 JSON');
  }
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function telegramCommand(text) {
  const match = String(text || '').trim().match(/^\/([^\s@]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/u);
  if (!match) return null;
  const name = match[1].toLowerCase(); const argument = String(match[2] || '').trim();
  if (['report', 'status', '报表', '状态'].includes(name)) return { type: 'report' };
  if (name === 'top') return { type: 'top' };
  if (name === 'alerts') return { type: 'alerts' };
  if (name === 'check') return { type: 'check', argument };
  if (name === 'help') return { type: 'help' };
  return null;
}

function pairingCode(text) {
  const match = String(text || '').trim().match(/^(?:(?:\/start|\/pair)(?:@[A-Za-z0-9_]+)?\s+)?([A-HJ-NP-Z2-9]{10})$/i);
  return match?.[1]?.toUpperCase() || '';
}

function groupPairingCommand(text) {
  return /^\/pair(?:@[A-Za-z0-9_]+)?\s+[A-HJ-NP-Z2-9]{10}$/i.test(String(text || '').trim());
}

function supportedChat(chat) {
  return Boolean(chat?.id) && ['private', 'group', 'supergroup'].includes(chat.type);
}

async function groupAdmin(message, env, fetcher) {
  if (!message?.from?.id) return false;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: message.chat.id, user_id: message.from.id }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    return Boolean(response.ok && payload?.ok && ['administrator', 'creator', 'owner'].includes(payload.result?.status));
  } catch {
    return false;
  }
}

async function authorizedDevice(request, env) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f-]{36})\.([0-9a-f]{64})$/i);
  if (!bearer) return null;
  const row = await env.DB.prepare('SELECT id, chat_id, sent_bucket, sent_count FROM pairings WHERE id = ? AND auth_hash = ?')
    .bind(bearer[1], await sha256(bearer[2])).first();
  return row || null;
}

async function sendBotMessage(env, fetcher, chatId, message) {
  const response = await fetcher(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram 发送失败（${response.status}）`);
  }
}

async function ensureWebhook(request, env, fetcher) {
  const response = await fetcher(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${new URL(request.url).origin}/v1/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error('Telegram webhook 配置失败');
}

async function startPairing(request, env, fetcher) {
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.BOT_USERNAME) return json({ error: '配对服务尚未配置完成' }, 503);
  await ensureWebhook(request, env, fetcher);
  const id = crypto.randomUUID();
  const secret = randomSecret();
  const now = Date.now();
  await env.DB.prepare('DELETE FROM pairings WHERE chat_id IS NULL AND expires_at < ?').bind(now).run();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = randomCode();
    try {
      await env.DB.prepare('INSERT INTO pairings (id, auth_hash, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, await sha256(secret), await sha256(code), now + PAIRING_LIFETIME_MS, now).run();
      return json({ token: `${id}.${secret}`, code, expiresAt: now + PAIRING_LIFETIME_MS, botUsername: env.BOT_USERNAME });
    } catch (error) {
      if (!String(error?.message || '').includes('UNIQUE')) throw error;
    }
  }
  return json({ error: '暂时无法生成配对码，请重试' }, 503);
}

async function receiveWebhook(request, env, ctx, fetcher) {
  if (!env.WEBHOOK_SECRET || !constantTimeEqual(request.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) {
    return json({ error: '未授权' }, 401);
  }
  const update = await readJson(request);
  const message = update?.message;
  const chatId = message?.chat?.id;
  if (!supportedChat(message?.chat) || !chatId) return json({ ok: true });
  const text = String(message.text || '').trim();
  const isGroup = message.chat.type !== 'private';
  const code = pairingCode(text);
  if (code) {
    if (isGroup && !groupPairingCommand(text)) return json({ ok: true });
    if (isGroup && !await groupAdmin(message, env, fetcher)) {
      ctx.waitUntil(sendBotMessage(env, fetcher, chatId, '只有群管理员可以配对。请将机器人设为群管理员后，由群管理员发送：/pair 配对码').catch(() => {}));
      return json({ ok: true });
    }
    const codeHash = await sha256(code);
    const candidate = await env.DB.prepare('SELECT id FROM pairings WHERE code_hash = ? AND chat_id IS NULL AND expires_at > ?')
      .bind(codeHash, Date.now()).first();
    if (!candidate) return json({ ok: true });
    const result = await env.DB.prepare('UPDATE pairings SET chat_id = ?, paired_at = ?, code_hash = NULL WHERE code_hash = ? AND chat_id IS NULL AND expires_at > ?')
      .bind(String(chatId), Date.now(), codeHash, Date.now()).run();
    if (result.meta.changes === 1) {
      const target = isGroup ? '本群' : '此私聊';
      const commandHint = isGroup ? '群管理员可使用 /report、/top、/alerts 或 /check。' : '现在可以回到电脑查看状态。';
      ctx.waitUntil(sendBotMessage(env, fetcher, chatId, `✅ 交收监控已配对到${target}。${commandHint}`).catch(() => {}));
    }
    return json({ ok: true });
  }
  const command = telegramCommand(text);
  if (command) {
    if (isGroup && !await groupAdmin(message, env, fetcher)) {
      ctx.waitUntil(sendBotMessage(env, fetcher, chatId, '只有群管理员可以执行交收监控指令。').catch(() => {}));
      return json({ ok: true });
    }
    if (command.type === 'help') {
      ctx.waitUntil(sendBotMessage(env, fetcher, chatId, '🤖 交收监控指令\n/report 或 /status：刷新并返回当前报表\n/top：返回当前金额绝对值前 10 名\n/alerts：返回最近 10 条提醒\n/check：刷新全部启用账号\n/check 账号名：刷新指定账号\n群聊中仅群管理员可执行指令。').catch(() => {}));
      return json({ ok: true });
    }
    const devices = await env.DB.prepare('SELECT id FROM pairings WHERE chat_id = ?').bind(String(chatId)).all();
    for (const device of devices.results || []) {
      await env.DB.prepare('INSERT INTO commands (id, device_id, command, created_at) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), device.id, JSON.stringify(command), Date.now()).run();
    }
    const labels = { report: '报表查询', top: '排行查询', alerts: '提醒记录查询', check: '刷新请求' };
    ctx.waitUntil(sendBotMessage(env, fetcher, chatId, devices.results?.length ? `📊 已收到${labels[command.type]}，正在向在线电脑请求最新数据。` : '当前没有已配对电脑。').catch(() => {}));
    return json({ ok: true });
  }
  return json({ ok: true });
}

async function nextCommand(env, device) {
  const command = await env.DB.prepare('SELECT id, command FROM commands WHERE device_id = ? ORDER BY created_at ASC LIMIT 1').bind(device.id).first();
  if (!command) return json({ command: null });
  await env.DB.prepare('DELETE FROM commands WHERE id = ?').bind(command.id).run();
  try { return json({ command: JSON.parse(command.command) }); } catch { return json({ command: { type: command.command } }); }
}

async function sendFromDevice(request, env, fetcher, device, testOnly) {
  if (!device.chat_id) return json({ error: '请先完成 Telegram 配对' }, 409);
  const body = testOnly ? {} : await readJson(request);
  const message = testOnly ? '✅ 交收监控：Telegram 通知测试成功' : String(body?.text || '').trim();
  if (!message || message.length > 3500) return json({ error: '消息内容必须为 1–3500 个字符' }, 400);
  const bucket = Math.floor(Date.now() / 60000);
  const limit = await env.DB.prepare('UPDATE pairings SET sent_bucket = ?, sent_count = CASE WHEN sent_bucket = ? THEN sent_count + 1 ELSE 1 END WHERE id = ? AND (sent_bucket IS NULL OR sent_bucket != ? OR sent_count < ?)')
    .bind(bucket, bucket, device.id, bucket, MAX_MESSAGES_PER_MINUTE).run();
  if (limit.meta.changes !== 1) return json({ error: '发送过于频繁，请稍后重试' }, 429);
  await sendBotMessage(env, fetcher, device.chat_id, message);
  return json({ ok: true });
}

export async function handleRequest(request, env, ctx, fetcher = fetch) {
  try {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      return json({ ok: true, ready: Boolean(env.DB && env.BOT_TOKEN && env.WEBHOOK_SECRET && env.BOT_USERNAME), botUsername: env.BOT_USERNAME || null });
    }
    if (!env.DB) return json({ error: '配对数据库尚未配置' }, 503);
    if (request.method === 'POST' && pathname === '/v1/pairings') return await startPairing(request, env, fetcher);
    if (request.method === 'POST' && pathname === '/v1/telegram/webhook') return await receiveWebhook(request, env, ctx, fetcher);
    const device = await authorizedDevice(request, env);
    if (!device) return json({ error: '配对凭据无效，请重新配对' }, 401);
    if (request.method === 'GET' && pathname === '/v1/pairings/status') return json({ paired: Boolean(device.chat_id) });
    if (request.method === 'DELETE' && pathname === '/v1/pairings') {
      await env.DB.prepare('DELETE FROM pairings WHERE id = ?').bind(device.id).run();
      return json({ ok: true });
    }
    if (request.method === 'GET' && pathname === '/v1/commands/next') return await nextCommand(env, device);
    if (request.method === 'POST' && pathname === '/v1/messages/test') return await sendFromDevice(request, env, fetcher, device, true);
    if (request.method === 'POST' && pathname === '/v1/messages') return await sendFromDevice(request, env, fetcher, device, false);
    return json({ error: '未找到接口' }, 404);
  } catch (error) {
    if (error?.message === 'Telegram webhook 配置失败') {
      return json({ error: 'Telegram 机器人配置失败，请检查 Bot Token' }, 502);
    }
    if (error?.message === '请求内容为空' || error?.message === '请求内容过大' || error?.message === '请求内容不是有效 JSON') {
      return json({ error: error.message }, 400);
    }
    console.error('Pairing service request failed', { message: error?.message || String(error) });
    return json({ error: '配对服务暂时不可用，请稍后重试' }, 503);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
