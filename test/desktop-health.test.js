const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DesktopHealth, retainedHealth } = require('../electron/desktop-health');
function fixture(state = {}, verification = false) {
  let now = Date.now(), next = 0, rebuilds = 0;
  const timers = new Map();
  const store = { state, update(change) { const draft = structuredClone(this.state); change(draft); this.state = draft; } };
  const win = () => Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const health = new DesktopHealth({ store, now: () => now, verificationTimeoutMs: verification ? 20000 : 0, schedule(fn) { timers.set(++next, fn); return next; }, cancel(id) { timers.delete(id); },
    rebuild() { rebuilds++; health.attach(win()); }, metrics: () => [{ type: 'Tab', name: 'private-name', memory: { workingSetSize: 123 }, cpu: { percentCPUUsage: 2 } }], memory: () => ({ rss: 100 }) });
  health.start(); health.attach(win());
  return { health, store, timers, tick(ms) { now += ms; }, run() { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); }, rebuilds: () => rebuilds };
}
test('unresponsive UI recovers at most twice per ten minutes without touching protected state', () => {
  const protectedState = { accounts: [{ password: 'keep', tier: 3 }], notificationOutbox: [{ id: 'pending' }], commandReplies: [{ id: 'reply' }] };
  const f = fixture(structuredClone(protectedState));
  for (let i = 0; i < 4; i++) { f.health.current.emit('unresponsive'); f.run(); }
  assert.equal(f.rebuilds(), 2); assert.equal(f.timers.size, 0);
  assert.ok(f.health.snapshot().events.some(x => x.type === 'recovery-limited'));
  for (const key of Object.keys(protectedState)) assert.deepEqual(f.store.state[key], protectedState[key]);
  f.tick(600001); f.health.current.emit('unresponsive'); f.run(); assert.equal(f.rebuilds(), 3);
});

test('window load alone or responsive does not prove restored state; sender and nonce must match', () => {
  const f = fixture({}, true), contents = f.health.current.webContents;
  const token = f.health.challenge(contents);
  assert.equal(f.health.acknowledge(contents, token), false);
  f.health.current.emit('responsive'); f.health.current.webContents.emit('did-finish-load');
  assert.ok(f.health.pending);
  f.health.stateServed(contents);
  assert.equal(f.health.acknowledge({}, token), false);
  assert.equal(f.health.acknowledge(contents, 'stale'), false);
  assert.equal(f.health.acknowledge(contents, token), true);
  assert.equal(f.health.pending, null); assert.equal(f.timers.size, 0);
  assert.ok(f.health.snapshot().events.some(x => x.type === 'ui-verified'));
});
test('verification timeout and renderer loss stop automatic rebuilds; manual successful verification re-enables them', () => {
  const f = fixture({}, true);
  f.run(); assert.equal(f.health.autoBlocked, true);
  f.health.recover(false); f.run(); assert.equal(f.rebuilds(), 0);
  f.health.recover(true); f.run(); assert.equal(f.rebuilds(), 1);
  const stale = f.health.current.webContents;
  stale.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.health.autoBlocked, true); f.health.recover(false); assert.equal(f.timers.size, 0);
  f.health.recover(true); f.run();
  const contents = f.health.current.webContents;
  assert.equal(f.health.acknowledge(stale, f.health.challenge(contents)), false);
  f.health.stateServed(contents); f.health.acknowledge(contents, f.health.challenge(contents)); contents.emit('did-finish-load');
  assert.equal(f.health.autoBlocked, false); assert.equal(f.health.pending, null);
});
test('main-frame load failure is recorded without raw URL and exit cancels verification', () => {
  const f = fixture({}, true);
  f.health.current.webContents.emit('did-fail-load', {}, -2, 'private-secret', 'https://private-secret', true);
  assert.equal(f.health.autoBlocked, true);
  assert.ok(f.health.snapshot().events.some(x => x.type === 'verify-load-failed'));
  assert.ok(!JSON.stringify(f.health.snapshot()).includes('private-secret'));
  const closing = fixture({}, true); closing.health.end(); closing.run();
  assert.equal(closing.timers.size, 0); assert.equal(closing.health.pending, null);
  assert.ok(!closing.health.snapshot().events.some(x => x.type === 'verify-timeout'));
});
test('responsive, shutdown and retired-window events cancel or cannot create extra UIs', () => {
  const f = fixture();
  f.health.current.emit('unresponsive'); f.health.current.emit('responsive'); f.run(); assert.equal(f.rebuilds(), 0);
  const old = f.health.current;
  old.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 }); f.run(); assert.equal(f.rebuilds(), 1);
  old.emit('unresponsive'); f.run(); assert.equal(f.rebuilds(), 1);
  f.health.current.emit('unresponsive'); f.health.end(); f.run(); assert.equal(f.rebuilds(), 1);
  assert.equal(f.store.state.desktopDiagnostics.session.cleanExit, true);
});
test('restart preserves evidence and reports only unclean exit, not a fabricated crash cause', () => {
  const f = fixture(); f.health.record('renderer-gone', { reason: 'crashed', exitCode: 7 });
  const next = fixture(JSON.parse(JSON.stringify(f.store.state)));
  assert.ok(next.health.snapshot().events.some(x => x.reason === 'crashed'));
  assert.ok(next.health.summary().warning.includes('原因尚未确认'));
  next.health.end(); const clean = fixture(next.store.state); assert.equal(clean.health.previousUnclean, false);
});
test('samples are minute-limited and metadata is bounded with no raw names, URLs or errors', () => {
  const f = fixture(); for (let i = 0; i < 400; i++) { f.health.sample(); f.tick(60000); }
  for (let i = 0; i < 140; i++) f.health.record('unresponsive', { reason: 'private-name', message: 'private-name' });
  const snapshot = f.health.snapshot(); assert.equal(snapshot.samples.length, 120); assert.equal(snapshot.events.length, 100);
  assert.ok(!JSON.stringify(snapshot).includes('private-name'));
  assert.equal(retainedHealth({ events: [{ type: 'crashed', at: new Date().toISOString() }], secret: 'secret' }).events.length, 0);
});
test('diagnostic disk failures and metric failures do not interrupt recovery or monitoring', () => {
  const f = fixture(); f.store.update = () => { throw Error('disk'); };
  f.health.current.emit('unresponsive'); f.run(); assert.equal(f.rebuilds(), 1); assert.equal(f.health.persistenceError, true);
  f.health.metrics = () => { throw Error('metrics'); }; f.tick(60000); assert.doesNotThrow(() => f.health.sample());
});
