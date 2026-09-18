const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { SecureStore } = require('../electron/store');

app.whenReady().then(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-monitor-store-smoke-'));
  try {
    const oldStore = new SecureStore(directory);
    oldStore.state.accounts.push({
      id: 'fixture', name: '测试账号', username: 'fixture',
      subagentThresholds: [{ name: 'parent-01', alertStep: 100 }],
    });
    oldStore.save();
    const migrated = new SecureStore(directory);
    migrated.load();
    assert.deepEqual(migrated.state.accounts[0].subagentThresholds[0].path, ['parent-01']);
    migrated.update((data) => {
      data.accounts[0].subagentThresholds.push({
        name: 'child-01', path: ['parent-01', 'child-01'], remark: '西区', alertStep: 300,
      });
    });
    const reopened = new SecureStore(directory);
    reopened.load();
    assert.deepEqual(reopened.publicState().accounts[0].subagentThresholds, [
      { name: 'parent-01', path: ['parent-01'], remark: '', alertStep: 100 },
      { name: 'child-01', path: ['parent-01', 'child-01'], remark: '西区', alertStep: 300 },
    ]);
    process.stdout.write('Agent settings migration and persistence smoke test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.quit();
});
