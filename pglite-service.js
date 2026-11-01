'use strict';
// ══════════════════════════════════════════════════════════════════
//  pglite-service：Electron 主进程里的「启动即监听」服务
//
//  app.whenReady() → startPgliteServer()：
//    1. 延迟 import @electric-sql/pglite（ESM 依赖，CJS 里只能用动态 import）
//    2. 创建 PGlite 实例（落盘到 dataDir；主进程默认 <APP_DIR>/pgdata，与 messages/ 平级；
//       都不指定则退回内存库）
//    3. 用 ./pglite-server 起 TCP 服务，默认 127.0.0.1:5432
//  之后任何 Postgres 客户端都能连：
//    psql -h localhost -p 5432 -U postgres
//
//  可用环境变量 / 选项覆盖：
//    PGLITE_PORT      监听端口（默认 5432；显式指定则不自动换端口）
//    PGLITE_HOST      监听地址（默认 127.0.0.1，只对本机开放）
//    PGLITE_DATA_DIR  数据目录（options.dataDir 优先；主进程默认 <APP_DIR>/pgdata）
//    PGLITE_LOG_LEVEL error|warn|info|debug（默认 info）
//  app.on('will-quit') → stopPgliteServer()：关端口、断连接、关库。
// ══════════════════════════════════════════════════════════════════
const path = require('node:path');
const { createServer, LogLevel } = require('./pglite-server');

const DEFAULT_PORT = 5432;
const DEFAULT_HOST = '127.0.0.1';
// 默认端口被占用时，最多向后找多少个端口（显式指定端口时不会回退）
const PORT_FALLBACK_TRIES = 10;

const LOG_LEVELS = {
  error: LogLevel.Error,
  warn: LogLevel.Warn,
  info: LogLevel.Info,
  debug: LogLevel.Debug,
};

// 当前活动的服务实例：{ db, servers:[], sockets:Set, host, port, dataDir|null }
let active = null;
// 启动中的 promise（并发调用 start 时复用同一个）
let starting = null;

// 解析数据目录：显式 options.dataDir 优先 → 环境变量 PGLITE_DATA_DIR → null（内存库）。
// 主进程默认传入 <APP_DIR>/pgdata（与 messages/ 平级）；独立调用不传则仍是内存库。
function resolveDataDir(options) {
  const raw = (options && options.dataDir) || process.env.PGLITE_DATA_DIR;
  return raw ? path.resolve(raw) : null;
}

async function createDb(dataDir) {
  // ESM 包在 CommonJS 里必须动态 import；放在函数内，缺失依赖时只让服务启动失败，
  // 不影响主模块加载（应用照常启动）。
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return db;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    // 端口传 0 时由系统分配（测试用）
    if (host) server.listen(port, host);
    else server.listen(port);
  });
}

function resolvePort(options) {
  if (options.port !== undefined && options.port !== null && options.port !== '') {
    return { port: Number(options.port), explicit: true };
  }
  if (process.env.PGLITE_PORT) {
    return { port: Number(process.env.PGLITE_PORT), explicit: true };
  }
  return { port: DEFAULT_PORT, explicit: false };
}

function resolveHost(options) {
  return (
    options.host || process.env.PGLITE_HOST || DEFAULT_HOST
  );
}

function resolveLogLevel(options) {
  if (options.logLevel !== undefined && options.logLevel !== null) return options.logLevel;
  const fromEnv = String(process.env.PGLITE_LOG_LEVEL || '').toLowerCase();
  if (fromEnv in LOG_LEVELS) return LOG_LEVELS[fromEnv];
  return LogLevel.Info;
}

/**
 * 启动 PGlite + wire-protocol 服务（幂等：已在运行则直接返回当前实例）。
 * 失败时抛错 —— 调用方只告警，不阻断应用启动。
 * @param {{port?: number, host?: string, logLevel?: number, dataDir?: string}} [options]
 *   dataDir 指定落盘目录（优先于环境变量 PGLITE_DATA_DIR）；都不传则内存库。
 * @returns {Promise<{host: string, port: number, dataDir: string|null, servers: import('node:net').Server[]}>}
 */
