'use strict';
/*
 * GoNavi-Postgres · 轻量后端
 * ---------------------------------------------------------------------------
 * 目标：为「GoNavi 风格」Postgres 客户端提供真实数据。
 *   · 用最小 Postgres Wire Protocol 客户端，连到本机已运行的 PGlite(Postgres) 服务
 *     （默认 127.0.0.1:5432，由主进程 pglite-service 启动，认证为 trust）。
 *   · 通过 HTTP 暴露：/api/status /api/objects /api/query /api/saved，并托管 public/ 静态页。
 * 不依赖任何第三方 npm 包（Node 标准库 net/http/fs 即可）。
 */

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.PGHOST || '127.0.0.1';
const PORT = Number(process.env.PGPORT || 5432);
const PGUSER = process.env.PGUSER || 'postgres';
const PGDATABASE = process.env.PGDATABASE || 'postgres';
const HTTP_PORT = Number(process.env.PORT || 8791);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ══════════════════════════════════════════════════════════════════════════
// 最小 Postgres Wire Protocol 客户端（Simple Query）
// ══════════════════════════════════════════════════════════════════════════
class PgClient {
  constructor(opts) {
    this.opts = Object.assign({ host: HOST, port: PORT, user: PGUSER, database: PGDATABASE }, opts || {});
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.connecting = null;
    this.waiters = [];       // 当前等待消息的解析器
    this.queue = Promise.resolve(); // 串行化查询
    this.serverVersion = '';
  }

  _tryExtract() {
    // 尝试从 this.buf 抽出一条完整消息
    if (this.buf.length < 5) return null;
    const type = this.buf[0];
    const len = this.buf.readInt32BE(1); // 含自身4字节，不含type
    const total = 1 + len;
    if (len < 4) { // 异常
      this.buf = this.buf.subarray(1);
      return null;
    }
    if (this.buf.length < total) return null;
    const payload = this.buf.subarray(5, total);
    const msg = { type: String.fromCharCode(type), payload };
    this.buf = this.buf.subarray(total);
    return msg;
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let msg;
    while ((msg = this._tryExtract())) {
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.type === 'S') {
      // ParameterStatus: key\0value\0
      const s = msg.payload.toString('utf8');
      const parts = s.split('\u0000');
      if (parts[0] === 'server_version') this.serverVersion = parts[1] || '';
    }
    const w = this.waiters[0];
    if (w) w(msg);
  }

