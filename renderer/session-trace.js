/*!
 * session-trace.js — 会话检索 / 血缘追踪（Session Trace）纯逻辑
 * =============================================================================
 * 对齐 dsh 的 `session-query/` 中「有界读取 + 血缘 + 事件检索」这一层：
 * 在既有 append-only 事件日志（messages/<sid>/events.jsonl）之上做纯逻辑折叠，
 * 提供 session_trace / session_event_search / session_event_read 的渲染能力。
 * UMD：window.SessionTrace / Node module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SessionTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { maxHits: 20, maxEventChars: 2000 };

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (p) {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text || '';
        return '';
      }).join('\n');
    }
    return String(content);
  }

  function foldSummary(events, sid) {
    var st = {
      sid: sid || null, title: null, createdAt: null, updatedAt: null,
      messages: [], requests: 0, branch: null, maxSeq: 0, eventCount: (events || []).length,
      types: {}
    };
    var sorted = (events || []).slice().sort(function (a, b) { return ((a && a.seq) || 0) - ((b && b.seq) || 0); });
    sorted.forEach(function (ev) {
      if (!ev || !ev.type) return;
      if (ev.seq != null && ev.seq > st.maxSeq) st.maxSeq = ev.seq;
      if (ev.ts) st.updatedAt = ev.ts;
      st.types[ev.type] = (st.types[ev.type] || 0) + 1;
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
          st.requests++;
          break;
        default:
          break;
      }
    });
    st.lastMessage = st.messages.length ? st.messages[st.messages.length - 1] : null;
    return st;
  }

  function formatTrace(st) {
    st = st || {};
    var lines = [];
    lines.push('会话：' + (st.sid || '(未知)'));
    if (st.title) lines.push('标题：' + st.title);
    if (st.createdAt) lines.push('创建：' + fmtTs(st.createdAt) + (st.updatedAt ? ('　更新：' + fmtTs(st.updatedAt)) : ''));
    lines.push('事件：' + (st.eventCount || 0) + ' 条，消息：' + ((st.messages && st.messages.length) || 0) + ' 条，模型请求：' + (st.requests || 0) + ' 次');
    if (st.branch && st.branch.from) lines.push('血缘：由 ' + st.branch.from + ' fork（fromSeq=' + st.branch.fromSeq + '）');
    var types = st.types || {};
    var tk = Object.keys(types).sort();
    if (tk.length) lines.push('事件类型：' + tk.map(function (k) { return k + '×' + types[k]; }).join(', '));
    if (st.lastMessage) lines.push('最后一条：[' + st.lastMessage.role + '] ' + clip(textOf(st.lastMessage.content), 160));
    return lines.join('\n');
  }

  function fmtTs(ts) {
    try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (_) { return String(ts); }
  }

  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    n = n || 160;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function eventText(ev) {
    if (!ev) return '';
    if (ev.type === 'msg.append' && Array.isArray(ev.msgs)) {
      return ev.msgs.map(function (m) { return '[' + (m.role || '?') + '] ' + textOf(m.content); }).join('\n');
    }
    if (ev.type === 'msg.replace' && Array.isArray(ev.msgs)) return textOf(ev.msgs);
    if (ev.text) return String(ev.text);
    if (ev.content) return textOf(ev.content);
    return '';
  }

  function searchEvents(events, query, opts) {
    opts = opts || {};
    var q = String(query == null ? '' : query).trim();
    if (!q) return [];
    var max = opts.maxHits || DEFAULTS.maxHits;
    var lq = q.toLowerCase();
    var hits = [];
    (events || []).forEach(function (ev) {
      var txt = eventText(ev);
      if (!txt) return;
      var at = txt.toLowerCase().indexOf(lq);
      if (at < 0) return;
      var start = Math.max(0, at - 40);
      hits.push({
        seq: ev.seq, type: ev.type,
        snippet: (start > 0 ? '…' : '') + txt.slice(start, at + q.length + 80).replace(/\s+/g, ' ') + (at + q.length + 80 < txt.length ? '…' : '')
      });
    });
    return hits.slice(0, max);
  }

  function formatSearch(query, hits) {
    if (!hits || !hits.length) return '未在会话事件中找到「' + query + '」。';
    var lines = ['在会话事件中找到 ' + hits.length + ' 处「' + query + '」：'];
    hits.forEach(function (h, i) {
      lines.push((i + 1) + '. [seq ' + h.seq + ' · ' + h.type + '] ' + h.snippet);
    });
    return lines.join('\n');
  }

  function formatEventList(events, opts) {
    opts = opts || {};
    var max = opts.maxEvents || 50;
    var maxChars = opts.maxEventChars || DEFAULTS.maxEventChars;
    var list = (events || []).slice(0, max);
    if (!list.length) return '（该会话没有事件）';
    var lines = ['事件（显示 ' + list.length + ' / ' + (events || []).length + '）：'];
    list.forEach(function (ev) {
      var head = 'seq ' + ev.seq + ' · ' + ev.type + (ev.ts ? (' · ' + fmtTs(ev.ts)) : '');
      var body = clip(eventText(ev), maxChars);
      lines.push(head + (body ? ('\n  ' + body) : ''));
    });
    return lines.join('\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    textOf: textOf,
    foldSummary: foldSummary,
    formatTrace: formatTrace,
    searchEvents: searchEvents,
    formatSearch: formatSearch,
    formatEventList: formatEventList,
    fmtTs: fmtTs
  };
});
