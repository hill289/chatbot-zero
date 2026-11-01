/*!
 * kb-health/detector.js — 发现项运行器（Findings Runner）
 * =============================================================================
 * 忠实移植 Yuheng findings/runner.go + repository.Reconcile 的语义：
 *
 *   run(kbId, docId)：
 *     1. 逐个检测器 Detect（duplicate/review/feedback），跳过 ErrUnsupported；
 *     2. 同指纹取证据更强（score 更高）的一条；
 *     3. route —— 按 AssignRule 经 steward 落 assignee；
 *        手工改派过（assignedBy 非空）的发现项不被覆盖；
 *     4. Reconcile（幂等对账）：
 *        · 上报的指纹 upsert：
 *            open → open（更新证据）；
 *            resolved → 重开（问题回来了）；
 *            dismissed + evidenceHash 相同 → 保持 dismissed
 *            （人忽略的就是这份证据），evidenceHash 变了 → 重开；
 *        · 本次运行的检测器【未上报】且与本文档相关的 open →
 *          resolved（resolvedBy=system, resolution=cleared，自动销案）。
 *
 * 检测器契约：{ name, detect(kbId, docId, ctx) → Promise<Candidate[]> }
 *   Candidate = { type, severity, assign, subjectDocId, relatedDocId?,
 *                 score, fingerprint?, details, _assignRule? }
 *
 * UMD：浏览器挂 globalThis.KBRunner，Node 下 module.exports。
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
  if (root) root.KBRunner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var steward = deps.steward;

  var detectors = [];    // [{ name, detect }]
  var running = {};      // docId 级防抖/防重入
  var pending = {};      // 触发合并（同文档短窗合并为一次）

  function register(detector) {
    if (!detector || !detector.name || typeof detector.detect !== 'function') {
      throw new Error('detector 需要 name + detect()');
    }
    if (detectors.some(function (d) { return d.name === detector.name; })) return false;
    detectors.push(detector);
    detectors.sort(function (a, b) { return a.name < b.name ? -1 : 1; });   // 按名排序可复现
    return true;
  }

  function listDetectors() { return detectors.map(function (d) { return d.name; }); }

  function severityValid(s) {
    return s === store.FINDING.INFO || s === store.FINDING.WARNING || s === store.FINDING.ERROR;
  }

  /**
   * run(kbId, docId, opts) — 对一篇文档跑全部检测器并幂等对账。
   * 返回 { findings: number, ran: [detector names] }。
   * opts.now 可注入（测试）；opts.detectors 限定子集（如只跑 feedback 复检）。
   *
   * 并发语义：同一文档已有检查在跑时，**排队等它结束后再跑一次**（而非
   * 静默丢弃）—— 调用方（如 settle/recheck、UI 点结案）await 的是本次
   * 「检查真的发生过」，丢弃会让复检永远不会执行、await 也永远悬着。
   */
  function run(kbId, docId, opts) {
    if (running[docId]) {
      var inflight = running[docId];
      return inflight.catch(function () { /* 上一轮失败不阻塞排队 */ })
        .then(function () { return run(kbId, docId, opts); });
    }
    var p = Promise.resolve().then(function () { return execRun(kbId, docId, opts); });
    running[docId] = p;
    return p.then(function (r) { delete running[docId]; return r; },
      function (e) { delete running[docId]; throw e; });
  }

  function execRun(kbId, docId, opts) {
    opts = opts || {};
    var nowTs = opts.now != null ? opts.now : Date.now();

    var doc = store.documents.get(docId);
    if (!doc || doc.kbId !== kbId) return Promise.resolve({ findings: 0, ran: [] });

    var active = detectors.filter(function (d) {
      return !opts.detectors || opts.detectors.indexOf(d.name) >= 0;
    });

    var byFingerprint = {};
    var rules = {};
    var ran = [];
    var failures = [];

    return active.reduce(function (chain, det) {
      return chain.then(function () {
        var maybe;
        try { maybe = det.detect(kbId, docId, { now: nowTs }); }
        catch (e) { failures.push(det.name + ': ' + (e && e.message)); return; }
        return Promise.resolve(maybe).then(function (candidates) {
          ran.push(det.name);
          (candidates || []).forEach(function (c) {
            var err = validate(c);
            if (err) { failures.push(det.name + ': ' + err); return; }
            var fp = c.fingerprint || defaultFingerprint(c.type, kbId, c.subjectDocId, c.relatedDocId);
            var prev = byFingerprint[fp];
            // 同一问题被两个检测器/两个方向上报 → 取证据更强
            if (prev && (prev.score || 0) >= (c.score || 0)) return;
            c.fingerprint = fp;
            c._assignRule = c.assign || steward.RULE.SUBJECT_OWNER;
            byFingerprint[fp] = c;
            rules[fp] = c._assignRule;
          });
        }).catch(function (e) { failures.push(det.name + ': ' + (e && e.message)); });
      });
    }, Promise.resolve()).then(function () {
      if (!ran.length) return { findings: 0, ran: [], failures: failures };

      var reported = Object.keys(byFingerprint).sort();
      var fingerprints = reported.map(function (fp) { return byFingerprint[fp]; });

      // 3) 路由
      var docIds = [];
      fingerprints.forEach(function (f) {
        if (docIds.indexOf(f.subjectDocId) < 0) docIds.push(f.subjectDocId);
        if (f.relatedDocId && docIds.indexOf(f.relatedDocId) < 0) docIds.push(f.relatedDocId);
      });
      var stewardsMap = steward.stewards(docIds, nowTs);
      var kb = store.kbs.get(kbId);
      var kbDefault = kb && kb.defaultOwnerId ? kb.defaultOwnerId : '';
      fingerprints.forEach(function (f) {
        if (f.assignedBy && f.assigneeId) return;   // 手工改派优先
        f.assigneeId = steward.routeFinding(
          Object.assign({}, f, { _assignRule: rules[f.fingerprint] }),
          stewardsMap, kbDefault
        ) || '';
      });

      // 4) Reconcile：upsert 上报项 + 销案未上报的 open
      return reconcile(kbId, docId, fingerprints, ran, nowTs).then(function (count) {
        return { findings: count, ran: ran, failures: failures };
      });
    });
  }

  function validate(c) {
    if (!c || !c.type || c.type.length > 32) return '类型缺失或超长';
    if (!severityValid(c.severity)) return 'severity 非法: ' + c.severity;
    if (!c.subjectDocId || c.subjectDocId === c.relatedDocId) return 'subject 缺失或与 related 相同';
    if (c.fingerprint && c.fingerprint.length > 128) return '指纹超长';
    return null;
  }

  function defaultFingerprint(type, kbId, aId, bId) {
    var lo = aId < bId ? aId : (bId || aId), hi = aId < bId ? bId : aId;
    return store.stableId(['fp', type, kbId, lo, hi].join('|'));
  }

  /**
   * reconcile — 幂等对账（对齐 upsertFinding + resolveUnreported）。
   * 返回 open 发现项总数。
   */
  function reconcile(kbId, docId, candidates, ranDetectors, nowTs) {
    var F = store.FINDING;
    var jobs = [];

    candidates.forEach(function (c) {
      var existing = store.findings.byFingerprint(c.fingerprint);
      var row;
      if (!existing) {
        row = {
          id: 'f-' + c.fingerprint.slice(0, 24) + '-' + stableShort(c.fingerprint + docId),
          kbId: kbId,
          type: c.type,
          detector: c._detector || guessDetector(c.type),
          severity: c.severity,
          status: F.OPEN,
          fingerprint: c.fingerprint,
          subjectDocId: c.subjectDocId,
          relatedDocId: c.relatedDocId || '',
          score: c.score != null ? c.score : 1,
          details: c.details || {},
          assigneeId: c.assigneeId || '',
          assignedBy: '',
          resolution: '',
          resolvedBy: '',
          resolvedAt: null,
          createdAt: nowTs,
          updatedAt: nowTs
        };
        jobs.push(store.findings.put(row));
      } else {
        var keepDismissed = existing.status === F.DISMISSED &&
          (existing.details && existing.details.evidenceHash) ===
          ((c.details && c.details.evidenceHash) || '');
        var wasResolved = existing.status === F.RESOLVED;
        row = Object.assign({}, existing, {
          type: c.type,
          severity: c.severity,
          subjectDocId: c.subjectDocId,
          relatedDocId: c.relatedDocId || '',
          score: c.score != null ? c.score : existing.score,
          details: c.details || existing.details,
          status: keepDismissed ? F.DISMISSED : F.OPEN,
          // dismissed 保持原结案字段；其余（含 resolved 重开）清空
          resolvedAt: keepDismissed ? existing.resolvedAt : null,
          resolvedBy: keepDismissed ? existing.resolvedBy : '',
          resolution: keepDismissed ? existing.resolution : '',
          // 路由：手工改派保持，否则用本次路由结果
          assigneeId: existing.assignedBy ? existing.assigneeId : (c.assigneeId || existing.assigneeId),
          updatedAt: nowTs
        });
        if (wasResolved && !keepDismissed) { /* 问题回来：resolved → open（上面已置） */ }
        jobs.push(store.findings.put(row));
      }
    });

    // 未上报的 open → resolved(system/cleared)
    // 范围：subject 或 related 是本文档，detector 属于本次运行
    var reportedSet = {};
    candidates.forEach(function (c) { reportedSet[c.fingerprint] = true; });
    store.findings.list({ kbId: kbId, status: F.OPEN }).forEach(function (f) {
      if (ranDetectors.indexOf(f.detector) < 0) return;
      if (f.subjectDocId !== docId && f.relatedDocId !== docId) return;
      if (reportedSet[f.fingerprint]) return;
      jobs.push(store.findings.settle(f.id, {
        status: F.RESOLVED,
        resolvedAt: nowTs,
        resolvedBy: F.SYSTEM,
        resolution: F.CLEARED
      }));
    });

    return Promise.all(jobs).then(function () {
      return candidates.length;
    });
  }

  function guessDetector(type) {
    if (type === store.FINDING.STALE) return 'review';
    if (type === store.FINDING.DISPUTED) return 'feedback';
    return 'duplicate';
  }

  function stableShort(s) { return store.stableId(s).slice(0, 8); }

  // ── 触发合并（ingest 高频写入时短窗合并，避免重复全量比对）──────────────
  var TRIGGER_DEBOUNCE_MS = 500;

  function trigger(kbId, docId, opts) {
    var key = kbId + '|' + docId;
    if (pending[key]) {
      clearTimeout(pending[key]);
      delete pending[key];
    }
    return new Promise(function (resolve) {
      pending[key] = setTimeout(function () {
        delete pending[key];
        // 文档可能在等待期间被删
        if (!store.documents.get(docId)) { resolve({ findings: 0, ran: [] }); return; }
        steward.ensureOwner(docId).then(function () {
          return run(kbId, docId, opts);
        }).then(resolve, function () { resolve({ findings: 0, ran: [] }); });
      }, (opts && opts.debounceMs != null) ? opts.debounceMs : TRIGGER_DEBOUNCE_MS);
    });
  }

  return {
    register: register,
    listDetectors: listDetectors,
    run: run,
    trigger: trigger,
    reconcile: reconcile
  };
});
