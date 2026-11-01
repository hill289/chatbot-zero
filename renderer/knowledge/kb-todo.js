/*!
 * kb-todo.js — 个人知识待办（Personal Knowledge To-Do）
 * =============================================================================
 * 对齐 Yuheng「every finding goes to the person best placed to act;
 * a personal knowledge to-do」：所有发现项按 assignee 聚合成待办。
 *
 *   · inbox(assigneeId)  某人的 open 发现项（按紧急度排序，带文档标题、
 *                        类型标签、负责人名、到期天数）；
 *   · counts()           徽标计数（按人/按严重度）；
 *   · overdueDocs(kbId)  复审到期文档清单（提醒用）；
 *   · digest()           面板头部摘要（open 总数 / 三类分布 / 最近到期）。
 *
 * UMD：浏览器挂 globalThis.KBTodo，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js'), steward: require('./kb-steward.js'), settle: require('./kb-health/settle.js') };
  } else {
    deps = { store: root.KBStore, steward: root.KBSteward, settle: root.KBSettle };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBTodo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var steward = deps.steward;
  var settle = deps.settle;

  var DAY_MS = 24 * 60 * 60 * 1000;

  function decorate(f) {
    var sum = settle.assignSummary(f);
    var st = steward.stewardOf(f.subjectDocId);
    var doc = store.documents.get(f.subjectDocId);
    return Object.assign({}, f, {
      subjectTitle: sum.subjectTitle,
      relatedTitle: sum.relatedTitle,
      assigneeName: sum.assigneeName,
      typeLabel: sum.typeLabel,
      docOwnerId: doc ? doc.ownerId : '',
      overdueDays: st ? st.daysOverdue : 0,
      dueAt: st ? st.reviewDueAt : null
    });
  }

  /**
   * inbox(assigneeId, opts) — 某人的 open 待办。
   * opts.kbId 过滤；assigneeId 为空 → 全部未分配（给管理员看）。
   */
  function inbox(assigneeId, opts) {
    opts = opts || {};
    var rows = store.findings.list({
      status: store.FINDING.OPEN,
      kbId: opts.kbId,
      assigneeId: assigneeId || undefined
    });
    if (assigneeId === '') {
      rows = rows.filter(function (f) { return !f.assigneeId; });
    }
    return rows.map(decorate);
  }

  /**
   * counts() — 徽标：{ total, bySeverity, byMember: {memberId: n}, unassigned }
   */
  function counts() {
    var open = store.findings.list({ status: store.FINDING.OPEN });
    var bySeverity = { info: 0, warning: 0, error: 0 };
    var byMember = {};
    var unassigned = 0;
    open.forEach(function (f) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      if (f.assigneeId) byMember[f.assigneeId] = (byMember[f.assigneeId] || 0) + 1;
      else unassigned++;
    });
    return { total: open.length, bySeverity: bySeverity, byMember: byMember, unassigned: unassigned };
  }

  /**
   * overdueDocs(kbId, nowTs) — 复审到期（或即将到期 ≤ remindDays 天）的
   * 文档清单，供提醒与面板。
   */
  function overdueDocs(kbId, nowTs, remindDays) {
    var nowTs2 = nowTs != null ? nowTs : Date.now();
    var horizon = nowTs2 + (remindDays != null ? remindDays : 0) * DAY_MS;
    return store.documents.list({ kbId: kbId }).filter(function (d) {
      if (d.status !== store.DOC_STATUS.ACTIVE) return false;
      var st = steward.stewardOf(d.id, nowTs2);
      return st && st.reviewDueAt != null && st.reviewDueAt <= horizon;
    }).map(function (d) {
      var st = steward.stewardOf(d.id, nowTs2);
      return {
        docId: d.id,
        title: d.title,
        kbId: d.kbId,
        ownerId: d.ownerId,
        ownerName: st.ownerName,
        dueAt: st.reviewDueAt,
        overdue: st.overdue,
        daysOverdue: st.daysOverdue
      };
    }).sort(function (a, b) { return a.dueAt - b.dueAt; });
  }

  /**
   * digest(opts) — 知识健康面板头部摘要。
   */
  function digest(opts) {
    opts = opts || {};
    var nowTs = opts.now != null ? opts.now : Date.now();
    var open = store.findings.list({ status: store.FINDING.OPEN, kbId: opts.kbId });
    var byType = { duplicate: 0, divergent: 0, stale: 0, disputed: 0 };
    open.forEach(function (f) { byType[f.type] = (byType[f.type] || 0) + 1; });
    var c = counts();
    var due = overdueDocs(opts.kbId, nowTs, 7);
    return {
      openTotal: c.total,
      bySeverity: c.bySeverity,
      byType: byType,
      unassigned: c.unassigned,
      overdueDocs: due.length,
      overdueSoon: due.filter(function (d) { return !d.overdue; }).length,
      nextDue: due[0] || null,
      stats: store.stats()
    };
  }

  /**
   * myNext(assigneeId) — 「下一步处理什么」：最高严重度 + 最早到期。
   * 供通知与空面板引导。
   */
  function myNext(assigneeId) {
    var rows = inbox(assigneeId);
    if (!rows.length) return null;
    return rows[0];
  }

  return {
    inbox: inbox,
    counts: counts,
    overdueDocs: overdueDocs,
    digest: digest,
    myNext: myNext
  };
});
