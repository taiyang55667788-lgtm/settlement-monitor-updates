const fs = require('node:fs');
const path = require('node:path');
const DIAGNOSTIC_NAME = /^before-update-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-(\d{13})\.json$/;
const CACHE_LIMIT = 200 * 1024 * 1024;

function pruneDiagnostics(userData, now = Date.now()) {
  if (!path.isAbsolute(userData)) throw Error('清理目录必须为应用绝对路径');
  const root = fs.realpathSync(userData);
  const folder = path.join(root, 'diagnostics');
  if (!fs.existsSync(folder)) return { removed: 0, bytes: 0 };
  if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== folder) throw Error('拒绝清理链接或非诊断目录');
  const directoryStat = fs.lstatSync(folder);
  const files = fs.readdirSync(folder).flatMap(name => {
    const match = name.match(DIAGNOSTIC_NAME);
    if (!match || Number(match[1]) > now) return [];
    const file = path.join(folder, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return [];
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.nlink !== 1) return [];
      const header = Buffer.alloc(256);
      const length = fs.readSync(fd, header, 0, header.length, 0);
      if (!/^\s*\{\s*"format"\s*:\s*"settlement-monitor-operational-diagnostics-v1"\s*,/.test(header.subarray(0, length).toString('utf8'))) return [];
      return [{ file, stat, time: Number(match[1]) }];
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }).sort((a, b) => b.time - a.time || a.file.localeCompare(b.file));
  let removed = 0, bytes = 0;
  files.forEach((item, index) => {
    if (!index || (index < 10 && now - item.time <= 30 * 86400000)) return;
    if (fs.lstatSync(folder).isSymbolicLink() || fs.lstatSync(folder).ino !== directoryStat.ino || fs.realpathSync(folder) !== folder) throw Error('清理目录已变化，本次停止');
    const latest = fs.lstatSync(item.file);
    if (!latest.isFile() || latest.isSymbolicLink() || latest.nlink !== 1 || latest.ino !== item.stat.ino || latest.size !== item.stat.size || latest.mtimeMs !== item.stat.mtimeMs) return;
    fs.unlinkSync(item.file); removed++; bytes += latest.size;
  });
  return { removed, bytes };
}

class SafeMaintenance {
  constructor({ userData, store, sessions, idle, now = Date.now }) {
    Object.assign(this, { userData, store, sessions, idle, now });
    this.running = false;
  }
  prune() { return pruneDiagnostics(this.userData, this.now()); }
  async run() {
    const day = new Date(this.now()).toLocaleDateString('sv-SE');
    if (this.running || !this.idle() || this.store.state.safeMaintenance?.day === day || this.lastAttemptDay === day) return;
    this.running = true; this.lastAttemptDay = day;
    let removed = 0, bytes = 0, caches = 0, errors = 0;
    try {
      // Reserve the day before destructive work, so a restart cannot repeat it.
      this.store.update(data => { data.safeMaintenance = { day, at: new Date(this.now()).toISOString(), status: 'started' }; });
      try { ({ removed, bytes } = this.prune()); } catch { errors++; }
      for (const ses of new Set(this.sessions())) {
        if (!this.idle()) break;
        try {
          const size = await ses.getCacheSize();
          if (Number.isFinite(size) && size > CACHE_LIMIT && this.idle()) { await ses.clearCache(); caches++; }
        } catch { errors++; }
      }
      this.store.update(data => { data.safeMaintenance = { day, at: new Date(this.now()).toISOString(), status: 'complete', removed, bytes, caches, errors }; });
      this.store.addEvent?.(errors ? 'error' : 'info', `安全清理：删除自动诊断 ${removed} 份，释放 ${bytes} 字节；清理 HTTP 缓存 ${caches} 个；异常 ${errors} 项。登录与未完成通知保留。`);
    } finally { this.running = false; }
  }
}
module.exports = { pruneDiagnostics, SafeMaintenance, CACHE_LIMIT };
