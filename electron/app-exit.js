class AppExit {
  constructor({ app, monitor, updater, store, windows, confirm, error, beforeExit = () => {} }) {
    Object.assign(this, { app, monitor, updater, store, windows, confirm, error, beforeExit });
    this.quitting = false;
    app.on('before-quit', event => { if (!this.prepare()) event.preventDefault(); });
  }
  attach(win) {
    this.mainWindow = win;
    win.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      if (!this.store.state.appPreferences?.skipExitConfirmation) {
        const result = this.confirm(win);
        if (result.response !== 0) return;
        if (result.checkboxChecked) {
          try { this.store.update(data => { data.appPreferences = { ...data.appPreferences, skipExitConfirmation: true }; }); }
          catch { this.error('无法保存退出偏好，退出已取消。请检查磁盘后重试。'); return; }
        }
      }
      if (this.prepare()) this.app.quit();
    });
  }
  prepare() {
    if (this.quitting) return true;
    this.monitor?.stop(); this.updater?.stop();
    try {
      this.beforeExit();
      // Force a final atomic encrypted save; do not discard pending replies/outbox.
      this.store?.save();
    } catch {
      this.updater?.disableAutomaticInstall?.();
      this.error('监控已停止，但保存失败，退出已取消。请检查磁盘空间/权限后重试；未完成消息不会主动清除。');
      return false;
    }
    this.quitting = true;
    // Hidden market pages must not keep Electron alive or veto exit via beforeunload.
    for (const win of this.windows()) if (win !== this.mainWindow && !win.isDestroyed()) win.destroy();
    return true;
  }
}
module.exports = { AppExit };
