/*!
 * 18-session-log.js — 会话事件日志（append-only Session Event Log）
 * -----------------------------------------------------------------------------
 * 目标（对齐 dsh 的「会话事实源」）：把对话从「内存数组 + localStorage 快照」
 * 升级为「磁盘上的 append-only 事件日志」，并维持不变量：
 *
 *       model-visible  ⟺  logged
 *
 * 即：凡是发给模型的消息，一定先被记录进日志；日志可被 replay 还原出完整对话，
 * 从而支持 replay / fork / 崩溃恢复。
 *
 * 落盘位置：应用目录下 messages/<sid>/events.jsonl（主进程只追加、绝不覆盖）。
 * 每行一个事件：{ seq, ts, type, sid, ... }。
 *
 * 事件类型：
 *   session.create  { sid, title }           会话创建（标题 / 创建时间）
 *   session.branch  { from, fromSeq }        由其它会话 fork 而来
 *   msg.append      { msgs:[...] }           追加消息（对话尾部增长）
 *   msg.truncate    { toLen }                截断到长度（重生成 / 上下文裁剪）
 *   msg.replace     { msgs:[...] }           整体替换（导入 / 就地裁剪）
 *   model.request   { digest, count }        模型可见载荷指纹（不变量锚点）
 *
 * 本文件 = 纯逻辑（fold / sync / fork）+ 可选磁盘 IO（经 window.messagesAPI）。
 * 无 messagesAPI（纯浏览器直开 file://）时自动降级为 no-op，不改变既有行为。
 * UMD：浏览器挂 globalThis.sessionLog；Node 下 module.exports（可 node --test 单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.sessionLog = api.createSessionLog(api.defaultEnv(root));
    if (root.document) {
      var kick = function () { try { root.sessionLog.boot(); } catch (_) {} };
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', kick);
      else setTimeout(kick, 0);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var _idc = 0;

  // ── 纯函数：ID / 哈希 / 稳定序列化 ─────────────────────────
  function genId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return 's-' + crypto.randomUUID(); } catch (_) {}
    _idc++;
    return 's-' + Date.now().toString(36) + '-' + _idc.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // FNV-1a 32bit + 长度：稳定、同步、无依赖，用于载荷指纹（非加密用途）
  function hashText(str) {
    str = String(str == null ? '' : str);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8) + ':' + str.length;
  }

  // 稳定序列化：对象键排序，保证同一消息内容得到同一指纹
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }

  function messageHash(m) { return hashText(stableStringify(m)); }

  function commonPrefixLen(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    for (; i < n; i++) { if (messageHash(a[i]) !== messageHash(b[i])) break; }
    return i;
  }

  // ── 纯函数：事件折叠（replay）─────────────────────────────
  function applyEvent(st, ev) {
    if (!ev || !ev.type) return;
    if (ev.seq != null && ev.seq > (st.maxSeq || 0)) st.maxSeq = ev.seq;
    if (ev.ts) st.updatedAt = ev.ts;
    switch (ev.type) {
      case 'session.create':
        if (ev.sid) st.sid = ev.sid;
        if (ev.title != null) st.title = ev.title;
        if (st.createdAt == null) st.createdAt = ev.ts || null;
        break;
      case 'session.branch':
        st.branch = { from: ev.from, fromSeq: ev.fromSeq };
        break;
      case 'msg.append':
        if (Array.isArray(ev.msgs)) st.messages = st.messages.concat(ev.msgs);
        break;
      case 'msg.truncate':
        st.messages = st.messages.slice(0, Math.max(0, ev.toLen | 0));
        break;
      case 'msg.replace':
        st.messages = Array.isArray(ev.msgs) ? ev.msgs.slice() : [];
        break;
      case 'model.request':
        st.requests = (st.requests || 0) + 1;
        st.lastRequest = { digest: ev.digest, count: ev.count };
        break;
      default:
        break;
    }
  }

  function foldEvents(events, sidOverride) {
    var st = {
      sid: sidOverride || null, title: null, createdAt: null, updatedAt: null,
      messages: [], requests: 0, lastRequest: null, branch: null, maxSeq: 0
    };
    var sorted = (events || []).slice().sort(function (a, b) { return ((a && a.seq) || 0) - ((b && b.seq) || 0); });
    for (var i = 0; i < sorted.length; i++) applyEvent(st, sorted[i]);
    return st;
  }

  // ── 会话日志实例 ──────────────────────────────────────────
  function createSessionLog(env) {
    env = env || {};
    var api = env.api || null;
    var now = env.now || function () { return Date.now(); };
    var uuid = env.uuid || genId;
    var onError = env.onError || function () {};

    var sessions = {};   // sid -> folded state
    var order = [];      // sid 出现顺序
    var active = null;   // { sid, ref }
    var booted = false;
    var refMap = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
    var refPairs = [];   // WeakMap 不可用时的回退

    function enabled() { return !!(api && typeof api.append === 'function'); }
    function fresh(sid) {
      return { sid: sid, title: null, createdAt: null, updatedAt: null, messages: [], requests: 0, lastRequest: null, branch: null, maxSeq: 0 };
    }
    function err(e) { try { onError(e); } catch (_) {} }

    function refGet(ref) {
      if (!ref) return null;
      if (refMap) return refMap.get(ref) || null;
      for (var i = 0; i < refPairs.length; i++) if (refPairs[i][0] === ref) return refPairs[i][1];
      return null;
    }
    function refSet(ref, sid) {
      if (!ref) return;
      if (refMap) { refMap.set(ref, sid); return; }
      for (var i = 0; i < refPairs.length; i++) if (refPairs[i][0] === ref) { refPairs[i][1] = sid; return; }
      refPairs.push([ref, sid]);
    }
    function ensureSession(sid) {
      if (!sessions[sid]) { sessions[sid] = fresh(sid); if (order.indexOf(sid) === -1) order.push(sid); }
      return sessions[sid];
    }

    // 追加事件：本地折叠 + 异步落盘（append-only）
    function appendEvents(sid, events) {
      var st = ensureSession(sid);
      var out = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i], o = {};
        for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) o[k] = ev[k];
        o.seq = (st.maxSeq || 0) + 1;
        o.ts = o.ts || now();
        o.sid = sid;
        st.maxSeq = o.seq;
        applyEvent(st, o);
        out.push(o);
      }
      if (enabled()) {
        try {
          Promise.resolve(api.append(sid, out)).then(function (r) { if (r && r.ok === false) err(r.error); }).catch(err);
        } catch (e) { err(e); }
      }
      return out;
    }

    function sidFor(conv) {
      if (!conv) return null;
      var s = refGet(conv);
      if (s) return s;
      if (env.resolveSid) { try { var s2 = env.resolveSid(conv); if (s2) return s2; } catch (_) {} }
      if (active && active.ref === conv) return active.sid;
      return null;
    }

    function titleFor(conv) { if (env.titleFor) { try { return env.titleFor(conv); } catch (_) {} } return null; }

    // 确保 conv 有对应会话（无则新建），返回 sid
    function sessionFor(conv) {
      var sid = sidFor(conv);
      if (!sid) { sid = uuid(); ensureSession(sid); }
      refSet(conv, sid);
      if (env.markSid) { try { env.markSid(conv, sid); } catch (_) {} }
      var st = ensureSession(sid);
      if (st.createdAt == null) appendEvents(sid, [{ type: 'session.create', sid: sid, title: titleFor(conv) }]);
      return sid;
    }

    // ★ 核心：把内存对话增量对齐到日志（append-only）
    //   不变量：sync 之后，fold(日志) === conversation（replay 可还原）
    function sync(conversation) {
      if (!Array.isArray(conversation)) return { ok: false, error: 'not-array' };
      var sid = sessionFor(conversation);
      var st = sessions[sid];
      var logged = st.messages || [];
      var common = commonPrefixLen(logged, conversation);
      if (common === logged.length && common === conversation.length) return { ok: true, sid: sid, appended: 0 };
      if (common < logged.length) appendEvents(sid, [{ type: 'msg.truncate', toLen: common }]);
      var tail = conversation.slice(common);
      if (tail.length) appendEvents(sid, [{ type: 'msg.append', msgs: tail }]);
      return { ok: true, sid: sid, appended: tail.length, truncatedTo: common < logged.length ? common : undefined };
    }

    // ★ 不变量锚点：模型可见载荷先入日志，再发请求
    function recordRequest(modelMessages, rawConversation) {
      var sid = null;
      if (Array.isArray(rawConversation)) { sync(rawConversation); sid = sidFor(rawConversation); }
      if (!sid && active) sid = active.sid;
      if (!sid) return { ok: false, reason: 'no-session' };
      var digest = hashText(stableStringify(modelMessages || []));
      appendEvents(sid, [{ type: 'model.request', digest: digest, count: (modelMessages || []).length }]);
      return { ok: true, sid: sid, digest: digest, count: (modelMessages || []).length };
    }

    function activate(sid, ref) {
      if (!sid) { active = null; return null; }
      ensureSession(sid);
      active = { sid: sid, ref: ref || null };
      if (ref) refSet(ref, sid);
      return sessions[sid];
    }

    function messagesOf(sid) { return (sessions[sid] && sessions[sid].messages) ? sessions[sid].messages.slice() : []; }
    function stateOf(sid) { return sessions[sid] || null; }

    function setMeta(sid, meta) {
      if (enabled() && api.meta) { try { Promise.resolve(api.meta(sid, meta)).catch(err); } catch (e) { err(e); } }
    }

    // 从磁盘 replay（读事件 → fold），是「崩溃恢复」的基本单元
    function replay(sid) {
      if (!enabled() || !api.read) return Promise.resolve({ ok: false, reason: 'no-api' });
      return Promise.resolve(api.read(sid)).then(function (r) {
        if (!r || !r.ok) return { ok: false, error: r && r.error };
        var st = foldEvents(r.events || [], sid);
        sessions[sid] = st;
        if (order.indexOf(sid) === -1) order.push(sid);
        return { ok: true, sid: sid, state: st, messages: st.messages };
      });
    }

    // fork：优先主进程复制磁盘前缀（保留请求锚点）；否则本地按事件重建
    function fork(sid, upToSeq) {
      var newSid = uuid();
      if (enabled() && api.fork) {
        return Promise.resolve(api.fork(sid, newSid, upToSeq)).then(function (r) {
          if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'fork failed' };
          return replay(newSid).then(function () {
            var st = sessions[newSid] || ensureSession(newSid);
            st.title = (st.title || sid) + ' · fork';
            setMeta(newSid, { title: st.title, branchedFrom: sid, atSeq: upToSeq == null ? st.maxSeq : upToSeq });
            return { ok: true, sid: newSid, messages: st.messages.slice() };
          });
        });
      }
      var src = sessions[sid];
      if (!src) return Promise.resolve({ ok: false, error: 'unknown sid' });
      var cut = upToSeq == null ? src.messages.length : Math.min(src.messages.length, Math.max(0, Number(upToSeq) || 0));
      ensureSession(newSid);
      appendEvents(newSid, [
        { type: 'session.create', sid: newSid, title: (src.title || sid) + ' · fork' },
        { type: 'session.branch', from: sid, fromSeq: cut },
        { type: 'msg.append', msgs: src.messages.slice(0, cut) }
      ]);
      return Promise.resolve({ ok: true, sid: newSid, messages: messagesOf(newSid) });
    }

    function removeSession(sid) {
      if (!sid) return;
      delete sessions[sid];
      var i = order.indexOf(sid);
      if (i !== -1) order.splice(i, 1);
      if (active && active.sid === sid) active = null;
      if (enabled() && api.remove) { try { Promise.resolve(api.remove(sid)).catch(err); } catch (e) { err(e); } }
    }

    // 把所有已知会话对齐落盘（历史上可能只有部分会话有 sid）
    function syncAll() {
      try {
        if (typeof historyStore !== 'undefined' && historyStore && Array.isArray(historyStore.conversation)) {
          historyStore.conversation.forEach(function (e) { if (e && Array.isArray(e.history)) { try { sync(e.history); } catch (_) {} } });
        }
      } catch (_) {}
      return { ok: true };
    }

    // fork 第 idx 条历史会话 → 新会话，并载入当前视图
    function forkEntry(idx) {
      return Promise.resolve().then(function () {
        if (typeof historyStore === 'undefined' || !historyStore) return { ok: false };
        var entry = historyStore.conversation[idx];
        if (!entry) return { ok: false };
        if (!entry.sid) sync(entry.history);
        var sid = entry.sid || refGet(entry.history);
        return fork(sid, null).then(function (r) {
          if (!r || !r.ok) return r;
          var newEntry = { id: (entry.id || '会话') + ' · fork', sid: r.sid, history: r.messages };
          refSet(newEntry.history, r.sid);
          historyStore.conversation.unshift(newEntry);
          if (typeof persist !== 'undefined' && persist) persist.save('historyStore', historyStore.conversation);
          try {
            if (typeof messageStore !== 'undefined' && messageStore) {
              messageStore.conversation = newEntry.history;
              if (messageStore.resetTimer) messageStore.resetTimer();
            }
            if (typeof renderConversation === 'function') renderConversation();
            if (typeof updateInputIcon === 'function') updateInputIcon();
          } catch (_) {}
          return r;
        });
      });
    }

    // 启动：磁盘有会话 → 以日志为事实源恢复；磁盘为空 → 迁移 localStorage 历史进日志
    function boot() {
      if (booted) return Promise.resolve({ ok: true, booted: false });
      if (!enabled() || !api.list) return Promise.resolve({ ok: true, booted: false, reason: 'no-api' });
      return Promise.resolve(api.list()).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: res && res.error };
        var disk = (res.sessions || []).filter(function (s) { return s && s.size > 0; });
        if (disk.length) {
          var chain = Promise.resolve();
          var entries = [];
          disk.forEach(function (s) {
            chain = chain.then(function () {
              return replay(s.sid).then(function (rr) {
                if (!rr || !rr.ok) return;
                entries.push({ id: rr.state.title || s.sid, sid: s.sid, history: rr.state.messages, _ts: rr.state.createdAt || s.mtimeMs || 0 });
              });
            });
          });
          return chain.then(function () {
            entries.sort(function (a, b) { return (a._ts || 0) - (b._ts || 0); });
            try {
              if (typeof historyStore !== 'undefined' && historyStore) {
                historyStore.conversation = entries.map(function (e) { return { id: e.id, sid: e.sid, history: e.history }; });
                if (typeof persist !== 'undefined' && persist) persist.save('historyStore', historyStore.conversation);
              }
            } catch (_) {}
            var last = entries[entries.length - 1];
            if (last) {
              try {
                if (typeof messageStore !== 'undefined' && messageStore) messageStore.conversation = last.history;
                refSet(last.history, last.sid);
                activate(last.sid, last.history);
                if (typeof renderConversation === 'function') renderConversation();
              } catch (_) {}
            }
            booted = true;
            return { ok: true, restored: entries.length, lastSid: last && last.sid };
          });
        }
        var migrated = 0;
        try {
          if (typeof historyStore !== 'undefined' && historyStore && Array.isArray(historyStore.conversation)) {
            historyStore.conversation.forEach(function (e) {
              if (!e || !Array.isArray(e.history) || e.sid) return;
              var sid = uuid();
              ensureSession(sid);
              appendEvents(sid, [
                { type: 'session.create', sid: sid, title: e.id || null },
                { type: 'msg.append', msgs: e.history.slice() }
              ]);
              e.sid = sid;
              refSet(e.history, sid);
              migrated++;
            });
            if (migrated && typeof persist !== 'undefined' && persist) persist.save('historyStore', historyStore.conversation);
          }
        } catch (_) {}
        booted = true;
        return { ok: true, migrated: migrated };
      }).catch(function (e) { err(e); return { ok: false, error: String((e && e.message) || e) }; });
    }

    return {
      VERSION: VERSION,
      isEnabled: enabled,
      enabled: enabled,
      boot: boot,
      sync: sync,
      syncAll: syncAll,
      recordRequest: recordRequest,
      sessionFor: sessionFor,
      activate: activate,
      activeSid: function () { return (active && active.sid) || null; },
      stateOf: stateOf,
      messagesOf: messagesOf,
      replay: replay,
      fork: fork,
      forkEntry: forkEntry,
      removeSession: removeSession,
      setMeta: setMeta,
      // 纯函数（供测试 / 调试）
      foldEvents: foldEvents,
      hashText: hashText,
      stableStringify: stableStringify,
      messageHash: messageHash,
      commonPrefixLen: commonPrefixLen,
      _sessions: function () { return sessions; },
      _order: function () { return order.slice(); }
    };
  }

  // 浏览器默认运行环境：注入 messagesAPI + historyStore 适配
  function defaultEnv(root) {
    return {
      api: (root && root.messagesAPI) || null,
      now: function () { return Date.now(); },
      uuid: genId,
      resolveSid: function (conv) {
        try {
          if (typeof historyStore === 'undefined' || !historyStore || !Array.isArray(historyStore.conversation)) return null;
          for (var i = 0; i < historyStore.conversation.length; i++) {
            var e = historyStore.conversation[i];
            if (e && e.history === conv && e.sid) return e.sid;
          }
        } catch (_) {}
        return null;
      },
      markSid: function (conv, sid) {
        try {
          if (typeof historyStore === 'undefined' || !historyStore || !Array.isArray(historyStore.conversation)) return;
          for (var i = 0; i < historyStore.conversation.length; i++) {
            var e = historyStore.conversation[i];
            if (e && e.history === conv) e.sid = sid;
          }
        } catch (_) {}
      },
      titleFor: function (conv) {
        try {
          for (var i = 0; i < conv.length; i++) {
            var m = conv[i];
            if (m && m.role === 'user') {
              var c = m.content;
              var t = Array.isArray(c) ? c.map(function (x) { return x && x.text || ''; }).join(' ') : String(c == null ? '' : c);
              t = t.trim().replace(/\s+/g, ' ').slice(0, 80);
              if (t) return t;
            }
          }
        } catch (_) {}
        return null;
      },
      onError: function (e) { try { console.warn('[sessionLog]', e); } catch (_) {} }
    };
  }

  return {
    VERSION: VERSION,
    createSessionLog: createSessionLog,
    defaultEnv: defaultEnv,
    foldEvents: foldEvents,
    applyEvent: applyEvent,
    hashText: hashText,
    stableStringify: stableStringify,
    messageHash: messageHash,
    commonPrefixLen: commonPrefixLen,
    genId: genId
  };
});
