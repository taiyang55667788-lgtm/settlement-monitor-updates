const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

class UpdateService {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.timer = null;
    this.runtime = {
      currentVersion: app.getVersion(),
      status: 'idle',
      message: '等待检查',
      progress: 0,
      availableVersion: '',
      lastCheckedAt: '',
      packaged: app.isPackaged,
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    this.bindEvents();
  }

  bindEvents() {
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', message: '正在检查新版本…', progress: 0 }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', message: `发现 ${info.version}，正在后台下载…`, availableVersion: info.version }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', message: '当前已是最新版本', lastCheckedAt: new Date().toISOString() }));
    autoUpdater.on('download-progress', (progress) => this.set({ status: 'downloading', progress: Math.round(progress.percent), message: `正在下载更新 ${Math.round(progress.percent)}%` }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', progress: 100, message: `版本 ${info.version} 已下载，重启即可安装`, availableVersion: info.version, lastCheckedAt: new Date().toISOString() }));
    autoUpdater.on('error', (error) => this.set({ status: 'error', message: error?.message || '检查更新失败', lastCheckedAt: new Date().toISOString() }));
  }

  set(patch) {
    Object.assign(this.runtime, patch);
    this.onChange();
  }

  configure() {
    const feedUrl = String(this.store.state.update?.feedUrl || '').trim().replace(/\/$/, '');
    if (!feedUrl) {
      this.set({ status: 'unconfigured', message: '请先设置更新服务器地址' });
      return false;
    }
    if (!/^https:\/\//i.test(feedUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(feedUrl)) {
      throw new Error('更新地址必须使用 HTTPS');
    }
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    return true;
  }

  start() {
    clearInterval(this.timer);
    if (this.store.state.update?.autoCheck === false) return;
    setTimeout(() => void this.check(true), 8000);
    this.timer = setInterval(() => void this.check(true), 6 * 60 * 60 * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async check(silent = false) {
    if (!app.isPackaged) {
      this.set({ status: 'development', message: '开发模式不检查更新；安装包中会自动启用', lastCheckedAt: new Date().toISOString() });
      return;
    }
    try {
      if (!this.configure()) return;
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ status: 'error', message: silent ? '自动检查失败，稍后重试' : (error.message || '检查更新失败'), lastCheckedAt: new Date().toISOString() });
    }
  }

  install() {
    if (this.runtime.status !== 'ready') throw new Error('更新尚未下载完成');
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }
}

module.exports = { UpdateService };
