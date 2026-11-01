/*!
 * kb-source.js — 知识库「本地路径」数据源（Local Folder Source）
 * =============================================================================
 * 目标：把磁盘上的某个文件夹配置为知识库的数据源 ——
 *   选择文件夹 → 递归扫描（按扩展名过滤）→ 逐篇读取正文 → 摄取入库 →
 *   提问即在该路径的内容上作答（复用 kb-search/kb-qa 的引用问答链路）。
 *
 * 设计要点：
 *   · 配置按知识库维度存 meta（key = `kb.source.<kbId>`）：rootPath /
 *     includeExts / subdirs / maxFiles / maxFileBytes / autoSyncOnStart /
 *     lastSyncAt / lastSummary；
 *   · 幂等：sourceKey = 文件绝对路径，内容寻址由 kb-store.documents.upsert
 *     负责（内容不变 → changed=false，不重建分块）；重复「扫描并同步」
 *     安全无副作用；
 *   · 增量：文件被删除 → 对应文档 status=disabled（**不删除**，检索自动
 *     排除、可恢复）；文件回来 → 自动重新生效；
 *   · 双向同步扫描结果：仅当本次扫描未被截断（truncated=false）才判定
 *     「缺失」，避免「扫描到一半」误停用大量文档；
 *   · 解耦：真实文件系统经 driver 抽象（浏览器默认走 window.fileAPI：
 *     pickDirectory / scanDir / read），Node 测试注入内存 driver；
 *     正文解析复用 renderer 的 anydoc（PDF/Office → Markdown）与
 *     TextDecoder / DOMParser，不引入新依赖；
 *   · 健康检查：批量摄取传 opts.skipHealth=true，改由外部注入的
 *     healthProvider 统一调度（避免逐篇触发检测器风暴）。
 *
 * UMD：浏览器挂 globalThis.KBSource，Node 下 module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  function safeRequire(p) { try { return require(p); } catch (_) { return null; } }
  var deps = null;
  if (typeof module !== 'undefined' && module.exports) {
    deps = { store: require('./kb-store.js'), ingest: require('./kb-ingest.js') };
  } else {
    deps = { store: root.KBStore, ingest: root.KBIngest };
  }
  var api = factory(deps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KBSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var store = deps.store;
  var ingest = deps.ingest;

  var META_PREFIX = 'kb.source.';
  var VERSION = '1.0.0';

  // 纯文本（直接 UTF-8 解码）
  var TEXT_EXTS = ['.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv',
    '.json', '.xml', '.yml', '.yaml', '.ini', '.conf', '.rst', '.tex', '.sql', '.sh'];
  // HTML（去标签）
  var HTML_EXTS = ['.html', '.htm', '.xhtml'];
  // 富文档（走 anydoc → Markdown）
  var OFFICE_EXTS = ['.pdf', '.doc', '.docx', '.odt', '.ppt', '.pptx', '.odp',
    '.rtf', '.epub', '.xls', '.xlsx', '.ods'];
  // 默认纳入的扩展名
  var DEFAULT_EXTS = TEXT_EXTS.concat(HTML_EXTS).concat(OFFICE_EXTS);

  var DEFAULTS = {
    rootPath: '',
    includeExts: DEFAULT_EXTS.slice(),
    subdirs: true,
    maxFiles: 300,
    maxFileBytes: 4 * 1024 * 1024,   // 单文件上限 4MB（超出跳过并报告）
    autoSyncOnStart: false,
    lastScanAt: 0,
    lastSyncAt: 0,
    lastSummary: null
  };

  var driver = null;
  var onHealth = null;   // (kbId, docId) => Promise（kb-bootstrap 注入）

  // ── 路径 / 文件小工具 ────────────────────────────────────────────────────
  function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  }
  function extOf(name) {
    var m = /(\.[A-Za-z0-9]+)$/.exec(String(name == null ? '' : name));
    return m ? m[1].toLowerCase() : '';
  }
  function baseName(p) {
    var n = normPath(p);
    var i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
  }
  function stripExt(name) { return String(name == null ? '' : name).replace(/\.[^.]+$/, ''); }
  function hasExt(name, exts) { return exts.indexOf(extOf(name)) >= 0; }

  // ── driver：真实文件系统的默认实现（window.fileAPI）─────────────────────
  function webDriver() {
    return {
      kind: 'electron-fileAPI',
      available: function () {
        return !!(typeof window !== 'undefined' && window.fileAPI &&
          typeof window.fileAPI.scanDir === 'function');
      },
      pickDirectory: function () {
        if (typeof window === 'undefined' || !window.fileAPI ||
          typeof window.fileAPI.pickDirectory !== 'function') return Promise.resolve(null);
        return Promise.resolve(window.fileAPI.pickDirectory()).then(function (r) {
          if (!r) return null;
          if (typeof r === 'string') return r;
          if (r.canceled || r.ok === false) return null;
          return r.path || null;
        });
      },
      scan: function (rootPath, opts) {
        return Promise.resolve(window.fileAPI.scanDir(rootPath, opts || {})).then(function (res) {
          if (res && res.ok === false) throw new Error(res.error || '扫描失败');
          return res;
        });
      },
      readBytes: function (p) { return Promise.resolve(window.fileAPI.read(p)); }
    };
  }

  function getDriver() { if (!driver) driver = webDriver(); return driver; }
  function setDriver(d) { driver = d || null; }

  // ── 配置读写（meta：kb.source.<kbId>）───────────────────────────────────
  function readConfig(kbId) {
    var raw = store.meta.get(META_PREFIX + kbId);
    var cfg = Object.assign({}, DEFAULTS, (raw && typeof raw === 'object') ? raw : {});
    if (!Array.isArray(cfg.includeExts) || !cfg.includeExts.length) cfg.includeExts = DEFAULT_EXTS.slice();
    cfg.includeExts = cfg.includeExts.map(function (x) { return String(x).toLowerCase(); });
    cfg.maxFiles = Math.max(1, Number(cfg.maxFiles) || DEFAULTS.maxFiles);
    cfg.maxFileBytes = Math.max(0, Number(cfg.maxFileBytes) || DEFAULTS.maxFileBytes);
    return cfg;
  }
  function writeConfig(kbId, patch) {
    var next = Object.assign({}, readConfig(kbId), patch || {});
    if (patch && patch.includeExts) {
      next.includeExts = patch.includeExts.map(function (x) { return String(x).toLowerCase(); });
    }
    return store.meta.set(META_PREFIX + kbId, next).then(function () { return next; });
  }

  // ── 字节 / 文本 ─────────────────────────────────────────────────────────
  function toU8(bytes) {
    if (!bytes) return new Uint8Array(0);
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined') {
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      if (ArrayBuffer.isView && ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    }
    if (typeof bytes === 'string') {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(bytes);
      var a = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) a[i] = bytes.charCodeAt(i) & 0xff;
      return a;
    }
    if (Array.isArray(bytes)) return Uint8Array.from(bytes);
    try { return Uint8Array.from(Object.values(bytes)); } catch (_) { return new Uint8Array(0); }
  }

  function decodeText(bytes) {
    var u8 = toU8(bytes);
    try { return new TextDecoder('utf-8').decode(u8); } catch (_) { /* 极老内核 */ }
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function stripHtml(html) {
    var s = String(html == null ? '' : html);
    if (typeof DOMParser !== 'undefined') {
      try {
        var doc = new DOMParser().parseFromString(s, 'text/html');
        if (doc.querySelectorAll) {
          var junk = doc.querySelectorAll('script,style,noscript');
          for (var i = 0; i < junk.length; i++) {
            if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
          }
        }
        var t = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
        if (t && t.trim()) return t;
      } catch (_) { /* 兜底走正则 */ }
    }
    return s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  // anydoc 解析器（WASM 异步 instantiate 后才注入，见 whenAnydocReady）
  function anydocParser() {
    if (typeof window === 'undefined') return null;
    var fn = window.__undocParse || window.__anydocParse;
    return typeof fn === 'function' ? fn : null;
  }

  /**
   * whenAnydocReady(ms) — 等待 anydoc WASM 就绪（__undocParse 注入）。
   * Office/PDF 摄取前调用：anydoc 是异步 instantiate，启动即同步/导入时
   * 可能尚未就绪，直接解析会误报「不支持该格式」。Node 测试环境立即 false。
   * 返回 Promise<boolean>。
   */
  function whenAnydocReady(ms) {
    if (anydocParser()) return Promise.resolve(true);
    if (typeof window === 'undefined' || typeof setInterval !== 'function') return Promise.resolve(false);
    var timeout = Math.max(0, Number(ms) || 10000);
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (anydocParser()) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 >= timeout) { clearInterval(iv); resolve(false); }
      }, 100);
    });
  }

  /**
   * extractText(name, bytes) → { text, format, unsupported? }
   *   · office/pdf → anydoc（window.__undocParse）→ **Markdown**
   *   · html      → 去标签
   *   · 其余      → UTF-8 文本
   */
  function extractText(name, bytes) {
    var ext = extOf(name);
    if (OFFICE_EXTS.indexOf(ext) >= 0) {
      var parse = anydocParser();
      if (parse) {
        try {
          var res = parse(toU8(bytes));
          var fmt = (res.format && res.format()) || ext.slice(1);
          var md = res.toMarkdown ? res.toMarkdown() : '';
          if (!md || !String(md).trim()) md = res.toText ? res.toText() : '';
          return { text: String(md || ''), format: String(fmt || ext.slice(1)) };
        } catch (e) {
          return { text: '', format: ext.slice(1), unsupported: true, error: String(e && e.message || e) };
        }
      }
      // 无 anydoc（如 Node 测试 / WASM 未就绪）→ 富文档不可解析
      return { text: '', format: ext.slice(1), unsupported: true };
    }
    if (HTML_EXTS.indexOf(ext) >= 0) return { text: stripHtml(decodeText(bytes)), format: 'html' };
    return { text: decodeText(bytes), format: ext ? ext.slice(1) : 'text' };
  }

  // ── 扫描（只列文件，不读正文）────────────────────────────────────────────
  function scan(kbId, opts) {
    opts = opts || {};
    var cfg = readConfig(kbId);
    var rootPath = opts.rootPath != null ? String(opts.rootPath) : cfg.rootPath;
    if (!rootPath) return Promise.reject(new Error('尚未配置本地路径'));
    var exts = (opts.includeExts || cfg.includeExts).map(function (x) { return String(x).toLowerCase(); });
    var d = getDriver();
    if (!d || typeof d.scan !== 'function') {
      return Promise.reject(new Error('当前环境不支持目录扫描（需 Electron 外壳）'));
    }
    if (typeof d.available === 'function' && !d.available()) {
      return Promise.reject(new Error('当前环境无文件系统访问（需 Electron 外壳）'));
    }
    return Promise.resolve(d.scan(rootPath, {
      subdirs: cfg.subdirs,
      maxFiles: opts.maxFiles || cfg.maxFiles,
      exts: exts
    })).then(function (res) {
      var files = Array.isArray(res) ? res : ((res && res.files) || []);
      var out = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var p = typeof f === 'string' ? f : (f && (f.path || f.filePath || f.fullPath));
        if (!p) continue;
        var name = (f && f.name) || baseName(p);
        if (!hasExt(name, exts)) continue;
        out.push({
          path: p,
          name: name,
          ext: extOf(name),
          size: (f && f.size) || 0,
          mtimeMs: (f && f.mtimeMs) || 0
        });
      }
      return {
        rootPath: rootPath,
        files: out,
        total: out.length,
        scanned: Array.isArray(res) ? res.length : ((res && res.scanned) || files.length),
        truncated: !!(res && res.truncated)
      };
    });
  }

  function docIdOf(kbId, sourceKey) { return 'doc-' + store.stableId(kbId + '|' + sourceKey); }

  function readAndIngest(kbId, file, opts) {
    var d = getDriver();
    if (!d || typeof d.readBytes !== 'function') return Promise.reject(new Error('driver 不支持读取文件'));
    var docId = docIdOf(kbId, file.path);
    var isNew = !store.documents.get(docId);
    return Promise.resolve(d.readBytes(file.path)).then(function (bytes) {
      var isOffice = OFFICE_EXTS.indexOf(extOf(file.name)) >= 0;
      // Office/PDF → 先等 anydoc 就绪，再统一转 Markdown 摄取
      var exP = isOffice
        ? whenAnydocReady().then(function (ok) {
            return ok ? extractText(file.name, bytes)
              : { text: '', format: extOf(file.name).slice(1), unsupported: true };
          })
        : Promise.resolve(extractText(file.name, bytes));
      return exP.then(function (ex) {
        if (ex.unsupported) throw new Error('无法解析该格式（' + (ex.format || file.ext) + '）');
        if (!String(ex.text || '').trim()) throw new Error('文件无可提取正文');
        return ingest.ingest({
          kbId: kbId,
          title: stripExt(file.name),
          text: ex.text,
          sourceKey: file.path,       // 路径作幂等键
          sourcePath: file.path,
          sourceType: 'file',
          skipHealth: true            // 批量同步：健康检查由 provider 统一调度
        });
      }).then(function (r) {
        r.isNew = isNew;
        if (onHealth && r.changed) {
          try {
            var p = onHealth(kbId, r.doc.id);
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (_) { /* 健康检查失败不影响同步 */ }
        }
        return r;
      });
    });
  }

  // 扫描后磁盘上已不存在的「本地文档」→ status=disabled（不删除，可恢复）
  function markMissing(kbId, cfg, seen, opts) {
    if (opts.markMissing === false) return Promise.resolve(0);
    var root = normPath(cfg.rootPath);
    var victims = store.kbs.documents(kbId).filter(function (doc) {
      if (doc.sourceType !== 'file' || !doc.sourcePath) return false;
      var sp = normPath(doc.sourcePath);
      var underRoot = sp === root || sp.indexOf(root + '/') === 0;
      if (!underRoot) return false;
      if (doc.status !== store.DOC_STATUS.ACTIVE) return false;
      return !seen[sp];
    });
    var chain = Promise.resolve();
    victims.forEach(function (doc) {
      chain = chain.then(function () {
        return store.documents.patch(doc.id, {
          status: store.DOC_STATUS.DISABLED,
          disabledReason: 'file-missing',
          disabledAt: Date.now()
        });
      });
    });
    return chain.then(function () { return victims.length; });
  }

  /**
   * sync(kbId, opts) — 扫描 + 逐篇摄取 + 停用缺失文件。
   * opts.limit        本次最多处理多少个文件（默认取 cfg.maxFiles）
   * opts.maxFileBytes 单文件字节上限覆盖
   * opts.markMissing  false 时不停用缺失文档
   * 返回 summary：{ total, added, updated, unchanged, failed, skipped, missing, truncated, docs[], errors[] }
   */
  function sync(kbId, opts) {
    opts = opts || {};
    if (!store.kbs.get(kbId)) return Promise.reject(new Error('知识库不存在: ' + kbId));
    var cfg = readConfig(kbId);
    var summary = {
      kbId: kbId, rootPath: cfg.rootPath,
      total: 0, added: 0, updated: 0, unchanged: 0,
      failed: 0, skipped: 0, missing: 0, truncated: false,
      docs: [], errors: [], startedAt: Date.now(), durationMs: 0
    };
    var seen = {};
    var startedAt = Date.now();

    return scan(kbId, opts).then(function (res) {
      summary.rootPath = res.rootPath;
      summary.truncated = !!res.truncated;
      var files = res.files;
      var limit = Math.max(1, Number(opts.limit) || cfg.maxFiles);
      if (files.length > limit) { summary.truncated = true; files = files.slice(0, limit); }
      summary.total = files.length;

      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          seen[normPath(f.path)] = true;
          var maxBytes = opts.maxFileBytes != null ? opts.maxFileBytes : cfg.maxFileBytes;
          if (maxBytes && f.size && f.size > maxBytes) {
            summary.skipped++;
            summary.errors.push({ path: f.path, reason: '文件过大 ' + f.size + 'B' });
            return;
          }
          summary.docs.push(f.path);
          return readAndIngest(kbId, f, opts).then(function (r) {
            if (r.changed) { if (r.isNew) summary.added++; else summary.updated++; }
            else summary.unchanged++;
          }, function (err) {
            summary.failed++;
            summary.errors.push({ path: f.path, reason: String((err && err.message) || err) });
          });
        });
      });

      return chain.then(function () {
        // 扫描被截断时不做「缺失」判定（避免误停用）
        if (summary.truncated) return 0;
        return markMissing(kbId, cfg, seen, opts);
      }).then(function (n) {
        summary.missing = n;
        summary.durationMs = Date.now() - startedAt;
        // 落库的 summary 精简（文件清单/错误列表截断，避免 meta 膨胀）
        var compact = Object.assign({}, summary, {
          docs: (summary.docs || []).slice(0, 100),
          errors: (summary.errors || []).slice(0, 50)
        });
        return writeConfig(kbId, {
          lastScanAt: Date.now(),
          lastSyncAt: Date.now(),
          lastSummary: compact
        });
      }).then(function () { return summary; });
    });
  }

  /**
   * status(kbId) — 面板/工具展示：配置 + 本地文档计数。
   */
  function status(kbId) {
    var cfg = readConfig(kbId);
    var docs = (kbId && store.kbs.get(kbId)) ? store.kbs.documents(kbId) : [];
    var fileDocs = docs.filter(function (d) { return d.sourceType === 'file'; });
    var active = fileDocs.filter(function (d) { return d.status === store.DOC_STATUS.ACTIVE; });
    var d = getDriver();
    return {
      kbId: kbId,
      version: VERSION,
      rootPath: cfg.rootPath,
      includeExts: cfg.includeExts,
      subdirs: cfg.subdirs,
      maxFiles: cfg.maxFiles,
      autoSyncOnStart: cfg.autoSyncOnStart,
      lastScanAt: cfg.lastScanAt,
      lastSyncAt: cfg.lastSyncAt,
      lastSummary: cfg.lastSummary,
      driverKind: (d && d.kind) || '',
      driverAvailable: !!(d && (typeof d.available !== 'function' || d.available())),
      docs: fileDocs.length,
      activeDocs: active.length,
      disabledDocs: fileDocs.length - active.length
    };
  }

  function pickDirectory() {
    var d = getDriver();
    if (!d || typeof d.pickDirectory !== 'function') return Promise.resolve(null);
    return Promise.resolve(d.pickDirectory());
  }

  return {
    VERSION: VERSION,
    META_PREFIX: META_PREFIX,
    DEFAULTS: DEFAULTS,
    TEXT_EXTS: TEXT_EXTS,
    HTML_EXTS: HTML_EXTS,
    OFFICE_EXTS: OFFICE_EXTS,
    DEFAULT_EXTS: DEFAULT_EXTS,
    getDriver: getDriver,
    setDriver: setDriver,
    setHealthProvider: function (fn) { onHealth = (typeof fn === 'function') ? fn : null; },
    readConfig: readConfig,
    writeConfig: writeConfig,
    pickDirectory: pickDirectory,
    scan: scan,
    sync: sync,
    status: status,
    extractText: extractText,
    whenAnydocReady: whenAnydocReady,
    normPath: normPath,
    extOf: extOf,
    isSupported: function (name, exts) { return hasExt(name, exts || DEFAULT_EXTS); }
  };
});
