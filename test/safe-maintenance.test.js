const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pruneDiagnostics, SafeMaintenance, CACHE_LIMIT } = require('../electron/safe-maintenance');
const AUTO = '{"format":"settlement-monitor-operational-diagnostics-v1","fixture":true}';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-cleanup-test-'));
  fs.mkdirSync(path.join(root, 'diagnostics'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('only auto diagnostics expire by 30 days and ten files; protected exports/config remain', t => {
  const root = fixture(t), now = Date.now(), dir = path.join(root, 'diagnostics');
  const make = time => { const name = `before-update-1.0.43-${time}.json`; fs.writeFileSync(path.join(dir, name), AUTO); return name; };
  for (let i = 0; i < 12; i++) make(now - i * 60000);
  make(now - 31 * 86400000); const future = make(now + 86400000);
  for (const name of ['manual.json', '交收监控-诊断.json', 'settings.enc', 'settings.enc.backup', 'before-update-1.0.43-no-time.json']) fs.writeFileSync(path.join(dir, name), 'keep');
  const result = pruneDiagnostics(root, now);
  assert.equal(result.removed, 3); assert.equal(result.bytes, 3 * Buffer.byteLength(AUTO));
  assert.equal(fs.existsSync(path.join(dir, future)), true);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.enc.backup'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(dir, 'manual.json'), 'utf8'), 'keep');
});
test('at least newest diagnostic remains even when all are old; no recursive directory deletion', t => {
  const root = fixture(t), now = Date.now(), dir = path.join(root, 'diagnostics');
  const names = [31, 32].map(days => `before-update-1.0.43-${now - days * 86400000}.json`);
  names.forEach(name => fs.writeFileSync(path.join(dir, name), AUTO));
  const exported = path.join(dir, `before-update-1.0.43-${now - 45 * 86400000}.json`);
  fs.writeFileSync(exported, '{"format":"settlement-monitor-diagnostics-v1","fixture":true}');
  const folder = path.join(dir, `before-update-1.0.43-${now - 40 * 86400000}.json`); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'keep'), 'keep');
  assert.equal(pruneDiagnostics(root, now).removed, 1);
  assert.equal(fs.existsSync(path.join(dir, names[0])), true); assert.equal(fs.existsSync(path.join(folder, 'keep')), true);
  assert.equal(fs.existsSync(exported), true);
});
test('linked diagnostics folder is rejected without touching its target', t => {
  const root = fixture(t), target = path.join(root, 'other'); fs.mkdirSync(target);
  fs.rmdirSync(path.join(root, 'diagnostics'));
  fs.symlinkSync(target, path.join(root, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneDiagnostics(root), /拒绝/); assert.equal(fs.existsSync(target), true);
});
test('cache clears only above 200MiB at idle, once per day, never calls storage clearing', async t => {
  const root = fixture(t); const original = { accounts: [{ password: 'keep' }], notificationOutbox: [{ id: 'pending' }], commandReplies: [{ text: 'keep' }] };
  const store = { state: structuredClone(original), update(fn) { fn(this.state); }, addEvent() {} };
  let idle = false, cleared = 0; const ses = { getCacheSize: async () => CACHE_LIMIT + 1, clearCache: async () => { cleared++; }, clearStorageData: () => { throw Error('must not clear credentials'); } };
  const worker = new SafeMaintenance({ userData: root, store, sessions: () => [ses, ses], idle: () => idle });
  await worker.run(); assert.equal(cleared, 0);
  idle = true; await worker.run(); await worker.run(); assert.equal(cleared, 1);
  for (const key of Object.keys(original)) assert.deepEqual(store.state[key], original[key]);
});
test('below threshold cache and cleanup failures do not erase state or block another session', async t => {
  const root = fixture(t); let cleared = 0;
  const store = { state: {}, update(fn) { fn(this.state); }, addEvent() {} };
  const worker = new SafeMaintenance({ userData: root, store, sessions: () => [{ getCacheSize: async () => CACHE_LIMIT, clearCache: async () => { cleared++; } }, { getCacheSize: async () => { throw Error('disk'); } }], idle: () => true });
  await worker.run(); assert.equal(cleared, 0); assert.equal(store.state.safeMaintenance.errors, 1);
});

test('daily reservation survives restart during cache clearing; failed reservation cleans nothing', async t => {
  const root = fixture(t); let finish, clears = 0;
  const store = { state: {}, update(fn) { fn(this.state); }, addEvent() {} };
  const options = { userData: root, store, idle: () => true, sessions: () => [{ getCacheSize: async () => CACHE_LIMIT + 1, clearCache: () => { clears++; return new Promise(resolve => { finish = resolve; }); } }] };
  const first = new SafeMaintenance(options); const pending = first.run();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(store.state.safeMaintenance.status, 'started');
  await new SafeMaintenance(options).run(); assert.equal(clears, 1);
  finish(); await pending;
  const failure = new SafeMaintenance({ ...options, store: { state: {}, update() { throw Error('disk'); } } });
  await assert.rejects(failure.run(), /disk/); assert.equal(clears, 1);
});
