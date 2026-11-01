'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   GoNavi · PostgreSQL client — 前端逻辑（原生 JS，无构建）
   ══════════════════════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);

// ── 图标（内联 SVG，统一 currentColor）────────────────────────────────────
const ICON = {
  database: '<svg viewBox="0 0 16 16"><ellipse cx="8" cy="3.8" rx="5.2" ry="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 3.8v8.4c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V3.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 6h12M6.2 6v7.5" stroke="currentColor" stroke-width="1.1"/></svg>',
  view: '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.9 8 3.9 14.5 8 14.5 8 12 12.1 8 12.1 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  func: '<svg viewBox="0 0 16 16"><path d="M5.6 5 2.6 8l3 3M10.4 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trig: '<svg viewBox="0 0 16 16"><path d="M9 1.8 3.4 8.8H7l-1 5.4L12.6 7H8.8L9 1.8Z" fill="currentColor" opacity="0.9"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1.8 4.1c0-.85.7-1.55 1.55-1.55h3.2l1.5 1.7h4.5c.85 0 1.55.7 1.55 1.55v6.5c0 .85-.7 1.55-1.55 1.55H3.35c-.85 0-1.55-.7-1.55-1.55Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  query: '<svg viewBox="0 0 16 16"><rect x="2" y="2.8" width="12" height="10.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.6 6.2 7 8l-2.4 1.8M8.2 10h3.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  col: '<svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tools: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  skin: '<svg viewBox="0 0 16 16"><path d="M8 1.8a6.2 6.2 0 0 0 0 12.4c1 0 1.4-.7 1.4-1.4 0-.9-.6-1.1-.6-1.9 0-.7.6-1.2 1.4-1.2h1.1A2.9 2.9 0 0 0 14.2 8 6.2 6.2 0 0 0 8 1.8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.3" cy="6.3" r="1" fill="currentColor"/><circle cx="8" cy="4.8" r="1" fill="currentColor"/><circle cx="10.7" cy="6.3" r="1" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor"/></svg>',
};

// ── 状态 ─────────────────────────────────────────────────────────────────
const S = {
  conn: null,
  objects: { tables: [], views: [], functions: [], triggers: [] },
  saved: [],
  tabs: [],
  activeId: null,
  expanded: new Set(['conn', 'db', 'grp:queries', 'grp:tables', 'grp:views', 'grp:funcs', 'grp:triggers']),
  logs: [],
  filter: '',
  seq: 0,
};

const KWSET = new Set(('SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL ON USING GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE OR REPLACE TABLE VIEW FUNCTION TRIGGER PROCEDURE DROP ALTER ADD COLUMN AS AND OR NOT NULL IS IN DISTINCT COUNT SUM AVG MIN MAX RETURNS RETURN LANGUAGE BEGIN END NEW OLD TG_OP AFTER BEFORE FOR EACH ROW EXECUTE PRIMARY KEY SERIAL INT INTEGER NUMERIC TEXT TIMESTAMPTZ TIMESTAMP DEFAULT REFERENCES CASCADE IF EXISTS CAST COALESCE NOW ASC DESC CONFLICT DO NOTHING').split(/\s+/));

// ══════════════════════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════════════════════
async function api(path, opts) {
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); } catch (_) { data = { error: 'invalid json' }; }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ══════════════════════════════════════════════════════════════════════════
// Toast / 日志
// ══════════════════════════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function log(kind, text) {
  S.logs.unshift({ kind, text, t: new Date().toLocaleTimeString() });
  if (S.logs.length > 200) S.logs.length = 200;
  renderLog();
}
function renderLog() {
  const b = $('#logBody');
  if (!b) return;
  b.innerHTML = S.logs.map((l) =>
    `<div class="logrow"><span class="lt">[${l.t}]</span> <span class="${l.kind === 'ok' ? 'ok' : l.kind === 'err' ? 'err' : ''}">${esc(l.text)}</span></div>`
  ).join('') || '<div class="lt">暂无日志</div>';
}

