/*!
 * delivery-summary.js — 结构化「改动摘要 / 交付说明」（纯逻辑）
 * =============================================================================
 * 问题：用户得自己读代码判断「这改动对不对」。对工程师勉强，对非工程岗等于没有
 * 审核能力。同步前必须给他一份**结论**，而不是一堆 diff 行。
 *
 * 做法：**从 diff 本身**推导，不依赖模型（模型可能不说、也可能编）。
 *   1) 逐文件的硬事实：改了几行、几块、接受几块、新建/删除/二进制；
 *   2) 风险信号：改函数签名/删声明、移除异常处理、动配置、动依赖、动 SQL/迁移、
 *      动测试、默认值变化、超大改动；
 *   3) 「无法验证」清单：类型/语法诊断结论 + 三条结构性的能力边界
 *      （跨文件引用、运行时行为、二进制内容）。
 *
 * 设计约束：**宁可说「我不知道」，也不要给一个假绿勾**。所以本模块永不返回
 * 「已验证通过」这种整体结论，只返回「本次检查覆盖了什么、没覆盖什么」。
 *
 * UMD：浏览器挂 globalThis.DeliverySummary；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeliverySummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 一、声明识别（判断「签名有没有变」）
  // ══════════════════════════════════════════════════════════════════
  var RE_DECL = [
    // function foo(a, b) / export async function* foo(...)
    { kind: 'fn', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/ },
    // const foo = (a) => / let foo = async function (a)
    { kind: 'fn', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*[A-Za-z_$\w]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/ },
    // class Foo / export default class Foo extends Bar
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    // python: def foo(a, b=1) / async def / class Foo
    { kind: 'fn', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/ },
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
    // go: func Foo(a int) / func (r *T) Foo(a int)
    { kind: 'fn', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/ }
  ];

  function normParams(p) {
    return String(p == null ? '' : p).replace(/\s+/g, '').replace(/,$/, '');
  }

  // 文本 → { name: {kind, params} }（同名后出现者覆盖前者）
  function declsOf(text) {
    var out = {};
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      if (!s || s.length > 400) continue;
      for (var k = 0; k < RE_DECL.length; k++) {
        var m = RE_DECL[k].re.exec(s);
        if (m) {
          out[m[1]] = { kind: RE_DECL[k].kind, params: normParams(m[2]), line: i + 1, raw: s.trim() };
          break;
        }
      }
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  // 二、逐文件分析
  // ══════════════════════════════════════════════════════════════════

  var RE_ERR = /(?:\btry\b|\bcatch\b|\bexcept\b|\braise\b|\bthrow\b|\bfinally\b|\.catch\s*\()/;

  function countMatches(text, re) {
    var lines = String(text == null ? '' : text).split(/\r?\n/), n = 0;
    for (var i = 0; i < lines.length; i++) if (re.test(lines[i])) n++;
    return n;
  }

  var CFG_EXT = /\.(env|ini|cfg|conf|toml|ya?ml|properties)$/i;
  var CFG_NAME = /(^|\/)(\.env(\..*)?|Dockerfile|Makefile|\.gitignore|\.gitattributes|\.editorconfig|nginx\.conf|web\.config|tsconfig\.json|jsconfig\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|rollup\.config\.[jt]s|next\.config\.[jt]s|\.babelrc|\.eslintrc.*)$/i;
  var DEP_NAME = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|requirements-.*\.txt|pyproject\.toml|poetry\.lock|Pipfile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle(\.kts)?)$/i;
  var SQL_RE = /\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|INDEX|VIEW|DATABASE|SCHEMA|SEQUENCE)\b|\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/i;
  var TEST_PATH = /(^|\/)(tests?|spec|__tests__|__mocks__)\/|\.(test|spec)\.[A-Za-z0-9]+$/i;
  var DEFAULT_RE = /^\s*(?:export\s+)?(?:const|let|var|static|final)\s+([A-Z][A-Z0-9_]{2,})\s*=|^\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*/;

  function baseName(p) { var s = String(p || '').replace(/\\/g, '/'); var i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); }

  /**
   * @param {object} f
   * @param {string} f.path        展示用路径
   * @param {string} [f.aText]     修改前文本（无基线 → undefined）
   * @param {string} [f.bText]     修改后文本（删除 → ''）
   * @param {string} [f.kind]      'write' | 'delete'
   * @param {number} [f.add]       新增行数（已接受）
   * @param {number} [f.del]       删除行数（已接受）
   * @param {number} [f.total]     变更块总数
   * @param {number} [f.accepted]  已接受块数
   * @param {boolean} [f.binary]   二进制
   * @param {boolean} [f.baselineUnknown] 修改前内容未知
   * @param {string} [f.intent]    可选：AI 自述的意图（若上层能拿到）
   */
  function analyzeFile(f) {
    f = f || {};
    var path = String(f.path || '');
    var tags = [];
    function tag(code, label, detail, severity) {
      tags.push({ code: code, label: label, detail: detail || '', severity: severity || 'mid' });
    }

    var isNew = f.baselineUnknown === true && f.kind !== 'delete';
    if (f.kind === 'delete') tag('DEL', '删除文件', '整份文件从磁盘移除', 'high');
    else if (isNew) tag('NEW', '新建文件', '磁盘上原本没有这份文件', 'mid');

    if (f.binary) tag('BIN', '二进制文件', '无法逐行审核，只能看大小/类型', 'high');

    var a = String(f.aText == null && f.baselineUnknown ? '' : (f.aText == null ? '' : f.aText));
    var b = String(f.bText == null ? '' : f.bText);

    // ── 签名 / 声明变更 ──────────────────────────────────────────
    if (f.aText != null || f.baselineUnknown === false) {
      var da = declsOf(a), db = declsOf(b);
      var sigChanged = [], removed = [];
      for (var name in da) {
        if (!Object.prototype.hasOwnProperty.call(da, name)) continue;
        if (db[name]) {
          if (db[name].params !== da[name].params) {
            sigChanged.push(name + '(' + (da[name].params || '') + ') → (' + (db[name].params || '') + ')');
          }
        } else {
          removed.push(name);
        }
      }
      if (sigChanged.length) {
        tag('SIG', '函数签名变更', sigChanged.slice(0, 5).join('；') + (sigChanged.length > 5 ? ' 等 ' + sigChanged.length + ' 处' : ''), 'high');
      }
      if (removed.length) {
        tag('DECL', '移除声明', removed.slice(0, 8).join('、') + (removed.length > 8 ? ' 等' : ''), 'high');
      }
    }

    // ── 异常处理 ────────────────────────────────────────────────
    if (f.aText != null && RE_ERR.test(a)) {
      var ea = countMatches(a, RE_ERR), eb = countMatches(b, RE_ERR);
      if (eb < ea) tag('ERR', '移除异常处理', 'try/catch/except/throw 由 ' + ea + ' 处减为 ' + eb + ' 处', 'high');
    }

    // ── 配置 / 依赖 / SQL / 测试 ────────────────────────────────
    var bn = baseName(path);
    if (DEP_NAME.test(path) || DEP_NAME.test(bn)) tag('DEP', '依赖清单变更', bn + '：依赖版本变化会影响安装与构建', 'high');
    else if (CFG_NAME.test(path) || CFG_NAME.test(bn) || CFG_EXT.test(bn)) tag('CFG', '配置变更', bn + '：不是业务代码，改错影响启动', 'mid');

    if (/\.sql$/i.test(path) || SQL_RE.test(b) || SQL_RE.test(a)) tag('SQL', '数据库/迁移脚本', '可能对数据产生不可逆影响', 'high');

    if (TEST_PATH.test(path)) tag('TEST', '测试文件', '只影响测试，不影响运行时行为', 'info');

    // ── 默认值 / 常量 ───────────────────────────────────────────
    if (f.aText != null) {
      var la = a.split(/\r?\n/), lb = b.split(/\r?\n/);
      var ma = {}, mb = {};
      for (var i = 0; i < la.length; i++) { var m1 = DEFAULT_RE.exec(la[i]); if (m1) ma[m1[1] || m1[2]] = la[i].trim(); }
      for (var j = 0; j < lb.length; j++) { var m2 = DEFAULT_RE.exec(lb[j]); if (m2) mb[m2[1] || m2[2]] = lb[j].trim(); }
      var changed = [];
      for (var k in mb) if (ma[k] && ma[k] !== mb[k]) changed.push(k);
      if (changed.length) tag('CONST', '常量/默认值变化', changed.slice(0, 5).join('、'), 'mid');
    }

    // ── 规模 ────────────────────────────────────────────────────
    var add = f.add || 0, del = f.del || 0;
    if (add + del > 200) tag('BIG', '超大改动', '+' + add + ' / −' + del + ' 行：建议分段审核', 'mid');

    if (f.baselineUnknown === true && f.kind !== 'delete') {
      tag('NOBASE', '无「修改前」基线', '无法判断具体改了什么（可能是旧版待同步记录）', 'mid');
    }

    if (f.intent) tag('INTENT', 'AI 自述意图', String(f.intent).slice(0, 300), 'info');

    return {
      path: path,
      kind: f.kind || 'write',
      add: add, del: del,
      total: f.total || 0, accepted: f.accepted == null ? (f.total || 0) : f.accepted,
      binary: !!f.binary,
      tags: tags,
      high: tags.filter(function (t) { return t.severity === 'high'; }).length
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 三、汇总
  // ══════════════════════════════════════════════════════════════════

  // 三条结构性边界：任何一次交付都成立，必须每次都写出来
  var STRUCTURAL_UNVERIFIED = [
    '跨文件引用：只检查拖入工作区内的文件，仓库其它位置（未拖入）的引用与实现未验证',
    '运行时行为：没有执行代码，运行期错误 / 行为变化不可见（不代表能跑通）',
    '业务正确性：意图是否吻合需求，机器无法判断，只能由你确认'
  ];

  /**
   * @param {object} o
   * @param {Array}  o.files         analyzeFile 的产出数组
   * @param {object} [o.gate]        type-gate 的结论 { status, errors:[], warnings:[], unavailable:[] }
   * @param {string} [o.at]          时间戳
   */
  function build(o) {
    o = o || {};
    var files = Array.isArray(o.files) ? o.files : [];
    var add = 0, del = 0, blocks = 0, accepted = 0, high = 0;
    for (var i = 0; i < files.length; i++) {
      add += files[i].add || 0; del += files[i].del || 0;
      blocks += files[i].total || 0; accepted += files[i].accepted || 0;
      high += files[i].high || 0;
    }
    var unverified = STRUCTURAL_UNVERIFIED.slice();
    if (o.gate) {
      var g = o.gate;
      if (g.status === 'unavailable') unverified.push('类型/语法检查：本次未能运行（' + (g.reason || '语言服务不可用') + '）');
      else if (g.status === 'skipped') unverified.push('类型/语法检查：已跳过（' + (g.reason || '文件类型不支持') + '）');
      if (g.status === 'pass' && g.checked > 0) {
        // 通过也只说「覆盖了」，不说「没问题」
        unverified.push('类型/语法检查：已检查 ' + g.checked + ' 个文件（仅语法与引用完整性，不含类型设计是否合理）');
      }
      if (g.errors && g.errors.length) {
        for (var e = 0; e < Math.min(g.errors.length, 8); e++) unverified.push('诊断错误：' + g.errors[e]);
      }
      if (g.unavailable && g.unavailable.length) {
        for (var u = 0; u < Math.min(g.unavailable.length, 5); u++) unverified.push('未能检查：' + g.unavailable[u]);
      }
    }
    return {
      at: o.at || new Date().toISOString(),
      files: files,
      totals: {
        files: files.length, add: add, del: del,
        blocks: blocks, accepted: accepted,
        riskHigh: high,
        blocked: !!(o.gate && o.gate.blocked)
      },
      gate: o.gate || null,
      unverified: unverified
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 四、渲染（Markdown：可直接贴进 PR / 工单 / 聊天）
  // ══════════════════════════════════════════════════════════════════

  function esc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }

  function toMarkdown(s) {
    if (!s) return '';
    var t = s.totals || {};
    var L = [];
    L.push('### 交付说明（自动生成）');
    L.push('');
    L.push('**' + t.files + ' 个文件** · 净变化 **+' + t.add + ' / −' + t.del + '** · 变更块 **' + t.accepted + '/' + t.blocks + ' 已接受**' +
      (t.riskHigh ? ' · ⚠️ 高风险项 **' + t.riskHigh + '**' : ''));
    if (s.gate) {
      var g = s.gate;
      var badge = g.blocked ? '❌ 存在阻断性错误' :
        (g.status === 'pass' ? '✅ 语法/引用检查通过' :
          (g.status === 'warn' ? '⚠️ 通过但有告警' : '➖ 未做类型检查（' + (g.reason || g.status) + '）'));
      L.push('');
      L.push('**检查结论：' + badge + '**');
    }
    L.push('');
    L.push('| 文件 | 类型 | 变化 | 变更块 | 风险 |');
    L.push('|---|---|---|---|---|');
    for (var i = 0; i < s.files.length; i++) {
      var f = s.files[i];
      var kindLabel = f.kind === 'delete' ? '删除' : (f.binary ? '二进制' : '修改');
      var risk = f.tags.filter(function (x) { return x.severity !== 'info'; }).map(function (x) { return x.label; }).join('、') || '—';
      L.push('| `' + esc(f.path) + '` | ' + kindLabel + ' | +' + f.add + ' / −' + f.del + ' | ' + f.accepted + '/' + f.total + ' | ' + esc(risk) + ' |');
    }

    // 风险明细
    var riskLines = [];
    for (var j = 0; j < s.files.length; j++) {
      var ff = s.files[j];
      for (var k = 0; k < ff.tags.length; k++) {
        var tg = ff.tags[k];
        if (tg.severity === 'info') continue;
        riskLines.push('- ' + (tg.severity === 'high' ? '🔴' : '🟠') + ' **' + tg.label + '** — `' + ff.path + '`' + (tg.detail ? '：' + tg.detail : ''));
      }
    }
    L.push('');
    L.push('#### 风险项');
    L.push('');
    L.push(riskLines.length ? riskLines.join('\n') : '- 未识别到结构性风险（不代表改动一定正确）');

    L.push('');
    L.push('#### 无法验证的部分');
    L.push('');
    for (var u = 0; u < s.unverified.length; u++) L.push('- ' + s.unverified[u]);
    L.push('');
    L.push('> 本说明由 diff 与诊断结果机械推导，不含推测。以上「无法验证」项请你确认后再提交。');
    return L.join('\n');
  }

  // 一句话结论（给 toast / 按钮提示用）
  function oneLine(s) {
    if (!s) return '';
    var t = s.totals || {};
    var parts = [t.files + ' 个文件', '+' + t.add + '/−' + t.del];
    if (s.gate && s.gate.blocked) parts.push('存在阻断性错误');
    else if (t.riskHigh) parts.push(t.riskHigh + ' 个高风险项');
    return parts.join(' · ');
  }

  return {
    declsOf: declsOf,
    analyzeFile: analyzeFile,
    build: build,
    toMarkdown: toMarkdown,
    oneLine: oneLine,
    STRUCTURAL_UNVERIFIED: STRUCTURAL_UNVERIFIED
  };
});
