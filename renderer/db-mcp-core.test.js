/*!
 * db-mcp-core.test.js — db-mcp-core.js 的 Node 自检（零依赖）
 * 运行： node renderer/db-mcp-core.test.js   （也可被 node --test 收集）
 */
'use strict';
const C = require('./db-mcp-core.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }
function textOf(res) { return (res && res.content && res.content[0] && res.content[0].text) || ''; }

// 一个符合 db:* 输出形状的假库（可局部覆盖）
function fakeDb(over) {
  return Object.assign({
    status: async () => ({ connected: true, host: 'embedded', user: 'postgres', database: 'postgres', serverVersion: 'PGlite (内嵌)', display: 'postgresql://postgres@embedded/postgres · 内嵌直连' }),
    objects: async () => ({
      tables: [{ name: 'customers', columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] }],
      views: [{ name: 'v_order_summary' }],
      functions: [{ name: 'fn_customer_total', type: 'FUNCTION' }],
      triggers: [{ name: 'trg_orders_audit', table: 'orders', event: 'INSERT' }]
    }),
    saved: async () => ({ queries: [{ id: 'q1', name: '所有客户', sql: 'SELECT * FROM customers;' }] }),
    query: async () => ({ columns: ['id', 'name'], rows: [[1, '张伟'], [2, '李娜']], command: 'SELECT', rowCount: 2, durationMs: 3 }),
    table: async () => ({ columns: ['id', 'name'], rows: [[1, '张伟']], command: 'SELECT', rowCount: 1 }),
    apply: async () => ({ ok: true, counts: { inserted: 1, updated: 2, deleted: 0 } })
  }, over || {});
}

