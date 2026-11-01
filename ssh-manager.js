/*!
 * ssh-manager.js — 主进程 SSH/SFTP 连接管理（供 MCP ssh 工具与 VFS 传输使用）
 * -----------------------------------------------------------------------------
 * 职责：
 *   · 维护「多主机连接池」：按 host:port@user 键控，支持 connect / disconnect / status；
 *   · 每条连接提供 exec（远程执行）与 sftp（ls / read / write）；
 *   · 通过 IPC 暴露给渲染层（preload.js → window.sshAPI），全部经 isTrustedSender 校验。
 *
 * 依赖：ssh2（package.json dependencies；缺失时整体降级为「SSH 不可用」而不影响启动）。
 * 安全：
 *   · 密码只在主进程内存中驻留，不回传渲染层、不落盘；
 *   · 单次 SFTP 读/写有字节上限（默认 64MB），防止拖垮会话；
 *   · 所有 handler 均校验受信来源（isTrustedSender），与既有 IPC 一致。
 */
'use strict';

const { Client } = require('ssh2');

const CONNECT_TIMEOUT_MS = 15000;
const EXEC_TIMEOUT_MS = 120000;
const SFTP_TIMEOUT_MS = 120000;
const MAX_XFER_BYTES = 64 * 1024 * 1024; // 单文件传输上限 64MB

function hostKey(cfg) {
  return String(cfg.host || '').trim() + ':' + String(cfg.port || 22) + '@' + String(cfg.username || '').trim();
}

