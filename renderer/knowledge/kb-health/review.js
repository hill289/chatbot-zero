/*!
 * kb-health/review.js — 复审周期检测器（stale）
 * =============================================================================
 * 移植 Yuheng findings/review.go：
 *
 *   大多数知识是「没人改就过期了」——VPN 地址换了、制度在会上修订了，
 *   任何文档比对都发现不了。知识库设了复审周期（kb.reviewIntervalDays），
 *   到期没人确认/修改的文档产生 stale 发现项，送交负责人：
 *     · 负责人「确认仍有效」（vouch）→ 时钟重启 → 下次 check 销案；
 *     · 负责人改文档 → ingest 的 lastVouchedAt=now 同样重启 → 销案；
 *     · 周期被关闭（interval=0）→ 检测器照常跑、判定不过 → 销案
 *       （所以 Supports 语义上「无不适用，只有无到期」）。
 *
 *   严重度：过期 1 个周期 = info；再过 1 个完整周期 = warning。
 *   evidenceHash = dueAt（一轮复审一条发现：「这轮到期」被忽略后，
 *   下一轮 dueAt 变了 → 指纹/哈希变化 → 重新出现）。
 *
 *   sweep：启动时 + 每小时扫「到期未确认」的文档并调度 check
 *   （纯前端无常驻任务：漏一个 tick 下次补，多次 sweep 由 trigger 的
 *   debounce 合并）。
 *
 * UMD：浏览器挂 globalThis.KBReview，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('../kb-store.js'), steward: require('../kb-steward.js') };
  } else {
    deps = { store: root.KBStore, steward: root.KBSteward };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var steward = deps.steward;

  var NAME = 'review';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var SWEEP_INTERVAL_MS = 60 * 60 * 1000;   // ReviewSweepInterval：每小时
  var SWEEP_BATCH = 500;                    // reviewSweepBatch

  function pairFingerprint(type, kbId, docId) {
    return store.stableId(['solo', type, kbId, docId].join('|'));
  }

  /**
   * detect(kbId, docId, ctx) — 到期判定（每次都跑，保证确认/修改即时销案）。
   * 注意：KB 没设周期 ≠ 不适用 —— 周期刚被关掉时，open 的 stale 必须由
   * 「跑了但不产出」的检测器销案（Reconcile 机制）。
   */
  function detect(kbId, docId, ctx) {
    var nowTs = (ctx && ctx.now != null) ? ctx.now : Date.now();
    var st = steward.stewardOf(docId, nowTs);
    if (!st || st.status !== store.DOC_STATUS.ACTIVE) return Promise.resolve([]);
    if (st.reviewDueAt == null) return Promise.resolve([]);   // 未设周期：无到期
    if (!st.overdue) return Promise.resolve([]);

    var severity = store.FINDING.INFO;
    // 过期再满一个完整周期 → warning
    var intervalMs = st.intervalDays * DAY_MS;
    if (nowTs > st.lastVouchedAt + 2 * intervalMs) severity = store.FINDING.WARNING;

    return Promise.resolve([{
      type: store.FINDING.STALE,
      severity: severity,
      assign: steward.RULE.SUBJECT_OWNER,
      subjectDocId: docId,
      score: 1,
      fingerprint: pairFingerprint(store.FINDING.STALE, kbId, docId),
      details: {
        evidence: [],
        evidenceHash: String(st.reviewDueAt),   // 一轮复审一条发现
        extra: {
          due_at: new Date(st.reviewDueAt).toISOString(),
          last_vouched_at: new Date(st.lastVouchedAt).toISOString(),
          interval_days: st.intervalDays,
          days_overdue: st.daysOverdue
        }
      }
    }]);
  }

  /**
   * sweep(kbId, runner, opts) — 扫到期文档并调度 check。
   * 返回 { due, scheduled }。opts.now / opts.limit / opts.trigger 可注入。
   */
  function sweep(kbId, runner, opts) {
    opts = opts || {};
    var nowTs = opts.now != null ? opts.now : Date.now();
    var limit = opts.limit || SWEEP_BATCH;
    var triggerFn = opts.trigger || function (k, d) { return runner.trigger(k, d, { debounceMs: 0 }); };
    var due = steward.listDue(kbId, nowTs).slice(0, limit);
    var scheduled = 0;
    return due.reduce(function (chain, st) {
      return chain.then(function () {
        return Promise.resolve(triggerFn(st.kbId, st.docId)).then(function () { scheduled++; },
          function () { /* 调度失败下轮再补 */ });
      });
    }, Promise.resolve()).then(function () {
      return { due: due.length, scheduled: scheduled };
    });
  }

  /**
   * startSweep(runner, opts) — 周期 sweep（启动即跑一轮 + interval 循环）。
   * 返回 stop()。opts.intervalMs 可注入（测试用短周期）。
   */
  function startSweep(runner, opts) {
    opts = opts || {};
    if (opts.enabled === false) return function () {};
    var intervalMs = opts.intervalMs || SWEEP_INTERVAL_MS;
    var timer = null;
    var stopped = false;
    function tick() {
      if (stopped) return;
      var kbs = store.kbs.list();
      kbs.reduce(function (chain, kb) {
        return chain.then(function () { return sweep(kb.id, runner, opts); });
      }, Promise.resolve()).catch(function () { /* sweep 失败不致命，下轮再跑 */ });
    }
    // 启动即扫一轮（对齐 ReviewSweep 的「missed tick 下次补」哲学）
    setTimeout(tick, opts.initialDelayMs != null ? opts.initialDelayMs : 50);
    timer = setInterval(tick, intervalMs);
    return function stop() { stopped = true; if (timer) clearInterval(timer); };
  }

  return {
    NAME: NAME,
    detect: detect,
    sweep: sweep,
    startSweep: startSweep,
    SWEEP_INTERVAL_MS: SWEEP_INTERVAL_MS
  };
});
