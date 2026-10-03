const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { pruneDeepAgents } = require('./agent-depth');
const { recipientKey } = require('./reliability');
const { DEFAULT_UPDATE_FEED_URL, migrateUpdateFeedUrl } = require('./update-feed');
const { alertStepFromLegacy, agentPath } = require('./report-parser');
const { alertLedgerKey, bufferedAlertLevel } = require('./alert-ledger');
const { accountSystemId, accountBaseUrl, crownLoginEntryId, crownUrl, metricForAccount } = require('./monitor-systems');

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
  alertRecords: [],
  notificationOutbox: [],
};

class SecureStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'monitor-settings.bin');
    this.state = structuredClone(EMPTY_STATE);
    this.loadStatus = 'new';
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this.state;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用');
      const decode = file => {
        const saved = JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64')));
        if (!saved || !Array.isArray(saved.accounts) || saved.accounts.some(account => !account || typeof account !== 'object')) throw new Error('配置结构无效');
        return saved;
      };
      let saved;
      try { saved = decode(this.filePath); this.loadStatus = 'loaded'; }
      catch (error) {
        fs.copyFileSync(this.filePath, `${this.filePath}.unreadable-${Date.now()}`);
        saved = decode(`${this.filePath}.backup`);
        this.loadStatus = 'recovered';
      }
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
      this.state.alertRecords = Array.isArray(this.state.alertRecords) ? this.state.alertRecords.slice(0, 500) : [];
      let depthPruned = false;
      this.state.accounts = this.state.accounts.map((account) => {
        const systemType = accountSystemId(account);
        const crownLoginEntry = crownLoginEntryId(account.crownLoginEntry, account.monitorMetric);
        const crownDomain = crownUrl(account.crownDomain || account.navUrl);
        const normalized = {
          ...account,
          systemType,
          navUrl: systemType === 'crown' ? crownDomain : account.navUrl || accountBaseUrl({ systemType }),
          crownDomain: systemType === 'crown' ? crownDomain : '',
          crownLoginEntry: systemType === 'crown' ? crownLoginEntry : '',
          monitorMetric: metricForAccount({ systemType, crownLoginEntry }).id,
        subagentThresholds: Array.isArray(account.subagentThresholds)
          ? account.subagentThresholds.map((item) => ({ name: item.name, path: agentPath(item), remark: String(item.remark || '').trim(), alertStep: alertStepFromLegacy(item), deltaAlertStep: Number.isFinite(item.deltaAlertStep) && item.deltaAlertStep > 0 ? item.deltaAlertStep : null }))
          : [],
        expandedAgentPaths: Array.isArray(account.expandedAgentPaths) ? account.expandedAgentPaths.filter(Array.isArray) : [],
        };
        const before = JSON.stringify(normalized);
        pruneDeepAgents(normalized);
        depthPruned ||= before !== JSON.stringify(normalized);
        return normalized;
      });
      if (this.loadStatus === 'recovered') {
        this.state.recoveryReviewRequired = true;
        this.state.events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'error', message: '配置损坏，已从加密备份恢复；请核对提醒设置与通知记录。' });
      }
      if (depthPruned || this.loadStatus === 'recovered') this.save();
    } catch (error) {
      const backup = `${this.filePath}.unreadable-${Date.now()}`;
      fs.copyFileSync(this.filePath, backup);
      this.state = structuredClone(EMPTY_STATE);
      this.loadStatus = 'failed';
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
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.dirty = true;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法安全保存账号');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.state));
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 });
    // Preserve the last readable generation. Never replace it with a corrupt file.
    if (fs.existsSync(this.filePath) && this.loadStatus !== 'recovered' && (!this.backupAt || Date.now() - this.backupAt >= 300000)) {
      fs.copyFileSync(this.filePath, `${this.filePath}.backup`);
      this.backupAt = Date.now();
    }
    fs.renameSync(temporary, this.filePath);
    this.dirty = false;
  }

  update(mutator, { deferred = false } = {}) {
    const previous = structuredClone(this.state);
    try { mutator(this.state); if (deferred) this.deferSave(); else { this.save(); this.persistenceError = ''; } }
    catch (error) { this.state = previous; this.persistenceError = `保存失败：${error.message}`; throw error; }
    return this.state;
  }

  deferSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      try { this.save(); this.persistenceError = ''; }
      catch (error) { this.saveTimer = null; this.persistenceError = `保存失败：${error.message}`; }
    }, 1000);
    this.saveTimer.unref?.();
  }

  flush() { if (this.saveTimer || this.dirty) this.save(); }

  publicState(runtime = new Map()) {
    return {
      persistenceError: this.persistenceError || '',
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
      notificationQueue: {
        pending: (this.state.notificationOutbox || []).length,
        failed: (this.state.notificationOutbox || []).filter(item => item.attempts > 0).length,
        held: (this.state.notificationOutbox || []).filter(item => item.recipient !== recipientKey(this.state.telegram)).length,
        items: (this.state.notificationOutbox || []).map(item => ({
          id: item.id, text: item.text, createdAt: item.createdAt, attempts: item.attempts,
          error: item.error || '', nextAttemptAt: item.nextAttemptAt,
          held: item.recipient !== recipientKey(this.state.telegram),
        })),
      },
      accounts: this.state.accounts.map((account) => {
        const metric = metricForAccount(account);
        // Long-running samples belong to on-demand diagnostics, not every UI tick.
        const { readSamples, ...live } = runtime.get(account.id) || {};
        const snapshotMatchesMetric = account.agentSnapshot?.metric === metric.id
          || (!account.agentSnapshot?.metric && metric.id === 'receivable-downline');
        const period = live.reportPeriod || (snapshotMatchesMetric ? account.agentSnapshot?.period : null);
        const periodKey = period?.start && period?.end ? `${period.start}/${period.end}` : '';
        const history = account.alertHistory?.metric === metric.alertMetric && account.alertHistory?.period === periodKey
          ? account.alertHistory : null;
        const subagents = (live.subagents || []).map((agent) => {
          const entry = history?.agents?.[alertLedgerKey(agent.path, agent.alertStep)];
          const deliveredHistory = account.notificationLedgerVersion ? account.deliveredAlertHistory : history;
          const sentEntry = deliveredHistory?.period === periodKey && deliveredHistory?.metric === history?.metric
            ? deliveredHistory.agents?.[alertLedgerKey(agent.path, agent.alertStep)] : null;
          const pending = (this.state.notificationOutbox || []).filter(item => item.record?.accountId === account.id
            && JSON.stringify(item.record.agentPath) === JSON.stringify(agent.path));
          const delivered = this.state.alertRecords.find(item => item.status === 'sent' && item.accountId === account.id
            && JSON.stringify(item.agentPath) === JSON.stringify(agent.path));
          return {
            ...agent,
            alertedPositiveLevel: sentEntry?.positiveLastAlertLevel || 0,
            alertedNegativeLevel: sentEntry?.negativeLastAlertLevel || 0,
            lastObservedLevel: entry?.currentLevel || 0,
            effectiveAlertLevel: bufferedAlertLevel(agent.value, agent.alertStep, entry),
            pendingNotifications: pending.length,
            lastAlertAt: delivered?.time || sentEntry?.lastSentAt || '',
          };
        });
        return {
          id: account.id,
          name: account.name,
          navUrl: account.navUrl,
          systemType: accountSystemId(account),
          crownDomain: account.crownDomain || '',
          crownLoginEntry: account.crownLoginEntry || '',
          username: account.username,
          monitorMetric: metric.id,
          subagentThresholds: (account.subagentThresholds || []).map((item) => ({
            name: item.name,
            path: agentPath(item),
            remark: String(item.remark || ''),
            alertStep: Number.isFinite(item.alertStep) && item.alertStep > 0 ? item.alertStep : null,
            ...(Number.isFinite(item.deltaAlertStep) && item.deltaAlertStep > 0 ? { deltaAlertStep: item.deltaAlertStep } : {}),
          })),
          expandedAgentPaths: account.expandedAgentPaths || [],
          intervalMinutes: account.intervalMinutes,
          enabled: account.enabled,
          hasSecurityCode: Boolean(account.securityCode),
          hasPassword: Boolean(account.password),
          tierTransitions: account.tierTransitions || [],
          alertSettingChanges: account.alertSettingChanges || [],
          ...live,
          trend: Array.isArray(account.agentTrend) ? account.agentTrend.filter((point) => !point.metric || point.metric === metric.id) : [],
          subagents,
        };
      }),
      events: this.state.events.slice(0, 100),
      alertRecords: this.state.alertRecords.slice(0, 500),
    };
  }

  addEvent(type, message, accountId = null) {
    this.state.events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type, message, accountId });
    this.state.events = this.state.events.slice(0, 500);
    this.deferSave();
  }

  addAlertRecord(record) {
    this.state.alertRecords.unshift({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      ...record,
    });
    this.state.alertRecords = this.state.alertRecords.slice(0, 500);
    this.save();
  }
}

module.exports = { SecureStore };