async function startPgliteServer(options = {}) {
  if (active) return active;
  if (starting) return starting;

  starting = (async () => {
    const host = resolveHost(options);
    const { port: wantPort, explicit } = resolvePort(options);
    const logLevel = resolveLogLevel(options);
    const dataDir = resolveDataDir(options);

    const db = await createDb(dataDir);

    const servers = [];
    const sockets = new Set();

    const track = (server) => {
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      servers.push(server);
      return server;
    };

    const primary = track(createServer(db, { logLevel }));

    // 绑定端口：默认 5432 被占用时向后找（本机可能已有真实 Postgres）；
    // 显式指定端口则只试该端口，失败即报错，绝不悄悄换端口。
    const tries = explicit ? 1 : PORT_FALLBACK_TRIES;
    let boundPort = null;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      const candidate = wantPort === 0 ? 0 : wantPort + i;
      try {
        await listenOnce(primary, candidate, host);
        boundPort = candidate === 0 ? primary.address().port : candidate;
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'EADDRINUSE') continue;
        break;
      }
    }
    if (boundPort === null) {
      try { primary.close(); } catch (_) { /* ignore */ }
      const reason = lastErr && lastErr.code === 'EADDRINUSE'
        ? `端口 ${wantPort}（及其后 ${tries - 1} 个）已被占用`
        : (lastErr && lastErr.message) || '未知错误';
      throw new Error(`pglite-server 无法监听 ${host}:${wantPort}：${reason}`);
    }

    // 默认只绑 127.0.0.1；再尽力绑一个 ::1，保证 `psql -h localhost`
    // 在系统优先解析到 IPv6 回环时也能连上（失败不致命，端口 0 时不启）
    if (wantPort !== 0 && host === DEFAULT_HOST) {
      try {
        const v6 = track(createServer(db, { logLevel }));
        await listenOnce(v6, boundPort, '::1');
      } catch (_) {
        // 机器没有 IPv6 回环就算了，IPv4 已可用
        const idx = servers.length - 1;
        const maybe = servers[idx];
        if (maybe && maybe !== primary && !maybe.address()) servers.splice(idx, 1);
      }
    }

    active = { db, servers, sockets, host, port: boundPort, dataDir };

    const ps =
      `psql -h ${host === DEFAULT_HOST ? 'localhost' : host} -p ${boundPort} -U postgres`;
    console.log(
      `[pglite] server listening on ${host}:${boundPort}` +
        `${dataDir ? `（数据目录 ${dataDir}）` : '（内存库，重启即清空）'}` +
        `\n[pglite] 连接方式：${ps}`
    );
    return active;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * 停止服务：关端口 → 掐断存量连接 → 关 PGlite。幂等，可随便调用。
 * @returns {Promise<void>}
 */
async function stopPgliteServer() {
  const current = active;
  active = null;
  if (!current) return;

  for (const server of current.servers) {
    try { server.close(); } catch (_) { /* ignore */ }
  }
  for (const socket of Array.from(current.sockets)) {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  }
  current.sockets.clear();
  try { await current.db.close(); } catch (_) { /* ignore */ }
  console.log(`[pglite] server stopped（端口 ${current.port} 已释放）`);
}

/** 当前状态（未启动则 null），供状态查询/测试使用。 */
function getPgliteStatus() {
  if (!active) return null;
  return { host: active.host, port: active.port, dataDir: active.dataDir };
}

/** 取得当前活动的 PGlite 实例（未启动则 null），供「直连模式」在进程内查询。 */
function getPgliteDb() {
  return active ? active.db : null;
}

/**
 * 「直连模式」启动：只在进程内创建 PGlite 实例，**不监听任何端口**。
 * 供内嵌 dbclient 使用（app 主进程直接 db.query，无需 TCP / psql）。
 * 幂等：已在运行（无论 server 模式还是 direct 模式）则直接返回当前实例。
 * @param {{dataDir?: string}} [options]
 */
async function startPgliteDirect(options = {}) {
  if (active) return active;
  if (starting) return starting;

  starting = (async () => {
    const dataDir = resolveDataDir(options);
    const db = await createDb(dataDir);
    active = { db, servers: [], sockets: new Set(), host: null, port: null, dataDir, direct: true };
    console.log(
      `[pglite] 直连模式就绪（无端口，进程内 PGlite）` +
        `${dataDir ? `（数据目录 ${dataDir}）` : '（内存库，重启即清空）'}`
    );
    return active;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * 在「已就绪的 PGlite 实例」上开启 Postgres wire-protocol TCP 监听，
 * 让外部 psql / DBeaver / 内置 GoNavi(dbclient) 等客户端连进同一个内嵌库。
 *
 * 与 startPgliteServer 的区别：本函数 **不新建 PGlite**，而是复用 active.db ——
 * 也就是 db:* IPC（内嵌 dbview）正在用的那个实例，因此外部 psql 看到的数据
 * 与应用内界面完全一致（同一个库，不是另起一个）。
 *
 * 前置：需先 startPgliteDirect() / startPgliteServer() 让 active 就绪。
 * 幂等：已监听则直接返回当前 host/port。
 *
 * 选项 / 环境变量：
 *   host      PGLITE_HOST      默认 127.0.0.1（仅本机）；设为 0.0.0.0 则对局域网开放
 *                              （注意：PGlite 为 trust 认证，开放到外网无鉴权）
 *   port      PGLITE_PORT      默认 5432；被占用时自动向后找（显式指定端口则不回退）
 *   logLevel  PGLITE_LOG_LEVEL error|warn|info|debug（默认 info）
 * @param {{host?: string, port?: number, logLevel?: number}} [options]
 * @returns {Promise<{host: string, port: number}>}
 */
async function startWireServer(options = {}) {
  if (!active || !active.db) {
    throw new Error('内嵌数据库尚未就绪，无法开启 psql 监听');
  }
  // 已经监听（direct 模式重复调用 / 或 startPgliteServer 模式）→ 直接返回
  if (active.wirePort) return { host: active.host, port: active.wirePort };
  if (active.servers && active.servers.length > 0) {
    return { host: active.host, port: active.port };
  }

  const host = resolveHost(options);
  const { port: wantPort, explicit } = resolvePort(options);
  const logLevel = resolveLogLevel(options);
  const db = active.db;

  const servers = active.servers || (active.servers = []);
  const sockets = active.sockets || (active.sockets = new Set());

  const track = (server) => {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return server;
  };

  const primary = track(createServer(db, { logLevel }));
  const tries = explicit ? 1 : PORT_FALLBACK_TRIES;
  let boundPort = null;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const candidate = wantPort === 0 ? 0 : wantPort + i;
    try {
      await listenOnce(primary, candidate, host);
      boundPort = candidate === 0 ? primary.address().port : candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EADDRINUSE') continue;
      break;
    }
  }
  if (boundPort === null) {
    try { primary.close(); } catch (_) { /* ignore */ }
    const idx = servers.indexOf(primary);
    if (idx >= 0) servers.splice(idx, 1);
    const reason = lastErr && lastErr.code === 'EADDRINUSE'
      ? `端口 ${wantPort}（及其后 ${tries - 1} 个）已被占用`
      : (lastErr && lastErr.message) || '未知错误';
    throw new Error(`pglite wire 服务无法监听 ${host}:${wantPort}：${reason}`);
  }

  // 默认 127.0.0.1 时尽力再绑 ::1，保证 `psql -h localhost`
  // 在系统优先解析 IPv6 回环时也能连上（失败不致命，端口 0 时不启）
  if (wantPort !== 0 && host === DEFAULT_HOST) {
    const v6 = track(createServer(db, { logLevel }));
    try {
      await listenOnce(v6, boundPort, '::1');
    } catch (_) {
      const idx = servers.indexOf(v6);
      if (idx >= 0) servers.splice(idx, 1);
      try { v6.close(); } catch (_2) { /* ignore */ }
    }
  }

  active.host = host;
  active.port = boundPort;
  active.wirePort = boundPort;

  const ps = `psql -h ${host === DEFAULT_HOST ? 'localhost' : host} -p ${boundPort} -U postgres`;
  console.log(
    `[pglite] 外部 psql 已可连接：${host}:${boundPort}` +
      `\n[pglite] 连接方式：${ps}`
  );
  return { host, port: boundPort };
}

module.exports = { startPgliteServer, startPgliteDirect, startWireServer, stopPgliteServer, getPgliteStatus, getPgliteDb };
