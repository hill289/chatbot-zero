/*!
 * watchdog-core.js — Watchdog 自愈巡检「纯逻辑」核心（Super-agent 模块 6）
 * =============================================================================
 * 设计目标（对齐优化方案 模块 6 · Watchdog）：
 *   · 在主系统之外提供一个独立的巡检判定内核：给定「某个 Worker 的快照」与
 *     其「任务的快照」，判定它是否健康；不健康时给出**原因 + 建议动作**。
 *   · 它是纯函数、零依赖、可 Node 单测；真正的定时驱动 / 作动器
 *     （agent-control 的 list_agents / send_message / interrupt_agent）
 *     由运行时（31-watchdog.js / runner）注入，本文件不做任何 IO。
 *
 * 判定维度（方案 6）：
 *   1) 基础设施故障：接口报错 / job interrupted / guard 连续失败 → escalate
 *   2) 无实质进展：Worker 在跑但长时间没有任何进展时间戳变化 → interrupt
 *   3) 方向偏离：由语义层（LLM）给出 deviation 信号，透传为 nudge → send
 *
 * 契约：
 *   assess(workerSnapshot, taskSnapshot, opts) -> {
 *       healthy: boolean,
 *       code: 'ok'|'no-worker'|'inactive'|'infra-failure'|'no-progress'|'deviation',
 *       reason: string,
 *       action: 'none'|'interrupt'|'send'|'escalate',
 *       severity: 'info'|'warn'|'error'
 *   }
 *
 * workerSnapshot（缺失项按「未知」保守处理，不误报）：
 *   { id, status, lastProgressAt, lastActivityAt, messageCount,
 *     toolCalls, lastToolError, lastErrorAt, toolErrorStreak }
 *   status ∈ idle|running|generating|queued|aborted|missing
 * taskSnapshot：
 *   { id, stage, status, updatedAt, stepsDone, stepsTotal, artifactsCount }
 *   status ∈ running|paused|done|failed
 * opts：
 *   { now, stallMs=90000, infraErrorWindowMs=120000, maxToolErrorStreak=3,
 *     deviation:{detected,reason} }
 *
 * UMD：浏览器挂 globalThis.WatchdogCore；Node 下 module.exports（可 node --test）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WatchdogCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    stallMs: 90000,            // 90s 无进展即视为疑似卡死
    infraErrorWindowMs: 120000, // 近 120s 内报错视为基础设施异常
    maxToolErrorStreak: 3      // 同一处连续失败达该值视为基础设施故障
  };

  var ACTIVE_WORKER_STATUS = { running: 1, generating: 1 };

  function nowOf(opts) {
    if (opts && typeof opts.now === 'number') return opts.now;
    return Date.now();
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function result(healthy, code, reason, action, severity) {
    return {
      healthy: !!healthy,
      code: code,
      reason: reason || '',
      action: action || 'none',
      severity: severity || (healthy ? 'info' : 'warn')
    };
  }

  // 基础设施故障判定：显式 fatal / 近期报错 / toolErrorStreak 超阈值
  function detectInfraFailure(worker, opts, now) {
    var inf = (worker && worker.infra) || (opts && opts.infra) || {};
    if (inf.fatal) return '基础设施致命故障：' + (inf.reason || 'fatal');
    if (inf.jobInterrupted) return '后台作业被中断（job interrupted）';
    var streak = num(inf.toolErrorStreak);
    if (streak == null) streak = num(worker && worker.toolErrorStreak);
    if (streak != null && streak >= opts.maxToolErrorStreak) {
      return '工具连续失败 ' + streak + ' 次（疑似接口/执行环境故障）';
    }
    var lastErrAt = num(inf.lastErrorAt);
    if (lastErrAt == null) lastErrAt = num(worker && worker.lastErrorAt);
    if (lastErrAt != null && (now - lastErrAt) <= opts.infraErrorWindowMs) {
      return '近期发生接口/执行报错（' + Math.max(0, Math.round((now - lastErrAt) / 1000)) + 's 前）';
    }
    return null;
  }

  // 主判定
  function assess(workerSnapshot, taskSnapshot, opts) {
    var o = {};
    var k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    var now = nowOf(o);

    var worker = workerSnapshot || null;
    var task = taskSnapshot || null;

    // 1) 没有 Worker 可看 → 无需介入
    var status = worker && worker.status ? String(worker.status) : (worker ? 'idle' : 'missing');
    if (!worker || status === 'missing') {
      return result(true, 'no-worker', '没有可巡检的 Worker', 'none', 'info');
    }

    // 2) 任务已终态 / 用户暂停 → 巡检无需动作（避免误伤人工接管）
    var tstatus = task && task.status ? String(task.status) : null;
    var tstage = task && task.stage ? String(task.stage) : null;
    if (tstatus === 'done' || tstatus === 'failed' || tstage === 'done' || tstage === 'failed' || tstage === 'paused') {
      return result(true, 'inactive', '任务已结束或暂停（无需巡检介入）', 'none', 'info');
    }

    // 3) 基础设施故障（最高优先级：先止损/上报）
    var infraReason = detectInfraFailure(worker, o, now);
    if (infraReason) {
      return result(false, 'infra-failure', infraReason, 'escalate', 'error');
    }

    // 4) 无实质进展：Worker 在跑，但「进度时间戳」长时间不前进
    if (ACTIVE_WORKER_STATUS[status]) {
      var lastProgress = num(worker.lastProgressAt);
      if (lastProgress == null) lastProgress = num(worker.lastActivityAt);
      if (lastProgress == null) lastProgress = num(worker.startedAt);
      if (lastProgress != null && (now - lastProgress) >= o.stallMs) {
        var secs = Math.round((now - lastProgress) / 1000);
        return result(false, 'no-progress',
          'Worker 已 ' + secs + 's 无实质进展（疑似卡死/空转）', 'interrupt', 'warn');
      }
    }

    // 5) 方向偏离（语义层信号透传）：只做提醒，不打断
    if (o.deviation && o.deviation.detected) {
      return result(false, 'deviation',
        '疑似偏离目标：' + (o.deviation.reason || '方向可能已偏'),
        'send', 'warn');
    }

    return result(true, 'ok', '健康', 'none', 'info');
  }

  // 批量巡检：对 [{worker,task}] 逐个 assess，返回不健康清单
  function assessAll(snapshots, opts) {
    var issues = [];
    (snapshots || []).forEach(function (s) {
      var r = assess(s && s.worker, s && s.task, opts);
      if (!r.healthy) {
        issues.push({
          workerId: s && s.worker && s.worker.id,
          taskId: s && s.task && s.task.id,
          code: r.code, reason: r.reason, action: r.action, severity: r.severity
        });
      }
    });
    return issues;
  }

  return {
    DEFAULTS: DEFAULTS,
    assess: assess,
    assessAll: assessAll,
    detectInfraFailure: detectInfraFailure
  };
});
