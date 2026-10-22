const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppExit } = require('../electron/app-exit');
function fixture() {
  const app = new EventEmitter(), win = new EventEmitter(); let stopped = 0, saved = 0, destroyed = 0, quits = 0, errors = 0, prompt = { response: 0, checkboxChecked: false };
  const store = { state: { notificationOutbox: [{ id: 'pending' }], commandReplies: [{ id: 'reply' }], accounts: [{ password: 'keep', alertHistory: { level: 3 } }] }, update(fn) { fn(this.state); }, save() { saved++; } };
  const exit = new AppExit({ app, monitor: { stop() { stopped++; } }, updater: { stop() {} }, store, windows: () => [win, { isDestroyed: () => false, destroy() { destroyed++; } }], confirm: () => prompt, error: () => { errors++; } });
  app.quit = () => { quits++; app.emit('before-quit', { preventDefault() {} }); };
  exit.attach(win);
  const close = () => { let prevented = false; win.emit('close', { preventDefault() { prevented = true; } }); return prevented; };
  return { app, win, store, exit, close, prompt: value => { prompt = value; }, stats: () => ({ stopped, saved, destroyed, quits, errors }) };
}
test('main close saves protected state, destroys hidden windows, and quits once; minimizing does not stop', () => {
  const s = fixture(); const before = structuredClone(s.store.state); s.win.emit('minimize'); assert.equal(s.stats().stopped, 0);
  assert.equal(s.close(), true); assert.equal(s.exit.quitting, true);
  assert.deepEqual(s.stats(), { stopped: 1, saved: 1, destroyed: 1, quits: 1, errors: 0 }); assert.deepEqual(s.store.state, before);
  assert.equal(s.close(), false);
});
test('cancelled confirmation leaves monitoring running; opt-out persists only after confirmation', () => {
  const s = fixture(); s.prompt({ response: 1, checkboxChecked: true }); s.close(); assert.equal(s.stats().stopped, 0); assert.equal(s.store.state.appPreferences, undefined);
  s.prompt({ response: 0, checkboxChecked: true }); s.close(); assert.equal(s.store.state.appPreferences.skipExitConfirmation, true);
});
test('save failure stops monitoring but cancels process exit instead of discarding state', () => {
  const s = fixture(); s.store.save = () => { throw Error('disk'); }; s.close();
  assert.equal(s.stats().stopped, 1); assert.equal(s.stats().quits, 0); assert.equal(s.stats().errors, 1); assert.equal(s.exit.quitting, false);
});
test('explicit app quit performs the same shutdown without a main window close', () => {
  const s = fixture(); let prevented = false;
  s.app.emit('before-quit', { preventDefault() { prevented = true; } }); assert.equal(prevented, false); assert.equal(s.stats().destroyed, 1); assert.equal(s.stats().saved, 1);
});
