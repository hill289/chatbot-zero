'use strict';
/* ══════════════════════════════════════════════════════════════════════════
 *  embedded-db.js —— 应用内置的 PostgreSQL（PGlite）后端
 * --------------------------------------------------------------------------
 *  设计目标（对应任务要求）：
 *    · dbclient 不再单独运行进程、不监听任何 HTTP / TCP 端口；
 *    · 直接在 Electron 主进程内用 PGlite 实例（WASM Postgres）执行 SQL；
 *    · 只支持 PostgreSQL 一种数据源。
 *
 *  后端能力（供主进程 db:* IPC 使用）：
 *    status()            连接状态（内嵌，无端口）
 *    objects()           对象树：tables / views / functions / triggers
 *    saved()             已存查询
 *    query(sql)          执行任意 SQL → { columns, rows(数组), command, rowCount, durationMs }
 *    tableRows(name)     查看某表前 200 行
 *    applyChanges(payload) 结果区事务提交（增/改/删，原子）
 *
 *  依赖 pglite-service 的 startPgliteDirect()（不监听端口，仅创建 db 实例）。
 * ══════════════════════════════════════════════════════════════════════════ */

const { startPgliteDirect, getPgliteDb } = require('./pglite-service');

// 已存查询（演示用，和对象树一一对应）
const SAVED_QUERIES = [
  { id: 'q1', name: '所有客户', sql: 'SELECT id, name, city, email, created_at\nFROM customers\nORDER BY id;' },
  { id: 'q2', name: '订单概览', sql: 'SELECT o.id, c.name AS customer, p.name AS product,\n       o.quantity, o.status, o.created_at\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nJOIN products p ON p.id = o.product_id\nORDER BY o.id DESC;' },
  { id: 'q3', name: '按城市统计客户', sql: 'SELECT city, COUNT(*) AS customer_count\nFROM customers\nGROUP BY city\nORDER BY customer_count DESC;' },
  { id: 'q4', name: '库存预警(<20)', sql: 'SELECT id, name, stock\nFROM products\nWHERE stock < 20\nORDER BY stock ASC;' },
  { id: 'q5', name: '本月订单金额', sql: 'SELECT SUM(o.quantity * p.price) AS total_amount\nFROM orders o\nJOIN products p ON p.id = o.product_id;' },
];

// 首次启动自动建 demo schema（保证左侧「表 / 视图 / 函数 / 触发器」都有真实内容）
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

let _initPromise = null;
let _dataDir = null;
let _seeded = false;

// ── 工具 ──────────────────────────────────────────────────────────────────
function sqlIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// 把 PGlite 的 { rows:[对象], fields } 统一成前端期望的「列名 + 数组行」
function normalize(result) {
  const fields = (result && result.fields) || [];
  const columns = fields.map((f) => f.name);
  const objRows = (result && result.rows) || [];
  const rows = objRows.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])));
  const rowCount = result && result.affectedRows != null ? result.affectedRows : rows.length;
  return { columns, rows, rowCount };
}

