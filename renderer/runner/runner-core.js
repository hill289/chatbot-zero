/*!
 * runner/runner-core.js — 无头 Runner 核心（Super-agent 模块 5.1 · 计算/状态分离）
 * =============================================================================
 * 目标：让 Agent Loop 能脱离 UI 标签页、在 Electron 主进程常驻推进（A 档）。
 * 本文件是**纯驱动核心**（不依赖 Electron）：
 *   · selectResumable(tasks)：按「未完成任务」筛出可自动拉起的任务（对齐任务中心中断恢复）
 *   · isResumableTask(task)
 *   · createRunner({ hasWork, step, save, now, maxSteps })：
 *       驱动「有活就一步步推进」，带步数上限护栏，每步后可落盘。
 * 真正的 loadState / step / save（读 messages/<sid> 恢复并驱动推理）由上层注入，
 * 因此本文件可 Node 单测；`runner/agent-runner.js` 只是 Electron 侧的薄封装。
 *
 * UMD：浏览器挂 globalThis.RunnerCore / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RunnerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isResumableTask(task) {
    if (!task || typeof task !== 'object') return false;
    var status = task.status ? String(task.status) : '';
    var stage = task.stage ? String(task.stage) : '';
    if (status === 'done' || status === 'failed') return false;
    if (stage === 'done' || stage === 'failed') return false;
    // interrupted / paused / executing / planning / verifying 均视为可恢复
    return true;
  }

  function selectResumable(tasks) {
    return (Array.isArray(tasks) ? tasks : []).filter(isResumableTask);
  }

  function createRunner(deps) {
    deps = deps || {};
    var hasWork = (typeof deps.hasWork === 'function') ? deps.hasWork : function () { return false; };
    var step = deps.step;
    var save = deps.save;
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var maxSteps = (typeof deps.maxSteps === 'number' && deps.maxSteps > 0) ? deps.maxSteps : 1000;

    function run() {
      if (typeof step !== 'function') return Promise.resolve({ steps: 0, done: !hasWork(), ok: false, reason: 'no-step' });
      var n = 0;
      var hitLimit = false;
      function loop() {
        if (!hasWork()) return Promise.resolve();
        if (n >= maxSteps) { hitLimit = true; return Promise.resolve(); }
        return Promise.resolve(step()).then(function () {
          n++;
          if (typeof save === 'function') { try { save(); } catch (_) {} }
          return loop();
        });
      }
      return loop().then(function () {
        return { steps: n, done: !hasWork(), hitLimit: hitLimit, at: now() };
      });
    }

    return { run: run, maxSteps: maxSteps };
  }

  return {
    isResumableTask: isResumableTask,
    selectResumable: selectResumable,
    createRunner: createRunner
  };
});
