/*!
 * session-trace-bootstrap.js — 会话检索工具（session_list / session_trace /
 *   session_event_search / session_event_read）
 * 依赖：renderer/session-trace.js（纯逻辑）、preload 注入的 window.messagesAPI。
 */
(function () {
  'use strict';
  var CORE = (typeof window !== 'undefined' && window.SessionTrace) || null;
  if (!CORE) { try { console.warn('[session-trace] session-trace.js 未加载，跳过接线'); } catch (_) {} return; }

  function api() { return (typeof window !== 'undefined') ? window.messagesAPI : null; }
  function need() { var a = api(); if (!a) throw new Error('会话检索需要 Electron 外壳（messagesAPI 不可用）'); return a; }

  function readEvents(sid, fromSeq) {
    return Promise.resolve(need().read(sid, fromSeq ? { fromSeq: fromSeq } : undefined)).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '读取会话失败');
      return r.events || [];
    });
  }

  function toolSessionList() {
    var a = api();
    if (!a || typeof a.list !== 'function') return { error: '会话检索需要 Electron 外壳（messagesAPI 不可用）' };
    return Promise.resolve(a.list()).then(function (r) {
      if (!r || !r.ok) return { error: (r && r.error) || 'session_list 失败' };
      var sessions = r.sessions || [];
      var lines = ['会话（' + sessions.length + '）：'];
      sessions.slice(0, 50).forEach(function (s) {
        lines.push(s.sid + '  ' + (s.size || 0) + 'B' + (s.mtimeMs ? ('  ' + new Date(s.mtimeMs).toISOString().slice(0, 19)) : ''));
      });
      return { sessions: sessions, formatted: lines.join('\n') };
    });
  }

  function toolSessionTrace(args) {
    args = args || {};
    if (!args.session_id) return { error: 'session_trace 需要 session_id（可用 session_list 获取）' };
    return readEvents(args.session_id).then(function (events) {
      var st = CORE.foldSummary(events, args.session_id);
      return { summary: { sid: st.sid, title: st.title, messages: st.messages.length, requests: st.requests, branch: st.branch, maxSeq: st.maxSeq }, formatted: CORE.formatTrace(st) };
    }).catch(function (e) { return { error: (e && e.message) || String(e) }; });
  }

  function toolEventSearch(args) {
    args = args || {};
    var query = String(args.query || '').trim();
    if (!query) return { error: 'session_event_search 需要 query' };
    var a = need();
    var sid = args.session_id;
    var chain;
    if (sid) {
      chain = readEvents(sid).then(function (events) { return [{ sid: sid, events: events }]; });
    } else {
      chain = Promise.resolve(a.list()).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'list failed');
        var list = (r.sessions || []).slice(0, 10);
        return Promise.all(list.map(function (s) {
          return readEvents(s.sid).then(function (ev) { return { sid: s.sid, events: ev }; }).catch(function () { return { sid: s.sid, events: [] }; });
        }));
      });
    }
    return chain.then(function (sources) {
      var allHits = [];
      sources.forEach(function (src) {
        CORE.searchEvents(src.events, query, { maxHits: args.limit || 20 }).forEach(function (h) {
          allHits.push(Object.assign({ sid: src.sid }, h));
        });
      });
      if (allHits.length > (args.limit || 20)) allHits = allHits.slice(0, args.limit || 20);
      return { hits: allHits, formatted: CORE.formatSearch(query, allHits) };
    }).catch(function (e) { return { error: (e && e.message) || String(e) }; });
  }

  function toolEventRead(args) {
    args = args || {};
    if (!args.session_id) return { error: 'session_event_read 需要 session_id' };
    return readEvents(args.session_id, args.from_seq).then(function (events) {
      var list = events;
      if (args.to_seq != null) list = events.filter(function (ev) { return ev.seq <= args.to_seq; });
      return { events: list, formatted: CORE.formatEventList(list, { maxEvents: args.max_events || 50 }) };
    }).catch(function (e) { return { error: (e && e.message) || String(e) }; });
  }

  var TOOLS = [
    {
      name: 'session_list',
      description: '列出磁盘上的所有归档会话（sid、大小、时间）。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: function () { return toolSessionList(); }
    },
    {
      name: 'session_trace',
      description: '读取某会话的事件日志并折叠出摘要：消息数、模型请求数、血缘（fork 来源）、事件类型统计。',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: '会话 id（来自 session_list / search_transcript）' } },
        required: ['session_id'], additionalProperties: false
      },
      handler: function (a) { return toolSessionTrace(a); }
    },
    {
      name: 'session_event_search',
      description: '在会话事件日志中全文检索（可指定 session_id，缺省检索最近 10 个会话），返回 seq + 片段。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          session_id: { type: 'string', description: '可选：限定某个会话' },
          limit: { type: 'integer', description: '最多命中数（默认 20）' }
        },
        required: ['query'], additionalProperties: false
      },
      handler: function (a) { return toolEventSearch(a); }
    },
    {
      name: 'session_event_read',
      description: '按 seq 区间读取某会话的原始事件（用于查看工具调用 / 请求锚点等细节）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '会话 id' },
          from_seq: { type: 'integer', description: '起始 seq（可选）' },
          to_seq: { type: 'integer', description: '结束 seq（可选）' },
          max_events: { type: 'integer', description: '最多返回事件数（默认 50）' }
        },
        required: ['session_id'], additionalProperties: false
      },
      handler: function (a) { return toolEventRead(a); }
    }
  ];

  function register() {
    if (typeof window.registerTool !== 'function') { setTimeout(register, 100); return; }
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, { source: 'session-trace', builtin: true, override: true });
      else TOOLS.forEach(function (t) { window.registerTool(t, { source: 'session-trace', builtin: true, override: true }); });
    } catch (e) { try { console.warn('[session-trace] 注册失败', e); } catch (_) {} }
  }
  register();
})();
