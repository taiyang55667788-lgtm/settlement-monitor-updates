const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandReplies } = require('../electron/command-replies');
const id = '11111111-2222-4333-8444-555555555555';
function setup() {
  const store = { state: { telegram: { mode: 'pairing', pairing: { paired: true, token: 'one' } } }, update(fn) { const draft = structuredClone(this.state); fn(draft); this.state = draft; } };
  const sends = [], acks = [];
  const client = { async send(token, text, options) { sends.push({ token, text, options }); return { notificationId: options.notificationId }; }, async ackCommand(...args) { acks.push(args); return { ok: true }; } };
  return { store, client, sends, acks, work: new CommandReplies(store, client) };
}
test('frozen reply survives restart and lost ack without resending or refreshing', async () => {
  const s = setup(); s.work.prepare(id, 'original', { inline_keyboard: [] });
  let fail = true;
  s.client.ackCommand = async () => { if (fail) throw Error('offline'); };
  await assert.rejects(s.work.resume('one'));
  assert.equal(s.sends.length, 1); assert.equal(s.work.current().stage, 'sent');
  fail = false;
  await new CommandReplies(s.store, s.client).resume('one');
  assert.equal(s.sends.length, 1); assert.equal(s.work.current(), undefined);
});
test('lost send receipt retries the same id and frozen content after restart', async () => {
  const s = setup(); s.work.prepare(id, 'original');
  s.client.send = async (token, text, options) => { s.sends.push({ text, options }); if (s.sends.length === 1) throw Error('lost'); return { notificationId: options.notificationId }; };
  await assert.rejects(s.work.resume('one'));
  const next = new CommandReplies(s.store, s.client); next.prepare(id, 'changed'); await next.resume('one');
  assert.equal(s.sends[0].text, s.sends[1].text); assert.deepEqual(s.sends[0].options, s.sends[1].options);
});
test('uncertain reply requires explicit resend or cancel and never auto-replays', async () => {
  const s = setup(); s.work.prepare(id, 'original');
  s.client.send = async () => { throw Error('[SEND_UNCERTAIN]'); };
  await assert.rejects(s.work.resume('one'), error => error.code === 'COMMAND_CONFIRMATION_REQUIRED');
  await assert.rejects(s.work.resume('one'), error => error.code === 'COMMAND_CONFIRMATION_REQUIRED');
  s.work.manage('resend'); assert.notEqual(s.work.current().replyId, id);
  s.client.send = async (_, __, options) => ({ notificationId: options.notificationId }); await s.work.resume('one');
  assert.equal(s.acks.length, 1);
  s.work.prepare(id, 'cancel'); s.work.update(s.work.current(), item => { item.confirmationRequired = true; });
  s.work.manage('cancel'); await s.work.resume('one'); assert.equal(s.acks.at(-1)[3], true);
});
test('recipient changes hold replies and journal stays bounded', async () => {
  const s = setup(); s.work.prepare(id, 'first');
  s.store.state.telegram.pairing.token = 'two'; assert.equal(await s.work.resume('two'), false);
  s.store.state.telegram.pairing.token = 'one'; await assert.rejects(s.work.resume('wrong'), /凭据/);
  for (let i = 2; i <= 10; i++) { s.store.state.telegram.pairing.token = String(i); s.work.prepare(id, 'held'); }
  s.store.state.telegram.pairing.token = 'eleven'; assert.throws(() => s.work.prepare(id, 'full'), /上限/);
  assert.equal(s.store.state.commandReplies.length, 10); assert.equal(s.sends.length, 0);
});