  _waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (predicate(msg)) {
          this.waiters.shift();
          resolve(msg);
        } else {
          // 继续等待，但先把 handler 放回队首
          // （保持单等待者模式：只有队列头部 waiter 生效）
        }
      };
      // 简单的单 waiter 循环：把处理器压入队首，收到不匹配消息时忽略
      const waiter = (msg) => {
        if (predicate(msg)) {
          // 移除
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(msg);
        }
        // 否则消息被丢弃（S/K/N 等我们都忽略即可）
      };
      this.waiters.unshift(waiter);
    });
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      sock.setNoDelay(true);
      sock.on('connect', () => {
        // 发送 StartupMessage
        const params = Buffer.from(
          'user\u0000' + this.opts.user + '\u0000' +
          'database\u0000' + this.opts.database + '\u0000' +
          'application_name\u0000GoNavi-Web\u0000' +
          'client_encoding\u0000UTF8\u0000\u0000', 'utf8');
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0);
        head.writeInt32BE(196608, 4); // protocol 3.0
        sock.write(Buffer.concat([head, params]));
      });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('error', (e) => {
        this.connected = false;
        fail(e);
        // 让挂起查询失败
        this._flushError(e);
      });
      sock.on('close', () => { this.connected = false; });
      // 等待 ReadyForQuery('Z')
      this._waitFor((m) => m.type === 'Z').then(() => {
        this.connected = true;
        settled = true;
        resolve();
      }).catch(fail);
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  _flushError(e) {
    // 唤醒所有等待者（用 error 消息模拟）
    const errMsg = { type: 'E', payload: Buffer.from('M' + (e && e.message || 'connection error') + '\u0000\u0000') };
    while (this.waiters.length) {
      const w = this.waiters.shift();
      try { w(errMsg); } catch (_) {}
    }
  }

  _parseRowDescription(payload) {
    const count = payload.readInt16BE(0);
    const fields = [];
    let off = 2;
    for (let i = 0; i < count; i++) {
      let end = off;
      while (payload[end] !== 0) end++;
      const name = payload.subarray(off, end).toString('utf8');
      off = end + 1;
      const tableOID = payload.readInt32BE(off); off += 4;
      const colAttNum = payload.readInt16BE(off); off += 2;
      const typeOID = payload.readInt32BE(off); off += 4;
      const typeSize = payload.readInt16BE(off); off += 2;
      const typeMod = payload.readInt32BE(off); off += 4;
      const format = payload.readInt16BE(off); off += 2;
      fields.push({ name, typeOID, format });
    }
    return fields;
  }

  _parseDataRow(payload) {
    const count = payload.readInt16BE(0);
    const row = [];
    let off = 2;
    for (let i = 0; i < count; i++) {
      const len = payload.readInt32BE(off); off += 4;
      if (len === -1) { row.push(null); }
      else { row.push(payload.subarray(off, off + len).toString('utf8')); off += len; }
    }
    return row;
  }

  _parseError(payload) {
    // 字段: 类型字节 + 文本\0 ... 以 0 结束
    let off = 0; let msg = ''; let code = '';
    while (off < payload.length && payload[off] !== 0) {
      const t = String.fromCharCode(payload[off]); off++;
      let end = off; while (end < payload.length && payload[end] !== 0) end++;
      const val = payload.subarray(off, end).toString('utf8');
      off = end + 1;
      if (t === 'M') msg = val;
      if (t === 'C') code = val;
    }
    return { message: msg || 'PostgreSQL error', code };
  }

  query(sql) {
    // 串行执行
    const run = () => this._execSimpleQuery(sql);
    const p = this.queue.then(run, run);
    // 保持队列不断链条（错误也继续）
    this.queue = p.then(() => {}, () => {});
    return p;
  }

  async _execSimpleQuery(sql) {
    await this.connect();
    const text = String(sql);
    const payload = Buffer.from(text + '\u0000', 'utf8');
    const head = Buffer.alloc(5);
    head.write('Q', 0, 'ascii');
    head.writeInt32BE(4 + payload.length, 1);
    const start = Date.now();
    const resultP = this._collectionQuery();
    this.sock.write(Buffer.concat([head, payload]));
    const res = await resultP;
    res.durationMs = Date.now() - start;
    if (res.error) {
      const e = new Error(res.error.message);
      e.pgCode = res.error.code;
      e.pgError = true;
      throw e;
    }
    return res;
  }

  // 收集一条 Simple Query 的完整结果直到 ReadyForQuery
  _collectionQuery() {
    return new Promise((resolve) => {
      const res = { fields: [], rows: [], command: '', rowCount: null, error: null };
      let currentFields = res.fields;
      const waiter = (msg) => {
        switch (msg.type) {
          case 'T': {
            res.fields = this._parseRowDescription(msg.payload);
            currentFields = res.fields;
            break;
          }
          case 'D': {
            res.rows.push(this._parseDataRow(msg.payload));
            break;
          }
          case 'C': {
            const tag = msg.payload.toString('utf8').replace(/\u0000/g, '').trim();
            res.command = tag;
            const m = /([0-9]+)$/.exec(tag);
            res.rowCount = m ? Number(m[1]) : null;
            break;
          }
          case 'E': {
            res.error = this._parseError(msg.payload);
            break;
          }
          case 'Z': {
            const i = this.waiters.indexOf(waiter);
            if (i >= 0) this.waiters.splice(i, 1);
            resolve(res);
            break;
          }
          default:
            break; // I, N, S, K, A, etc.
        }
      };
      this.waiters.unshift(waiter);
    });
  }

  close() {
    try { if (this.sock) this.sock.end(); } catch (_) {}
    this.connected = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 业务层
// ══════════════════════════════════════════════════════════════════════════
const conn = new PgClient();

// DB 互斥：事务期间独占连接，避免其他请求插到 BEGIN/COMMIT 之间
let __dbChain = Promise.resolve();
function withLock(fn) {
  const run = __dbChain.then(fn, fn);
  __dbChain = run.then(() => {}, () => {});
  return run;
}
function sqlIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const SAVED_QUERIES = [
  { id: 'q1', name: '所有客户', sql: 'SELECT id, name, city, email, created_at\nFROM customers\nORDER BY id;' },
  { id: 'q2', name: '订单概览', sql: 'SELECT o.id, c.name AS customer, p.name AS product,\n       o.quantity, o.status, o.created_at\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nJOIN products p ON p.id = o.product_id\nORDER BY o.id DESC;' },
  { id: 'q3', name: '按城市统计客户', sql: 'SELECT city, COUNT(*) AS customer_count\nFROM customers\nGROUP BY city\nORDER BY customer_count DESC;' },
  { id: 'q4', name: '库存预警(<20)', sql: "SELECT id, name, stock\nFROM products\nWHERE stock < 20\nORDER BY stock ASC;" },
  { id: 'q5', name: '本月订单金额', sql: 'SELECT SUM(o.quantity * p.price) AS total_amount\nFROM orders o\nJOIN products p ON p.id = o.product_id;' },
];

const SEED = [
  `CREATE TABLE IF NOT EXISTS customers (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT,
     city TEXT,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS products (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     price NUMERIC(10,2) NOT NULL DEFAULT 0,
     stock INT NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id SERIAL PRIMARY KEY,
     customer_id INT REFERENCES customers(id),
     product_id INT REFERENCES products(id),
     quantity INT NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS order_audit (
     id SERIAL PRIMARY KEY,
     order_id INT,
     action TEXT,
     changed_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE OR REPLACE VIEW v_order_summary AS
     SELECT o.id AS order_id, c.name AS customer, p.name AS product,
            o.quantity, (o.quantity * p.price) AS amount, o.status
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN products  p ON p.id = o.product_id`,
  `CREATE OR REPLACE FUNCTION fn_customer_total(cid INT) RETURNS NUMERIC AS $$
     SELECT COALESCE(SUM(o.quantity * p.price), 0)
     FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.customer_id = cid;
   $$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION log_order_change() RETURNS TRIGGER AS $$
     BEGIN
       INSERT INTO order_audit(order_id, action) VALUES (NEW.id, TG_OP);
       RETURN NEW;
     END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_orders_audit ON orders`,
  `CREATE TRIGGER trg_orders_audit AFTER INSERT OR UPDATE ON orders
     FOR EACH ROW EXECUTE FUNCTION log_order_change()`,
];

async function seed() {
  for (const sql of SEED) {
    try { await conn.query(sql); }
    catch (e) { console.warn('[seed] 跳过:', (e.message || '').split('\n')[0]); }
  }
  // 数据：仅当为空时插入
  try {
    const c = await conn.query('SELECT COUNT(*)::int AS n FROM customers');
    const n = c.rows && c.rows[0] ? Number(c.rows[0][0]) : 0;
    if (!n) {
      await conn.query(`INSERT INTO customers(name,email,city) VALUES
        ('张伟','zhangwei@example.com','北京'),
        ('李娜','lina@example.com','上海'),
        ('王强','wangqiang@example.com','广州'),
        ('刘洋','liuyang@example.com','深圳'),
        ('陈静','chenjing@example.com','杭州'),
        ('赵磊','zhaolei@example.com','成都')`);
      await conn.query(`INSERT INTO products(name,price,stock) VALUES
        ('机械键盘',399.00,120),
        ('无线鼠标',129.00,15),
        ('27寸显示器',1599.00,8),
        ('USB-C 扩展坞',259.00,45),
        ('降噪耳机',899.00,30)`);
      await conn.query(`INSERT INTO orders(customer_id,product_id,quantity,status) VALUES
        (1,1,2,'paid'),(2,2,1,'pending'),(3,3,1,'paid'),
        (4,4,3,'shipped'),(5,5,2,'paid'),(1,3,1,'cancelled'),
        (2,1,1,'paid'),(6,2,5,'pending')`);
    }
  } catch (e) { console.warn('[seed-data] ', e.message); }
}

async function introspectObjects() {
  const out = { tables: [], views: [], functions: [], triggers: [] };

  const tRes = await conn.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const tables = tRes.rows.map((r) => r[0]);

  const colRes = await conn.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns WHERE table_schema='public'
     ORDER BY table_name, ordinal_position`);
  const colsByTable = {};
  for (const r of colRes.rows) {
    (colsByTable[r[0]] = colsByTable[r[0]] || []).push({ name: r[1], type: r[2], nullable: r[3] });
  }
  out.tables = tables.map((name) => ({ name, columns: colsByTable[name] || [] }));

  const vRes = await conn.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY table_name`);
  out.views = vRes.rows.map((r) => ({ name: r[0] }));

  const fRes = await conn.query(
    `SELECT routine_name, routine_type FROM information_schema.routines
     WHERE routine_schema='public' ORDER BY routine_name`);
  // 去重（重载会有多行）
  const seenF = new Set();
  out.functions = [];
  for (const r of fRes.rows) {
    const key = r[0] + '|' + r[1];
    if (seenF.has(key)) continue;
    seenF.add(key);
    out.functions.push({ name: r[0], type: (r[1] || 'FUNCTION').toUpperCase() });
  }

  const trRes = await conn.query(
    `SELECT trigger_name, event_object_table, event_manipulation
     FROM information_schema.triggers WHERE trigger_schema='public'
     ORDER BY trigger_name`);
  const seenT = new Set();
  out.triggers = [];
  for (const r of trRes.rows) {
    const key = r[0] + '|' + r[1];
    if (seenT.has(key)) { continue; }
    seenT.add(key);
    out.triggers.push({ name: r[0], table: r[1], event: r[2] });
  }

  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP
// ══════════════════════════════════════════════════════════════════════════
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found: ' + rel); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p === '/api/status') {
      return sendJson(res, 200, {
        connected: conn.connected, host: conn.opts.host, port: conn.opts.port,
        user: conn.opts.user, database: conn.opts.database,
        serverVersion: conn.serverVersion || 'pglite',
      });
    }
    if (p === '/api/objects') {
      const objs = await introspectObjects();
      return sendJson(res, 200, objs);
    }
    if (p === '/api/saved') {
      return sendJson(res, 200, { queries: SAVED_QUERIES });
    }
    if (p === '/api/query' && req.method === 'POST') {
      const body = await readBody(req);
      const sql = String(body.sql || '').trim();
      if (!sql) return sendJson(res, 400, { error: 'SQL 不能为空' });
      try {
        const r = await withLock(() => conn.query(sql));
        return sendJson(res, 200, {
          columns: r.fields.map((f) => f.name),
          rows: r.rows,
          command: r.command,
          rowCount: r.rowCount,
          durationMs: r.durationMs,
        });
      } catch (e) {
        return sendJson(res, 200, { error: e.message, columns: [], rows: [] });
      }
    }
    if (p === '/api/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const table = String(body.table || '').trim();
      const pk = String(body.pk || 'id').trim();
      const inserts = Array.isArray(body.inserts) ? body.inserts : [];
      const updates = Array.isArray(body.updates) ? body.updates : [];
      const deletes = Array.isArray(body.deletes) ? body.deletes : [];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return sendJson(res, 400, { error: '非法表名' });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pk)) return sendJson(res, 400, { error: '非法主键列' });
      try {
        const counts = await withLock(async () => {
          await conn.query('BEGIN');
          try {
            let ins = 0, upd = 0, del = 0;
            for (const row of inserts) {
              const cols = Object.keys(row || {});
              if (!cols.length) continue;
              const sql = 'INSERT INTO ' + sqlIdent(table) + ' (' + cols.map(sqlIdent).join(',') + ') VALUES (' + cols.map((c) => sqlLiteral(row[c])).join(',') + ')';
              await conn.query(sql); ins++;
            }
            for (const u of updates) {
              const changes = (u && u.changes) ? u.changes : {};
              const cols = Object.keys(changes);
              if (!cols.length) continue;
              const set = cols.map((c) => sqlIdent(c) + ' = ' + sqlLiteral(changes[c])).join(', ');
              const sql = 'UPDATE ' + sqlIdent(table) + ' SET ' + set + ' WHERE ' + sqlIdent(pk) + ' = ' + sqlLiteral(u.pkValue);
              await conn.query(sql); upd++;
            }
            for (const d of deletes) {
              const sql = 'DELETE FROM ' + sqlIdent(table) + ' WHERE ' + sqlIdent(pk) + ' = ' + sqlLiteral(d.pkValue);
              await conn.query(sql); del++;
            }
            await conn.query('COMMIT');
            return { inserted: ins, updated: upd, deleted: del };
          } catch (e) {
            try { await conn.query('ROLLBACK'); } catch (_) {}
            throw e;
          }
        });
        return sendJson(res, 200, { ok: true, counts });
      } catch (e) {
        return sendJson(res, 200, { error: e.message });
      }
    }
    if (p === '/api/table' && req.method === 'GET') {
      const name = u.searchParams.get('name') || '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return sendJson(res, 400, { error: '非法表名' });
      try {
        const r = await withLock(() => conn.query(`SELECT * FROM ${name} LIMIT 200`));
        return sendJson(res, 200, {
          columns: r.fields.map((f) => f.name), rows: r.rows,
          command: r.command, rowCount: r.rowCount, durationMs: r.durationMs,
        });
      } catch (e) {
        return sendJson(res, 200, { error: e.message, columns: [], rows: [] });
      }
    }
    // static
    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e && e.message || 'server error' });
  }
});

async function main() {
  try {
    await conn.connect();
    console.log(`[dbclient] 已连接 Postgres ${conn.opts.host}:${conn.opts.port} 库=${conn.opts.database}`);
    await seed();
    console.log('[dbclient] 示例 schema 就绪');
  } catch (e) {
    console.error('[dbclient] 连接 Postgres 失败：', e.message);
  }
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[dbclient] HTTP 服务已启动： http://127.0.0.1:${HTTP_PORT}`);
  });
}

main();
