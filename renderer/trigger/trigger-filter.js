/*!
 * trigger-filter.js — Trigger 两级过滤的「程序 Fast-Path」纯逻辑（模块 3.1）
 * =============================================================================
 * 对齐优化方案 模块 3：环境事件 → 程序 Fast-Path 过滤（确定性规则）→
 * 语义 Slow-Path 判定（LLM）。本文件只做 Fast-Path + 生成 Slow-Path 提示词，
 * 纯函数、零依赖、可 Node 单测。
 *
 * programFilter(event, rules) -> { admit, route, reason }
 *   event: { source, group, author, text, path, channel, thread }
 *   rules: {
 *     allowSources:[], denySources:[],
 *     allowGroups:[], denyGroups:[],
 *     keywords:[], denyKeywords:[],
 *     pathInclude:[], pathExclude:[],   // 子串包含（简易 glob）
 *     routes:{ source: {type:'router'|'direct'} }
 *   }
 *
 * semanticPromptFor(event) -> string  （交给 Slow-Path LLM 判定是否行动）
 *
 * UMD：浏览器挂 globalThis.TriggerFilter / Node module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TriggerFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function arr(v) { return Array.isArray(v) ? v : []; }
  function has(list, v) { return arr(list).indexOf(v) !== -1; }
  function containsAny(text, list) {
    text = String(text == null ? '' : text);
    var a = arr(list);
    for (var i = 0; i < a.length; i++) { if (a[i] && text.indexOf(String(a[i])) !== -1) return String(a[i]); }
    return null;
  }

  function programFilter(event, rules) {
    event = event || {};
    rules = rules || {};
    var source = event.source != null ? String(event.source) : '';
    var group = event.group != null ? String(event.group) : '';
    var text = event.text != null ? String(event.text) : '';
    var path = event.path != null ? String(event.path) : '';

    function deny(reason) { return { admit: false, route: null, reason: reason }; }

    // 来源黑白名单
    if (has(rules.denySources, source)) return deny('来源被拒：' + source);
    if (arr(rules.allowSources).length && !has(rules.allowSources, source)) return deny('来源不在白名单：' + source);

    // 群组黑白名单（仅在有 group 时生效）
    if (group) {
      if (has(rules.denyGroups, group)) return deny('群组被拒：' + group);
      if (arr(rules.allowGroups).length && !has(rules.allowGroups, group)) return deny('群组不在白名单：' + group);
    }

    // 关键词
    var dk = containsAny(text, rules.denyKeywords);
    if (dk) return deny('命中排除关键词：' + dk);
    if (arr(rules.keywords).length) {
      var k = containsAny(text, rules.keywords);
      if (!k) return deny('未命中任一关键词');
    }

    // 路径包含/排除
    if (arr(rules.pathInclude).length) {
      if (!containsAny(path, rules.pathInclude)) return deny('路径不在包含规则内：' + path);
    }
    var pe = containsAny(path, rules.pathExclude);
    if (pe) return deny('路径命中排除规则：' + pe);

    var route = (rules.routes && rules.routes[source]) ? rules.routes[source] : { type: 'router' };
    return { admit: true, route: route, reason: 'program-filter 通过' };
  }

  function eventSummary(event) {
    event = event || {};
    var parts = [];
    if (event.source) parts.push('来源=' + event.source);
    if (event.group) parts.push('群组=' + event.group);
    if (event.author) parts.push('作者=' + event.author);
    if (event.path) parts.push('路径=' + event.path);
    if (event.channel) parts.push('信道=' + event.channel);
    if (event.text) parts.push('内容=' + String(event.text).slice(0, 500));
    return parts.join('；');
  }

  function semanticPromptFor(event) {
    return [
      '你是事件分诊器（Slow-Path）。判断下面这个环境事件是否值得启动/继续一个 Agent 任务。',
      '事件：' + eventSummary(event),
      '请只返回严格 JSON：{"act": true|false, "reason":"...", "workerTask":"若 act 为 true，给出交给 Worker 的任务描述"}',
      '判定原则：与用户目标相关、需要采取动作（回复/修复/实现）才 act=true；纯噪声、无需行动则 act=false。'
    ].join('\n');
  }

  return {
    programFilter: programFilter,
    semanticPromptFor: semanticPromptFor,
    eventSummary: eventSummary
  };
});
