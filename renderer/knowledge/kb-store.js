/*!
 * kb-store.js — 知识库存储层（Knowledge Base Store）
 * =============================================================================
 * 对齐 Yuheng 的数据模型（internal/types + migrations），改造为纯前端实现：
 *
 *   Yuheng 表                    → 本模块对象仓库（IndexedDB: agent-kb v1）
 *   ---------------------------------------------------------------------------
 *   knowledge_bases               → kbs         知识库（含 reviewIntervalDays）
 *   knowledges                    → documents   文档（owner/背书/复审/取代状态）
 *   chunks                        → chunks      分块（含向量，enabled 可禁用）
 *   knowledge_findings            → findings    知识健康发现项（指纹幂等）
 *   message_feedback              → feedback    回答反馈（按被引文档逐篇落行）
 *   答案引用关系                   → citations   消息 → 被引 chunk/doc
 *   成员/负责人                    → members     轻量「人」模型
 *
 * 设计：
 *   · 零依赖、UMD：浏览器挂 globalThis.KBStore，Node 下 module.exports。
 *   · 存储抽象复用 memory-layer 的 Storage 接口约定（init/getAll/get/put/
 *     putMany/delete/clear），IndexedDB 缺失时自动降级内存（Node 测试即走此路）。
 *   · 小表（kbs/documents/findings/feedback/members/citations）init 时全量载入
 *     内存缓存，读操作同步；chunks 按需加载并缓存（规模：数千文档级足够）。
 *   · 状态机与字段命名严格对齐 Yuheng knowledge_finding.go：
 *     status: open/dismissed/resolved；resolution: distinct_scope/intentional/
 *     cleared；resolvedBy='system' 表示检测器自动销案。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DB_NAME = 'agent-kb';
  var DB_VERSION = 1;
  var STORE_NAMES = ['kbs', 'documents', 'chunks', 'findings', 'feedback', 'citations', 'members', 'meta'];

  // ── 发现项常量（对齐 types/knowledge_finding.go）─────────────────────────
  var FINDING = {
    // type
    DUPLICATE: 'duplicate',
    DIVERGENT: 'divergent',
    STALE: 'stale',
    DISPUTED: 'disputed',
    // severity
    INFO: 'info',
    WARNING: 'warning',
    ERROR: 'error',
    // status
    OPEN: 'open',
    DISMISSED: 'dismissed',
    RESOLVED: 'resolved',
    // resolution
    DISTINCT_SCOPE: 'distinct_scope',
    INTENTIONAL: 'intentional',
    CLEARED: 'cleared',
    // resolved_by
    SYSTEM: 'system'
  };

  // ── 通用小工具 ────────────────────────────────────────────────────────────
  function fnv1a(str, seed) {
    var h = (seed == null ? 2166136261 : seed) >>> 0;
    str = String(str == null ? '' : str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  // 内容寻址稳定 ID（与 memory-layer.stableId 同构，保证幂等）
  function stableId(str) {
    var a = fnv1a(str, 2166136261).toString(16).padStart(8, '0');
    var b = fnv1a(str, 0x01000193).toString(16).padStart(8, '0');
    return a + b;
  }
  function now() { return Date.now(); }
  function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  // ── 存储后端：内存（Node / 降级）─────────────────────────────────────────
  function createMemoryBackend() {
    var tables = {};
    STORE_NAMES.forEach(function (n) { tables[n] = new Map(); });
    function keyOf(name, val) {
      if (name === 'meta' || name === 'members') return val.key != null ? val.key : val.id;
      return val.id;
    }
    return {
      kind: 'memory',
      init: function () { return Promise.resolve(); },
      getAll: function (name) { return Promise.resolve(Array.from(tables[name].values())); },
      get: function (name, key) { return Promise.resolve(tables[name].get(key) || null); },
      put: function (name, val) { tables[name].set(keyOf(name, val), val); return Promise.resolve(val); },
      putMany: function (name, vals) {
        for (var i = 0; i < vals.length; i++) tables[name].set(keyOf(name, vals[i]), vals[i]);
        return Promise.resolve(vals.length);
      },
      delete: function (name, key) { tables[name].delete(key); return Promise.resolve(true); },
      deleteMany: function (name, keys) {
        for (var i = 0; i < keys.length; i++) tables[name].delete(keys[i]);
        return Promise.resolve(keys.length);
      },
      clear: function (name) {
        if (name) tables[name].clear();
        else STORE_NAMES.forEach(function (n) { tables[n].clear(); });
        return Promise.resolve(true);
      }
    };
  }

  // ── 存储后端：IndexedDB ──────────────────────────────────────────────────
  function createIdbBackend(dbName) {
    var DB = dbName || DB_NAME;
    var db = null;
    function open() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB, DB_VERSION);
        req.onupgradeneeded = function () {
          var d = req.result;
          STORE_NAMES.forEach(function (n) {
            if (!d.objectStoreNames.contains(n)) {
              var opts = { keyPath: (n === 'meta' || n === 'members') ? 'key' : 'id' };
              var os = d.createObjectStore(n, opts);
              if (n === 'documents') os.createIndex('kbId', 'kbId', { unique: false });
              if (n === 'chunks') { os.createIndex('docId', 'docId', { unique: false }); os.createIndex('kbId', 'kbId', { unique: false }); }
              if (n === 'findings') { os.createIndex('fingerprint', 'fingerprint', { unique: false }); os.createIndex('kbId', 'kbId', { unique: false }); }
              if (n === 'feedback') os.createIndex('docId', 'docId', { unique: false });
            }
          });
        };
        req.onsuccess = function () { db = req.result; resolve(db); };
        req.onerror = function () { reject(req.error); };
      });
    }
    function exec(name, mode, fn) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(name, mode);
        var os = t.objectStore(name);
        var request;
        try { request = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(request ? request.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('idb aborted')); };
      });
    }
    return {
      kind: 'indexeddb',
      init: function () {
        if (db) return Promise.resolve();
        return open().then(function () { return undefined; });
      },
      getAll: function (name) { return exec(name, 'readonly', function (os) { return os.getAll(); }); },
      get: function (name, key) { return exec(name, 'readonly', function (os) { return os.get(key); }); },
      put: function (name, val) { return exec(name, 'readwrite', function (os) { os.put(val); return null; }).then(function () { return val; }); },
      putMany: function (name, vals) {
        return exec(name, 'readwrite', function (os) {
          for (var i = 0; i < vals.length; i++) os.put(vals[i]);
          return null;
        }).then(function () { return vals.length; });
      },
      delete: function (name, key) { return exec(name, 'readwrite', function (os) { os.delete(key); return null; }).then(function () { return true; }); },
      // 批量删除：单事务内逐 key 删（清空数千分块时避免每 key 一个事务）
      deleteMany: function (name, keys) {
        return exec(name, 'readwrite', function (os) {
          for (var i = 0; i < keys.length; i++) os.delete(keys[i]);
          return null;
        }).then(function () { return keys.length; });
      },
      clear: function (name) {
        var names = name ? [name] : STORE_NAMES;
        return Promise.all(names.map(function (n) { return exec(n, 'readwrite', function (os) { os.clear(); return null; }); }))
          .then(function () { return true; });
      }
    };
  }

  function defaultBackend() {
    try { if (typeof indexedDB !== 'undefined' && indexedDB) return createIdbBackend(); } catch (_) { /* 回退 */ }
    return createMemoryBackend();
  }

  // 当前实例：所有模块通过导出对象的代理访问（模块加载时拿到的是导出，
  // createStore() 之后属性访问透明转发到最新实例 —— 浏览器单实例、
  // Node 测试逐用例重建都成立）。
  var current = null;

  // ── 文档状态 ─────────────────────────────────────────────────────────────
  var DOC_STATUS = { ACTIVE: 'active', SUPERSEDED: 'superseded', DISABLED: 'disabled' };

  /**
   * createStore — 创建知识库存储实例。
   * opts.backend 可注入（测试用内存后端）；opts.timeout 为 IDB 初始化超时（毫秒）。
   */
  function createStore(opts) {
    opts = opts || {};
    var backend = opts.backend || defaultBackend();
    // 内存缓存（init 后可用；chunks 单独懒加载）
    var cache = {
      kbs: new Map(),
      documents: new Map(),
      findings: new Map(),
      feedback: [],
      citations: [],          // [{messageId, kbId, chunkIds, docIds, createdAt}]
      members: new Map(),     // key = id
      meta: new Map()
    };
    var chunkCache = new Map();   // docId -> [chunk]（含 vec）
    var ready = null;

    function loadAll(name) {
      return backend.getAll(name).then(function (rows) { return rows || []; });
    }

    function init() {
      if (ready) return ready;
      var timeout = opts.timeout != null ? opts.timeout : 2500;

      function loadAllCached() {
        return Promise.all([
          loadAll('kbs'), loadAll('documents'), loadAll('findings'),
          loadAll('feedback'), loadAll('citations'), loadAll('members'), loadAll('meta')
        ]).then(function (all) {
          all[0].forEach(function (r) { cache.kbs.set(r.id, r); });
          all[1].forEach(function (r) { cache.documents.set(r.id, r); });
          all[2].forEach(function (r) { cache.findings.set(r.id, r); });
          cache.feedback = all[3];
          cache.citations = all[4];
          all[5].forEach(function (r) { cache.members.set(r.id, r); });
          all[6].forEach(function (r) { cache.meta.set(r.key, r); });
        });
      }

      function resetCaches() {
        chunkCache.clear();
        cache.kbs.clear(); cache.documents.clear(); cache.findings.clear();
        cache.feedback = []; cache.citations = [];
        cache.members.clear(); cache.meta.clear();
      }

      // 先开后端（IDB open），再全量载入小表；超时/失败 → 降级内存并重新载入
      var attempt = Promise.resolve().then(function () {
        return backend.init();
      }).then(loadAllCached);

      ready = Promise.race([
        attempt,
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('kb-store init timeout')); }, timeout);
        })
      ]).catch(function (e) {
        try { console.warn('[kb-store] 初始化失败，降级为内存存储：', e && e.message); } catch (_) {}
        backend = createMemoryBackend();
        resetCaches();
        return backend.init().then(loadAllCached);
      }).then(function () { return api; });
      return ready;
    }

    function put(table, rec) {
      return backend.put(table, rec).then(function () { return rec; });
    }

    // ── 知识库 CRUD ────────────────────────────────────────────────────────
    var kbs = {
      list: function () { return Array.from(cache.kbs.values()).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }); },
      get: function (id) { return cache.kbs.get(id) || null; },
      create: function (rec) {
        var kb = {
          id: rec.id || ('kb-' + stableId(String(rec.name || 'kb') + '|' + now())),
          name: rec.name || '未命名知识库',
          reviewIntervalDays: rec.reviewIntervalDays | 0,
          defaultOwnerId: rec.defaultOwnerId || '',
          description: rec.description || '',
          createdAt: rec.createdAt || now(),
          updatedAt: now()
        };
        cache.kbs.set(kb.id, kb);
        return put('kbs', kb).then(function () { return kb; });
      },
      update: function (id, patch) {
        var kb = cache.kbs.get(id);
        if (!kb) return Promise.reject(new Error('知识库不存在: ' + id));
        var next = Object.assign({}, kb, patch, { id: kb.id, updatedAt: now() });
        cache.kbs.set(id, next);
        return put('kbs', next).then(function () { return next; });
      },
      remove: function (id) {
        var docs = kbs.documents(id);
        var jobs = docs.map(function (d) { return documents.remove(d.id); });
        return Promise.all(jobs).then(function () {
          cache.kbs.delete(id);
          return backend.delete('kbs', id);
        });
      },
      documents: function (kbId) {
        return Array.from(cache.documents.values())
          .filter(function (d) { return d.kbId === kbId; })
          .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      }
    };

    // ── 文档 CRUD ──────────────────────────────────────────────────────────
    var documents = {
      list: function (filter) {
        filter = filter || {};
        return Array.from(cache.documents.values()).filter(function (d) {
          if (filter.kbId && d.kbId !== filter.kbId) return false;
          if (filter.status && d.status !== filter.status) return false;
          return true;
        }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      },
      get: function (id) { return cache.documents.get(id) || null; },
      // 创建或更新（内容寻址：同 kb+sourceKey 幂等；内容变化 → version+1）
      upsert: function (rec) {
        if (!rec || !rec.kbId) return Promise.reject(new Error('文档需要 kbId'));
        var sourceKey = rec.sourceKey || rec.sourcePath || rec.title;
        var id = rec.id || ('doc-' + stableId(rec.kbId + '|' + sourceKey));
        var prev = cache.documents.get(id) || null;
        var contentHash = stableId(String(rec.text == null ? '' : rec.text));
        var changed = !prev || prev.contentHash !== contentHash;
        var doc = {
          id: id,
          kbId: rec.kbId,
          title: rec.title || (prev && prev.title) || '未命名文档',
          sourceType: rec.sourceType || (prev && prev.sourceType) || 'text',
          sourcePath: rec.sourcePath || (prev && prev.sourcePath) || '',
          ownerId: rec.ownerId !== undefined ? rec.ownerId : (prev && prev.ownerId) || '',
          // 背书：文档被修改即「作者背书」（Yuheng：changing it restarts the clock）
          lastVouchedAt: changed ? now() : (prev && prev.lastVouchedAt) || now(),
          reviewDueAt: null,   // 由 steward.ensureDue 填充
          status: (prev && prev.status === DOC_STATUS.SUPERSEDED) ? DOC_STATUS.SUPERSEDED : DOC_STATUS.ACTIVE,
          supersededBy: (prev && prev.supersededBy) || '',
          version: (prev && prev.version || 0) + (changed ? 1 : 0),
          contentHash: contentHash,
          text: String(rec.text == null ? '' : rec.text),
          tags: rec.tags || (prev && prev.tags) || [],
          createdAt: (prev && prev.createdAt) || now(),
          updatedAt: now()
        };
        cache.documents.set(id, doc);
        return put('documents', doc).then(function () { return { doc: doc, changed: changed }; });
      },
      patch: function (id, patch) {
        var doc = cache.documents.get(id);
        if (!doc) return Promise.reject(new Error('文档不存在: ' + id));
        var next = Object.assign({}, doc, patch, { id: id, kbId: doc.kbId });
        cache.documents.set(id, next);
        return put('documents', next).then(function () { return next; });
      },
      remove: function (id) {
        return chunks.removeByDoc(id).then(function () {
          cache.documents.delete(id);
          // 该文档相关的引用与反馈一并清理（缓存 + 后端）
          var fbVictims = cache.feedback.filter(function (f) { return f.docId === id; });
          cache.feedback = cache.feedback.filter(function (f) { return f.docId !== id; });
          var citeVictims = cache.citations.filter(function (c) {
            return (c.docIds || []).indexOf(id) >= 0;
          });
          cache.citations = cache.citations.filter(function (c) {
            return (c.docIds || []).indexOf(id) < 0;
          });
          // 该文档参与的发现项删除（配对方的发现项也含此文档）
          var doomed = [];
          cache.findings.forEach(function (f, fid) {
            if (f.subjectDocId === id || f.relatedDocId === id) doomed.push(fid);
          });
          doomed.forEach(function (fid) { cache.findings.delete(fid); });
          var jobs = [backend.delete('documents', id)];
          doomed.forEach(function (fid) { jobs.push(backend.delete('findings', fid)); });
          fbVictims.forEach(function (f) { jobs.push(backend.delete('feedback', f.id)); });
          // 引用行也要落库删除（旧版只清了内存缓存，重载后又回来 = 空间没释放）
          citeVictims.forEach(function (c) { jobs.push(backend.delete('citations', c.id)); });
          return Promise.all(jobs).then(function () { return true; });
        });
      },
      // 一键清空（释放空间）：kbId 省略/空 → 清空所有知识库的文档。
      // 级联清理：分块、发现项、反馈、引用一并删除；返回各表删除计数。
      clear: function (kbId) {
        var docs = documents.list(kbId ? { kbId: kbId } : {});
        var empty = { docs: 0, chunks: 0, findings: 0, feedback: 0, citations: 0 };
        if (!docs.length) return Promise.resolve(empty);
        var docIds = {};
        docs.forEach(function (d) { docIds[d.id] = true; });

        // 分块回源全量（chunkCache 未必已加载），顺带作废缓存
        return loadAll('chunks').then(function (all) {
          var chunkIds = [];
          var chunksByDoc = {};
          all.forEach(function (c) {
            if (!docIds[c.docId]) return;
            chunkIds.push(c.id);
            (chunksByDoc[c.docId] = chunksByDoc[c.docId] || []).push(c.id);
          });
          docs.forEach(function (d) { chunkCache.delete(d.id); });

          // 发现项（含 kbId 归属的兜底）
          var fIds = [];
          cache.findings.forEach(function (f, fid) {
            if (docIds[f.subjectDocId] || docIds[f.relatedDocId] || (kbId && f.kbId === kbId)) fIds.push(fid);
          });
          fIds.forEach(function (fid) { cache.findings.delete(fid); });

          // 反馈
          var fbVictims = cache.feedback.filter(function (f) { return docIds[f.docId]; });
          cache.feedback = cache.feedback.filter(function (f) { return !docIds[f.docId]; });

          // 引用：剔除被清 doc/chunk；行空了就删，否则写回裁剪后的行
          var chunkIdSet = {};
          chunkIds.forEach(function (cid) { chunkIdSet[cid] = true; });
          var citeDeleted = [], citeUpdated = [];
          var kept = [];
          cache.citations.forEach(function (c) {
            var hitDoc = (c.docIds || []).some(function (id) { return docIds[id]; });
            var hitChunk = (c.chunkIds || []).some(function (id) { return chunkIdSet[id]; });
            if (!hitDoc && !hitChunk) { kept.push(c); return; }
            var next = Object.assign({}, c, {
              chunkIds: (c.chunkIds || []).filter(function (id) { return !chunkIdSet[id]; }),
              docIds: (c.docIds || []).filter(function (id) { return !docIds[id]; }),
              refs: (c.refs || []).filter(function (r) { return !docIds[r.docId] && !chunkIdSet[r.chunkId]; })
            });
            if (next.docIds.length) citeUpdated.push(next); else citeDeleted.push(c.id);
          });
          cache.citations = kept.concat(citeUpdated);

          // 文档本体
          docs.forEach(function (d) { cache.documents.delete(d.id); });

          var jobs = [];
          function delMany(table, ids) {
            if (!ids.length) return;
            if (typeof backend.deleteMany === 'function') jobs.push(backend.deleteMany(table, ids));
            else ids.forEach(function (x) { jobs.push(backend.delete(table, x)); });
          }
          delMany('chunks', chunkIds);
          delMany('findings', fIds);
          delMany('feedback', fbVictims.map(function (f) { return f.id; }));
          delMany('documents', docs.map(function (d) { return d.id; }));
          delMany('citations', citeDeleted);
          citeUpdated.forEach(function (c) { jobs.push(put('citations', c)); });
          return Promise.all(jobs).then(function () {
            return {
              docs: docs.length,
              chunks: chunkIds.length,
              findings: fIds.length,
              feedback: fbVictims.length,
              citations: citeDeleted.length + citeUpdated.length
            };
          });
        });
      },
      // 检索可用性：active 才参与检索（superseded 被取代后排除 —— 核心痛点）
      isSearchable: function (doc) {
        return !!doc && doc.status === DOC_STATUS.ACTIVE;
      }
    };

    // ── 分块 ───────────────────────────────────────────────────────────────
    var chunks = {
      // 某文档的全部分块（懒加载 + 缓存）
      listByDoc: function (docId) {
        if (chunkCache.has(docId)) return Promise.resolve(chunkCache.get(docId));
        return loadAll('chunks').then(function (all) {
          // 全量载入缓存（一次查询优于逐 doc 往返）
          var byDoc = {};
          all.forEach(function (c) { (byDoc[c.docId] = byDoc[c.docId] || []).push(c); });
          Object.keys(byDoc).forEach(function (k) {
            byDoc[k].sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
            chunkCache.set(k, byDoc[k]);
          });
          var mine = chunkCache.get(docId) || [];
          return mine;
        });
      },
      // 替换某文档的分块（内容寻址幂等：同 id 覆盖，旧 chunk 删除）
      replaceForDoc: function (docId, kbId, list) {
        return chunks.listByDoc(docId).then(function (old) {
          var oldIds = {};
          old.forEach(function (c) { oldIds[c.id] = true; });
          var next = list.map(function (c, i) {
            var id = stableId(docId + '|' + i + '|' + stableId(c.text));
            oldIds[id] = false;
            return {
              id: id, docId: docId, kbId: kbId, seq: i,
              text: c.text, len: c.text.length,
              vec: c.vec || null, dim: c.dim || 0,
              enabled: c.enabled !== false,
              heading: c.heading || '',
              createdAt: c.createdAt || now()
            };
          });
          var removals = Object.keys(oldIds).filter(function (k) { return oldIds[k]; })
            .map(function (k) { return backend.delete('chunks', k); });
          return Promise.all(removals)
            .then(function () { return backend.putMany('chunks', next); })
            .then(function () { chunkCache.set(docId, next); return next; });
        });
      },
      // 某知识库全部「检索可用」分块（active 文档且 enabled）
      listByKb: function (kbId) {
        return chunks._all().then(function (all) {
          return all.filter(function (c) {
            if (c.kbId !== kbId || c.enabled === false) return false;
            var doc = cache.documents.get(c.docId);
            return documents.isSearchable(doc);
          });
        });
      },
      _all: function () {
        var ids = Array.from(chunkCache.keys());
        // 缓存不全时回源
        return loadAll('chunks').then(function (all) {
          var byDoc = {};
          all.forEach(function (c) { (byDoc[c.docId] = byDoc[c.docId] || []).push(c); });
          Object.keys(byDoc).forEach(function (k) {
            byDoc[k].sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
            if (!chunkCache.has(k)) chunkCache.set(k, byDoc[k]);
          });
          var out = [];
          chunkCache.forEach(function (v) { out.push.apply(out, v); });
          return out;
        });
      },
      removeByDoc: function (docId) {
        var list = chunkCache.get(docId) || [];
        chunkCache.delete(docId);
        return Promise.all(list.map(function (c) { return backend.delete('chunks', c.id); }));
      }
    };

    // ── 发现项（knowledge_findings）────────────────────────────────────────
    var findings = {
      list: function (filter) {
        filter = filter || {};
        var rows = Array.from(cache.findings.values()).filter(function (f) {
          if (filter.kbId && f.kbId !== filter.kbId) return false;
          if (filter.status && f.status !== filter.status) return false;
          if (filter.type && f.type !== filter.type) return false;
          if (filter.assigneeId && f.assigneeId !== filter.assigneeId) return false;
          if (filter.docId && f.subjectDocId !== filter.docId && f.relatedDocId !== filter.docId) return false;
          return true;
        });
        // 最紧急在前，再按证据强度（对齐 findingOrder）
        var sev = { error: 0, warning: 1, info: 2 };
        rows.sort(function (a, b) {
          if ((sev[a.severity] || 3) !== (sev[b.severity] || 3)) return (sev[a.severity] || 3) - (sev[b.severity] || 3);
          if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
          if ((b.updatedAt || 0) !== (a.updatedAt || 0)) return (b.updatedAt || 0) - (a.updatedAt || 0);
          return a.id < b.id ? -1 : 1;
        });
        return rows;
      },
      get: function (id) { return cache.findings.get(id) || null; },
      byFingerprint: function (fp) {
        var found = null;
        cache.findings.forEach(function (f) { if (!found && f.fingerprint === fp) found = f; });
        return found;
      },
      put: function (rec) {
        cache.findings.set(rec.id, rec);
        return put('findings', rec).then(function () { return rec; });
      },
      remove: function (id) {
        cache.findings.delete(id);
        return backend.delete('findings', id);
      },
      // 发现项结案（人做的三种：supersede 后由检测器销案 / confirm / dismiss）
      settle: function (id, patch) {
        var f = cache.findings.get(id);
        if (!f) return Promise.reject(new Error('发现项不存在: ' + id));
        var next = Object.assign({}, f, patch, { id: id, updatedAt: now() });
        cache.findings.set(id, next);
        return put('findings', next).then(function () { return next; });
      }
    };

    // ── 反馈（message_feedback：按被引文档逐篇落行）────────────────────────
    var feedback = {
      list: function (filter) {
        filter = filter || {};
        return cache.feedback.filter(function (f) {
          if (filter.docId && f.docId !== filter.docId) return false;
          if (filter.messageId && f.messageId !== filter.messageId) return false;
          if (filter.rating && f.rating !== filter.rating) return false;
          return true;
        });
      },
      // 落行：一条反馈对每篇被引文档一行（upsert by messageId+docId）
      record: function (rec) {
        var id = stableId(rec.messageId + '|' + rec.docId);
        var row = {
          id: id,
          messageId: rec.messageId,
          docId: rec.docId,
          kbId: rec.kbId || '',
          sessionId: rec.sessionId || 'main',
          rating: rec.rating,                      // 'up' | 'down'
          comment: rec.comment || '',
          shareQuestion: !!rec.shareQuestion,
          question: rec.question || '',            // 仅 shareQuestion 时展示（争议证据）
          userId: rec.userId || 'local',
          createdAt: now()
        };
        var idx = cache.feedback.findIndex(function (f) { return f.id === id; });
        if (idx >= 0) cache.feedback[idx] = row; else cache.feedback.push(row);
        return put('feedback', row).then(function () { return row; });
      },
      removeByMessage: function (messageId) {
        var victims = cache.feedback.filter(function (f) { return f.messageId === messageId; });
        cache.feedback = cache.feedback.filter(function (f) { return f.messageId !== messageId; });
        return Promise.all(victims.map(function (f) { return backend.delete('feedback', f.id); }));
      }
    };

    // ── 引用关系（消息 → 被引 chunk/doc，反馈归因的数据前提）───────────────
    var citations = {
      record: function (rec) {
        var id = stableId('cite|' + rec.messageId);
        var row = {
          id: id,
          messageId: rec.messageId,
          kbId: rec.kbId || '',
          chunkIds: rec.chunkIds || [],
          docIds: rec.docIds || [],
          refs: rec.refs || [],       // [{n, chunkId, docId, title, excerpt}]
          createdAt: now()
        };
        var idx = cache.citations.findIndex(function (c) { return c.id === id; });
        if (idx >= 0) cache.citations[idx] = row; else cache.citations.push(row);
        return put('citations', row).then(function () { return row; });
      },
      byMessage: function (messageId) {
        return cache.citations.find(function (c) { return c.messageId === messageId; }) || null;
      },
      removeByMessage: function (messageId) {
        var victims = cache.citations.filter(function (c) { return c.messageId === messageId; });
        cache.citations = cache.citations.filter(function (c) { return c.messageId !== messageId; });
        return Promise.all(victims.map(function (c) { return backend.delete('citations', c.id); }));
      }
    };

    // ── 成员 / 负责人 ──────────────────────────────────────────────────────
    var members = {
      list: function () { return Array.from(cache.members.values()).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }); },
      get: function (id) { return cache.members.get(id) || null; },
      add: function (rec) {
        var m = {
          id: rec.id || ('m-' + stableId(String(rec.name) + '|' + now())),
          name: String(rec.name || '').trim() || '未命名',
          role: rec.role || 'owner',
          createdAt: rec.createdAt || now()
        };
        cache.members.set(m.id, m);
        return put('members', m).then(function () { return m; });
      },
      remove: function (id) {
        cache.members.delete(id);
        return backend.delete('members', id);
      }
    };

    // ── meta（当前用户等杂项）──────────────────────────────────────────────
    var meta = {
      get: function (key) { var r = cache.meta.get(key); return r ? r.value : null; },
      set: function (key, value) {
        var rec = { key: key, value: value, updatedAt: now() };
        cache.meta.set(key, rec);
        return put('meta', rec).then(function () { return value; });
      }
    };

    var api = {
      VERSION: VERSION,
      DB_NAME: DB_NAME,
      FINDING: FINDING,
      DOC_STATUS: DOC_STATUS,
      init: init,
      get backendKind() { return backend.kind; },      kbs: kbs,
      documents: documents,
      chunks: chunks,
      findings: findings,
      feedback: feedback,
      citations: citations,
      members: members,
      meta: meta,
      // 危险：全量清空（设置面板用）
      clearAll: function () {
        cache.kbs.clear(); cache.documents.clear(); cache.findings.clear();
        cache.feedback = []; cache.citations = [];
        cache.members.clear(); cache.meta.clear(); chunkCache.clear();
        return backend.clear();
      },
      stats: function () {
        var byStatus = {};
        cache.documents.forEach(function (d) { byStatus[d.status] = (byStatus[d.status] || 0) + 1; });
        var openFindings = 0;
        cache.findings.forEach(function (f) { if (f.status === FINDING.OPEN) openFindings++; });
        return {
          storage: backend.kind,
          kbs: cache.kbs.size,
          documents: cache.documents.size,
          docByStatus: byStatus,
          findings: cache.findings.size,
          openFindings: openFindings,
          feedback: cache.feedback.length,
          members: cache.members.size
        };
      }
    };
    current = api;   // 模块级当前实例（见导出注释）
    return api;
  }

  // 导出门面：常量/工厂直出；实例属性转发到 current（createStore 之后可用）。
  // 这样 kb-ingest/search/qa 等模块在加载时 require 本文件拿到的也是可用句柄。
  var FORWARD = ['kbs', 'documents', 'chunks', 'findings', 'feedback', 'citations',
    'members', 'meta', 'stats', 'clearAll', 'backendKind', 'init'];
  var facade = {
    VERSION: VERSION,
    DB_NAME: DB_NAME,
    FINDING: FINDING,
    DOC_STATUS: DOC_STATUS,
    createStore: createStore,
    stableId: stableId,
    createMemoryBackend: createMemoryBackend,
    get current() { return current; }
  };
  FORWARD.forEach(function (key) {
    Object.defineProperty(facade, key, {
      enumerable: true,
      get: function () {
        if (!current) throw new Error('KBStore: 请先 createStore() 并 init()');
        return current[key];
      }
    });
  });

  return facade;
});
