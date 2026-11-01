/*!
 * kb-ui.js — 知识库 / 知识健康 / 待办 面板（纯 DOM，零框架）
 * =============================================================================
 * 挂载入口：工具箱（🛠️）里的「📚」按钮。三个页签：
 *   📚 知识库   知识库切换/新建、复审周期、成员（负责人）、文档列表
 *               （状态角标 / 确认有效 / 恢复 / 查看原文）、摄取区
 *               （粘贴文本 / 本地文件 / URL）；
 *   🩺 知识健康  发现项卡片：严重度、双方文档、**差异高亮证据**
 *               （KBDiv.diffSegments → 并排红删绿增）、四种处置
 *               （确认 / 忽略带理由 / 取代 / 改派）、立即体检；
 *   ✅ 我的待办  按负责人聚合的 open 发现项 + 复审到期清单 + 到期通知。
 *
 * 所有写操作走 kb-bootstrap 暴露的 KBBridge / 各引擎模块；面板异常
 * 不影响对话与工具（包裹 try/catch）。样式复用 index.html 的
 * modal-overlay / modal-card / mh-btn 等既有类，新增样式在 kb-ui.css。
 * =============================================================================
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // 等 kb-bootstrap 就绪（脚本顺序保证先于本文件加载，但保持防御）
  var bootTry = 0;
  (function waitBridge() {
    if (window.KBBridge) return initUi(window.KBBridge);
    if (++bootTry < 100) return setTimeout(waitBridge, 100);
    try { console.warn('[kb-ui] KBBridge 不可用，面板未挂载'); } catch (_) {}
  })();

  function initUi(BR) {
    // ── 样式注入 ──────────────────────────────────────────────────────────
    (function injectCss() {
      if (document.getElementById('kbUiCss')) return;
      var link = document.createElement('link');
      link.id = 'kbUiCss';
      link.rel = 'stylesheet';
      link.href = './knowledge/kb-ui.css';
      document.head.appendChild(link);
    })();

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function fmtDate(ts) {
      if (!ts) return '—';
      var d = new Date(ts);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }
    function toast(msg, ok) {
      try {
        if (window.snackbarStore) {
          (ok ? snackbarStore.showSuccessMessage : snackbarStore.showWarningMessage)(msg);
          return;
        }
      } catch (_) { /* 回退 */ }
      try { console.log('[kb-ui]', msg); } catch (_) {}
    }
    function store() { return BR.store; }

    // ── 浮动入口按钮（工具箱）────────────────────────────────────────────
    var toolbox = document.getElementById('toolbox');
    if (toolbox && !document.getElementById('kbPanelBtn')) {
      var btn = document.createElement('button');
      btn.className = 'tb-btn';
      btn.id = 'kbPanelBtn';
      btn.title = '知识库 / 知识健康 (Knowledge Base & Health)';
      btn.innerHTML = '📚<span id="kbBadge" class="kb-badge" style="display:none;">0</span>';
      toolbox.insertBefore(btn, toolbox.firstChild);
      btn.addEventListener('click', function () { togglePanel(); });
    }

    // ── 面板骨架 ──────────────────────────────────────────────────────────
    function ensurePanel() {
      var overlay = document.getElementById('kbModal');
      if (overlay) return overlay;
      overlay = document.createElement('div');
      overlay.id = 'kbModal';
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal-card kb-card">' +
        '  <div class="modal-header">' +
        '    <span class="modal-title">📚 知识库 · Knowledge</span>' +
        '    <div class="kb-tabs">' +
        '      <button class="kb-tab active" data-tab="kb">📚 知识库</button>' +
        '      <button class="kb-tab" data-tab="health">🩺 知识健康<span id="kbHealthBadge" class="kb-badge" style="display:none;"></span></button>' +
        '      <button class="kb-tab" data-tab="todo">✅ 我的待办<span id="kbTodoBadge" class="kb-badge" style="display:none;"></span></button>' +
        '    </div>' +
        '    <button class="mh-btn" id="kbCloseBtn" title="关闭">✕</button>' +
        '  </div>' +
        '  <div class="kb-body" id="kbBody"></div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closePanel();
      });
      document.getElementById('kbCloseBtn').addEventListener('click', closePanel);
      overlay.querySelectorAll('.kb-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          state.tab = t.getAttribute('data-tab');
          overlay.querySelectorAll('.kb-tab').forEach(function (x) { x.classList.remove('active'); });
          t.classList.add('active');
          render();
        });
      });
      return overlay;
    }

    var state = { tab: 'kb', kbId: '', memberId: '' };

    function openPanel() {
      var overlay = ensurePanel();
      overlay.classList.add('open');
      BR.ready.then(function () {
        state.kbId = BR.resolveKbId() || '';
        render();
        updateBadges();
      });
    }
    function closePanel() {
      var o = document.getElementById('kbModal');
      if (o) o.classList.remove('open');
    }
    function togglePanel() {
      var o = document.getElementById('kbModal');
      if (o && o.classList.contains('open')) closePanel(); else openPanel();
    }

    // ── 徽标 ──────────────────────────────────────────────────────────────
    function updateBadges() {
      BR.ready.then(function () {
        if (!store()) return;
        var c = window.KBTodo.counts();
        var badge = document.getElementById('kbBadge');
        if (badge) {
          badge.style.display = c.total > 0 ? '' : 'none';
          badge.textContent = c.total > 99 ? '99+' : String(c.total);
        }
        var hb = document.getElementById('kbHealthBadge');
        if (hb) { hb.style.display = c.total > 0 ? '' : 'none'; hb.textContent = String(c.total); }
        var tb = document.getElementById('kbTodoBadge');
        if (tb) {
          var overdue = window.KBTodo.overdueDocs(undefined, Date.now(), 0)
            .filter(function (d) { return d.overdue; }).length;
          tb.style.display = overdue > 0 ? '' : 'none';
          tb.textContent = String(overdue);
        }
      }).catch(function () {});
    }
    setInterval(updateBadges, 60000);

    // ── 渲染分发 ──────────────────────────────────────────────────────────
    function render() {
      var body = document.getElementById('kbBody');
      if (!body) return;
      BR.ready.then(function () {
        if (!store()) { body.innerHTML = '<div class="kb-empty">知识库初始化失败（存储不可用）</div>'; return; }
        if (state.tab === 'kb') renderKbTab(body);
        else if (state.tab === 'health') renderHealthTab(body);
        else renderTodoTab(body);
        updateBadges();
      }).catch(function (e) {
        body.innerHTML = '<div class="kb-empty">渲染失败：' + esc(e && e.message) + '</div>';
      });
    }

    // ── 事件委托：只绑一次 ───────────────────────────────────────────────
    // body（#kbBody）是常驻元素，render 时只换 innerHTML（子节点），监听器
    // 挂在 body 自身不会被清掉。旧版在各页签渲染函数里直接
    // addEventListener → 每渲染一次叠加一个，点「🗑 删除」便连续弹出 N 个
    // confirm 确认框（同理：确认有效/改派会重复执行、重复弹 toast）。
    function bindBodyOnce(body, key, handler) {
      if (!body) return;
      var flag = '__kbBound_' + key;
      if (body[flag]) return;
      body[flag] = true;
      body.addEventListener('click', handler);
    }

    // ── 📚 知识库页签 ─────────────────────────────────────────────────────
    function renderKbTab(body) {
      var st = store();
      var kbs = st.kbs.list();
      if (!state.kbId || !st.kbs.get(state.kbId)) state.kbId = kbs.length ? kbs[0].id : '';
      var kb = state.kbId ? st.kbs.get(state.kbId) : null;
      var members = st.members.list();
      var docs = kb ? st.kbs.documents(kb.id) : [];

      var html = '';
      // 知识库选择 + 新建
      html += '<div class="kb-section">' +
        '<div class="kb-row">' +
        '  <select id="kbSel" class="kb-select">' +
        kbs.map(function (k) {
          return '<option value="' + esc(k.id) + '"' + (k.id === state.kbId ? ' selected' : '') + '>' + esc(k.name) + '</option>';
        }).join('') +
        (kbs.length ? '' : '<option value="">（还没有知识库）</option>') +
        '  </select>' +
        '  <input id="kbNewName" class="kb-input" placeholder="新知识库名称" style="width:160px;">' +
        '  <button class="mh-btn" id="kbCreateBtn">➕ 新建</button>' +
        '</div>';

      if (kb) {
        html += '<div class="kb-row kb-muted">' +
          '复审周期 <input id="kbInterval" class="kb-input" type="number" min="0" style="width:70px;" value="' + (kb.reviewIntervalDays | 0) + '"> 天（0=不复审）' +
          '<button class="mh-btn" id="kbIntervalSave">保存</button>' +
          '　默认负责人 <select id="kbDefaultOwner" class="kb-select">' +
          '<option value="">（不设）</option>' +
          members.map(function (m) {
            return '<option value="' + esc(m.id) + '"' + (m.id === kb.defaultOwnerId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
          }).join('') +
          '</select><button class="mh-btn" id="kbOwnerSave">保存</button>' +
          '</div>';
      }
      html += '</div>';

      // ── 📁 本地知识库路径（kb-source）────────────────────────────────
      if (kb) {
        var src = window.KBSource ? window.KBSource.readConfig(kb.id) : null;
        var srcFsOk = !!(window.fileAPI && typeof window.fileAPI.scanDir === 'function');
        var fileDocs = docs.filter(function (d) { return d.sourceType === 'file'; });
        var activeFileDocs = fileDocs.filter(function (d) { return d.status === 'active'; });
        var ls = src && src.lastSummary;
        html += '<div class="kb-section"><h4>📁 本地知识库路径' +
          '<span class="kb-muted" style="font-weight:400;font-size:12px;"> · 提问即在此路径内容上作答</span></h4>' +
          '<div class="kb-row">' +
          '<input id="kbSourcePath" class="kb-input" placeholder="例如 D:\\公司制度 或 /Users/me/docs" style="width:50%;" value="' + esc(src ? src.rootPath : '') + '">' +
          '<button class="mh-btn" id="kbSourcePick">📂 选择文件夹</button>' +
          '<button class="mh-btn" id="kbSourceSave">💾 保存</button>' +
          '<button class="mh-btn kb-primary" id="kbSourceSync">🔄 扫描并同步</button>' +
          '</div>' +
          '<div class="kb-row kb-muted" style="font-size:12px;">' +
          '<label><input type="checkbox" id="kbSourceSubdirs"' + (src && src.subdirs ? ' checked' : '') + '> 含子目录</label>' +
          '<label style="margin-left:14px;"><input type="checkbox" id="kbSourceAuto"' + (src && src.autoSyncOnStart ? ' checked' : '') + '> 启动时自动同步</label>' +
          '<span style="margin-left:14px;">本地文档 ' + fileDocs.length + '（生效 ' + activeFileDocs.length + '）</span>' +
          (srcFsOk ? '' : '<span style="margin-left:14px;color:#f59e0b;">当前环境无文件系统访问（需 Electron 外壳）</span>') +
          '</div>';
        if (src && src.lastSyncAt) {
          html += '<div class="kb-muted" style="font-size:12px;">上次同步 ' +
            esc(new Date(src.lastSyncAt).toLocaleString()) + '：新增 ' + ((ls && ls.added) || 0) +
            '，更新 ' + ((ls && ls.updated) || 0) + '，未变 ' + ((ls && ls.unchanged) || 0) +
            '，停用 ' + ((ls && ls.missing) || 0) +
            ((ls && ls.errors && ls.errors.length) ? '，错误 ' + ls.errors.length : '') + '</div>';
        }
        if (src && src.rootPath && (src.includeExts || []).length) {
          html += '<div class="kb-muted" style="font-size:12px;">纳入类型：' +
            esc(src.includeExts.slice(0, 12).join(' ')) + (src.includeExts.length > 12 ? ' …' : '') + '</div>';
        }
        html += '</div>';
      }

      // 成员
      html += '<div class="kb-section"><h4>👥 成员（负责人）</h4><div class="kb-row">' +
        members.map(function (m) {
          return '<span class="kb-chip">' + esc(m.name) +
            ' <a data-op="member-del" data-id="' + esc(m.id) + '" class="kb-link">✕</a></span>';
        }).join('') +
        '<input id="kbMemberName" class="kb-input" placeholder="成员姓名" style="width:120px;">' +
        '<button class="mh-btn" id="kbMemberAdd">➕ 添加</button>' +
        '</div><div class="kb-muted" style="font-size:12px;">发现项按规则分配给成员：改动方 / 最久未背书方 / 文档负责人。</div></div>';

      // 摄取区（Office/PDF/HTML/TXT 全部纳入：Office/PDF 经 anydoc 转 Markdown）
      var kbAccept = (window.KBSource && Array.isArray(window.KBSource.DEFAULT_EXTS) && window.KBSource.DEFAULT_EXTS.length)
        ? window.KBSource.DEFAULT_EXTS.join(',')
        : '.txt,.md,.markdown,.html,.htm,.csv,.json,.log,.pdf,.doc,.docx,.odt,.ppt,.pptx,.odp,.rtf,.epub,.xls,.xlsx,.ods';
      html += '<div class="kb-section"><h4>📥 摄取文档</h4>' +
        '<input id="kbDocTitle" class="kb-input" placeholder="文档标题（如：考勤管理制度2025）" style="width:40%;">' +
        '<button class="mh-btn" id="kbFileBtn">📄 本地文件…</button>' +
        '<input type="file" id="kbFileInput" accept="' + esc(kbAccept) + '" style="display:none;">' +
        '<div class="kb-row" style="margin-top:6px;">' +
        '<input id="kbUrlInput" class="kb-input" placeholder="https://… 网页 URL" style="width:50%;">' +
        '<button class="mh-btn" id="kbUrlBtn">🌐 导入 URL</button></div>' +
        '<textarea id="kbDocText" class="kb-textarea" placeholder="粘贴文档正文（纯文本 / Markdown）…"></textarea>' +
        '<div class="kb-row"><button class="mh-btn kb-primary" id="kbIngestBtn">⬆️ 摄取入库（自动触发健康检查）</button></div>' +
        '</div>';

      // 文档列表
      var allDocs = st.documents.list();   // 跨知识库总数（清空按钮用）
      html += '<div class="kb-section"><h4>🗂 文档（' + docs.length + '）' +
        (allDocs.length
          ? ' <button class="mh-btn" data-op="docs-clear" style="color:#ef4444;" ' +
            'title="删除所有知识库的全部文档及其分块/反馈/发现项，释放存储空间">🧹 一键清空全部文档（' + allDocs.length + '）</button>'
          : '') +
        '</h4>';
      if (!docs.length) html += '<div class="kb-empty">还没有文档 —— 上面摄取第一篇。</div>';
      html += docs.map(function (d) {
        var owner = d.ownerId ? st.members.get(d.ownerId) : null;
        var badge = d.status === 'superseded'
          ? '<span class="kb-tag kb-tag-grey" title="已被取代，检索已排除（未删除）">已被取代</span>'
          : (d.status === 'disabled'
            ? '<span class="kb-tag kb-tag-grey" title="源文件已不在本地路径中，已从检索排除（不删除；文件回来即恢复）">已停用</span>'
            : '<span class="kb-tag kb-tag-green">生效中</span>');
        var stw = window.KBSteward.stewardOf(d.id);
        var due = stw && stw.reviewDueAt
          ? (stw.overdue
            ? '<span class="kb-tag kb-tag-red" title="' + esc(new Date(stw.reviewDueAt).toLocaleString()) + '">逾期' + stw.daysOverdue + '天</span>'
            : '<span class="kb-tag kb-tag-blue" title="下次复审 ' + esc(new Date(stw.reviewDueAt).toLocaleDateString()) + '">v' + d.version + '</span>')
          : '<span class="kb-tag kb-tag-blue">v' + d.version + '</span>';
        return '<div class="kb-doc">' +
          '<div class="kb-doc-main">' +
          '  <span class="kb-doc-title">' + esc(d.title) + '</span> ' + badge + ' ' + due +
          '  <span class="kb-muted"> · ' + (owner ? esc(owner.name) : '无负责人') + ' · ' + fmtDate(d.updatedAt) + '</span>' +
          '</div>' +
          '<div class="kb-doc-acts">' +
          (d.status !== 'active'
            ? '<button class="mh-btn" data-op="doc-restore" data-id="' + esc(d.id) + '">♻️ 恢复</button>'
            : '<button class="mh-btn" data-op="doc-confirm" data-id="' + esc(d.id) + '">✅ 确认有效</button>') +
          '<button class="mh-btn" data-op="doc-view" data-id="' + esc(d.id) + '">👁 查看</button>' +
          '<button class="mh-btn" data-op="doc-check" data-id="' + esc(d.id) + '">🩺 体检</button>' +
          '<button class="mh-btn" data-op="doc-del" data-id="' + esc(d.id) + '" style="color:#ef4444;">🗑</button>' +
          '</div>' +
          '<div class="kb-doc-view" id="view-' + esc(d.id) + '" style="display:none;"><pre>' +
          esc((d.text || '').slice(0, 4000)) + ((d.text || '').length > 4000 ? '\n…（截断）' : '') +
          '</pre></div></div>';
      }).join('');
      html += '</div>';

      body.innerHTML = html;
      bindKbTab(body, kb);
    }

    function bindKbTab(body, kb) {
      function id(sel) { return body.querySelector(sel); }
      var sel = id('#kbSel');
      if (sel) sel.addEventListener('change', function () { state.kbId = sel.value; render(); });
      var createBtn = id('#kbCreateBtn');
      if (createBtn) createBtn.addEventListener('click', function () {
        var name = (id('#kbNewName').value || '').trim();
        if (!name) return toast('请输入知识库名称', false);
        store().kbs.create({ name: name }).then(function (kb2) {
          state.kbId = kb2.id; toast('已创建：' + name, true); render();
        });
      });
      if (kb) {
        var ivSave = id('#kbIntervalSave');
        if (ivSave) ivSave.addEventListener('click', function () {
          var days = Math.max(0, parseInt(id('#kbInterval').value, 10) || 0);
          store().kbs.update(kb.id, { reviewIntervalDays: days }).then(function () {
            toast('复审周期已设为 ' + (days || '关闭') + (days ? ' 天' : ''), true);
            render();
          });
        });
        var owSave = id('#kbOwnerSave');
        if (owSave) owSave.addEventListener('click', function () {
          store().kbs.update(kb.id, { defaultOwnerId: id('#kbDefaultOwner').value }).then(function () {
            toast('默认负责人已保存', true); render();
          });
        });

        // ── 本地路径（kb-source）──────────────────────────────────────
        function srcOpts(extra) {
          var o = {
            subdirs: id('#kbSourceSubdirs') ? id('#kbSourceSubdirs').checked : true,
            autoSyncOnStart: id('#kbSourceAuto') ? id('#kbSourceAuto').checked : false
          };
          return Object.assign(o, extra || {});
        }
        var srcPick = id('#kbSourcePick');
        if (srcPick) srcPick.addEventListener('click', function () {
          if (!window.fileAPI || typeof window.fileAPI.pickDirectory !== 'function') {
            return toast('当前环境不支持文件夹选择（需 Electron 外壳）', false);
          }
          srcPick.disabled = true;
          window.fileAPI.pickDirectory().then(function (r) {
            var p = '';
            if (r) { p = (typeof r === 'string') ? r : (r.canceled ? '' : (r.path || '')); }
            if (!p) return null;
            id('#kbSourcePath').value = p;
            return BR.setLocalPath(kb.id, p, srcOpts()).then(function (out) {
              var s = out.summary || {};
              toast('已设置本地路径并同步：新增 ' + (s.added || 0) + '，更新 ' + (s.updated || 0) + '，未变 ' + (s.unchanged || 0), true);
              render();
            });
          }).catch(function (e) { toast('选择/同步失败：' + (e && e.message), false); })
            .then(function () { srcPick.disabled = false; });
        });
        var srcSave = id('#kbSourceSave');
        if (srcSave) srcSave.addEventListener('click', function () {
          var p = (id('#kbSourcePath').value || '').trim();
          BR.setLocalPath(kb.id, p, srcOpts({ sync: false })).then(function () {
            toast(p ? '本地路径已保存' : '已清空本地路径', true); render();
          }).catch(function (e) { toast(String(e && e.message), false); });
        });
        var srcSync = id('#kbSourceSync');
        if (srcSync) srcSync.addEventListener('click', function () {
          var p = (id('#kbSourcePath').value || '').trim() ||
            (window.KBSource ? window.KBSource.readConfig(kb.id).rootPath : '');
          if (!p) return toast('请先选择或填写本地路径', false);
          srcSync.disabled = true; srcSync.textContent = '⏳ 同步中…';
          BR.setLocalPath(kb.id, p, srcOpts()).then(function (out) {
            var s = out.summary || {};
            toast('同步完成：新增 ' + (s.added || 0) + '，更新 ' + (s.updated || 0) + '，未变 ' +
              (s.unchanged || 0) + '，停用 ' + (s.missing || 0) + (s.failed ? '，失败 ' + s.failed : ''), true);
          }).catch(function (e) { toast('同步失败：' + (e && e.message), false); })
            .then(function () { render(); });
        });
      }
      var mAdd = id('#kbMemberAdd');
      if (mAdd) mAdd.addEventListener('click', function () {
        var name = (id('#kbMemberName').value || '').trim();
        if (!name) return toast('请输入姓名', false);
        store().members.add({ name: name }).then(function () { toast('已添加：' + name, true); render(); });
      });
      var iBtn = id('#kbIngestBtn');
      if (iBtn) iBtn.addEventListener('click', function () {
        var title = (id('#kbDocTitle').value || '').trim();
        var text = id('#kbDocText').value || '';
        if (!title || !text.trim()) return toast('标题与正文都要填', false);
        iBtn.disabled = true;
        BR.ingestText(title, text, { kbId: state.kbId, sourceKey: title, sourceType: 'text' })
          .then(function (r) {
            toast((r.changed ? '已摄取 ' : '内容未变（幂等）') + '《' + r.doc.title + '》' + r.chunkCount + ' 块', true);
            render();
          })
          .catch(function (e) { toast('摄取失败：' + (e && e.message), false); })
          .then(function () { iBtn.disabled = false; });
      });
      var fBtn = id('#kbFileBtn'), fInput = id('#kbFileInput');
      if (fBtn) fBtn.addEventListener('click', function () { fInput.click(); });
      if (fInput) fInput.addEventListener('change', function () {
        var f = fInput.files && fInput.files[0];
        if (!f) return;
        fInput.value = '';
        var src = window.KBSource;
        var title = f.name.replace(/\.[^.]+$/, '');
        function fill(text, note) {
          if (!String(text || '').trim()) return toast('文件无可提取正文', false);
          id('#kbDocTitle').value = title;
          id('#kbDocText').value = text;
          toast(note, true);
        }
        function readUtf8Fallback() {
          var r0 = new FileReader();
          r0.onload = function () { fill(String(r0.result || ''), '已读取 ' + f.name + '（确认标题后点摄取）'); };
          r0.onerror = function () { toast('读取文件失败', false); };
          r0.readAsText(f, 'utf-8');
        }
        if (!src || typeof src.extractText !== 'function') return readUtf8Fallback();
        var ext = src.extOf ? src.extOf(f.name) : '';
        var office = (src.OFFICE_EXTS || []).indexOf(ext) >= 0;
        var reader = new FileReader();
        reader.onerror = function () { toast('读取文件失败', false); };
        reader.onload = function () {
          var bytes = new Uint8Array(reader.result);
          var go = function () {
            var ex;
            try { ex = src.extractText(f.name, bytes); }
            catch (e) { return toast('解析失败：' + (e && e.message || e), false); }
            if (ex.unsupported) {
              return toast('无法解析该格式（' + (ex.format || ext) + '）：anydoc 未就绪或文件损坏', false);
            }
            fill(ex.text, office
              ? '已用 anydoc 解析 ' + f.name + ' → Markdown（确认标题后点摄取）'
              : '已读取 ' + f.name + '（确认标题后点摄取）');
          };
          if (office && typeof src.whenAnydocReady === 'function') {
            // anydoc WASM 可能尚未就绪（异步 instantiate）→ 等一下再转 Markdown
            src.whenAnydocReady(8000).then(function (ok) {
              if (!ok) return toast('anydoc 尚未就绪，无法解析 Office/PDF（请稍后重试）', false);
              go();
            });
          } else go();
        };
        reader.readAsArrayBuffer(f);
      });
      var uBtn = id('#kbUrlBtn');
      if (uBtn) uBtn.addEventListener('click', function () {
        var url = (id('#kbUrlInput').value || '').trim();
        if (!url) return toast('请输入 URL', false);
        if (!window.fileAPI || typeof window.fileAPI.fetchUrl !== 'function') {
          return toast('当前环境不支持 URL 抓取（需 Electron 外壳）', false);
        }
        uBtn.disabled = true;
        window.fileAPI.fetchUrl(url, { maxChars: 200000 }).then(function (resp) {
          if (!resp || !resp.ok) throw new Error((resp && (resp.error || resp.statusText)) || '抓取失败');
          var text = '';
          if (resp.text) text = resp.text;
          else if (resp.base64) {
            try {
              var bin = atob(resp.base64);
              var bytes = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              text = new TextDecoder('utf-8').decode(bytes);
            } catch (_) { throw new Error('内容解码失败'); }
          }
          if (/html/i.test(resp.contentType || '') && text) {
            try {
              var doc = new DOMParser().parseFromString(text, 'text/html');
              text = (doc.body && doc.body.innerText) || text;
            } catch (_) { /* 保留原文 */ }
          }
          if (!text.trim()) throw new Error('页面无可提取正文');
          if (!id('#kbDocTitle').value) {
            try {
              var d2 = new DOMParser().parseFromString(text, 'text/html');
              var t = d2.querySelector && d2.querySelector('title');
              id('#kbDocTitle').value = (t && t.textContent || url).slice(0, 80);
            } catch (_) { id('#kbDocTitle').value = url.slice(0, 80); }
          }
          id('#kbDocText').value = text;
          toast('已抓取（确认标题后点摄取）', true);
        }).catch(function (e) { toast('抓取失败：' + (e && e.message), false); })
          .then(function () { uBtn.disabled = false; });
      });

      // 文档行操作（事件委托，只绑一次）
      bindBodyOnce(body, 'docOps', function (e) {
        var el = e.target.closest ? e.target.closest('[data-op]') : null;
        if (!el || !body.contains(el)) return;
        var op = el.getAttribute('data-op');
        var did = el.getAttribute('data-id');
        if (op === 'doc-view') {
          var v = document.getElementById('view-' + did);
          if (v) v.style.display = v.style.display === 'none' ? '' : 'none';
        } else if (op === 'doc-confirm') {
          window.KBSettle.confirm(did, 'local', null).then(function () {
            toast('已确认有效（背书已更新，复审时钟重启）', true); render();
          }).catch(function (er) { toast(String(er && er.message), false); });
        } else if (op === 'doc-restore') {
          window.KBSettle.restore(did, 'local', null).then(function () {
            toast('已恢复（重新参与检索）', true); render();
          }).catch(function (er) { toast(String(er && er.message), false); });
        } else if (op === 'doc-check') {
          var d = store().documents.get(did);
          BR.checkDoc(d.kbId, did).then(function (r) {
            toast('体检完成：发现 ' + (r.findings || 0) + ' 项', true); render();
          });
        } else if (op === 'doc-del') {
          if (!confirm('删除该文档及其分块、反馈、相关发现项？此操作不可恢复。')) return;
          store().documents.remove(did).then(function () { toast('已删除', true); render(); });
        } else if (op === 'docs-clear') {
          var total = store().documents.list().length;
          if (!total) { toast('没有可清空的文档', false); return; }
          if (!confirm('清空所有知识库的 ' + total + ' 篇文档？\n\n' +
            '将一并删除：分块与向量、回答反馈、知识健康发现项、引用关系。\n' +
            '知识库、成员与配置保留。此操作不可恢复。')) return;
          el.disabled = true;
          store().documents.clear().then(function (r) {
            toast('已清空 ' + r.docs + ' 篇文档（分块 ' + r.chunks + '、发现项 ' +
              r.findings + '、引用 ' + r.citations + '），空间已释放', true);
            render();
          }).catch(function (er) {
            toast('清空失败：' + String(er && er.message), false);
            el.disabled = false;
          });
        } else if (op === 'member-del') {
          store().members.remove(did).then(function () { toast('成员已删除', true); render(); });
        }
      });
    }

    // ── 🩺 知识健康页签 ───────────────────────────────────────────────────
    function renderHealthTab(body) {
      var st = store();
      var digest = window.KBTodo.digest({ kbId: state.kbId || undefined });
      var findings = st.findings.list({ status: 'open', kbId: state.kbId || undefined });

      var html = '<div class="kb-section kb-digest">' +
        '<div class="kb-digest-cell"><b>' + digest.openTotal + '</b><span>待处理</span></div>' +
        '<div class="kb-digest-cell"><b>' + (digest.byType.divergent + digest.byType.duplicate) + '</b><span>重复/出入</span></div>' +
        '<div class="kb-digest-cell"><b>' + digest.byType.stale + '</b><span>复审到期</span></div>' +
        '<div class="kb-digest-cell"><b>' + digest.byType.disputed + '</b><span>差评争议</span></div>' +
        '<div class="kb-digest-cell"><b>' + digest.overdueDocs + '</b><span>到期文档</span></div>' +
        '<div class="kb-digest-act"><button class="mh-btn kb-primary" id="kbCheckAll">🩺 立即体检全库</button></div>' +
        '</div>';

      if (!findings.length) {
        html += '<div class="kb-empty">✅ 没有待处理的知识问题' +
          (digest.overdueDocs ? '（但有 ' + digest.overdueDocs + ' 篇文档临近复审）' : '') + '</div>';
      }
      html += findings.map(function (f) { return findingCard(f, st); }).join('');
      body.innerHTML = html;
      bindHealthTab(body);
    }

    function findingCard(f, st) {
      var sum = window.KBSettle.assignSummary(f);
      var sevIcon = { info: 'ℹ️', warning: '⚠️', error: '🚨' }[f.severity] || 'ℹ️';
      var sevCls = { info: 'kb-sev-info', warning: 'kb-sev-warn', error: 'kb-sev-err' }[f.severity] || 'kb-sev-info';
      var members = st.members.list();

      var evHtml = '';
      var evidence = (f.details && f.details.evidence) || [];
      evidence.forEach(function (ev, i) {
        evHtml += '<div class="kb-ev" title="相似度 ' + (ev.score || 0).toFixed(3) + '">' +
          '<div class="kb-ev-head">证据 ' + (i + 1) +
          (ev.differs ? ' <span class="kb-tag kb-tag-amber">有出入</span>' : ' <span class="kb-tag kb-tag-grey">逐字相同</span>') +
          '</div>' + diffPairHtml(ev) + '</div>';
      });
      var ex = (f.details && f.details.extra) || {};
      if (ex.count) {
        evHtml += '<div class="kb-ev"><div class="kb-ev-head">差评 ' + ex.count + ' 次</div>' +
          (ex.reports || []).map(function (r) {
            return '<div class="kb-report">' +
              (r.question ? '<div><b>问：</b>' + esc(r.question) + '</div>' : '<div class="kb-muted">（提问者未选择公开问题）</div>') +
              (r.excerpt ? '<div><b>据：</b>' + esc(r.excerpt) + '</div>' : '') +
              (r.comment ? '<div><b>评：</b>' + esc(r.comment) + '</div>' : '') +
              '</div>';
          }).join('') + '</div>';
      }
      if (ex.due_at) {
        evHtml += '<div class="kb-ev"><div class="kb-ev-head">复审</div><div class="kb-muted">' +
          '应于 ' + esc(String(ex.due_at).slice(0, 10)) + ' 前确认；最近背书 ' +
          esc(String(ex.last_vouched_at).slice(0, 10)) + '；周期 ' + ex.interval_days + ' 天' +
          (ex.days_overdue ? '，已逾期 <b>' + ex.days_overdue + ' 天</b>' : '') + '</div></div>';
      }

      var actions = '';
      if (f.relatedDocId) {
        // divergent/duplicate：两种取代方向 + 忽略 + 改派
        actions +=
          '<button class="mh-btn kb-primary" data-fop="supersede" data-fid="' + esc(f.id) + '" ' +
          'data-winner="' + esc(f.subjectDocId) + '" data-loser="' + esc(f.relatedDocId) + '">' +
          '♻️ 保留《' + esc(sum.subjectTitle) + '》</button>' +
          '<button class="mh-btn kb-primary" data-fop="supersede" data-fid="' + esc(f.id) + '" ' +
          'data-winner="' + esc(f.relatedDocId) + '" data-loser="' + esc(f.subjectDocId) + '">' +
          '♻️ 保留《' + esc(sum.relatedTitle) + '》</button>';
      }
      actions += '<button class="mh-btn" data-fop="confirm" data-fid="' + esc(f.id) + '">✅ 确认仍有效</button>';
      actions += '<select class="kb-select kb-reason" data-fid="' + esc(f.id) + '">' +
        '<option value="">🙈 忽略（选理由）…</option>' +
        '<option value="distinct_scope">适用范围不同（两个办事处/年份）</option>' +
        '<option value="intentional">有意重叠（摘要引用原文）</option></select>';
      actions += '<select class="kb-select kb-assignee" data-fid="' + esc(f.id) + '">' +
        '<option value="">👤 改派…</option>' +
        members.map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (m.id === f.assigneeId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
        }).join('') +
        (f.assigneeId && !members.some(function (m) { return m.id === f.assigneeId; })
          ? '<option value="' + esc(f.assigneeId) + '" selected>' + esc(f.assigneeId) + '</option>' : '') +
        '</select>';

      return '<div class="kb-finding ' + sevCls + '" data-fid="' + esc(f.id) + '">' +
        '<div class="kb-finding-head">' +
        '  <span class="kb-sev">' + sevIcon + '</span>' +
        '  <span class="kb-finding-type">' + esc(sum.typeLabel) + '</span>' +
        '  <span class="kb-finding-title">《' + esc(sum.subjectTitle) + '》' +
        (sum.relatedTitle ? ' ↔《' + esc(sum.relatedTitle) + '》' : '') + '</span>' +
        '  <span class="kb-finding-owner">👤 ' + esc(sum.assigneeName) +
        (f.assignedBy ? ' <span class="kb-muted">(手工)</span>' : '') + '</span>' +
        (f.score > 1 ? '<span class="kb-finding-score">×' + f.score + '</span>' : '') +
        '</div>' +
        '<div class="kb-finding-body">' + evHtml + '</div>' +
        '<div class="kb-finding-acts">' + actions + '</div>' +
        '</div>';
    }

    /**
     * diffPairHtml — 差异高亮并排视图：左=subject，右=related。
     * KBDiv.diffSegments 出 eq/del/ins 分段：左渲染 eq+del（del 红底），
     * 右渲染 eq+ins（ins 绿底）。
     */
    function diffPairHtml(ev) {
      var cls = 'kb-ev-col';
      if (!ev.differs || !window.KBDiv) {
        return '<div class="kb-ev-pair">' +
          '<div class="' + cls + '"><span class="kb-ev-label">A</span>' + esc(ev.subjectExcerpt || '') + '</div>' +
          '<div class="' + cls + '"><span class="kb-ev-label">B</span>' + esc(ev.relatedExcerpt || '') + '</div>' +
          '</div>';
      }
      var segs = window.KBDiv.diffSegments(ev.subjectExcerpt || '', ev.relatedExcerpt || '');
      var left = '', right = '';
      segs.forEach(function (s) {
        if (!s.text) return;
        if (s.type === 'eq') { left += esc(s.text); right += esc(s.text); }
        else if (s.type === 'del') left += '<mark class="kb-del">' + esc(s.text) + '</mark>';
        else if (s.type === 'ins') right += '<mark class="kb-ins">' + esc(s.text) + '</mark>';
      });
      return '<div class="kb-ev-pair">' +
        '<div class="' + cls + '"><span class="kb-ev-label">A</span>' + left + '</div>' +
        '<div class="' + cls + '"><span class="kb-ev-label">B</span>' + right + '</div>' +
        '</div>';
    }

    function bindHealthTab(body) {
      var ca = body.querySelector('#kbCheckAll');
      if (ca) ca.addEventListener('click', function () {
        ca.disabled = true; ca.textContent = '⏳ 体检中…';
        var kbId = state.kbId || BR.resolveKbId();
        if (!kbId) { ca.disabled = false; ca.textContent = '🩺 立即体检全库'; return toast('没有知识库', false); }
        BR.checkAll(kbId).then(function (r) {
          toast('体检完成：' + r.docs + ' 篇文档', true);
        }).then(render, function (e) { toast(String(e && e.message), false); })
          .then(function () { ca.disabled = false; ca.textContent = '🩺 立即体检全库'; });
      });
      bindBodyOnce(body, 'findingOps', function (e) {
        var el = e.target.closest ? e.target.closest('[data-fop]') : null;
        if (!el || !body.contains(el)) return;
        var op = el.getAttribute('data-fop');
        var fid = el.getAttribute('data-fid');
        var f = store().findings.get(fid);
        if (!f) return;
        if (op === 'supersede') {
          var winner = el.getAttribute('data-winner'), loser = el.getAttribute('data-loser');
          var w = store().documents.get(winner), l = store().documents.get(loser);
          if (!confirm('用《' + (w && w.title) + '》取代《' + (l && l.title) + '》？\n旧文档将被标记「已被取代」并从检索排除（不删除）。')) return;
          el.disabled = true;
          window.KBSettle.supersede(loser, winner, 'local', null).then(function () {
            toast('已取代：《' + (l && l.title) + '》退出检索', true); render();
          }).catch(function (er) { toast(String(er && er.message), false); el.disabled = false; });
        } else if (op === 'confirm') {
          window.KBSettle.confirm(f.subjectDocId, 'local', null).then(function () {
            toast('已确认有效（争议/复审计数归零）', true); render();
          }).catch(function (er) { toast(String(er && er.message), false); });
        }
      });
      body.querySelectorAll('.kb-reason').forEach(function (sel) {
        sel.addEventListener('change', function () {
          if (!sel.value) return;
          var reason = sel.value;
          window.KBSettle.dismiss(sel.getAttribute('data-fid'), reason, 'local', null)
            .then(function () {
              toast('已忽略（' + (reason === 'distinct_scope' ? '适用范围不同' : '有意重叠') + '）；证据变化会自动重开', true);
              render();
            }).catch(function (er) { toast(String(er && er.message), false); sel.value = ''; });
        });
      });
      body.querySelectorAll('.kb-assignee').forEach(function (sel) {
        sel.addEventListener('change', function () {
          window.KBSettle.assign(sel.getAttribute('data-fid'), sel.value, 'local')
            .then(function () {
              var m = sel.value ? store().members.get(sel.value) : null;
              toast('已改派给 ' + (m ? m.name : '未分配'), true); render();
            }).catch(function (er) { toast(String(er && er.message), false); });
        });
      });
    }

    // ── ✅ 我的待办页签 ───────────────────────────────────────────────────
    function renderTodoTab(body) {
      var st = store();
      var members = st.members.list();
      if (!state.memberId) {
        // 默认第一个成员（或全部）
        state.memberId = members.length ? members[0].id : '';
      }
      var rows = window.KBTodo.inbox(state.memberId || undefined, { kbId: state.kbId || undefined });
      var overdue = window.KBTodo.overdueDocs(state.kbId || undefined, Date.now(), 0);

      var html = '<div class="kb-section"><div class="kb-row">' +
        '👤 负责人 <select id="kbTodoOwner" class="kb-select">' +
        '<option value="">（全部）</option>' +
        members.map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (m.id === state.memberId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
        }).join('') +
        '</select></div></div>';

      html += '<div class="kb-section"><h4>📋 待处理（' + rows.length + '）</h4>';
      if (!rows.length) html += '<div class="kb-empty">✅ 该范围没有待办</div>';
      html += rows.map(function (f) {
        var due = f.type === 'stale'
          ? '<span class="kb-tag kb-tag-red">逾期' + f.overdueDays + '天</span>' : '';
        return '<div class="kb-todo-row">' +
          '<span class="kb-tag ' + (f.severity === 'warning' ? 'kb-tag-amber' : 'kb-tag-blue') + '">' + esc(f.typeLabel) + '</span>' +
          '<span class="kb-todo-title">《' + esc(f.subjectTitle) + '》' +
          (f.relatedTitle ? ' ↔《' + esc(f.relatedTitle) + '》' : '') + '</span>' + due +
          '<span class="kb-muted">→ ' + esc(f.assigneeName) + '</span>' +
          '</div>';
      }).join('') + '</div>';

      html += '<div class="kb-section"><h4>⏰ 复审到期 / 临近（' + overdue.length + '）</h4>';
      if (!overdue.length) html += '<div class="kb-empty">没有到期文档' +
        (st.kbs.list().some(function (k) { return k.reviewIntervalDays > 0; }) ? '' : '（尚未设置复审周期）') + '</div>';
      html += overdue.map(function (d) {
        return '<div class="kb-todo-row">' +
          (d.overdue ? '<span class="kb-tag kb-tag-red">逾期' + d.daysOverdue + '天</span>'
            : '<span class="kb-tag kb-tag-blue">' + fmtDate(d.dueAt) + '</span>') +
          '<span class="kb-todo-title">《' + esc(d.title) + '》</span>' +
          '<span class="kb-muted">👤 ' + esc(d.ownerName || '无负责人') + '</span>' +
          '<button class="mh-btn" data-op="todo-confirm" data-id="' + esc(d.docId) + '">✅ 确认有效</button>' +
          '</div>';
      }).join('') + '</div>';

      body.innerHTML = html;
      var sel = body.querySelector('#kbTodoOwner');
      if (sel) sel.addEventListener('change', function () { state.memberId = sel.value; render(); });
      bindBodyOnce(body, 'todoOps', function (e) {
        var el = e.target.closest ? e.target.closest('[data-op="todo-confirm"]') : null;
        if (!el) return;
        window.KBSettle.confirm(el.getAttribute('data-id'), 'local', null).then(function () {
          toast('已确认有效', true); render();
        }).catch(function (er) { toast(String(er && er.message), false); });
      });
    }

    // ── 对话内：引用角标 + 反馈按钮（renderMessage 钩子调用）───────────────
    /**
     * decorate(messageEl, msg) — 由 index.html 的 renderMessage 调用。
     * 1) 正文中的 [Sn] → 引用角标（悬停显示来源与摘录）；
     * 2) 文末追加「来源」列表；
     * 3) 操作行加 👍/👎（👎 展开可选「附上我的问题」后归因到被引文档）。
     */
    function decorate(messageEl, msg) {
      try {
        if (!msg || msg.role !== 'assistant') return;
        var refs = msg._kbRefs;
        var body = messageEl.querySelector('.card-content-body');
        if (refs && refs.length && body && !body.querySelector('.kb-refchip')) {
          markCitations(body, refs);
          appendRefList(body, refs);
        }
        var actions = messageEl.querySelector('.card-actions');
        if (actions && !actions.querySelector('.kb-fb')) {
          var up = document.createElement('button');
          up.className = 'act-btn kb-fb';
          up.title = '有帮助';
          up.setAttribute('data-act', 'kb-up');
          up.textContent = '👍';
          var down = document.createElement('button');
          down.className = 'act-btn kb-fb';
          down.title = '没帮助（归因到被引文档）';
          down.setAttribute('data-act', 'kb-down');
          down.textContent = '👎';
          var spacer = actions.querySelector('.act-spacer');
          if (spacer) { spacer.parentNode.insertBefore(up, spacer); spacer.parentNode.insertBefore(down, spacer); }
          else { actions.appendChild(up); actions.appendChild(down); }
          up.addEventListener('click', function (e) { e.stopPropagation(); onFeedback(msg, 'up', messageEl); });
          down.addEventListener('click', function (e) { e.stopPropagation(); onFeedback(msg, 'down', messageEl); });
        }
      } catch (_) { /* 装饰失败不影响渲染 */ }
    }

    function markCitations(body, refs) {
      var md = body.querySelector('.assistant-md') || body;
      var walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
      var nodes = [];
      while (walker.nextNode()) {
        var n = walker.currentNode;
        if (/\[S\d{1,2}\]/.test(n.nodeValue || '')) nodes.push(n);
      }
      var byN = {};
      refs.forEach(function (r) { byN[r.n] = r; });
      nodes.forEach(function (n) {
        var frag = document.createDocumentFragment();
        var parts = (n.nodeValue || '').split(/(\[S\d{1,2}\])/);
        parts.forEach(function (p) {
          var m = /^\[S(\d{1,2})\]$/.exec(p);
          if (m && byN[parseInt(m[1], 10)]) {
            var r = byN[parseInt(m[1], 10)];
            var chip = document.createElement('sup');
            chip.className = 'kb-refchip';
            chip.textContent = p;
            chip.title = '《' + r.title + '》\n' + (r.excerpt || '').slice(0, 160);
            frag.appendChild(chip);
          } else if (p) {
            frag.appendChild(document.createTextNode(p));
          }
        });
        n.parentNode.replaceChild(frag, n);
      });
    }

    function appendRefList(body, refs) {
      var box = document.createElement('div');
      box.className = 'kb-reflist';
      box.innerHTML = '<div class="kb-reflist-head">📖 引用来源</div>' +
        refs.map(function (r) {
          return '<div class="kb-refline"><span class="kb-refchip static">[S' + r.n + ']</span>' +
            '<b>《' + esc(r.title) + '》</b>' + (r.heading ? ' · ' + esc(r.heading) : '') +
            '<div class="kb-muted">' + esc((r.excerpt || '').slice(0, 200)) + '</div></div>';
        }).join('');
      body.appendChild(box);
    }

    function ensureMsgId(msg) {
      if (!msg._kbMessageId && window.KBStore) {
        msg._kbMessageId = 'm-' + window.KBStore.stableId('msg|' + (msg.content || ''));
      }
      return msg._kbMessageId;
    }

    function onFeedback(msg, rating, messageEl) {
      var id = ensureMsgId(msg);
      if (rating === 'up') {
        BR.feedback(id, 'up').then(function () { toast('已记录 👍', true); })
          .catch(function () { toast('记录失败', false); });
        return;
      }
      // 👎：可选「附上我的问题」（默认不带，保护隐私 —— 对齐 Yuheng 语义）
      var old = messageEl.querySelector('.kb-fbpop');
      if (old) { old.remove(); return; }
      var pop = document.createElement('div');
      pop.className = 'kb-fbpop';
      pop.innerHTML =
        '<div class="kb-fbpop-title">这个回答没帮助</div>' +
        '<label class="kb-muted"><input type="checkbox" id="kbFbShare"> 附上我的原始问题给文档负责人</label>' +
        '<div class="kb-row"><button class="mh-btn kb-primary" id="kbFbOk">提交</button>' +
        '<button class="mh-btn" id="kbFbCancel">取消</button></div>';
      messageEl.appendChild(pop);
      pop.querySelector('#kbFbCancel').addEventListener('click', function (e) {
        e.stopPropagation(); pop.remove();
      });
      pop.querySelector('#kbFbOk').addEventListener('click', function (e) {
        e.stopPropagation();
        var share = pop.querySelector('#kbFbShare').checked;
        var okBtn = pop.querySelector('#kbFbOk');
        okBtn.disabled = true;
        BR.feedback(id, 'down', { shareQuestion: share }).then(function (r) {
          pop.remove();
          if (r.recorded > 0) {
            toast('已记录差评，归因到 ' + r.recorded + ' 篇被引文档 → 负责人待办', true);
          } else {
            toast('已记录（该回答没有可归因的引用）', true);
          }
          updateBadges();
        }).catch(function () { toast('提交失败', false); okBtn.disabled = false; });
      });
    }

    // ── 到期通知（kb-bootstrap 回调）──────────────────────────────────────
    BR.onNotify(function (payload) {
      toast(payload.title + '：' + payload.body, false);
      if (window.fileAPI && typeof window.fileAPI.notify === 'function') {
        window.fileAPI.notify(payload.title, payload.body);
      }
    });

    // ── 对外 ──────────────────────────────────────────────────────────────
    window.KBUi = {
      decorate: decorate,
      open: openPanel,
      close: closePanel,
      refresh: render,
      updateBadges: updateBadges
    };
    // index.html 的 renderMessage 会尝试调用（存在即用）
    updateBadges();
  }
})();
