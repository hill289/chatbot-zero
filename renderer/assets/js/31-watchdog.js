/*!
 * 31-watchdog.js — Watchdog 运行时（Super-agent 模块 6 · 自愈巡检控制回路）
 * =============================================================================
 * 由定时器驱动：取各 Worker/任务快照 → 用 watchdog-core.assessAll 判定 →
 * 对异常用「作动器」(agent-control 的 interrupt / send / escalate) 介入，
 * 并记录自愈日志。核心判定是纯逻辑（watchdog-core.js），本文件只做「取快照 +
 * 定时 + 作动 + 记账」。依赖全部注入，可 Node 单测。
 *
 * UMD：浏览器挂 globalThis.Watchdog / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Watchdog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createWatchdog(deps) {
    deps = deps || {};
    var core = deps.core;
    var snapshots = (typeof deps.snapshots === 'function') ? deps.snapshots : function () { return []; };
    var assessOpts = deps.assessOpts || {};
    var actuator = deps.actuator || {};
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var setTimer = (typeof deps.setTimer === 'function') ? deps.setTimer
      : function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = (typeof deps.clearTimer === 'function') ? deps.clearTimer
      : function (t) { clearTimeout(t); };
    var intervalMs = (typeof deps.intervalMs === 'number' && deps.intervalMs > 0) ? deps.intervalMs : 60000;
    var log = [];
    var running = false;
    var timer = null;

    function actOn(it) {
      var rec = { at: now(), workerId: it.workerId, taskId: it.taskId, code: it.code, reason: it.reason, action: it.action, did: 'none' };
      try {
        if (it.code === 'infra-failure') {
          if (typeof actuator.escalate === 'function') { actuator.escalate(it); rec.did = 'escalate'; }
        } else if (it.code === 'no-progress') {
          if (typeof actuator.interrupt === 'function') { actuator.interrupt(it.workerId, it.reason); rec.did = 'interrupt'; }
        } else if (it.code === 'deviation') {
          if (typeof actuator.send === 'function') { actuator.send(it.workerId, '疑似偏离目标：' + it.reason); rec.did = 'send'; }
        }
      } catch (e) { rec.error = (e && e.message) || String(e); }
      return rec;
    }

    // 单次巡检（纯同步，便于测试）
    function tick() {
      if (!core || typeof core.assessAll !== 'function') return { issues: [], at: now() };
      var snaps = [];
      try { snaps = snapshots() || []; } catch (e) { snaps = []; }
      var opts = {};
      for (var k in assessOpts) if (Object.prototype.hasOwnProperty.call(assessOpts, k)) opts[k] = assessOpts[k];
      if (opts.now === undefined) opts.now = now();
      var issues = core.assessAll(snaps, opts);
      var acted = issues.map(function (it) {
        var rec = actOn(it);
        log.push(rec);
        if (log.length > 500) log.shift();
        return rec;
      });
      return { issues: acted, at: now() };
    }

    function start() {
      if (running) return false;
      running = true;
      var loop = function () { if (!running) return; try { tick(); } catch (_) {} timer = setTimer(loop, intervalMs); };
      timer = setTimer(loop, intervalMs);
      return true;
    }
    function stop() { running = false; if (timer != null) { try { clearTimer(timer); } catch (_) {} timer = null; } }
    function isRunning() { return running; }
    function history() { return log.slice(); }

    return { tick: tick, start: start, stop: stop, isRunning: isRunning, history: history, intervalMs: intervalMs };
  }

  return { createWatchdog: createWatchdog };
});
