/*!
 * url-resolve.js — 内置浏览器「地址 → 可加载 URL」纯逻辑（零依赖 · UMD · 可 node 单测）
 * =============================================================================
 * 背景（修复的 Bug）：
 *   工作台的文件都住在 almostnode 虚拟文件系统（VFS，根目录 /home/pyodide）里。
 *   旧版 resolveInput 把 `/home/pyodide/xxx` 当成「磁盘 POSIX 绝对路径」转成
 *   file:// URL → 浏览器去磁盘上找这个文件 → 当然找不到（ERR_FILE_NOT_FOUND）。
 *   这就是「浏览器浏览 vfs 的文件无法找到」。
 *
 * 修复方案：
 *   引入 vfs:// 自定义协议。地址栏 / browser_navigate 里出现的 VFS 路径
 *   （/home/pyodide/...）一律转成 vfs://home/pyodide/... ；主进程注册
 *   protocol.handle('vfs')，向工作台渲染层要字节（window.__vfsServeRead），
 *   再以正确的 MIME 返回给浏览器标签 —— VFS 文件即可直接在内置浏览器里浏览。
 *
 * 本模块只做「纯字符串逻辑」：
 *   · resolveBrowserInput(input) → { kind, url?, path? }
 *       kind: 'empty' | 'raw'(已带协议) | 'vfs' | 'disk' | 'web' | 'search'
 *   · toVfsUrl / vfsPathFromUrl（互为逆变换，逐段 encodeURIComponent）
 *   · normalizeVfsPath / joinVfsPath / isVfsPath
 *   · mimeFromVPath / renderDirectoryHtml / renderVfsErrorHtml
 * 磁盘路径 → file:// 的转换依赖 node:path，留在 main.js（kind='disk' 时它自己处理）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UrlResolve = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VFS_ROOT = '/home/pyodide';
  var VFS_HOST = 'home';                       // vfs://home/pyodide/... 的 host 段
  var RAW_PROTOCOL = /^(https?|file|about|data|chrome|view-source|blob):/i;

  // 反斜杠 → 正斜杠
  function slash(p) {
    return String(p == null ? '' : p).split('\\').join('/');
  }

  // 把路径规范成「VFS 绝对路径」：正斜杠、折叠 //、解析 . 与 ..、去 query/hash 噪声
  function normalizeVfsPath(p) {
    var s = slash(p).trim();
    if (!s) return '';
    // 去掉误带的 vfs://host 前缀（容错：vfsPathFromUrl 之外的调用方也可能传进来）
    if (/^vfs:\/\//i.test(s)) {
      var back = vfsPathFromUrl(s);
      return back || '';
    }
    if (s.charAt(0) !== '/') s = '/' + s;
    var parts = [];
    var segs = s.split('/');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  // 是否是 VFS 根或其子路径（严格：/home/pyodidefile 不算）
  function isVfsPath(p) {
    var n = normalizeVfsPath(p);
    return n === VFS_ROOT || n.indexOf(VFS_ROOT + '/') === 0;
  }

  // 拼接：基路径 + 相对段 → 规范 VFS 绝对路径
  function joinVfsPath(base, rel) {
    var b = normalizeVfsPath(base) || VFS_ROOT;
    var r = slash(rel == null ? '' : rel).replace(/^\/+/, '');
    if (!r) return b;
    return normalizeVfsPath(b + '/' + r);
  }

  // VFS 路径 → vfs:// URL（逐段编码，中文/空格/# 都安全）
  // standard scheme 形态：VFS 路径首段（/home/... 的 "home"）即 host，
  // 其余各段保持为 URL path —— 与 vfsPathFromUrl 的解析严格互逆。
  function toVfsUrl(p) {
    var n = normalizeVfsPath(p);
    if (!n) n = VFS_ROOT;
    var segs = n.split('/').filter(Boolean);
    if (!segs.length) return 'vfs://' + VFS_HOST + '/';
    var host = encodeURIComponent(segs[0]);
    var rest = segs.slice(1).map(function (s) { return encodeURIComponent(s); }).join('/');
    // 根目录带尾斜杠，浏览器按目录处理
    if (!rest || n === VFS_ROOT) return 'vfs://' + host + '/' + rest + (rest ? '/' : '');
    return 'vfs://' + host + '/' + rest;
  }

  // vfs:// URL → VFS 路径（toVfsUrl 的逆变换）；非 vfs:// 或越界返回 null
  function vfsPathFromUrl(url) {
    var s = String(url == null ? '' : url).trim();
    if (!/^vfs:\/\//i.test(s)) return null;
    var body = s.replace(/^vfs:\/\//i, '');
    // 去掉 query/hash（地址栏可能带上）
    body = body.split('#')[0].split('?')[0];
    var slashIdx = body.indexOf('/');
    var host = slashIdx === -1 ? body : body.slice(0, slashIdx);
    var rest = slashIdx === -1 ? '' : body.slice(slashIdx + 1);
    var raw = host ? ('/' + host + (rest ? '/' + rest : '')) : ('/' + rest);
    var decoded;
    try {
      decoded = raw.split('/').map(function (seg) {
        return seg ? decodeURIComponent(seg) : seg;
      }).join('/');
    } catch (_) { return null; }   // 非法百分号编码 → 拒绝，不去猜
    var n = normalizeVfsPath(decoded);
    if (!n) return null;
    return isVfsPath(n) ? n : null;
  }

  // 地址输入 → { kind, url?, path? }
  function resolveBrowserInput(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { kind: 'empty' };
    // 已带 vfs:// → 规范化后原样可用（坏 URL → 退化为搜索，绝不静默 fail）
    if (/^vfs:\/\//i.test(s)) {
      var vp = vfsPathFromUrl(s);
      if (vp) return { kind: 'vfs', url: toVfsUrl(vp) };
      return { kind: 'search', url: 'https://www.google.com/search?q=' + encodeURIComponent(s) };
    }
    // 其它已带协议（http/https/file/about/data/chrome/view-source/blob）→ 原样
    if (RAW_PROTOCOL.test(s)) return { kind: 'raw', url: s };
    // VFS 绝对路径（/home/pyodide/...）→ vfs:// —— 本模块存在的意义
    if (isVfsPath(s)) return { kind: 'vfs', url: toVfsUrl(s) };
    // Windows 盘符 / POSIX 绝对 / UNC → 磁盘路径（调用方转 file://）
    if (/^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{1,2}/.test(s)) return { kind: 'disk', path: s };
    // 形如 domain.tld（含点、无空格）→ https
    if (/^[^\s]+\.[^\s]{2,}(?:[/:?#].*)?$/.test(s)) return { kind: 'web', url: 'https://' + s };
    // 其余按搜索引擎处理
    return { kind: 'search', url: 'https://www.google.com/search?q=' + encodeURIComponent(s) };
  }

  // ── MIME（目录页 / 文件字节都要用；按扩展名，保守默认）───────────────
  var MIME_MAP = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', log: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    zip: 'application/zip'
  };

  function extOf(p) {
    var base = String(p == null ? '' : p).split('/').pop() || '';
    var idx = base.lastIndexOf('.');
    return idx > 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function mimeFromVPath(p) {
    return MIME_MAP[extOf(p)] || 'application/octet-stream';
  }

  // ── HTML（目录列表 / 错误页）：全部转义，防路径名带标签注入 ────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&#39;');
  }

  function humanSize(n) {
    var sz = Number(n);
    if (!isFinite(sz) || sz < 0) return '-';
    if (sz < 1024) return sz + ' B';
    if (sz < 1024 * 1024) return (sz / 1024).toFixed(1) + ' KB';
    return (sz / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 目录列表页：entries = [{ name, isDir, size }]
  function renderDirectoryHtml(vpath, entries) {
    var dir = normalizeVfsPath(vpath) || VFS_ROOT;
    var rows = [];
    if (dir !== VFS_ROOT) {
      var parent = dir.split('/').slice(0, -1).join('/') || '/';
      rows.push('<tr><td><a href="' + escapeHtml(toVfsUrl(parent)) + '">📁 ../</a></td><td>-</td></tr>');
    }
    var list = (entries || []).slice().sort(function (a, b) {
      if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var name = String(e.name == null ? '' : e.name);
      if (!name || name === '.' || name === '..') continue;
      var href = toVfsUrl(joinVfsPath(dir, name));
      rows.push('<tr><td><a href="' + escapeHtml(href) + '">' +
        (e.isDir ? '📁 ' : '📄 ') + escapeHtml(name) + (e.isDir ? '/' : '') +
        '</a></td><td>' + (e.isDir ? '-' : humanSize(e.size)) + '</td></tr>');
    }
    var body = rows.length
      ? '<table>' + rows.join('') + '</table>'
      : '<p class="empty">（空目录）</p>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(dir) + '</title>'
      + '<style>'
      + 'body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#1e1e1e;color:#ddd;margin:0;padding:32px;}'
      + 'h2{font-size:18px;margin:0 0 4px;color:#79c0ff;}'
      + '.hint{color:#8b949e;font-size:12px;margin:0 0 20px;}'
      + 'table{border-collapse:collapse;width:100%;max-width:960px;}'
      + 'td{padding:7px 12px;border-bottom:1px solid #30363d;font-size:14px;}'
      + 'a{color:#58a6ff;text-decoration:none;}a:hover{text-decoration:underline;}'
      + '.empty{color:#8b949e;}'
      + '</style></head><body>'
      + '<h2>📂 ' + escapeHtml(dir) + '</h2>'
      + '<p class="hint">虚拟文件系统（VFS）目录 — ' + (list.length) + ' 项 · <a href="' + escapeHtml(toVfsUrl(VFS_ROOT)) + '">回到工作区根目录</a></p>'
      + body + '</body></html>';
  }

  // 错误页（文件不存在 / 运行时未就绪 …）
  function renderVfsErrorHtml(title, detail) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(title || '无法访问') + '</title>'
      + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#1e1e1e;color:#ddd;padding:48px;}'
      + 'h2{color:#ff7b72;margin:0 0 16px;}code{background:#2b2b2b;padding:2px 6px;border-radius:4px;}</style></head>'
      + '<body><h2>' + escapeHtml(title || '无法访问') + '</h2>'
      + '<p>' + (detail == null ? '' : escapeHtml(String(detail))) + '</p></body></html>';
  }

  return {
    VFS_ROOT: VFS_ROOT,
    slash: slash,
    normalizeVfsPath: normalizeVfsPath,
    isVfsPath: isVfsPath,
    joinVfsPath: joinVfsPath,
    toVfsUrl: toVfsUrl,
    vfsPathFromUrl: vfsPathFromUrl,
    resolveBrowserInput: resolveBrowserInput,
    mimeFromVPath: mimeFromVPath,
    renderDirectoryHtml: renderDirectoryHtml,
    renderVfsErrorHtml: renderVfsErrorHtml
  };
});
