/*!
 * guard.js — 循环卫生守卫（Loop-Hygiene Guard）纯逻辑模块
 * =============================================================================
 * 对齐 dsh 的 `guard/`：重复调用提醒（已有 createLoopGuard 负责）+ `tools/execute`
 * 截止时间强制执行（deadline enforcer，本模块补充统一实现）。
 *
 * 为什么需要 deadline：
 *   · 现有仅 run_shell / run_tests 自带超时；其它工具（外部 MCP、run_subagent、
 *     read_url、run_node 里的死循环 …）一旦挂住，整轮对话会永久卡死。
 *   · 在唯一收敛点 mcpStore.callTool 外包一层 Promise.race 超时，任何工具超时都
 *     变成「普通工具结果 + isError」返回给模型，而不是让 UI 一直转圈。
 *
 * 设计：
 *   · 纯逻辑、零依赖、UMD；withDeadline 可 node 单测（短超时）。
 *   · 默认豁免「本身就会长时间等待或自带超时」的工具：
 *       ask_user（等人）、run_shell / run_tests（自带 timeout_ms，最长 10 分钟）。
 *   · 超时只「不再等待」，不会强制杀死底层任务（副作用工具可能仍在后台完成）；
 *     因此有副作用的长任务应由工具自身的超时机制兜底。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ToolGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    deadlineMs: 600000, // 10 分钟；<=0 表示关闭
    exempt: ['ask_user', 'run_shell', 'run_tests', 'run_subagent']
  };

  function normConfig(cfg) {
    cfg = cfg || {};
    var deadlineMs = (cfg.deadlineMs == null) ? DEFAULTS.deadlineMs : Number(cfg.deadlineMs);
    if (!isFinite(deadlineMs)) deadlineMs = DEFAULTS.deadlineMs;
    var exempt = Array.isArray(cfg.exempt) ? cfg.exempt.slice() : DEFAULTS.exempt.slice();
    return {
      enabled: cfg.enabled !== false,
      deadlineMs: deadlineMs,
      exempt: exempt
    };
  }

  function isExempt(toolName, cfg) {
    var c = normConfig(cfg);
    if (!c.enabled) return true;
    if (c.deadlineMs <= 0) return true;
    return c.exempt.indexOf(toolName) >= 0;
  }

  // 返回本次调用的超时毫秒数；0 表示不限制。
  function deadlineFor(toolName, cfg) {
    var c = normConfig(cfg);
    return isExempt(toolName, c) ? 0 : c.deadlineMs;
  }

  // 给任意 Promise 加截止时间。超时 reject 一个带 code='TOOL_DEADLINE' 的 Error。
  function withDeadline(promise, ms, label) {
    ms = Number(ms) || 0;
    if (ms <= 0) return Promise.resolve(promise);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('工具执行超时：' + (label || 'tool') + '（' + ms + 'ms 未返回）');
        e.code = 'TOOL_DEADLINE';
        e.timeoutMs = ms;
        e.tool = label || '';
        reject(e);
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    normConfig: normConfig,
    isExempt: isExempt,
    deadlineFor: deadlineFor,
    withDeadline: withDeadline
  };
});
