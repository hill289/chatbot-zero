/*!
 * kb-ingest.js — 文档摄取（Ingest：解析文本 → 分块 → 向量化 → 入库）
 * =============================================================================
 * 摄取是知识库的入口。对齐 Yuheng 的 knowledge_process（chunker + 向量索引），
 * 改造为纯前端：
 *
 *   1. splitChunks()   标题/段落感知分块：目标 ~500 字、80 字重叠；
 *                      短于 MIN_CHUNK_RUNES(40) 的块丢弃
 *                      （对齐 duplicate.go duplicateMinPassageRunes=40：
 *                       短标题/页脚不算证据，避免模板文档互相误报）；
 *   2. embedChunk()    默认 hashEmbed（memory-layer 同源），可注入神经嵌入；
 *   3. ingest()        写 documents（内容寻址幂等，内容变则 version+1 并
 *                      lastVouchedAt=now 即「作者背书」）→ replaceForDoc 分块
 *                      → 返回 {doc, changed}；
 *   4. onIngest 回调   由 kb-bootstrap 挂上：changed 时触发知识健康检查
 *                      （对齐 Yuheng「文档更新时与库内其他文档比对」）。
 *
 * UMD：浏览器挂 globalThis.KBIngest，Node 下 module.exports（测试直接 require）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  function safeRequire(p) { try { return require(p); } catch (_) { return null; } }
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js'), memory: safeRequire('../memory/memory-layer.js') };
  } else {
    deps = { store: root.KBStore, memory: root.AgentMemory };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBIngest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var MIN_CHUNK_RUNES = 40;      // 短于 40 字的块不入库（模板碎片不算证据）
  var TARGET_CHARS = 500;        // 目标分块长度
  var OVERLAP_CHARS = 80;        // 相邻分块重叠
  var MAX_CHUNK_CHARS = 1200;    // 单块硬上限（超长段落强制切）

  var store = deps.store;
  var memory = deps.memory;
  var onIngest = null;   // kb-bootstrap 挂接：async ({doc, changed}) => {}

  function runes(s) { return Array.from(String(s == null ? '' : s)).length; }

  // ── 分词 / 向量化（与 memory-layer 同源，保证检索一致）─────────────────
  function embedderFor(opts) {
    if (opts && typeof opts.embedder === 'function') return opts.embedder;
    var dim = (opts && opts.dim) || 256;
    if (memory && memory.hashEmbed) return function (t) { return memory.hashEmbed(t, dim); };
    // 兜底（memory-layer 未加载时的极简 hash 向量，保证模块独立可用）
    return function (t) { return fallbackEmbed(t, dim); };
  }
  function fallbackEmbed(text, dim) {
    var v = new Float32Array(dim);
    var toks = String(text || '').match(/[a-z0-9_]+|[\u3400-\u9fff]/gi) || [];
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i].toLowerCase();
      var h = 2166136261;
      for (var c = 0; c < tk.length; c++) { h ^= tk.charCodeAt(c); h = Math.imul(h, 16777619) >>> 0; }
      v[h % dim] += 1;
    }
    var n = 0;
    for (var j = 0; j < dim; j++) n += v[j] * v[j];
    n = Math.sqrt(n);
    if (n > 0) for (var k = 0; k < dim; k++) v[k] /= n;
    return v;
  }

  // ── 分块：标题/段落感知 ──────────────────────────────────────────────────
  // 规则：按空行/换行切成段落；段落带「最近标题」上下文；逐段累积到 TARGET_CHARS
  // 成块，相邻块尾部保留 OVERLAP_CHARS 重叠；单段超 MAX 强制滑窗切。
  function splitChunks(text) {
    text = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (!text.trim()) return [];
    var lines = text.split('\n');
    var paras = [];
    var cur = [];
    var heading = '';
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var h = /^#{1,6}\s+(.*)/.exec(ln) || /^([一二三四五六七八九十]+[、.．])\s*(.*)/.exec(ln);
      if (h) heading = String(h[1] || h[2] || '').replace(/^#+\s*/, '').trim();
      if (ln.trim() === '') {
        if (cur.length) { paras.push(cur.join('\n')); cur = []; }
      } else {
        cur.push(ln);
        // 单行超长直接成段，避免整段超限
        if (ln.length > MAX_CHUNK_CHARS) { paras.push(cur.join('\n')); cur = []; }
      }
    }
    if (cur.length) paras.push(cur.join('\n'));

    var chunks = [];
    var buf = '';
    var bufHeading = '';
    function flush(force) {
      if (!buf.trim()) return;
      if (runes(buf) < MIN_CHUNK_RUNES && !force) {
        buf = '';   // 丢弃碎片
        return;
      }
      chunks.push({ heading: bufHeading, text: buf.trim() });
      // 重叠：保留尾部 OVERLAP_CHARS
      var arr = Array.from(buf);
      buf = arr.length > OVERLAP_CHARS ? arr.slice(arr.length - OVERLAP_CHARS).join('') : '';
      bufHeading = bufHeading;
    }
    for (var p = 0; p < paras.length; p++) {
      var para = paras[p];
      if (runes(para) >= MAX_CHUNK_CHARS) {
        flush(true);
        // 滑窗切超长段
        var arr = Array.from(para);
        for (var s = 0; s < arr.length; s += (TARGET_CHARS - OVERLAP_CHARS)) {
          var piece = arr.slice(s, s + TARGET_CHARS).join('');
          if (runes(piece) >= MIN_CHUNK_RUNES) chunks.push({ heading: heading, text: piece.trim() });
          if (s + TARGET_CHARS >= arr.length) break;
        }
        buf = '';
        continue;
      }
      if (!buf) bufHeading = heading;
      if (runes(buf) + runes(para) > TARGET_CHARS && runes(buf) >= MIN_CHUNK_RUNES) flush(false);
      buf = buf ? (buf + '\n' + para) : para;
      if (runes(buf) >= TARGET_CHARS) flush(false);
    }
    flush(true);
    // 去空/过短（flush(true) 的强制块仍需过滤碎片）
    return chunks.filter(function (c) { return c.text && runes(c.text) >= MIN_CHUNK_RUNES; });
  }

  // ── 摄取主流程 ───────────────────────────────────────────────────────────
  /**
   * ingest(opts)
   *   opts.kbId     必填
   *   opts.title    文档标题
   *   opts.text     正文（已解析的纯文本/Markdown）
   *   opts.sourceKey 同源幂等键（路径/URL），缺省用 title
   *   opts.sourceType 'file' | 'url' | 'text'
   *   opts.ownerId  负责人（可选，缺省用 kb.defaultOwnerId）
   *   opts.tags     标签
   *   opts.embedder / opts.dim  向量器覆盖
   *   opts.reindex  true=强制重建分块（即使内容未变）
   *   opts.skipHealth true=不触发 onIngest 健康检查（批量同步时由调用方
   *                   统一调度，避免逐篇触发检测器的风暴）
   * 返回 { doc, changed, chunkCount }
   */
  function ingest(opts) {
    opts = opts || {};
    if (!opts.kbId) return Promise.reject(new Error('ingest 需要 kbId'));
    var kb = store.kbs.get(opts.kbId);
    if (!kb) return Promise.reject(new Error('知识库不存在: ' + opts.kbId));
    if (opts.ownerId === undefined && kb.defaultOwnerId) opts.ownerId = kb.defaultOwnerId;

    var embed = embedderFor(opts);
    var dim = opts.dim || 256;

    return store.documents.upsert({
      kbId: opts.kbId,
      title: opts.title,
      sourceKey: opts.sourceKey,
      sourceType: opts.sourceType,
      sourcePath: opts.sourcePath,
      ownerId: opts.ownerId,
      text: opts.text,
      tags: opts.tags
    }).then(function (r) {
      var doc = r.doc;
      var changed = r.changed || opts.reindex;
      if (!changed && !opts.forceChunks) {
        return store.chunks.listByDoc(doc.id).then(function (list) {
          return { doc: doc, changed: false, chunkCount: list.length };
        });
      }
      var parts = splitChunks(doc.text);
      // 异步向量化（逐块 embed；hashEmbed 同步但保持统一 Promise 形状）
      return Promise.all(parts.map(function (c) {
        return Promise.resolve(embed(c.text)).then(function (vec) {
          return { text: c.text, heading: c.heading, vec: toF32(vec), dim: dim };
        });
      })).then(function (list) {
        return store.chunks.replaceForDoc(doc.id, doc.kbId, list);
      }).then(function (list) {
        return { doc: doc, changed: true, chunkCount: list.length };
      });
    }).then(function (out) {
      if (onIngest && out.changed && !opts.skipHealth) {
        try {
          var p = onIngest({ doc: out.doc, kbId: out.doc.kbId });
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (_) { /* 健康检查失败不影响摄取 */ }
      }
      return out;
    });
  }

  function toF32(v) {
    if (v instanceof Float32Array) return v;
    if (Array.isArray(v)) return Float32Array.from(v);
    return new Float32Array(0);
  }

  // 文本入口便捷方法：直接喂 URL/粘贴文本
  function ingestText(kbId, title, text, extra) {
    return ingest(Object.assign({ kbId: kbId, title: title, text: text, sourceType: 'text' }, extra || {}));
  }

  return {
    splitChunks: splitChunks,
    ingest: ingest,
    ingestText: ingestText,
    embedderFor: embedderFor,
    MIN_CHUNK_RUNES: MIN_CHUNK_RUNES,
    TARGET_CHARS: TARGET_CHARS,
    OVERLAP_CHARS: OVERLAP_CHARS,
    // kb-bootstrap 挂接健康检查触发器
    setOnIngest: function (fn) { onIngest = fn; },
    _deps: deps
  };
});
