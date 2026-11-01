/*!
 * kb-qa.js — 带引用的问答（Cited Q&A）
 * =============================================================================
 * 把 kb-search 的检索结果组装成「可注入、可回溯」的引用上下文：
 *
 *   1. buildBlock()   检索 → [S1..Sn] 编号片段块（注入最后一条 user 消息尾部，
 *                     不碰 system+tools 前缀 —— 沿用记忆层的前缀缓存纪律）；
 *   2. extractCitations() 从模型回答里解析 [Sn] 引用标记；
 *   3. recordAnswer() 落库「消息 → 被引 chunk/doc」引用关系
 *                     （这是「差评归因到被引文档」的数据前提，
 *                      对齐 Yuheng 的 msg.KnowledgeReferences）。
 *
 * 过期保护：检索默认排除 superseded 文档（kb-search 已保证），因此
 * 「被取代的旧制度不再出现在引用里」。
 *
 * UMD：浏览器挂 globalThis.KBQA，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js'), search: require('./kb-search.js') };
  } else {
    deps = { store: root.KBStore, search: root.KBSearch };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBQA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var search = deps.search;

  var DEFAULT_LIMIT = 6;
  var DEFAULT_MAX_CHARS = 3200;
  var EXCERPT_CHARS = 420;

  function clipRunes(s, n) {
    var arr = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
    return arr.length > n ? arr.slice(0, n - 1).join('') + '…' : arr.join('');
  }

  /**
   * buildBlock(kbId, question, opts)
   *   opts.limit      片段数（默认 6）
   *   opts.maxChars   块总长上限（默认 3200）
   *   opts.kbName     块首署名（可选）
   * 返回 { block, refs, hits }
   *   block 为可直接拼到 user 消息尾部的文本；refs = [{n, chunkId, docId,
   *   title, excerpt, heading}]，与 [Sn] 编号一一对应。
   */
  function buildBlock(kbId, question, opts) {
    opts = opts || {};
    if (!kbId) return Promise.resolve({ block: '', refs: [], hits: [] });
    var kb = store.kbs.get(kbId);
    var limit = opts.limit || DEFAULT_LIMIT;
    var maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    return search.search(kbId, question, { limit: limit }).then(function (hits) {
      if (!hits.length) return { block: '', refs: [], hits: [] };
      var refs = [];
      var lines = [];
      var used = 0;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var excerpt = clipRunes(h.text, EXCERPT_CHARS);
        var head = (h.title || '') + (h.heading ? ' · ' + h.heading : '');
        var line = '[S' + (i + 1) + ']《' + head + '》' + excerpt;
        if (used + line.length > maxChars && refs.length) break;
        used += line.length;
        refs.push({
          n: i + 1, chunkId: h.chunkId, docId: h.docId,
          title: h.title, heading: h.heading, excerpt: excerpt,
          score: h.score, ownerId: h.ownerId
        });
        lines.push(line);
      }
      if (!refs.length) return { block: '', refs: [], hits: [] };
      var block = '【知识库参考资料】' + (kb && kb.name ? '（' + kb.name + '）' : '') + '\n'
        + lines.join('\n')
        + '\n回答要求：仅在有资料支撑时作答；引用上述资料时标注来源编号，如 [S1]；'
        + '资料之间如有冲突（如新旧版本数字不一致），以编号靠后者与更新的制度为准并明确指出冲突。';
      return { block: block, refs: refs, hits: hits };
    }).catch(function () { return { block: '', refs: [], hits: [] }; });
  }

  /**
   * extractCitations(text, refs) — 解析回答中的 [Sn] 标记。
   * 返回去重排序后的 refs 子集（真实出现在回答里的引用）。
   */
  function extractCitations(text, refs) {
    if (!text || !refs || !refs.length) return [];
    var seen = {};
    var out = [];
    var re = /\[S(\d{1,2})\]/g;
    var m;
    while ((m = re.exec(String(text))) !== null) {
      var n = parseInt(m[1], 10);
      if (seen[n]) continue;
      seen[n] = true;
      var ref = null;
      for (var i = 0; i < refs.length; i++) if (refs[i].n === n) { ref = refs[i]; break; }
      if (ref) out.push(ref);
    }
    return out;
  }

  /**
   * recordAnswer(messageId, refs, answerText, opts)
   * 落库引用关系（只记回答里真实出现的引用；一个都没有则记空引用，便于
   * 「无引用回答」的统计）。返回 { messageId, cited }。
   *   opts.sessionId / opts.kbId / opts.question 供争议证据回看
   */
  function recordAnswer(messageId, refs, answerText, opts) {
    opts = opts || {};
    if (!messageId) return Promise.resolve(null);
    var cited = extractCitations(answerText, refs);
    var docIds = [];
    cited.forEach(function (r) { if (docIds.indexOf(r.docId) < 0) docIds.push(r.docId); });
    return store.citations.record({
      messageId: messageId,
      kbId: opts.kbId || (refs && refs[0] && refs[0].kbId) || '',
      chunkIds: cited.map(function (r) { return r.chunkId; }),
      docIds: docIds,
      refs: cited.map(function (r) {
        return { n: r.n, chunkId: r.chunkId, docId: r.docId, title: r.title, excerpt: r.excerpt };
      })
    }).then(function (row) {
      // 会话/问题留档（争议证据 extra 用）
      if (opts.question || opts.sessionId) {
        row.question = opts.question || '';
        row.sessionId = opts.sessionId || 'main';
        return store.citations.record(Object.assign({}, row)).then(function () {
          return { messageId: messageId, cited: cited };
        });
      }
      return { messageId: messageId, cited: cited };
    });
  }

  /**
   * citationsFor(messageId) — UI 渲染角标 / 反馈归因读取。
   * 返回 { row, docs }（docs 为已解析的文档元数据，可能含已删除文档的空项）。
   */
  function citationsFor(messageId) {
    var row = store.citations.byMessage(messageId);
    if (!row) return { row: null, docs: [] };
    var docs = (row.docIds || []).map(function (id) { return store.documents.get(id); }).filter(Boolean);
    return { row: row, docs: docs };
  }

  /**
   * feedbackDocs(messageId, rating, opts) — 对被引文档逐篇落反馈行
   * （对齐 Yuheng message_feedback：一条反馈 = 每篇被引文档一行，≤10 篇）。
   * 返回写入的行数。
   */
  var MAX_DISPUTED_CITATIONS = 10;
  function recordFeedback(messageId, rating, opts) {
    opts = opts || {};
    var row = store.citations.byMessage(messageId);
    if (!row || !row.docIds || !row.docIds.length) return Promise.resolve(0);
    var docIds = row.docIds.slice(0, MAX_DISPUTED_CITATIONS);
    var jobs = docIds.map(function (docId) {
      var doc = store.documents.get(docId);
      if (!doc || doc.kbId !== (row.kbId || doc.kbId)) return null;   // 同库限定
      return store.feedback.record({
        messageId: messageId,
        docId: docId,
        kbId: doc.kbId,
        sessionId: row.sessionId || 'main',
        rating: rating,
        comment: opts.comment || '',
        shareQuestion: !!opts.shareQuestion,
        userId: opts.userId || 'local',
        question: opts.question || row.question || ''
      });
    }).filter(Boolean);
    return Promise.all(jobs).then(function (rows) { return rows.length; });
  }

  return {
    buildBlock: buildBlock,
    extractCitations: extractCitations,
    recordAnswer: recordAnswer,
    citationsFor: citationsFor,
    recordFeedback: recordFeedback,
    MAX_DISPUTED_CITATIONS: MAX_DISPUTED_CITATIONS
  };
});
