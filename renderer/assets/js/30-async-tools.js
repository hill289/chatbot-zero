/*!
 * 30-async-tools.js — 异步工具 start()/stop() 适配层（Super-agent 模块 4 · 异步 ReAct）
 * =============================================================================
 * 对齐优化方案 4.1：把「耗时命令/子任务」类工具改造为 start()/stop()——
 * 调用**立即返回** { started:true, taskId }，真实执行在后台；完成后结果作为
 * **一条新事件**回注（onResult），使 ReAct 循环不再 await 到工具完成才继续。
 *
 * 本文件是纯适配层（不碰 DOM、不做 IO）：真实执行 run(name,args) 由上层注入
 * （可复用 jobs.js 的后台作业），因此可 Node 单测。
 *
 * UMD：浏览器挂 globalThis.AsyncTools / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AsyncTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 可异步化的工具（其余工具仍同步阻塞，保持既有语义）
  var ASYNC_TOOLS = ['run_shell', 'run_tests', 'run_subagent', 'run_node'];
  var ASYNC_SET = {};
  ASYNC_TOOLS.forEach(function (n) { ASYNC_SET[n] = 1; });

  function isAsyncTool(name) { return !!ASYNC_SET[name]; }

  function createAsyncToolController(deps) {
    deps = deps || {};
    var run = deps.run; // (name, args) => Promise<result>
    var onResult = (typeof deps.onResult === 'function') ? deps.onResult : function () {};
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var genId = (typeof deps.genId === 'function') ? deps.genId
      : (function () { var n = 0; return function () { n++; return 'at-' + Date.now().toString(36) + '-' + n; }; })();
    var tasks = {};

    function start(name, args) {
      if (!isAsyncTool(name)) return { started: false, reason: 'not-async-tool' };
      if (typeof run !== 'function') return { started: false, reason: 'no-runner' };
      var taskId = genId();
      var rec = { taskId: taskId, name: name, args: args || {}, status: 'running', startedAt: now(), endedAt: null };
      tasks[taskId] = rec;
      var p;
      try { p = run(name, args || {}); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (result) {
        if (tasks[taskId] && rec.status !== 'cancelled') {
          rec.status = 'done'; rec.endedAt = now(); rec.result = result;
          try {
            onResult({ taskId: taskId, name: name, status: 'done', result: result, at: rec.endedAt });
          } catch (_) {}
        }
      }).catch(function (err) {
        if (tasks[taskId] && rec.status !== 'cancelled') {
          rec.status = 'failed'; rec.endedAt = now(); rec.error = (err && err.message) || String(err);
          try {
            onResult({ taskId: taskId, name: name, status: 'failed', error: rec.error, at: rec.endedAt });
          } catch (_) {}
        }
      });
      return { started: true, taskId: taskId };
    }

    function stop(taskId) {
      var rec = tasks[taskId];
      if (!rec) return false;
      rec.status = 'cancelled'; rec.endedAt = now();
      return true;
    }

    function get(taskId) {
      var r = tasks[taskId];
      return r ? { taskId: r.taskId, name: r.name, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt } : null;
    }
    function list() { return Object.keys(tasks).map(function (k) { return get(k); }); }

    return { start: start, stop: stop, get: get, list: list };
  }

  return {
    ASYNC_TOOLS: ASYNC_TOOLS,
    isAsyncTool: isAsyncTool,
    createAsyncToolController: createAsyncToolController
  };
});
