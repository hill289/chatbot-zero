/*!
 * kb-health/dispute.js — 反馈归因检测器（disputed）
 * =============================================================================
 * 移植 Yuheng findings/dispute.go + message_feedback.go 的语义：
 *
 *   「没帮助」是文档可能有错的最直接信号 —— 有人问了真实的问题，
 *   知识库答砸了，答案的出处就是被引的那几篇文档。
 *
 *   · 计数：统计该文档【最近一次背书之后】收到的 down 反馈行数
 *     （背书 = 确认仍有效 / 被修改 —— owner 看过了，旧账清零，
 *      此后再有差评是新争议）；
 *   · 严重度：1~2 条 = info（可能是问题本身刁钻）；≥3 条 = warning
 *     （多次差评就是文档的问题）；
 *   · 证据：最新 3 条报告（问题摘录、回答摘录、用户评论）；
 *   · evidenceHash：count + 最新反馈 id/时间 —— 新差评改变哈希 →
 *     被忽略的争议重新出现（别人也觉得答案不对）。
 *
 *   触发：用户点「没帮助」→ recordFeedback 落行 → runner.trigger 被引文档。
 *
 * UMD：浏览器挂 globalThis.KBDispute，Node 下 module.exports。
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
  if (root) root.KBDispute = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var steward = deps.steward;

  var NAME = 'feedback';
  var WARNING_COUNT = 3;    // disputeWarningCount
  var REPORTS = 3;          // disputeReports
  var DAY_MS = 24 * 60 * 60 * 1000;

  function pairFingerprint(type, kbId, docId) {
    return store.stableId(['solo', type, kbId, docId].join('|'));
  }

  function clip(s, n) {
    var arr = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
    return arr.length > n ? arr.slice(0, n - 1).join('') + '…' : arr.join('');
  }

  /**
   * detect(kbId, docId, ctx) — 统计 since lastVouchedAt 的差评。
   */
  function detect(kbId, docId, ctx) {
    var nowTs = (ctx && ctx.now != null) ? ctx.now : Date.now();
    var st = steward.stewardOf(docId, nowTs);
    if (!st || st.status !== store.DOC_STATUS.ACTIVE) return Promise.resolve([]);

    var since = st.lastVouchedAt || 0;
    // 严格晚于背书时刻才算「背书后的新差评」：同一毫秒内先点差评、后确认
    // 背书的反馈若用 >= 会被误算成新争议 → 确认后销不掉案（时序偶发）。
    var downs = store.feedback.list({ docId: docId, rating: 'down' })
      .filter(function (f) { return f.createdAt > since; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!downs.length) return Promise.resolve([]);

    var count = downs.length;
    var severity = count >= WARNING_COUNT ? store.FINDING.WARNING : store.FINDING.INFO;
    var doc = store.documents.get(docId);

    var reports = downs.slice(0, REPORTS).map(function (f) {
      var cite = store.citations.byMessage(f.messageId);
      var ref = null;
      if (cite && cite.refs) {
        for (var i = 0; i < cite.refs.length; i++) {
          if (cite.refs[i].docId === docId) { ref = cite.refs[i]; break; }
        }
      }
      return {
        feedbackId: f.id,
        at: new Date(f.createdAt).toISOString(),
        question: f.shareQuestion ? clip(f.question || '', 160) : '',   // 只有选择附上才带出
        excerpt: ref ? clip(ref.excerpt, 160) : '',
        comment: clip(f.comment || '', 160)
      };
    });

    return Promise.resolve([{
      type: store.FINDING.DISPUTED,
      severity: severity,
      assign: steward.RULE.SUBJECT_OWNER,
      subjectDocId: docId,
      score: count,
      fingerprint: pairFingerprint(store.FINDING.DISPUTED, kbId, docId),
      details: {
        evidence: [],
        evidenceHash: disputeHash(count, downs[0]),
        extra: {
          count: count,
          reports: reports,
          doc_title: doc ? doc.title : ''
        }
      }
    }]);
  }

  function disputeHash(count, latest) {
    var tail = latest ? (latest.id + '@' + latest.createdAt) : '';
    return store.stableId(count + '|' + tail);
  }

  /**
   * recheckFeedback(mentionOfDocIds, runner) — 反馈落行后对被引文档复检
   * （对齐 message_feedback.recheckCited：best-effort，文档下次变更也会再查）。
   */
  function recheckFeedback(docIds, runner, kbIdOf) {
    var seen = {};
    var jobs = [];
    (docIds || []).slice(0, 10).forEach(function (docId) {   // maxDisputedCitations
      if (seen[docId]) return;
      seen[docId] = true;
      var doc = store.documents.get(docId);
      if (!doc) return;
      var kbId = kbIdOf || doc.kbId;
      jobs.push(runner.trigger(kbId, docId, { debounceMs: 200 }));
    });
    return Promise.all(jobs);
  }

  return {
    NAME: NAME,
    detect: detect,
    recheckFeedback: recheckFeedback,
    WARNING_COUNT: WARNING_COUNT
  };
});
