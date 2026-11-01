/*!
 * agent-control.js — 子代理控制面（List / Send / Interrupt）纯逻辑
 * =============================================================================
 * 对齐 dsh 的 `subagent/` 控制工具（list_agents / send_message / interrupt_agent）。
 * 这里只做「状态判定 + 文本渲染」，真正的窗口操作由 bootstrap 注入 subagentStore。
 * UMD：浏览器 window.AgentControl / Node module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AgentControl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { snippetChars: 120 };

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

  function statusOf(win) {
    if (!win) return 'missing';
    if (win._guardAborted) return 'aborted';
    if (win.generating) return 'generating';
    if (win.isRunningTask) return 'running';
    if (win.taskQueue && win.taskQueue.length > 0) return 'queued';
    return 'idle';
  }

  function lastText(win, role) {
    var conv = (win && win.conversation) || [];
    for (var i = conv.length - 1; i >= 0; i--) {
      var m = conv[i];
      if (m && m.role === role) {
        var t = textOf(m.content).replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }
    return '';
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    n = n || DEFAULTS.snippetChars;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function summarize(win, opts) {
    opts = opts || {};
    var status = statusOf(win);
    var label = {
      idle: '空闲', running: '运行中', generating: '生成中', queued: '排队中', aborted: '已中止', missing: '不存在'
    }[status] || status;
    var count = (win && win.conversation) ? win.conversation.length : 0;
    var snip = lastText(win, 'assistant') || lastText(win, 'user');
    return {
      id: win && win.id,
      title: (win && win.title) || '',
      status: status,
      statusLabel: label,
      hidden: !!(win && win.hidden),
      messages: count,
      snippet: clip(snip, opts.snippetChars)
    };
  }

  function formatList(windows, opts) {
    if (!windows || !windows.length) return '当前没有 agent（子代理）窗口。可用 run_subagent 启动一个。';
    var lines = ['Agents（' + windows.length + '）：'];
    windows.forEach(function (w) {
      var s = summarize(w, opts);
      lines.push('#' + s.id + ' [' + s.statusLabel + (s.hidden ? '·隐藏' : '') + '] 🤖 ' + s.title +
        ' — 消息 ' + s.messages + ' 条' + (s.snippet ? ('；最近：' + s.snippet) : ''));
    });
    return lines.join('\n');
  }

  function findById(windows, id) {
    var n = Number(id);
    for (var i = 0; i < (windows || []).length; i++) {
      if (Number(windows[i].id) === n) return windows[i];
    }
    return null;
  }

  return {
    DEFAULTS: DEFAULTS,
    textOf: textOf,
    statusOf: statusOf,
    lastText: lastText,
    clip: clip,
    summarize: summarize,
    formatList: formatList,
    findById: findById
  };
});
