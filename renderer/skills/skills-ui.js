/*!
 * skills-ui.js — 技能面板（🧩）：技能库 / 启停 / 安装 / 查看 / 预览 system 片段
 * 入口：工具箱 🧩（#skillsBtn）。纯前端，数据全本地。
 */
(function (root) {
  'use strict';
  function el(html) { var t = root.document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]; }); }
  function snack(msg, err) { try { if (root.snackbarStore) (err ? root.snackbarStore.showErrorMessage : root.snackbarStore.showInfoMessage).call(root.snackbarStore, msg); } catch (_) {} }

  var UI = {
    open: function () {
      var Store = root.SkillStore;
      if (!Store) { snack('技能库未就绪', true); return; }
      var old = root.document.getElementById('skillsModal');
      if (old) old.remove();
      var overlay = el('<div class="modal-overlay" id="skillsModal"><div class="modal-card" style="min-width:720px;max-width:94vw;">' +
        '<div class="modal-header"><span class="modal-title">🧩 技能 · Skills（SKILL.md）</span>' +
        '<button class="mh-btn" id="skImportBtn" title="导入 SKILL.md / JSON">⬆️</button>' +
        '<button class="mh-btn" id="skExportBtn" title="导出全部技能 JSON">⬇️</button>' +
        '<button class="mh-btn modal-close" id="skClose">✕</button></div>' +
        '<div class="modal-body"><div class="sk-hint" style="font-size:12px;opacity:.8;margin-bottom:8px;">' +
        '启用技能后，其方法论/输出模板会追加到 system 末尾（触发一次前缀缓存 miss，之后稳定）。' +
        '兼容 OpenClaw / WorkBuddy 的 SKILL.md 格式，可导入导出。</div>' +
        '<div id="skList"></div>' +
        '<div id="skImportWrap" style="display:none;margin-top:10px;"><textarea id="skImportText" rows="6" style="width:100%;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;" placeholder="粘贴 SKILL.md 或技能 JSON…"></textarea>' +
        '<div style="margin-top:6px;"><button class="sr-btn pri" id="skDoImport">导入</button> <button class="sr-btn" id="skCancelImport">取消</button></div></div>' +
        '<div id="skPreview" style="display:none;margin-top:10px;"></div>' +
        '</div></div>');
      root.document.body.appendChild(overlay);
      // 关键：.modal-overlay 默认 display:none，只有加 .open 才 display:flex。
      // 此前动态创建的浮层从未加 open，导致 🧩 面板始终不可见（看起来像「无法点击技能」）。
      overlay.classList.add('open');
      var close = function () { overlay.remove(); };
      overlay.querySelector('#skClose').addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

      var listEl = overlay.querySelector('#skList');
      var wrap = overlay.querySelector('#skImportWrap');

      function render() {
        var skills = Store.list();
        var rows = skills.map(function (s) {
          return '<div class="sr-row" data-name="' + esc(s.name) + '" style="display:flex;gap:8px;align-items:flex-start;">' +
            '<input type="checkbox" class="sk-toggle" ' + (s.enabled ? 'checked' : '') + ' title="启用/停用">' +
            '<div style="flex:1;min-width:0;">' +
              '<b>' + esc(s.name) + '</b>' + (s.source === 'builtin' ? ' <span style="opacity:.5;font-size:11px;">builtin</span>' : '') +
              '<div style="opacity:.75;font-size:12px;">' + esc(s.description || '') + '</div>' +
              (s.toolWhitelist ? '<div style="opacity:.6;font-size:11px;">tools: ' + esc(s.toolWhitelist.join(', ')) + '</div>' : '') +
            '</div>' +
            '<span class="sk-ops">' +
              '<button class="pm-mini" data-act="view" title="查看 SKILL.md">👁</button>' +
              '<button class="pm-mini" data-act="del" title="删除">✕</button>' +
            '</span>' +
          '</div>';
        }).join('') || '<div style="opacity:.6;">（技能库为空。点右上 ⬆️ 导入，或用 skill_create 创建）</div>';
        listEl.innerHTML = rows;
        listEl.querySelectorAll('.sk-toggle').forEach(function (cb) {
          cb.addEventListener('change', function () {
            var name = cb.closest('[data-name]').getAttribute('data-name');
            Store.setEnabled(name, cb.checked);
            snack('技能 ' + name + (cb.checked ? ' 已启用' : ' 已停用'));
          });
        });
        listEl.querySelectorAll('[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var name = b.closest('[data-name]').getAttribute('data-name');
            var act = b.getAttribute('data-act');
            if (act === 'del') { Store.remove(name); render(); snack('已删除 ' + name); }
            else if (act === 'view') {
              var md = Store.exportSkill(name, 'skillmd');
              var pv = overlay.querySelector('#skPreview');
              pv.style.display = 'block';
              pv.innerHTML = '<div style="font-size:12px;opacity:.7;margin-bottom:4px;">SKILL.md / ' + esc(name) + '</div>' +
                '<pre style="max-height:36vh;overflow:auto;background:rgba(0,0,0,.2);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;">' + esc(md) + '</pre>';
            }
          });
        });
      }

      overlay.querySelector('#skImportBtn').addEventListener('click', function () { wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none'; });
      overlay.querySelector('#skCancelImport').addEventListener('click', function () { wrap.style.display = 'none'; });
      overlay.querySelector('#skDoImport').addEventListener('click', function () {
        var txt = overlay.querySelector('#skImportText').value || '';
        if (!txt.trim()) return;
        var res;
        if (/^\s*[\[{]/.test(txt)) res = Store.importJSON(txt, { override: true });
        else res = Store.add(txt, { override: true });
        if (res && res.ok === false) snack('导入失败：' + (res.errors || []).join('；'), true);
        else { snack('导入成功'); overlay.querySelector('#skImportText').value = ''; wrap.style.display = 'none'; render(); }
      });
      overlay.querySelector('#skExportBtn').addEventListener('click', function () {
        try {
          var data = Store.exportJSON({});
          var blob = new Blob([data], { type: 'application/json' });
          var a = root.document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = 'skills.json';
          root.document.body.appendChild(a); a.click(); a.remove();
        } catch (_) {}
      });

      UI._render = render;
      render();
    },
    refresh: function () { try { if (UI._render && root.document.getElementById('skillsModal')) UI._render(); } catch (_) {} }
  };

  if (root && root.document && !root.__skillsUiBooted) {
    root.__skillsUiBooted = true;
    var kick = function () {
      try {
        var btn = root.document.getElementById('skillsBtn');
        if (btn) btn.addEventListener('click', function () { UI.open(); });
      } catch (_) {}
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', kick);
    else setTimeout(kick, 0);
  }
  root.SkillsUI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
