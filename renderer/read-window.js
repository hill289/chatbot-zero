/*!
 * read-window.js — 「读多少」的预算与窗口规划（纯逻辑，无 DOM / 无 FS）
 * =============================================================================
 * 为什么需要：把「行数」当读取单位是错的。
 *   · renderer/assets/js/12-render.js      1541 行 → 106 KB（2000 行 ≈ 137 KB）
 *   · renderer/mermaid.min.js              2030 行 → 3.2 MB（2000 行 = 3.1 MB）
 *   · renderer/katex.min.js                   1 行 → 275 KB
 *   · renderer/almostnode.global.js       81080 行 → 最长单行 1.28 MB
 * 同样是「2000 行」，体积差 30 倍；同样是「1000 行」，token 数能差 100 倍。
 *
 * 所以本模块只做三件事：
 *   1) probe()          —— 先看形状（大小 / 行数 / 最长行 / 平均行长），再决定怎么读；
 *   2) plan()           —— 按形状分派策略：正常窗口 / 长行摘要 / 压缩包拒读 / 超大文件；
 *   3) sliceByLines()   —— 真正的窗口切片：token 预算 + 行数上限双限，且**必然**带续读指针。
 *
 * 三条不变量（测试里逐条断言）：
 *   · 任何一次返回都不超 token 预算（estimateTokens ≤ maxTokens + 单行溢出容差）；
 *   · 只要没读到末尾，返回里必然有 nextStartLine / nextCharOffset；
 *   · 同样的输入 → 逐字节相同的输出（前缀缓存友好，禁止时间戳/随机数）。
 *
 * UMD：浏览器挂 globalThis.ReadWindow；Node 下 module.exports（供 read-window.test.js）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReadWindow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 默认预算
  // ══════════════════════════════════════════════════════════════════
  var DEFAULTS = {
    maxLines: 400,            // 默认每次最多返回多少行（显式指定 start/end 时可放宽）
    hardMaxLines: 2000,       // 硬上限：即使模型要 10 万行也只给 2000
    maxTokens: 6000,          // 单次工具结果 token 预算（约 24 KB 纯 ASCII）
    maxLineChars: 1000,       // 单行最多展示多少字符
    longLineTail: 160,        // 超长行额外展示尾部字符数（头 + 尾，避免错过闭合括号）
    longLineThreshold: 4000,  // 单行超过该长度 → 判定「长行」，不做内联展开
    minifiedMinBytes: 100 * 1024, // 压缩包判定：文件 > 100 KB
    minifiedMaxLines: 50,     //   且行数 < 50（典型 min.js 只有 1–3 行）
    minifiedAvgLine: 4000,    //   或平均行长 > 4000
    probeBytes: 65536,        // 结构摘要只扫前 64 KB，避免对大文件做 O(n) 正则
    hugeBytes: 2 * 1024 * 1024 // 超过 2 MB 不给正文（走 summary）
  };

  function cfg(opts) {
    var o = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (Object.prototype.hasOwnProperty.call(opts, k2) && opts[k2] != null) o[k2] = opts[k2];
    return o;
  }

  // ══════════════════════════════════════════════════════════════════
  // token 估算：ASCII 约 4 字符/token，非 ASCII（中文/emoji）约 1 字符/token。
  // 不做精确分词（要引 tokenizer，太重），只要单调且量级正确即可 ——
  // 预算的目的是「别把上下文吃光」，不是计费。
  // ══════════════════════════════════════════════════════════════════
  function estimateTokens(text) {
    if (!text) return 0;
    var ascii = 0, wide = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) ascii++;
      else if (c >= 0xD800 && c <= 0xDBFF) { wide++; i++; } // 代理对算 1 个宽字符
      else wide++;
    }
    return Math.ceil(ascii / 4 + wide);
  }

  // ══════════════════════════════════════════════════════════════════
  // 形状探测
  //   content : 已解码的全文（可为 null，此时用 lines）
  //   lines   : 可选，已 split 的结果（避免重复 split）
  //   bytes   : 原始字节数（比 content.length 更准，含 BOM/多字节）
  // ══════════════════════════════════════════════════════════════════
  function probe(content, opts) {
    opts = opts || {};
    var lines = opts.lines || (content == null ? [] : String(content).split(/\r?\n/));
    var bytes = opts.bytes != null ? opts.bytes : (content == null ? 0 : String(content).length);
    var maxLine = 0, sum = 0;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i].length;
      sum += L;
      if (L > maxLine) maxLine = L;
    }
    var totalLines = lines.length;
    var avg = totalLines ? Math.round(sum / totalLines) : 0;
    var kind = 'normal';
    if (bytes > DEFAULTS.hugeBytes) kind = 'huge';
    else if (totalLines <= DEFAULTS.minifiedMaxLines && bytes > DEFAULTS.minifiedMinBytes) kind = 'minified';
    else if (avg > DEFAULTS.minifiedAvgLine) kind = 'minified';
    else if (maxLine > DEFAULTS.longLineThreshold) kind = 'longline';
    return {
      kind: kind,
      bytes: bytes,
      totalLines: totalLines,
      maxLineLen: maxLine,
      avgLineLen: avg,
      estimatedTokens: estimateTokens(content == null ? '' : String(content))
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 策略分派
  //   返回 { mode, reason, maxLines, maxTokens, allowBody }
  //   mode: 'lines' | 'longline' | 'minified' | 'huge'
  // ══════════════════════════════════════════════════════════════════
  function plan(shape, opts) {
    var o = cfg(opts);
    var explicit = !!(opts && opts.explicitRange);
    var maxLines = explicit ? o.hardMaxLines : o.maxLines;
    var base = { maxLines: maxLines, maxTokens: o.maxTokens };

    if (shape.kind === 'huge') {
      return {
        mode: 'huge', allowBody: false, maxLines: 0, maxTokens: o.maxTokens,
        reason: '文件 ' + shape.bytes + ' bytes 超过 ' + o.hugeBytes + ' bytes 正文上限：文本读取不适用，请用 search_content 定位，或 run_node 解析。'
      };
    }
    if (shape.kind === 'minified') {
      return {
        mode: 'minified', allowBody: false, maxLines: 0, maxTokens: o.maxTokens,
        reason: '疑似压缩/打包文件（' + shape.totalLines + ' 行 / ' + shape.bytes + ' bytes，平均行长 ' + shape.avgLineLen +
          '）：逐行读取没有意义，已返回结构摘要。请用 search_content 定位符号，或 run_node 里 require() 取结构。'
      };
    }
    if (shape.kind === 'longline') {
      return {
        mode: 'longline', allowBody: true, maxLines: maxLines, maxTokens: o.maxTokens,
        reason: '存在超长行（最长 ' + shape.maxLineLen + ' 字符）：该行只给头尾摘要，正文请用 read_file_char_range 按字符偏移读。'
      };
    }
    return { mode: 'lines', allowBody: true, maxLines: maxLines, maxTokens: o.maxTokens, reason: '' };
  }

  // ══════════════════════════════════════════════════════════════════
  // 单行渲染：正常行原样；超长行 → 头 + 尾 + 续读指引
  // ══════════════════════════════════════════════════════════════════
  function renderLine(lineNo, raw, o) {
    var cap = o.maxLineChars;
    if (raw.length <= cap) return { text: lineNo + ':' + raw, kind: 'normal' };

    var head = raw.slice(0, cap);
    var tailLen = Math.min(o.longLineTail, Math.max(0, raw.length - cap));
    var tail = tailLen > 0 ? raw.slice(raw.length - tailLen) : '';
    var headText = lineNo + ':' + head;
    var tailText = tail ? ('…[+' + (raw.length - cap - tailLen) + ' chars]…' + tail) : ('…[+' + (raw.length - cap) + ' chars]');
    return {
      text: headText + '\n' + tailText,
      kind: 'long',
      line: lineNo,
      lineLength: raw.length,
      nextOffset: cap
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 行窗口切片
  //   lines     : 全文 split 结果
  //   startLine : 1-indexed，包含
  //   endLine   : 1-indexed，包含（可空）
  //   opts      : { maxLines, maxTokens, maxLineChars, ... }
  // 返回 { ok, text, startLine, endLine, totalLines, nextStartLine, truncated,
  //        tokens, longLines:[{line,lineLength,nextOffset}], footer }
  // ══════════════════════════════════════════════════════════════════
  function sliceByLines(lines, startLine, endLine, opts) {
    var o = cfg(opts);
    var total = lines.length;
    if (!total) return { ok: true, text: '', startLine: 1, endLine: 0, totalLines: 0, nextStartLine: null, truncated: false, tokens: 0, longLines: [], footer: '[窗口] 空文件' };
    if (!(startLine >= 1)) startLine = 1;
    if (startLine > total) return { ok: false, error: 'start_line (' + startLine + ') 超过文件总行数 (' + total + ')' };

    var lastRequested = Math.min(endLine == null ? total : endLine, total);
    if (lastRequested < startLine) lastRequested = startLine;

    var out = [];
    var tokens = 0;
    var longLines = [];
    var lastLine = startLine - 1;
    var truncated = false;

    for (var n = startLine; n <= lastRequested; n++) {
      var r = renderLine(n, lines[n - 1], o);
      var t = estimateTokens(r.text) + 1;
      // 至少放一行：保证「一行都塞不下」时也能返回带续读指针的片段
      if (out.length > 0 && (tokens + t > o.maxTokens || out.length >= o.maxLines)) { truncated = true; break; }
      out.push(r.text);
      tokens += t;
      lastLine = n;
      if (r.kind === 'long') longLines.push({ line: r.line, lineLength: r.lineLength, nextOffset: r.nextOffset });
    }

    var nextStartLine = lastLine < total ? lastLine + 1 : null;
    var body = out.join('\n');

    // 尾部指引：必须可执行，且逐字节稳定（同样的输入 → 同样的输出）
    var footer;
    if (nextStartLine) {
      footer = '[窗口] 第 ' + startLine + '–' + lastLine + ' 行 / 共 ' + total + ' 行（约 ' + tokens + ' tokens）\n' +
        '[继续] start_line=' + nextStartLine + '（还有 ' + (total - lastLine) + ' 行未读）';
    } else {
      footer = '[窗口] 第 ' + startLine + '–' + lastLine + ' 行 / 共 ' + total + ' 行（约 ' + tokens + ' tokens）\n[窗口] 已到文件末尾';
    }
    if (longLines.length) {
      var L = longLines[0];
      footer += '\n[超长行] 第 ' + L.line + ' 行共 ' + L.lineLength + ' 字符，此处只显示头尾；' +
        '继续请用 read_file_char_range(file_path, offset=' + L.nextOffset + ', limit=2000)';
    }

    return {
      ok: true,
      text: body ? body + '\n' + footer : footer,
      startLine: startLine,
      endLine: lastLine,
      totalLines: total,
      nextStartLine: nextStartLine,
      truncated: truncated && !!nextStartLine,
      tokens: tokens,
      longLines: longLines,
      footer: footer
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 字符窗口切片（read_file_char_range 的核心）
  //   raw : 单行或整段文本
  // ══════════════════════════════════════════════════════════════════
  function sliceByChars(raw, offset, limit, opts) {
    var o = cfg(opts);
    var text = raw == null ? '' : String(raw);
    var total = text.length;
    var off = (offset == null || !isFinite(offset) || offset < 0) ? 0 : Math.floor(offset);
    if (off > total) off = total;
    var lim = (limit == null || !isFinite(limit) || limit <= 0) ? o.maxLineChars * 2 : Math.floor(limit);
    if (lim > o.maxTokens * 3) lim = o.maxTokens * 3; // 粗上限，防止 limit 被写成 100 万

    var end = Math.min(off + lim, total);
    var chunk = text.slice(off, end);
    // UTF-8 代理对安全：不要让半个代理对成为返回值
    if (chunk.length && end < total) {
      var lastCode = text.charCodeAt(end - 1);
      if (lastCode >= 0xD800 && lastCode <= 0xDBFF) { chunk = chunk.slice(0, -1); end--; }
    }
    var nextOffset = end < total ? end : null;
    var footer = '[偏移] ' + off + '–' + end + ' / 共 ' + total + ' 字符' +
      (nextOffset == null ? '（已到末尾）' : '\n[继续] offset=' + nextOffset);
    return { ok: true, text: chunk, offset: off, end: end, total: total, nextOffset: nextOffset, footer: footer };
  }

  // ══════════════════════════════════════════════════════════════════
  // 结构摘要：压缩包 / 超大文件不给正文，给「这是什么」
  //   只扫 probeBytes，绝不 O(文件大小) 正则
  // ══════════════════════════════════════════════════════════════════
  function summarizeStructure(filePath, content, shape, opts) {
    var o = cfg(opts);
    var head = String(content == null ? '' : content).slice(0, o.probeBytes);
    var symbols = [];
    var seen = Object.create(null);
    var re = /(?:^|[;{}\n])\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]{1,63})|(?:^|[;{}\n])\s*(?:const|let|var|class)\s+([A-Za-z_$][\w$]{1,63})/g;
    var m, guard = 0;
    while ((m = re.exec(head)) && guard++ < 4000) {
      var name = m[1] || m[2];
      if (name && !seen[name]) { seen[name] = 1; symbols.push(name); }
      if (symbols.length >= 40) break;
    }
    var out = [];
    out.push('[SUMMARY] \'' + filePath + '\' 判定为压缩/打包文件，不返回正文。');
    out.push('- 文件大小: ' + shape.bytes + ' bytes');
    out.push('- 行数: ' + shape.totalLines + '（平均行长 ' + shape.avgLineLen + '，最长 ' + shape.maxLineLen + '）');
    if (symbols.length) {
      out.push('- 前 ' + symbols.length + ' 个顶层符号（仅扫描前 ' + o.probeBytes + ' 字节）:');
      out.push('  ' + symbols.join(', '));
    }
    out.push('- 开头 200 字符:');
    out.push('  ' + head.slice(0, 200).replace(/\s+/g, ' '));
    out.push('[提示] 不要逐行读这类文件。请用 search_content 定位符号、run_node 里 require() 后取 Object.keys()；' +
      '确需看某段原文时用 read_file_char_range(file_path, offset=<n>, limit=4000) 按字符偏移读。');
    return out.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════
  // 错误分类：别再让所有异常都变成「文件不存在」
  // ══════════════════════════════════════════════════════════════════
  function classifyError(e) {
    var code = (e && (e.code || e.errno)) || '';
    var msg = (e && e.message) ? String(e.message) : String(e || 'unknown error');
    if (code === 'ENOENT' || /ENOENT|no such file|not exists/i.test(msg)) return { code: 'ENOENT', message: msg };
    if (code === 'EISDIR' || /EISDIR|is a directory/i.test(msg)) return { code: 'EISDIR', message: msg };
    if (code === 'EACCES' || code === 'EPERM' || /permission denied/i.test(msg)) return { code: 'EPERM', message: msg };
    return { code: 'OTHER', message: msg };
  }

  return {
    DEFAULTS: DEFAULTS,
    estimateTokens: estimateTokens,
    probe: probe,
    plan: plan,
    renderLine: renderLine,
    sliceByLines: sliceByLines,
    sliceByChars: sliceByChars,
    summarizeStructure: summarizeStructure,
    classifyError: classifyError
  };
});
