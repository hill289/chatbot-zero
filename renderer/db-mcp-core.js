/*!
 * db-mcp-core.js — 内置 PostgreSQL（PGlite）MCP 工具核心（纯逻辑模块）
 * =============================================================================
 * 目标：把应用「内置的 PostgreSQL」（主进程内嵌 PGlite，无端口，经 db:* IPC 直连）
 * 暴露成一组 MCP 工具，让 AI Agent 能直接查询 / 维护这个内嵌库。
 *
 * 设计约束（与 tool-registry.js / spill.js / approval.js 一致）：
 *   · 纯逻辑、零依赖、UMD（浏览器 globalThis.DbMcpCore / Node module.exports），
 *     便于 node --test 直接单测；
 *   · 不碰 DOM、不碰 IPC：真正的数据通道由宿主注入的 `db` 对象提供，
 *     只需实现 status/objects/saved/query/table/apply 六个方法（见下）。
 *
 * 注入的 db 接口（形状与应用内 db:* IPC 完全一致）：
 *   status()            → { connected, host, user, database, serverVersion, display }
 *   objects()           → { tables:[{name,columns:[{name,type,nullable}]}], views, functions, triggers }
 *   saved()             → { queries:[{id,name,sql}] }
 *   query(sql)          → { columns:[...], rows:[[...]], command, rowCount, durationMs } | { error }
 *   table(name)         → 同上（某表前 200 行）
 *   apply(payload)      → { ok, counts:{inserted,updated,deleted} } | { error }
 *
 * 说明：本模块只负责「工具描述 + 结果格式化」，不负责注册到 window.mcpServers，
 *      注册逻辑在 renderer/assets/js/07-mcp.js 的 dbMcpSync()（服务键 db-mcp）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DbMcpCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 下发给模型的工具清单（声明式，inputSchema 为 JSON Schema）────────────────
  var TOOLS = [
    {
      name: 'db_status',
      description: '查看内置 PostgreSQL（PGlite，进程内嵌、无端口直连）的连接状态：是否就绪、服务端版本、当前数据库与用户。开始任何数据库操作前可先调用它确认可用。',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'db_query',
      description: '对内置 PostgreSQL 执行任意 SQL（SELECT / INSERT / UPDATE / DELETE / 建表改表等 DDL 均可），返回列名与行数据（默认最多展示前 100 行）。数据分析、验证数据、建表/改表都走这个。⚠ 该工具可修改数据，写操作请谨慎确认。',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '要执行的 SQL（单条；若含多条语句，返回最后一条的结果）' },
          limit: { type: 'integer', description: '结果最多展示多少行（默认 100，上限 500）' }
        },
        required: ['sql']
      }
    },
    {
      name: 'db_objects',
      description: '列出内置 PostgreSQL 的对象树：表（含列名与类型）、视图、函数、触发器。用于快速了解库结构后再写 SQL。',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'db_saved',
      description: '列出内置 PostgreSQL 的「已存查询」（id / 名称 / SQL），可直接拿来运行或改写。',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'db_table',
      description: '查看某张表的前 200 行数据（等价于 SELECT * FROM 表 LIMIT 200）。table 为表名（仅字母/数字/下划线）。',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名' }
        },
        required: ['table']
      }
    },
    {
      name: 'db_apply_changes',
      description: '在一个事务中原子地提交对某张表的增/改/删（等价于结果区「保存」）。payload：table 表名；pk 主键列（默认 id）；inserts 新增行（列名→值对象数组）；updates 更新（[{pkValue, changes:{列名:新值}}]）；deletes 删除（[{pkValue}]）。任一语句失败则整体回滚。⚠ 该工具会修改数据。',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名' },
          pk: { type: 'string', description: '主键列名，默认 id' },
          inserts: { type: 'array', items: { type: 'object' }, description: '新增行（列名→值）' },
          updates: { type: 'array', items: { type: 'object' }, description: '更新：[{pkValue, changes:{列名→新值}}]' },
          deletes: { type: 'array', items: { type: 'object' }, description: '删除：[{pkValue}]' }
        },
        required: ['table']
      }
    }
  ];

  // ── 小工具 ────────────────────────────────────────────────────────────────
  function ev(x) { return (x === null || x === undefined) ? '' : String(x); }
  function text(s) { return { content: [{ type: 'text', text: String(s) }], isError: false }; }
  function error(s) { return { content: [{ type: 'text', text: '❌ ' + String(s) }], isError: true }; }
  function pad(s, w) { s = String(s); while (s.length < w) { s += ' '; } return s; }

  // 把 { columns, rows } 渲染成「可读文本表 + 统计脚注」。
  // rows 为「数组的数组」（与 embedded-db 的 normalize 输出一致）。
  function formatResult(columns, rows, opts) {
    opts = opts || {};
    columns = Array.isArray(columns) ? columns : [];
    rows = Array.isArray(rows) ? rows : [];
    var limit = (Number(opts.limit) > 0) ? Math.floor(Number(opts.limit)) : 100;

    if (!columns.length) {
      var bits = ['（无结果列）'];
      if (opts.command != null && opts.command !== '') bits.push('command=' + opts.command);
      if (opts.rowCount != null) bits.push('rowCount=' + opts.rowCount);
      return bits.join(' · ');
    }

    var shown = rows.slice(0, limit);
    // 每列宽度 = 表头与本次展示数据中的最大字符宽度（含截断后的长度）
    var colw = columns.map(function (c) { return String(c).length; });
    var body = shown.map(function (r) {
      return columns.map(function (c, i) {
        var v = ev(r ? r[i] : '');
        if (v.length > 80) { v = v.slice(0, 77) + '…'; }
        if (v.length > colw[i]) { colw[i] = v.length; }
        return v;
      });
    });

    var head = columns.map(function (c, i) { return pad(c, colw[i]); }).join(' | ');
    var sep = columns.map(function (_, i) { return new Array(colw[i] + 1).join('-'); }).join('-+-');
    var lines = [head, sep].concat(body.map(function (cells) {
      return cells.map(function (v, i) { return pad(v, colw[i]); }).join(' | ');
    }));

    var footer = [];
    if (rows.length > shown.length) { footer.push('… 共 ' + rows.length + ' 行，仅显示前 ' + shown.length + ' 行'); }
    else { footer.push('共 ' + rows.length + ' 行'); }
    if (opts.rowCount != null) { footer.push('rowCount=' + opts.rowCount); }
    if (opts.command != null && opts.command !== '') { footer.push('command=' + opts.command); }
    if (opts.durationMs != null) { footer.push(opts.durationMs + ' ms'); }

    return lines.join('\n') + '\n\n' + footer.join(' · ');
  }

  // ── 工厂：用注入的 db 构造一个「工具引擎」 ─────────────────────────────────
  function create(db) {
    async function call(name, args) {
      args = (args && typeof args === 'object') ? args : {};
      try {
        if (!db || typeof db.query !== 'function') {
          return error('内置 PostgreSQL 不可用：需要 Electron 桌面外壳，且已安装 PGlite。');
        }

        if (name === 'db_status') {
          var st = (typeof db.status === 'function') ? await db.status() : null;
          if (st && st.error) { return error('数据库状态查询失败：' + st.error); }
          return text('内置 PostgreSQL 状态：\n'
            + '· 连接：' + (st && st.connected ? '✅ 已就绪' : '❌ 未连接') + '\n'
            + '· 版本：' + ev(st && st.serverVersion) + '\n'
            + '· 数据库：' + ev(st && st.database) + '\n'
            + '· 用户：' + ev(st && st.user) + '\n'
            + '· 连接串：' + ev(st && st.display));
        }

        if (name === 'db_query') {
          var sql = ev(args.sql).trim();
          if (!sql) { return error('db_query 需要非空的 sql 参数。'); }
          var limit = Number(args.limit);
          if (!isFinite(limit) || limit <= 0) { limit = 100; }
          if (limit > 500) { limit = 500; }
          var r = await db.query(sql);
          if (r && r.error) { return error('SQL 执行失败：' + r.error); }
          var body = formatResult(r && r.columns, r && r.rows, {
            limit: limit,
            rowCount: (r && r.rowCount != null) ? r.rowCount : undefined,
            command: r && r.command,
            durationMs: r && r.durationMs
          });
          return text(body);
        }

        if (name === 'db_objects') {
          var o = (typeof db.objects === 'function') ? await db.objects() : null;
          if (o && o.error) { return error('查询对象失败：' + o.error); }
          var tables = (o && o.tables) || [];
          var views = (o && o.views) || [];
          var funcs = (o && o.functions) || [];
          var trigs = (o && o.triggers) || [];
          var out = [];
          out.push('表（' + tables.length + '）：');
          tables.forEach(function (t) {
            var cols = (t.columns || []).map(function (c) { return c.name + ':' + c.type; }).join(', ');
            out.push('  · ' + t.name + (cols ? ' (' + cols + ')' : ''));
          });
          out.push('视图（' + views.length + '）：' + (views.map(function (v) { return v.name; }).join(', ') || '无'));
          out.push('函数（' + funcs.length + '）：' + (funcs.map(function (f) { return f.name; }).join(', ') || '无'));
          out.push('触发器（' + trigs.length + '）：' + (trigs.map(function (tr) { return tr.name + '@' + tr.table; }).join(', ') || '无'));
          return text(out.join('\n'));
        }

        if (name === 'db_saved') {
          var sv = (typeof db.saved === 'function') ? await db.saved() : null;
          var qs = (sv && sv.queries) || [];
          if (!qs.length) { return text('（没有已存查询）'); }
          return text('已存查询：\n' + qs.map(function (q) {
            return '· [' + q.id + '] ' + q.name + '\n   ' + String(q.sql).replace(/\n/g, '\n   ');
          }).join('\n'));
        }

        if (name === 'db_table') {
          var tbl = ev(args.table || args.name).trim();
          if (!tbl) { return error('db_table 需要 table 参数。'); }
          var tr = await db.table(tbl);
          if (tr && tr.error) { return error('读取表失败：' + tr.error); }
          return text('表 ' + tbl + '（前 ' + ((tr && tr.rows) || []).length + ' 行）：\n'
            + formatResult(tr && tr.columns, tr && tr.rows, {
              limit: 200,
              rowCount: (tr && tr.rowCount != null) ? tr.rowCount : undefined,
              command: tr && tr.command
            }));
        }

        if (name === 'db_apply_changes') {
          var payload = {
            table: ev(args.table).trim(),
            pk: ev(args.pk).trim() || 'id',
            inserts: Array.isArray(args.inserts) ? args.inserts : [],
            updates: Array.isArray(args.updates) ? args.updates : [],
            deletes: Array.isArray(args.deletes) ? args.deletes : []
          };
          if (!payload.table) { return error('db_apply_changes 需要 table 参数。'); }
          var ar = await db.apply(payload);
          if (ar && ar.error) { return error('提交失败（事务已回滚）：' + ar.error); }
          var c = (ar && ar.counts) || {};
          return text('事务已提交：新增 ' + (c.inserted || 0) + ' 行，更新 ' + (c.updated || 0) + ' 行，删除 ' + (c.deleted || 0) + ' 行。');
        }

        return error('未知的数据库工具：' + name);
      } catch (e) {
        return error('数据库工具执行失败：' + ((e && e.message) || String(e)));
      }
    }

    return { tools: TOOLS.slice(), call: call };
  }

  return {
    TOOLS: TOOLS,
    create: create,
    formatResult: formatResult
  };
});