// 执行单条或多条 SQL。单条走 query（返回结果集），多条回退 exec（取最后一条结果）。
async function rawQuery(sql) {
  const db = getPgliteDb();
  if (!db) throw new Error('内嵌数据库尚未就绪');
  const text = String(sql);
  try {
    return await db.query(text);
  } catch (e) {
    // 多语句 / 需要 Simple Query 的场景：用 exec（返回结果数组）
    const results = await db.exec(text);
    const arr = Array.isArray(results) ? results : [results];
    return arr[arr.length - 1] || { rows: [], fields: [] };
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────
async function seed() {
  if (_seeded) return;
  for (const sql of SEED) {
    try { await rawQuery(sql); }
    catch (e) { console.warn('[embedded-db] seed 跳过:', (e.message || '').split('\n')[0]); }
  }
  try {
    const r = await rawQuery('SELECT COUNT(*)::int AS n FROM customers');
    const n = r && r.rows && r.rows[0] ? Number(r.rows[0].n != null ? r.rows[0].n : r.rows[0][0]) : 0;
    if (!n) {
      await rawQuery(`INSERT INTO customers(name,email,city) VALUES
        ('张伟','zhangwei@example.com','北京'),
        ('李娜','lina@example.com','上海'),
        ('王强','wangqiang@example.com','广州'),
        ('刘洋','liuyang@example.com','深圳'),
        ('陈静','chenjing@example.com','杭州'),
        ('赵磊','zhaolei@example.com','成都')`);
      await rawQuery(`INSERT INTO products(name,price,stock) VALUES
        ('机械键盘',399.00,120),
        ('无线鼠标',129.00,15),
        ('27寸显示器',1599.00,8),
        ('USB-C 扩展坞',259.00,45),
        ('降噪耳机',899.00,30)`);
      await rawQuery(`INSERT INTO orders(customer_id,product_id,quantity,status) VALUES
        (1,1,2,'paid'),(2,2,1,'pending'),(3,3,1,'paid'),
        (4,4,3,'shipped'),(5,5,2,'paid'),(1,3,1,'cancelled'),
        (2,1,1,'paid'),(6,2,5,'pending')`);
    }
  } catch (e) { console.warn('[embedded-db] seed-data:', e.message); }
  _seeded = true;
}

/** 幂等初始化：创建内嵌 PGlite（不监听端口）并建 demo schema。 */
function init(opts) {
  if (opts && opts.dataDir !== undefined) _dataDir = opts.dataDir || null;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await startPgliteDirect({ dataDir: _dataDir || undefined });
    await seed();
    console.log('[embedded-db] 内嵌 PostgreSQL 就绪（无端口，直连 PGlite）');
    return true;
  })();
  return _initPromise;
}

async function ensure() {
  if (!_initPromise) await init();
  else await _initPromise;
}

// ── 业务接口 ──────────────────────────────────────────────────────────────
async function status() {
  await ensure();
  return {
    connected: !!getPgliteDb(),
    host: 'embedded',
    port: null,
    user: 'postgres',
    database: 'postgres',
    serverVersion: 'PGlite (内嵌)',
    display: 'postgresql://postgres@embedded/postgres · 内嵌直连',
  };
}

