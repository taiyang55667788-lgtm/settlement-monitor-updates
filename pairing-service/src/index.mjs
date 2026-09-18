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
  if (message?.chat?.type !== 'private' || !chatId) return json({ ok: true });
  const code = String(message.text || '').trim().match(/^(?:\/start(?:@[A-Za-z0-9_]+)?\s+)?([A-HJ-NP-Z2-9]{10})$/i)?.[1]?.toUpperCase();
  if (!code) return json({ ok: true });
  const codeHash = await sha256(code);
  const candidate = await env.DB.prepare('SELECT id FROM pairings WHERE code_hash = ? AND chat_id IS NULL AND expires_at > ?')
    .bind(codeHash, Date.now()).first();
  if (!candidate) return json({ ok: true });
  await env.DB.prepare('INSERT OR IGNORE INTO bot_owner (id, chat_id) VALUES (1, ?)').bind(String(chatId)).run();
  const owner = await env.DB.prepare('SELECT chat_id FROM bot_owner WHERE id = 1').bind().first();
  if (owner?.chat_id !== String(chatId)) {
    ctx.waitUntil(sendBotMessage(env, fetcher, chatId, '此机器人已绑定其他 Telegram 用户，无法配对。').catch(() => {}));
    return json({ ok: true });
  }
  const result = await env.DB.prepare('UPDATE pairings SET chat_id = ?, paired_at = ?, code_hash = NULL WHERE code_hash = ? AND chat_id IS NULL AND expires_at > ?')
    .bind(String(chatId), Date.now(), codeHash, Date.now()).run();
  if (result.meta.changes === 1) {
    ctx.waitUntil(sendBotMessage(env, fetcher, chatId, '✅ 交收监控已配对。现在可以回到电脑查看状态。').catch(() => {}));
  }
  return json({ ok: true });
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
