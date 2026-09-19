const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { DEFAULT_UPDATE_FEED_URL, migrateUpdateFeedUrl } = require('./update-feed');
const { alertStepFromLegacy, agentPath } = require('./report-parser');
const { ALERT_METRIC, alertLedgerKey } = require('./alert-ledger');

const EMPTY_STATE = {
  telegram: { botToken: '', chatId: '', mode: '', pairing: null },
  appearance: { theme: 'ocean' },
  alertPolicy: { confirmationReads: 1, quietStart: '', quietEnd: '', failureEscalation: 3 },
  update: {
    feedUrl: DEFAULT_UPDATE_FEED_URL,
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
        appearance: { ...EMPTY_STATE.appearance, ...(saved.appearance || {}) },
        alertPolicy: { ...EMPTY_STATE.alertPolicy, ...(saved.alertPolicy || {}) },
        update: { ...EMPTY_STATE.update, ...(saved.update || {}) },
      };
      if (!Object.hasOwn(saved.telegram || {}, 'mode') && this.state.telegram.botToken && this.state.telegram.chatId) {
        this.state.telegram.mode = 'legacy';
      }
      this.state.update.feedUrl = migrateUpdateFeedUrl(this.state.update.feedUrl);
      this.state.accounts = this.state.accounts.map((account) => ({
        ...account,
        subagentThresholds: Array.isArray(account.subagentThresholds)
          ? account.subagentThresholds.map((item) => ({ name: item.name, path: agentPath(item), remark: String(item.remark || '').trim(), alertStep: alertStepFromLegacy(item) }))
          : [],
        expandedAgentPaths: Array.isArray(account.expandedAgentPaths) ? account.expandedAgentPaths.filter(Array.isArray) : [],
      }));
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
        mode: this.state.telegram.mode,
        pairing: this.state.telegram.pairing ? {
          code: this.state.telegram.pairing.code,
          expiresAt: this.state.telegram.pairing.expiresAt,
          botUsername: this.state.telegram.pairing.botUsername,
          paired: this.state.telegram.pairing.paired === true,
        } : null,
      },
      update: {
        feedUrl: this.state.update?.feedUrl || '',
        autoCheck: this.state.update?.autoCheck !== false,
      },
      appearance: { theme: this.state.appearance?.theme || 'ocean' },
      alertPolicy: { ...EMPTY_STATE.alertPolicy, ...(this.state.alertPolicy || {}) },
      accounts: this.state.accounts.map((account) => {
        const live = runtime.get(account.id) || {};
        const period = live.reportPeriod || account.agentSnapshot?.period;
        const periodKey = period?.start && period?.end ? `${period.start}/${period.end}` : '';
        const history = account.alertHistory?.metric === ALERT_METRIC && account.alertHistory?.period === periodKey
          ? account.alertHistory : null;
        const subagents = (live.subagents || []).map((agent) => {
          const entry = history?.agents?.[alertLedgerKey(agent.path, agent.alertStep)];
          return {
            ...agent,
            alertedPositiveMax: entry?.positiveMax || 0,
            alertedNegativeMax: entry?.negativeMax || 0,
            lastAlertAt: entry?.lastSentAt || '',
          };
        });
        return {
          id: account.id,
          name: account.name,
          navUrl: account.navUrl,
          username: account.username,
          subagentThresholds: (account.subagentThresholds || []).map((item) => ({
            name: item.name,
            path: agentPath(item),
            remark: String(item.remark || ''),
            alertStep: Number.isFinite(item.alertStep) && item.alertStep > 0 ? item.alertStep : null,
          })),
          expandedAgentPaths: account.expandedAgentPaths || [],
          intervalMinutes: account.intervalMinutes,
          enabled: account.enabled,
          hasSecurityCode: Boolean(account.securityCode),
          hasPassword: Boolean(account.password),
          ...live,
          trend: Array.isArray(account.agentTrend) ? account.agentTrend : [],
          subagents,
        };
      }),
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