async function main() {
  group('TOOLS · 工具清单');
  {
    const names = C.TOOLS.map((t) => t.name);
    eq(names.length, 6, '共 6 个工具');
    ['db_status', 'db_query', 'db_objects', 'db_saved', 'db_table', 'db_apply_changes'].forEach((n) => ok(names.indexOf(n) >= 0, '含工具 ' + n));
    C.TOOLS.forEach((t) => {
      ok(t.inputSchema && t.inputSchema.type === 'object', t.name + ' 有 object inputSchema');
      ok(typeof t.description === 'string' && t.description.length > 0, t.name + ' 有描述');
    });
    eq(C.TOOLS.find((t) => t.name === 'db_query').inputSchema.required, ['sql'], 'db_query 必填 sql');
  }

  group('formatResult · 文本表渲染');
  {
    const s = C.formatResult(['id', 'name'], [[1, 'A'], [2, 'B']], { limit: 100, rowCount: 2, command: 'SELECT' });
    ok(s.indexOf('id') >= 0 && s.indexOf('name') >= 0, '含表头');
    ok(s.indexOf('A') >= 0 && s.indexOf('B') >= 0, '含数据');
    ok(s.indexOf('共 2 行') >= 0, '含统计');
    const big = []; for (let i = 0; i < 50; i++) big.push([i, 'x']);
    ok(C.formatResult(['id', 'v'], big, { limit: 10 }).indexOf('仅显示前 10 行') >= 0, '超限提示');
    const s3 = C.formatResult([], [], { command: 'INSERT', rowCount: 3 });
    ok(s3.indexOf('无结果列') >= 0 && s3.indexOf('rowCount=3') >= 0, '无结果列分支');
  }

  group('create · db_status');
  {
    const eng = C.create(fakeDb());
    const res = await eng.call('db_status', {});
    ok(res.isError === false, '非错误');
    ok(textOf(res).indexOf('已就绪') >= 0, '含就绪');
    ok(textOf(res).indexOf('PGlite') >= 0, '含版本');
  }

  group('create · db_query 正常 / 空 sql / 报错');
  {
    const db = fakeDb();
    const orig = db.query;
    let seenSql = null;
    db.query = async (sql) => { seenSql = sql; return orig(sql); };
    const eng = C.create(db);
    const res = await eng.call('db_query', { sql: 'SELECT * FROM customers' });
    ok(res.isError === false, '正常查询非错误');
    eq(seenSql, 'SELECT * FROM customers', 'sql 已转发');
    ok(textOf(res).indexOf('张伟') >= 0, '含数据张伟');

    const r2 = await eng.call('db_query', { sql: '   ' });
    ok(r2.isError === true, '空 sql 报错');

    const eng2 = C.create(fakeDb({ query: async () => ({ error: 'relation "x" does not exist' }) }));
    const r3 = await eng2.call('db_query', { sql: 'SELECT * FROM x' });
    ok(r3.isError === true && textOf(r3).indexOf('does not exist') >= 0, 'SQL 错误透传');
  }

  group('create · db_objects / db_saved / db_table');
  {
    const eng = C.create(fakeDb());
    const objs = await eng.call('db_objects', {});
    ok(objs.isError === false, 'objects 非错误');
    ok(textOf(objs).indexOf('customers') >= 0 && textOf(objs).indexOf('v_order_summary') >= 0, 'objects 含表/视图');
    ok(textOf(objs).indexOf('trg_orders_audit@orders') >= 0, 'objects 含触发器');

    const saved = await eng.call('db_saved', {});
    ok(saved.isError === false && textOf(saved).indexOf('所有客户') >= 0, 'saved 含查询名');

    let tArg = null;
    const dbT = fakeDb();
    const oT = dbT.table;
    dbT.table = async (n) => { tArg = n; return oT(n); };
    const engT = C.create(dbT);
    const tb = await engT.call('db_table', { table: 'customers' });
    ok(tb.isError === false && tArg === 'customers', 'db_table 参数转发');
    ok(textOf(tb).indexOf('张伟') >= 0, 'db_table 含数据');
    const tbErr = await engT.call('db_table', {});
    ok(tbErr.isError === true, 'db_table 缺 table 报错');
  }

  group('create · db_apply_changes 正常 / 报错 / 缺 table');
  {
    let captured = null;
    const db = fakeDb();
    db.apply = async (p) => { captured = p; return { ok: true, counts: { inserted: 1, updated: 2, deleted: 3 } }; };
    const eng = C.create(db);
    const res = await eng.call('db_apply_changes', { table: 'orders', inserts: [{ a: 1 }], deletes: [{ pkValue: 5 }] });
    ok(res.isError === false, 'apply 非错误');
    eq(captured.table, 'orders', 'table 转发');
    eq(captured.pk, 'id', 'pk 默认 id');
    eq(captured.deletes, [{ pkValue: 5 }], 'deletes 转发');
    ok(textOf(res).indexOf('新增 1 行') >= 0 && textOf(res).indexOf('更新 2 行') >= 0 && textOf(res).indexOf('删除 3 行') >= 0, '回显 counts');

    const engErr = C.create(fakeDb({ apply: async () => ({ error: '外键冲突' }) }));
    const r2 = await engErr.call('db_apply_changes', { table: 'orders' });
    ok(r2.isError === true && textOf(r2).indexOf('外键冲突') >= 0, 'apply 错误透传');

    const r3 = await eng.call('db_apply_changes', {});
    ok(r3.isError === true, '缺 table 报错');
  }

  group('create · 未知工具 / db 不可用 / 异常捕获');
  {
    const eng = C.create(fakeDb());
    const r = await eng.call('no_such_tool', {});
    ok(r.isError === true && textOf(r).indexOf('未知') >= 0, '未知工具报错');

    const engNull = C.create(null);
    const r2 = await engNull.call('db_query', { sql: 'SELECT 1' });
    ok(r2.isError === true && textOf(r2).indexOf('不可用') >= 0, 'db 为空时报不可用');

    const engBoom = C.create(fakeDb({ query: async () => { throw new Error('boom'); } }));
    const r3 = await engBoom.call('db_query', { sql: 'SELECT 1' });
    ok(r3.isError === true && textOf(r3).indexOf('boom') >= 0, '异常转 isError');
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
