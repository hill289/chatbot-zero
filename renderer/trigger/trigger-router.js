/*!
 * trigger-router.js — Trigger 路由 + Thread↔Worker 订阅表纯逻辑（模块 3.2）
 * =============================================================================
 * 对齐优化方案 模块 3.2「订阅直通」：
 *   · 已订阅事件（thread → [workerId] 多对多）→ 程序直发对应 Worker，不进 Router；
 *   · 未订阅事件 → 交 Router 冷启动 Worker。
 * 本文件纯逻辑、零依赖、可 Node 单测（持久化由上层注入 storage，落 APP_DIR/threads/）。
 *
 * UMD：浏览器挂 globalThis.TriggerRouter / Node module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TriggerRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function threadOf(event) {
    event = event || {};
    if (event.thread != null && String(event.thread) !== '') return String(event.thread);
    if (event.path != null && String(event.path) !== '') return 'path:' + String(event.path);
    var src = event.source != null ? String(event.source) : 'event';
    var key = event.group != null ? event.group : (event.channel != null ? event.channel : 'default');
    return src + ':' + key;
  }

  // 可注入 storage（{ load():obj, save(obj) }）以持久化订阅表
  function createSubscriptionStore(initial, storage) {
    var map = {}; // thread -> [workerId,...]
    function normalize(v) { return Array.isArray(v) ? v.slice() : []; }
    if (initial && typeof initial === 'object') {
      Object.keys(initial).forEach(function (k) { map[k] = normalize(initial[k]); });
    } else if (storage && typeof storage.load === 'function') {
      var loaded = null;
      try { loaded = storage.load(); } catch (_) {}
      if (loaded && typeof loaded === 'object') Object.keys(loaded).forEach(function (k) { map[k] = normalize(loaded[k]); });
    }
    function persist() { if (storage && typeof storage.save === 'function') { try { storage.save(map); } catch (_) {} } }

    return {
      add: function (thread, workerId) {
        if (thread == null || workerId == null) return;
        var t = String(thread);
        if (!map[t]) map[t] = [];
        if (map[t].indexOf(workerId) === -1) { map[t].push(workerId); persist(); }
      },
      remove: function (thread, workerId) {
        var t = String(thread);
        if (!map[t]) return;
        var i = map[t].indexOf(workerId);
        if (i !== -1) { map[t].splice(i, 1); if (!map[t].length) delete map[t]; persist(); }
      },
      removeThread: function (thread) { delete map[String(thread)]; persist(); },
      get: function (thread) { return (map[String(thread)] || []).slice(); },
      list: function () { return JSON.parse(JSON.stringify(map)); },
      toJSON: function () { return JSON.parse(JSON.stringify(map)); }
    };
  }

  // subscriptions：订阅表实例（有 get/list）或纯对象映射
  function workersOf(subscriptions, thread) {
    if (!subscriptions) return [];
    if (typeof subscriptions.get === 'function') return subscriptions.get(thread) || [];
    var v = subscriptions[thread];
    return Array.isArray(v) ? v : [];
  }

  function route(event, subscriptions) {
    var t = threadOf(event);
    var workers = workersOf(subscriptions, t);
    if (workers.length) {
      return { type: 'direct', thread: t, workerId: workers[0], workerIds: workers.slice() };
    }
    return { type: 'router', thread: t };
  }

  return {
    threadOf: threadOf,
    createSubscriptionStore: createSubscriptionStore,
    route: route
  };
});
