/*!
 * 28-trigger-bus.js — Trigger 运行时总线（Super-agent 模块 3 · 事件驱动）
 * =============================================================================
 * 把纯逻辑 trigger-filter / trigger-router 接到运行时（workerPool / routerSession）：
 *   收到事件 → 程序 Fast-Path 过滤 → 订阅直通 or 交 Router（可先投机执行）。
 *
 * 纯编排层：filter / router / routerSession / workerPool 全部依赖注入，可 Node 单测。
 * UMD：浏览器挂 globalThis.TriggerBus / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TriggerBus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTriggerBus(deps) {
    deps = deps || {};
    var filter = deps.filter;
    var router = deps.router;
    var rules = deps.rules || {};
    var subscriptions = deps.subscriptions || {};
    var routerSession = deps.routerSession || null;
    var workerPool = deps.workerPool || null;

    // 分类：仅做确定性 Fast-Path（不触发任何执行）
    function classify(event) {
      var r = filter.programFilter(event, rules);
      if (!r.admit) return { action: 'deny', reason: r.reason };
      var rt = router.route(event, subscriptions);
      if (rt.type === 'direct') {
        return { action: 'direct', thread: rt.thread, workerId: rt.workerId, workerIds: rt.workerIds };
      }
      return { action: 'router', thread: rt.thread, prompt: filter.semanticPromptFor(event) };
    }

    // 摄取事件：Fast-Path 分类 + （可选）Slow-Path 决策驱动派单
    //   decision: { act:boolean, workerTask:string }（由语义层给出；不传则返回 needs-semantic）
    function ingest(event, decision) {
      var c = classify(event);
      if (c.action === 'deny' || c.action === 'direct') {
        if (c.action === 'direct' && routerSession && typeof routerSession.forwardToWorker === 'function') {
          try { routerSession.forwardToWorker(c.workerId, event); } catch (_) {}
        }
        return c;
      }
      // c.action === 'router'
      if (decision && decision.act && routerSession && typeof routerSession.dispatch === 'function') {
        var sp = routerSession.dispatch({ task: decision.workerTask || String(event.text || ''), source: event.source, thread: c.thread });
        return { action: 'dispatched', thread: c.thread, workerId: sp && sp.workerId, accepted: !!(sp && sp.accepted) };
      }
      return c; // 交 Router / 待语义判定
    }

    // 投机执行：弱信号先在后台做「低承诺」准备（可被丢弃）
    function speculate(event) {
      if (!workerPool || typeof workerPool.spawn !== 'function') return { action: 'none' };
      var sp = workerPool.spawn({ task: String(event.text || ''), speculative: true, title: 'spec' });
      return { action: 'speculated', workerId: sp && sp.workerId, accepted: !!(sp && sp.accepted) };
    }

    return { classify: classify, ingest: ingest, speculate: speculate };
  }

  return { createTriggerBus: createTriggerBus };
});
