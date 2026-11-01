/*!
 * 20-session-replay-ui.js — 会话事实源 · 回放 / 分叉 / 差异 UI
 * -----------------------------------------------------------------------------
 * 把已有的 append-only 会话事件日志（18-session-log.js + main.js msg:* IPC，
 * 落盘 messages/<sid>/events.jsonl）从「崩溃恢复」升级为「Agent 可观测性」：
 *
 *   ① 会话列表   —— messagesAPI.list() / sessionLog（降级）
 *   ② 事件时间线 —— 逐事件 {seq,ts,type}；model.request 显示载荷指纹
 *   ③ 步进播放器 —— foldEvents(events.slice(0,k)) 还原「第 k 步的对话」
 *   ④ 差异 diff  —— 两会话并排：行级 + 词级高亮（自包含 LCS，不依赖 kb-health）
 *
 * 约束：零构建、纯前端可降级（无 messagesAPI 时只用内存折叠态）、不触网。
 * UMD：浏览器挂 globalThis.SessionReplay；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SessionReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ══════════════════════════════════════════════════════════════
  // 一、纯逻辑（可单测）：LCS 行差异 + 词差异 + 事件折叠
  // ══════════════════════════════════════════════════════════════
  var MAX_LINES = 4000; // 防御性上限

  function lineDiff(a, b) {
    a = (a || []).slice(0, MAX_LINES);
    b = (b || []).slice(0, MAX_LINES);
    var n = a.length, m = b.length;
    // LCS 长度表
    var dp = [];
    for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = (a[i] === b[j]) ? (dp[i + 1][j + 1] + 1) : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { out.push({ type: 'eq', text: a[x] }); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push({ type: 'del', text: a[x], lineA: x }); x++; }
      else { out.push({ type: 'ins', text: b[y], lineB: y }); y++; }
    }
    while (x < n) { out.push({ type: 'del', text: a[x], lineA: x }); x++; }
    while (y < m) { out.push({ type: 'ins', text: b[y], lineB: y }); y++; }
    return out;
  }

  // 词级差异（把一行拆成词/字，做 LCS）；返回 [{type,text}]
  function words(s) {
    s = String(s == null ? '' : s);
    // 中文按单字，英文/数字按词，空白保留
    return s.match(/[\u4e00-\u9fa5]|[A-Za-z0-9_]+|\s+|[^\s]/g) || [];
  }
  function wordDiff(aText, bText) {
    var A = words(aText), B = words(bText);
    // 长度保护
    if (A.length * B.length > 40000) return [{ type: 'del', text: aText }, { type: 'ins', text: bText }];
    var n = A.length, m = B.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--)
      dp[i][j] = (A[i] === B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (A[x] === B[y]) { push(out, 'eq', A[x]); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { push(out, 'del', A[x]); x++; }
      else { push(out, 'ins', B[y]); y++; }
    }
    while (x < n) { push(out, 'del', A[x]); x++; }
    while (y < m) { push(out, 'ins', B[y]); y++; }
    return out;
    function push(arr, type, text) {
      var last = arr[arr.length - 1];
      if (last && last.type === type) last.text += text; else arr.push({ type: type, text: text });
    }
  }

  // 把消息数组压成「对比用行」
  function messagesToLines(msgs) {
    return (msgs || []).map(function (m, i) {
      var role = (m && m.role) || '?';
      var c = (m && m.content);
      if (Array.isArray(c)) c = c.map(function (x) { return x && (x.text || x.type || ''); }).join(' ');
      c = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
      if (c.length > 160) c = c.slice(0, 160) + '…';
      return role + ': ' + c;
    });
  }

  // 折叠事件到第 k 个（含）后（优先用 sessionLog.foldEvents）
  function foldUpTo(events, k, sid) {
    var evs = (events || []).slice(0, Math.max(0, k));
    var sl = (root && root.sessionLog) || null;
    if (sl && typeof sl.foldEvents === 'function') {
      var st = sl.foldEvents(evs, sid);
      return st && st.messages ? st.messages : [];
    }
    // 兜底：最小实现
    var msgs = [];
    evs.forEach(function (ev) {
      if (!ev) return;
      if (ev.type === 'msg.append' && Array.isArray(ev.msgs)) msgs = msgs.concat(ev.msgs);
      else if (ev.type === 'msg.truncate') msgs = msgs.slice(0, ev.toLen | 0);
      else if (ev.type === 'msg.replace') msgs = Array.isArray(ev.msgs) ? ev.msgs.slice() : [];
    });
    return msgs;
  }

  function normalizeEvents(r) {
    if (!r) return null;
    if (Array.isArray(r)) return r;
    return r.events || r.rows || r.data || r.lines || (r.state && r.state.events) || null;
  }

  // ══════════════════════════════════════════════════════════════
  // 二、运行时（浏览器）
  // ══════════════════════════════════════════════════════════════
  var _styleInjected = false;
  function injectStyle() {
    if (_styleInjected || !root || !root.document) return;
    _styleInjected = true;
    var st = root.document.createElement('style');
    st.textContent = [
      '.sr-overlay .sr-card{min-width:820px;max-width:94vw;}',
      '.sr-tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;}',
      '.sr-tab{border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;opacity:.7;}',
      '.sr-tab.on{opacity:1;background:#2f6feb;border-color:#2f6feb;color:#fff;}',
      '.sr-list{max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:4px;}',
      '.sr-row{padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);cursor:pointer;font-size:12px;display:flex;gap:8px;align-items:center;}',
      '.sr-row:hover{background:rgba(255,255,255,.05);}',
      '.sr-row.on{background:rgba(47,111,235,.15);border-color:#2f6feb;}',
      '.sr-ev{padding:3px 8px;border-radius:4px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;cursor:pointer;}',
      '.sr-ev:hover{background:rgba(255,255,255,.05);}',
      '.sr-ev.on{background:rgba(47,111,235,.2);}',
      '.sr-ev .t{display:inline-block;min-width:120px;opacity:.85;}',
      '.sr-ev .s{opacity:.5;margin-right:8px;}',
      '.sr-prev{max-height:40vh;overflow:auto;white-space:pre-wrap;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.2);border-radius:8px;padding:10px;}',
      '.sr-diff{max-height:52vh;overflow:auto;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;}',
      '.sr-diff .ln{padding:1px 8px;white-space:pre-wrap;}',
      '.sr-diff .eq{opacity:.75;}',
      '.sr-diff .del{background:rgba(255,90,90,.16);}',
      '.sr-diff .ins{background:rgba(63,185,80,.16);}',
      '.sr-diff .w-del{background:rgba(255,90,90,.4);border-radius:2px;}',
      '.sr-diff .w-ins{background:rgba(63,185,80,.4);border-radius:2px;}',
      '.sr-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:12px;}',
      '.sr-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;}',
      '.sr-btn:hover{background:rgba(255,255,255,.1);}',
      '.sr-btn.pri{background:#2f6feb;border-color:#2f6feb;color:#fff;}',
      '.sr-mut{opacity:.6;}'
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(st);
  }

  function el(html) { var t = root.document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]; }); }
  function snack(msg, err) { try { if (typeof snackbarStore !== 'undefined' && snackbarStore) (err ? snackbarStore.showErrorMessage : snackbarStore.showInfoMessage).call(snackbarStore, msg); } catch (_) {} }

  // ── 数据访问 ──
  async function listSessions() {
    try {
      if (root.messagesAPI && root.messagesAPI.list) {
        var r = await root.messagesAPI.list();
        var arr = (r && (r.sessions || r.data)) || (Array.isArray(r) ? r : []);
        if (arr && arr.length) {
          return arr.map(function (s) { return { sid: s.sid || s.id, title: s.title || s.sid || s.id, size: s.size || 0, mtimeMs: s.mtimeMs || 0 }; });
        }
      }
    } catch (_) {}
    // 降级：内存折叠态
    var out = [];
    var sl = root.sessionLog;
    if (sl && sl._order) {
      sl._order().forEach(function (sid) {
        var st = (sl.stateOf && sl.stateOf(sid)) || {};
        out.push({ sid: sid, title: st.title || sid, size: (st.messages || []).length, mtimeMs: st.updatedAt || 0 });
      });
    }
    return out;
  }
  async function loadEvents(sid) {
    try {
      if (root.messagesAPI && root.messagesAPI.read) {
        var r = await root.messagesAPI.read(sid, {});
        var evs = normalizeEvents(r);
        if (evs && evs.length) return evs;
      }
    } catch (_) {}
    var sl = root.sessionLog;
    if (sl && sl.stateOf) {
      var st = sl.stateOf(sid);
      if (st && st.messages && st.messages.length) return [{ seq: 1, ts: st.updatedAt || 0, type: 'msg.append', msgs: st.messages, _synth: true }];
    }
    return [];
  }
  async function forkSession(from, to, upToSeq) {
    if (root.messagesAPI && root.messagesAPI.fork) return root.messagesAPI.fork(from, to, upToSeq);
    if (root.sessionLog && root.sessionLog.fork) return root.sessionLog.fork(from, to, upToSeq);
    return { ok: false, error: 'fork 不可用' };
  }
  function download(name, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/jsonl' });
      var a = root.document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      root.document.body.appendChild(a); a.click(); a.remove();
    } catch (_) {}
  }

  // ── 视图 ──
  var state = { sid: null, events: [], idx: 0, otherSid: null, tab: 'timeline' };

  var API = {
    version: 1,
    __pure: { lineDiff: lineDiff, wordDiff: wordDiff, messagesToLines: messagesToLines, foldUpTo: foldUpTo, normalizeEvents: normalizeEvents },

    open: async function (sid) {
      if (!root || !root.document) return;
      injectStyle();
      var old = root.document.getElementById('sessionReplayModal');
      if (old) old.remove();

      var overlay = el(
        '<div class="modal-overlay sr-overlay" id="sessionReplayModal">' +
          '<div class="modal-card sr-card">' +
            '<div class="modal-header">' +
              '<span class="modal-title">🎞 会话回放 / Replay &amp; Diff</span>' +
              '<button class="mh-btn" id="srExport" title="导出 events.jsonl">⬇️</button>' +
              '<button class="mh-btn modal-close" id="srClose" title="关闭">✕</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="sr-tabs">' +
                '<button class="sr-tab" data-tab="sessions">会话</button>' +
                '<button class="sr-tab" data-tab="timeline">时间线</button>' +
                '<button class="sr-tab" data-tab="player">播放</button>' +
                '<button class="sr-tab" data-tab="diff">差异</button>' +
              '</div>' +
              '<div id="srBody"></div>' +
            '</div>' +
          '</div>' +
        '</div>');
      root.document.body.appendChild(overlay);
      overlay.querySelector('#srClose').addEventListener('click', function () { overlay.remove(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

      overlay.querySelectorAll('.sr-tab').forEach(function (b) {
        b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); render(); });
      });
      overlay.querySelector('#srExport').addEventListener('click', function () {
        if (!state.sid) return snack('先选择一个会话', true);
        var txt = state.events.map(function (e) { return JSON.stringify(e); }).join('\n');
        download('events-' + state.sid + '.jsonl', txt);
      });

      var sessions = await listSessions();
      if (sid && sessions.some(function (s) { return s.sid === sid; })) state.sid = sid;
      else if (!state.sid && sessions.length) state.sid = sessions[sessions.length - 1].sid;
      state._sessions = sessions;
      if (state.sid) state.events = await loadEvents(state.sid);
      state.idx = state.events.length;

      function render() {
        overlay.querySelectorAll('.sr-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); });
        var body = overlay.querySelector('#srBody');
        if (state.tab === 'sessions') return renderSessions(body);
        if (state.tab === 'timeline') return renderTimeline(body);
        if (state.tab === 'player') return renderPlayer(body);
        if (state.tab === 'diff') return renderDiff(body);
      }
      API._render = render;

      function renderSessions(body) {
        var rows = (state._sessions || []).map(function (s) {
          return '<div class="sr-row' + (s.sid === state.sid ? ' on' : '') + '" data-sid="' + esc(s.sid) + '">' +
            '<b>' + esc(s.title || s.sid) + '</b>' +
            '<span class="sr-mut">' + esc(s.sid) + '</span>' +
            '<span class="spacer" style="flex:1"></span>' +
            '<span class="sr-mut">' + (s.size || 0) + '</span>' +
            '</div>';
        }).join('') || '<div class="sr-mut">没有找到会话（messagesAPI / sessionLog 均不可用）</div>';
        body.innerHTML = '<div class="sr-list">' + rows + '</div>';
        body.querySelectorAll('.sr-row').forEach(function (r) {
          r.addEventListener('click', async function () {
            state.sid = r.getAttribute('data-sid');
            state.events = await loadEvents(state.sid);
            state.idx = state.events.length;
            state.tab = 'timeline';
            render();
          });
        });
      }

      function renderTimeline(body) {
        var head = '<div class="sr-bar"><b>' + esc(state.sid || '-') + '</b>' +
          '<span class="sr-mut">' + state.events.length + ' 个事件</span>' +
          '<span class="spacer" style="flex:1"></span>' +
          '<button class="sr-btn" data-act="fold">折叠查看（内存态）</button></div>';
        var evs = state.events.map(function (e, i) {
          var t = e.type || '?';
          var extra = '';
          if (t === 'model.request') extra = '<span class="sr-mut">digest=' + esc(e.digest || '') + ' count=' + esc(e.count || '') + '</span>';
          if (t === 'session.branch') extra = '<span class="sr-mut">from=' + esc(e.from || '') + '@' + esc(e.fromSeq || '') + '</span>';
          if (t === 'msg.append' && e.msgs) extra = '<span class="sr-mut">+' + e.msgs.length + ' 条消息</span>';
          return '<div class="sr-ev' + (i + 1 === state.idx ? ' on' : '') + '" data-i="' + (i + 1) + '">' +
            '<span class="s">#' + esc(e.seq || (i + 1)) + '</span>' +
            '<span class="t">' + esc(t) + '</span>' + extra + '</div>';
        }).join('') || '<div class="sr-mut">该会话暂无事件。</div>';
        body.innerHTML = head + '<div class="sr-list">' + evs + '</div>';
        body.querySelector('[data-act="fold"]').addEventListener('click', function () { state.tab = 'player'; render(); });
        body.querySelectorAll('.sr-ev').forEach(function (r) {
          r.addEventListener('click', function () { state.idx = parseInt(r.getAttribute('data-i'), 10); state.tab = 'player'; render(); });
        });
      }

      function renderPlayer(body) {
        var n = state.events.length;
        if (!n) { body.innerHTML = '<div class="sr-mut">无可播放的事件。</div>'; return; }
        if (state.idx > n) state.idx = n;
        var head = '<div class="sr-bar">' +
          '<button class="sr-btn" data-act="first">⏮</button>' +
          '<button class="sr-btn" data-act="prev">◀</button>' +
          '<button class="sr-btn pri" data-act="play">▶ 播放</button>' +
          '<button class="sr-btn" data-act="next">▶</button>' +
          '<button class="sr-btn" data-act="last">⏭</button>' +
          '<input type="range" min="0" max="' + n + '" value="' + state.idx + '" id="srRange" style="flex:1">' +
          '<span>' + state.idx + ' / ' + n + '</span></div>';
        var msgs = foldUpTo(state.events, state.idx, state.sid);
        var prev = messagesToLines(msgs).join('\n') || '（此刻尚无消息）';
        body.innerHTML = head + '<div class="sr-prev">' + esc(prev) + '</div>';
        var range = body.querySelector('#srRange');
        var act = function (d) { state.idx = Math.max(0, Math.min(n, state.idx + d)); render(); };
        body.querySelector('[data-act="first"]').addEventListener('click', function () { state.idx = 0; render(); });
        body.querySelector('[data-act="prev"]').addEventListener('click', function () { act(-1); });
        body.querySelector('[data-act="next"]').addEventListener('click', function () { act(1); });
        body.querySelector('[data-act="last"]').addEventListener('click', function () { state.idx = n; render(); });
        range.addEventListener('input', function () { state.idx = parseInt(range.value, 10); var m = foldUpTo(state.events, state.idx, state.sid); body.querySelector('.sr-prev').textContent = messagesToLines(m).join('\n') || '（此刻尚无消息）'; });
        body.querySelector('[data-act="play"]').addEventListener('click', function () {
          var i = 0; state.idx = 0;
          var timer = setInterval(function () {
            i++; state.idx = i; render();
            if (i >= n) clearInterval(timer);
          }, 300);
        });
      }

      function renderDiff(body) {
        var others = (state._sessions || []).filter(function (s) { return s.sid !== state.sid; });
        var opts = others.map(function (s) { return '<option value="' + esc(s.sid) + '"' + (s.sid === state.otherSid ? ' selected' : '') + '>' + esc(s.title || s.sid) + '</option>'; }).join('');
        var head = '<div class="sr-bar"><span>对比：</span><b>' + esc(state.sid || '-') + '</b><span>↔</span>' +
          '<select id="srOther" class="sr-btn">' + (opts || '<option value="">（无其它会话）</option>') + '</select>' +
          '<span class="spacer" style="flex:1"></span>' +
          '<button class="sr-btn" data-act="reload">刷新</button></div>';
        body.innerHTML = head + '<div class="sr-diff" id="srDiff"></div>';
        var sel = body.querySelector('#srOther');
        sel.addEventListener('change', function () { state.otherSid = sel.value; renderDiffBody(body); });
        body.querySelector('[data-act="reload"]').addEventListener('click', function () { renderDiffBody(body); });
        if (!state.otherSid && others.length) state.otherSid = others[0].sid;
        renderDiffBody(body);
      }
      async function renderDiffBody(body) {
        var box = body.querySelector('#srDiff'); if (!box) return;
        if (!state.otherSid) { box.innerHTML = '<div class="sr-mut">需要至少两个会话才能对比。</div>'; return; }
        var aMsgs = foldUpTo(state.events, state.events.length, state.sid);
        var bEvs = await loadEvents(state.otherSid);
        var bMsgs = foldUpTo(bEvs, bEvs.length, state.otherSid);
        var a = messagesToLines(aMsgs), b = messagesToLines(bMsgs);
        var d = lineDiff(a, b);
        // 相邻 del/ins 配对 → 词级高亮
        var html = '', i = 0;
        while (i < d.length) {
          if (d[i].type === 'del' && d[i + 1] && d[i + 1].type === 'ins') {
            var wd = wordDiff(d[i].text, d[i + 1].text);
            var left = '', right = '';
            wd.forEach(function (w) {
              if (w.type === 'eq') { left += esc(w.text); right += esc(w.text); }
              else if (w.type === 'del') left += '<span class="w-del">' + esc(w.text) + '</span>';
              else right += '<span class="w-ins">' + esc(w.text) + '</span>';
            });
            html += '<div class="ln del">- ' + left + '</div><div class="ln ins">+ ' + right + '</div>';
            i += 2;
          } else {
            var t = d[i];
            var cls = t.type === 'eq' ? 'eq' : t.type;
            var sign = t.type === 'del' ? '- ' : t.type === 'ins' ? '+ ' : '  ';
            html += '<div class="ln ' + cls + '">' + sign + esc(t.text) + '</div>';
            i++;
          }
        }
        box.innerHTML = html || '<div class="sr-mut">两个会话内容一致。</div>';
      }

      state.tab = sid ? 'timeline' : 'sessions';
      render();
    }
  };

  // ── 自动引导：绑定工具箱按钮 #sessionReplayBtn ──
  if (root && root.document && !root.__sessionReplayBooted) {
    root.__sessionReplayBooted = true;
    var kick = function () {
      try {
        var btn = root.document.getElementById('sessionReplayBtn');
        if (btn) btn.addEventListener('click', function () { API.open(); });
      } catch (_) {}
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', kick);
    else setTimeout(kick, 0);
  }

  return API;
});
