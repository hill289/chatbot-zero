/*!
 * workspace-context.js — 工作区上下文（Workspace Context）纯逻辑模块
 * =============================================================================
 * 对齐 dsh 的 `context/`：把模型应当知道的「会话级事实」注入请求：
 *   · 项目指令（AGENTS.md / CLAUDE.md …）；
 *   · 当前工作目录（working_directory）；
 *   · 当前时间（时间上下文）。
 *
 * 铁律：只注入到「对话尾部最后一条 user 消息」，绝不改动被 prefixManager 缓存的
 *       system + tools 前缀 —— 否则每轮都会破坏前缀缓存命中。
 *
 * 纯逻辑、零依赖、UMD（浏览器 window.WorkspaceContext / Node module.exports）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkspaceContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    includeTime: true,
    maxAgentsChars: 8000,
    instructionNames: ['AGENTS.md', 'CLAUDE.md', 'AGENT.md']
  };

  function norm(opts) {
    opts = opts || {};
    var max = Number(opts.maxAgentsChars);
    if (!isFinite(max) || max <= 0) max = DEFAULTS.maxAgentsChars;
    return {
      enabled: opts.enabled !== false,
      includeTime: opts.includeTime !== false,
      maxAgentsChars: max,
      instructionNames: Array.isArray(opts.instructionNames) ? opts.instructionNames.slice() : DEFAULTS.instructionNames.slice()
    };
  }

  function truncate(text, max) {
    text = String(text == null ? '' : text);
    max = Number(max) || DEFAULTS.maxAgentsChars;
    if (text.length <= max) return { text: text, truncated: false, omitted: 0 };
    return { text: text.slice(0, max), truncated: true, omitted: text.length - max };
  }

  function pad2(n) {
    n = Number(n) || 0;
    return (n < 10 ? '0' : '') + n;
  }

  function formatTime(now, timezone) {
    var d = (now instanceof Date) ? now : new Date(now == null ? Date.now() : now);
    if (isNaN(d.getTime())) return '';
    var off = -d.getTimezoneOffset(); // 分钟（东为正）
    var sign = off >= 0 ? '+' : '-';
    var ao = Math.abs(off);
    var tz = timezone || ('UTC' + sign + pad2(Math.floor(ao / 60)) + ':' + pad2(ao % 60));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' (' + tz + ')';
  }

  function compose(opts) {
    opts = opts || {};
    var o = norm(opts);
    if (!o.enabled) return '';

    var parts = [];
    if (opts.agentsText && String(opts.agentsText).trim()) {
      var tr = truncate(opts.agentsText, o.maxAgentsChars);
      var name = opts.fileName || 'AGENTS.md';
      parts.push('【项目指令 · ' + name + '】\n' + tr.text +
        (tr.truncated ? ('\n…（已截断，省略 ' + tr.omitted + ' 字符）') : ''));
    }
    if (opts.workingDirectory) {
      parts.push('【工作目录】' + String(opts.workingDirectory));
    }
    if (o.includeTime) {
      var t = formatTime(opts.now, opts.timezone);
      if (t) parts.push('【当前时间】' + t);
    }
    if (!parts.length) return '';

    return '<workspace-context>\n（系统自动注入的工作区上下文，仅作参考；与用户最新指令冲突时以用户为准）\n' +
      parts.join('\n\n') + '\n</workspace-context>';
  }

  function pickInstructionFile(names, existsFn) {
    names = Array.isArray(names) ? names : DEFAULTS.instructionNames;
    for (var i = 0; i < names.length; i++) {
      try { if (existsFn(names[i])) return names[i]; } catch (_) {}
    }
    return null;
  }

  return {
    DEFAULTS: DEFAULTS,
    norm: norm,
    truncate: truncate,
    formatTime: formatTime,
    compose: compose,
    pickInstructionFile: pickInstructionFile
  };
});
