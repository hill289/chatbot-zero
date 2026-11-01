/*!
 * memory-layer.js — 本地记忆层（Local Memory Layer）
 * =============================================================================
 * 给「chatbot-zero」补上长期记忆能力，逻辑提炼自 Yuheng（玉衡，Go 版
 * 企业 RAG 知识平台）的检索链路，并改造成**纯前端、零后端、持久化到 IndexedDB**
 * 的本地实现：
 *
 *   Yuheng 里的关键逻辑                       → 本模块的对应实现
 *   ---------------------------------------------------------------------------
 *   向量 + 关键词「混合检索」                  → hybridSearch()：hashEmbed 向量 + BM25
 *   RRF 融合（weight/(k+rank)）               → rrfFuse()（默认 k=60，权重各 1.0）
 *   单模去重按分数保留最高                     → dedupeByScore()
 *   确定性排序后再截断 TopK                    → deterministicSort() + filterTopK()
 *   低召回时的本地查询扩展                      → expandQueries()（停用词/短语/分隔/疑问词）
 *   相邻分块合并                               → mergeAdjacent()
 *   检索上下文/引用注入到「最后一条 user 消息」  → composeRecall() → bootstrap 注入
 *   跨会话消息检索（yuheng message search）      → sessionSearch() / indexTurns()
 *   画像注入（用户画像 / user profile）         → profile 存储 + recall()
 *
 * 关键设计（对齐本项目既有约定）：
 *   · 零依赖、无构建、UMD：浏览器挂 globalThis.AgentMemory，Node 下 module.exports。
 *   · 存储抽象 Storage：优先 IndexedDB（DB=agent-memory），Node/无 IDB 环境回退内存。
 *   · 向量：默认内置「哈希 n-gram 向量器」（离线可用、中英文皆可、确定性）；
 *     可通过 configure({ embedder }) 换成真正的 WASM 神经嵌入（如 transformers.js）。
 *   · 前缀缓存友好：本模块**绝不**改动被 prefixManager 缓存的 system+tools 前缀，
 *     召回内容只注入到「对话尾部最后一条 user 消息」。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AgentMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DB_NAME = 'agent-memory';
  var DB_VERSION = 1;
  var DEFAULT_DIM = 256;        // 哈希向量维度
  var DEFAULT_RRF_K = 60;       // RRF 平滑常数（与 Yuheng 默认一致）
  var DEFAULT_VEC_WEIGHT = 1.0;
  var DEFAULT_KW_WEIGHT = 1.0;
  var BM25_K1 = 1.2;
  var BM25_B = 0.75;
  var PROFILE_META_KEY = 'profile';

  // ── 通用小工具 ────────────────────────────────────────────────────────────
  function toText(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (_) { return String(x); }
  }
  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function fnv1a(str, seed) {
    var h = (seed == null ? 2166136261 : seed) >>> 0;
    str = String(str == null ? '' : str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  // 稳定 ID：两次 FNV-1a 拼成 16 位十六进制（内容寻址，可幂等去重）
  function stableId(str) {
    var a = fnv1a(str, 2166136261).toString(16).padStart(8, '0');
    var b = fnv1a(str, 0x01000193).toString(16).padStart(8, '0');
    return a + b;
  }
  function toFloat32(vec) {
    if (vec instanceof Float32Array) return vec;
    if (Array.isArray(vec) || (vec && typeof vec.length === 'number')) {
      var out = new Float32Array(vec.length);
      for (var i = 0; i < vec.length; i++) out[i] = Number(vec[i]) || 0;
      return out;
    }
    return new Float32Array(0);
  }
  function l2norm(v) {
    var n = 0;
    for (var i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    if (n > 0) for (var j = 0; j < v.length; j++) v[j] /= n;
    return v;
  }
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // ── 分词（中文按字 + 二元组，英文/数字按词）────────────────────────────────
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/;
  function tokenize(text) {
    var out = [];
    if (text == null) return out;
    var s = String(text);
    if (!s) return out;
    var re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+|[A-Za-z0-9_]+/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var t = m[0];
      if (/^[A-Za-z0-9_]/.test(t)) {
        var low = t.toLowerCase();
        out.push(low);
        if (low.indexOf('_') >= 0) {
          var parts = low.split(/_+/);
          for (var p = 0; p < parts.length; p++) if (parts[p]) out.push(parts[p]);
        }
      } else {
        var chars = Array.from(t);
        for (var i = 0; i < chars.length; i++) {
          out.push(chars[i]);
          if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
        }
      }
    }
    return out;
  }

  // ── 内置哈希向量器（offline、确定性、中英文通用）──────────────────────────
  // 词哈希 + 词频对数加权 + 符号散列（signed hashing trick），最后 L2 归一化。
  function hashEmbed(text, dim) {
    dim = dim || DEFAULT_DIM;
    var v = new Float32Array(dim);
    var toks = tokenize(text);
    if (!toks.length) return v;
    var tf = new Map();
    for (var i = 0; i < toks.length; i++) tf.set(toks[i], (tf.get(toks[i]) || 0) + 1);
    tf.forEach(function (c, t) {
      var h = fnv1a(t, 2166136261);
      var idx = h % dim;
      var sign = ((h >>> 31) & 1) ? -1 : 1;
      v[idx] += (1 + Math.log(c)) * sign;
    });
    return l2norm(v);
  }

  // ── BM25 ─────────────────────────────────────────────────────────────────
  function termFreq(tokens) {
    var tf = new Map();
    for (var i = 0; i < tokens.length; i++) tf.set(tokens[i], (tf.get(tokens[i]) || 0) + 1);
    return tf;
  }
  function bm25Score(queryTf, doc, df, N, avgdl) {
    if (!doc || !doc.len || !N) return 0;
    var k1 = BM25_K1, b = BM25_B, score = 0;
    queryTf.forEach(function (qf, term) {
      var d = df.get(term) || 0;
      if (!d) return;
      var f = doc.tf.get(term) || 0;
      if (!f) return;
      var idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.len / (avgdl || doc.len))));
    });
    return score;
  }

  // ── 排序 / 去重 / 融合（对齐 Yuheng knowledgebase_search_fusion.go）─────────
  function sortByScoreDesc(list) {
    list.sort(function (a, b) { return b.score - a.score; });
    return list;
  }
  // 单模去重：同 id 保留最高分
  function dedupeByScore(items) {
    var best = new Map();
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      var cur = best.get(r.id);
      if (!cur || r.score > cur.score) best.set(r.id, r);
    }
    var out = Array.from(best.values());
    return sortByScoreDesc(out);
  }
  // 确定性排序：分数降序 → id 升序 → ts 升序（结果可复现）
  function deterministicSort(items) {
    return items.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return (a.ts || 0) - (b.ts || 0);
    });
  }
  function filterTopK(items, topK) {
    if (topK > 0 && items.length > topK) return items.slice(0, topK);
    return items;
  }
  // RRF 融合：score = Σ weight_i / (k + rank_i)。lists 为若干已按 score 降序的 [{id,score}]
  function rrfFuse(lists, opts) {
    opts = opts || {};
    var k = opts.k > 0 ? opts.k : DEFAULT_RRF_K;
    var weights = opts.weights || [];
    var fused = new Map();
    for (var li = 0; li < lists.length; li++) {
      var list = lists[li] || [];
      var w = (weights[li] != null) ? weights[li] : 1.0;
      for (var ri = 0; ri < list.length; ri++) {
        var id = list[ri].id;
        var rank = ri + 1;
        fused.set(id, (fused.get(id) || 0) + w / (k + rank));
      }
    }
    return fused;
  }

  // ── 本地查询扩展（移植 Yuheng query_expansion.go 的 expandQueries）─────────
  var STOPWORDS = (function () {
    var arr = ['的', '是', '在', '了', '和', '与', '或', '就', '也', '都', '我', '你', '他',
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'about',
      'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose'];
    var m = {}; for (var i = 0; i < arr.length; i++) m[arr[i]] = true; return m;
  })();
  var QUESTION_WORDS = /^(什么是|什么|如何|怎么|怎样|为什么|为何|哪个|哪些|谁|何时|何地|请问|请告诉我|帮我|我想知道|我想了解)/;
  function expandQueries(query) {
    query = String(query == null ? '' : query).trim();
    if (!query) return [];
    var seen = {}; seen[query.toLowerCase()] = true;
    var out = [];
    function addIfNew(s) {
      s = String(s == null ? '' : s).trim();
      if (!s || s.length < 3) return;
      var key = s.toLowerCase();
      if (seen[key]) return;
      seen[key] = true; out.push(s);
    }
    // 1) 去停用词后的关键词串
    var toks = tokenize(query), keywords = [];
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i];
      if (!STOPWORDS[w.toLowerCase()] && w.length > 1) keywords.push(w);
    }
    if (keywords.length >= 2) addIfNew(keywords.join(' '));
    // 2) 引号 / 书名号短语
    var re = /["'“”‘’「」『』《》]([^"'“”‘’「」『』《》]+)["'“”‘’「」『』《》]/g, mm;
    while ((mm = re.exec(query)) !== null) if (mm[1] && mm[1].length > 2) addIfNew(mm[1]);
    // 3) 按分隔符切分取长片段
    var segs = query.split(/[,，;；、。！？!?\s]+/);
    for (var s = 0; s < segs.length; s++) if (segs[s].length > 5) addIfNew(segs[s]);
    // 4) 去掉疑问词
    var cleaned = query.replace(QUESTION_WORDS, '').trim();
    if (cleaned && cleaned !== query) addIfNew(cleaned);
    return out.slice(0, 5);
  }

  // ── 相邻合并（会话片段/分块，参考 Yuheng merge_overlap.go 的时序合并）───────
  function mergeAdjacent(items, opts) {
    opts = opts || {};
    var gapMs = opts.gapMs != null ? opts.gapMs : 5 * 60 * 1000;
    var maxChars = opts.maxChars || 1200;
    var keyOf = opts.keyOf || function (x) { return x.sessionId || ''; };
    var sorted = items.slice().sort(function (a, b) {
      var ka = keyOf(a), kb = keyOf(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (a.ts || 0) - (b.ts || 0);
    });
    var groups = [];
    for (var i = 0; i < sorted.length; i++) {
      var cur = sorted[i];
      var last = groups[groups.length - 1];
      if (last && keyOf(last) === keyOf(cur) && (cur.ts - last._lastTs) <= gapMs &&
        last.text.length + cur.text.length <= maxChars) {
        last.text = last.text + '\n' + cur.text;
        last.ids.push(cur.id);
        last._lastTs = cur.ts;
        if (cur.score > last.score) last.score = cur.score;
      } else {
        var g = Object.assign({}, cur, { text: cur.text, ids: [cur.id], _lastTs: cur.ts || 0 });
        groups.push(g);
      }
    }
    groups.forEach(function (g) { delete g._lastTs; });
    return sortByScoreDesc(groups);
  }

  // ── 存储抽象 ─────────────────────────────────────────────────────────────
  // 统一接口（keyPath：items→id，meta→key）：
  //   init/getAll/get/put/putMany/delete/clear
  function createMemoryStorage() {
    var s = { items: new Map(), meta: new Map() };
    function store(name) { return name === 'meta' ? s.meta : s.items; }
    function keyOf(name, val) { return name === 'meta' ? val.key : val.id; }
    return {
      kind: 'memory',
      init: function () { return Promise.resolve(); },
      getAll: function (name) { return Promise.resolve(Array.from(store(name).values())); },
      get: function (name, key) { return Promise.resolve(store(name).get(key) || null); },
      put: function (name, val) { store(name).set(keyOf(name, val), val); return Promise.resolve(val); },
      putMany: function (name, vals) {
        for (var i = 0; i < vals.length; i++) store(name).set(keyOf(name, vals[i]), vals[i]);
        return Promise.resolve(vals.length);
      },
      delete: function (name, key) { store(name).delete(key); return Promise.resolve(true); },
      clear: function (name) {
        if (name) { store(name).clear(); } else { s.items.clear(); s.meta.clear(); }
        return Promise.resolve(true);
      }
    };
  }

  function createIdbStorage(dbName) {
    var DB = dbName || DB_NAME;
    var db = null;
    function open() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB, DB_VERSION);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
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
      clear: function (name) {
        var names = name ? [name] : ['items', 'meta'];
        return Promise.all(names.map(function (n) { return exec(n, 'readwrite', function (os) { os.clear(); return null; }); }))
          .then(function () { return true; });
      }
    };
  }

  function defaultStorage() {
    try { if (typeof indexedDB !== 'undefined' && indexedDB) return createIdbStorage(); } catch (_) { /* 回退 */ }
    return createMemoryStorage();
  }

  // ── 召回上下文组装（注入到「最后一条 user 消息」的块）───────────────────────
  function composeRecall(query, opts) {
    opts = opts || {};
    var profile = opts.profile || [];
    var results = opts.results || [];
    var sessions = opts.sessions || [];
    var limit = opts.limit || 8;
    var maxChars = opts.maxChars || 2400;
    var lines = [];
    if (profile.length) {
      lines.push('【用户画像】');
      for (var i = 0; i < profile.length && i < 12; i++) {
        var p = profile[i];
        lines.push('- ' + (p.key ? p.key + '：' : '') + clip(p.text, 180));
      }
    }
    if (results.length) {
      lines.push('【相关长期记忆】');
      for (var r = 0; r < results.length && r < limit; r++) {
        lines.push((r + 1) + '. [' + (results[r].kind || 'memory') + '] ' + clip(results[r].text, 240));
      }
    }
    if (sessions.length) {
      lines.push('【历史会话片段】');
      for (var sIdx = 0; sIdx < sessions.length && sIdx < 5; sIdx++) {
        lines.push('- (' + (sessions[sIdx].sessionId || 'session') + ') ' + clip(sessions[sIdx].text, 200));
      }
    }
    if (!lines.length) return '';
    var body = lines.join('\n');
    var head = '<!-- 本地记忆 · 自动召回' + (query ? '（query=' + clip(query, 60) + '）' : '') + ' -->\n';
    var foot = '\n（以上由本地记忆层自动检索，可能与当前问题无关；若与用户当前输入冲突，以用户当前输入为准。）';
    var out = head + body + foot;
    if (maxChars && out.length > maxChars) out = out.slice(0, maxChars) + '…';
    return out;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // MemoryEngine
  // ═════════════════════════════════════════════════════════════════════════
  function MemoryEngine(opts) {
    opts = opts || {};
    this.opts = opts;
    this.dim = opts.dim || DEFAULT_DIM;
    this.rrfK = opts.rrfK || DEFAULT_RRF_K;
    this.vecWeight = opts.vectorWeight != null ? opts.vectorWeight : DEFAULT_VEC_WEIGHT;
    this.kwWeight = opts.keywordWeight != null ? opts.keywordWeight : DEFAULT_KW_WEIGHT;
    this.storage = opts.storage || defaultStorage();
    this.embedder = opts.embedder || null;   // 自定义嵌入（可 async）；为空则用 hashEmbed
    this._items = [];
    this._index = null;
    this._ready = false;
  }

  MemoryEngine.prototype.init = function () {
    var self = this;
    return Promise.resolve(this.storage.init())
      .then(function () { return self._reload(); })
      .then(function () { self._ready = true; return self; });
  };
  MemoryEngine.prototype._reload = function () {
    var self = this;
    return this.storage.getAll('items').then(function (items) {
      self._items = (items || []).map(function (it) {
        if (it.vec && !(it.vec instanceof Float32Array)) it.vec = toFloat32(it.vec);
        return it;
      });
      self._index = null;
      return self._items;
    });
  };
  MemoryEngine.prototype._ensureIndex = function () {
    if (this._index) return this._index;
    var docs = new Map(), df = new Map(), total = 0;
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      var toks = tokenize(it.text);
      var tf = termFreq(toks);
      docs.set(it.id, { id: it.id, tf: tf, len: toks.length });
      total += toks.length;
      tf.forEach(function (_c, t) { df.set(t, (df.get(t) || 0) + 1); });
    }
    this._index = { docs: docs, df: df, N: this._items.length, avgdl: this._items.length ? total / this._items.length : 0 };
    return this._index;
  };
  MemoryEngine.prototype._embed = function (text) {
    var self = this;
    return Promise.resolve()
      .then(function () { return self.embedder ? self.embedder(text) : hashEmbed(text, self.dim); })
      .then(function (v) { return l2norm(toFloat32(v)); });
  };
  MemoryEngine.prototype._normalize = function (item) {
    var text = String(item.text == null ? '' : item.text);
    var kind = item.kind || 'memory';
    var ts = item.ts || Date.now();
    return {
      id: item.id || stableId([kind, item.sessionId || '', text].join('\u0000')),
      kind: kind,
      text: text,
      ts: ts,
      sessionId: item.sessionId || null,
      role: item.role || null,
      tags: Array.isArray(item.tags) ? item.tags.slice() : [],
      meta: item.meta || null,
      hash: stableId(text)
    };
  };
  MemoryEngine.prototype.add = function (item) {
    var self = this;
    return this._embed(item.text == null ? '' : item.text).then(function (vec) {
      var rec = self._normalize(item);
      rec.vec = vec;
      rec.dim = self.dim;
      return self.storage.put('items', rec).then(function () {
        // 内存索引增量更新
        var existed = self._items.findIndex(function (x) { return x.id === rec.id; });
        if (existed >= 0) self._items[existed] = rec; else self._items.push(rec);
        self._index = null;
        return rec;
      });
    });
  };
  MemoryEngine.prototype.addMany = function (items) {
    var self = this;
    if (!items || !items.length) return Promise.resolve(0);
    return Promise.all(items.map(function (it) {
      return self._embed(it.text == null ? '' : it.text).then(function (vec) {
        var rec = self._normalize(it); rec.vec = vec; rec.dim = self.dim; return rec;
      });
    })).then(function (recs) {
      return self.storage.putMany('items', recs).then(function () {
        recs.forEach(function (rec) {
          var i = self._items.findIndex(function (x) { return x.id === rec.id; });
          if (i >= 0) self._items[i] = rec; else self._items.push(rec);
        });
        self._index = null;
        return recs.length;
      });
    });
  };
  MemoryEngine.prototype.remove = function (id) {
    var self = this;
    return this.storage.delete('items', id).then(function () {
      self._items = self._items.filter(function (x) { return x.id !== id; });
      self._index = null;
      return true;
    });
  };
  MemoryEngine.prototype.clear = function (kind) {
    var self = this;
    if (!kind) {
      return this.storage.clear().then(function () { self._items = []; self._index = null; return true; });
    }
    var victims = this._items.filter(function (x) { return x.kind === kind; });
    return Promise.all(victims.map(function (v) { return self.storage.delete('items', v.id); }))
      .then(function () { self._items = self._items.filter(function (x) { return x.kind !== kind; }); self._index = null; return victims.length; });
  };
  MemoryEngine.prototype.all = function (kind) {
    if (!kind) return this._items.slice();
    return this._items.filter(function (x) { return x.kind === kind; });
  };

  // 混合检索：向量 + BM25 → RRF 融合 → 去重 → 确定性排序 → TopK
  MemoryEngine.prototype.search = function (query, o) {
    var self = this;
    o = o || {};
    var kinds = o.kinds || null;
    var pool = this._items.filter(function (x) {
      if (kinds && kinds.indexOf(x.kind) < 0) return false;
      if (o.sessionId && x.sessionId !== o.sessionId) return false;
      return true;
    });
    if (!pool.length) return Promise.resolve([]);
    var index = this._ensureIndex();
    var queries = [String(query == null ? '' : query)];
    if (o.expand !== false) queries = queries.concat(expandQueries(query));
    return Promise.all(queries.map(function (q) { return self._embed(q); })).then(function (qvecs) {
      var lists = [], weights = [];
      for (var qi = 0; qi < queries.length; qi++) {
        // 关键词（BM25）
        var qtf = termFreq(tokenize(queries[qi]));
        if (qtf.size) {
          var kw = [];
          for (var i = 0; i < pool.length; i++) {
            var doc = index.docs.get(pool[i].id);
            var sc = bm25Score(qtf, doc, index.df, index.N, index.avgdl);
            if (sc > 0) kw.push({ id: pool[i].id, score: sc });
          }
          if (kw.length) { sortByScoreDesc(kw); lists.push(kw); weights.push(self.kwWeight); }
        }
        // 向量（cosine）
        var vs = [];
        for (var v = 0; v < pool.length; v++) {
          if (!pool[v].vec) continue;
          var cs = cosine(qvecs[qi], pool[v].vec);
          if (cs > 0) vs.push({ id: pool[v].id, score: cs });
        }
        if (vs.length) { sortByScoreDesc(vs); lists.push(vs); weights.push(self.vecWeight); }
      }
      var scored = [];                                  // [{id, score}]
      var byId = new Map();
      pool.forEach(function (x) { byId.set(x.id, x); });
      if (lists.length === 1) {
        scored = dedupeByScore(lists[0]);               // 单模：保留原始分数
      } else if (lists.length > 1) {
        var fused = rrfFuse(lists, { k: self.rrfK, weights: weights });
        fused.forEach(function (score, id) { scored.push({ id: id, score: score }); });
      }
      scored = deterministicSort(scored);
      if (o.threshold > 0) scored = scored.filter(function (r) { return r.score >= o.threshold; });
      scored = filterTopK(scored, o.limit || 8);
      // 回填记忆条目字段
      return scored.map(function (r) {
        var it = byId.get(r.id);
        if (!it) return null;
        return { id: it.id, kind: it.kind, text: it.text, ts: it.ts, sessionId: it.sessionId, role: it.role, tags: it.tags, score: r.score };
      }).filter(Boolean);
    });
  };

  // 自动召回：检索 + 画像（+ 可选会话片段）→ 组装成可注入的文本块
  MemoryEngine.prototype.recall = function (query, o) {
    var self = this;
    o = o || {};
    var kinds = o.kinds || ['memory', 'fact', 'note', 'preference', 'doc'];
    return this.search(query, { kinds: kinds, limit: o.limit || 6, expand: o.expand !== false, threshold: o.threshold || 0 })
      .then(function (results) {
        var p = o.includeProfile === false ? Promise.resolve([]) : self.getProfile();
        return p.then(function (profile) {
          var sess = o.includeSessions ? self.sessionSearch(query, { limit: 3 }) : Promise.resolve([]);
          return sess.then(function (sessions) {
            var block = composeRecall(query, { profile: profile, results: results, sessions: sessions, limit: o.limit || 6, maxChars: o.maxChars });
            return { block: block, items: results, profile: profile, sessions: sessions };
          });
        });
      });
  };

  // ── 用户画像（画像注入）──────────────────────────────────────────────────
  MemoryEngine.prototype.getProfile = function () {
    return this.storage.get('meta', PROFILE_META_KEY).then(function (doc) {
      return (doc && Array.isArray(doc.facts)) ? doc.facts : [];
    });
  };
  MemoryEngine.prototype.setProfile = function (facts) {
    var norm = (facts || []).map(function (f) {
      if (typeof f === 'string') return { key: '', text: f, updatedAt: Date.now() };
      return { key: f.key || '', text: String(f.text == null ? '' : f.text), updatedAt: f.updatedAt || Date.now() };
    }).filter(function (f) { return f.text; });
    return this.storage.put('meta', { key: PROFILE_META_KEY, facts: norm }).then(function () { return norm; });
  };
  MemoryEngine.prototype.upsertProfile = function (fact) {
    var self = this;
    return this.getProfile().then(function (facts) {
      var key = fact.key || '';
      var text = String(fact.text == null ? '' : fact.text);
      var idx = -1;
      for (var i = 0; i < facts.length; i++) {
        if ((facts[i].key || '') === key && (key || facts[i].text === text)) { idx = i; break; }
      }
      var rec = { key: key, text: text, updatedAt: Date.now() };
      if (idx >= 0) facts[idx] = rec; else facts.push(rec);
      return self.setProfile(facts);
    });
  };
  MemoryEngine.prototype.removeProfile = function (key) {
    var self = this;
    return this.getProfile().then(function (facts) {
      return self.setProfile(facts.filter(function (f) { return (f.key || '') !== key; }));
    });
  };

  // ── 会话检索（跨会话历史对话）────────────────────────────────────────────
  // 幂等索引一轮对话：role ∈ user/assistant，内容哈希去重
  MemoryEngine.prototype.indexTurns = function (messages, o) {
    o = o || {};
    var sessionId = o.sessionId || 'main';
    var batch = [];
    var seenText = {};
    (messages || []).forEach(function (m) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
      var text = typeof m.content === 'string' ? m.content : toText(m.content);
      if (!text || text.length < 2) return;
      var id = stableId(['turn', sessionId, m.role, text].join('\u0000'));
      if (o._dedupe !== false) { if (seenText[id]) return; seenText[id] = true; }
      batch.push({ id: id, kind: 'turn', text: text, role: m.role, sessionId: sessionId, ts: m.ts || o.ts || Date.now() });
    });
    if (!batch.length) return Promise.resolve(0);
    return this.addMany(batch);
  };
  MemoryEngine.prototype.sessionSearch = function (query, o) {
    var self = this;
    o = o || {};
    return this.search(query, { kinds: ['turn'], limit: o.limit || 5, expand: o.expand !== false }).then(function (res) {
      if (o.merge === false) return res;
      return mergeAdjacent(res, { gapMs: o.gapMs, maxChars: o.maxChars, keyOf: function (x) { return x.sessionId || ''; } });
    });
  };

  MemoryEngine.prototype.stats = function () {
    var byKind = {};
    this._items.forEach(function (x) { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
    return {
      storage: this.storage.kind,
      dim: this.dim,
      total: this._items.length,
      byKind: byKind,
      terms: this._index ? this._index.df.size : null
    };
  };
  MemoryEngine.prototype.exportJSON = function () {
    var self = this;
    return this.getProfile().then(function (profile) {
      return { version: VERSION, dim: self.dim, profile: profile, items: self._items.map(function (x) {
        return { id: x.id, kind: x.kind, text: x.text, ts: x.ts, sessionId: x.sessionId, role: x.role, tags: x.tags };
      }) };
    });
  };
  MemoryEngine.prototype.importJSON = function (data) {
    if (!data || !Array.isArray(data.items)) return Promise.resolve(0);
    var self = this;
    return this.addMany(data.items).then(function (n) {
      if (data.profile) return self.setProfile(data.profile).then(function () { return n; });
      return n;
    });
  };

  // ── 导出 ────────────────────────────────────────────────────────────────
  return {
    VERSION: VERSION,
    DB_NAME: DB_NAME,
    PROFILE_META_KEY: PROFILE_META_KEY,
    createEngine: function (opts) { return new MemoryEngine(opts); },
    // 纯逻辑（供单测 / 复用）
    tokenize: tokenize,
    termFreq: termFreq,
    hashEmbed: hashEmbed,
    cosine: cosine,
    bm25Score: bm25Score,
    sortByScoreDesc: sortByScoreDesc,
    dedupeByScore: dedupeByScore,
    deterministicSort: deterministicSort,
    filterTopK: filterTopK,
    rrfFuse: rrfFuse,
    expandQueries: expandQueries,
    mergeAdjacent: mergeAdjacent,
    composeRecall: composeRecall,
    fnv1a: fnv1a,
    stableId: stableId,
    // 存储工厂
    storage: {
      memory: createMemoryStorage,
      indexedDB: createIdbStorage,
      default: defaultStorage
    }
  };
});
