/*!
 * demo-core.js — 官网 Demo 的核心计算（纯逻辑，DOM-free，UMD）
 * =============================================================================
 * 目的：让「演示」跑在**项目真实模块**上，而不是写死的假数据。
 *
 *   · 差异与块划分   → HunkSelect（与工作台界面同一份实现）
 *   · 风险识别/摘要   → DeliverySummary（同一份实现）
 *   · 门禁判定       → TypeGate（诊断条目来自真实 tsserver）
 *
 * 本文件只做「输入 → 计算 → 对象」，不碰 DOM、不加载脚本，因此可以在 Node 下
 * 用 node --test 直接验证（见 demo-core.test.js）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DemoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PATH = 'src/billing/refund.js';

  // 磁盘上的原始文件（= 拖入时的基线）
  var BASE = [
    'const TIMEOUT_MS = 3000;',
    'const TAX_RATE = 0.1;',
    '',
    'function calcTax(amount) {',
    '  return amount * TAX_RATE;',
    '}',
    '',
    'function refund(orderId, amount) {',
    '  try {',
    '    const total = amount - calcTax(amount);',
    '    return { orderId, total };',
    '  } catch (err) {',
    "    console.error('refund failed', err);",
    '    return { orderId, total: 0 };',
    '  }',
    '}',
    '',
    'module.exports = { refund, calcTax, TIMEOUT_MS };'
  ].join('\n');

  // AI 的修改提案（4 个变更块：常量 / 改名定义 / 主体重写 / 导出）
  var PROPOSAL = [
    'const TIMEOUT_MS = 8000;',
    'const TAX_RATE = 0.1;',
    '',
    'function calcTaxInclusive(amount) {',
    '  return amount * TAX_RATE;',
    '}',
    '',
    'function refund(orderId, amount, reason) {',
    '  const total = amount - calcTaxInclusive(amount);',
    '  return { orderId, total, reason };',
    '}',
    '',
    'module.exports = { refund, calcTaxInclusive, TIMEOUT_MS };'
  ].join('\n');

  function deps(o) {
    o = o || {};
    var H = o.HunkSelect, D = o.DeliverySummary, T = o.TypeGate;
    if (!H || !D || !T) throw new Error('demo-core: 缺少依赖（HunkSelect / DeliverySummary / TypeGate）');
    return { H: H, D: D, T: T };
  }

  function create(depsIn) {
    var d = deps(depsIn);

    // 全量差异：块的划分对 (BASE, PROPOSAL) 是恒定的
    function diff() {
      return d.H.compose(BASE, PROPOSAL, null, false);
    }

    /**
     * 按「接受的块下标」合成待写盘文本。
     * @param {number[]|Set|null} accepted null = 全部接受
     */
    function compose(accepted) {
      var arr = null;
      if (accepted != null) {
        arr = (typeof accepted.has === 'function') ? Array.from(accepted) : accepted.slice();
      }
      return d.H.compose(BASE, PROPOSAL, arr, false);
    }

    /** 复现「只接受调用点、拒绝改名定义」这个典型错误组合 */
    function presetBrokenAcceptance() {
      var base = diff(), out = [];
      for (var i = 0; i < base.blocks.length; i++) {
        var blk = base.blocks[i], isDefinition = false;
        for (var k = 0; k < blk.dels.length; k++) {
          if (/function\s+calcTax\s*\(/.test(base.aLines[blk.dels[k]])) isDefinition = true;
        }
        if (!isDefinition) out.push(blk.index);
      }
      return out;
    }

    /**
     * 门禁：诊断由真实 tsserver 产出（由调用方注入 ts / libs）。
     * 引擎不可用时返回 status:'unavailable' —— 绝不返回 pass。
     */
    function gate(o) {
      o = o || {};
      var text = String(o.text == null ? '' : o.text);
      var path = o.path || PATH;
      var items = null, fail = '';

      if (!o.ts || !o.ts.createLanguageService) {
        fail = 'TypeScript 引擎未加载';
      } else {
        var r = d.T.diagnose({
          path: '/' + path,
          text: text,
          ts: o.ts,
          libs: o.libs || {},
          readFile: function () { return undefined; },
          defaultLib: o.defaultLib || 'lib.es2020.full.d.ts'
        });
        if (r && r.ok) items = r.items || [];
        else fail = (r && r.reason) || '诊断执行失败';
      }

      if (fail) {
        return {
          status: 'unavailable', blocked: false, reason: fail,
          errors: [], warnings: [], checked: 0, items: []
        };
      }

      var v = d.T.verdict({ path: path, diagnostics: items });
      v.items = items;
      return v;
    }

    /** 交付摘要（完全由 diff + 诊断机械推导） */
    function summary(c, v, o) {
      o = o || {};
      var aText = o.aText == null ? BASE : o.aText;
      var file = d.D.analyzeFile({
        path: o.path || PATH,
        aText: aText,
        bText: c.text,
        add: c.stats.add,
        del: c.stats.del,
        accepted: c.acceptedCount,
        total: c.total
      });
      file.high = file.tags.filter(function (t) { return t.severity === 'high'; }).length;
      var s = d.D.build({ files: [file], gate: v });
      return { summary: s, file: file, markdown: d.D.toMarkdown(s), oneLine: d.D.oneLine(s) };
    }

    /** 写盘后「剩余差异」：磁盘已是 c.text，AI 提案是 PROPOSAL */
    function remaining(syncedText) {
      return d.H.compose(String(syncedText == null ? '' : syncedText), PROPOSAL, null, false);
    }

    return {
      PATH: PATH,
      BASE: BASE,
      PROPOSAL: PROPOSAL,
      diff: diff,
      compose: compose,
      presetBrokenAcceptance: presetBrokenAcceptance,
      gate: gate,
      summary: summary,
      remaining: remaining
    };
  }

  return { create: create, PATH: PATH, BASE: BASE, PROPOSAL: PROPOSAL };
});