// ══════════════════════════════════════════════════════════════════════════
// 连接（Postgres 按钮 → 自动连接）
// ══════════════════════════════════════════════════════════════════════════
async function connect() {
  showToast('正在连接 PostgreSQL…', 4000);
  try {
    const [st, objs, saved] = await Promise.all([
      api('/api/status'), api('/api/objects'), api('/api/saved'),
    ]);
    S.conn = st;
    S.objects = { tables: objs.tables || [], views: objs.views || [], functions: objs.functions || [], triggers: objs.triggers || [] };
    S.saved = saved.queries || [];

    $('#launcher').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const pill = $('#connPill');
    pill.classList.remove('off');
    $('#connPillText').textContent = `已连接 · postgresql://${st.user}@${st.host}:${st.port}/${st.database}`;

    renderTree();
    log('ok', `已连接 ${st.host}:${st.port}/${st.database}（${st.serverVersion}）`);
    // 打开默认查询并自动执行，立即呈现操作区 + 结果区
    openQueryTab('查询 1', 'SELECT id, name, city, email, created_at\nFROM customers\nORDER BY id\nLIMIT 100;', true);
    showToast('已连接 PostgreSQL · ' + st.host + ':' + st.port);
  } catch (e) {
    showToast('连接失败：' + e.message, 4000);
    log('err', '连接失败：' + e.message);
  }
}

