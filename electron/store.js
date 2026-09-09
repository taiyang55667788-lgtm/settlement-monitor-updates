const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

const EMPTY_STATE = {
  telegram: { botToken: '', chatId: '' },
  update: {
    feedUrl: 'https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest/download',
    autoCheck: true,
  },
  accounts: [],
  events: [],
};

class SecureStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'monitor-settings.bin');
    this.state = structuredClone(EMPTY_STATE);
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this.state;
    try {
      const encrypted = Buffer.from(fs.readFileSync(this.filePath, 'utf8'), 'base64');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用');
      const saved = JSON.parse(safeStorage.decryptString(encrypted));
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...saved,
        telegram: { ...EMPTY_STATE.telegram, ...(saved.telegram || {}) },
        update: { ...EMPTY_STATE.update, ...(saved.update || {}) },
      };
      if (!this.state.update.feedUrl) this.state.update.feedUrl = EMPTY_STATE.update.feedUrl;
    } catch (error) {
      const backup = `${this.filePath}.unreadable-${Date.now()}`;
      fs.copyFileSync(this.filePath, backup);
      this.state = structuredClone(EMPTY_STATE);
      this.state.events.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'error',
        message: '旧设置无法解密，已保留备份并创建新配置。',
      });
    }
    return this.state;
  }

  save() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法安全保存账号');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.state));
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  update(mutator) {
    mutator(this.state);
    this.save();
    return this.state;
  }

  publicState(runtime = new Map()) {
    return {
      telegram: {
        chatId: this.state.telegram.chatId,
        hasBotToken: Boolean(this.state.telegram.botToken),
      },
      update: {
        feedUrl: this.state.update?.feedUrl || '',
        autoCheck: this.state.update?.autoCheck !== false,
      },
      accounts: this.state.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        navUrl: account.navUrl,
        username: account.username,
        operator: account.operator,
        threshold: account.threshold,
        intervalMinutes: account.intervalMinutes,
        enabled: account.enabled,
        hasSecurityCode: Boolean(account.securityCode),
        hasPassword: Boolean(account.password),
        ...(runtime.get(account.id) || {}),
      })),
      events: this.state.events.slice(0, 100),
    };
  }

  addEvent(type, message, accountId = null) {
    this.state.events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type, message, accountId });
    this.state.events = this.state.events.slice(0, 500);
    this.save();
  }
}

module.exports = { SecureStore };
