/*!
 * run-collect.js — 真实执行后的「回收」纯逻辑
 * =============================================================================
 * 方案 B 的完整链路是：虚拟 FS → 物化到 <APP_DIR>/workspace/ → 真实执行 → 回收。
 * 前三步由 run:materialize / run:exec 完成；本模块负责最后一环里「哪些文件变了」
 * 的判定（真正的读盘 / 写 vfs 由 main.js 与 03-node-tools.js 完成）。
 *
 * 为什么需要它：
 *   AI 用 run_shell / run_tests 跑的命令（构建脚本、代码生成器、测试快照……）
 *   只改了「物化运行目录」里的文件；almostnode 的虚拟工作区仍是执行前的样子，
 *   于是文件树 / read_file / 后续工具都看不到命令产物。回收就是把真实运行目录里
 *   新增 / 修改 / 删除的文件同步回虚拟 FS。
 *
 * 三条不变量：
 *   1) 只回收清单之外的「变化」——manifest 记录上次物化时每个文件的 sha1，
 *      哈希相同 = 没变，不搬字节（省内存也省 IO）；
 *   2) 「垃圾文件」永不同步回虚拟工作区，否则一次构建/安装就会把大量无意义文件
 *      塞进 IndexedDB。默认拦截：依赖与版本库（node_modules/.git/.hg/.svn）、
 *      构建产物（dist/build/out/target/coverage）、各类缓存（.next/.nuxt/.cache/
 *      .turbo/.vite/__pycache__/.pytest_cache…）、日志与临时文件（*.log/*.tmp/*.swp…）。
 *      规则集中在 DEFAULT_IGNORED_DIRS / _FILES / _GLOBS，可按需扩展（见 isIgnoredRunPath）；
 *   3) 单文件 / 总字节 / 文件数都有上限，超限的文件记入 skipped，并在清单里
 *      删掉其条目 —— 下次物化会用虚拟 FS 的内容重新覆盖，绝不静默丢改动。
 *
 * 纯逻辑、零依赖、UMD（浏览器 window.RunCollect / Node module.exports）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RunCollect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 忽略规则（「垃圾文件」不回收进虚拟空间）────────────────────────────
  // 目录名（任意一层命中即整棵剪枝跳过）。除了依赖/版本库/运行元数据，
  // 重点是拦下「真实执行命令后生成、但不该回灌虚拟 FS」的构建产物与缓存目录。
  var DEFAULT_IGNORED_DIRS = [
    // 依赖 / 版本库 / 运行清单所在目录
    'node_modules', '.git', '.hg', '.svn', '.sandbox',
    // 工具运行期内部目录：结果溢出（spill）/ 运行清单等，不属于项目内容，永不回收进虚拟空间
    '.spill',
    // 常见构建输出
    'dist', 'build', 'out', 'target', 'coverage',
    // 各类工具缓存 / 覆盖率
    '.cache', '.parcel-cache', '.turbo', '.vite', '.nyc_output',
    '.next', '.nuxt', '.output', '.svelte-kit', '.angular', '.astro', '.docusaurus',
    // Python / 测试缓存
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
    // 日志 / 临时目录
    'logs', 'tmp', 'temp',
    // 沙箱运行期目录（sandbox/index.js redirectHome 把 TMP/TEMP/TMPDIR 指到 <ws>/.tmp、
    // HOME 指到 <ws>/.home）。这些是执行副作用，非项目内容，永不回收进虚拟空间。
    // 注意：显式列出 '.tmp'/'..home'，不要只依赖上面的 *.tmp 通配（目录名匹配过脆）。
    '.tmp', '.home',
    // Node 编译缓存在 TMP 下（<tmp>/node-compile-cache），任意层级也一并拦
    'node-compile-cache'
  ];
  // 文件名（精确匹配）：OS / 编辑器 / 运行清单
  var DEFAULT_IGNORED_FILES = [
    '.chatbot-run-manifest.json', '.DS_Store', 'Thumbs.db', 'desktop.ini',
    '.eslintcache', '.stylelintcache'
  ];
  // 文件名通配模式（对路径的每一段做 * / ? 匹配）：日志 / 临时 / 编译中间产物
  var DEFAULT_IGNORED_GLOBS = [
    '*.log', '*.tmp', '*.temp', '*.swp', '*.swo', '*~',
    'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*', 'pnpm-debug.log*',
    '*.pyc', '*.pyo', '*.class', '*.o', '*.obj', '*.orig', '*.rej',
    '*.tsbuildinfo', '*.bak'
  ];
  // 回收上限：避免一次构建把整个 dist / 缓存塞进浏览器的 IndexedDB
  var DEFAULT_LIMITS = {
    maxFiles: 2000,
    maxFileBytes: 4 * 1024 * 1024,      // 单文件 4MB
    maxTotalBytes: 32 * 1024 * 1024     // 单次回收总量 32MB
  };

  // 统一成「工作区相对路径」：正斜杠、去 ./ 与前导 /
  function toRel(rel) {
    var r = String(rel == null ? '' : rel).replace(/\\/g, '/');
    r = r.replace(/^\.\//, '').replace(/^\/+/, '');
    if (r === '.' || r === './') return '';
    return r;
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 把一段路径名（不含分隔符）与通配模式做 * / ? 匹配（大小写不敏感，兼顾 Win/mac）
  function matchGlob(name, glob) {
    var re = '^' + String(glob)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 先转义正则元字符（含 . 与 \）
      .replace(/\*/g, '[^/]*')                // * → 任意非分隔字符
      .replace(/\?/g, '[^/]')                 // ? → 单个非分隔字符
      + '$';
    try { return new RegExp(re, 'i').test(name); } catch (_) { return false; }
  }

  // 列表合并：override 若给了数组则替换默认，extra 永远追加去重
  function resolveList(override, defaults, extra) {
    var base = Array.isArray(override) ? override.slice() : defaults.slice();
    if (Array.isArray(extra)) {
      for (var i = 0; i < extra.length; i++) {
        if (base.indexOf(extra[i]) < 0) base.push(extra[i]);
      }
    }
    return base;
  }

  // 是否属于「永不回收」的路径（依赖目录 / 构建缓存 / 版本库 / 日志临时 / 运行清单本身）
  //   opts.ignoredDirs / ignoredFiles / ignoredGlobs     → 替换对应默认列表
  //   opts.extraIgnoredDirs / extraIgnoredFiles / extraIgnoredGlobs → 在默认之上追加
  function isIgnoredRunPath(rel, opts) {
    var r = toRel(rel);
    if (!r) return true;
    opts = opts || {};
    var dirs = resolveList(opts.ignoredDirs, DEFAULT_IGNORED_DIRS, opts.extraIgnoredDirs);
    var files = resolveList(opts.ignoredFiles, DEFAULT_IGNORED_FILES, opts.extraIgnoredFiles);
    var globs = resolveList(opts.ignoredGlobs, DEFAULT_IGNORED_GLOBS, opts.extraIgnoredGlobs);
    var segs = r.split('/').filter(Boolean);
    for (var i = 0; i < segs.length; i++) {
      if (dirs.indexOf(segs[i]) >= 0) return true;   // 目录名命中（任意一层）
    }
    var base = segs[segs.length - 1];
    if (files.indexOf(base) >= 0) return true;        // 文件名精确命中
    // 通配模式：对每一段（含文件名、目录名）逐个匹配
    for (var s = 0; s < segs.length; s++) {
      for (var g = 0; g < globs.length; g++) {
        if (matchGlob(segs[s], globs[g])) return true;
      }
    }
    return false;
  }

  // 比对「上次物化清单」与「当前磁盘文件」：
  //   entries = [{ rel, hash, size? }]
  //   → { changed, removed, unchanged }（均为工作区相对路径，已排序）
  function diffRunDir(manifest, entries) {
    manifest = manifest || {};
    // 清单键也统一成相对路径（历史数据可能含反斜杠 / 前导 ./），否则会造成假「删除 + 新增」
    var mf = {};
    Object.keys(manifest).forEach(function (k) {
      var r = toRel(k);
      if (r) mf[r] = manifest[k];
    });
    var changed = [], removed = [], unchanged = [];
    var seen = {};
    (entries || []).forEach(function (it) {
      if (!it || !it.rel) return;
      var rel = toRel(it.rel);
      if (!rel) return;
      seen[rel] = true;
      if (!has(mf, rel) || mf[rel] !== it.hash) changed.push(rel);
      else unchanged.push(rel);
    });
    Object.keys(mf).forEach(function (rel) {
      if (!seen[rel]) removed.push(rel);
    });
    changed.sort();
    removed.sort();
    unchanged.sort();
    return { changed: changed, removed: removed, unchanged: unchanged };
  }

  // 按限额从「待回收条目」里挑出真正要搬字节的文件：
  //   items = [{ rel, size }]（顺序即优先级，先到先得）
  //   → { take: [rel], skipped: [rel], bytes }
  function selectCollectable(items, limits) {
    var lim = {};
    var k;
    for (k in DEFAULT_LIMITS) if (has(DEFAULT_LIMITS, k)) lim[k] = DEFAULT_LIMITS[k];
    if (limits) for (k in limits) if (has(limits, k) && limits[k] != null) lim[k] = limits[k];

    var take = [], skipped = [], bytes = 0;
    (items || []).forEach(function (it) {
      if (!it || !it.rel) return;
      var rel = toRel(it.rel);
      if (!rel) return;
      var size = Number(it.size);
      if (!isFinite(size) || size < 0) size = 0;
      if (take.length >= lim.maxFiles) { skipped.push(rel); return; }
      if (size > lim.maxFileBytes || (bytes + size) > lim.maxTotalBytes) {
        skipped.push(rel);
        return;
      }
      take.push(rel);
      bytes += size;
    });
    return { take: take, skipped: skipped, bytes: bytes };
  }

  // 生成回收后的新清单：
  //   · collected: { rel: hash } → 采用磁盘新哈希
  //   · removed:   [rel]        → 磁盘上已不存在，清单删条目
  //   · skipped:   [rel]        → 本次没搬（超限），清单也删条目，
  //                                下次物化会用虚拟 FS 内容重新覆盖，避免「清单说没变、盘上却是新内容」
  function buildNextManifest(manifest, update) {
    var next = {};
    manifest = manifest || {};
    Object.keys(manifest).forEach(function (k) {
      var r = toRel(k);
      if (r) next[r] = manifest[k];
    });
    update = update || {};
    var collected = update.collected || {};
    Object.keys(collected).forEach(function (rel) {
      var r = toRel(rel);
      if (r) next[r] = collected[rel];
    });
    (update.removed || []).forEach(function (rel) {
      var r = toRel(rel);
      if (r) delete next[r];
    });
    (update.skipped || []).forEach(function (rel) {
      var r = toRel(rel);
      if (r) delete next[r];
    });
    return next;
  }

  // 路径通配匹配（给白名单 includeGlobs 用）：
  //   · 含 '/' 视为「路径模式」：** 跨目录、* 单段、? 单字符
  //   · 不含 '/' 视为「文件名模式」：只匹配最后一段（与 isIgnoredRunPath 的通配一致）
  function matchAnyGlob(rel, glob) {
    var g = String(glob == null ? '' : glob);
    var r = toRel(rel);
    if (g.indexOf('/') < 0) {
      var base = r.split('/').pop();
      return matchGlob(base, g);
    }
    var re = '^' + g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]')
      + '$';
    try { return new RegExp(re, 'i').test(r); } catch (_) { return false; }
  }

  // ── 逻辑保证：从「来源」决定一个文件能否进入虚拟空间（白名单准入）──────────
  //   ctx = {
  //     baseline: Set|Array —— 已存在于虚拟空间/物化清单里的项目文件（相对路径）
  //     allowNew: boolean  —— 是否允许「命令新生成」的文件进入（默认 false）
  //     includeGlobs: string[] —— allowNew=true 时的进一步收窄（空=不限）
  //     ignores: isIgnoredRunPath 的 opts —— 已知垃圾黑名单（纵深防御，永远先拦）
  //   }
  //   规则（与文件名无关，结构性保证「只出现有必要的新增/编辑」）：
  //     1) 已知垃圾（.tmp/.home/node_modules/缓存…）—— 永远拒绝；
  //     2) 已有项目文件的「编辑/删除」—— 永远允许（这是必要的编辑）；
  //     3) 「新增」文件—— 默认一律拒绝；仅当 allowNew=true 才放行（可选 includeGlobs 收窄）。
  function isAdmitted(rel, ctx) {
    var r = toRel(rel);
    if (!r) return false;
    ctx = ctx || {};
    if (isIgnoredRunPath(r, ctx.ignores)) return false;
    var base = ctx.baseline;
    var isBase = false;
    if (base && typeof base.has === 'function') isBase = base.has(r);
    else if (Array.isArray(base)) isBase = base.indexOf(r) >= 0;
    if (isBase) return true;
    if (!ctx.allowNew) return false;
    var inc = Array.isArray(ctx.includeGlobs) ? ctx.includeGlobs : [];
    if (!inc.length) return true;
    for (var i = 0; i < inc.length; i++) {
      if (matchAnyGlob(r, inc[i])) return true;
    }
    return false;
  }

  return {
    DEFAULT_IGNORED_DIRS: DEFAULT_IGNORED_DIRS,
    DEFAULT_IGNORED_FILES: DEFAULT_IGNORED_FILES,
    DEFAULT_IGNORED_GLOBS: DEFAULT_IGNORED_GLOBS,
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    toRel: toRel,
    matchGlob: matchGlob,
    matchAnyGlob: matchAnyGlob,
    isIgnoredRunPath: isIgnoredRunPath,
    isAdmitted: isAdmitted,
    diffRunDir: diffRunDir,
    selectCollectable: selectCollectable,
    buildNextManifest: buildNextManifest
  };
});
