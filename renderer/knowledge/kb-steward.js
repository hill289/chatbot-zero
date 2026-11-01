/*!
 * kb-steward.js — 负责人 / 背书 / 复审到期 / 路由（Knowledge Stewardship）
 * =============================================================================
 * 移植 Yuheng knowledge_stewardship.go + findings/runner.go 的 assign 语义：
 *
 *   · 每篇文档有 owner（负责人）；每篇文档有 lastVouchedAt（最近背书）——
 *     「确认仍有效」或「被修改」都算背书，时钟重新起算；
 *   · 复审到期 = lastVouchedAt + kb.reviewIntervalDays（0 = 不复审）；
 *   · 发现项路由规则（AssignRule）：
 *       latest_hand    → 最近背书更晚一方的负责人（谁改的新政策谁负责）
 *       stalest_owner  → 最久没背书一方的负责人（复审/争议找最该看的人）
 *       subject_owner  → 主文档负责人
 *     拾不到人时回退到另一方；两方都空则返回 ''（由调用方落默认负责人）。
 *
 * UMD：浏览器挂 globalThis.KBSteward，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js') };
  } else {
    deps = { store: root.KBStore };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBSteward = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var RULE = {
    LATEST_HAND: 'latest_hand',
    STALEST_OWNER: 'stalest_owner',
    SUBJECT_OWNER: 'subject_owner'
  };

  /**
   * stewardOf(docId) — 文档的管家视图（不存在返回 null）。
   * 返回 { docId, ownerId, ownerName, lastVouchedAt, reviewDueAt, intervalDays,
   *        overdue, daysOverdue, status }
   * reviewDueAt 派生自 lastVouchedAt + interval（interval<=0 → null）。
   */
  function stewardOf(docId, nowTs) {
    var doc = store.documents.get(docId);
    if (!doc) return null;
    var kb = store.kbs.get(doc.kbId);
    var interval = kb && kb.reviewIntervalDays > 0 ? kb.reviewIntervalDays : 0;
    var due = interval > 0 ? (doc.lastVouchedAt || doc.createdAt || 0) + interval * DAY_MS : null;
    var nowTs2 = nowTs != null ? nowTs : Date.now();
    var overdue = due != null && nowTs2 > due;
    var owner = doc.ownerId ? store.members.get(doc.ownerId) : null;
    return {
      docId: doc.id,
      kbId: doc.kbId,
      ownerId: doc.ownerId || '',
      ownerName: owner ? owner.name : '',
      lastVouchedAt: doc.lastVouchedAt || doc.createdAt || 0,
      reviewDueAt: due,
      intervalDays: interval,
      overdue: overdue,
      daysOverdue: overdue ? Math.floor((nowTs2 - due) / DAY_MS) : 0,
      status: doc.status
    };
  }

  function stewards(docIds, nowTs) {
    var out = {};
    (docIds || []).forEach(function (id) {
      var st = stewardOf(id, nowTs);
      if (st) out[id] = st;
    });
    return out;
  }

  /**
   * vouch(docId, by) — 背书：确认仍有效（或调用方先改了文档）。
   * 重置 lastVouchedAt → 复审时钟重启、争议计数归零（dispute 检测基于
   * since lastVouchedAt）。返回更新后的文档。
   */
  function vouch(docId, by) {
    var doc = store.documents.get(docId);
    if (!doc) return Promise.reject(new Error('文档不存在: ' + docId));
    return store.documents.patch(docId, {
      lastVouchedAt: Date.now(),
      lastVouchedBy: by || 'local'
    });
  }

  /**
   * assign(rule, subjectSteward, relatedSteward) — 发现项路由
   * （对齐 runner.go assign()：规则挑一方，空则回退另一方）。
   * 返回 assigneeId（可能 ''）。
   */
  function assign(rule, subject, related) {
    var first = subject, second = related;
    if (rule === RULE.LATEST_HAND) {
      // 谁最近背书谁负责；related 更晚则 related 先
      if (subject && related && related.lastVouchedAt > subject.lastVouchedAt) {
        first = related; second = subject;
      }
    } else if (rule === RULE.STALEST_OWNER) {
      // 谁最久没背书谁负责（related 更早则 related 先）
      if (subject && related && related.lastVouchedAt < subject.lastVouchedAt) {
        first = related; second = subject;
      }
    }
    // subject_owner：first = subject（默认顺序）
    var order = [first, second];
    for (var i = 0; i < order.length; i++) {
      var st = order[i];
      if (st && st.ownerId) return st.ownerId;
    }
    return '';
  }

  /**
   * routeFinding(finding, stewards, kbDefaultOwnerId) — 给发现项落 assignee。
   * 手工改派（assignedBy 非空）时不动（runner 的路由语义）。
   */
  function routeFinding(finding, stewardsMap, kbDefaultOwnerId) {
    if (finding.assignedBy) return finding.assigneeId || '';
    var subject = stewardsMap[finding.subjectDocId] || null;
    var related = finding.relatedDocId ? (stewardsMap[finding.relatedDocId] || null) : null;
    var id = assign(finding._assignRule || RULE.SUBJECT_OWNER, subject, related);
    if (!id) id = kbDefaultOwnerId || '';
    return id;
  }

  /**
   * listDue(kbId, nowTs) — sweep 用：某库（或全部）到期 + 未到期但有 open
   * stale 发现需要复检的文档。返回 steward 视图数组。
   */
  function listDue(kbId, nowTs) {
    var nowTs2 = nowTs != null ? nowTs : Date.now();
    return store.documents.list({ kbId: kbId }).filter(function (d) {
      if (d.status !== store.DOC_STATUS.ACTIVE) return false;
      var st = stewardOf(d.id, nowTs2);
      return st && st.reviewDueAt != null;
    }).filter(function (d) {
      var st = stewardOf(d.id, nowTs2);
      if (st.overdue) return true;
      // 周期被修改/关闭后，open 的 stale 发现需要复检才能销案
      var open = store.findings.list({ docId: d.id, status: store.FINDING.OPEN, type: store.FINDING.STALE });
      return open.length > 0;
    }).map(function (d) { return stewardOf(d.id, nowTs2); });
  }

  /**
   * ensureOwner(docId, kbId) — 负责人兜底：文档无 owner 时落 KB 默认负责人
   * （或第一个成员），保证「每个发现都有人可派」。
   */
  function ensureOwner(docId) {
    var doc = store.documents.get(docId);
    if (!doc) return Promise.resolve(null);
    if (doc.ownerId) return Promise.resolve(doc.ownerId);
    var kb = store.kbs.get(doc.kbId);
    var fallback = (kb && kb.defaultOwnerId) || '';
    if (!fallback) {
      var members = store.members.list();
      fallback = members.length ? members[0].id : '';
    }
    if (!fallback) return Promise.resolve('');
    return store.documents.patch(docId, { ownerId: fallback }).then(function () { return fallback; });
  }

  return {
    RULE: RULE,
    stewardOf: stewardOf,
    stewards: stewards,
    vouch: vouch,
    assign: assign,
    routeFinding: routeFinding,
    listDue: listDue,
    ensureOwner: ensureOwner
  };
});