async function introspectObjects() {
  await ensure();
  const out = { tables: [], views: [], functions: [], triggers: [] };

  const tRes = await rawQuery(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const tables = tRes.rows.map((r) => r.table_name);

  const colRes = await rawQuery(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns WHERE table_schema='public'
     ORDER BY table_name, ordinal_position`);
  const colsByTable = {};
  for (const r of colRes.rows) {
    (colsByTable[r.table_name] = colsByTable[r.table_name] || []).push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable });
  }
  out.tables = tables.map((name) => ({ name, columns: colsByTable[name] || [] }));

  const vRes = await rawQuery(
    `SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY table_name`);
  out.views = vRes.rows.map((r) => ({ name: r.table_name }));

  const fRes = await rawQuery(
    `SELECT routine_name, routine_type FROM information_schema.routines
     WHERE routine_schema='public' ORDER BY routine_name`);
  const seenF = new Set();
  for (const r of fRes.rows) {
    const key = r.routine_name + '|' + r.routine_type;
    if (seenF.has(key)) continue;
    seenF.add(key);
    out.functions.push({ name: r.routine_name, type: (r.routine_type || 'FUNCTION').toUpperCase() });
  }

  const trRes = await rawQuery(
    `SELECT trigger_name, event_object_table, event_manipulation
     FROM information_schema.triggers WHERE trigger_schema='public'
     ORDER BY trigger_name`);
  const seenT = new Set();
  for (const r of trRes.rows) {
    const key = r.trigger_name + '|' + r.event_object_table;
    if (seenT.has(key)) continue;
    seenT.add(key);
    out.triggers.push({ name: r.trigger_name, table: r.event_object_table, event: r.event_manipulation });
  }

  return out;
}

async function objects() { return introspectObjects(); }

async function saved() { return { queries: SAVED_QUERIES }; }

async function query(sql) {
  await ensure();
  const text = String(sql || '').trim();
  if (!text) return { error: 'SQL 不能为空', columns: [], rows: [] };
  const started = Date.now();
  try {
    const r = await rawQuery(text);
    const norm = normalize(r);
    return { columns: norm.columns, rows: norm.rows, command: (r && r.command) || '', rowCount: norm.rowCount, durationMs: Date.now() - started };
  } catch (e) {
    return { error: e.message || String(e), columns: [], rows: [] };
  }
}

async function tableRows(name) {
  await ensure();
  const n = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return { error: '非法表名', columns: [], rows: [] };
  const started = Date.now();
  try {
    const r = await rawQuery(`SELECT * FROM ${n} LIMIT 200`);
    const norm = normalize(r);
    return { columns: norm.columns, rows: norm.rows, command: (r && r.command) || '', rowCount: norm.rowCount, durationMs: Date.now() - started };
  } catch (e) {
    return { error: e.message || String(e), columns: [], rows: [] };
  }
}

// 结果区事务提交（增 / 改 / 删，原子）
// 必须走 PGlite 官方 db.transaction()：它在内部用简单协议 BEGIN/COMMIT，出错自动
// ROLLBACK，并把「真实错误」原样抛出。旧实现用多次 rawQuery('BEGIN'/'COMMIT')：
// 一旦某条语句失败，rawQuery 的兜底会在「已中止(aborted)」的事务里用 db.exec 再跑一次，
// 最终只抛出 “current transaction is aborted, commands ignored until end of transaction
// block”，把真正的失败原因（外键 / 非空 / 类型约束等）完全掩盖，用户只看到“提交失败”
// 却不知原因；而且手工事务同样不保证真正的原子性。
async function applyChanges(payload) {
  await ensure();
  const body = payload || {};
  const table = String(body.table || '').trim();
  const pk = String(body.pk || 'id').trim();
  const inserts = Array.isArray(body.inserts) ? body.inserts : [];
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return { error: '非法表名' };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pk)) return { error: '非法主键列' };
  const db = getPgliteDb();
  if (!db) return { error: '内嵌数据库尚未就绪' };
  let ins = 0, upd = 0, del = 0;
  try {
    await db.transaction(async (tx) => {
      for (const row of inserts) {
        const cols = Object.keys(row || {}).filter((k) => k.indexOf('__') !== 0);
        if (!cols.length) continue;
        const sql = 'INSERT INTO ' + sqlIdent(table) + ' (' + cols.map(sqlIdent).join(',') + ') VALUES (' + cols.map((c) => sqlLiteral(row[c])).join(',') + ')';
        await tx.query(sql); ins++;
      }
      for (const u of updates) {
        const changes = (u && u.changes) ? u.changes : {};
        const cols = Object.keys(changes);
        if (!cols.length) continue;
        const set = cols.map((c) => sqlIdent(c) + ' = ' + sqlLiteral(changes[c])).join(', ');
        await tx.query('UPDATE ' + sqlIdent(table) + ' SET ' + set + ' WHERE ' + sqlIdent(pk) + ' = ' + sqlLiteral(u.pkValue)); upd++;
      }
      for (const d of deletes) {
        await tx.query('DELETE FROM ' + sqlIdent(table) + ' WHERE ' + sqlIdent(pk) + ' = ' + sqlLiteral(d.pkValue)); del++;
      }
    });
    return { ok: true, counts: { inserted: ins, updated: upd, deleted: del } };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

module.exports = { init, status, objects, saved, query, tableRows, applyChanges, SAVED_QUERIES };
