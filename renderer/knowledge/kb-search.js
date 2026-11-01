/*!
 * kb-search.js — 知识库检索（Hybrid Retrieval：向量 + BM25 → RRF）
 * =============================================================================
 * 检索算法与 memory-layer 同源（提炼自 Yuheng knowledgebase_search_fusion.go）：
 * 向量 cosine + BM25 两路召回 → RRF(k=60) 融合 → 去重 → 确定性排序 → TopK，
 * 外加查询扩展（query_expansion.go 的本地实现）。
 *
 * 与 memory-layer 的区别（这是「知识库」而非「记忆」）：
 *   · 语料 = 某知识库的 chunks（仅 active 文档 —— **被取代的过期文档
 *     自动排除**，正是「过期制度不再被引用」的落点）；
 *   · 返回带文档元数据（docId/title/heading），供引用角标与反馈归因；
 *   · BM25 语料统计（df/avgdl/N）按 kb 每次现算（数千块级毫秒内），
 *     无需维护增量统计表。
 *
 * UMD：浏览器挂 globalThis.KBSearch，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js'), memory: safe('../memory/memory-layer.js') };
  } else {
    deps = { store: root.KBStore, memory: root.AgentMemory };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBSearch = api;

  function safe(p) { try { return require(p); } catch (_) { return null; } }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var mem = deps.memory;

  var BM25_K1 = 1.2;
  var BM25_B = 0.75;
  var RRF_K = 60;

  // ── 分词 / 向量（与 memory-layer 完全同源；不可用时兜底）────────────────
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/;

  function tokenize(text) {
    if (mem && mem.tokenize) return mem.tokenize(text);
    var out = [];
    var re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+|[A-Za-z0-9_]+/g;
    var m;
    var s = String(text == null ? '' : text);
    while ((m = re.exec(s)) !== null) {
      var t = m[0];
      if (/^[A-Za-z0-9_]/.test(t)) {
        out.push(t.toLowerCase());
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

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function hashEmbed(text, dim) {
    if (mem && mem.hashEmbed) return mem.hashEmbed(text, dim || 256);
    dim = dim || 256;
    var v = new Float32Array(dim);
    var toks = tokenize(text);
    if (!toks.length) return v;
    var tf = new Map();
    for (var i = 0; i < toks.length; i++) tf.set(toks[i], (tf.get(toks[i]) || 0) + 1);
    tf.forEach(function (c, t) {
      var h = 2166136261;
      for (var k = 0; k < t.length; k++) { h ^= t.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
      h = h >>> 0;
      var sign = ((h >>> 31) & 1) ? -1 : 1;
      v[h % dim] += (1 + Math.log(c)) * sign;
    });
    var n = 0;
    for (var j = 0; j < dim; j++) n += v[j] * v[j];
    n = Math.sqrt(n);
    if (n > 0) for (var q = 0; q < dim; q++) v[q] /= n;
    return v;
  }

  // ── 查询扩展（与 memory-layer.expandQueries 同构的精简版）────────────────
  var STOP = {};
  ['的', '是', '在', '了', '和', '与', '或', '就', '也', '都', 'a', 'an', 'the', 'is',
    'are', 'was', 'were', 'be', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'what', 'how', 'why', 'when', 'which'].forEach(function (w) { STOP[w] = true; });

  function expandQueries(query) {
    query = String(query == null ? '' : query).trim();
    if (!query) return [];
    var seen = {}; seen[query.toLowerCase()] = true;
    var out = [];
    function add(s) {
      s = String(s || '').trim();
      if (!s || s.length < 3) return;
      var k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = true; out.push(s);
    }
    var keywords = tokenize(query).filter(function (w) { return !STOP[w.toLowerCase()] && w.length > 1; });
    if (keywords.length >= 2) add(keywords.join(' '));
    var re = /["'“”「」『』《》]([^"'“”「」『』《》]+)["'“”「」『』《》]/g, m;
    while ((m = re.exec(query)) !== null) if (m[1] && m[1].length > 2) add(m[1]);
    query.split(/[,，;；、。！？!?\s]+/).forEach(function (seg) { if (seg.length > 5) add(seg); });
    return out.slice(0, 4);
  }

  // ── BM25 ────────────────────────────────────────────────────────────────
  function buildIndex(chunks) {
    var docs = new Map();   // chunkId -> {tf, len}
    var df = new Map();
    var totalLen = 0;
    chunks.forEach(function (c) {
      var toks = tokenize(c.text);
      var tf = new Map();
      toks.forEach(function (t) { tf.set(t, (tf.get(t) || 0) + 1); });
      docs.set(c.id, { tf: tf, len: toks.length || 1 });
      totalLen += toks.length || 1;
      var seenTerm = new Set();
      tf.forEach(function (_, t) { if (!seenTerm.has(t)) { seenTerm.add(t); df.set(t, (df.get(t) || 0) + 1); } });
    });
    return { docs: docs, df: df, N: chunks.length, avgdl: chunks.length ? totalLen / chunks.length : 1 };
  }

  function bm25(queryTf, doc, index) {
    if (!doc || !doc.len || !index.N) return 0;
    var score = 0;
    queryTf.forEach(function (_, term) {
      var d = index.df.get(term) || 0;
      if (!d) return;
      var f = doc.tf.get(term) || 0;
      if (!f) return;
      var idf = Math.log(1 + (index.N - d + 0.5) / (d + 0.5));
      score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgdl)));
    });
    return score;
  }

  function sortDesc(list) { list.sort(function (a, b) { return b.score - a.score; }); return list; }

  function rrfFuse(lists) {
    var fused = new Map();
    lists.forEach(function (list) {
      list.forEach(function (r, i) {
        fused.set(r.id, (fused.get(r.id) || 0) + 1 / (RRF_K + i + 1));
      });
    });
    return fused;
  }

  /**
   * search(kbId, query, opts)
   *   opts.limit     TopK（默认 6）
   *   opts.expand    查询扩展（默认 true）
   *   opts.threshold RRF 分数阈值（可选）
   *   opts.withDisabled  true 时包含 superseded 文档（仅供健康面板查看，问答默认排除）
   * 返回 [{ chunkId, docId, seq, text, excerpt, score, title, heading, docStatus }]
   */
  function search(kbId, query, opts) {
    opts = opts || {};
    var limit = opts.limit || 6;
    var loader = opts.withDisabled
      ? store.chunks._all().then(function (all) {
          return all.filter(function (c) {
            if (c.kbId !== kbId || c.enabled === false) return false;
            var d = store.documents.get(c.docId);
            return !!d;   // include superseded when explicitly requested
          });
        })
      : store.chunks.listByKb(kbId);

    return loader.then(function (chunks) {
      if (!chunks.length || !String(query || '').trim()) return [];
      var index = buildIndex(chunks);
      var queries = [String(query)];
      if (opts.expand !== false) queries = queries.concat(expandQueries(query));
      // chunk 文本可能不含 vec（被禁用后重开等），按需补 embed
      var lists = [];
      queries.forEach(function (q) {
        // BM25 路
        var qtf = new Map();
        tokenize(q).forEach(function (t) { qtf.set(t, (qtf.get(t) || 0) + 1); });
        if (qtf.size) {
          var kw = [];
          chunks.forEach(function (c) {
            var sc = bm25(qtf, index.docs.get(c.id), index);
            if (sc > 0) kw.push({ id: c.id, score: sc });
          });
          if (kw.length) { sortDesc(kw); lists.push(kw); }
        }
        // 向量路
        var qv = hashEmbed(q, chunks[0].dim || 256);
        var vs = [];
        chunks.forEach(function (c) {
          if (!c.vec || !c.vec.length) return;
          var cs = cosine(qv, c.vec);
          if (cs > 0) vs.push({ id: c.id, score: cs });
        });
        if (vs.length) { sortDesc(vs); lists.push(vs); }
      });
      if (!lists.length) return [];

      var byId = new Map();
      chunks.forEach(function (c) { byId.set(c.id, c); });

      var scored;
      if (lists.length === 1) {
        // 单模去重保留原始分
        var best = new Map();
        lists[0].forEach(function (r) {
          var cur = best.get(r.id);
          if (!cur || r.score > cur.score) best.set(r.id, r);
        });
        scored = Array.from(best.values());
      } else {
        scored = [];
        rrfFuse(lists).forEach(function (score, id) { scored.push({ id: id, score: score }); });
      }
      // 确定性排序：分数 → id
      scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.id < b.id ? -1 : 1;
      });
      if (opts.threshold > 0) scored = scored.filter(function (r) { return r.score >= opts.threshold; });
      if (scored.length > limit) scored = scored.slice(0, limit);

      return scored.map(function (r) {
        var c = byId.get(r.id);
        if (!c) return null;
        var doc = store.documents.get(c.docId);
        return {
          chunkId: c.id,
          docId: c.docId,
          seq: c.seq,
          text: c.text,
          excerpt: clip(c.text, 400),
          score: r.score,
          title: doc ? doc.title : '',
          heading: c.heading || '',
          docStatus: doc ? doc.status : '',
          ownerId: doc ? doc.ownerId : ''
        };
      }).filter(Boolean);
    });
  }

  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join('') + '…' : s;
  }

  /**
   * similarChunks(kbId, excludeDocId, opts) — 近重复检测的相似分块检索。
   * 对齐 Yuheng retriever/postgres/similar.go 的语义：对 subject 文档的每个
   * chunk 找其他文档的 top-N 近邻，返回 [{subjectChunkId, relatedChunkId,
   * relatedDocId, score}]。纯前端实现为全量 cosine 扫描（数千块毫秒级）。
   */
  function similarChunks(kbId, subjectDocId, opts) {
    opts = opts || {};
    var minScore = opts.minScore != null ? opts.minScore : 0.9;
    var perChunk = Math.min(opts.perChunk || 5, 20);
    var maxSubject = opts.maxSubjectRows || 5000;
    return store.chunks._all().then(function (all) {
      // 比较语料：同库、启用、非 subject 文档（含 superseded 的也参与比对 ——
      // 过期文档正是要被抓出来的对象）
      var subject = [];
      var others = [];
      all.forEach(function (c) {
        if (c.kbId !== kbId || c.enabled === false) return;
        if (c.text && Array.from(c.text).length < 40) return;   // minPassageRunes
        if (c.docId === subjectDocId) subject.push(c);
        else others.push(c);
      });
      if (!subject.length || !others.length) return [];
      if (subject.length > maxSubject) subject = subject.slice(0, maxSubject);
      var out = [];
      subject.forEach(function (s) {
        if (!s.vec || !s.vec.length) return;
        var near = [];
        others.forEach(function (o) {
          if (!o.vec || !o.vec.length) return;
          var sc = cosine(s.vec, o.vec);
          if (sc >= minScore) near.push({ o: o, score: sc });
        });
        near.sort(function (a, b) { return b.score - a.score || (a.o.id < b.o.id ? -1 : 1); });
        near.slice(0, perChunk).forEach(function (n) {
          out.push({ subjectChunkId: s.id, relatedChunkId: n.o.id, relatedDocId: n.o.docId, score: n.score });
        });
      });
      return out;
    });
  }

  return {
    search: search,
    similarChunks: similarChunks,
    splitChunksText: tokenize,
    hashEmbed: hashEmbed,
    expandQueries: expandQueries,
    buildIndex: buildIndex,
    bm25: bm25,
    clip: clip
  };
});
