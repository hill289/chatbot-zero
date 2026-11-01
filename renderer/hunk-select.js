/*!
 * hunk-select.js — 变更块级接受（纯逻辑，无 DOM / 无 FS）
 * =============================================================================
 * 解决的问题：同步只能「整份接受」。一份 400 行改动里只要有 3 处不对，用户只剩
 * 「全要」和「全不要」，于是理性选择是「全同步 + 回 IDE 手改」——审核退化成弹窗。
 *
 * 本模块只做三件事，不碰任何 IO，便于单测（见 hunk-select.test.js）：
 *   1) diffLines / buildRows：行级差分（与 15-pgpy-runtime.js 里的 UI 差分**同一份**
 *      实现 —— 块编号必须两侧一致，否则「界面上勾第 2 块、写盘却写成第 3 块」）；
 *   2) blocksOf：把差分 ops 切成「变更块」，块是接受的粒度；
 *   3) composeText：按「接受哪些块」合成最终文本：接受的块取新内容，拒绝的块留旧内容。
 *
 * ⚠️ 关键语义（决定了它为什么必须配类型门禁）：
 *   合成结果是一个**既不是 AI 写的、也不是用户整体看过**的状态 —— 它可能语法不通
 *   （定义在块 2、使用在块 5，只接受 5）。所以调用方必须在写盘前对合成结果重新做
 *   一次诊断，见 type-gate.js。
 *
 * UMD：浏览器挂 globalThis.HunkSelect；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HunkSelect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 一、行级差分（与 runtime 中的 UI 差分同源，勿单独改动）
  // ══════════════════════════════════════════════════════════════════

  function lineKey(s, ignoreWs) {
    s = String(s == null ? '' : s);
    return ignoreWs ? s.replace(/\s+/g, ' ').trim() : s;
  }

  function diffDP(a, b, aOff, bOff, key) {
    var n = a.length, m = b.length, W = m + 1;
    var dp = new Uint32Array((n + 1) * W);
    for (var i = n - 1; i >= 0; i--) {
      var row = i * W, nextRow = (i + 1) * W, aKey = key(a[i]);
      for (var j = m - 1; j >= 0; j--) {
        if (aKey === key(b[j])) dp[row + j] = dp[nextRow + j + 1] + 1;
        else dp[row + j] = Math.max(dp[nextRow + j], dp[row + j + 1]);
      }
    }
    var ops = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (key(a[x]) === key(b[y])) { ops.push({ type: 'equal', ai: aOff + x, bi: bOff + y }); x++; y++; }
      else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) { ops.push({ type: 'del', ai: aOff + x, bi: bOff + y }); x++; }
      else { ops.push({ type: 'ins', ai: aOff + x, bi: bOff + y }); y++; }
    }
    while (x < n) { ops.push({ type: 'del', ai: aOff + x, bi: bOff + y }); x++; }
    while (y < m) { ops.push({ type: 'ins', ai: aOff + x, bi: bOff + y }); y++; }
    return ops;
  }

  // 超大 / 高差异用「唯一行」做锚点二分，避免 O(n*m) 爆内存
  function diffCore(a, b, aOff, bOff, key, depth) {
    var n = a.length, m = b.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) { var r1 = []; for (var j0 = 0; j0 < m; j0++) r1.push({ type: 'ins', ai: aOff, bi: bOff + j0 }); return r1; }
    if (m === 0) { var r2 = []; for (var i0 = 0; i0 < n; i0++) r2.push({ type: 'del', ai: aOff + i0, bi: bOff }); return r2; }
    if (n * m <= 4000000) return diffDP(a, b, aOff, bOff, key);
    if (depth < 16) {
      var cntA = new Map(), cntB = new Map();
      for (var i1 = 0; i1 < n; i1++) { var k1 = key(a[i1]); cntA.set(k1, (cntA.get(k1) || 0) + 1); }
      for (var j1 = 0; j1 < m; j1++) { var k2 = key(b[j1]); cntB.set(k2, (cntB.get(k2) || 0) + 1); }
      var midIdx = (n / 2) | 0;
      var best = -1, bestDist = Infinity;
      for (var i2 = 0; i2 < n; i2++) {
        var k3 = key(a[i2]);
        if (cntA.get(k3) === 1 && cntB.get(k3) === 1) {
          var d = Math.abs(i2 - midIdx);
          if (d < bestDist) { bestDist = d; best = i2; }
        }
      }
      if (best >= 0) {
        var kk = key(a[best]), bj = -1;
        for (var j2 = 0; j2 < m; j2++) { if (key(b[j2]) === kk) { bj = j2; break; } }
        var ops0 = [];
        var left = diffCore(a.slice(0, best), b.slice(0, bj), aOff, bOff, key, depth + 1);
        for (var l = 0; l < left.length; l++) ops0.push(left[l]);
        ops0.push({ type: 'equal', ai: aOff + best, bi: bOff + bj });
        var right = diffCore(a.slice(best + 1), b.slice(bj + 1), aOff + best + 1, bOff + bj + 1, key, depth + 1);
        for (var r = 0; r < right.length; r++) ops0.push(right[r]);
        return ops0;
      }
    }
    var out = [];
    for (var i3 = 0; i3 < n; i3++) out.push({ type: 'del', ai: aOff + i3, bi: bOff });
    for (var j3 = 0; j3 < m; j3++) out.push({ type: 'ins', ai: aOff + n, bi: bOff + j3 });
    return out;
  }

  function diffLines(aLines, bLines, ignoreWs) {
    var key = function (s) { return lineKey(s, ignoreWs); };
    var n = aLines.length, m = bLines.length;
    var start = 0;
    while (start < n && start < m && key(aLines[start]) === key(bLines[start])) start++;
    var endA = n, endB = m;
    while (endA > start && endB > start && key(aLines[endA - 1]) === key(bLines[endB - 1])) { endA--; endB--; }
    var ops = [], i;
    for (i = 0; i < start; i++) ops.push({ type: 'equal', ai: i, bi: i });
    var mid = diffCore(aLines.slice(start, endA), bLines.slice(start, endB), start, start, key, 0);
    for (i = 0; i < mid.length; i++) ops.push(mid[i]);
    for (var k = 0; k < (n - endA); k++) ops.push({ type: 'equal', ai: endA + k, bi: endB + k });
    return ops;
  }

  // ══════════════════════════════════════════════════════════════════
  // 二、块划分
  // ══════════════════════════════════════════════════════════════════

  // ops → 变更块（连续的 del/ins 序列为一个块）。块下标即 accept 的粒度。
  function blocksOf(ops) {
    var blocks = [], cur = null;
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o.type === 'equal') { if (cur) { blocks.push(cur); cur = null; } continue; }
      if (!cur) {
        cur = {
          index: blocks.length, opFrom: i, opTo: i + 1,
          aFrom: o.ai, aTo: o.ai, bFrom: o.bi, bTo: o.bi,
          dels: [], inss: []
        };
      }
      cur.opTo = i + 1;
      if (o.type === 'del') { cur.dels.push(o.ai); cur.aTo = o.ai + 1; }
      else { cur.inss.push(o.bi); cur.bTo = o.bi + 1; }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  // 每个 op 下标 → 所属块下标（-1 = 未改动）。渲染时用来打 data-block。
  function blockIndexByOp(ops) {
    var map = new Array(ops.length), cur = -1, n = 0;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === 'equal') { cur = -1; map[i] = -1; }
      else { if (cur === -1) { cur = n++; } map[i] = cur; }
    }
    return map;
  }

  // ops → 并排对齐行（改动块内逐行配对）。行上带 block 下标，供 UI 直接渲染勾选框。
  function buildRows(aLines, bLines, ops) {
    var rows = [], optoBlock = blockIndexByOp(ops), i = 0;
    while (i < ops.length) {
      var o = ops[i];
      if (o.type === 'equal') {
        rows.push({ type: 'equal', li: o.ai, ri: o.bi, lText: aLines[o.ai], rText: bLines[o.bi], block: -1 });
        i++;
        continue;
      }
      var blk = optoBlock[i], dels = [], inss = [];
      while (i < ops.length && ops[i].type !== 'equal') {
        if (ops[i].type === 'del') dels.push(ops[i].ai); else inss.push(ops[i].bi);
        i++;
      }
      var cnt = Math.max(dels.length, inss.length);
      for (var k = 0; k < cnt; k++) {
        var li = k < dels.length ? dels[k] : -1;
        var ri = k < inss.length ? inss[k] : -1;
        rows.push({
          type: (li >= 0 && ri >= 0) ? 'mod' : (li >= 0 ? 'del' : 'add'),
          li: li, ri: ri,
          lText: li >= 0 ? aLines[li] : '',
          rText: ri >= 0 ? bLines[ri] : '',
          block: blk
        });
      }
    }
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════
  // 三、按块合成
  // ══════════════════════════════════════════════════════════════════

  // accepted: 可传 null（= 全接受）/ 数组 / Set / function(blockIndex) -> bool
  function acceptorOf(accepted) {
    if (accepted == null) return function () { return true; };
    if (typeof accepted === 'function') return accepted;
    if (typeof accepted.has === 'function') return function (i) { return accepted.has(i); };
    var set = {};
    for (var i = 0; i < accepted.length; i++) set[accepted[i]] = true;
    return function (i) { return !!set[i]; };
  }

  /**
   * 合成最终文本。
   * 未改动的行一律取 a（旧）侧 —— a 是「磁盘原始内容」的文本投影，
   * 保持它可以让「用户没点过的行」逐字符不变；EOL/BOM 由写回端的 EolMeta 还原。
   */
  function composeText(aLines, bLines, ops, accepted) {
    var acc = acceptorOf(accepted);
    var optoBlock = blockIndexByOp(ops);
    var out = [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o.type === 'equal') { out.push(aLines[o.ai]); continue; }
      var take = acc(optoBlock[i]);
      if (o.type === 'del') { if (!take) out.push(aLines[o.ai]); }
      else { if (take) out.push(bLines[o.bi]); }
    }
    return out.join('\n');
  }

  function splitText(t) {
    return (typeof t === 'string' && t.length) ? t.split(/\r?\n/) : [];
  }

  /**
   * 一步到位：文本 → { text, ops, rows, blocks, acceptedCount, total, stats }
   * accepted 省略 = 全接受（等价于今天的「整份同步」）。
   */
  function compose(aText, bText, accepted, ignoreWs) {
    var aLines = splitText(aText), bLines = splitText(bText);
    var ops = diffLines(aLines, bLines, !!ignoreWs);
    var blocks = blocksOf(ops);
    var text = composeText(aLines, bLines, ops, accepted);
    var acc = acceptorOf(accepted);
    var acceptedCount = 0, add = 0, del = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (!acc(i)) continue;
      acceptedCount++;
      add += blocks[i].inss.length;
      del += blocks[i].dels.length;
    }
    return {
      text: text, ops: ops, blocks: blocks,
      aLines: aLines, bLines: bLines,
      acceptedCount: acceptedCount, total: blocks.length,
      stats: { add: add, del: del }
    };
  }

  // 未接受（被拒）的块：这些块的内容不会写盘，仍留在「待同步」里
  function rejectedBlocks(blocks, accepted) {
    var acc = acceptorOf(accepted), out = [];
    for (var i = 0; i < blocks.length; i++) if (!acc(i)) out.push(blocks[i]);
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  // 四、选择集的签名
  // ══════════════════════════════════════════════════════════════════
  // 块下标只在「同一对 (旧文本, 新文本)」下有意义。AI 再改一次，块编号就全变了，
  // 旧的勾选必须失效 —— 否则会把「用户勾过的第 2 块」错套到别的改动上。
  // 用内容签名做校验：签名不符 → 退回「全部接受」。
  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function signature(aText, bText, ignoreWs) {
    var a = ignoreWs ? splitText(aText).map(function (s) { return lineKey(s, true); }).join('\n') : String(aText == null ? '' : aText);
    var b = ignoreWs ? splitText(bText).map(function (s) { return lineKey(s, true); }).join('\n') : String(bText == null ? '' : bText);
    return fnv(a + '\u0000' + b + '\u0000' + (ignoreWs ? 'w' : 'x'));
  }

  return {
    lineKey: lineKey,
    diffLines: diffLines,
    blocksOf: blocksOf,
    blockIndexByOp: blockIndexByOp,
    buildRows: buildRows,
    composeText: composeText,
    compose: compose,
    rejectedBlocks: rejectedBlocks,
    splitText: splitText,
    signature: signature
  };
});
