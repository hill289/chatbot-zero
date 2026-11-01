'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   GoNavi · DataGrid 结果区（移植自 GoNavi-0.5.0 DataGrid）
   功能：刷新 / 导入 / 导出(CSV·JSON·Markdown) / 添加行 / 编辑行 / 删除选中 /
         单元格编辑器 / 提交事务(写库, 原子) / 回滚 / 字段信息 / 表格·JSON·文本 视图
   依赖 app.js 暴露的全局：esc / api / showToast / log / ICON
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  const G = (window.DataGrid = {});
  let cur = { tab: null, els: null, onReload: function () {} };
  let overlay = null, __float = null;

  // ── 小工具 ──────────────────────────────────────────────────────────────
  function rkField(tab) { return tab.pk || (tab.columns.includes('id') ? 'id' : tab.columns[0]); }
  function rkOf(tab, o) { const pk = rkField(tab); const v = o[pk]; return (v === null || v === undefined) ? null : String(v); }
  function cleanObj(o) { const r = {}; for (const k in o) { if (k === '__rk' || k === '__added' || k === '__deleted') continue; r[k] = o[k]; } return r; }
  function shortType(t) { return String(t || '').replace('character varying', 'varchar').replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp'); }

  // 日期/时间值归一化：
  //   · PGlite/Better drivers 会把 timestamp/date 列返回成 JS Date 对象，若直接渲染或放进编辑器，
  //     会显示成 "Sat Oct 24 2026 14:18:06 GMT+0800 (中国标准时间)"，且提交时数据库无法解析 → 表现为“无法修改”。
  //   · 带时区/毫秒的字符串（2026-10-24T14:18:06.123Z、2026-10-24 14:18:06+08:00 等）统一成
  //     "YYYY-MM-DD HH:mm:ss"，与 GoNavi 结果区展示一致。
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isDateObject(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function normalizeDateTimeValue(v) {
    if (isDateObject(v)) {
      if (isNaN(v.getTime())) return String(v);
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate())
        + ' ' + pad2(v.getHours()) + ':' + pad2(v.getMinutes()) + ':' + pad2(v.getSeconds());
    }
    if (typeof v === 'string') {
      if (/^0{4}-0{2}-0{2}/.test(v)) return v; // 0000-00-00 之类的无效日期保持原样
      const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}(?::?\d{2})?)(?:\s+[A-Za-z_\/+-]+)?)?$/);
      if (m) return m[1] + ' ' + m[2];
    }
    return v;
  }

  function baseRows(tab) {
    const pk = rkField(tab);
    return tab.rows.map(function (arr) {
      const o = {}; tab.columns.forEach(function (c, j) { o[c] = normalizeDateTimeValue(arr[j]); });
      o.__rk = rkOf(tab, o); return o;
    });
  }
  function displayRows(tab) {
    const base = baseRows(tab);
    base.forEach(function (o) {
      if (o.__rk != null && tab.modified[o.__rk]) Object.assign(o, tab.modified[o.__rk]);
      o.__deleted = o.__rk != null && tab.deleted.has(o.__rk);
    });
    const added = tab.added.map(function (o) { return Object.assign({}, o, { __added: true, __deleted: false }); });
    return base.concat(added);
  }
  function changeCount(tab) { return tab.added.length + Object.keys(tab.modified).length + tab.deleted.size; }

  // ── 工具栏 ──────────────────────────────────────────────────────────────
  function toolbarHTML(tab) {
    const canModify = !!tab.tableName;
    const sel = tab.selected.size;
    const seg = tab.viewMode;
    const n = changeCount(tab);
    let h = '<div class="dg-toolbar">';
    h += '<button class="dg-btn" data-act="refresh">⟳ 刷新</button>';
    if (canModify) h += '<button class="dg-btn" data-act="import">⭳ 导入</button>';
    h += '<button class="dg-btn" data-act="export">⭱ 导出 ▾</button>';
    h += '<span class="dg-sep"></span>';
    if (canModify) {
      h += '<button class="dg-btn" data-act="addrow">＋ 添加行</button>';
      h += '<button class="dg-btn" data-act="editrow" ' + (sel === 1 ? '' : 'disabled') + '>✎ 编辑行</button>';
      h += '<button class="dg-btn danger" data-act="delrow" ' + (sel > 0 ? '' : 'disabled') + '>🗑 删除选中</button>';
      if (sel > 0) h += '<span class="dg-hint">已选 ' + sel + '</span>';
      h += '<span class="dg-sep"></span>';
      h += '<button class="dg-btn ' + (tab.cellEditMode ? 'active' : '') + '" data-act="cellmode">▦ 单元格编辑器</button>';
      h += '<span class="dg-sep"></span>';
    }
    h += '<button class="dg-btn primary" data-act="commit" ' + (canModify && n > 0 ? '' : 'disabled') + '>✓ 提交事务 (' + n + ')</button>';
    if (canModify && n > 0) h += '<button class="dg-btn" data-act="rollback">↺ 回滚</button>';
    h += '<div class="dg-flex"></div>';
    h += '<button class="dg-btn" data-act="fields">▤ 字段信息</button>';
    h += '<div class="dg-seg">'
      + '<button class="' + (seg === 'table' ? 'on' : '') + '" data-act="view" data-v="table">表格</button>'
      + '<button class="' + (seg === 'json' ? 'on' : '') + '" data-act="view" data-v="json">JSON</button>'
      + '<button class="' + (seg === 'text' ? 'on' : '') + '" data-act="view" data-v="text">文本</button>'
      + '</div>';
    h += '</div>';
    return h;
  }

  // ── 视图 ────────────────────────────────────────────────────────────────
  function bodyHTML(tab) {
    if (tab.loading) return '<div class="res-empty">正在执行…</div>';
    if (tab.error) return '<div class="res-error">执行失败：\n' + esc(tab.error) + '</div>';
    if (!tab.ran) return '<div class="res-empty">运行 SQL 查看结果　<span class="kbd">Ctrl</span> + <span class="kbd">Enter</span></div>';
    if (!tab.columns.length) return '<div class="res-empty">命令已执行：' + esc(tab.command || 'OK') + '</div>';
    if (tab.viewMode === 'json') return jsonHTML(tab);
    if (tab.viewMode === 'text') return textHTML(tab);
    return tableHTML(tab);
  }

  function tableHTML(tab) {
    const rows = displayRows(tab);
    const selectable = rows.filter(function (r) { return r.__rk != null && !r.__deleted; });
    const allSel = selectable.length > 0 && selectable.every(function (r) { return tab.selected.has(r.__rk); });
    let h = '<div class="grid-wrap"><table class="grid dg-grid"><thead><tr>';
    h += '<th class="dg-check"><input type="checkbox" data-act="selall" ' + (allSel ? 'checked' : '') + '></th>';
    h += '<th class="rownum">#</th>';
    tab.columns.forEach(function (c) { h += '<th>' + esc(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r, idx) {
      const sel = r.__rk != null && tab.selected.has(r.__rk);
      const cls = (r.__added ? ' dg-added' : '') + (r.__deleted ? ' dg-del' : '') + (sel ? ' dg-sel' : '');
      h += '<tr class="' + cls.trim() + '"' + (r.__rk != null ? ' data-rk="' + esc(r.__rk) + '"' : '') + '>';
      h += '<td class="dg-check"><input type="checkbox" data-act="rowcheck" ' + (sel ? 'checked' : '') + (r.__deleted ? ' disabled' : '') + '></td>';
      h += '<td class="rownum">' + (idx + 1) + '</td>';
      tab.columns.forEach(function (c) {
        const v = r[c];
        const rkattr = r.__rk != null ? (' data-rk="' + esc(r.__rk) + '"') : '';
        const colattr = ' data-col="' + esc(c) + '"';
        if (v === null || v === undefined) h += '<td class="dg-cell null"' + rkattr + colattr + '>NULL</td>';
        else if (/^-?\d+(\.\d+)?$/.test(String(v))) h += '<td class="dg-cell num"' + rkattr + colattr + '>' + esc(v) + '</td>';
        else h += '<td class="dg-cell"' + rkattr + colattr + ' title="' + esc(v) + '">' + esc(v) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  function jsonHTML(tab) {
    const rows = displayRows(tab).map(cleanObj);
    const txt = JSON.stringify(rows, null, 2);
    return '<div class="dg-jsonbar"><button class="dg-btn" data-act="editjson">编辑 JSON</button><button class="dg-btn" data-act="copyjson">复制</button><span class="dg-hint">只读预览，可点「编辑 JSON」批量修改</span></div><pre class="dg-json">' + esc(txt) + '</pre>';
  }

  function textHTML(tab) {
    const rows = displayRows(tab);
    if (!rows.length) return '<div class="res-empty">无记录</div>';
    let i = tab.textIndex || 0; if (i >= rows.length) i = rows.length - 1; if (i < 0) i = 0;
    const r = rows[i];
    let h = '<div class="dg-textbar"><button class="dg-btn" data-act="prev"' + (i <= 0 ? ' disabled' : '') + '>‹ 上一条</button><span class="dg-hint">' + (i + 1) + ' / ' + rows.length + '</span><button class="dg-btn" data-act="next"' + (i >= rows.length - 1 ? ' disabled' : '') + '>下一条 ›</button>';
    if (tab.tableName) h += '<button class="dg-btn" data-act="editrow">✎ 编辑本行</button>';
    h += '</div><div class="dg-text">';
    tab.columns.forEach(function (c) {
      const v = r[c];
      h += '<div class="dg-trow"><div class="dg-tkey">' + esc(c) + '</div><div class="dg-tval">' + (v === null || v === undefined ? '<span class="null">NULL</span>' : esc(typeof v === 'object' ? JSON.stringify(v) : v)) + '</div></div>';
    });
    h += '</div>';
    return h;
  }

  function statusHTML(tab) {
    if (tab.loading) return '加载中…';
    if (tab.error) return '<span class="err">执行失败</span>';
    if (!tab.ran) return '';
    let s = '命令 <b>' + esc(tab.command || 'OK') + '</b>　·　' + tab.rows.length + ' 行　·　' + (tab.durationMs || 0) + ' ms';
    if (changeCount(tab) > 0) s += '　·　<span class="dg-warn">未提交：+' + tab.added.length + ' ~' + Object.keys(tab.modified).length + ' -' + tab.deleted.size + '</span>';
    if (tab.tableName) s += '　·　表 ' + esc(tab.tableName);
    return s;
  }

  function render() {
    const tab = cur.tab, els = cur.els;
    if (!tab || !els) return;
    els.toolbar.innerHTML = toolbarHTML(tab);
    els.body.innerHTML = bodyHTML(tab);
    els.status.innerHTML = statusHTML(tab);
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  function onActClick(e) { const b = e.target.closest('[data-act]'); if (b) onAct(b); }
  function onBodyClick(e) {
    const b = e.target.closest('[data-act]');
    if (b) { onAct(b); return; }
    const cell = e.target.closest('.dg-cell');
    if (cell && cur.tab.cellEditMode) { openCellModal(cell.dataset.rk, cell.dataset.col); return; }
    const tr = e.target.closest('tr[data-rk]');
    if (tr) toggleSelect(tr.dataset.rk);
  }
  function onBodyDbl(e) { const cell = e.target.closest('.dg-cell'); if (cell) openCellModal(cell.dataset.rk, cell.dataset.col); }

  function onAct(b) {
    const tab = cur.tab, act = b.dataset.act;
    switch (act) {
      case 'refresh': tab.textIndex = 0; tab.added = []; tab.modified = {}; tab.deleted = new Set(); tab.selected = new Set(); cur.onReload(); break;
      case 'import': importData(tab); break;
      case 'export': openExportMenu(b, tab); break;
      case 'addrow': openRowModal('insert', null); break;
      case 'editrow': doEditRow(); break;
      case 'delrow': deleteSelected(); break;
      case 'cellmode': tab.cellEditMode = !tab.cellEditMode; showToast(tab.cellEditMode ? '已进入单元格编辑模式（单击单元格即可编辑）' : '已退出单元格编辑模式'); render(); break;
      case 'commit': commit(); break;
      case 'rollback': rollback(); break;
      case 'fields': openFieldsPopover(b); break;
      case 'view': setView(b.dataset.v); break;
      case 'selall': toggleAll(); break;
      case 'rowcheck': { const tr = b.closest('tr'); if (tr) toggleSelect(tr.dataset.rk); } break;
      case 'editjson': openJsonEdit(tab); break;
      case 'copyjson': copyText(JSON.stringify(displayRows(tab).map(cleanObj), null, 2)); break;
      case 'prev': tab.textIndex = Math.max(0, (tab.textIndex || 0) - 1); render(); break;
      case 'next': { const n = displayRows(tab).length; tab.textIndex = Math.min(n - 1, (tab.textIndex || 0) + 1); render(); break; }
    }
  }

  function setView(v) {
    const tab = cur.tab;
    if (v === 'text') { const sel = Array.from(tab.selected)[0]; if (sel != null) { const rows = displayRows(tab); const idx = rows.findIndex(function (r) { return String(r.__rk) === String(sel); }); if (idx >= 0) tab.textIndex = idx; } }
    tab.viewMode = v; render();
  }
  function toggleSelect(rk) { if (rk == null) return; const tab = cur.tab; if (tab.selected.has(rk)) tab.selected.delete(rk); else tab.selected.add(rk); render(); }
  function toggleAll() {
    const tab = cur.tab; const rows = displayRows(tab).filter(function (r) { return r.__rk != null && !r.__deleted; });
    const allSel = rows.length > 0 && rows.every(function (r) { return tab.selected.has(r.__rk); });
    if (allSel) rows.forEach(function (r) { tab.selected.delete(r.__rk); }); else rows.forEach(function (r) { tab.selected.add(r.__rk); });
    render();
  }
  function deleteSelected() {
    const tab = cur.tab; const sel = Array.from(tab.selected); if (!sel.length) return;
    sel.forEach(function (rk) {
      if (String(rk).indexOf('new:') === 0) tab.added = tab.added.filter(function (o) { return String(o.__rk) !== String(rk); });
      else { tab.deleted.add(rk); delete tab.modified[rk]; }
    });
    tab.selected = new Set(); render(); showToast('已标记删除 ' + sel.length + ' 行（未提交）');
  }
  function doEditRow() {
    const tab = cur.tab; const sel = Array.from(tab.selected);
    if (sel.length !== 1) { showToast('请勾选一行再编辑'); return; }
    const rows = displayRows(tab); const row = rows.find(function (r) { return String(r.__rk) === String(sel[0]); });
    if (!row) { showToast('未找到该行，请刷新'); return; }
    openRowModal('edit', row);
  }
  async function commit() {
    const tab = cur.tab; if (!tab.tableName) return;
    const pk = rkField(tab);
    const inserts = tab.added.map(function (o) { return cleanObj(o); });
    const updates = Object.keys(tab.modified).map(function (rk) { return { pkValue: rk, changes: tab.modified[rk] }; });
    const deletes = Array.from(tab.deleted).map(function (rk) { return { pkValue: rk }; });
    try {
      const res = await api('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: tab.tableName, pk: pk, inserts: inserts, updates: updates, deletes: deletes }) });
      if (res.error) { showToast('提交失败：' + res.error, 4000); return; }
      showToast('事务提交成功：' + JSON.stringify(res.counts));
      log('ok', '提交事务 ' + tab.tableName + ' ' + JSON.stringify(res.counts));
      tab.added = []; tab.modified = {}; tab.deleted = new Set(); tab.selected = new Set();
      cur.onReload();
    } catch (e) { showToast('提交失败：' + e.message, 4000); }
  }
  function rollback() {
    const tab = cur.tab; tab.added = []; tab.modified = {}; tab.deleted = new Set(); tab.selected = new Set();
    render(); showToast('已回滚未提交的修改');
  }

  // ── 弹窗 ────────────────────────────────────────────────────────────────
  function closeModal() { if (overlay) { overlay.remove(); overlay = null; } }
  function openModal(title, bodyHtml, buttons) {
    closeModal();
    overlay = document.createElement('div'); overlay.className = 'dg-overlay';
    const btnHtml = buttons.map(function (b, i) { return '<button class="dg-btn ' + (b.cls || '') + '" data-i="' + i + '">' + b.label + '</button>'; }).join('');
    overlay.innerHTML = '<div class="dg-modal"><div class="dg-modal-head"><span>' + title + '</span><span class="dg-x" data-close="1">✕</span></div><div class="dg-modal-body">' + bodyHtml + '</div><div class="dg-modal-foot">' + btnHtml + '</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.getAttribute('data-close')) { closeModal(); return; }
      const btn = e.target.closest('[data-i]'); if (btn) { buttons[+btn.dataset.i].onClick(overlay); }
    });
    return overlay;
  }

  function openRowModal(mode, row) {
    const tab = cur.tab;
    let body = '<div class="dg-form">';
    tab.columns.forEach(function (c) {
      let v = row ? row[c] : '';
      if (v === null || v === undefined) v = '';
      body += '<label class="dg-fld"><span>' + esc(c) + '</span><textarea data-col="' + esc(c) + '" rows="' + (String(v).length > 40 ? 3 : 1) + '">' + esc(v) + '</textarea></label>';
    });
    body += mode === 'insert' ? '<div class="dg-hint">留空的字段将使用数据库默认值 / NULL</div>' : '';
    body += '</div>';
    openModal(mode === 'insert' ? '添加行' : ('编辑行 · ' + esc(tab.tableName || '')), body, [
      { label: '取消', onClick: closeModal },
      {
        label: '保存', cls: 'primary', onClick: function (ov) {
          const fields = Array.prototype.slice.call(ov.querySelectorAll('textarea[data-col]'));
          if (mode === 'insert') {
            const obj = { __rk: 'new:' + (++tab._seq) };
            fields.forEach(function (f) { const val = f.value; if (val !== '') obj[f.dataset.col] = val; });
            tab.added.push(obj);
          } else {
            fields.forEach(function (f) {
              const col = f.dataset.col; const nv = f.value; const ovv = row[col];
              const nvs = nv === '' ? null : nv; const ovs = (ovv === null || ovv === undefined) ? null : String(ovv);
              if (String(nvs) !== String(ovs)) { tab.modified[row.__rk] = tab.modified[row.__rk] || {}; tab.modified[row.__rk][col] = nvs; }
            });
          }
          closeModal(); render();
        }
      }
    ]);
  }

  function saveCell(rk, col, val) {
    const tab = cur.tab;
    if (String(rk).indexOf('new:') === 0) { const a = tab.added.find(function (o) { return String(o.__rk) === String(rk); }); if (a) a[col] = val; }
    else { tab.modified[rk] = tab.modified[rk] || {}; tab.modified[rk][col] = val; }
    render();
  }
  function openCellModal(rk, col) {
    const tab = cur.tab; const rows = displayRows(tab); const row = rows.find(function (r) { return String(r.__rk) === String(rk); });
    let v = row ? row[col] : ''; if (v === null || v === undefined) v = '';
    const isJson = typeof v === 'string' && /^\s*[\[{]/.test(v);
    const body = '<textarea class="dg-cell-input" data-val="1" rows="10">' + esc(v) + '</textarea>'
      + '<div class="dg-cell-ops"><button class="dg-btn" data-setnull="1">设为 NULL</button>' + (isJson ? '<button class="dg-btn" data-fmtjson="1">格式化 JSON</button>' : '') + '</div>';
    const ov = openModal('编辑单元格 · ' + esc(col), body, [
      { label: '取消', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: function (o) { const ta = o.querySelector('[data-val]'); const val = ta.value; saveCell(rk, col, val === '' ? null : val); closeModal(); } }
    ]);
    ov.querySelector('[data-setnull]').onclick = function () { saveCell(rk, col, null); closeModal(); };
    const fj = ov.querySelector('[data-fmtjson]'); if (fj) fj.onclick = function () { const ta = ov.querySelector('[data-val]'); try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { showToast('JSON 无效：' + e.message); } };
  }

  function openJsonEdit(tab) {
    const rows = displayRows(tab); const clean = rows.map(cleanObj);
    const body = '<textarea class="dg-cell-input" data-val="1" rows="18">' + esc(JSON.stringify(clean, null, 2)) + '</textarea>';
    openModal('编辑 JSON（数组，每项一条记录）', body, [
      { label: '取消', onClick: closeModal },
      {
        label: '应用', cls: 'primary', onClick: function (ov) {
          let arr;
          try { arr = JSON.parse(ov.querySelector('[data-val]').value); } catch (e) { showToast('JSON 解析失败：' + e.message, 4000); return; }
          if (!Array.isArray(arr)) { showToast('JSON 必须是数组'); return; }
          if (arr.length !== rows.length) { showToast('记录条数不一致：界面 ' + rows.length + ' 条，JSON ' + arr.length + ' 条'); return; }
          for (let i = 0; i < arr.length; i++) {
            const cr = rows[i], nx = arr[i] || {};
            if (String(cr.__rk).indexOf('new:') === 0) { const a = tab.added.find(function (o) { return String(o.__rk) === String(cr.__rk); }); if (a) tab.columns.forEach(function (c) { if (Object.prototype.hasOwnProperty.call(nx, c)) a[c] = nx[c]; }); }
            else tab.columns.forEach(function (c) {
              if (!Object.prototype.hasOwnProperty.call(nx, c)) return;
              const nv = nx[c], ovv = cr[c]; const a = (nv == null ? null : String(nv)), b = (ovv == null ? null : String(ovv));
              if (a !== b) { tab.modified[cr.__rk] = tab.modified[cr.__rk] || {}; tab.modified[cr.__rk][c] = nv; }
            });
          }
          closeModal(); render(); showToast('已应用到结果集，可继续「提交事务」');
        }
      }
    ]);
  }

  // ── 字段信息 / 浮层 ─────────────────────────────────────────────────────
  function closeFloating() { if (__float) { __float.remove(); __float = null; } }
  function floating(anchor, html) {
    closeFloating();
    const d = document.createElement('div'); d.className = 'dg-float'; d.innerHTML = html;
    document.body.appendChild(d);
    const r = anchor.getBoundingClientRect();
    d.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 280)) + 'px';
    d.style.top = (r.bottom + 4) + 'px';
    __float = d;
    setTimeout(function () { const h = function (ev) { if (d && !d.contains(ev.target)) { closeFloating(); document.removeEventListener('mousedown', h); } }; document.addEventListener('mousedown', h); }, 0);
    return d;
  }
  function openFieldsPopover(anchor) {
    const tab = cur.tab;
    let cols;
    if (tab.meta && tab.meta.length) cols = tab.meta.map(function (c) { return { name: c.name, type: c.type, nullable: c.nullable }; });
    else cols = tab.columns.map(function (c) { return { name: c, type: '', nullable: '' }; });
    const html = '<div class="dg-fields"><div class="dg-fhead">字段信息 · ' + cols.length + ' 列</div>' + cols.map(function (c) {
      return '<div class="dg-frow"><span class="dg-fname">' + esc(c.name) + '</span><span class="dg-ftype">' + esc(shortType(c.type)) + (c.nullable === 'NO' ? ' · NOT NULL' : '') + '</span></div>';
    }).join('') + '</div>';
    floating(anchor, html);
  }

  // ── 导入 / 导出 / 复制 ──────────────────────────────────────────────────
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { showToast('已复制到剪贴板'); }, function () { showToast('复制失败'); });
    else showToast('当前环境不支持复制');
  }
  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }
  function csvCell(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportAs(kind, tab, rows) {
    const base = (tab.tableName || tab.title || 'result').replace(/[^\w.-]+/g, '_');
    if (kind === 'csv') {
      const header = tab.columns.join(',');
      const body = rows.map(function (r) { return tab.columns.map(function (c) { return csvCell(r[c]); }).join(','); }).join('\n');
      download(base + '.csv', '\ufeff' + header + '\n' + body, 'text/csv;charset=utf-8');
    } else if (kind === 'json') {
      download(base + '.json', JSON.stringify(rows, null, 2), 'application/json');
    } else {
      const head = '| ' + tab.columns.join(' | ') + ' |';
      const sep = '| ' + tab.columns.map(function () { return '---'; }).join(' | ') + ' |';
      const body = rows.map(function (r) { return '| ' + tab.columns.map(function (c) { return String(r[c] == null ? '' : r[c]).replace(/\|/g, '\\|'); }).join(' | ') + ' |'; }).join('\n');
      download(base + '.md', head + '\n' + sep + '\n' + body, 'text/markdown');
    }
    showToast('已导出 ' + rows.length + ' 行（' + kind.toUpperCase() + '）');
  }
  function openExportMenu(anchor, tab) {
    const rows = displayRows(tab).map(cleanObj);
    const menu = floating(anchor, '<div class="dg-menu"><div data-exp="csv">导出 CSV</div><div data-exp="json">导出 JSON</div><div data-exp="md">导出 Markdown</div></div>');
    menu.addEventListener('click', function (e) { const el = e.target.closest('[data-exp]'); if (!el) return; exportAs(el.dataset.exp, tab, rows); closeFloating(); });
  }
  function splitCSVLine(line) {
    const res = []; let curS = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { curS += '"'; i++; } else q = false; } else curS += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { res.push(curS); curS = ''; } else curS += ch; }
    }
    res.push(curS); return res;
  }
  function importData(tab) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,.json,.txt';
    input.onchange = async function () {
      const f = input.files[0]; if (!f) return;
      const text = await f.text();
      let rows = [];
      try {
        if (/\.json$/i.test(f.name)) { const arr = JSON.parse(text); if (!Array.isArray(arr)) throw new Error('JSON 需为对象数组'); rows = arr; }
        else {
          const lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.length; });
          if (!lines.length) throw new Error('空文件');
          const header = splitCSVLine(lines[0]).map(function (h) { return h.trim(); });
          rows = lines.slice(1).map(function (l) { const cells = splitCSVLine(l); const o = {}; header.forEach(function (h, j) { o[h] = cells[j] !== undefined ? cells[j] : ''; }); return o; });
        }
      } catch (e) { showToast('解析失败：' + e.message, 4000); return; }
      if (!rows.length) { showToast('文件无可导入数据'); return; }
      if (!confirm('将向表 ' + tab.tableName + ' 导入 ' + rows.length + ' 行，确认？')) return;
      const inserts = rows.map(function (r) { const o = {}; tab.columns.forEach(function (c) { if (Object.prototype.hasOwnProperty.call(r, c) && r[c] !== '' && r[c] != null) o[c] = r[c]; }); return o; }).filter(function (o) { return Object.keys(o).length; });
      try {
        const res = await api('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: tab.tableName, pk: rkField(tab), inserts: inserts, updates: [], deletes: [] }) });
        if (res.error) { showToast('导入失败：' + res.error, 4000); return; }
        showToast('已导入 ' + rows.length + ' 行'); log('ok', '导入 ' + rows.length + ' 行到 ' + tab.tableName);
        cur.onReload();
      } catch (e) { showToast('导入失败：' + e.message, 4000); }
    };
    input.click();
  }

  // ── 挂载 ────────────────────────────────────────────────────────────────
  G.mount = function (tab, els, ctx) {
    if (!Array.isArray(tab.added)) tab.added = [];
    if (!tab.modified) tab.modified = {};
    if (!(tab.deleted instanceof Set)) tab.deleted = new Set();
    if (!(tab.selected instanceof Set)) tab.selected = new Set();
    tab.viewMode = tab.viewMode || 'table';
    tab.cellEditMode = !!tab.cellEditMode;
    if (tab._seq === undefined) tab._seq = 0;
    if (tab.textIndex === undefined) tab.textIndex = 0;
    if (tab.tableName && !tab.pk) tab.pk = tab.columns.indexOf('id') >= 0 ? 'id' : tab.columns[0];
    cur = { tab: tab, els: els, onReload: (ctx && ctx.onReload) || function () {} };
    els.toolbar.onclick = onActClick;
    els.body.onclick = onBodyClick;
    els.body.ondblclick = onBodyDbl;
    render();
  };
})();