function createSshManager() {
  // key -> { conn, cfg, connectedAt, lastError }
  const pool = new Map();

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' timeout (' + ms + 'ms)')), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  function openSftp(conn) {
    return withTimeout(new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    }), SFTP_TIMEOUT_MS, 'sftp open');
  }

  function ensureConn(key) {
    const entry = pool.get(key);
    if (!entry || !entry.connected) {
      const err = new Error('SSH 未连接：' + key + '（请先在「⚙️ 配置 → SSH Servers」点击「连接」）');
      err.code = 'SSH_NOT_CONNECTED';
      throw err;
    }
    return entry;
  }

  async function connect(cfg) {
    cfg = cfg || {};
    const host = String(cfg.host || '').trim();
    const username = String(cfg.username || '').trim();
    if (!host || !username) throw new Error('缺少 host / username');
    const port = parseInt(cfg.port, 10) || 22;
    const key = hostKey({ host, port, username });

    // 已连 → 复用；先关旧连接再重连（用户点「连接」= 按当前参数重建）
    const old = pool.get(key);
    if (old) { try { old.conn.end(); } catch (_) {} pool.delete(key); }

    const conn = new Client();
    const entry = { conn, cfg: { host, port, username }, connected: false, connectedAt: 0, lastError: '' };
    pool.set(key, entry);

    await withTimeout(new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      conn.on('ready', () => {
        if (settled) return;
        settled = true;
        entry.connected = true;
        entry.connectedAt = Date.now();
        entry.lastError = '';
        resolve();
      });
      conn.on('error', (err) => {
        entry.connected = false;
        entry.lastError = String((err && err.message) || err);
        fail(err);
      });
      conn.on('close', () => {
        entry.connected = false;
        if (!settled) fail(new Error('connection closed before ready'));
      });
      try {
        conn.connect({
          host, port, username,
          password: cfg.password == null ? '' : String(cfg.password),
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 15000,
          // 密码登录的内网运维场景：接受未知 host key（不在这里做 TOFU 信任决策）
          algorithms: undefined
        });
      } catch (err) { fail(err); }
    }), CONNECT_TIMEOUT_MS, 'connect');

    return { key, host, port, username, connectedAt: entry.connectedAt };
  }

  function disconnect(key) {
    if (key) {
      const entry = pool.get(key);
      if (!entry) return { ok: false, error: '连接不存在：' + key };
      try { entry.conn.end(); } catch (_) {}
      pool.delete(key);
      return { ok: true, key };
    }
    for (const [k, entry] of pool) { try { entry.conn.end(); } catch (_) {} pool.delete(k); }
    return { ok: true, key: '' };
  }

  function status() {
    const out = [];
    for (const [key, entry] of pool) {
      out.push({
        key,
        host: entry.cfg.host, port: entry.cfg.port, username: entry.cfg.username,
        connected: !!entry.connected,
        connectedAt: entry.connectedAt,
        lastError: entry.lastError
      });
    }
    return out;
  }

  async function exec(key, command, timeoutMs) {
    const entry = ensureConn(key);
    const cmd = String(command || '');
    if (!cmd) throw new Error('缺少 command');
    const ms = Math.min(Math.max(parseInt(timeoutMs, 10) || EXEC_TIMEOUT_MS, 1000), 600000);
    return withTimeout(new Promise((resolve, reject) => {
      entry.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '', stderr = '';
        stream.on('data', (data) => { if (stdout.length < 1024 * 512) stdout += data.toString('utf8'); });
        stream.stderr.on('data', (data) => { if (stderr.length < 1024 * 256) stderr += data.toString('utf8'); });
        stream.on('close', (code) => { resolve({ stdout, stderr, code: code == null ? 0 : code }); });
        stream.on('error', reject);
      });
    }), ms, 'exec');
  }

  async function ls(key, remotePath) {
    const entry = ensureConn(key);
    const sftp = await openSftp(entry.conn);
    const p = String(remotePath || '.');
    try {
      const list = await withTimeout(new Promise((resolve, reject) => {
        sftp.readdir(p, (err, items) => (err ? reject(err) : resolve(items || [])));
      }), SFTP_TIMEOUT_MS, 'sftp readdir');
      const files = list.map((it) => ({
        name: it.filename,
        type: (it.attrs && (it.attrs.mode & 0o170000) === 0o040000) ? 'dir' : 'file',
        size: it.attrs ? Number(it.attrs.size || 0) : 0,
        mtime: it.attrs && it.attrs.mtime ? Number(it.attrs.mtime) * 1000 : 0
      })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
      return { path: p, files };
    } finally {
      try { sftp.end(); } catch (_) {}
    }
  }

  async function read(key, remotePath) {
    const entry = ensureConn(key);
    const sftp = await openSftp(entry.conn);
    const p = String(remotePath || '');
    if (!p) throw new Error('缺少 remotePath');
    try {
      const stat = await withTimeout(new Promise((resolve, reject) => {
        sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
      }), SFTP_TIMEOUT_MS, 'sftp stat');
      const size = Number(stat && stat.size || 0);
      if (size > MAX_XFER_BYTES) throw new Error('远程文件过大（' + size + ' > ' + MAX_XFER_BYTES + ' 上限）');
      const buf = await withTimeout(new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const rs = sftp.createReadStream(p, { start: 0 });
        rs.on('data', (c) => {
          total += c.length;
          if (total > MAX_XFER_BYTES) { rs.destroy(); reject(new Error('远程文件超出传输上限')); return; }
          chunks.push(c);
        });
        rs.on('end', () => resolve(Buffer.concat(chunks)));
        rs.on('error', reject);
      }), SFTP_TIMEOUT_MS, 'sftp read');
      return { path: p, size: buf.length, dataBase64: buf.toString('base64') };
    } finally {
      try { sftp.end(); } catch (_) {}
    }
  }

  async function write(key, remotePath, dataBase64) {
    const entry = ensureConn(key);
    const sftp = await openSftp(entry.conn);
    const p = String(remotePath || '');
    if (!p) throw new Error('缺少 remotePath');
    const buf = Buffer.from(String(dataBase64 || ''), 'base64');
    if (buf.length > MAX_XFER_BYTES) throw new Error('数据超出传输上限（' + MAX_XFER_BYTES + ' 字节）');
    try {
      await withTimeout(new Promise((resolve, reject) => {
        const ws = sftp.createWriteStream(p);
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(buf);
      }), SFTP_TIMEOUT_MS, 'sftp write');
      return { path: p, size: buf.length };
    } finally {
      try { sftp.end(); } catch (_) {}
    }
  }

  return { connect, disconnect, status, exec, ls, read, write };
}

// ── IPC 注册：与 main.js 既有 handler 同风格（受信校验 + 结构化返回）──────
function registerSshIpc(ipcMain, isTrustedSender) {
  const mgr = createSshManager();
  const wrap = (fn) => async (e, payload) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
    try { return Object.assign({ ok: true }, await fn(payload || {})); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  };

  ipcMain.handle('ssh:connect', wrap((p) => mgr.connect(p)));
  ipcMain.handle('ssh:disconnect', wrap((p) => ({ result: mgr.disconnect(p.key), status: mgr.status() })));
  ipcMain.handle('ssh:status', wrap(() => ({ status: mgr.status() })));
  ipcMain.handle('ssh:exec', wrap((p) => mgr.exec(p.key, p.command, p.timeoutMs)));
  ipcMain.handle('ssh:ls', wrap((p) => mgr.ls(p.key, p.path)));
  ipcMain.handle('ssh:read', wrap((p) => mgr.read(p.key, p.path)));
  ipcMain.handle('ssh:write', wrap((p) => mgr.write(p.key, p.path, p.dataBase64)));

  // 应用退出时关闭全部连接
  try {
    const { app } = require('electron');
    app.on('will-quit', () => { try { mgr.disconnect(''); } catch (_) {} });
  } catch (_) { /* 测试环境无 app */ }
  return mgr;
}

module.exports = { registerSshIpc, createSshManager, hostKey };
