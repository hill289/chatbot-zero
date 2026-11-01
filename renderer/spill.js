/*!
 * spill.js — 工具结果溢出（Spill）纯逻辑模块
 * =============================================================================
 * 对齐 dsh 的 `spill/` 能力：当某次工具调用返回的文本过大时，不要把它整段灌进
 * 模型上下文（浏览器窗口本来就小），而是：
 *   1) 把「完整文本」交给宿主落盘（VFS / IndexedDB）；
 *   2) 只回「前 head + 后 tail + 一段说明 + 文件路径指针」；
 *   3) 模型之后用 read_file / read_file_char_range / search_content 按需回读。
 *
 * 设计约束：
 *   · 纯逻辑、零依赖、UMD（浏览器 window.SpillService / Node module.exports），
 *     方便 node --test 直接单测；真正的文件写入由宿主注入的 writeFn 完成。
 *   · 不改变工具返回的「形状」：输入是 JSON 字符串就还回 JSON 字符串，输入是对象
 *     就还回对象；`success / isError / denied / structuredContent / sessionRestart`
 *     等字段原样保留（只替换 content 里的超大文本项）。
 *   · 已经是 spill 过的结果（带 __spilled）不重复 spill。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SpillService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    maxChars: 20000,   // 单次工具结果文本总量超过该字符数即触发 spill
    headChars: 4000,   // 保留开头
    tailChars: 2000    // 保留结尾
  };

  function normOptions(opts) {
    opts = opts || {};
    var maxChars = (opts.maxChars == null) ? DEFAULTS.maxChars : Number(opts.maxChars);
    var headChars = (opts.headChars == null) ? DEFAULTS.headChars : Number(opts.headChars);
    var tailChars = (opts.tailChars == null) ? DEFAULTS.tailChars : Number(opts.tailChars);
    if (!isFinite(maxChars) || maxChars < 0) maxChars = DEFAULTS.maxChars;
    if (!isFinite(headChars) || headChars < 0) headChars = DEFAULTS.headChars;
    if (!isFinite(tailChars) || tailChars < 0) tailChars = DEFAULTS.tailChars;
    // head + tail 不能吃掉全部预算，否则“截断”没有意义
    if (maxChars > 0 && headChars + tailChars > maxChars) {
      var scale = maxChars / (headChars + tailChars);
      headChars = Math.floor(headChars * scale);
      tailChars = Math.floor(tailChars * scale);
    }
    return {
      enabled: opts.enabled !== false,
      maxChars: maxChars,
      headChars: headChars,
      tailChars: tailChars
    };
  }

  function isTextItem(item) {
    if (!item) return false;
    if (item.type === 'text') return true;
    // 兼容极少数「没有 type 但有 text」的裸内容项
    return (item.type == null && typeof item.text === 'string');
  }

  function textOf(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item.text === 'string') return item.text;
    return '';
  }

  // 把工具返回（JSON 字符串 / 对象）解析成 { shape, obj, content, plain }
  function parseResult(result) {
    if (typeof result === 'string') {
      try {
        var obj = JSON.parse(result);
        if (obj && typeof obj === 'object' && Array.isArray(obj.content)) {
          return { shape: 'string', obj: obj, content: obj.content, plain: false };
        }
      } catch (_) { /* 非 JSON：按纯文本处理 */ }
      return { shape: 'string', obj: null, content: [{ type: 'text', text: result }], plain: true };
    }
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
      return { shape: 'object', obj: result, content: result.content, plain: false };
    }
    return null;
  }

  function totalTextChars(content) {
    var n = 0;
    var list = content || [];
    for (var i = 0; i < list.length; i++) {
      if (isTextItem(list[i])) n += textOf(list[i]).length;
    }
    return n;
  }

  function shouldSpill(content, opts) {
    var o = normOptions(opts);
    if (!o.enabled || o.maxChars <= 0) return false;
    return totalTextChars(content) > o.maxChars;
  }

  function splitText(text, opts) {
    var o = normOptions(opts);
    text = String(text == null ? '' : text);
    if (!o.enabled || o.maxChars <= 0 || text.length <= o.maxChars) {
      return { head: text, tail: '', omitted: 0, total: text.length, spilled: false, headChars: text.length, tailChars: 0 };
    }
    var head = text.slice(0, o.headChars);
    var tail = o.tailChars > 0 ? text.slice(text.length - o.tailChars) : '';
    var omitted = text.length - head.length - tail.length;
    return {
      head: head,
      tail: tail,
      omitted: omitted,
      total: text.length,
      spilled: true,
      headChars: head.length,
      tailChars: tail.length
    };
  }

  function formatNotice(meta) {
    meta = meta || {};
    var lines = [];
    lines.push('⟪spill⟫ 工具结果过大：原始 ' + (meta.total | 0) + ' 字符，这里只保留前 ' +
      (meta.headChars | 0) + ' + 后 ' + (meta.tailChars | 0) + '，省略 ' + (meta.omitted | 0) + ' 字符。');
    if (meta.path) {
      lines.push('完整内容已写入工作区文件：' + meta.path);
      lines.push('继续查看请用 read_file / read_file_char_range / search_content 读取该文件；不要原样重复调用同一工具期待更短输出。');
    } else {
      lines.push('（落盘不可用，已内联截断；请缩小查询范围或分页读取。）');
    }
    return lines.join('\n');
  }

  // 核心：把一次工具返回按需 spill。writeFn(fullText) -> 保存路径（失败返回空串）
  function apply(result, writeFn, opts) {
    var o = normOptions(opts);
    if (!o.enabled) return { result: result, spilled: false };
    var p = parseResult(result);
    if (!p) return { result: result, spilled: false };
    if (p.obj && p.obj.__spilled) return { result: result, spilled: false };

    var content = p.content || [];
    var textItems = [];
    var otherItems = [];
    for (var i = 0; i < content.length; i++) {
      if (isTextItem(content[i])) textItems.push(content[i]);
      else otherItems.push(content[i]);
    }
    var full = textItems.map(textOf).join('\n');
    if (full.length <= o.maxChars) return { result: result, spilled: false };

    var split = splitText(full, o);
    var path = '';
    if (typeof writeFn === 'function') {
      try { path = writeFn(full) || ''; } catch (_) { path = ''; }
    }

    var notice = formatNotice({
      total: split.total,
      headChars: split.headChars,
      tailChars: split.tailChars,
      omitted: split.omitted,
      path: path
    });
    var newText = split.head + '\n\n' + notice + (split.tail ? ('\n\n' + split.tail) : '');
    var newContent = [{ type: 'text', text: newText }].concat(otherItems);

    var out;
    if (p.shape === 'string') {
      if (p.plain) {
        out = newText;
      } else {
        out = JSON.stringify(Object.assign({}, p.obj, {
          content: newContent,
          __spilled: true,
          __spillPath: path || undefined,
          __spillOmitted: split.omitted
        }));
      }
    } else {
      out = Object.assign({}, p.obj, {
        content: newContent,
        __spilled: true,
        __spillPath: path || undefined,
        __spillOmitted: split.omitted
      });
    }

    return { result: out, spilled: true, path: path, omitted: split.omitted, total: split.total };
  }

  return {
    DEFAULTS: DEFAULTS,
    normOptions: normOptions,
    parseResult: parseResult,
    totalTextChars: totalTextChars,
    shouldSpill: shouldSpill,
    splitText: splitText,
    formatNotice: formatNotice,
    apply: apply
  };
});
