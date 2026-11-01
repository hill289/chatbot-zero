/*!
 * kb-bootstrap.js — 知识库层「零侵入」接入工作台
 * =============================================================================
 * 依赖（均已在工作台内可用）：
 *   · kb-store / kb-ingest / kb-search / kb-qa / kb-steward / kb-todo
 *   · kb-health/{divergence,duplicate,review,dispute,settle,detector}
 *   · renderer/tool-registry.js → window.registerTool
 *   · renderer/index.html 的 promptMessage 钩子 → window.KBBridge
 *
 * 本文件做五件事：
 *   1) 初始化 store（IndexedDB，超时降级内存）→ window.kbStore；
 *   2) 注册检测器（duplicate / review / feedback）到 KBRunner；
 *   3) 注册 kb_* 工具（检索/问答/摄取/健康/结案/待办）；
 *   4) 暴露 KBBridge：
 *        · enhance(messages, conversation)：对最新 user 消息注入 [S1..Sn]
 *          引用块（只改对话尾部，不碰 system+tools 前缀 —— 与记忆层同纪律）；
 *        · finalize(messageId, answerText)：回答后回写引用关系；
 *        · feedback(messageId, rating, opts)：👎 → 被引文档逐篇落行 + 触发
 *          dispute 复检；👍 仅记录；
 *        · config({kbId, enabled, autoIngest…})；
 *   5) 启动复审 sweep（启动即扫 + 每小时）+ 到期通知回调；
 *   6) 「本地知识库路径」：把某个磁盘文件夹设为知识库数据源（kb-source），
 *      扫描/同步入库后，提问即在该路径的内容上作答；可选启动时自动同步。
 *      （见 KBBridge.sourceStatus / setLocalPath / syncSource / pickDirectory）
 *
 * 所有异常静默回退，绝不影响主对话（与记忆层一致）。
 * =============================================================================
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var CORE = {
    store: window.KBStore, ingest: window.KBIngest, search: window.KBSearch,
    qa: window.KBQA, steward: window.KBSteward, todo: window.KBTodo,
    runner: window.KBRunner, duplicate: window.KBDuplicate,
    review: window.KBReview, dispute: window.KBDispute, settle: window.KBSettle,
    source: window.KBSource
  };
  var missing = Object.keys(CORE).filter(function (k) { return !CORE[k]; });
  if (missing.length) {
    try { console.warn('[kb] 知识库模块缺失，跳过接线：', missing.join(', ')); } catch (_) {}
    return;
  }

  // ── 配置 ────────────────────────────────────────────────────────────────
  var AUTO_INGEST_PROMPT = false;   // 用户消息不自动入知识库（须显式摄取）
  var enabled = true;               // 注入开关
  var activeKbId = '';              // 当前知识库（'' → 自动选第一个有文档的）
  var persistedKbId = '';           // 上次选定的知识库（meta 持久化，重载后沿用）
  var autoRecall = true;            // 每轮自动检索注入
  var RECALL_LIMIT = 6;
  var NOTIFY_OVERDUE = true;        // 到期提醒
  var lastUserQuestion = '';        // 供反馈附带问题（用户勾选时才带出）

  var store = null;
  var ready = null;
  var stopSweep = null;
  var onNotify = null;   // UI 挂接：({title, body, kind}) => {}

  // ── 初始化 ──────────────────────────────────────────────────────────────
  function init() {
    if (ready) return ready;
    store = CORE.store.createStore();
    ready = store.init().then(function () {
      window.kbStore = store;
      registerDetectors();
      wireSource();
      persistedKbId = store.meta.get('activeKbId') || '';
      registerTools();
      startSweep();
      maybeAutoSync();
      try { console.log('[kb] 知识库层就绪：', store.stats()); } catch (_) {}
      return store;
    }).catch(function (e) {
      try { console.warn('[kb] 初始化失败（知识库层不可用）', e); } catch (_) {}
      return null;
    });
    return ready;
  }

  function registerDetectors() {
    CORE.runner.register({
      name: CORE.duplicate.NAME,
      detect: function (kbId, docId) { return CORE.duplicate.detect(kbId, docId); }
    });
    CORE.runner.register({
      name: CORE.review.NAME,
      detect: function (kbId, docId, ctx) { return CORE.review.detect(kbId, docId, ctx); }
    });
    CORE.runner.register({
      name: CORE.dispute.NAME,
      detect: function (kbId, docId, ctx) { return CORE.dispute.detect(kbId, docId, ctx); }
    });
    // 摄取触发（ingest changed → 健康检查）
    CORE.ingest.setOnIngest(function (ev) {
      return CORE.runner.trigger(ev.kbId, ev.doc.id, { debounceMs: 500 });
    });
  }

  // ── 知识库选择 ──────────────────────────────────────────────────────────
  function resolveKbId(explicit) {
    if (explicit) return explicit;
    if (activeKbId && store.kbs.get(activeKbId)) return activeKbId;
    if (persistedKbId && store.kbs.get(persistedKbId)) return persistedKbId;
    var kbs = store.kbs.list();
    if (!kbs.length) return '';
    // 自动选第一个有可检索文档的知识库
    for (var i = 0; i < kbs.length; i++) {
      if (store.kbs.documents(kbs[i].id).length) return kbs[i].id;
    }
    return kbs[0].id;
  }

  // ── 摄取便捷入口 ────────────────────────────────────────────────────────
  function ensureDefaultKb() {
    var kbs = store.kbs.list();
    if (kbs.length) return Promise.resolve(kbs[0]);
    return store.kbs.create({ name: '默认知识库', reviewIntervalDays: 0 });
  }

  function ingestText(title, text, opts) {
    opts = opts || {};
    return ensureDefaultKb().then(function (kb) {
      var kbId = opts.kbId || kb.id;
      return CORE.ingest.ingest({
        kbId: kbId, title: title, text: text,
        sourceKey: opts.sourceKey || title,
        sourceType: opts.sourceType || 'text',
        sourcePath: opts.sourcePath || '',
        ownerId: opts.ownerId
      });
    });
  }

  /**
   * ingestFile(filePath, opts) — 读本地文件摄取：
   *   Office/PDF → anydoc 转 **Markdown**；HTML → 去标签；其余 → UTF-8 文本。
   * 与 kb-source 同一条解析链路（复用 CORE.source 的 driver + extractText）。
   */
  function ingestFile(filePath, opts) {
    opts = opts || {};
    var src = CORE.source;
    if (!src || typeof src.extractText !== 'function') throw new Error('kb-source 不可用');
    var d = src.getDriver && src.getDriver();
    if (!d || typeof d.readBytes !== 'function') throw new Error('当前环境不支持读取本地文件（需 Electron 外壳）');
    var p = String(filePath || '').trim();
    if (!p) throw new Error('file_path 不能为空');
    var name = p.replace(/^.*[\\\/]/, '');
    var ext = src.extOf(name);
    var office = (src.OFFICE_EXTS || []).indexOf(ext) >= 0;
    // Office/PDF：等 anydoc WASM 就绪再转 Markdown
    var ready = (office && typeof src.whenAnydocReady === 'function')
      ? src.whenAnydocReady() : Promise.resolve(true);
    return ready.then(function (ok) {
      if (!ok) throw new Error('anydoc 尚未就绪，无法解析 Office/PDF（稍后重试）');
      return Promise.resolve(d.readBytes(p));
    }).then(function (bytes) {
      var ex = src.extractText(name, bytes);
      if (ex.unsupported) throw new Error('无法解析该格式（' + (ex.format || ext.slice(1)) + '）');
      if (!String(ex.text || '').trim()) throw new Error('文件无可提取正文');
      return ingestText(opts.title || name.replace(/\.[^.]+$/, ''), ex.text, {
        kbId: opts.kbId,
        sourceKey: opts.sourceKey || p,
        sourcePath: p,
        sourceType: 'file'
      });
    });
  }

  // ── 本地路径数据源（kb-source）──────────────────────────────────────────
  // 批量同步时逐篇触发健康检查会造成检测器风暴 → 摄取改用 skipHealth，
  // 由这里注入的 provider 统一调度（runner.trigger 自带去抖/排队）。
  function wireSource() {
    try {
      if (CORE.source && typeof CORE.source.setHealthProvider === 'function') {
        CORE.source.setHealthProvider(function (kbId, docId) {
          return CORE.runner.trigger(kbId, docId, { debounceMs: 500 });
        });
      }
    } catch (_) { /* 忽略 */ }
    try {
      var drv = CORE.source && CORE.source.getDriver && CORE.source.getDriver();
      if (drv && typeof drv.available === 'function' && !drv.available()) {
        console.warn('[kb] 未检测到 Electron 文件系统：本地路径功能不可用（浏览器环境）');
      }
    } catch (_) { /* 忽略 */ }
  }

  // 把知识库设为「当前」（持久化 → 重载后提问仍作用于该库）
  function activateKb(kbId) {
    activeKbId = String(kbId || '');
    persistedKbId = activeKbId;
    try { if (store) store.meta.set('activeKbId', activeKbId); } catch (_) {}
    return activeKbId;
  }

  /**
   * setLocalPath(kbId, rootPath, opts) — 配置某知识库的本地路径。
   * opts.subdirs / opts.includeExts / opts.autoSyncOnStart / opts.sync(默认 true)
   * 未指定 kbId 且库里没有知识库时自动建一个「默认知识库」。
   * 返回 { kb, config, summary }。
   */
  function setLocalPath(kbId, rootPath, opts) {
    opts = opts || {};
    return init().then(function () {
      if (!store) throw new Error('知识库不可用');
      var id = kbId || resolveKbId();
      return (id && store.kbs.get(id)) ? store.kbs.get(id) : ensureDefaultKb();
    }).then(function (kb) {
      activateKb(kb.id);
      var patch = { rootPath: String(rootPath == null ? '' : rootPath).trim() };
      if (opts.subdirs != null) patch.subdirs = !!opts.subdirs;
      if (opts.includeExts) patch.includeExts = opts.includeExts;
      if (opts.autoSyncOnStart != null) patch.autoSyncOnStart = !!opts.autoSyncOnStart;
      return CORE.source.writeConfig(kb.id, patch).then(function (cfg) {
        if (opts.sync === false || !cfg.rootPath) {
          return { kb: kb, config: cfg, summary: null };
        }
        return CORE.source.sync(kb.id, {}).then(function (s) {
          return { kb: kb, config: CORE.source.readConfig(kb.id), summary: s };
        });
      });
    });
  }

  function syncSource(kbId, opts) {
    return init().then(function () {
      if (!store) throw new Error('知识库不可用');
      var id = kbId || resolveKbId();
      if (id) return CORE.source.sync(id, opts || {});
      return ensureDefaultKb().then(function (kb) { return CORE.source.sync(kb.id, opts || {}); });
    });
  }

  function sourceStatus(kbId) {
    return init().then(function () {
      if (!store) return null;
      var id = kbId || resolveKbId();
      return id ? CORE.source.status(id) : { kbId: '', rootPath: '', driverKind: '', docs: 0, activeDocs: 0 };
    });
  }

  function pickDirectory() {
    return init().then(function () {
      return CORE.source ? CORE.source.pickDirectory() : null;
    });
  }

  // 启动时对「已配置路径 + 开了自动同步」的知识库做一次扫描同步
  function maybeAutoSync() {
    if (!store || !CORE.source) return;
    try {
      store.kbs.list().forEach(function (kb) {
        var cfg = CORE.source.readConfig(kb.id);
        if (!cfg.rootPath || !cfg.autoSyncOnStart) return;
        CORE.source.sync(kb.id, {}).then(function (s) {
          try {
            console.log('[kb] 本地路径自动同步《' + kb.name + '》：新增 ' + s.added +
              '，更新 ' + s.updated + '，未变 ' + s.unchanged + '，停用 ' + s.missing);
          } catch (_) {}
        }).catch(function () { /* 启动同步失败静默 */ });
      });
    } catch (_) { /* 忽略 */ }
  }

  // ── 对话注入（引用问答）────────────────────────────────────────────────
  function messageText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (p) { return (p && p.type === 'text') ? (p.text || '') : ''; }).join('\n');
    }
    return String(content);
  }

  // 每轮为「最后一条 user 消息」查一次引用块；结果暂存供 finalize 使用
  var pendingRefs = { refs: [], kbId: '', question: '' };

  function enhance(messages, conversation) {
    // 每轮模型请求开始：清掉上一轮残留的引用快照 —— 本轮若无召回，
    // finalize 不会把旧引用误挂到新回答上。
    pendingRefs = { refs: [], kbId: '', question: '' };
    if (!enabled || !autoRecall) return Promise.resolve(messages);
    return init().then(function () {
      if (!store) return messages;
      var conv = conversation || [];
      var lastUser = null;
      for (var i = conv.length - 1; i >= 0; i--) {
        if (conv[i] && conv[i].role === 'user' && typeof conv[i].content === 'string') { lastUser = conv[i]; break; }
      }
      if (!lastUser) return messages;
      var q = String(lastUser.content || '').trim();
      if (q.length < 2) return messages;
      var kbId = resolveKbId();
      if (!kbId) return messages;
      lastUserQuestion = q;
      return CORE.qa.buildBlock(kbId, q, { limit: RECALL_LIMIT }).then(function (out) {
        if (!out.block) return messages;
        pendingRefs = { refs: out.refs, kbId: kbId, question: q };
        var next = messages.slice();
        for (var j = next.length - 1; j >= 0; j--) {
          if (next[j] && next[j].role === 'user') {
            next[j] = Object.assign({}, next[j], { content: out.block + '\n\n' + messageText(next[j].content) });
            return next;
          }
        }
        return messages;
      });
    }).catch(function () { return messages; });
  }

  /**
   * finalize(messageId, answerText) — 回答完成后回写引用关系。
   * messageId 由 UI 层生成（消息对象上的 _kbMessageId）。
   */
  function finalize(messageId, answerText) {
    if (!messageId || !pendingRefs.refs.length) return Promise.resolve(null);
    var snap = pendingRefs;
    pendingRefs = { refs: [], kbId: '', question: '' };
    return init().then(function () {
      if (!store) return null;
      return CORE.qa.recordAnswer(messageId, snap.refs, answerText, {
        kbId: snap.kbId, question: snap.question, sessionId: 'main'
      });
    }).catch(function () { return null; });
  }

  /**
   * finalizeTurnAnswer(conversation) — index.html 流结束点调用：
   * 给最后一条 assistant 消息挂 _kbMessageId / _kbRefs（decorate 渲染
   * 角标与来源列表用），并回写引用关系。无引用命中时只挂 id 不回写。
   */
  function finalizeTurnAnswer(conversation) {
    if (!conversation || !conversation.length) return Promise.resolve(null);
    // 从尾部找最后一条真实作答（有内容、非护栏提示）
    var last = null;
    for (var i = conversation.length - 1; i >= 0; i--) {
      var m = conversation[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content &&
        m.content.indexOf('⛔') !== 0 && !m._kbFinalized) { last = m; break; }
    }
    if (!last) return Promise.resolve(null);
    last._kbFinalized = true;
    if (!last._kbMessageId) {
      last._kbMessageId = 'a-' + String(Date.now()) + '-' +
        Math.abs(hashText(last.content)).toString(16);
    }
    var snap = pendingRefs;
    if (!snap.refs.length) return Promise.resolve(null);
    last._kbRefs = snap.refs.map(function (r) {
      return { n: r.n, chunkId: r.chunkId, docId: r.docId, title: r.title, heading: r.heading, excerpt: r.excerpt };
    });
    pendingRefs = { refs: [], kbId: '', question: '' };
    return init().then(function () {
      if (!store) return null;
      return CORE.qa.recordAnswer(last._kbMessageId, snap.refs, last.content, {
        kbId: snap.kbId, question: snap.question, sessionId: 'main'
      });
    }).catch(function () { return null; });
  }

  function hashText(s) {
    var h = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h | 0;
  }

  /**
   * feedback(messageId, rating, opts) — 👍/👎。
   *  rating 'down'：对被引文档逐篇落行 → 触发 dispute 复检 → 发现项进待办；
   *  rating 'up'：仅记录（对齐 Yuheng：What helped is not something a
   *               document's maintainer acts on）。
   * 返回 { recorded, docs }。
   */
  function feedback(messageId, rating, opts) {
    opts = opts || {};
    return init().then(function () {
      if (!store) return { recorded: 0, docs: [] };
      var cite = store.citations.byMessage(messageId);
      var docIds = cite ? (cite.docIds || []) : [];
      return CORE.qa.recordFeedback(messageId, rating, {
        comment: opts.comment || '',
        shareQuestion: !!opts.shareQuestion,
        question: opts.question || lastUserQuestion,
        userId: opts.userId || 'local'
      }).then(function (n) {
        if (rating !== 'down') return { recorded: n, docs: docIds };
        return CORE.dispute.recheckFeedback(docIds, CORE.runner)
          .then(function () { return { recorded: n, docs: docIds }; })
          .catch(function () { return { recorded: n, docs: docIds }; });
      });
    }).catch(function () { return { recorded: 0, docs: [] }; });
  }

  // ── 健康检查 / 结案代理（UI 与工具共用）────────────────────────────────
  function checkDoc(kbId, docId) {
    return init().then(function () {
      if (!store) return { findings: 0 };
      return CORE.steward.ensureOwner(docId).then(function () {
        return CORE.runner.run(kbId, docId, {});
      });
    });
  }

  function checkAll(kbId) {
    return init().then(function () {
      if (!store) return { docs: 0 };
      var docs = store.kbs.documents(kbId).filter(function (d) {
        return d.status === store.DOC_STATUS.ACTIVE;
      });
      return docs.reduce(function (chain, d) {
        return chain.then(function (acc) {
          return CORE.runner.run(kbId, d.id, {}).then(function (r) {
            acc.findings += r.findings || 0; acc.docs++; return acc;
          }, function () { acc.docs++; return acc; });
        });
      }, Promise.resolve({ docs: 0, findings: 0 }));
    });
  }

  // ── 复审 sweep + 到期通知 ───────────────────────────────────────────────
  function startSweep() {
    if (stopSweep) { try { stopSweep(); } catch (_) {} }
    stopSweep = CORE.review.startSweep(CORE.runner, {
      initialDelayMs: 300,
      trigger: function (kbId, docId) { return CORE.runner.trigger(kbId, docId, { debounceMs: 0 }); }
    });
    // 启动后 1s 跑一次到期提醒检查（面板红点 + 桌面通知）
    setTimeout(remindDue, 1000);
  }

  function remindDue() {
    if (!store || !NOTIFY_OVERDUE) return;
    try {
      var due = CORE.todo.overdueDocs(undefined, Date.now(), 0)
        .filter(function (d) { return d.overdue; });
      if (!due.length) return;
      // 同一负责人合并一条
      var byOwner = {};
      due.forEach(function (d) {
        var k = d.ownerId || 'unassigned';
        (byOwner[k] = byOwner[k] || []).push(d);
      });
      Object.keys(byOwner).forEach(function (ownerId) {
        var list = byOwner[ownerId];
        var name = list[0].ownerName || '未分配';
        notify({
          title: '📋 知识复审到期 · ' + name,
          body: list.length + ' 篇文档待确认：' + list.slice(0, 3).map(function (d) {
            return '《' + d.title + '》逾期 ' + d.daysOverdue + ' 天';
          }).join('；') + (list.length > 3 ? ' 等' : ''),
          kind: 'review'
        });
      });
    } catch (_) { /* 提醒失败不影响运行 */ }
  }

  function notify(payload) {
    try {
      if (onNotify) { onNotify(payload); return; }
      if (window.fileAPI && typeof window.fileAPI.notify === 'function') {
        window.fileAPI.notify(payload.title, payload.body);
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(payload.title, { body: payload.body });
      }
    } catch (_) { /* 通知失败静默 */ }
  }

  // ── kb_* 工具 ───────────────────────────────────────────────────────────
  function fmtFinding(f) {
    var sum = CORE.settle.assignSummary(f);
    var sev = { info: 'ℹ️', warning: '⚠️', error: '🚨' }[f.severity] || '';
    var line = sev + ' [' + sum.typeLabel + '] ' + sum.subjectTitle +
      (sum.relatedTitle ? ' ↔ ' + sum.relatedTitle : '') +
      ' → 负责人:' + sum.assigneeName;
    var ev = f.details && f.details.evidence && f.details.evidence[0];
    if (ev) {
      line += '\n   证据(' + (ev.score || 0).toFixed(2) + '): ' +
        'A「' + (ev.subjectExcerpt || '').slice(0, 80) + '…」 / B「' + (ev.relatedExcerpt || '').slice(0, 80) + '…」';
    }
    var ex = f.details && f.details.extra;
    if (ex && ex.count) line += '\n   差评 ' + ex.count + ' 次';
    if (ex && ex.days_overdue != null) line += '\n   逾期 ' + ex.days_overdue + ' 天';
    return line;
  }

  // ── 本地路径：文本输出 ─────────────────────────────────────────────────
  function srcStatusText(s) {
    if (!s) return '（知识库不可用）';
    return '📁 本地路径：' + (s.rootPath || '（未配置）') +
      '\n当前知识库：' + (s.kbId || '—') +
      '\n本地文档：' + (s.docs || 0) + '（生效 ' + (s.activeDocs || 0) + ' / 停用 ' + (s.disabledDocs || 0) + '）' +
      '\n递归子目录：' + (s.subdirs ? '是' : '否') + '，启动自动同步：' + (s.autoSyncOnStart ? '开' : '关') +
      '\n上次同步：' + (s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '从未') +
      '\n文件系统：' + (s.driverAvailable ? (s.driverKind || '可用') : '不可用（需 Electron 外壳）');
  }
  function srcSummaryText(r) {
    var s = r && r.summary;
    if (!s) {
      return '📁 已保存本地路径：' + (((r || {}).config || {}).rootPath || '（空）') + '（未同步）';
    }
    return '📁 同步《' + (((r || {}).kb || {}).name || (s.kbId || '')) + '》' +
      '\n路径：' + s.rootPath +
      '\n文件 ' + s.total + ' 个 → 新增 ' + s.added + '，更新 ' + s.updated +
      '，未变 ' + s.unchanged + '，停用(缺失) ' + s.missing + '，跳过 ' + s.skipped + '，失败 ' + s.failed +
      (s.truncated ? '（结果被截断）' : '') +
      (s.errors && s.errors.length
        ? '\n错误：' + s.errors.slice(0, 3).map(function (e) { return e.reason; }).join('；') : '');
  }

  var TOOLS = [
    {
      name: 'kb_search',
      description: '在知识库中做「向量+BM25」混合检索，返回带文档来源的片段。回答制度/流程/规范类问题前先检索。',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: '查询文本' },
        kb_id: { type: 'string', description: '知识库 id（可选，默认当前）' },
        limit: { type: 'integer', description: '返回条数（默认6）' }
      }, required: ['query'] },
      handler: function (args) {
        return init().then(function () {
          if (!store) return { results: [], formatted: '（知识库不可用）' };
          var kbId = resolveKbId(args.kb_id);
          if (!kbId) return { results: [], formatted: '（知识库为空：请先摄取文档）' };
          return CORE.search.search(kbId, args.query, { limit: args.limit || 6 }).then(function (rows) {
            var formatted = rows.length ? rows.map(function (r, i) {
              return (i + 1) + '. 《' + r.title + '》' + (r.heading ? ' · ' + r.heading : '') +
                ' [score=' + r.score.toFixed(3) + ']\n   ' + r.excerpt;
            }).join('\n') : '（无匹配片段）';
            return { results: rows, formatted: formatted };
          });
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_ingest',
      description: '把内容摄取进知识库（分块+向量化+触发健康检查）。传 text 给正文，或传 file_path 读本地文件（Office/PDF 自动用 anydoc 转成 Markdown）。用于新增或更新制度/规范/流程文档。',
      inputSchema: { type: 'object', properties: {
        title: { type: 'string', description: '文档标题（file_path 时可省略，默认取文件名）' },
        text: { type: 'string', description: '正文（纯文本或 Markdown）；与 file_path 二选一' },
        file_path: { type: 'string', description: '本地文件绝对路径；Office/PDF 经 anydoc 转 Markdown 后入库。与 text 二选一' },
        kb_id: { type: 'string', description: '知识库 id（可选）' },
        source_key: { type: 'string', description: '同源幂等键（如文件路径/URL；同键重复摄取=更新；file_path 时默认取该路径）' }
      } },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          if (args.file_path) {
            return ingestFile(args.file_path, { kbId: args.kb_id, sourceKey: args.source_key, title: args.title });
          }
          if (!args.title || !args.text) throw new Error('需要 title+text，或 file_path 二选一');
          return ingestText(args.title, args.text, { kbId: args.kb_id, sourceKey: args.source_key });
        }).then(function (r) {
          return {
            doc_id: r.doc.id, changed: r.changed, chunk_count: r.chunkCount,
            version: r.doc.version,
            formatted: (r.changed ? '已摄取' : '内容未变（幂等跳过）') +
              '：《' + r.doc.title + '》 v' + r.doc.version + '，' + r.chunkCount + ' 块' +
              (r.changed ? '，健康检查已排队' : '')
          };
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_health_check',
      description: '对知识库/单篇文档跑知识健康检测（重复/近重复/复审到期/差评争议），返回新发现的清单。',
      inputSchema: { type: 'object', properties: {
        kb_id: { type: 'string' }, doc_id: { type: 'string', description: '不传则全库检查' }
      } },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          var kbId = resolveKbId(args.kb_id);
          if (!kbId) throw new Error('没有知识库');
          var p = args.doc_id ? checkDoc(kbId, args.doc_id) : checkAll(kbId);
          return p.then(function (r) {
            var open = store.findings.list({ kbId: kbId, status: store.FINDING.OPEN });
            var formatted = open.length
              ? open.map(fmtFinding).join('\n')
              : '✅ 未发现问题';
            return { findings: open, scanned: r.docs || 1, formatted: formatted };
          });
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_findings',
      description: '列出知识健康发现项（可按状态/负责人过滤），用于查看待处理的知识问题与分配情况。',
      inputSchema: { type: 'object', properties: {
        status: { type: 'string', description: 'open|dismissed|resolved|all（默认 open）' },
        assignee: { type: 'string', description: '负责人 id；"none"=未分配' },
        kb_id: { type: 'string' }
      } },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          var status = args.status && args.status !== 'all' ? args.status : undefined;
          var rows = store.findings.list({ kbId: resolveKbId(args.kb_id), status: status });
          if (args.assignee === 'none') rows = rows.filter(function (f) { return !f.assigneeId; });
          else if (args.assignee) rows = rows.filter(function (f) { return f.assigneeId === args.assignee; });
          return {
            total: rows.length,
            formatted: rows.length ? rows.map(fmtFinding).join('\n') : '（无发现项）'
          };
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_settle',
      description: '处理一条知识健康发现项：confirm（确认文档仍有效）| dismiss（带理由忽略）| supersede（用另一篇取代）| assign（改派负责人）。处理完问题即销案。',
      inputSchema: { type: 'object', properties: {
        finding_id: { type: 'string' },
        action: { type: 'string', description: 'confirm | dismiss | supersede | assign' },
        reason: { type: 'string', description: 'dismiss 时必填：distinct_scope | intentional' },
        winner_id: { type: 'string', description: 'supersede 时：取代方（保留方）文档 id' },
        assignee: { type: 'string', description: 'assign 时：新负责人 id' }
      }, required: ['finding_id', 'action'] },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          var f = store.findings.get(args.finding_id);
          if (!f) throw new Error('发现项不存在: ' + args.finding_id);
          switch (args.action) {
            case 'confirm':
              return CORE.settle.confirm(f.subjectDocId, 'model', CORE.runner).then(function () {
                return { ok: true, formatted: '已确认《' + (store.documents.get(f.subjectDocId) || {}).title + '》仍有效（背书已更新）' };
              });
            case 'dismiss':
              return CORE.settle.dismiss(f.id, args.reason, 'model', CORE.runner).then(function () {
                return { ok: true, formatted: '已忽略（理由：' + args.reason + '）；证据变化时会自动重开' };
              });
            case 'supersede': {
              var loser = f.subjectDocId, winner = args.winner_id;
              if (!winner) throw new Error('supersede 需要 winner_id');
              if (winner === loser) { loser = f.relatedDocId; }
              return CORE.settle.supersede(loser, winner, 'model', CORE.runner).then(function (r) {
                return { ok: true, formatted: '《' + r.loser.title + '》已被《' + r.winner.title + '》取代（检索排除，未删除）' };
              });
            }
            case 'assign':
              return CORE.settle.assign(f.id, args.assignee, 'model').then(function (next) {
                var m = next.assigneeId ? store.members.get(next.assigneeId) : null;
                return { ok: true, formatted: '已改派给 ' + (m ? m.name : next.assigneeId || '未分配') };
              });
            default:
              throw new Error('未知 action: ' + args.action);
          }
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_todo',
      description: '查看「我的知识待办」：分配给某负责人的待处理发现项（重复/出入/到期/差评）。',
      inputSchema: { type: 'object', properties: {
        assignee: { type: 'string', description: '负责人 id（不传=全部）' }
      } },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          var rows = args.assignee ? CORE.todo.inbox(args.assignee) : CORE.todo.inbox(undefined);
          var c = CORE.todo.counts();
          return {
            total: rows.length,
            counts: c,
            formatted: (rows.length ? rows.map(fmtFinding).join('\n') : '✅ 暂无待办') +
              '\n---\n总计 open=' + c.total + '，未分配=' + c.unassigned
          };
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_source',
      description: '配置/同步「本地知识库路径」：把本地文件夹里的文档扫描并摄取入库，之后提问即在该路径内容上作答。action：status（查看配置）| set_path（设置本地路径，默认立即同步）| scan（预扫描，不入库）| sync（扫描并同步入库）。',
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', description: 'status | set_path | scan | sync' },
        path: { type: 'string', description: '本地文件夹绝对路径（set_path 必填）' },
        kb_id: { type: 'string', description: '知识库 id（可选，默认当前）' },
        subdirs: { type: 'boolean', description: '是否递归子目录（默认沿用配置）' },
        exts: { type: 'array', items: { type: 'string' }, description: '限定扩展名，如 [".md", ".pdf"]' },
        auto_sync_on_start: { type: 'boolean', description: '是否在启动时自动同步' },
        limit: { type: 'integer', description: '本次最多处理文件数' }
      }, required: ['action'] },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          var action = args.action;
          if (action === 'status') {
            return sourceStatus(args.kb_id).then(function (s) {
              return { status: s, formatted: srcStatusText(s) };
            });
          }
          if (action === 'set_path') {
            if (!args.path) throw new Error('set_path 需要 path');
            var opts = { sync: true };
            if (args.subdirs != null) opts.subdirs = args.subdirs;
            if (args.exts) opts.includeExts = args.exts;
            if (args.auto_sync_on_start != null) opts.autoSyncOnStart = args.auto_sync_on_start;
            return setLocalPath(args.kb_id, args.path, opts).then(function (r) {
              return { kb_id: r.kb.id, summary: r.summary, formatted: srcSummaryText(r) };
            });
          }
          if (action === 'scan') {
            var id = resolveKbId(args.kb_id);
            if (!id) throw new Error('没有知识库');
            return CORE.source.scan(id, {}).then(function (res) {
              return {
                total: res.total, truncated: res.truncated, files: res.files.slice(0, 50),
                formatted: '预扫描到 ' + res.total + ' 个文件' + (res.truncated ? '（已截断）' : '') + '：\n' +
                  res.files.slice(0, 20).map(function (f) { return '· ' + f.path; }).join('\n') +
                  (res.total > 20 ? '\n…（共 ' + res.total + ' 个）' : '')
              };
            });
          }
          if (action === 'sync') {
            return syncSource(args.kb_id, { limit: args.limit }).then(function (s) {
              return { summary: s, formatted: srcSummaryText({ config: CORE.source.readConfig(s.kbId), summary: s }) };
            });
          }
          throw new Error('未知 action: ' + action);
        });
      },
      tags: ['kb']
    },
    {
      name: 'kb_members',
      description: '管理知识库成员（负责人）：list（列出）| add（新增）。发现项会分配给具体成员。',
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', description: 'list | add' },
        name: { type: 'string', description: 'add 时：成员姓名' }
      }, required: ['action'] },
      handler: function (args) {
        return init().then(function () {
          if (!store) throw new Error('知识库不可用');
          if (args.action === 'add') {
            if (!args.name) throw new Error('add 需要 name');
            return store.members.add({ name: args.name }).then(function (m) {
              return { ok: true, member: m, formatted: '已添加成员：' + m.name + '（id=' + m.id + '）' };
            });
          }
          var list = store.members.list();
          return {
            members: list,
            formatted: list.length ? list.map(function (m) { return m.id + ' · ' + m.name; }).join('\n') : '（无成员）'
          };
        });
      },
      tags: ['kb']
    }
  ];

  function registerToolsWhenReady(attempt) {
    attempt = attempt || 0;
    if (typeof window.registerTool !== 'function') {
      if (attempt < 100) return setTimeout(function () { registerToolsWhenReady(attempt + 1); }, 100);
      try { console.warn('[kb] window.registerTool 不可用，知识库工具未注册'); } catch (_) {}
      return;
    }
    var opts = { source: 'knowledge', builtin: true, override: true };
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, opts);
      else TOOLS.forEach(function (t) { window.registerTool(t, opts); });
    } catch (e) {
      TOOLS.forEach(function (t) { try { window.registerTool(t); } catch (_) {} });
    }
    try { console.log('[kb] 已注册知识库工具：', TOOLS.map(function (t) { return t.name; }).join(', ')); } catch (_) {}
  }

  // ── 对外桥 ──────────────────────────────────────────────────────────────
  window.KBBridge = {
    enhance: enhance,
    finalize: finalize,
    finalizeTurnAnswer: finalizeTurnAnswer,
    feedback: feedback,
    checkDoc: checkDoc,
    checkAll: checkAll,
    remindDue: remindDue,
    ingestText: ingestText,
    ingestFile: ingestFile,
    ensureDefaultKb: ensureDefaultKb,
    resolveKbId: resolveKbId,
    fmtFinding: fmtFinding,
    // 本地路径数据源
    setLocalPath: setLocalPath,
    syncSource: syncSource,
    sourceStatus: sourceStatus,
    pickDirectory: pickDirectory,
    activateKb: activateKb,
    source: CORE.source,
    get store() { return store; },
    get ready() { return init(); },
    tools: TOOLS.map(function (t) { return t.name; }),
    onNotify: function (fn) { onNotify = fn; },
    config: function (patch) {
      patch = patch || {};
      if (patch.enabled != null) enabled = !!patch.enabled;
      if (patch.autoRecall != null) autoRecall = !!patch.autoRecall;
      if (patch.kbId != null) activateKb(patch.kbId);
      if (patch.recallLimit != null) RECALL_LIMIT = patch.recallLimit | 0;
      if (patch.notifyOverdue != null) NOTIFY_OVERDUE = !!patch.notifyOverdue;
      return {
        enabled: enabled, autoRecall: autoRecall, kbId: activeKbId,
        recallLimit: RECALL_LIMIT, notifyOverdue: NOTIFY_OVERDUE
      };
    },
    pendingRefs: function () { return pendingRefs; }
  };

  registerToolsWhenReady();
  init();
})();
