/*!
 * kb-health/settle.js — 发现项结案（Settling）
 * =============================================================================
 * 对齐 Yuheng README「settling」的三种收尾 + 手工改派：
 *
 *   1. supersede(loserId, winnerId, by)  取代：旧文档标 superseded 并从
 *      检索排除（**不删除** —— 历史引用可回溯，这是「过期制度不再被
 *      引用」的落点）；被取代文档的 open 发现项在后续 check 中自动销案；
 *   2. confirm(docId, by)                确认仍有效：vouch 背书 →
 *      复审时钟重启 + 争议计数归零 → 复检销案；
 *   3. dismiss(findingId, reason, by)    忽略（带理由）：
 *        distinct_scope — 看着像但管的不是一件事（两个办事处/两个年份）；
 *        intentional    — 重叠是有意的（摘要页就该引用原文）。
 *      dismissed 在 evidenceHash 不变期间保持；证据变了自动重开。
 *   4. assign(findingId, assigneeId, by) 手工改派：assignedBy 置位后，
 *      检测器的自动路由不再覆盖。
 *
 * 每种结案后都触发相关文档的复检（check 跟着动作走）。
 *
 * UMD：浏览器挂 globalThis.KBSettle，Node 下 module.exports。
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
  if (root) root.KBSettle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var steward = deps.steward;

  var REASONS = ['distinct_scope', 'intentional'];

  function clip(s, n) {
    var arr = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
    return arr.length > n ? arr.slice(0, n - 1).join('') + '…' : arr.join('');
  }

  function recheck(docId, runner) {
    if (!runner) return Promise.resolve(null);
    var doc = store.documents.get(docId);
    if (!doc) return Promise.resolve(null);
    return runner.trigger(doc.kbId, docId, { debounceMs: 100 });
  }

  /**
   * supersede(loserId, winnerId, by, runner) — loser 被 winner 取代。
   * loser → status=superseded（检索排除）、chunks 置 disabled、
   * supersededBy=winnerId；winner vouch（新鲜度起算）。
   * 返回 { loser, winner }。
   */
  function supersede(loserId, winnerId, by, runner) {
    if (!loserId || !winnerId || loserId === winnerId) {
      return Promise.reject(new Error('取代需要两个不同的文档'));
    }
    var loser = store.documents.get(loserId);
    var winner = store.documents.get(winnerId);
    if (!loser || !winner) return Promise.reject(new Error('文档不存在'));
    if (loser.kbId !== winner.kbId) return Promise.reject(new Error('两篇文档不在同一知识库'));

    return store.chunks.listByDoc(loserId).then(function (chunks) {
      // 禁用 loser 的分块（保留数据，检索过滤 enabled=false）
      return disableChunks(loserId, chunks);
    }).then(function () {
      return store.documents.patch(loserId, {
        status: store.DOC_STATUS.SUPERSEDED,
        supersededBy: winnerId,
        supersededAt: Date.now(),
        supersededByUser: by || 'local'
      });
    }).then(function (loserNext) {
      return steward.vouch(winnerId, by).then(function (winnerNext) {
        var both = Promise.all([
          recheck(loserId, runner),
          recheck(winnerId, runner)
        ]);
        return both.then(function () {
          return { loser: loserNext, winner: winnerNext };
        });
      });
    });
  }

  function disableChunks(docId, chunks) {
    // 直接经 store.chunks.replaceForDoc 的 enabled 语义：重建为 disabled
    var list = (chunks || []).map(function (c) {
      return { text: c.text, heading: c.heading, vec: c.vec, dim: c.dim, enabled: false };
    });
    if (!list.length) return Promise.resolve(true);
    return store.chunks.replaceForDoc(docId, (store.documents.get(docId) || {}).kbId || '', list)
      .then(function () { return true; });
  }

  /**
   * restore(docId, by, runner) — 撤销取代（误操作恢复；重新启用分块）。
   */
  function restore(docId, by, runner) {
    var doc = store.documents.get(docId);
    if (!doc) return Promise.reject(new Error('文档不存在'));
    return store.chunks.listByDoc(docId).then(function (chunks) {
      return store.chunks.replaceForDoc(docId, doc.kbId, chunks.map(function (c) {
        return { text: c.text, heading: c.heading, vec: c.vec, dim: c.dim, enabled: true };
      }));
    }).then(function () {
      return store.documents.patch(docId, { status: store.DOC_STATUS.ACTIVE, supersededBy: '' });
    }).then(function (next) {
      return recheck(docId, runner).then(function () { return next; });
    });
  }

  /**
   * confirm(docId, by, runner) — 确认仍有效（vouch）→ 复审/争议复检销案。
   */
  function confirm(docId, by, runner) {
    return steward.vouch(docId, by).then(function (doc) {
      return recheck(docId, runner).then(function () { return doc; });
    });
  }

  /**
   * dismiss(findingId, reason, by, runner) — 带理由忽略。
   * reason ∈ distinct_scope | intentional。
   */
  function dismiss(findingId, reason, by, runner) {
    if (REASONS.indexOf(reason) < 0) {
      return Promise.reject(new Error('忽略需要理由：distinct_scope（适用范围不同）或 intentional（有意重叠）'));
    }
    var f = store.findings.get(findingId);
    if (!f) return Promise.reject(new Error('发现项不存在'));
    if (f.status === store.FINDING.RESOLVED) {
      return Promise.reject(new Error('已销案的发现项无需忽略'));
    }
    var nowTs = Date.now();
    return store.findings.settle(findingId, {
      status: store.FINDING.DISMISSED,
      resolution: reason,
      resolvedBy: by || 'local',
      resolvedAt: nowTs
    }).then(function (next) {
      return recheck(next.subjectDocId, runner).then(function () { return next; });
    });
  }

  /**
   * reopen(findingId) — 撤销忽略（重新打开观察）。
   */
  function reopen(findingId) {
    var f = store.findings.get(findingId);
    if (!f) return Promise.reject(new Error('发现项不存在'));
    return store.findings.settle(findingId, {
      status: store.FINDING.OPEN,
      resolution: '', resolvedBy: '', resolvedAt: null
    });
  }

  /**
   * assign(findingId, assigneeId, by) — 手工改派（assignedBy 置位后
   * 自动路由不再覆盖）。
   */
  function assign(findingId, assigneeId, by) {
    var f = store.findings.get(findingId);
    if (!f) return Promise.reject(new Error('发现项不存在'));
    if (assigneeId && !store.members.get(assigneeId)) {
      return Promise.reject(new Error('成员不存在: ' + assigneeId));
    }
    return store.findings.settle(findingId, {
      assigneeId: assigneeId || '',
      assignedBy: by || 'local',
      assignedAt: Date.now()
    });
  }

  /**
   * assignSummary(finding) — 卡片展示用：双方文档标题 + 负责人姓名。
   */
  function assignSummary(finding) {
    var sub = store.documents.get(finding.subjectDocId);
    var rel = finding.relatedDocId ? store.documents.get(finding.relatedDocId) : null;
    var owner = finding.assigneeId ? store.members.get(finding.assigneeId) : null;
    return {
      subjectTitle: sub ? sub.title : '（已删除）',
      relatedTitle: rel ? rel.title : '',
      assigneeName: owner ? owner.name : (finding.assigneeId ? finding.assigneeId : '未分配'),
      typeLabel: {
        duplicate: '完全重复',
        divergent: '内容有出入',
        stale: '复审到期',
        disputed: '被差评质疑'
      }[finding.type] || finding.type
    };
  }

  return {
    REASONS: REASONS,
    supersede: supersede,
    restore: restore,
    confirm: confirm,
    dismiss: dismiss,
    reopen: reopen,
    assign: assign,
    assignSummary: assignSummary,
    clip: clip
  };
});
