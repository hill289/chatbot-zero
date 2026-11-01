/*!
 * kb-health/duplicate.js — 近重复检测器（duplicate / divergent）
 * =============================================================================
 * 忠实移植 Yuheng findings/duplicate.go + runner 的候选生成语义：
 *
 *   1. 触发：某文档新增/更新（ingest 后）；
 *   2. 召回：对该文档每个分块（≥40字）在同库其他文档中找 top-5 近邻
 *      （cosine ≥ minScore）——由 kb-search.similarChunks 提供；
 *   3. 【双向对称】对每个命中的对方文档，再从它的侧跑一次近邻搜索，
 *      取并集（去重、保最高分）——NN 非对称，单向结果会因触发方不同而
 *      漂移，导致指纹不稳定、被忽略的发现无故重开（Yuheng 注释明确警告）；
 *   4. 文本比对：每对分块过 divergence.comparePassages ——
 *      有出入 → divergent（warning，一方可能过期，找最久没背书的负责人）；
 *      完全一致 → duplicate（overlap ≥ 0.5 升 warning，找最近改动的负责人）；
 *   5. 证据：≤3 对分块摘录（差异优先、去重选对），带 overlapRatio；
 *   6. 指纹：PairFingerprint(type, kbId, docA, docB)（对序不敏感）；
 *      evidenceHash 基于【文本内容】而非 chunk id（重新分块不改词 →
 *      忽略状态不被无谓重开）。
 *
 * UMD：浏览器挂 globalThis.KBDuplicate，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('../kb-store.js'), search: require('../kb-search.js'), div: require('./divergence.js') };
  } else {
    deps = { store: root.KBStore, search: root.KBSearch, div: root.KBDiv };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBDuplicate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var search = deps.search;
  var div = deps.div;

  var NAME = 'duplicate';
  var MIN_SCORE = 0.9;             // 两段计为同一文本的最低 cosine
  var NEIGHBOURS = 5;              // duplicateNeighbours
  var MAX_RELATED = 20;            // duplicateMaxRelated
  var MIN_PASSAGE_RUNES = 40;      // duplicateMinPassageRunes
  var WARN_OVERLAP = 0.5;          // duplicateWarningOverlap
  var EVIDENCE_PAIRS = 3;          // duplicateEvidencePairs

  // ── 稳定工具 ─────────────────────────────────────────────────────────────
  function fnv1a(str, seed) {
    var h = (seed == null ? 2166136261 : seed) >>> 0;
    str = String(str == null ? '' : str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function stableId(str) {
    return fnv1a(str, 2166136261).toString(16).padStart(8, '0')
      + fnv1a(str, 0x01000193).toString(16).padStart(8, '0');
  }
  // PairFingerprint：对序不敏感（A→B 与 B→A 同指纹）
  function pairFingerprint(type, kbId, aId, bId) {
    var lo = aId < bId ? aId : bId, hi = aId < bId ? bId : aId;
    return stableId(['pair', type, kbId, lo, hi].join('|'));
  }
  function contentHash(s) { return stableId(String(s == null ? '' : s)); }

  /**
   * detect(kbId, subjectDocId) — 跑一遍近重复检测，返回候选数组。
   * 候选形状对齐 runner 的 Candidate：
   *   { type, severity, assign, subjectDocId, relatedDocId, score,
   *     fingerprint, details: { evidence, overlapRatio, evidenceHash } }
   * 不抛错（检测器不可用返回 []，由 Runner 记日志）。
   */
  function detect(kbId, subjectDocId) {
    var subjectDoc = store.documents.get(subjectDocId);
    if (!subjectDoc || subjectDoc.kbId !== kbId) return Promise.resolve([]);
    if (subjectDoc.status === store.DOC_STATUS.SUPERSEDED) {
      // 已被取代的文档不再主动比对（它已经是输家；新旧比对由新版触发时完成）
      return Promise.resolve([]);
    }
    return store.chunks.listByDoc(subjectDocId).then(function (subjectChunks) {
      subjectChunks = subjectChunks.filter(function (c) {
        return c.enabled !== false && Array.from(c.text || '').length >= MIN_PASSAGE_RUNES;
      });
      if (!subjectChunks.length) return [];
      // 2) 正向近邻
      return search.similarChunks(kbId, subjectDocId, { minScore: MIN_SCORE, perChunk: NEIGHBOURS })
        .then(function (forward) {
          // 按对方文档分组，保每文档最高分
          var byRelated = {};
          var best = {};
          forward.forEach(function (p) {
            if (!p.relatedDocId || p.relatedDocId === subjectDocId) return;
            (byRelated[p.relatedDocId] = byRelated[p.relatedDocId] || []).push(p);
            if (!best[p.relatedDocId] || p.score > best[p.relatedDocId]) best[p.relatedDocId] = p.score;
          });
          var relatedIds = Object.keys(byRelated).sort(function (a, b) {
            if (best[a] !== best[b]) return best[b] - best[a];
            return a < b ? -1 : 1;
          }).slice(0, MAX_RELATED);
          if (!relatedIds.length) return [];

          // 3) 每个对方文档再跑反向近邻，取并集
          return relatedIds.reduce(function (chain, otherId) {
            return chain.then(function (acc) {
              return search.similarChunks(kbId, otherId, { minScore: MIN_SCORE, perChunk: NEIGHBOURS })
                .then(function (backward) {
                  return store.chunks.listByDoc(otherId).then(function (otherChunks) {
                    var otherMap = {};
                    otherChunks.forEach(function (c) { otherMap[c.id] = c; });
                    var subjectMap = {};
                    subjectChunks.forEach(function (c) { subjectMap[c.id] = c; });
                    var pairs = unionPairs(subjectMap, otherMap, byRelated[otherId] || [], backward, subjectDocId);
                    if (pairs.length) acc.push({ otherId: otherId, subject: subjectMap, other: otherMap, pairs: pairs });
                    return acc;
                  });
                });
            });
          }, Promise.resolve([]));
        })
        .then(function (groups) {
          return groups.map(function (g) {
            return buildDuplicate(kbId, subjectDocId, g.subject, g.otherId, g.other, g.pairs);
          });
        });
    }).catch(function () { return []; });
  }

  /**
   * unionPairs — 正反两向的分块对并集（只留两侧都存在的分块，重复对保最高分）。
   * 对齐 duplicate.go unionPairs。
   */
  function unionPairs(subject, other, forward, backward, subjectDocId) {
    var scores = {};
    function add(s, r, score) {
      if (!subject[s] || !other[r]) return;
      var key = s + '\u0000' + r;
      if (scores[key] === undefined || score > scores[key]) scores[key] = score;
    }
    (forward || []).forEach(function (p) { add(p.subjectChunkId, p.relatedChunkId, p.score); });
    (backward || []).forEach(function (p) {
      // 反向结果以 other 为 subject：翻转回本侧视角
      if (p.relatedDocId === subjectDocId) add(p.relatedChunkId, p.subjectChunkId, p.score);
      else if (p.subjectChunkId && subject[p.relatedChunkId] && other[p.subjectChunkId]) {
        add(p.relatedChunkId, p.subjectChunkId, p.score);
      }
    });
    var out = Object.keys(scores).map(function (key) {
      var parts = key.split('\u0000');
      return { subject: parts[0], related: parts[1], score: scores[key] };
    });
    out.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
      return a.related < b.related ? -1 : 1;
    });
    return out;
  }

  /**
   * buildDuplicate — 配对 → 候选。方向取「更被对方包含」的一方为 subject
   * （overlap 大者，平手比 docId）——只依赖配对结果，触发方无关。
   */
  function buildDuplicate(kbId, aId, a, bId, b, pairs) {
    var matchedA = {}, matchedB = {};
    pairs.forEach(function (p) { matchedA[p.subject] = true; matchedB[p.related] = true; });
    var overlapA = Object.keys(matchedA).length / Math.max(1, Object.keys(a).length);
    var overlapB = Object.keys(matchedB).length / Math.max(1, Object.keys(b).length);

    var subjectDocId = aId, relatedDocId = bId, subject = a, other = b;
    var overlap = overlapA, flipped = false;
    if (overlapB > overlapA || (overlapB === overlapA && bId < aId)) {
      subjectDocId = bId; relatedDocId = aId;
      subject = b; other = a; overlap = overlapB; flipped = true;
    }

    // 逐对文本比对（按 subject 方向）
    var oriented = pairs.map(function (p) {
      var s = flipped ? p.related : p.subject;
      var r = flipped ? p.subject : p.related;
      var cmp = div.comparePassages(subject[s] ? subject[s].text : '', other[r] ? other[r].text : '');
      return { subject: s, related: r, score: p.score, cmp: cmp };
    });
    var divergent = oriented.some(function (p) { return p.cmp.differs; });

    // 证据：差异对优先 → 不同对优先 → 同对不重复
    var evidence = [];
    var usedS = {}, usedR = {};
    function pick(requireDistinct, differing) {
      for (var i = 0; i < oriented.length && evidence.length < EVIDENCE_PAIRS; i++) {
        var p = oriented[i];
        if (differing && !p.cmp.differs) continue;
        if (usedS[p.subject] && usedR[p.related]) continue;
        if (requireDistinct && (usedS[p.subject] || usedR[p.related])) continue;
        usedS[p.subject] = usedR[p.related] = true;
        var sText = subject[p.subject] ? subject[p.subject].text : '';
        var rText = other[p.related] ? other[p.related].text : '';
        var ev = {
          subjectChunkId: p.subject, relatedChunkId: p.related,
          score: p.score, differs: !!p.cmp.differs,
          subjectExcerpt: p.cmp.differs ? div.excerptAround(sText, p.cmp.subjectAt) : div.excerpt(sText),
          relatedExcerpt: p.cmp.differs ? div.excerptAround(rText, p.cmp.relatedAt) : div.excerpt(rText)
        };
        evidence.push(ev);
      }
    }
    if (divergent) { pick(true, true); pick(false, true); }
    pick(true, false); pick(false, false);

    var type = store.FINDING.DUPLICATE;
    var severity = store.FINDING.INFO;
    var assign = 'latest_hand';
    if (divergent) {
      type = store.FINDING.DIVERGENT;
      severity = store.FINDING.WARNING;
      assign = 'stalest_owner';
    } else if (overlap >= WARN_OVERLAP) {
      severity = store.FINDING.WARNING;
    }

    return {
      type: type,
      severity: severity,
      assign: assign,
      subjectDocId: subjectDocId,
      relatedDocId: relatedDocId,
      score: pairs[0].score,
      fingerprint: pairFingerprint(type, kbId, aId, bId),
      details: {
        evidence: evidence,
        overlapRatio: Math.round(overlap * 1000) / 1000,
        evidenceHash: evidenceHash(aId, a, bId, b, pairs)
      }
    };
  }

  /**
   * evidenceHash — 基于【配对文本内容】（按 docId 序排列，与方向无关）。
   * 重新分块/重排不改词 → 哈希不变 → 忽略状态稳定。
   */
  function evidenceHash(aId, a, bId, b, pairs) {
    var lines = pairs.map(function (p) {
      var left = contentHash(a[p.subject] ? a[p.subject].text : '');
      var right = contentHash(b[p.related] ? b[p.related].text : '');
      return bId < aId ? (right + '|' + left) : (left + '|' + right);
    }).sort();
    var dedup = lines.filter(function (s, i) { return i === 0 || s !== lines[i - 1]; });
    return stableId(dedup.join('\n'));
  }

  return {
    NAME: NAME,
    detect: detect,
    pairFingerprint: pairFingerprint,
    unionPairs: unionPairs,
    MIN_SCORE: MIN_SCORE,
    MIN_PASSAGE_RUNES: MIN_PASSAGE_RUNES
  };
});
