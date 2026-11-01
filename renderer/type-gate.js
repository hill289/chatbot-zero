/*!
 * type-gate.js — 交付前的类型/语法门禁（诊断分类为纯逻辑，诊断执行走 tsserver）
 * =============================================================================
 * 为什么需要：hunk 级接受产出的文件，是 **AI 没写过、用户也没整体看过** 的状态
 * （定义在块 2、使用在块 5，只接受 5 → 语法是正确的废话，跑起来是 undefined）。
 * 让用户在没有编译器的情况下逐块点头，等于把风险管理外包给最没能力承担它的人。
 *
 * 所以：**门禁跑在「合成结果」上，不是跑在单个块上。**
 *   · 逐块检查没有意义 —— 单块取自一份连贯的 AI 输出，天然自洽；
 *     bug 只存在于拼装处。
 *
 * 而且它是**地板，不是证书**：
 *   · 抓得到：语法错误、未定义标识符、参数个数不符、重复声明、import 冲突、JSON 语法；
 *   · 抓不到：语义是否正确、运行时行为、配置值是否合理、**未拖入文件里的引用**。
 * 因此结论里永远带一份「没法验证」清单（见 delivery-summary.js），
 * 绝不返回一个「全部通过」的绿勾。
 *
 * UMD：浏览器挂 globalThis.TypeGate；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TypeGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 可检查的文件类型 ────────────────────────────────────────────
  var TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
  var JSON_EXT = /\.(json|jsonc|json5)$/i;

  function canCheck(path) {
    var p = String(path || '');
    if (JSON_EXT.test(p)) return 'json';
    if (TS_EXT.test(p)) return 'ts';
    return null;
  }

  // ── 阻断性错误码白名单（TS/JS 诊断码）──────────────────────────
  // 只拦「代码根本连不起来」的那类；风格/类型口味问题一律降级为告警，
  // 否则一个 checkJs 工程会满屏 2339 让人关掉门禁 —— 那样等于没有门禁。
  var BLOCK_CODES = {
    1005: '语法：缺少分号/括号',
    1009: '语法：字符串未闭合',
    1014: '语法：期望表达式',
    1109: '语法：表达式缺失',
    1128: '语法：声明或语句不完整',
    1136: '语法：属性赋值缺失',
    1160: '语法：字符串未终止',
    1161: '语法：模板字符串未终止',
    1308: '语法：默认导出只能有一个',
    1434: '语法：期望标识符',
    1472: '语法：模块声明不完整',
    2300: '重复标识符',
    2304: '找不到名称（未定义变量/函数）',
    2351: '导出重复声明',
    2440: '导入与本地声明冲突',
    2451: '重复声明',
    2551: '属性不存在（拼写/接口不符）',
    2554: '参数个数不匹配',
    2555: '参数个数少于要求',
    2556: '参数个数多于允许',
    2792: '找不到模块声明',
    7027: '未指定可调用对象',
    7028: '未指定可调用对象'
  };

  function isBlockCode(code) { return Object.prototype.hasOwnProperty.call(BLOCK_CODES, code); }

  // ── JSON 语法检查 ──────────────────────────────────────────────
  // 配置文件改错是最常见也最难在 diff 里看出来的事故，且机器 100% 判得准。
  function jsonError(text) {
    var s = String(text == null ? '' : text);
    if (!s.trim()) return '文件为空';
    try { JSON.parse(s); return null; } catch (e) { return String(e && e.message || e); }
  }

  // ── 诊断条目归一 ──────────────────────────────────────────────
  // 归一形态：{ file, line(1 基), col(1 基), code, severity:'error'|'warning'|'info', message }
  function fmt(it) {
    var where = it.file || '';
    var pos = it.line ? (':' + it.line + (it.col ? ':' + it.col : '')) : '';
    return where + pos + ' · TS' + it.code + ' ' + String(it.message || '').replace(/\s+/g, ' ').trim();
  }

  function classify(items, opts) {
    opts = opts || {};
    var errors = [], warnings = [];
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      var sev = it.severity || 'error';
      // 语法类（无 code 或 code 属于白名单）与显式 error → 阻断
      if (sev === 'error') {
        if (!it.code || isBlockCode(it.code) || opts.allSemanticBlocking) errors.push(fmt(it));
        else warnings.push(fmt(it));
      } else {
        warnings.push(fmt(it));
      }
    }
    // 去重（同一行同一码只留一条）
    function uniq(a) {
      var seen = {}, out = [];
      for (var k = 0; k < a.length; k++) { if (!seen[a[k]]) { seen[a[k]] = 1; out.push(a[k]); } }
      return out;
    }
    return { errors: uniq(errors), warnings: uniq(warnings) };
  }

  /**
   * 门禁结论。
   * @param {object} o
   * @param {string} o.path            文件路径（决定能不能检查）
   * @param {Array}  [o.diagnostics]   归一后的诊断条目
   * @param {string} [o.jsonError]     JSON 解析错误（若有）
   * @param {string} [o.skipReason]    为什么没检查
   * @param {number} [o.checked]       实际检查过的文件数（批量时）
   * @returns {{status,blocked,reason,errors,warnings,checked}}
   *   status: pass | warn | block | skipped | unavailable
   */
  function verdict(o) {
    o = o || {};
    var kind = o.kind || canCheck(o.path);
    if (!kind) {
      return { status: 'skipped', blocked: false, reason: o.skipReason || '该文件类型不做类型检查', errors: [], warnings: [], checked: 0 };
    }
    if (o.skipReason) {
      return { status: 'skipped', blocked: false, reason: o.skipReason, errors: [], warnings: [], checked: 0 };
    }
    if (o.jsonError) {
      return { status: 'block', blocked: true, reason: 'JSON 语法错误', errors: ['JSON 解析失败：' + o.jsonError], warnings: [], checked: 1 };
    }
    var c = classify(o.diagnostics, o);
    var checked = o.checked == null ? 1 : o.checked;
    if (c.errors.length) return { status: 'block', blocked: true, reason: '存在阻断性错误', errors: c.errors, warnings: c.warnings, checked: checked };
    if (c.warnings.length) return { status: 'warn', blocked: false, reason: '有告警（不阻断）', errors: [], warnings: c.warnings, checked: checked };
    return { status: 'pass', blocked: false, reason: '', errors: [], warnings: [], checked: checked };
  }

  // ══════════════════════════════════════════════════════════════════
  // 诊断执行（浏览器侧；Node 单测不触碰）
  // ══════════════════════════════════════════════════════════════════

  var ENV_DTS_NAME = '/__pgpy_env__.d.ts';
  var ENV_DTS = [
    'declare var require: (id: string) => any;',
    'declare var module: any;',
    'declare var exports: any;',
    'declare var process: any;',
    'declare var global: any;',
    'declare var Buffer: any;',
    'declare var __dirname: string;',
    'declare var __filename: string;',
    'declare function setImmediate(cb: (...a: any[]) => void, ...args: any[]): any;',
    'declare function clearImmediate(id: any): void;',
    'declare module "*";'
  ].join('\n');

  var MAX_TEXT = 400 * 1024;

  function normName(n) {
    var s = String(n).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  /**
   * 用 tsserver 检查「一段还没落盘的文本」，并把 vfs 里的其它文件当作依赖一并解析。
   * @param {object} env
   * @param {string} env.path        该文件在 vfs 里的绝对路径（import 相对解析的基准）
   * @param {string} env.text        要检查的内容（合成结果，尚未写入 vfs）
   * @param {function} env.readFile  (path) => string|undefined，读 vfs
   * @param {object} env.ts          window.ts
   * @param {object} [env.libs]      window.__TS_LIBS__
   * @param {string} [env.defaultLib]
   * @returns {{ok, items, reason}}
   */
  function diagnose(env) {
    env = env || {};
    var ts = env.ts;
    if (!ts || !ts.createLanguageService) return { ok: false, reason: 'TypeScript 引擎不可用', items: [] };
    var path = String(env.path || '');
    var text = String(env.text == null ? '' : env.text);
    if (text.length > MAX_TEXT) return { ok: false, reason: '文件过大，跳过类型检查', items: [] };
    var libs = env.libs || {};
    var readFile = typeof env.readFile === 'function' ? env.readFile : function () { return undefined; };

    function read(name) {
      if (name === ENV_DTS_NAME) return ENV_DTS;
      if (name === path) return text;              // ← 用「合成结果」覆盖磁盘/ vfs 里的旧内容
      var b = normName(name);
      if (libs[b] !== undefined) return libs[b];
      try { var t = readFile(name); return t == null ? undefined : String(t); } catch (_) { return undefined; }
    }

    var options = {
      allowJs: true,
      checkJs: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      lib: [env.defaultLib || 'lib.es2020.full.d.ts'],
      noEmit: true,
      strict: false,
      skipLibCheck: true,
      allowNonTsExtensions: true,
      types: [],
      maxNodeModuleJsDepth: 0
    };

    var host = {
      getScriptFileNames: function () { return [ENV_DTS_NAME, path]; },
      getScriptVersion: function () { return '1'; },
      getScriptSnapshot: function (n) {
        var t = read(n);
        return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
      },
      getCurrentDirectory: function () { return '/'; },
      getCompilationSettings: function () { return options; },
      getDefaultLibFileName: function () { return options.lib[0]; },
      fileExists: function (n) { return read(n) !== undefined; },
      readFile: function (n) { return read(n); },
      directoryExists: function () { return true; },
      getDirectories: function () { return []; },
      readDirectory: function () { return []; },
      getScriptKind: function (n) {
        var e = normName(n).toLowerCase();
        if (/\.d\.ts$/.test(e)) return ts.ScriptKind.TS;
        if (/\.tsx$/.test(e)) return ts.ScriptKind.TSX;
        if (/\.ts$/.test(e)) return ts.ScriptKind.TS;
        if (/\.jsx$/.test(e)) return ts.ScriptKind.JSX;
        if (/\.json$/.test(e)) return ts.ScriptKind.JSON;
        return ts.ScriptKind.JS;
      }
    };

    try {
      var ls = ts.createLanguageService(host, ts.createDocumentRegistry());
      var diags = [].concat(ls.getSyntacticDiagnostics(path) || [], ls.getSemanticDiagnostics(path) || []);
      var items = [];
      for (var i = 0; i < diags.length; i++) {
        var d = diags[i];
        if (!d) continue;
        var sf = d.file;
        var line = 0, col = 0;
        try {
          if (sf && d.start != null) {
            var s = ts.getLineAndCharacterOfPosition(sf, d.start);
            line = s.line + 1; col = s.character + 1;
          }
        } catch (_) {}
        items.push({
          file: normName(d.file && d.file.fileName || path),
          line: line, col: col,
          code: d.code,
          severity: d.category === ts.DiagnosticCategory.Error ? 'error'
            : d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
          message: ts.flattenDiagnosticMessageText(d.messageText, ' ')
        });
      }
      return { ok: true, items: items, reason: '' };
    } catch (e) {
      return { ok: false, reason: '诊断执行失败：' + (e && e.message || e), items: [] };
    }
  }

  return {
    canCheck: canCheck,
    jsonError: jsonError,
    classify: classify,
    verdict: verdict,
    diagnose: diagnose,
    isBlockCode: isBlockCode,
    BLOCK_CODES: BLOCK_CODES,
    ENV_DTS: ENV_DTS
  };
});
