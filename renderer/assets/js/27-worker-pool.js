/*!
 * 27-worker-pool.js — Worker 池（Super-agent 模块 2 · 双层架构）
 * =============================================================================
 * 把现有 subagentStore 的「多窗口独立会话」抽象为可编排的 Worker 池：
 *   · spawn(taskSpec)  → 从池里派一个 Worker 执行任务，**异步**返回 { workerId, accepted }
 *   · report(id,payload) → Worker 向 Router 汇报「状态/进度/结论」事件
 *   · list() / get(id)  → 池视图（供 Router 汇总、Watchdog 巡检）
 *   · kill(id)          → 终止某 Worker
 *
 * 设计原则（对齐优化方案「唯一收敛点 + 依赖注入可测」）：
 *   · 本文件是**编排层**，不直接操作 DOM，也不内置具体 store：
 *     通过 deps.store（具备 createWindow / removeWindow）注入，方便 Node 单测。
 *   · Worker 只向 Router 汇报，不直接面向最终用户；汇报出口 deps.onReport 由
 *     RouterSession 注入（无 Router 时退化为日志/忽略，符合「兼容回灌」降级）。
 *   · 汇报事件统一形状：{ workerId, taskId, status, summary, at }。
 *
 * UMD：浏览器挂 globalThis.WorkerPool / Node 下 module.exports（可 node --test）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkerPool = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUS = { running: 1, done: 1, failed: 1, killed: 1 };

  function createWorkerPool(deps) {
    deps = deps || {};
    var store = deps.store || null;
    var emit = (typeof deps.onReport === 'function') ? deps.onReport : function () {};
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var seq = 0;
    var records = {};   // workerId -> record
    var order = [];     // workerId 派单顺序

    function idOf(win) {
      if (win && win.id != null) return win.id;
      seq += 1;
      return 'w-' + seq;
    }

    function summaryOf(rec) {
      return {
        id: rec.id,
        taskId: rec.taskId,
        status: rec.status,
        title: rec.title || '',
        startedAt: rec.startedAt,
        updatedAt: rec.updatedAt,
        reports: rec.reports.length,
        lastReport: rec.reports.length ? rec.reports[rec.reports.length - 1] : null
      };
    }

    function pushReport(rec, payload) {
      payload = payload || {};
      var at = (typeof payload.at === 'number') ? payload.at : now();
      var rep = {
        workerId: rec.id,
        taskId: rec.taskId,
        status: payload.status || rec.status,
        summary: payload.summary != null ? payload.summary : '',
        at: at
      };
      if (payload.status && STATUS[payload.status]) rec.status = payload.status;
      rec.updatedAt = at;
      rec.reports.push(rep);
      if (rec.reports.length > 200) rec.reports.shift(); // 防无限增长
      try { emit(rep); } catch (_) {}
      return rep;
    }

    function spawn(spec) {
      spec = spec || {};
      if (!store || typeof store.createWindow !== 'function') {
        return { workerId: null, accepted: false, error: 'no-store' };
      }
      var win = store.createWindow(spec.title);
      var id = idOf(win);
      var rec = {
        id: id,
        taskId: spec.taskId || (spec.task ? String(spec.task).slice(0, 60) : ('task-' + id)),
        title: spec.title || '',
        task: spec.task || '',
        status: 'running',
        startedAt: now(),
        updatedAt: now(),
        reports: [],
        result: null,
        error: null,
        _win: win
      };
      records[id] = rec;
      order.push(id);
      pushReport(rec, { status: 'running', summary: '已派单，开始执行' });

      // 异步执行：派单即返回（配合模块 4 全双工）；完成/失败均以「汇报事件」回投
      var p;
      try {
        p = win.runTask(spec.task || '', spec.context || '');
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).then(function (result) {
        if (records[id] && records[id].status !== 'killed') {
          rec.result = result;
          pushReport(rec, { status: 'done', summary: result });
        }
      }).catch(function (err) {
        if (records[id] && records[id].status !== 'killed') {
          rec.error = (err && err.message) || String(err);
          pushReport(rec, { status: 'failed', summary: rec.error });
        }
      });

      return { workerId: id, accepted: true };
    }

    function report(workerId, payload) {
      var rec = records[workerId];
      if (!rec) return null;
      return pushReport(rec, payload);
    }

    function get(workerId) {
      var rec = records[workerId];
      return rec ? summaryOf(rec) : null;
    }

    function list() {
      return order.map(function (id) { return summaryOf(records[id]); });
    }

    function kill(workerId) {
      var rec = records[workerId];
      if (!rec) return false;
      rec.status = 'killed';
      try {
        if (store && typeof store.removeWindow === 'function' && rec.id != null) store.removeWindow(rec.id);
        else if (rec._win && typeof rec._win.stop === 'function') rec._win.stop();
      } catch (_) {}
      pushReport(rec, { status: 'killed', summary: 'Worker 已被终止' });
      return true;
    }

    function clear() {
      records = {};
      order = [];
    }

    return {
      spawn: spawn,
      report: report,
      get: get,
      list: list,
      kill: kill,
      clear: clear,
      size: function () { return order.length; }
    };
  }

  // 适配真实 subagentStore（其窗口自带 runTask / id；subagentStore 有 createWindow/removeWindow）
  function createSubagentStoreAdapter(subagentStore) {
    return {
      createWindow: function (title) { return subagentStore.createWindow(title); },
      removeWindow: function (id) { return subagentStore.removeWindow(id); }
    };
  }

  return {
    STATUS: STATUS,
    createWorkerPool: createWorkerPool,
    createSubagentStoreAdapter: createSubagentStoreAdapter
  };
});
