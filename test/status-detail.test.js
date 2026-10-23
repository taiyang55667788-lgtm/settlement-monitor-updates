const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionReason, telegramFault, finishDrawRead } = require('../electron/status-detail');

test('session reasons distinguish evidence from unknown or network failures', () => {
  assert.match(sessionReason(new Error('账号在其他地方登录')), /异地登录/);
  assert.match(sessionReason({ code: 'SESSION_EXPIRED' }), /无法确认/);
  assert.match(sessionReason(new Error('读取超时')), /不等同掉线/);
  assert.match(sessionReason(new Error('表头错误')), /原因未确认/);
});
test('Telegram errors distinguish timeout, upstream, rejection and uncertain delivery', () => {
  assert.match(telegramFault({ status: 502 }), /上游服务异常/);
  assert.match(telegramFault(new Error('Telegram 发送失败（429）')), /拒绝请求/);
  assert.match(telegramFault({ code: 'TimeoutError' }), /超时/);
  assert.match(telegramFault(new Error('[SEND_UNCERTAIN]')), /待确认/);
  assert.match(telegramFault(new Error('fetch failed')), /未取得明确响应/);
});
test('draw completion updates terminal state without overwriting a newer draw or fallback', () => {
  for (const [status, expected] of [['ok', '读取完成'], ['triggered', '读取完成'], ['partial', '部分读取完成'], ['error', '读取失败'], ['manual', '人工处理']]) {
    const state = { status, drawTrigger: { enabled: true, state: '已检测开奖，正在读取', latestDraw: '123' } };
    finishDrawRead(state); assert.ok(state.drawTrigger.state.includes(expected)); assert.equal(state.drawTrigger.latestDraw, '123');
  }
  for (const drawTrigger of [{ enabled: true, state: '等待开奖延迟', nextReadAt: 'new' }, { enabled: true, state: '已检测开奖，正在读取', nextReadAt: 'new' }, { enabled: false, state: '固定间隔' }]) {
    const original = structuredClone(drawTrigger); finishDrawRead({ status: 'ok', drawTrigger }); assert.deepEqual(drawTrigger, original);
  }
});