async function refreshObjects() {
  if (!S.conn) return;
  try {
    const [objs, saved] = await Promise.all([api('/api/objects'), api('/api/saved')]);
    S.objects = { tables: objs.tables || [], views: objs.views || [], functions: objs.functions || [], triggers: objs.triggers || [] };
    S.saved = saved.queries || [];
    renderTree();
    showToast('对象已刷新');
  } catch (e) { showToast('刷新失败：' + e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// 左侧对象树
// ══════════════════════════════════════════════════════════════════════════
function buildTreeModel() {
  const o = S.objects;
  const dbName = S.conn ? S.conn.database : 'postgres';
  const connLabel = S.conn ? `PostgreSQL@${S.conn.host}:${S.conn.port}` : 'PostgreSQL';

  const savedChildren = S.saved.map((q) => ({
    key: 'save:' + q.id, label: q.name, icon: 'query', ti: 'query',
    leaf: true, data: { kind: 'saved', name: q.name, sql: q.sql },
  }));

  const tableChildren = o.tables.map((t) => ({
    key: 'tbl:' + t.name, label: t.name, icon: 'table', ti: 'table',
    data: { kind: 'table', name: t.name },
    children: (t.columns || []).map((c) => ({
      key: 'col:' + t.name + '.' + c.name, label: c.name + '  ' + shortType(c.type), icon: 'col', ti: 'col',
      leaf: true, muted: true, data: { kind: 'column' },
    })),
  }));

  const viewChildren = o.views.map((v) => ({
    key: 'view:' + v.name, label: v.name, icon: 'view', ti: 'view', leaf: true,
    data: { kind: 'view', name: v.name },
  }));
  const funcChildren = o.functions.map((f) => ({
    key: 'fn:' + f.name + ':' + f.type, label: f.name, icon: 'func', ti: 'func', leaf: true,
    data: { kind: 'func', name: f.name, ftype: f.type },
  }));
  const trigChildren = o.triggers.map((t) => ({
    key: 'trg:' + t.name + ':' + t.table, label: `${t.name} (${t.table})`, icon: 'trig', ti: 'trig', leaf: true,
    data: { kind: 'trigger', name: t.name, table: t.table },
  }));

  return [{
    key: 'conn', label: connLabel, icon: 'database', ti: 'db', dot: true,
    children: [{
      key: 'db', label: dbName, icon: 'database', ti: 'db',
      children: [
        { key: 'grp:queries', label: '已存查询', icon: 'folder', ti: 'folder', count: savedChildren.length, children: savedChildren },
        { key: 'grp:tables', label: '表', icon: 'table', ti: 'table', count: tableChildren.length, children: tableChildren },
        { key: 'grp:views', label: '视图', icon: 'view', ti: 'view', count: viewChildren.length, children: viewChildren },
        { key: 'grp:funcs', label: '函数', icon: 'func', ti: 'func', count: funcChildren.length, children: funcChildren },
        { key: 'grp:triggers', label: '触发器', icon: 'trig', ti: 'trig', count: trigChildren.length, children: trigChildren },
      ],
    }],
  }];
}

function shortType(t) {
  if (!t) return '';
  return String(t).replace('character varying', 'varchar').replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp');
}

function renderTree() {
  const root = $('#tree');
  if (!root) return;
  const model = buildTreeModel();
  if (S.filter) {
    root.innerHTML = renderFiltered(model, S.filter.trim().toLowerCase());
    return;
  }
  root.innerHTML = renderNodes(model, 0);
}

function renderNodes(nodes, depth) {
  let html = '';
  for (const n of nodes) {
    const hasChildren = !n.leaf && n.children && n.children.length;
    const open = hasChildren && S.expanded.has(n.key);
    const isLeaf = !hasChildren;
    html += `<div class="tnode" style="padding-left:${2 + depth * 15}px" data-kind="${n.data ? n.data.kind : 'group'}" data-key="${n.key}" title="${esc(n.label)}">`
      + `<span class="chev ${open ? 'open' : ''} ${isLeaf ? 'leaf' : ''}" data-toggle="1">${ICON.chev}</span>`
      + `<span class="tico ${n.ti}">${ICON[n.icon] || ICON.folder}</span>`
      + `<span class="tn-label" style="${n.muted ? 'color:var(--text-2)' : ''}">${esc(n.label)}</span>`
      + (n.count !== undefined ? `<span class="count">(${n.count})</span>` : '')
      + (n.dot ? '<span class="dot"></span>' : '')
      + `</div>`;
    if (open) html += renderNodes(n.children, depth + 1);
    else if (hasChildren) { /* collapsed */ }
  }
  return html;
}

function renderFiltered(model, q) {
  const out = [];
  (function walk(nodes, depth) {
    for (const n of nodes) {
      if (n.data && n.data.kind && n.data.kind !== 'group' && n.data.kind !== 'column' && n.label.toLowerCase().includes(q)) {
        out.push({ ...n, _depth: depth });
      }
      if (n.children) walk(n.children, depth + 1);
    }
  })(model, 0);
  if (!out.length) return '<div style="color:var(--text-3);padding:10px 12px;font-size:12px">未找到匹配项</div>';
  return out.map((n) =>
    `<div class="tnode" style="padding-left:${8}px" data-kind="${n.data.kind}" data-key="${n.key}" title="${esc(n.label)}">`
    + `<span class="chev leaf">${ICON.chev}</span><span class="tico ${n.ti}">${ICON[n.icon]}</span>`
    + `<span class="tn-label">${esc(n.label)}</span></div>`
  ).join('');
}

function findNode(nodes, key) {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.children) { const r = findNode(n.children, key); if (r) return r; }
  }
  return null;
}

function onTreeClick(e) {
  const row = e.target.closest('.tnode');
  if (!row) return;
  const key = row.dataset.key;
  const nodes = buildTreeModel();
  const node = findNode(nodes, key);
  if (!node) return;
  const d = node.data || {};
  const actionable = ['saved', 'table', 'view', 'func', 'trigger'].indexOf(d.kind) >= 0;
  const chev = e.target.closest('.chev');
  const hasChildren = !node.leaf && node.children && node.children.length;

  // 点击展开箭头：只在有子节点时切换展开
  if (chev && !chev.classList.contains('leaf')) {
    if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
    renderTree();
    return;
  }
  // 点击对象节点（表/视图/已存查询/函数/触发器）的标签：打开对应标签页
  if (actionable) {
    if (d.kind === 'saved') openQueryTab(d.name, d.sql, true);
    else if (d.kind === 'table') openObjectTab('table', d.name);
    else if (d.kind === 'view') openObjectTab('view', d.name);
    else if (d.kind === 'func') openFunctionTab(d.name, d.ftype);
    else if (d.kind === 'trigger') openTriggerTab(d.name, d.table);
    return;
  }
  // 其余（连接 / 数据库 / 分组）：有子节点则切换展开
  if (hasChildren) {
    if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
    renderTree();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 标签页
// ══════════════════════════════════════════════════════════════════════════
function getActive() { return S.tabs.find((t) => t.id === S.activeId) || null; }

function addTab(tab) {
  // 结果区编辑/事务所需的暂存状态（切换标签页后仍保留）
  tab.added = [];
  tab.modified = {};
  tab.deleted = new Set();
  tab.selected = new Set();
  tab.viewMode = 'table';
  tab.cellEditMode = false;
  tab._seq = 0;
  tab.textIndex = 0;
  if (tab.tableName === undefined) tab.tableName = null;
  if (tab.meta === undefined) tab.meta = null;
  S.tabs.push(tab);
  S.activeId = tab.id;
  renderTabs();
  renderWorkspace();
  return tab;
}

function openQueryTab(title, sql, autoRun) {
  const id = 'tab' + (++S.seq);
  const tab = addTab({ id, title: title || '查询', kind: 'query', sql: sql || '', columns: [], rows: [], ran: false, loading: false, error: null, command: '', durationMs: 0, rowCount: 0 });
  if (autoRun) runTab(tab.id);
}

function openObjectTab(kind, name) {
  const sql = `SELECT *\nFROM ${name}\nLIMIT 200;`;
  const id = 'tab' + (++S.seq);
  const tbl = kind === 'table' ? S.objects.tables.find((t) => t.name === name) : null;
  const tab = addTab({
    id, title: name, kind, sql, columns: [], rows: [], ran: false, loading: false, error: null, command: '', durationMs: 0, rowCount: 0,
    tableName: kind === 'table' ? name : null,
    meta: tbl ? tbl.columns : null,
  });
  runTab(tab.id);
}

function openFunctionTab(name, ftype) {
  const sql = `-- 函数：${name}（${ftype || 'FUNCTION'}）\n-- 查看定义 / 调用示例，可自行修改后运行\nSELECT routine_definition\nFROM information_schema.routines\nWHERE routine_schema='public' AND routine_name='${name}';`;
  const id = 'tab' + (++S.seq);
  const tab = addTab({ id, title: '函数: ' + name, kind: 'func', sql, columns: [], rows: [], ran: false, loading: false, error: null, command: '', durationMs: 0, rowCount: 0 });
  runTab(tab.id);
}

function openTriggerTab(name, table) {
  const sql = `-- 触发器：${name}（表 ${table}）\nSELECT trigger_name, event_manipulation, event_object_table, action_timing\nFROM information_schema.triggers\nWHERE trigger_schema='public' AND trigger_name='${name}';`;
  const id = 'tab' + (++S.seq);
  const tab = addTab({ id, title: '触发器: ' + name, kind: 'trigger', sql, columns: [], rows: [], ran: false, loading: false, error: null, command: '', durationMs: 0, rowCount: 0 });
  runTab(tab.id);
}

function closeTab(id) {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  if (S.activeId === id) S.activeId = S.tabs.length ? S.tabs[Math.max(0, i - 1)].id : null;
  renderTabs();
  renderWorkspace();
}
function switchTab(id) { S.activeId = id; renderTabs(); renderWorkspace(); }

function tabIcon(kind) {
  return { table: 'table', view: 'view', func: 'func', trigger: 'trig', query: 'query' }[kind] || 'query';
}
function tabIconTi(kind) {
  return { table: 'table', view: 'view', func: 'func', trigger: 'trig', query: 'query' }[kind] || 'query';
}

function renderTabs() {
  const bar = $('#tabbar');
  if (!bar) return;
  bar.innerHTML = S.tabs.map((t) =>
    `<div class="tab ${t.id === S.activeId ? 'active' : ''}" data-id="${t.id}">`
    + `<span class="tico ${tabIconTi(t.kind)}">${ICON[tabIcon(t.kind)]}</span>`
    + `<span class="tlabel">${esc(t.title)}</span>`
    + `<span class="tclose" data-close="${t.id}">✕</span></div>`
  ).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// 工作区（操作区 + 结果区）
// ══════════════════════════════════════════════════════════════════════════
function welcomeHTML() {
  return `<div class="wtab">
    <div class="biglogo">G</div>
    <h2>GoNavi · PostgreSQL</h2>
    <p>从左侧选择表 / 视图 / 已存查询，或点击「新建查询」开始</p>
    <p>在编辑器中按 <span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> 执行 SQL</p>
  </div>`;
}

function tabPaneHTML(tab) {
  return `<div class="tabpane">
    <div class="op-area">
      <div class="op-toolbar">
        <button class="btn primary" id="btnRun">▶ 运行</button>
        <button class="btn" id="btnFormat">格式化</button>
        <button class="btn" id="btnSaveQ">保存查询</button>
        <div class="spacer tb-flex"></div>
        <span class="db-hint">${esc(S.conn ? S.conn.database : 'postgres')} · public</span>
      </div>
      <div class="editor">
        <div class="gutter" id="gutter"></div>
        <div class="code-wrap">
          <pre class="hl" id="hl"><code id="hlCode"></code></pre>
          <textarea id="sqlEditor" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
        </div>
      </div>
    </div>
    <div class="res-area">
      <div class="res-toolbar" id="resToolbar"></div>
      <div class="res-body" id="resBody"></div>
      <div class="status-bar" id="statusBar"></div>
    </div>
  </div>`;
}

function renderWorkspace() {
  const ws = $('#workspace');
  if (!ws) return;
  const tab = getActive();
  if (!tab) { ws.innerHTML = welcomeHTML(); return; }
  ws.innerHTML = tabPaneHTML(tab);
  const ta = $('#sqlEditor');
  if (!ta) return;
  ta.value = tab.sql;
  syncEditor(ta);
  ta.addEventListener('input', () => { tab.sql = ta.value; syncEditor(ta); });
  ta.addEventListener('scroll', () => syncScroll(ta));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runTab(tab.id); }
  });
  $('#btnRun').addEventListener('click', () => runTab(tab.id));
  $('#btnFormat').addEventListener('click', () => { ta.value = formatSQL(ta.value); tab.sql = ta.value; syncEditor(ta); });
  $('#btnSaveQ').addEventListener('click', () => saveQuery(tab));
  renderResult(tab);
  ta.focus();
}

function syncScroll(ta) {
  const hl = $('#hl'); const gutter = $('#gutter');
  if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
  if (gutter) { gutter.scrollTop = ta.scrollTop; }
}
function syncEditor(ta) {
  const code = $('#hlCode'); const gutter = $('#gutter');
  if (code) code.innerHTML = highlightSQL(ta.value) + '\n';
  if (gutter) {
    const n = ta.value.split('\n').length;
    let g = '';
    for (let i = 1; i <= n; i++) g += i + '\n';
    gutter.textContent = g;
  }
  syncScroll(ta);
}

// ── 语法高亮 ─────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function highlightSQL(sql) {
  const rx = /(\/\*[\s\S]*?\*\/)|(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = '', last = 0, m;
  while ((m = rx.exec(sql))) {
    out += esc(sql.slice(last, m.index));
    if (m[1] || m[2]) out += '<span class="tok-com">' + esc(m[0]) + '</span>';
    else if (m[3]) out += '<span class="tok-str">' + esc(m[0]) + '</span>';
    else if (m[4]) out += '<span class="tok-num">' + esc(m[0]) + '</span>';
    else if (m[5]) {
      const w = m[5];
      if (KWSET.has(w.toUpperCase())) out += '<span class="tok-kw">' + esc(w) + '</span>';
      else out += esc(w);
    }
    last = rx.lastIndex;
  }
  out += esc(sql.slice(last));
  return out;
}

function formatSQL(sql) {
  // 极简格式化：压缩多余空行、关键字大写
  return sql.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── 执行 ─────────────────────────────────────────────────────────────────
async function runTab(id) {
  const tab = S.tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.loading = true; tab.error = null;
  if (S.activeId === id) renderResult(tab);
  const started = performance.now();
  try {
    const data = await api('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: tab.sql }),
    });
    tab.loading = false;
    if (data.error) {
      tab.error = data.error; tab.ran = true; tab.columns = []; tab.rows = [];
      log('err', `${tab.title}: ${data.error}`);
    } else {
      tab.columns = data.columns || [];
      tab.rows = data.rows || [];
      tab.command = data.command || '';
      tab.rowCount = data.rowCount == null ? (data.rows ? data.rows.length : 0) : data.rowCount;
      tab.durationMs = data.durationMs != null ? data.durationMs : Math.round(performance.now() - started);
      tab.ran = true;
      log('ok', `${tab.title}: ${tab.command || 'OK'} · ${tab.rows.length} 行 · ${tab.durationMs} ms`);
    }
  } catch (e) {
    tab.loading = false; tab.error = e.message; tab.ran = true;
    log('err', `${tab.title}: ${e.message}`);
  }
  if (S.activeId === id) { renderResult(tab); $('#statusBar'); }
}

function gridHTML(tab) {
  const cols = tab.columns;
  let head = '<tr><th class="rownum">#</th>';
  for (const c of cols) head += `<th>${esc(c)}</th>`;
  head += '</tr>';
  let body = '';
  for (let i = 0; i < tab.rows.length; i++) {
    const row = tab.rows[i];
    body += `<tr><td class="rownum">${i + 1}</td>`;
    for (let j = 0; j < cols.length; j++) {
      const v = row[j];
      if (v === null || v === undefined) body += '<td class="null">NULL</td>';
      else if (/^-?\d+(\.\d+)?$/.test(v)) body += `<td class="num">${esc(v)}</td>`;
      else body += `<td title="${esc(v)}">${esc(v)}</td>`;
    }
    body += '</tr>';
  }
  return `<div class="grid-wrap"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function renderResult(tab) {
  const toolbar = $('#resToolbar'), body = $('#resBody'), status = $('#statusBar');
  if (!body) return;
  // 结果区交由 DataGrid 组件渲染（工具栏 / 视图 / 网格 / 状态栏）
  if (window.DataGrid && (tab.columns || tab.error || tab.loading)) {
    window.DataGrid.mount(tab, { toolbar: toolbar, body: body, status: status }, { onReload: () => runTab(tab.id) });
  }
}

function saveQuery(tab) {
  const name = prompt('保存查询名称：', tab.title || '未命名查询');
  if (!name) return;
  S.saved.push({ id: 'local' + Date.now(), name, sql: tab.sql });
  renderTree();
  showToast('已保存查询：' + name);
  log('ok', '保存查询：' + name);
}

// ══════════════════════════════════════════════════════════════════════════
// 事件绑定
// ══════════════════════════════════════════════════════════════════════════
function bind() {
  $('#btnPostgres').addEventListener('click', connect);
  $('#tbPostgres').addEventListener('click', () => { if (!S.conn) connect(); else showToast('PostgreSQL 已连接'); });
  $('#btnNewQuery').addEventListener('click', () => openQueryTab('查询 ' + (S.tabs.length + 1), 'SELECT * FROM customers LIMIT 100;', true));
  $('#btnRefresh').addEventListener('click', refreshObjects);
  $('#btnNewConn').addEventListener('click', () => showToast('演示环境已内置 PostgreSQL 连接'));
  $('#tree').addEventListener('click', onTreeClick);
  $('#treeSearch').addEventListener('input', (e) => { S.filter = e.target.value; renderTree(); });

  $('#btnLog').addEventListener('click', () => $('#logDrawer').classList.toggle('hidden'));
  $('#logClose').addEventListener('click', () => $('#logDrawer').classList.add('hidden'));

  ['tbTools', 'tbProxy', 'tbTheme', 'tbAbout'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('click', () => showToast('演示版：' + el.textContent.trim() + '（暂未实现）'));
  });

  $('#tabbar').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { e.stopPropagation(); closeTab(close.dataset.close); return; }
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.id);
  });

  // 图标注入启动页 PostgreSQL 图标
  const pgIco = $('#pgIco');
  if (pgIco) pgIco.innerHTML = ICON.database;
  // 工具栏图标 / 新建查询图标
  document.querySelectorAll('.tb-i').forEach((el) => { el.innerHTML = ICON[el.dataset.ico] || ''; });
  const nq = $('#newQueryIco');
  if (nq) nq.innerHTML = ICON.query;
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  // 深链：?auto=1 时自动连接
  const params = new URLSearchParams(location.search);
  if (params.get('auto') === '1') connect();
});
