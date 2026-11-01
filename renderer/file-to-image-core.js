/*!
 * file-to-image-core.js — file_to_image 工具的「纯逻辑」核心（不依赖 DOM）
 * =============================================================================
 * 把可单测的纯逻辑单独抽出来，DOM/Canvas 相关的重活留在 04-doc-tools.js：
 *   · detectFormat     根据扩展名 / 显式入参判断格式（markdown/docx/xlsx/pptx/pdf）
 *   · planOutputs   规划中间 PDF 路径与逐页图片文件名
 *   · selectPages   把用户给的 1-based 页号转成 0-based 索引（去重、越界过滤）
 *   · decodeDataUrl dataURL → Uint8Array（写 almostnode FS 用）
 *
 * UMD：浏览器挂 globalThis.FileToImageCore；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FileToImageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 扩展名 / 别名 → 规范格式名
  var FORMAT_ALIASES = {
    md: 'markdown', markdown: 'markdown', mkd: 'markdown', mdown: 'markdown', markdn: 'markdown',
    html: 'html', htm: 'html', xhtml: 'html',
    docx: 'docx', doc: 'docx',
    xlsx: 'xlsx', xls: 'xlsx', csv: 'xlsx',
    pptx: 'pptx', ppt: 'pptx',
    pdf: 'pdf'
  };
  var SUPPORTED = ['html', 'markdown', 'docx', 'xlsx', 'pptx', 'pdf'];

  // 取扩展名（小写），忽略 query/hash；无扩展名/隐藏文件返回 ''
  function extOf(p) {
    if (p === undefined || p === null) return '';
    var s = String(p).split(/[?#]/)[0];
    var slash = s.lastIndexOf('/');
    var base = s.substring(slash + 1);
    var dot = base.lastIndexOf('.');
    // dot<=0：无点(-1) 或 隐藏文件以点开头(.bashrc)；dot=末尾也无效
    if (dot <= 0 || dot >= base.length - 1) return '';
    return base.substring(dot + 1).toLowerCase();
  }

  // 显式 format 优先；否则按扩展名推断；都不识别返回 ''
  function detectFormat(filePath, explicit) {
    var e = explicit ? String(explicit).toLowerCase().replace(/^\./, '').trim() : '';
    if (e) {
      if (FORMAT_ALIASES[e]) return FORMAT_ALIASES[e];
      if (SUPPORTED.indexOf(e) >= 0) return e;
    }
    var ext = extOf(filePath);
    return FORMAT_ALIASES[ext] || '';
  }

  function isSupported(format) { return SUPPORTED.indexOf(format) >= 0; }
  function isMarkdown(format) { return format === 'markdown'; }

  function splitDir(p) {
    if (p === undefined || p === null || p === '') return { dir: '', name: '' };
    var s = String(p);
    var i = s.lastIndexOf('/');
    if (i < 0) return { dir: '', name: s };
    return { dir: s.substring(0, i), name: s.substring(i + 1) };
  }

  function baseName(p) {
    var n = splitDir(p).name;
    var d = n.lastIndexOf('.');
    return d > 0 ? n.substring(0, d) : n;
  }

  function normalizeImageFormat(fmt) {
    var f = fmt ? String(fmt).toLowerCase().replace(/^\./, '').trim() : 'png';
    if (f === 'jpg') f = 'jpeg';
    if (f !== 'png' && f !== 'jpeg' && f !== 'webp') f = 'png';
    return f;
  }
  function mimeForImage(format) {
    var f = normalizeImageFormat(format);
    return f === 'jpeg' ? 'image/jpeg' : (f === 'webp' ? 'image/webp' : 'image/png');
  }
  function extForImage(format) {
    var f = normalizeImageFormat(format);
    return f === 'jpeg' ? 'jpg' : f;
  }

  // 逐页图片文件名：<base>-<n>.<ext>
  function imageName(base, index1, imageFormat) {
    var ext = extForImage(imageFormat);
    var stem = base ? String(base) : 'page';
    return stem + '-' + index1 + '.' + ext;
  }

  // 规划输出：目录 / 中间 PDF 路径 / 逐页图片命名
  function planOutputs(opts) {
    opts = opts || {};
    var outputPath = opts.output_path ? String(opts.output_path).trim() : '';
    var outputDir = opts.output_dir ? String(opts.output_dir).trim() : '';
    var base = opts.base ? String(opts.base).trim() : '';

    var dir;
    if (outputDir) dir = outputDir;
    else if (outputPath) dir = splitDir(outputPath).dir || '/home/pyodide';
    else dir = '/home/pyodide';
    dir = dir.replace(/\/+$/, '') || '/home/pyodide';

    if (!base) {
      if (outputPath) base = baseName(outputPath) || 'output';
      else base = 'output';
    }

    var pdfPath = opts.pdf_path ? String(opts.pdf_path).trim() : (dir + '/' + base + '.pdf');

    return {
      dir: dir,
      base: base,
      pdfPath: pdfPath,
      imageDir: dir,
      imageName: function (index1) { return imageName(base, index1, opts.image_format); }
    };
  }

  // 选择导出的页：pages 为 1-based（null=全部）；返回去重升序的 0-based 索引
  function selectPages(total, pages) {
    total = Math.max(0, Math.floor(Number(total) || 0));
    if (total === 0) return [];
    var out = [];
    if (pages === undefined || pages === null) {
      for (var i = 0; i < total; i++) out.push(i);
      return out;
    }
    var list = Array.isArray(pages) ? pages : [pages];
    var seen = {};
    for (var j = 0; j < list.length; j++) {
      var n = Math.floor(Number(list[j]));
      if (!isFinite(n)) continue;
      if (n < 1 || n > total) continue;
      if (!seen[n]) { seen[n] = 1; out.push(n - 1); }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // dataURL → { mime, bytes: Uint8Array }
  function decodeDataUrl(dataUrl) {
    var s = String(dataUrl === undefined || dataUrl === null ? '' : dataUrl);
    var m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/i.exec(s);
    if (!m) throw new Error('不是合法的 dataURL');
    var mime = m[1] || 'application/octet-stream';
    var isB64 = !!m[2];
    var data = m[3] || '';
    if (isB64) {
      if (typeof atob === 'function') {
        var bin = atob(data);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return { mime: mime, bytes: arr };
      }
      if (typeof Buffer !== 'undefined') {
        return { mime: mime, bytes: new Uint8Array(Buffer.from(data, 'base64')) };
      }
      throw new Error('当前环境无法解码 base64 dataURL');
    }
    var dec = decodeURIComponent(data);
    var u = new Uint8Array(dec.length);
    for (var k = 0; k < dec.length; k++) u[k] = dec.charCodeAt(k) & 0xff;
    return { mime: mime, bytes: u };
  }

  return {
    FORMAT_ALIASES: FORMAT_ALIASES,
    SUPPORTED: SUPPORTED,
    extOf: extOf,
    detectFormat: detectFormat,
    isSupported: isSupported,
    isMarkdown: isMarkdown,
    splitDir: splitDir,
    baseName: baseName,
    normalizeImageFormat: normalizeImageFormat,
    mimeForImage: mimeForImage,
    extForImage: extForImage,
    imageName: imageName,
    planOutputs: planOutputs,
    selectPages: selectPages,
    decodeDataUrl: decodeDataUrl
  };
});
