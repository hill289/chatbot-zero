/*!
 * kb-health/divergence.js — 文本比对（区分「复制」与「有出入的近似」）
 * =============================================================================
 * 忠实移植 Yuheng internal/application/service/findings/divergence.go。
 *
 * 为什么向量不够：嵌入模型分不出「15 天假」和「10 天假」——同一段话改一个
 * 数字，cosine 仍高达 0.97，但两者的处理动作完全相反：纯复制是冗余
 * （该做链接），有出入的近似是分歧（其中一方可能过期，删错就删掉了对的）。
 * 因此每对候选分块都要做**文本级比对**：
 *
 *   1. normalizeSpace        空白折叠（换行缩进是排版不是内容；摘录同规则
 *                            归一，保证偏移量在两者间一致）；
 *   2. diffRunes             Myers 最短编辑脚本（按字符，maxEdits 保护，
 *                            超限视为「重写」而非「编辑」）；
 *   3. comparePassages       锚点对齐：只承认两段共享 ≥8 字长公共串【之间】
 *                            （或共同开头/结尾）的差异 —— 容忍「同一段被在
 *                            不同位置切块」造成的边缘差异；
 *   4. excerptAround         以第一处差异为中心截取摘录（前后留 context，
 *                            总长上限），供证据展示。
 *
 * UMD：浏览器挂 globalThis.KBDiv，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBDiv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ANCHOR_RUNES = 8;        // divergenceAnchorRunes：最短共享锚点
  var MAX_EDITS = 600;         // divergenceMaxEdits：超限视为重写
  var EXCERPT_RUNES = 300;     // duplicateExcerptRunes
  var EXCERPT_LEAD = 60;       // duplicateExcerptLead：差异点前保留

  // ── 空白归一 ─────────────────────────────────────────────────────────────
  function normalizeSpace(s) {
    return String(s == null ? '' : s).split(/\s+/).filter(Boolean).join(' ');
  }

  // ── Myers 最短编辑脚本（按字符；超 maxEdits 返回 null）──────────────────
  // 返回 [{kind:'='|'-'|'+', aFrom,aTo, bFrom,bTo}]（a→b 的编辑脚本）。
  function diffRunes(a, b, maxEdits) {
    var n = a.length, m = b.length;
    if (n === 0 && m === 0) return [];
    maxEdits = maxEdits || MAX_EDITS;
    var limit = Math.min(n + m, maxEdits);
    var off = limit + 1;
    var v = new Int32Array(2 * limit + 3);
    var trace = [];
    for (var d = 0; d <= limit; d++) {
      trace.push(Int32Array.from(v.subarray(off - d - 1, off + d + 2)));
      for (var k = -d; k <= d; k += 2) {
        var x;
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        var y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) return backtrack(trace, n, m);
      }
    }
    return null;   // 编辑数超限 → 调用方按「重写」处理
  }

  // 与 Go backtrack 逐行对应：trace[d] 为第 d 轮开始时的 v 快照，
  // 索引 k+d+1 对应对角线 k ∈ [-d-1, d+1]。
  function backtrack(trace, n, m) {
    var rev = [];
    function push(kind, aFrom, aTo, bFrom, bTo) {
      var last = rev.length - 1;
      if (last >= 0 && rev[last].kind === kind &&
        rev[last].aFrom === aTo && rev[last].bFrom === bTo) {
        rev[last].aFrom = aFrom; rev[last].bFrom = bFrom;   // 向后合并同类操作
        return;
      }
      rev.push({ kind: kind, aFrom: aFrom, aTo: aTo, bFrom: bFrom, bTo: bTo });
    }
    var x = n, y = m;
    for (var d = trace.length - 1; d >= 0; d--) {
      var saved = trace[d];
      var at = function (kk) { return saved[kk + d + 1]; };
      var k = x - y;
      var prevK = k - 1;
      if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
      // d = 0 是起点：at(1) 为 0，prevY 为 -1，下方公共串回溯到 (0,0)
      var prevX = at(prevK);
      var prevY = prevX - prevK;
      var run = Math.min(x - prevX, y - prevY);
      if (run > 0) {
        push('=', x - run, x, y - run, y);
        x -= run; y -= run;
      }
      if (d === 0) break;
      if (x === prevX) push('+', x, x, y - 1, y);
      else push('-', x - 1, x, y, y);
      x = prevX; y = prevY;
    }
    return rev.reverse();
  }

  // ── 公共边判定 ───────────────────────────────────────────────────────────
  function atCommonEdge(op, lenA, lenB) {
    return (op.aFrom === 0 && op.bFrom === 0) || (op.aTo === lenA && op.bTo === lenB);
  }

  function commonPrefix(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /**
   * comparePassages(subject, related) — 两段（向量已认定相似的）文本比对。
   * 返回 { differs, subjectAt, relatedAt }（At 为归一化文本上的字符偏移）。
   */
  function comparePassages(subject, related) {
    var a = Array.from(normalizeSpace(subject));
    var b = Array.from(normalizeSpace(related));
    if (a.join('') === b.join('')) return { differs: false, subjectAt: 0, relatedAt: 0 };
    var ops = diffRunes(a, b, MAX_EDITS);
    if (!ops) {
      // 编辑数超限：重写 → 以公共前缀处为「第一处差异」
      var at = commonPrefix(a, b);
      return { differs: true, subjectAt: at, relatedAt: at };
    }
    // 找锚点：长公共串（≥ ANCHOR_RUNES）或共同边上的公共串
    var first = -1, last = -1, hasLong = false;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.kind !== '=') continue;
      var runLen = op.aTo - op.aFrom;
      if (runLen >= ANCHOR_RUNES) hasLong = true;
      else if (!atCommonEdge(op, a.length, b.length)) continue;
      if (first < 0) first = i;
      last = i;
    }
    // 没有值得对齐的公共串 → 两段是「换说法」，按有出入处理
    if (!hasLong) return { differs: true, subjectAt: 0, relatedAt: 0 };
    // 锚点【之间】的非公共操作 = 共享文本内部的差异
    for (var j = first + 1; j < last; j++) {
      if (ops[j].kind !== '=') {
        return { differs: true, subjectAt: ops[j].aFrom, relatedAt: ops[j].bFrom };
      }
    }
    return { differs: false, subjectAt: 0, relatedAt: 0 };
  }

  /**
   * excerptAround(s, at) — 以 at（归一化文本偏移）为中心截取摘录。
   * 与 Yuheng excerptAround 同规则：总长 ≤ EXCERPT_RUNES，差异点前留
   * EXCERPT_LEAD，两端用 … 标注截断。
   */
  function excerptAround(s, at) {
    var norm = normalizeSpace(s);
    var runes = Array.from(norm);
    if (runes.length <= EXCERPT_RUNES) return norm;
    at = Math.max(0, Math.min(at || 0, runes.length - 1));
    var start = Math.max(0, at - EXCERPT_LEAD);
    var end = Math.min(runes.length, start + EXCERPT_RUNES);
    start = Math.max(0, end - EXCERPT_RUNES);
    var body = runes.slice(start, end).join('');
    return (start > 0 ? '…' : '') + body + (end < runes.length ? '…' : '');
  }

  function excerpt(s) {
    var norm = normalizeSpace(s);
    var runes = Array.from(norm);
    if (runes.length <= EXCERPT_RUNES) return norm;
    return runes.slice(0, EXCERPT_RUNES - 1).join('') + '…';
  }

  /**
   * diffSegments(a, b) — 供 UI 差异高亮的分段结构：
   * 返回 [{type:'eq'|'del'|'ins', text}]（按 a 视角输出，del/a 独有，
   * ins/b 独有；UI 侧把 del 渲成红色删除、ins 渲成绿色插入，两边并排）。
   * 超长文本回退为「整体替换」单段（避免 UI 卡死）。
   */
  function diffSegments(a, b) {
    var ra = Array.from(normalizeSpace(a));
    var rb = Array.from(normalizeSpace(b));
    var ops = diffRunes(ra, rb, 4000);
    if (!ops) {
      return [
        { type: 'del', text: ra.join('') },
        { type: 'ins', text: rb.join('') }
      ];
    }
    var out = [];
    ops.forEach(function (op) {
      if (op.kind === '=') out.push({ type: 'eq', text: ra.slice(op.aFrom, op.aTo).join('') });
      else if (op.kind === '-') out.push({ type: 'del', text: ra.slice(op.aFrom, op.aTo).join('') });
      else out.push({ type: 'ins', text: rb.slice(op.bFrom, op.bTo).join('') });
    });
    return out;
  }

  return {
    normalizeSpace: normalizeSpace,
    diffRunes: diffRunes,
    comparePassages: comparePassages,
    excerptAround: excerptAround,
    excerpt: excerpt,
    diffSegments: diffSegments,
    ANCHOR_RUNES: ANCHOR_RUNES,
    MAX_EDITS: MAX_EDITS
  };
});
