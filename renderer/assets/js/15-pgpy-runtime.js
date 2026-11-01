        // ══════════════════════════════════════════════════════════════
        //  Node.js Engine (almostnode) — 在浏览器里运行 Node.js
        //  代码执行与 /home/pyodide 工作区文件读写全部由 almostnode 提供（Node.js in the browser）。
        // ══════════════════════════════════════════════════════════════
        //  PGPy State
        // ══════════════════════════════════════════════════════════════
        let pgpyEnginesStarted = false;
        let pgpyAiMode = false;
        let pgpyFsPersisted = false;
        let pgpyCurrentFilePath = null; // 双击文件行载入编辑器后,保存(Save File)时写入的路径
        let pgpyCurrentFileFromBinary = false; // 当前编辑内容是否由 Office/PDF 二进制解析而来(保存前需确认)

        let pgpyIdbfsMount = null;
        let pgpyEditor = null;
        let pgpyMode = 'node';
        let pgpyLastResult = null;
        let pgpySortState = { col: null, asc: true };
        let pgpySelectedFiles = new Set(); // 表格中勾选待删除的文件路径
        let pgpyDiffSyncChecked = new Set(); // ⇄ 对比弹窗内「待同步文件」清单里勾选的文件（供一键同步）

        // ══════════════════════════════════════════════════════════════
        //  nodeRuntime —— almostnode（浏览器内 Node.js）运行时封装
        //   · createContainer() 提供文件系统（VirtualFS）+ Node 内置模块；
        //     传入 { persistence: { dbName, storeName } } 后，VirtualFS 会把
        //     /home/pyodide 的内容持久化到 IndexedDB（写操作自动落盘 + 启动时恢复），
        //     刷新页面文件仍在；createContainer() 返回的 vfsReady 表示恢复完成。
        //   · FS：把 nodeRuntime.FS 的调用面（readFile/writeFile/mkdirTree/readdir/
        //         stat/unlink/rmdir/isDir/isFile/syncfs…）映射到 almostnode VirtualFS
        //   · syncFS()/saveSnapshot()：把内存树增量/全量刷入 IndexedDB
        //   · execute(code)：同步执行 Node 代码并捕获 console 输出
        // ══════════════════════════════════════════════════════════════
        const NODE_FS_SNAPSHOT_KEY = 'almostnode_fs_snapshot'; // 旧版 localStorage 快照键（仅用于迁移）

        // ── 工作区「内部目录/文件」判定 ─────────────────────────────
        // 这些是工具运行期产物（如工具结果溢出 spill、运行清单），不是用户项目内容。
        // 文件树列表 / 物化执行 / 导出 ZIP / 回收 都统一跳过，避免它们「出现在虚拟空间」
        // 或被当成项目改动来回同步，污染整个工程。
        // 除工具溢出目录 .spill 外，还包括沙箱运行期目录：
        //   .tmp / .home 由 sandbox/index.js redirectHome 把 TMP/TEMP/TMPDIR 与 HOME 指到工作区内生成；
        //   .sandbox 为沙箱审计目录；node-compile-cache 为 Node 编译缓存。
        // 它们都是命令执行的副作用，不属于用户项目，统一在 文件树/物化/导出/回收 中跳过。
        const PGPY_INTERNAL_DIRS = ['.spill', '.tmp', '.home', '.sandbox', 'node-compile-cache'];
        const PGPY_INTERNAL_FILES = ['.chatbot-run-manifest.json'];
        function pgpyIsInternalName(name) {
          if (!name) return false;
          const n = String(name);
          return PGPY_INTERNAL_DIRS.indexOf(n) >= 0 || PGPY_INTERNAL_FILES.indexOf(n) >= 0;
        }
        // 传入任意路径（相对或 /home/pyodide 绝对），判断是否命中内部目录/文件
        function pgpyIsInternalPath(p) {
          if (!p) return false;
          const segs = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
          for (let i = 0; i < segs.length; i++) {
            if (pgpyIsInternalName(segs[i])) return true;
          }
          return false;
        }

        function createNodeFS(vfs) {
          const MODE_DIR = 0o040755;
          const MODE_FILE = 0o100644;
          const toBytes = (data) => {
            if (data instanceof Uint8Array) return data;
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
            return String(data == null ? '' : data);
          };
          return {
            filesystems: { IDBFS: 'IDBFS' },
            mount() { return undefined; },
            syncfs(populate, cb) { if (typeof cb === 'function') cb(null); return undefined; },
            mkdirTree(path) { try { vfs.mkdirSync(path, { recursive: true }); } catch (_) {} },
            mkdir(path) { vfs.mkdirSync(path); },
            writeFile(path, data) { vfs.writeFileSync(path, toBytes(data)); },
            readFile(path, opts) {
              const encoding = opts && (opts.encoding || opts);
              const raw = vfs.readFileSync(path);
              if (encoding === 'utf8' || encoding === 'utf-8' || encoding === 'utf8string') {
                return new TextDecoder().decode(raw);
              }
              return new Uint8Array(raw);
            },
            readdir(path) { return vfs.readdirSync(path); },
            exists(path) { return vfs.existsSync(path); },
            stat(path) {
              const st = vfs.statSync(path);
              return {
                mode: st.isDirectory() ? MODE_DIR : (st.isFile() ? MODE_FILE : st.mode),
                size: st.size,
                mtime: st.mtime,
                mtimeMs: st.mtimeMs,
                isDirectory: () => st.isDirectory(),
                isFile: () => st.isFile()
              };
            },
            isDir(mode) { return (mode & 0o170000) === 0o040000; },
            isFile(mode) { return (mode & 0o170000) === 0o100000; },
            unlink(path) { vfs.unlinkSync(path); },
            rmdir(path) { vfs.rmdirSync(path); }
          };
        }

        // ── run_node 兼容修复（读取 /home/pyodide 文件失败的两类根因）──────────────
        // 1) 合成模块路径：过去用户代码以 /tmp/__almostnode_run__.js 执行，导致
        //    __dirname='/tmp'、相对 require/import 的解析基准也是 /tmp，读 /home/pyodide
        //    下「相对路径 / __dirname 拼接」的文件全部失败。改根到工作区根 /home/pyodide
        //    （= 容器的 process.cwd()），让 __dirname/__filename/require/import 全部对齐。
        const PGPY_RUN_FILENAME = '/home/pyodide/__almostnode_run__.js';

        // 2) xlsx 文件级 API 桥接：随包附带的 xlsx 是浏览器构建、内部 Node fs 句柄被置空，
        //    XLSX.readFile/writeFile 必报 "Cannot access file"。桥接实现见 xlsx-fs-bridge.js
        //    （UMD，浏览器挂 window.PgpyXlsxFsBridge；其函数源码会被注入沙箱内执行）。

        const nodeRuntime = {
          ready: false,
          container: null,
          vfs: null,
          FS: null,
          _hook: null,
          _initPromise: null,
          _libFixed: false,

          init() {
            if (!this._initPromise) this._initPromise = this._doInit();
            return this._initPromise;
          },
          async _doInit() {
            if (this.ready) return;
            if (!(window.almostnode && typeof window.almostnode.createContainer === 'function')) {
              throw new Error('almostnode runtime not loaded (./almostnode.global.js)');
            }
            // 开启 IndexedDB 持久化：createContainer 会返回 vfsReady（从 IndexedDB 恢复完成）
            this.container = window.almostnode.createContainer({
              cwd: '/home/pyodide',
              onConsole: (method, args) => { if (this._hook) this._hook(method, args); },
              persistence: { dbName: 'almostnode-vfs', storeName: 'files', version: 1 }
            });
            this.vfs = this.container.vfs;
            this.FS = createNodeFS(this.vfs);
            this.FS.mkdirTree('/home/pyodide');
            // 等待 IndexedDB 中的文件系统恢复完成后再对外提供服务（刷新页面文件仍在）
            if (this.container && this.container.vfsReady) {
              try { await this.container.vfsReady; } catch (_) {}
            }
            pgpyFsPersisted = true;
            this.ready = true;
            // 兼容旧版：首次升级时把 localStorage 快照迁移进 IndexedDB
            try { this.migrateLegacySnapshot(); } catch (_) {}
            // ★ 在 IndexedDB 恢复/迁移完成之后再安装同步钩子：避免“恢复/迁移”本身的 vfs 写入
            //   被误当成一次编辑，而把旧内容回写覆盖磁盘上的真实文件。
            try { pgpyInstallVfsHooks(this.vfs); } catch (e) { console.warn('[pgpy] 安装 vfs 同步钩子失败:', e); }
            console.log('[pgpy] almostnode Node runtime ready (cwd=/home/pyodide, IndexedDB persistence)');
          },

          // 执行容器代码，但抑制「恰好是合成文件名」的那次 writeFileSync（其余写入原样透传），
          // 避免把 wrapper 源码写进 /home/pyodide，造成 readdir/IndexedDB/待同步队列污染。
          _executeSuppressSynthetic(code, runFile) {
            var vfs = this.vfs, orig = vfs && vfs.writeFileSync, skipped = false;
            if (vfs && typeof orig === 'function') {
              vfs.writeFileSync = function (p) {
                if (!skipped && p === runFile) { skipped = true; return undefined; }
                return orig.apply(this, arguments);
              };
            }
            try {
              return this.container.execute(code, runFile);
            } finally {
              if (vfs && typeof orig === 'function') vfs.writeFileSync = orig;
            }
          },

          // 运行期依赖修复：浏览器构建的 xlsx 缺 fs → 把文件级 API 桥接到 VFS fs（幂等，仅首次）。
          //   把 bridgeXlsxFileApi 的函数源码注入沙箱内执行，令其拿到沙箱里的 require('xlsx')/require('fs')。
          _applyNodeLibFixes() {
            if (this._libFixed) return;
            this._libFixed = true;
            try {
              var bridgeFn = (typeof window !== 'undefined' && window.PgpyXlsxFsBridge && window.PgpyXlsxFsBridge.bridgeXlsxFileApi) ? window.PgpyXlsxFsBridge.bridgeXlsxFileApi : null;
              if (!bridgeFn) return;
              var script = 'try { (' + bridgeFn.toString() + ')(require("xlsx"), require("fs")); } catch (e) { /* xlsx 不可用则跳过 */ }';
              this._executeSuppressSynthetic(script, '/tmp/__pgpy_libfix__.js');
            } catch (_) { /* 缺 xlsx / 环境差异不影响主流程 */ }
          },

          // 同步执行 Node 代码；返回 { logs, exports, module, error }
          execute(code, filename) {
            try { this._applyNodeLibFixes(); } catch (_) {}
            const logs = [];
            this._hook = (method, args) => {
              // 图片/二进制参数 → 描述文本 + 收集为 image 内容项（避免 utf8 乱码）
              const imgs = [];
              const text = (args || []).map((a) => {
                if (typeof a === 'string') return a;
                const desc = (typeof pgpyDescribeBinaryArg === 'function') ? pgpyDescribeBinaryArg(a, imgs) : null;
                return desc || safeStringify(a);
              }).join(' ');
              const stream = (method === 'error' || method === 'warn') ? 'stderr' : 'stdout';
              const entry = { stream: stream, text: (method === 'warn' ? '[warn] ' : '') + text };
              if (imgs.length) entry.images = imgs;
              logs.push(entry);
            };

            let result = null, error = null;
            try {
              result = this._executeSuppressSynthetic(code, filename || PGPY_RUN_FILENAME);
            } catch (e) {
              error = e;
            } finally {
              this._hook = null;
            }
            return { logs: logs, exports: result ? result.exports : undefined, module: result ? result.module : null, error: error };
          },

          // 异步执行 Node 代码：支持顶层 await，并把「游离」的异步输出也捕获进来。
          // 原理：
          //   1) prelude 在沙箱内追踪 setTimeout/setInterval 的待办数（__pgpyPending），
          //      并把 process.stdout/stderr.write 也转发到 console（走 onConsole 钩子）。
          //   2) 用户代码包进 async IIFE（promise 挂在 module.__pgpy_async__，避免被用户的
          //      module.exports 覆盖），promise 在 _hook 存活期间被 await。
          //   3) epilogue 等所有待办异步任务排空（连续两次 10ms 静默或 3s 上限）后才结束，
          //      因此「没有 return / await 的 setTimeout、setInterval、回调里的 promise」也能被捕获。
          // 返回 { logs, exports, module, error }。
          async executeAsync(code, filename) {
            try { this._applyNodeLibFixes(); } catch (_) {}
            const logs = [];
            this._hook = (method, args) => {
              // 图片/二进制参数 → 描述文本 + 收集为 image 内容项（避免 utf8 乱码）
              const imgs = [];
              const text = (args || []).map((a) => {
                if (typeof a === 'string') return a;
                const desc = (typeof pgpyDescribeBinaryArg === 'function') ? pgpyDescribeBinaryArg(a, imgs) : null;
                return desc || safeStringify(a);
              }).join(' ');
              const stream = (method === 'error' || method === 'warn') ? 'stderr' : 'stdout';
              const entry = { stream: stream, text: (method === 'warn' ? '[warn] ' : '') + text };
              if (imgs.length) entry.images = imgs;
              logs.push(entry);
            };


            // ── prelude：沙箱内一次性安装「计时器追踪 + stdio 捕获」（幂等）──
            //   注意：内层用 charCodeAt(10) 去除行尾换行，避免多层字符串转义问题。
            const PGPY_PRELUDE = `
(function () {
  var g = globalThis;
  if (!g.__pgpyOrig) {
    g.__pgpyOrig = { setTimeout: g.setTimeout, setInterval: g.setInterval, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval };
    g.setTimeout = function (fn, ms) {
      var args = Array.prototype.slice.call(arguments, 2);
      var id = g.__pgpyOrig.setTimeout(function () {
        g.__pgpyTimers.delete(id);
        try { fn.apply(null, args); } catch (e) { console.error((e && e.stack) || e); }
      }, ms);
      g.__pgpyTimers.add(id); return id;
    };
    g.setInterval = function (fn, ms) {
      var args = Array.prototype.slice.call(arguments, 2);
      var id = g.__pgpyOrig.setInterval(function () {
        try { fn.apply(null, args); } catch (e) { console.error((e && e.stack) || e); }
      }, ms);
      g.__pgpyTimers.add(id); return id;
    };
    g.clearTimeout = function (id) { try { g.__pgpyTimers.delete(id); } catch (_) {} return g.__pgpyOrig.clearTimeout(id); };
    g.clearInterval = function (id) { try { g.__pgpyTimers.delete(id); } catch (_) {} return g.__pgpyOrig.clearInterval(id); };
    try {
      if (typeof process !== 'undefined' && process.stdout) {
        var __inOut = false, __inErr = false;
        process.stdout.write = function (chunk, enc, cb) {
          // 二进制 chunk 不做 String() 转换（会变成 utf8 乱码）：原样交给 console 钩子，
          // 由宿主侧识别为图片/二进制并以 image 内容项回传
          if (!__inOut) { __inOut = true; try { console.log(typeof chunk === 'string' ? chunk.replace(/\\n$/, '') : chunk); } finally { __inOut = false; } }
          if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
          return true;
        };
        process.stderr.write = function (chunk, enc, cb) {
          if (!__inErr) { __inErr = true; try { console.error(typeof chunk === 'string' ? chunk.replace(/\\n$/, '') : chunk); } finally { __inErr = false; } }
          if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
          return true;
        };

      }
    } catch (_) {}
  }
  // 每次运行重置待办集合；并清掉上一次运行遗留的定时器（共享容器场景，避免污染本次输出）
  if (g.__pgpyTimers) { g.__pgpyTimers.forEach(function (id) { try { g.__pgpyOrig.clearTimeout(id); g.__pgpyOrig.clearInterval(id); } catch (_) {} }); }
  g.__pgpyTimers = new Set();
  g.__pgpySetTimeout = g.__pgpyOrig.setTimeout;
  g.__pgpyPending = function () { return g.__pgpyTimers.size; };
})();
`;

            // ── epilogue：用户代码（含异常）跑完后，等游离异步任务排空再交出 _hook ──
            const PGPY_EPILOGUE = `
(async function () {
  var g = globalThis, st = (g && g.__pgpySetTimeout) || setTimeout, deadline = Date.now() + 3000, quiet = 0;
  while (Date.now() < deadline) {
    if (g.__pgpyPending() === 0) { if (++quiet >= 2) break; } else { quiet = 0; }
    await new Promise(function (r) { st(r, 10); });
  }
  await new Promise(function (r) { st(r, 20); });
})()
`;

            let result = null, error = null;
            try {
              const wrapped =
                'module.__pgpy_async__ = (async () => {\n' +
                PGPY_PRELUDE + '\n' +
                'let __pgpyErr = null;\n' +
                'try {\n' + code + '\n} catch (e) { __pgpyErr = e; }\n' +
                'await ' + PGPY_EPILOGUE + ';\n' +
                'if (__pgpyErr) throw __pgpyErr;\n' +
                '})();';
              result = this._executeSuppressSynthetic(wrapped, filename || PGPY_RUN_FILENAME);
              const pending = (result && result.module) ? result.module.__pgpy_async__ : null;
              const exportsThenable = (result && result.exports && typeof result.exports.then === 'function') ? result.exports : null;
              if (pending && typeof pending.then === 'function') {
                await pending.catch((e) => { error = e; });
              }
              // 兼容用户直接 `module.exports = somePromise` 的写法
              if (exportsThenable) {
                try { result.exports = await exportsThenable; }
                catch (e) { if (!error) error = e; }
              }
            } catch (e) {
              error = e;
            } finally {
              this._hook = null;
            }
            return { logs: logs, exports: result ? result.exports : undefined, module: result ? result.module : null, error: error };
          },

          // ── 工作区持久化：IndexedDB（VirtualFS 原生 IDB 持久化）──
          //   数据真身在 IndexedDB；以下方法用于「落盘 / 全量快照 / 旧数据迁移」。

          // 枚举 /home/pyodide 下的所有文件（用于导出、迁移）
          snapshotFiles() {
            const out = [];
            const walk = (dir) => {
              let entries = [];
              try { entries = this.vfs.readdirSync(dir); } catch (_) { return; }
              for (const name of entries) {
                const full = dir === '/' ? '/' + name : dir + '/' + name;
                let st; try { st = this.vfs.statSync(full); } catch (_) { continue; }
                if (st.isDirectory()) walk(full);
                else if (st.isFile()) out.push({ path: full, data: pgpyBytesToBase64(this.vfs.readFileSync(full)) });
              }
            };
            walk('/home/pyodide');
            return out;
          },
          countFiles(dir) {
            let n = 0;
            let entries = [];
            try { entries = this.vfs.readdirSync(dir); } catch (_) { return 0; }
            for (const name of entries) {
              const full = dir === '/' ? '/' + name : dir + '/' + name;
              let st; try { st = this.vfs.statSync(full); } catch (_) { continue; }
              if (st.isDirectory()) n += this.countFiles(full);
              else if (st.isFile()) n += 1;
            }
            return n;
          },

          // 增量落盘：把排队的改动写入 IndexedDB（写操作已自动排队，这里立即刷入）
          syncFS() {
            if (this.vfs && typeof this.vfs.flush === 'function') {
              return Promise.resolve(this.vfs.flush());
            }
            return Promise.resolve();
          },
          // 全量快照：把整棵树写入 IndexedDB（页面关闭 / 手动保存时用）
          saveSnapshot() {
            if (this.vfs && typeof this.vfs.save === 'function') {
              return Promise.resolve(this.vfs.save());
            }
            return Promise.resolve();
          },

          // 旧版 localStorage 快照迁移（仅为兼容存量数据；迁移成功后删除旧 key）
          migrateLegacySnapshot() {
            if (this.countFiles('/home/pyodide') > 0) return; // IndexedDB 已有数据，无需迁移
            let files = [];
            try { files = JSON.parse(localStorage.getItem(NODE_FS_SNAPSHOT_KEY) || '[]'); } catch (_) { files = []; }
            if (!Array.isArray(files) || files.length === 0) return;
            let migrated = 0;
            for (const f of files) {
              if (!f || !f.path) continue;
              try {
                const bin = atob(f.data || '');
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                this.FS.mkdirTree(f.path.substring(0, f.path.lastIndexOf('/')) || '/');
                this.vfs.writeFileSync(f.path, bytes);
                migrated += 1;
              } catch (_) {}
            }
            if (migrated > 0) {
              try { localStorage.removeItem(NODE_FS_SNAPSHOT_KEY); } catch (_) {}
              console.log('[pgpy] migrated ' + migrated + ' file(s) from localStorage snapshot to IndexedDB');
            }
          }
        };

        // 安全字符串化（console 输出 / module.exports 展示）
        function safeStringify(value) {
          if (value === undefined) return 'undefined';
          if (value === null) return 'null';
          if (typeof value === 'string') return value;
          try { return JSON.stringify(value); } catch (_) { return String(value); }
        }

        function pgpySyncMount(populate) {
          // IndexedDB 是真正的持久层；populate=false 表示「落盘」（把内存树写入 IndexedDB）
          if (!populate && nodeRuntime && typeof nodeRuntime.syncFS === 'function') {
            return Promise.resolve(nodeRuntime.syncFS()).catch(function () {});
          }
          return Promise.resolve();
        }

        // ══════════════════════════════════════════════════════════════
        //  拖拽文件真实路径映射（虚拟路径 → 磁盘真实绝对路径）
        //   · 拖放/导入文件时用 fileAPI.getPathForFile() 记录其磁盘真实路径；
        //   · AI 工具（write_file / add_content / replace_lines / delete_content /
        //     delete_file）改动虚拟 FS 后，据此把新内容同步回真实目录；
        //   · 拖入「目录」时记录该目录的真实路径，目录下新建的文件也会落到真实目录。
        //   · 只存「路径元数据」，不缓存内容；IndexedDB / VirtualFS 持久化逻辑不变。
        // ══════════════════════════════════════════════════════════════
        const PGPY_REALPATH_KEY = 'pgpy_real_path_map_v1';
        let pgpyRealPathMap = {};
        try { pgpyRealPathMap = JSON.parse(localStorage.getItem(PGPY_REALPATH_KEY) || '{}') || {}; } catch (_) { pgpyRealPathMap = {}; }

        function pgpySaveRealPathMap() {
          try { localStorage.setItem(PGPY_REALPATH_KEY, JSON.stringify(pgpyRealPathMap)); } catch (_) {}
        }

        // ── 待同步队列（AI 改动先暂存，点击「同步」再写回）─────────────────
        // AI 改动虚拟 FS 后不再立即写回磁盘：先把「真实路径 → 操作」记入本队列并持久化，
        // 只有用户点击工具栏「同步」按钮时，才真正把这些改动写回 / 删除磁盘上的真实文件。
        //   { [realPath]: { kind: 'write' | 'delete', vPath } }
        const PGPY_PENDING_KEY = 'pgpy_pending_sync_v1';
        let pgpyPendingSync = {};
        try { pgpyPendingSync = JSON.parse(localStorage.getItem(PGPY_PENDING_KEY) || '{}') || {}; } catch (_) { pgpyPendingSync = {}; }
        // 导入 / 拖放写文件期间为 true：此时不把写入当成「AI 编辑」而计入待同步队列
        let pgpySuppressSync = false;

        function pgpySavePendingSync() {
          try { localStorage.setItem(PGPY_PENDING_KEY, JSON.stringify(pgpyPendingSync)); } catch (_) {}
        }

        // ── 磁盘指纹（拖入时的字节快照 → 哈希 + 大小）─────────────────────
        // 用途：点「同步」写回之前，先比对磁盘现状是否还等于「我们开始改之前」的样子。
        // 不一致 = 拖入之后磁盘被别人（IDE / git pull / 格式化 / 同事）动过：
        // 默认跳过不写，把决定权交给用户，绝不静默覆盖。
        const PGPY_DISK_FP_KEY = 'pgpy_disk_fp_v1';
        let pgpyDiskFp = {};
        try { pgpyDiskFp = JSON.parse(localStorage.getItem(PGPY_DISK_FP_KEY) || '{}') || {}; } catch (_) { pgpyDiskFp = {}; }

        function pgpySaveDiskFp() {
          try { localStorage.setItem(PGPY_DISK_FP_KEY, JSON.stringify(pgpyDiskFp)); } catch (_) {}
        }

        function pgpyDiskFpKey(real) {
          return pgpySlash(real || '').replace(/\/+$/, '');
        }

        // 记录某真实文件「当前磁盘内容」的指纹（拖入时 / 写回成功后各记一次）
        function pgpyRecordDiskFp(real, bytes) {
          const key = pgpyDiskFpKey(real);
          if (!key) return;
          try {
            if (typeof EolMeta === 'undefined' || !EolMeta || !EolMeta.hash) return;
            const u8 = pgpyToBytesSafe(bytes);
            if (!u8) return;
            const fp = (EolMeta.canonicalHash || EolMeta.hash)(u8);
            pgpyDiskFp[key] = { size: fp.size, h: fp.h, at: Date.now() };
            pgpySaveDiskFp();
          } catch (_) {}
        }

        function pgpyGetDiskFp(real) {
          const key = pgpyDiskFpKey(real);
          return key ? (pgpyDiskFp[key] || null) : null;
        }

        function pgpyForgetDiskFp(real) {
          const key = pgpyDiskFpKey(real);
          if (!key || !pgpyDiskFp[key]) return;
          try { delete pgpyDiskFp[key]; pgpySaveDiskFp(); } catch (_) {}
        }

        function pgpyPendingCount() {
          try { return Object.keys(pgpyPendingSync).length; } catch (_) { return 0; }
        }

        // 待同步队列里「虚拟路径 → 操作类型(write|delete)」映射：供文件列表标色与勾选匹配用
        function pgpyPendingKindMap() {
          const map = {};
          try {
            for (const real of Object.keys(pgpyPendingSync)) {
              const op = pgpyPendingSync[real];
              if (op && op.vPath) map[pgpyNormalizeVPath(op.vPath)] = op.kind === 'delete' ? 'delete' : 'write';
            }
          } catch (_) {}
          return map;
        }

        // 文件列表里「已勾选」且确实有待同步改动的真实路径列表：点「同步」时只处理这些
        function pgpySelectedPendingReals() {
          const sel = new Set(Array.from(pgpySelectedFiles).map(pgpyNormalizeVPath));
          const reals = [];
          for (const real of Object.keys(pgpyPendingSync)) {
            const op = pgpyPendingSync[real];
            if (op && op.vPath && sel.has(pgpyNormalizeVPath(op.vPath))) reals.push(real);
          }
          return reals;
        }

        // 把一次磁盘真实路径的改动登记进待同步队列（write：同步时从 vfs 读取最新内容写回；
        // delete：同步时删除该真实路径）。同一真实路径后一次操作覆盖前一次。
        function pgpyEnqueueSync(vPath, kind, beforeBytes) {
          if (pgpySuppressSync) return false;
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return false;
          const real = pgpyResolveRealPath(key);
          if (!real) return false;
          const existed = Object.prototype.hasOwnProperty.call(pgpyPendingSync, real);
          // 首次登记该真实文件的改动时，记录一份「修改前」基线（供 ⇄ 对比使用）
          if (!existed) {
            pgpyCaptureBaseline(key, beforeBytes === undefined ? null : beforeBytes);
            // 顺带落一枚磁盘指纹：基线字节 = 拖入时的磁盘内容，正是「开始改之前」的样子。
            // 拖入路径若已经记过指纹则保留更早的那一枚（更接近真正的起点）。
            if (beforeBytes != null && !pgpyGetDiskFp(real)) pgpyRecordDiskFp(real, beforeBytes);
          }
          pgpyPendingSync[real] = { kind: kind === 'delete' ? 'delete' : 'write', vPath: key };
          pgpySavePendingSync();
          pgpyUpdateSyncButton();
          pgpyNotifyPendingChanged(key);
          return true;
        }

        // 把路径规范成虚拟 FS 的绝对路径（补 /home/pyodide 前缀、正斜杠、折叠 ./ 与 ../）
        function pgpyNormalizeVPath(p) {
          p = String(p == null ? '' : p).replace(/\\/g, '/').trim();
          if (!p) return '';
          if (p[0] !== '/') p = '/home/pyodide/' + p;
          const parts = [];
          for (const seg of p.split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') { parts.pop(); continue; }
            parts.push(seg);
          }
          return '/' + parts.join('/');
        }

        // 取 File 对象的磁盘真实路径（Electron webUtils.getPathForFile；非 Electron 环境返回 ''）
        function pgpyRealPathOf(file) {
          try {
            if (file && window.fileAPI && typeof window.fileAPI.getPathForFile === 'function') {
              return window.fileAPI.getPathForFile(file) || '';
            }
          } catch (_) {}
          return '';
        }

        function pgpySetRealPath(vPath, realPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key || !realPath) return;
          pgpyRealPathMap[key] = realPath;
          pgpySaveRealPathMap();
        }

        function pgpyGetRealPath(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          return key ? (pgpyRealPathMap[key] || '') : '';
        }

        // 反斜杠 → 正斜杠（跨平台路径比较/拼接用；用字符码避免源码里的转义歧义）
        function pgpySlash(p) {
          return String(p == null ? '' : p).split(String.fromCharCode(92)).join('/');
        }

        // 解析某虚拟路径对应的磁盘真实路径（这是「拖入的目录」下新建文件也能同步的关键）：
        //   · 精确命中映射（文件或目录自身）→ 直接用它；
        //   · 否则向上逐级找「最近的已映射祖先目录」，把剩余相对路径拼到该目录真实路径后面。
        function pgpyResolveRealPath(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return '';
          if (pgpyRealPathMap[key]) return pgpyRealPathMap[key];
          const segs = key.split('/').filter(Boolean);
          for (let i = segs.length - 1; i >= 1; i--) {
            const ancestor = '/' + segs.slice(0, i).join('/');
            const base = pgpyRealPathMap[ancestor];
            if (base) return pgpySlash(base).replace(/\/+$/, '') + '/' + segs.slice(i).join('/');
          }
          return '';
        }

        // 待同步队列里「虚拟路径 → 真实路径」反查：删除时映射已被清除（幽灵行 vfs 也不存在），
        // 真实路径只剩在 pendingSync 的 key 上，据此展示 / 同步。
        function pgpyPendingRealOf(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return '';
          try {
            for (const real of Object.keys(pgpyPendingSync)) {
              const op = pgpyPendingSync[real];
              if (op && op.vPath && pgpyNormalizeVPath(op.vPath) === key) return real;
            }
          } catch (_) {}
          return '';
        }

        // UI 展示用路径（仅用于界面显示，不影响任何读写行为）：
        //   · 有真实磁盘映射 → 显示真实磁盘路径；
        //   · 否则 → 去掉 /home/pyodide 前缀，显示工作区内的相对路径（工作区根显示为 '.'）。
        // 注意：工具描述、工具返回结果、以及 nodeRuntime.FS 的实际读写仍全部使用虚拟路径。
        function pgpyDisplayPath(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return String(vPath == null ? '' : vPath);
          // 正常项用真实路径映射；待删除幽灵行映射已清除 → 回退到待同步队列里的真实路径
          const real = pgpyResolveRealPath(key) || pgpyPendingRealOf(key);
          if (real) return real;
          return key.replace(/^\/home\/pyodide\/?/, '') || '.';
        }

        // 由「相对路径 + 其磁盘真实路径」反推顶层目录的真实路径。
        //   例：relPath="myfolder/sub/a.txt"，realFilePath="D:/x/myfolder/sub/a.txt"
        //       → "D:/x/myfolder"
        //   relPath 末段的「文件相对路径」与真实路径末段一一对应；顶层目录名也要算进真实路径，
        //   所以切片到 parts.length - relSegs.length（不含）之后还要再向前含 1 段（即顶层目录本身）。
        function pgpyTopRealOf(relPath, realFilePath) {
          const relSegs = pgpySlash(relPath).split('/').filter(Boolean);
          if (relSegs.length < 2) return ''; // 顶层直接是文件，没有目录可反推
          const norm = pgpySlash(realFilePath).replace(/\/+$/, '');
          if (!norm) return '';
          const parts = norm.split('/');
          if (parts.length <= relSegs.length) return '';
          return parts.slice(0, parts.length - relSegs.length + 1).join('/');
        }

        // 拖入目录时：用「文件相对路径 + 其磁盘真实路径」反推顶层目录的真实路径并记录。
        //   → 记录 "/home/pyodide/myfolder" → "D:/x/myfolder"
        //   之后该目录下新建的文件才能被 pgpyResolveRealPath 解析回真实目录。
        function pgpyRecordDroppedFolderFromFile(relPath, realFilePath) {
          const relSegs = pgpySlash(relPath).split('/').filter(Boolean);
          const folderReal = pgpyTopRealOf(relPath, realFilePath);
          if (folderReal && relSegs[0]) pgpySetRealPath('/home/pyodide/' + relSegs[0], folderReal);
        }

        // 清除某虚拟路径（含其所有子路径）的真实路径记录
        function pgpyDeleteRealPathTree(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return;
          let changed = false;
          for (const k of Object.keys(pgpyRealPathMap)) {
            if (k === key || k.startsWith(key + '/')) { delete pgpyRealPathMap[k]; changed = true; }
          }
          if (changed) pgpySaveRealPathMap();
        }

        // ⚠️ 这里曾有一条 pgpySyncContentToReal()：fileAPI.write 裸写字符串，
        // 不还原 EOL/BOM、不校验磁盘是否被外部改过、不进撤销批次。
        // 它是「唯一写入口」这个安全不变量的唯一破口——一旦有人把它重新接上，
        // 三条保护同时失效，且没有编译期保护。已删除。
        // 任何写盘都必须走 pgpySyncPaths（唯一的写/删入口）。

        // 把各种形态的写入内容统一转成字节（保证二进制同步不失真）
        function pgpyToBytes(data) {
          if (data instanceof Uint8Array) return data;
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
          return new TextEncoder().encode(data == null ? '' : String(data));
        }

        // 某虚拟文件被写入：不再立即写回磁盘，只登记为「待同步」；
        // 内容在用户点击工具栏「同步」按钮时从 vfs 读取并写回真实文件（二进制不失真）。
        function pgpyScheduleSyncToReal(vPath, data, beforeBytes) {
          pgpyEnqueueSync(vPath, 'write', beforeBytes);
        }

        // ★ 唯一写/删入口钩子：不管内容从哪来 —— AI 的 write_file / replace_lines / add_content /
        //   delete_content 等工具，或 run_node 里 require('fs').writeFileSync / fs.appendFileSync……
        //   最终都会落到 almostnode vfs 的同步写入口。这里只在 vfs 的 writeFileSync / unlinkSync /
        //   rmdirSync 三个唯一入口上挂钩：若该虚拟路径来自「拖放上传」，就把同一份内容同步回磁盘真实文件。
        function pgpyInstallVfsHooks(vfs) {
          if (!vfs || vfs.__pgpyHooked) return;
          const wrapWrite = function (name) {
            const orig = vfs[name];
            if (typeof orig !== 'function') return;
            vfs[name] = function (vPath, data, ...rest) {
              // 改动前先取一份原内容快照，作为「修改前」差异基线（新建文件 → null）。
              // 导入期间(pgpySuppressSync)不取，避免无谓 IO。
              let before;
              try {
                if (!pgpySuppressSync) { try { before = vfs.readFileSync(vPath); } catch (_) { before = null; } }
              } catch (_) { before = undefined; }
              const ret = orig.call(this, vPath, data, ...rest);
              try { pgpyScheduleSyncToReal(vPath, data, before); } catch (_) {}
              return ret;
            };
          };
          const wrapDelete = function (name) {
            const orig = vfs[name];
            if (typeof orig !== 'function') return;
            vfs[name] = function (vPath, ...rest) {
              // 删除前先取一份原内容快照，作为「修改前」差异基线
              let before;
              try {
                if (!pgpySuppressSync) { try { before = vfs.readFileSync(vPath); } catch (_) { before = null; } }
              } catch (_) { before = undefined; }
              const ret = orig.call(this, vPath, ...rest);
              try { pgpyDeleteReal(vPath, undefined, before).catch(function () {}); } catch (_) {}
              return ret;
            };
          };
          wrapWrite('writeFileSync');
          wrapDelete('unlinkSync');
          wrapDelete('rmdirSync');
          vfs.__pgpyHooked = true;
          console.log('[pgpy] vfs 唯一写入口同步钩子已安装（写回拖放文件的磁盘真实路径）');
        }

        // AI 删除虚拟文件/目录后：登记为「待同步删除」并清除虚拟路径映射；
        // 真正删除磁盘上的真实文件/目录要等用户点击工具栏「同步」按钮。
        async function pgpyDeleteReal(vPath, fileType, beforeBytes) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return false;
          const real = pgpyResolveRealPath(key); // 目录下新建的文件也能解析回真实路径
          pgpyDeleteRealPathTree(key);
          if (!real) return false;
          if (pgpySuppressSync) return false;
          const existed = Object.prototype.hasOwnProperty.call(pgpyPendingSync, real);
          if (!existed) pgpyCaptureBaseline(key, beforeBytes === undefined ? null : beforeBytes);
          pgpyPendingSync[real] = { kind: 'delete', vPath: key };
          pgpySavePendingSync();
          pgpyUpdateSyncButton();
          pgpyNotifyPendingChanged(key);
          return true;
        }

        // 更新工具栏「同步」按钮：只要文件列表里勾选了文件，按钮就不能禁用（点击只写回勾选项）；
        // 勾选中有待同步改动时高亮；一个都没勾选时才禁用，角标提示待同步总数。
        function pgpyUpdateSyncButton() {
          const btn = document.getElementById('syncRealBtn');
          if (!btn) return;
          const total = pgpyPendingCount();
          const checked = pgpySelectedFiles ? pgpySelectedFiles.size : 0; // 文件列表里已勾选的文件数
          const selected = pgpySelectedPendingReals().length;            // 已勾选且确实有待同步改动的数量
          const badge = document.getElementById('syncRealBadge');
          if (badge) { badge.textContent = total; badge.style.display = total > 0 ? '' : 'none'; }
          // 规则：只要文件列表里勾选了文件，「同步」按钮就不禁用；一个都没勾选时才禁用。
          btn.disabled = checked === 0;
          // 勾选分类：锚点（有真实路径）/ 新增项（无真实路径）
          let anchorCount = 0, newsCount = 0;
          try { const pk = pgpyClassifySelection(); anchorCount = pk.anchors.length; newsCount = pk.news.length; } catch (_) {}
          if (newsCount > 0 && anchorCount === 0) {
            // 只勾了新增项、没勾真实目标 → 警示（点击会提示补选）
            btn.style.background = '';
            btn.style.borderColor = '#f59e0b';
            btn.style.color = '';
            btn.style.fontWeight = '';
            btn.title = '已勾选 ' + newsCount + ' 个新增项，但缺少「拖入的真实文件/目录」作为同步目标，请再勾选至少一个真实项';
          } else if (newsCount > 0 && anchorCount > 0) {
            btn.style.background = '#ef4444';
            btn.style.borderColor = '#ef4444';
            btn.style.color = '#fff';
            btn.style.fontWeight = '600';
            btn.title = '把 ' + newsCount + ' 个新增项同步进 ' + anchorCount + ' 个真实目标的目录'
              + (selected > 0 ? '，并写回 ' + selected + ' 处改动' : '') + '（待同步共 ' + total + ' 处）';
          } else if (selected > 0) {
            btn.style.background = '#ef4444';
            btn.style.borderColor = '#ef4444';
            btn.style.color = '#fff';
            btn.style.fontWeight = '600';
            btn.title = '把勾选的 ' + selected + ' 处改动写回磁盘真实文件（待同步共 ' + total + ' 处）';
          } else if (checked > 0) {
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
            btn.style.fontWeight = '';
            btn.title = '把勾选的 ' + checked + ' 个文件写回磁盘真实文件（待同步共 ' + total + ' 处）';
          } else if (total > 0) {
            btn.style.background = '';
            btn.style.borderColor = '#f59e0b';
            btn.style.color = '';
            btn.style.fontWeight = '';
            btn.title = '请在文件列表里勾选要同步的文件（待同步共 ' + total + ' 处）';
          } else {
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
            btn.style.fontWeight = '';
            btn.title = '请在文件列表里勾选要同步的文件';
          }
          // 「⇄ 对比」按钮可用性同步刷新（有改动 / 勾选 ≥2 个文件时可点）
          try { pgpyUpdateDiffButton(); } catch (_) {}
        }

        // 锚点的「目标真实目录」：目录 → 自身；文件 → 其所在目录（跨平台分隔符）
        function pgpyRealDirOf(real, isDir) {
          const s = pgpySlash(real).replace(/\/+$/, '');
          if (!s) return '';
          if (isDir) return s;
          const i = s.lastIndexOf('/');
          if (i < 0) return s;
          let dir = s.slice(0, i);
          if (/^[a-zA-Z]:$/.test(dir)) dir += '/'; // Windows 盘根，如 C:
          return dir || '/';
        }

        // 把当前勾选项分类：
        //   · 锚点 anchors：能解析出磁盘真实路径的行（拖入的文件/目录），作为同步目标；
        //   · 新增项 news：解析不出真实路径、但确实存在于 vfs 的行（AI 新建的文件/目录），待复制进目标目录。
        function pgpyClassifySelection(paths) {
          const anchors = [], news = [];
          const src = Array.isArray(paths) ? paths : Array.from(pgpySelectedFiles || []);
          const FS = (nodeRuntime && nodeRuntime.ready) ? nodeRuntime.FS : null;
          for (const raw of src) {
            const vPath = pgpyNormalizeVPath(raw);
            if (!vPath) continue;
            let isDir = false, exists = false;
            if (FS) { try { const st = FS.stat(vPath); exists = true; isDir = FS.isDir(st.mode); } catch (_) {} }
            // 待删除幽灵行：vfs 已无此文件、映射也已清除，真实路径只能从待同步队列取 → 当成真实项参与同步
            const pendingReal = pgpyPendingRealOf(vPath);
            const real = pgpyResolveRealPath(vPath) || pendingReal;
            if (real) anchors.push({ vPath: vPath, real: real, isDir: isDir, exists: exists, pendingReal: pendingReal });
            else if (!FS || exists) news.push({ vPath: vPath, isDir: isDir }); // 非删除又不存在的行不参与
          }
          return { anchors: anchors, news: news };
        }

        // 展开新增项：目录递归 → 文件列表 + 目录相对路径列表（相对 /home/pyodide，含空目录）
        function pgpyGatherCopyItems(news) {
          const FS = nodeRuntime.FS;
          const files = new Set();   // 虚拟路径
          const dirs = new Set();    // 相对 /home/pyodide 的目录相对路径
          const seen = new Set();
          function walk(vPath) {
            const key = pgpyNormalizeVPath(vPath);
            if (!key || seen.has(key)) return;
            seen.add(key);
            let st;
            try { st = FS.stat(key); } catch (_) { return; }
            if (FS.isDir(st.mode)) {
              const rel = pgpyZipRelPath(key);
              if (rel) dirs.add(rel);
              let items = [];
              try { items = FS.readdir(key); } catch (_) {}
              for (const it of items) {
                if (it === '.' || it === '..' || it === 'default.profraw') continue;
                walk(key + '/' + it);
              }
            } else if (FS.isFile(st.mode)) {
              files.add(key);
            }
          }
          for (const n of news) walk(n.vPath);
          return { files: Array.from(files), dirs: Array.from(dirs) };
        }

        // 点击「同步」：分两阶段
        //   ① 锚点（拖入的真实文件/目录）：把勾选项里「有待同步改动」的真实文件写回 / 删除磁盘真实文件（原行为）；
        //   ② 新增项（无真实路径的 AI 新建文件/目录）：复制进每个锚点对应的真实目录
        //      （锚点是文件 → 其所在目录；锚点是目录 → 目录自身），保留相对 /home/pyodide 的结构；
        //   · 只勾了新增项、没勾任何真实锚点 → 无法确定目标，提示并中止；
        //   · 解析不到真实路径的目录 → 跳过，计入 skipped。
        async function pgpySyncToRealNow() {
          // 工具栏「同步」：写回文件列表里勾选的（有待同步改动的）文件。
          // 写盘前先做一次交付预检：结构化摘要 + 类型/语法门禁。
          // 阻断性错误或高风险改动 → 让用户明确确认（默认动作是「先去逐块审核」）。
          const paths = Array.from(pgpySelectedFiles || []);
          const kindMap = pgpyPendingKindMap();
          const pendingPaths = paths.filter(function (x) { return !!kindMap[pgpyNormalizeVPath(x)]; });
          if (pendingPaths.length > 0) {
            let summary = null;
            try { summary = await pgpyPreflightSelection(pendingPaths); } catch (_) { summary = null; }
            if (summary) {
              const blocked = !!(summary.gate && summary.gate.blocked);
              const high = (summary.totals && summary.totals.riskHigh) || 0;
              if (blocked || high > 0) {
                const cancelOpt = '取消（先去 ⇄ 对比逐块审核）';
                const opts = [cancelOpt, blocked ? '仍然写回（我负责）' : '写回'];
                const ans = await pgpyAskChoice(
                  blocked ? '存在阻断性错误' : '检测到高风险改动',
                  (blocked ? '有文件存在语法/引用错误，写回后大概率跑不起来。\n\n' : '') + DeliverySummary.toMarkdown(summary),
                  opts,
                  '建议在「⇄ 对比」里逐块接受后再写回：拒绝的块不会落盘。'
                );
                if (!ans || ans === cancelOpt) return;
              }
            }
          }
          return pgpySyncPaths(paths);
        }

        // 核心同步：把传入的这些虚拟路径（有待同步改动的）写回磁盘真实文件 / 目录。
        //   · 工具栏「同步」→ 传文件列表已勾选项；
        //   · ⇄ 对比弹窗「一键同步勾选」→ 传弹窗清单里勾选项。
        // opts（可选，供「块级接受」用）：
        //   · overrideBytes { realPath: Uint8Array } —— 用调用方合成好的字节替代 vfs 原内容
        //   · partialReals [realPath] —— 这些文件只是「部分落盘」，不能清掉待同步项
        async function pgpySyncPaths(inputPaths, opts) {
          opts = opts || {};
          const overrideBytes = opts.overrideBytes || null;
          const partialReals = opts.partialReals || null;
          const checkedPaths = (Array.isArray(inputPaths) ? inputPaths : []).map(pgpyNormalizeVPath).filter(Boolean);
          if (checkedPaths.length === 0) { alert('请先勾选要同步的文件。'); return; }
          if (!window.fileAPI) { alert('当前环境不支持写回磁盘（请在 Electron 应用中打开）。'); return; }

          // 待同步队列里「虚拟路径 → 真实路径」映射（delete 时 vfs 已无该文件，真实路径只能从这里取）
          const pendingByVPath = {};
          try {
            for (const real of Object.keys(pgpyPendingSync)) {
              const op = pgpyPendingSync[real];
              if (op && op.vPath) pendingByVPath[pgpyNormalizeVPath(op.vPath)] = { real: real, kind: op.kind };
            }
          } catch (_) {}

          // 分类勾选项：锚点（有真实路径，作为同步目标）/ 新增项（无真实路径，待复制进目标目录）
          const picked = pgpyClassifySelection(checkedPaths);
          const anchors = picked.anchors;
          const news = picked.news;

          // 勾选了新增项，却没有任何真实锚点 → 无法确定写到哪里
          if (news.length > 0 && anchors.length === 0) {
            alert('检测到「新增文件/目录」，但没有勾选任何「拖入的真实文件/目录」作为同步目标。\n请至少勾选一个已拖入的真实文件或目录。');
            return;
          }

          // 组装待写回任务：每个「锚点」→ { vPath, real, kind }
          // ⚠️ 无论是否同时勾选了「新增项」，锚点里「有待同步改动」的真实文件都必须写回其自身；
          //    新增项只是「额外复制进目标目录」（阶段②），不能取代对锚点的写回。
          const jobs = [];
          let skipped = 0;
          for (const a of anchors) {
            const vPath = a.vPath;
            const pending = pendingByVPath[vPath];
            const real = pending ? pending.real : a.real;
            let kind = pending ? pending.kind : 'write';
            if (kind !== 'delete') {
              // 目录本身不写回（只作目标）；vfs 中读不到且非删除 → 跳过
              if (a.isDir || !a.exists) { skipped++; continue; }
            }
            jobs.push({ vPath, real, kind, partial: !!(partialReals && partialReals.indexOf(real) >= 0) });
          }
          // 既没有要写回的锚点、也没有可复制的新增项 → 无目标可同步
          if (jobs.length === 0 && news.length === 0) {
            alert('勾选的文件均无磁盘真实路径（未拖放上传的文件无法写回），已跳过。');
            return;
          }

          // ── 阶段 0：写回前校验「磁盘是否在拖入后被外部改过」──────────────
          // 这是「静默覆盖」的唯一防线：磁盘内容 ≠ 开始改之前 → 默认不写。
          // 同时为每个文件抽取文本风格档案（EOL/BOM/编码），供写回时还原。
          let blockedCount = 0;
          try {
            const conflicts = [];
            for (const job of jobs) {
              // 删除也要校验：磁盘上那份已经被别人改过，就不该照着旧判断删掉
              let st = { state: 'unknown', meta: null, diskBytes: null };
              try { st = await pgpyDiskStateOf(job.real, job.vPath); } catch (_) {}
              job.diskState = st.state;
              job.textMeta = st.meta || null;
              job.diskBytes = st.diskBytes || null;
              if (st.state === 'changed') conflicts.push(job);
            }
            if (conflicts.length > 0) {
              const force = await pgpyAskForceOverwrite(conflicts);
              for (const job of conflicts) job.blocked = !force;
              if (!force) blockedCount = conflicts.length;
            }
          } catch (err) {
            console.warn('[pgpy] 写回前磁盘校验异常（按放行处理）:', err);
          }

          const btn = document.getElementById('syncRealBtn');
          const status = document.getElementById('pgpyStatus');
          if (btn) btn.disabled = true;
          if (status) { status.className = 'pgpy-status-badge pgpy-loading'; status.textContent = jobs.length > 0 ? ('⏳ 正在同步 ' + jobs.length + ' 个文件…') : '⏳ 正在同步新增文件…'; }

          let ok = 0, fail = 0, partialCount = 0;
          const written = {};    // real → 本次真正落盘的字节（供「部分接受」轮转基线）
          const undoItems = []; // ⟲ 撤销批次：本轮写回的「同步前」基线（21-sync-undo.js 落库）
          for (const job of jobs) {
            // 磁盘已变更且用户选择跳过 → 不写、不清待同步、不改指纹
            if (job.blocked) continue;
            try {
              // 先取「同步前」基线（删除/覆盖落盘前必须拿到，否则事后无法回退）
              let preInfo = null;
              try { preInfo = await pgpyGetBaseline(job.vPath); } catch (_) { preInfo = null; }
              let writtenBytes = null; // 本次写回磁盘的字节（delete 项为 null）
              if (job.kind === 'delete') {
                if (typeof window.fileAPI.remove === 'function') await window.fileAPI.remove(job.real);
                pgpyForgetDiskFp(job.real);
              } else {
                // 从 vfs 读取最新内容再写回：文本 / 图片 / PDF 等二进制都不失真
                // 有 overrideBytes → 写调用方「按块合成」的结果；否则写 vfs 里的完整提案
                let bytes = null;
                if (overrideBytes && overrideBytes[job.real]) {
                  bytes = pgpyToBytesSafe(overrideBytes[job.real]);
                } else {
                  try { bytes = nodeRuntime.FS.readFile(job.vPath, { encoding: 'binary' }); } catch (_) { bytes = null; }
                }
                // EOL / BOM / 末尾换行 / 编码还原：按「拖入时的原始文本风格」写回，
                // 免得 AI 的 UTF-8+LF 把 CRLF 文件整篇改写（diff 看着只改三行，git 里全红）
                if (bytes != null) bytes = pgpyRestoreTextStyle(bytes, job.textMeta);
                if (bytes != null && typeof window.fileAPI.writeBytes === 'function') {
                  await window.fileAPI.writeBytes(job.real, bytes);
                  writtenBytes = bytes;
                } else {
                  let text = '';
                  try { text = nodeRuntime.FS.readFile(job.vPath, { encoding: 'utf8' }); } catch (_) {}
                  await window.fileAPI.write(job.real, text);
                  try { writtenBytes = new TextEncoder().encode(text); } catch (_) { writtenBytes = null; }
                }
                // 写回成功 → 指纹更新为「磁盘现在的内容」，供下一轮校验比对
                if (writtenBytes) pgpyRecordDiskFp(job.real, writtenBytes);
              }
              // 记入撤销批次（SyncUndo 缺失时静默跳过 → 仅失去「可撤销」能力）
              try {
                if (typeof SyncUndo !== 'undefined' && SyncUndo && SyncUndo.makeItem) {
                  const it = await SyncUndo.makeItem({
                    real: job.real, vPath: job.vPath,
                    kind: job.kind === 'delete' ? 'delete' : 'write',
                    pre: preInfo && preInfo.known ? preInfo.bytes : null,
                    preKnown: !!(preInfo && preInfo.known),
                    postBytes: writtenBytes
                  });
                  if (it) undoItems.push(it);
                }
              } catch (_) {}
              written[job.real] = writtenBytes;
              if (job.partial) {
                // 部分接受：磁盘上只是「合成结果」，vfs 里仍是 AI 的完整提案。
                // 待同步项必须保留 —— 否则被拒的块会被当作「已交付」而静默消失。
                partialCount++;
              } else {
                delete pgpyPendingSync[job.real];
                // 已同步 → 取消勾选（文件列表 + 对比弹窗清单）
                try { pgpySelectedFiles.delete(job.vPath); } catch (_) {}
                try { pgpyDiffSyncChecked.delete(job.vPath); } catch (_) {}
              }
              ok++;
            } catch (err) {
              fail++;
              console.warn('[pgpy] 同步到真实文件失败:', job.real, err);
            }
          }
          // 已写回磁盘 → 这些文件的「修改前」基线不再需要（无论成功与否都清理）
          // ⚠️ 被跳过的（磁盘已变更）不清：它们仍待处理，基线还要留着做 ⇄ 对比
          // 部分落盘的不清基线（调用方会把它轮转成新的「修改前」），否则剩下的块就没法再对比了
          try { pgpyBaselineDelete(jobs.filter(function (j) { return !j.blocked && !j.partial; }).map(function (j) { return j.vPath; })); } catch (_) {}

          // ── 第二阶段：把「新增文件/目录」复制进每个锚点的目标真实目录 ──
          let copied = 0, copyFail = 0;
          if (news.length > 0 && anchors.length > 0) {
            // 锚点目标真实目录（去重）：文件 → 其所在目录；目录 → 自身
            const targets = [];
            for (const a of anchors) {
              const pending = pendingByVPath[a.vPath];
              const real = pending ? pending.real : a.real;
              const dir = pgpyRealDirOf(real, a.isDir);
              if (dir && targets.indexOf(dir) === -1) targets.push(dir);
            }
            if (targets.length > 0) {
              const bundle = pgpyGatherCopyItems(news); // { files:[vPath], dirs:[rel] }
              if (status) status.textContent = '⏳ 正在同步 ' + bundle.files.length + ' 个新增文件到 ' + targets.length + ' 个真实目录…';
              for (const target of targets) {
                // 先造目录（含空目录）；文件写入时会自动补建父目录
                for (const rel of bundle.dirs) {
                  try { if (typeof window.fileAPI.mkdir === 'function') await window.fileAPI.mkdir(target + '/' + rel); } catch (_) {}
                }
                for (const vPath of bundle.files) {
                  const rel = pgpyZipRelPath(vPath);
                  if (!rel) continue;
                  try {
                    const bytes = nodeRuntime.FS.readFile(vPath, { encoding: 'binary' });
                    const targetPath = target + '/' + rel;
                    if (typeof window.fileAPI.writeBytes === 'function') await window.fileAPI.writeBytes(targetPath, bytes);
                    else await window.fileAPI.write(targetPath, nodeRuntime.FS.readFile(vPath, { encoding: 'utf8' }));
                    // 新增文件记入撤销批次（撤销 = 删除该文件）
                    try {
                      if (typeof SyncUndo !== 'undefined' && SyncUndo && SyncUndo.makeItem) {
                        const it = await SyncUndo.makeItem({ real: targetPath, vPath: vPath, kind: 'create', pre: null, preKnown: false, postBytes: bytes });
                        if (it) undoItems.push(it);
                      }
                    } catch (_) {}
                    copied++;
                  } catch (err) { copyFail++; console.warn('[pgpy] 新增文件同步失败:', target, rel, err); }
                }
              }
              // 已复制的新增项 → 取消勾选（文件列表 + 对比弹窗清单）
              for (const n of news) {
                try { pgpySelectedFiles.delete(n.vPath); } catch (_) {}
                try { pgpyDiffSyncChecked.delete(n.vPath); } catch (_) {}
              }
            }
          }

          // ── 撤销批次落库：把本轮写回的「同步前」状态存成可回退批次（ ⟲ 撤销写回 ）──
          //    落库失败 → 如实在结果里标注「不可撤销」，绝不假装有保险。
          let undoSaved = false;
          if (undoItems.length > 0 && typeof SyncUndo !== 'undefined' && SyncUndo && SyncUndo.saveBatch) {
            try {
              const undoNote = (ok + copied > 0 ? ('写回 ' + ok + ' 个' + (copied > 0 ? '，新增 ' + copied + ' 个' : '')) : '本轮同步');
              await SyncUndo.saveBatch(SyncUndo.buildBatch(undoItems, undoNote));
              undoSaved = true;
            } catch (_) { undoSaved = false; }
          }
          try { if (typeof pgpyRefreshUndoButton === 'function') pgpyRefreshUndoButton(); } catch (_) {}

          pgpySavePendingSync();
          pgpyUpdateSyncButton();
          // 变更已写回，刷新文件列表让「待同步」标记与勾选状态同步更新
          if (nodeRuntime.ready && pgpyLastResult && pgpyLastResult.isFileList) listNodeFiles();

          const skipParts = [];
          if (skipped > 0) skipParts.push(skipped + ' 个无真实路径');
          if (blockedCount > 0) skipParts.push(blockedCount + ' 个磁盘已变更、未覆盖');
          const skipNote = skipParts.length > 0 ? '（跳过 ' + skipParts.join('；') + '）' : '';
          // 阶段①只要产生了写回任务（jobs）就汇报「已同步」；不再因为同时有新增项而漏报。
          const writeNote = (jobs.length > 0) ? ('已同步 ' + ok + ' 个文件') : '';
          const newNote = (copied + copyFail) > 0 ? ('新增同步 ' + copied + ' 个' + (copyFail > 0 ? '（失败 ' + copyFail + '）' : '')) : '';
          let summary = [writeNote, newNote].filter(Boolean).join('，') || '已完成';
          // 撤销能力提示：有可回退项时告知用户可以 ⟲ 撤销；落库失败则如实提示不可撤销
          if (undoItems.length > 0) summary += undoSaved ? '（可 ⟲ 撤销）' : '（⚠️ 本次写回不可撤销）';
          if (fail === 0 && copyFail === 0) {
            if (status) { status.className = 'pgpy-status-badge pgpy-success'; status.textContent = '✅ ' + summary + skipNote; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showSuccessMessage) snackbarStore.showSuccessMessage('✅ ' + summary + skipNote);
          } else {
            if (status) { status.className = 'pgpy-status-badge pgpy-error'; status.textContent = '⚠️ 同步完成：成功 ' + (ok + copied) + '，失败 ' + (fail + copyFail) + '（' + summary + '）' + skipNote; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) snackbarStore.showErrorMessage('⚠️ 同步失败 ' + (fail + copyFail) + ' 个（成功 ' + (ok + copied) + '）');
          }
          return {
            ok: ok, fail: fail, copied: copied, copyFail: copyFail,
            skipped: skipped, blocked: blockedCount, partial: partialCount,
            written: written, undoSaved: undoSaved
          };
        }

        // ══════════════════════════════════════════════════════════════
        //  Web 版文件比较（Beyond Compare 风格）：AI 修改前 ⇄ 修改后
        //   · 「修改前」基线：AI 首次改动该文件时，在 vfs 写入口捕获的原始字节，
        //     随待同步队列持久化到 IndexedDB；点「同步」写回磁盘后自动清除。
        //   · 「修改后」：当前 almostnode 虚拟 FS 中的内容（被删除的文件视为空）。
        //   · 支持并排 / 统一视图、词级高亮、上一个/下一个差异、仅差异、忽略空白。
        // ══════════════════════════════════════════════════════════════
        const PGPY_DIFF_DB = 'pgpy-diff-baseline';
        const PGPY_DIFF_STORE = 'baselines';
        const pgpyBaselineMem = Object.create(null); // vPath -> Uint8Array | null（内存缓存）
        let pgpyDiffDbPromise = null;

        function pgpyOpenDiffDB() {
          if (pgpyDiffDbPromise) return pgpyDiffDbPromise;
          pgpyDiffDbPromise = new Promise(function (resolve) {
            try {
              if (!window.indexedDB) return resolve(null);
              const req = indexedDB.open(PGPY_DIFF_DB, 1);
              req.onupgradeneeded = function () {
                const db = req.result;
                if (!db.objectStoreNames.contains(PGPY_DIFF_STORE)) {
                  db.createObjectStore(PGPY_DIFF_STORE, { keyPath: 'vPath' });
                }
              };
              req.onsuccess = function () { resolve(req.result); };
              req.onerror = function () { resolve(null); };
            } catch (_) { resolve(null); }
          });
          return pgpyDiffDbPromise;
        }

        function pgpyToBytesSafe(data) {
          if (data == null) return null;
          if (data instanceof Uint8Array) return new Uint8Array(data);
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
          try { return new TextEncoder().encode(String(data)); } catch (_) { return null; }
        }

        async function pgpyBaselinePersist(vPath, bytes) {
          const db = await pgpyOpenDiffDB();
          if (!db) return;
          try {
            await new Promise(function (res, rej) {
              const tx = db.transaction(PGPY_DIFF_STORE, 'readwrite');
              tx.objectStore(PGPY_DIFF_STORE).put({ vPath: vPath, bytes: bytes || null, at: Date.now() });
              tx.oncomplete = function () { res(); };
              tx.onerror = function () { rej(tx.error); };
            });
          } catch (_) {}
        }

        async function pgpyBaselineRead(vPath) {
          const db = await pgpyOpenDiffDB();
          if (!db) return null;
          try {
            return await new Promise(function (res, rej) {
              const tx = db.transaction(PGPY_DIFF_STORE, 'readonly');
              const r = tx.objectStore(PGPY_DIFF_STORE).get(vPath);
              r.onsuccess = function () { res(r.result || null); };
              r.onerror = function () { rej(r.error); };
            });
          } catch (_) { return null; }
        }

        async function pgpyBaselineDelete(vPaths) {
          const list = Array.isArray(vPaths) ? vPaths : [vPaths];
          const keys = [];
          for (const vp of list) {
            const key = pgpyNormalizeVPath(vp);
            if (!key) continue;
            keys.push(key);
            try { delete pgpyBaselineMem[key]; } catch (_) {}
          }
          if (!keys.length) return;
          const db = await pgpyOpenDiffDB();
          if (!db) return;
          try {
            await new Promise(function (res, rej) {
              const tx = db.transaction(PGPY_DIFF_STORE, 'readwrite');
              const store = tx.objectStore(PGPY_DIFF_STORE);
              for (const key of keys) store.delete(key);
              tx.oncomplete = function () { res(); };
              tx.onerror = function () { rej(tx.error); };
            });
          } catch (_) {}
        }

        async function pgpyBaselineDeleteAll() {
          for (const k of Object.keys(pgpyBaselineMem)) { try { delete pgpyBaselineMem[k]; } catch (_) {} }
          const db = await pgpyOpenDiffDB();
          if (!db) return;
          try {
            await new Promise(function (res, rej) {
              const tx = db.transaction(PGPY_DIFF_STORE, 'readwrite');
              tx.objectStore(PGPY_DIFF_STORE).clear();
              tx.oncomplete = function () { res(); };
              tx.onerror = function () { rej(tx.error); };
            });
          } catch (_) {}
        }

        // 首次改动某文件时记录「修改前」基线（已有基线则保留最初的）
        function pgpyCaptureBaseline(vPath, bytes) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return;
          if (Object.prototype.hasOwnProperty.call(pgpyBaselineMem, key)) return;
          const copy = pgpyToBytesSafe(bytes); // 文件不存在 → null（视为新文件）
          pgpyBaselineMem[key] = copy;
          pgpyBaselinePersist(key, copy);
        }

        // 取某文件「修改前」基线：内存 → IndexedDB → 磁盘真实文件（Electron 同步前磁盘仍是原始内容）
        async function pgpyGetBaseline(vPath) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return { known: false, bytes: null };
          if (Object.prototype.hasOwnProperty.call(pgpyBaselineMem, key)) {
            return { known: true, bytes: pgpyBaselineMem[key] };
          }
          const rec = await pgpyBaselineRead(key);
          if (rec) { pgpyBaselineMem[key] = rec.bytes || null; return { known: true, bytes: rec.bytes || null }; }
          const real = pgpyResolveRealPath(key) || pgpyPendingRealOf(key);
          if (real && window.fileAPI && typeof window.fileAPI.read === 'function') {
            try {
              const b = pgpyToBytesSafe(await window.fileAPI.read(real));
              if (b) { pgpyBaselineMem[key] = b; return { known: true, bytes: b, fromDisk: true }; }
            } catch (_) {}
          }
          return { known: false, bytes: null };
        }

        // ── 文本风格还原（EOL / BOM / 末尾换行 / 编码）──────────────────────
        // 参照物优先取「改动前基线」（= 拖入时的原始字节），其次取此刻磁盘内容。
        // 还原不成立（二进制 / 非法编码 / 换行混合）时由 EolMeta 原样返回。
        function pgpyRestoreTextStyle(bytes, meta) {
          try {
            if (bytes == null || !meta) return bytes;
            if (typeof EolMeta === 'undefined' || !EolMeta || !EolMeta.restoreBytes) return bytes;
            return EolMeta.restoreBytes(bytes, meta) || bytes;
          } catch (_) { return bytes; }
        }

        // ── 写回前的磁盘状态判定 ──────────────────────────────────
        // 返回 { state: 'same'|'changed'|'missing'|'unknown', diskBytes, meta }
        //   same    磁盘内容 == 我们开始改之前（可安全写回）
        //   changed 磁盘被外部改过（默认不写，问用户）
        //   missing 磁盘上没了（写回 = 重建；删除 = 无事可做）
        //   unknown 拿不到磁盘内容（非 Electron / 无权限）：放行，但不算「校验通过」
        async function pgpyDiskStateOf(real, vPath) {
          if (!real || !window.fileAPI) return { state: 'unknown', meta: null, diskBytes: null };
          let st = null;
          try {
            if (typeof window.fileAPI.stat === 'function') st = await window.fileAPI.stat(real);
          } catch (_) { return { state: 'missing', meta: null, diskBytes: null }; }
          if (!st || st.isFile === false) return { state: 'missing', meta: null, diskBytes: null };

          let diskBytes = null;
          try {
            if (typeof window.fileAPI.read === 'function') diskBytes = pgpyToBytesSafe(await window.fileAPI.read(real));
          } catch (_) { diskBytes = null; }

          // 参照字节：基线（拖入时内容）优先；没有基线就用此刻磁盘内容
          let refBytes = null;
          try {
            const baseline = await pgpyGetBaseline(vPath);
            if (baseline && baseline.known && baseline.bytes) refBytes = pgpyToBytesSafe(baseline.bytes);
          } catch (_) {}
          const metaBytes = refBytes || diskBytes;
          let meta = null;
          try {
            if (metaBytes && typeof EolMeta !== 'undefined' && EolMeta && EolMeta.detect) meta = EolMeta.detect(metaBytes);
          } catch (_) { meta = null; }

          if (!diskBytes) return { state: 'unknown', meta: meta, diskBytes: null };

          // 判定交给 SyncGuard（纯逻辑、有单测）：基线优先，其次指纹，都没有则 unknown
          let verdict = { state: 'unknown', reason: 'guard-unavailable' };
          try {
            if (typeof SyncGuard !== 'undefined' && SyncGuard && SyncGuard.decide) {
              verdict = SyncGuard.decide({
                diskExists: true,
                diskBytes: diskBytes,
                refBytes: refBytes,
                fp: pgpyGetDiskFp(real),
                Eol: (typeof EolMeta !== 'undefined' ? EolMeta : null)
              });
            }
          } catch (err) { console.warn('[pgpy] 磁盘状态判定异常:', err); }
          return { state: verdict.state || 'unknown', reason: verdict.reason || '', meta: meta, diskBytes: diskBytes };
        }

        // 磁盘被外部改过时问用户：跳过（默认）还是仍然覆盖
        async function pgpyAskForceOverwrite(conflictList) {
          const names = conflictList.slice(0, 8).map(function (job) {
            const short = String(job.real || '').split(/[\\/]/).slice(-2).join('/');
            return '· ' + short;
          }).join('\n');
          const more = conflictList.length > 8 ? ('\n… 另有 ' + (conflictList.length - 8) + ' 个') : '';
          const question = '以下 ' + conflictList.length + ' 个文件在你拖入之后，磁盘上的内容被改动过（IDE 保存 / git 切换 / 格式化 / 他人修改）：\n\n'
            + names + more + '\n\n默认跳过这些文件（不写），其余照常同步。';
          try {
            if (typeof askUserStore !== 'undefined' && askUserStore && typeof askUserStore.ask === 'function') {
              const r = await askUserStore.ask({
                title: '磁盘内容已变化',
                question: question,
                context: '选择「跳过」最安全：这些文件保持磁盘现状，你可以在 ⇄ 对比里重新确认后单独同步。',
                options: ['跳过这些文件（推荐）', '仍然覆盖磁盘内容'],
                allow_free_text: false
              });
              if (r && r.answered) return String(r.value || '').indexOf('仍然覆盖') === 0;
              return false; // 取消 / 超时 → 按跳过处理
            }
          } catch (_) {}
          try { return window.confirm(question + '\n\n确定 = 仍然覆盖；取消 = 跳过这些文件。'); } catch (_) { return false; }
        }

        // 字节 → 文本；识别二进制（图片 / Office / PDF 等）
        function pgpyBytesToText(bytes) {
          const u8 = pgpyToBytesSafe(bytes);
          if (!u8 || u8.length === 0) return { text: '', binary: false, empty: true };
          const n = Math.min(u8.length, 8192);
          let bad = 0;
          for (let i = 0; i < n; i++) {
            const c = u8[i];
            if (c === 0) return { text: '', binary: true, empty: false };
            if (c < 9 || (c > 13 && c < 32)) bad++;
          }
          if (bad / n > 0.3) return { text: '', binary: true, empty: false };
          try { return { text: new TextDecoder('utf-8', { fatal: false }).decode(u8), binary: false, empty: false }; }
          catch (_) { return { text: '', binary: true, empty: false }; }
        }

        // ── 待同步变更 → 刷新「⇄ 对比」按钮 & 轻提示 ───────────────────
        let pgpyPendingNotifyTimer = null;
        function pgpyNotifyPendingChanged() {
          try { pgpyUpdateDiffButton(); } catch (_) {}
          if (pgpyPendingNotifyTimer) return;
          pgpyPendingNotifyTimer = setTimeout(function () {
            pgpyPendingNotifyTimer = null;
            const n = pgpyPendingCount();
            try { if (pgpyLastResult && pgpyLastResult.isFileList) listNodeFiles(); } catch (_) {}
            if (typeof snackbarStore !== 'undefined' && n > 0) {
              snackbarStore.showInfoMessage('✏️ 有 ' + n + ' 个文件改动待同步，点「⇄ 对比」查看差异');
            }
            try { pgpyUpdateDiffButton(); } catch (_) {}
          }, 600);
        }

        function pgpyUpdateDiffButton() {
          const total = pgpyPendingCount();
          const selected = pgpySelectedFiles ? pgpySelectedFiles.size : 0;
          const canDiff = total > 0 || selected >= 2;
          const title = selected >= 2
            ? '比较勾选的两个文件'
            : (total > 0 ? '比较 AI 修改前后的差异（待同步 ' + total + ' 处）' : '比较 AI 修改前后的差异');

          // 工具栏内联按钮（已迁移到输入区左侧菜单；保留兼容，存在才更新）
          const btn = document.getElementById('diffBtn');
          if (btn) {
            const badge = document.getElementById('diffBadge');
            if (badge) { badge.textContent = total; badge.style.display = total > 0 ? '' : 'none'; }
            btn.disabled = !canDiff;
            btn.style.borderColor = canDiff ? '#6366f1' : '';
            btn.style.color = canDiff ? '#4338ca' : '';
            btn.title = title;
          }

          // 输入区左侧「速度拨盘」菜单里的 ⇄ 对比入口
          const sd = document.getElementById('sdDiffBtn');
          if (sd) {
            sd.disabled = !canDiff;
            sd.classList.toggle('sd-btn-disabled', !canDiff);
            sd.title = title;
            const sdBadge = document.getElementById('sdDiffBadge');
            if (sdBadge) { sdBadge.textContent = total; sdBadge.style.display = total > 0 ? '' : 'none'; }
          }

          // 顺带刷新对比弹窗内的「待同步文件」勾选清单（弹窗未打开时也无害）
          try { pgpyRenderDiffSyncPanel(); } catch (_) {}
        }

        // ══════════════════════════════════════════════════════════════
        //  ⇄ 对比弹窗内「待同步文件」勾选清单 + 一键同步
        //   · 列出当前所有「有待同步改动」的文件，可勾选哪些要同步；
        //   · 「一键同步勾选(N)」直接写回这些文件，无需退回文件列表；
        //   · 点击文件名可把该文件载入对比视图（等价于顶部下拉框）。
        // ══════════════════════════════════════════════════════════════
        function pgpyDiffSyncKeys() {
          const map = pgpyPendingKindMap();
          return Object.keys(map).sort();
        }

        function pgpyUpdateDiffSyncBtn() {
          const btn = document.getElementById('diffSyncBtn');
          if (!btn) return;
          const n = pgpyDiffSyncChecked ? pgpyDiffSyncChecked.size : 0;
          btn.disabled = n === 0;
          btn.textContent = '🔁 一键同步勾选 (' + n + ')';
        }

        function pgpyDiffSyncSetAll(checked) {
          const keys = pgpyDiffSyncKeys();
          pgpyDiffSyncChecked = new Set(checked ? keys : []);
          pgpyRenderDiffSyncPanel();
        }

        function pgpyRenderDiffSyncPanel() {
          const panel = document.getElementById('diffSyncPanel');
          if (!panel) return;
          const listEl = document.getElementById('diffSyncList');
          const kindMap = pgpyPendingKindMap();
          const keys = Object.keys(kindMap).sort();
          // 待同步队列里已不存在的勾选项 → 清理，避免脏数据
          for (const k of Array.from(pgpyDiffSyncChecked)) {
            if (!kindMap[k]) { try { pgpyDiffSyncChecked.delete(k); } catch (_) {} }
          }
          if (keys.length === 0) {
            panel.style.display = 'none';
            if (listEl) listEl.innerHTML = '';
            const allEl0 = document.getElementById('diffSyncAll');
            if (allEl0) allEl0.checked = false;
            pgpyUpdateDiffSyncBtn();
            return;
          }
          panel.style.display = '';
          const cur = pgpyNormalizeVPath((pgpyDiffState && pgpyDiffState.vPath) || '');
          if (listEl) {
            listEl.innerHTML = keys.map(function (k) {
              const kind = kindMap[k];
              const icon = kind === 'delete' ? '🗑' : '✏️';
              return '<div class="diff-sync-item' + (k === cur ? ' is-current' : '') + '">' +
                '<input type="checkbox" class="diff-sync-check" data-path="' + pgpyEscapeAttr(k) + '"' + (pgpyDiffSyncChecked.has(k) ? ' checked' : '') + '>' +
                '<span class="diff-sync-kind" title="' + (kind === 'delete' ? '待删除' : '待写入') + '">' + icon + '</span>' +
                '<span class="diff-sync-open" data-path="' + pgpyEscapeAttr(k) + '" title="点击查看该文件的修改前后差异">' + pgpyEscapeHtml(pgpyDisplayPath(k)) + '</span>' +
                '</div>';
            }).join('');
          }
          const cnt = document.getElementById('diffSyncCount');
          if (cnt) cnt.textContent = keys.length;
          const allEl = document.getElementById('diffSyncAll');
          if (allEl) allEl.checked = keys.every(function (k) { return pgpyDiffSyncChecked.has(k); });
          pgpyUpdateDiffSyncBtn();
        }

        // ── 行级差分：实现统一放在 hunk-select.js（唯一一份）───────────
        // ⚠️ 差分**只能有一份实现**：界面上的「第 N 块」和写盘合成时的「第 N 块」
        //    必须是同一个块，否则会「用户勾了第 2 块、写盘写成了第 3 块」。
        function pgpyDiffLines(aLines, bLines, ignoreWs) {
          return HunkSelect.diffLines(aLines, bLines, ignoreWs);
        }
        function pgpyBuildRows(aLines, bLines, ops) {
          return HunkSelect.buildRows(aLines, bLines, ops);
        }

        // ── 词级差异（改动行的行内高亮）─────────────────────────────────
        function pgpyTokenize(s) { return String(s).match(/[\w\u00c0-\uffff]+|\s+|[^\s\w]/g) || []; }

        function pgpyDiffTokens(a, b) {
          const A = pgpyTokenize(a), B = pgpyTokenize(b);
          const n = A.length, m = B.length;
          if (n * m > 60000) {
            return { left: A.map(function (t) { return { t: t, ch: true }; }), right: B.map(function (t) { return { t: t, ch: true }; }) };
          }
          const W = m + 1;
          const dp = new Uint32Array((n + 1) * W);
          for (let i = n - 1; i >= 0; i--) {
            const row = i * W, nextRow = (i + 1) * W;
            for (let j = m - 1; j >= 0; j--) {
              if (A[i] === B[j]) dp[row + j] = dp[nextRow + j + 1] + 1;
              else dp[row + j] = Math.max(dp[nextRow + j], dp[row + j + 1]);
            }
          }
          const left = [], right = [];
          let i = 0, j = 0;
          while (i < n && j < m) {
            if (A[i] === B[j]) { left.push({ t: A[i], ch: false }); right.push({ t: B[j], ch: false }); i++; j++; }
            else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { left.push({ t: A[i], ch: true }); i++; }
            else { right.push({ t: B[j], ch: true }); j++; }
          }
          while (i < n) { left.push({ t: A[i], ch: true }); i++; }
          while (j < m) { right.push({ t: B[j], ch: true }); j++; }
          return { left: left, right: right };
        }

        function pgpyTokensHtml(tokens) {
          let html = '';
          for (const tok of tokens) {
            const esc = pgpyEscapeHtml(tok.t);
            html += tok.ch ? '<span class="diff-wd">' + esc + '</span>' : esc;
          }
          return html;
        }

        // 仅差异模式：把连续未改动行折叠为「⋯ N 行」
        function pgpyCollapseRows(rows, ctx) {
          const out = [];
          let i = 0;
          while (i < rows.length) {
            if (rows[i].type !== 'equal') { out.push({ kind: 'row', row: rows[i], idx: i }); i++; continue; }
            let j = i; while (j < rows.length && rows[j].type === 'equal') j++;
            const runLen = j - i;
            if (runLen > ctx * 2 + 1) {
              for (let k = 0; k < ctx; k++) out.push({ kind: 'row', row: rows[i + k], idx: i + k });
              out.push({ kind: 'gap', n: runLen - ctx * 2 });
              for (let k = ctx; k > 0; k--) out.push({ kind: 'row', row: rows[j - k], idx: j - k });
            } else {
              for (let k = i; k < j; k++) out.push({ kind: 'row', row: rows[k], idx: k });
            }
            i = j;
          }
          return out;
        }

        function pgpyCollapseOps(ops, ctx) {
          const out = [];
          let i = 0;
          while (i < ops.length) {
            if (ops[i].type !== 'equal') { out.push({ kind: 'op', op: ops[i], idx: i }); i++; continue; }
            let j = i; while (j < ops.length && ops[j].type === 'equal') j++;
            const runLen = j - i;
            if (runLen > ctx * 2 + 1) {
              for (let k = 0; k < ctx; k++) out.push({ kind: 'op', op: ops[i + k], idx: i + k });
              out.push({ kind: 'gap', n: runLen - ctx * 2 });
              for (let k = ctx; k > 0; k--) out.push({ kind: 'op', op: ops[j - k], idx: j - k });
            } else {
              for (let k = i; k < j; k++) out.push({ kind: 'op', op: ops[k], idx: k });
            }
            i = j;
          }
          return out;
        }

        const pgpyDiffState = {
          mode: 'split', onlyChanges: false, ignoreWs: false,
          aText: '', bText: '', aBinary: false, bBinary: false,
          aLabel: '修改前', bLabel: '修改后', kind: 'write', vPath: '', twoFiles: false,
          beforeKnown: true,
          aLines: [], bLines: [], ops: [], rows: [], _blockCount: 0, current: -1,
          // 块级接受：blocks = 变更块，accepted = 已接受的块下标集合
          blocks: [], accepted: new Set(), hunkable: false, maskKey: null,
        };

        function pgpyRenderDiff() {
          const st = pgpyDiffState;
          const panes = document.getElementById('diffPanes');
          if (!panes) return;
          const statsEl = document.getElementById('diffStats');
          const leftLabel = document.getElementById('diffLeftLabel');
          const rightLabel = document.getElementById('diffRightLabel');
          if (leftLabel) leftLabel.textContent = st.aLabel;
          if (rightLabel) rightLabel.textContent = st.bLabel;

          if (st.aBinary || st.bBinary) {
            panes.innerHTML = '<div class="diff-binary">⚠️ 二进制文件（图片 / Office / PDF 等）无法逐行比较。</div>';
            if (statsEl) statsEl.textContent = '';
            st._blockCount = 0; st.current = -1;
            st.blocks = []; st.accepted = new Set(); st.hunkable = false;
            pgpyUpdateDiffNav(); pgpyRenderHunkBar();
            return;
          }
          st.aLines = HunkSelect.splitText(st.aText);
          st.bLines = HunkSelect.splitText(st.bText);
          st.ops = pgpyDiffLines(st.aLines, st.bLines, st.ignoreWs);
          st.rows = pgpyBuildRows(st.aLines, st.bLines, st.ops);
          // 块级接受：块与选择集在这里一次算好。渲染用的块号 = 写盘合成用的块号。
          pgpyPrepareHunks();

          let add = 0, del = 0, mod = 0;
          for (const r of st.rows) {
            if (r.type === 'add') add++; else if (r.type === 'del') del++; else if (r.type === 'mod') mod++;
          }
          if (statsEl) {
            statsEl.innerHTML = '<span class="diff-stat-add">+' + add + '</span> <span class="diff-stat-del">−' + del + '</span>' +
              (mod ? ' <span class="diff-stat-mod">~' + mod + '</span>' : '');
          }
          if (st.mode === 'unified') pgpyRenderUnified(); else pgpyRenderSplit();
          st.current = st._blockCount > 0 ? 0 : -1;
          pgpyDiffGoTo(0, false);
          pgpyRenderHunkBar();
        }

        function pgpyRenderSplit() {
          const st = pgpyDiffState;
          const panes = document.getElementById('diffPanes');
          const items = st.onlyChanges ? pgpyCollapseRows(st.rows, 2)
            : st.rows.map(function (r, i) { return { kind: 'row', row: r, idx: i }; });
          const hk = !!st.hunkable;
          const cols = hk ? 5 : 4;
          let html = '<table class="diff-table diff-split"><colgroup>' +
            (hk ? '<col style="width:26px">' : '') +
            '<col style="width:44px"><col><col style="width:44px"><col></colgroup><tbody>';
          let lastBlock = -1;
          st._blockCount = st.blocks ? st.blocks.length : 0;
          for (const it of items) {
            if (it.kind === 'gap') {
              html += '<tr class="dgap"><td colspan="' + cols + '">⋯ 省略 ' + it.n + ' 行未改动 ⋯</td></tr>';
              lastBlock = -1;
              continue;
            }
            const r = it.row;
            const isChange = r.type !== 'equal';
            const blk = isChange ? r.block : -1;
            const accepted = !isChange || !hk || st.accepted.has(blk);
            const blockAttr = isChange ? ' data-block="' + blk + '"' : '';
            let chk = '';
            if (hk) {
              if (isChange && blk !== lastBlock) {
                chk = '<td class="dchk"><input type="checkbox" class="dchk-box" data-block="' + blk + '"' +
                  (st.accepted.has(blk) ? ' checked' : '') + ' title="接受这块改动（取消勾选 = 这块不写回磁盘）"></td>';
              } else {
                chk = '<td class="dchk"></td>';
              }
            }
            let lHtml, rHtml;
            if (r.type === 'mod') {
              if (!r._wd) r._wd = pgpyDiffTokens(r.lText, r.rText);
              lHtml = pgpyTokensHtml(r._wd.left);
              rHtml = pgpyTokensHtml(r._wd.right);
            } else {
              lHtml = r.li >= 0 ? pgpyEscapeHtml(r.lText) : '';
              rHtml = r.ri >= 0 ? pgpyEscapeHtml(r.rText) : '';
            }
            html += '<tr class="drow d-' + r.type + (accepted ? '' : ' d-rejected') + '"' + blockAttr + '>' +
              chk +
              '<td class="dln">' + (r.li >= 0 ? (r.li + 1) : '') + '</td>' +
              '<td class="dcode">' + lHtml + '</td>' +
              '<td class="dln">' + (r.ri >= 0 ? (r.ri + 1) : '') + '</td>' +
              '<td class="dcode">' + rHtml + '</td>' +
              '</tr>';
            lastBlock = blk;
          }
          html += '</tbody></table>';
          panes.innerHTML = html;
        }

        function pgpyRenderUnified() {
          const st = pgpyDiffState;
          const panes = document.getElementById('diffPanes');
          const items = st.onlyChanges ? pgpyCollapseOps(st.ops, 2)
            : st.ops.map(function (o, i) { return { kind: 'op', op: o, idx: i }; });
          const hk = !!st.hunkable;
          const cols = hk ? 4 : 3;
          const optoBlock = (st.ops && HunkSelect.blockIndexByOp) ? HunkSelect.blockIndexByOp(st.ops) : [];
          let html = '<table class="diff-table diff-unified"><colgroup>' +
            (hk ? '<col style="width:26px">' : '') +
            '<col style="width:44px"><col style="width:44px"><col></colgroup><tbody>';
          let lastBlock = -1;
          st._blockCount = st.blocks ? st.blocks.length : 0;
          for (const it of items) {
            if (it.kind === 'gap') {
              html += '<tr class="dgap"><td colspan="' + cols + '">⋯ 省略 ' + it.n + ' 行未改动 ⋯</td></tr>';
              lastBlock = -1;
              continue;
            }
            const o = it.op;
            const blk = (o.type === 'equal') ? -1 : (optoBlock[it.idx] === undefined ? -1 : optoBlock[it.idx]);
            const accepted = (o.type === 'equal') || !hk || blk < 0 || st.accepted.has(blk);
            let sign = ' ', cls = 'u-equal', blockAttr = '';
            if (o.type === 'del') { sign = '-'; cls = 'u-del'; }
            else if (o.type === 'ins') { sign = '+'; cls = 'u-ins'; }
            if (o.type !== 'equal') blockAttr = ' data-block="' + blk + '"';
            let chk = '';
            if (hk) {
              if (o.type !== 'equal' && blk !== lastBlock) {
                chk = '<td class="dchk"><input type="checkbox" class="dchk-box" data-block="' + blk + '"' +
                  (st.accepted.has(blk) ? ' checked' : '') + ' title="接受这块改动"></td>';
              } else {
                chk = '<td class="dchk"></td>';
              }
            }
            const aNo = o.type === 'ins' ? '' : (o.ai + 1);
            const bNo = o.type === 'del' ? '' : (o.bi + 1);
            const text = o.type === 'ins' ? st.bLines[o.bi] : st.aLines[o.ai];
            html += '<tr class="urow ' + cls + (accepted ? '' : ' d-rejected') + '"' + blockAttr + '>' +
              chk +
              '<td class="dln">' + aNo + '</td>' +
              '<td class="dln">' + bNo + '</td>' +
              '<td class="dcode"><span class="d-sign">' + sign + '</span>' + pgpyEscapeHtml(text == null ? '' : text) + '</td>' +
              '</tr>';
            lastBlock = blk;
          }
          html += '</tbody></table>';
          panes.innerHTML = html;
        }

        function pgpyDiffGoTo(k, scroll) {
          const st = pgpyDiffState;
          const total = st._blockCount || 0;
          if (total <= 0) { pgpyUpdateDiffNav(); return; }
          if (k < 0) k = total - 1;
          if (k >= total) k = 0;
          st.current = k;
          const panes = document.getElementById('diffPanes');
          if (panes) {
            panes.querySelectorAll('.diff-current').forEach(function (el) { el.classList.remove('diff-current'); });
            const el = panes.querySelector('[data-block="' + k + '"]');
            if (el) {
              el.classList.add('diff-current');
              if (scroll !== false && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
            }
          }
          pgpyUpdateDiffNav();
        }

        function pgpyUpdateDiffNav() {
          const el = document.getElementById('diffNavCount');
          if (!el) return;
          const total = pgpyDiffState._blockCount || 0;
          el.textContent = total > 0 ? ((pgpyDiffState.current + 1) + ' / ' + total) : '无差异';
        }

        function pgpyPopulateDiffSelect(currentVPath) {
          const sel = document.getElementById('diffFileSelect');
          const wrap = document.getElementById('diffFileWrap');
          if (!sel || !wrap) return;
          if (pgpyDiffState.twoFiles) { wrap.style.display = 'none'; return; }
          const map = pgpyPendingKindMap();
          const keys = Object.keys(map).sort();
          if (keys.length === 0) { wrap.style.display = 'none'; sel.innerHTML = ''; return; }
          wrap.style.display = '';
          const cur = pgpyNormalizeVPath(currentVPath);
          sel.innerHTML = keys.map(function (k) {
            const label = (map[k] === 'delete' ? '🗑 ' : '✏️ ') + pgpyDisplayPath(k);
            return '<option value="' + pgpyEscapeAttr(k) + '"' + (k === cur ? ' selected' : '') + '>' + pgpyEscapeHtml(label) + '</option>';
          }).join('');
        }

        async function pgpyShowDiffModal(cfg) {
          cfg = cfg || {};
          const modal = document.getElementById('diffModal');
          if (!modal) return;
          const st = pgpyDiffState;
          st.aText = cfg.aText || '';
          st.bText = cfg.bText || '';
          st.aBinary = !!cfg.aBinary;
          st.bBinary = !!cfg.bBinary;
          st.aLabel = cfg.leftLabel || '修改前';
          st.bLabel = cfg.rightLabel || '修改后';
          st.kind = cfg.kind || 'write';
          st.vPath = cfg.vPath || '';
          st.twoFiles = !!cfg.twoFiles;
          st.beforeKnown = cfg.beforeKnown !== false;
          const titleEl = document.getElementById('diffTitleText');
          if (titleEl) titleEl.textContent = cfg.title || '文件比较';
          const hint = document.getElementById('diffHint');
          if (hint) {
            let h = st.twoFiles
              ? '两个勾选文件的互相对比'
              : (st.kind === 'delete' ? '该文件将被删除（红色为删除内容）' : '红色 = 修改前 / 绿色 = 修改后');
            if (!st.twoFiles && cfg.beforeKnown === false) {
              h = '⚠️ 未能获取「修改前」内容（可能来自旧版待同步记录），当前按“新增文件”显示。 ' + h;
            }
            hint.textContent = h;
            st.hintBase = h;
          }
          pgpyPopulateDiffSelect(st.vPath);
          pgpyRenderDiff();
          // 打开对比弹窗时，「待同步文件」勾选清单默认全选（可直接一键同步全部）。
          // 只在这里重置：后台刷新（pgpyUpdateDiffButton → pgpyRenderDiffSyncPanel）不会改动手动勾选。
          try { pgpyDiffSyncChecked = new Set(pgpyDiffSyncKeys()); } catch (_) {}
          pgpyRenderDiffSyncPanel();
          modal.classList.add('open');
        }

        // 比较某文件：AI「修改前」基线 ⇄ 当前虚拟 FS 内容
        async function pgpyOpenDiff(vPath) {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return;
          const kindMap = pgpyPendingKindMap();
          const kind = kindMap[key] || 'write';
          let afterBytes = null;
          try { afterBytes = nodeRuntime.FS.readFile(key, { encoding: 'binary' }); } catch (_) { afterBytes = null; }
          const before = await pgpyGetBaseline(key);
          const a = pgpyBytesToText(before.bytes);
          const b = pgpyBytesToText(kind === 'delete' ? null : afterBytes);
          await pgpyShowDiffModal({
            title: pgpyDisplayPath(key),
            leftLabel: (before.known ? '修改前' : '修改前（无基线）') + ' — ' + pgpyBasename(key),
            rightLabel: (kind === 'delete' ? '修改后（已删除）' : '修改后') + ' — ' + pgpyBasename(key),
            aText: a.text, bText: b.text, aBinary: a.binary, bBinary: b.binary,
            kind: kind, vPath: key, twoFiles: false, beforeKnown: before.known,
          });
        }

        // 两个文件互相对比（在列表中勾选 ≥2 个文件时）
        async function pgpyOpenDiffTwoFiles(pathA, pathB) {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          const ka = pgpyNormalizeVPath(pathA), kb = pgpyNormalizeVPath(pathB);
          let ba = null, bb = null;
          try { ba = nodeRuntime.FS.readFile(ka, { encoding: 'binary' }); } catch (_) {}
          try { bb = nodeRuntime.FS.readFile(kb, { encoding: 'binary' }); } catch (_) {}
          const ta = pgpyBytesToText(ba), tb = pgpyBytesToText(bb);
          await pgpyShowDiffModal({
            title: pgpyBasename(ka) + '  ⇄  ' + pgpyBasename(kb),
            leftLabel: pgpyDisplayPath(ka),
            rightLabel: pgpyDisplayPath(kb),
            aText: ta.text, bText: tb.text, aBinary: ta.binary, bBinary: tb.binary,
            vPath: '', twoFiles: true,
          });
        }

        // 「⇄ 对比」按钮：勾选 ≥2 个文件 → 两两对比；否则比较单文件改动
        function pgpyOpenDiffFromSelection() {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          const selected = Array.from(pgpySelectedFiles || []);
          if (selected.length >= 2) { pgpyOpenDiffTwoFiles(selected[0], selected[1]); return; }
          const kindMap = pgpyPendingKindMap();
          const keys = Object.keys(kindMap);
          let target = selected[0] || pgpyCurrentFilePath || '';
          if (!target) {
            if (keys.length === 1) target = keys[0];
            else if (keys.length > 1) { pgpyOpenDiff(keys.sort()[0]); return; } // 打开选择器（默认第一个）
          }
          if (!target) { alert('没有可比较的文件：请先让 AI 修改文件，或在列表中勾选文件。'); return; }
          pgpyOpenDiff(target);
        }

        function pgpyDiffCopy(side) {
          const text = side === 'left' ? pgpyDiffState.aText : pgpyDiffState.bText;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
            if (typeof snackbarStore !== 'undefined') snackbarStore.showSuccessMessage('已复制' + (side === 'left' ? '修改前' : '修改后') + '内容');
          } catch (_) {}
        }

        function pgpyInitDiffUI() {
          const modal = document.getElementById('diffModal');
          if (!modal || modal.__wired) return;
          modal.__wired = true;
          const close = function () { modal.classList.remove('open'); };
          const close2 = document.getElementById('diffClose2');
          if (close2) close2.addEventListener('click', close);
          modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
          modal.querySelectorAll('.diff-mode-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
              modal.querySelectorAll('.diff-mode-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
              pgpyDiffState.mode = btn.getAttribute('data-mode') || 'split';
              pgpyRenderDiff();
            });
          });
          const oc = document.getElementById('diffOnlyChanges');
          if (oc) oc.addEventListener('change', function () { pgpyDiffState.onlyChanges = oc.checked; pgpyRenderDiff(); });
          const iw = document.getElementById('diffIgnoreWs');
          if (iw) iw.addEventListener('change', function () { pgpyDiffState.ignoreWs = iw.checked; pgpyRenderDiff(); });
          const prev = document.getElementById('diffPrev');
          if (prev) prev.addEventListener('click', function () { pgpyDiffGoTo(pgpyDiffState.current - 1); });
          const next = document.getElementById('diffNext');
          if (next) next.addEventListener('click', function () { pgpyDiffGoTo(pgpyDiffState.current + 1); });
          const sel = document.getElementById('diffFileSelect');
          if (sel) sel.addEventListener('change', function () { if (sel.value) pgpyOpenDiff(sel.value); });
          const cl = document.getElementById('diffCopyLeft');
          if (cl) cl.addEventListener('click', function () { pgpyDiffCopy('left'); });
          const cr = document.getElementById('diffCopyRight');
          if (cr) cr.addEventListener('click', function () { pgpyDiffCopy('right'); });
          // 文件行内「⇄ 对比」按钮
          document.addEventListener('click', function (e) {
            const b = e.target && e.target.closest ? e.target.closest('.pgpy-diff-link') : null;
            if (b) {
              e.preventDefault();
              e.stopPropagation();
              const p = b.getAttribute('data-path');
              if (p) pgpyOpenDiff(p);
            }
          });
          // 键盘：Esc 关闭 / Alt+↑↓ 切换差异
          document.addEventListener('keydown', function (e) {
            if (!modal.classList.contains('open')) return;
            if (e.key === 'Escape') close();
            else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); pgpyDiffGoTo(pgpyDiffState.current + 1); }
            else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); pgpyDiffGoTo(pgpyDiffState.current - 1); }
          });
          // 对比弹窗内「待同步文件」勾选清单：勾选 / 点击文件名查看 / 全选 / 全不选 / 一键同步
          const syncList = document.getElementById('diffSyncList');
          if (syncList) {
            syncList.addEventListener('change', function (e) {
              const cb = e.target;
              if (cb && cb.classList && cb.classList.contains('diff-sync-check')) {
                const p = cb.getAttribute('data-path');
                if (p) { if (cb.checked) pgpyDiffSyncChecked.add(p); else pgpyDiffSyncChecked.delete(p); }
                pgpyRenderDiffSyncPanel();
              }
            });
            syncList.addEventListener('click', function (e) {
              const link = e.target && e.target.closest ? e.target.closest('.diff-sync-open') : null;
              if (link) { e.preventDefault(); const p = link.getAttribute('data-path'); if (p) pgpyOpenDiff(p); }
            });
          }
          const syncAll = document.getElementById('diffSyncAll');
          if (syncAll) syncAll.addEventListener('change', function () { pgpyDiffSyncSetAll(syncAll.checked); });
          const syncNone = document.getElementById('diffSyncNone');
          if (syncNone) syncNone.addEventListener('click', function () { pgpyDiffSyncSetAll(false); });
          const syncBtn = document.getElementById('diffSyncBtn');
          if (syncBtn) syncBtn.addEventListener('click', function () { pgpySyncPaths(Array.from(pgpyDiffSyncChecked)); });
          try { pgpyWireHunkUI(); } catch (_) {}
          pgpyUpdateDiffButton();
        }

        // 页面关闭前兜底再保存一次（写入 IndexedDB）
        window.addEventListener('pagehide', function () {
          try {
            if (nodeRuntime && nodeRuntime.ready) {
              const p = nodeRuntime.saveSnapshot();
              if (p && typeof p.catch === 'function') p.catch(function () {});
            }
          } catch (_) {}
        });

        // 启动 almostnode 运行时（页面加载即开始；幂等）
        async function initNodeRuntime() {
          const statusEl = document.getElementById('pgpyStatus');
          try {
            if (statusEl) { statusEl.className = 'pgpy-status-badge pgpy-loading'; statusEl.textContent = '⏳ Loading Node.js runtime...'; }
            await nodeRuntime.init();
            if (statusEl) { statusEl.className = 'pgpy-status-badge pgpy-success'; statusEl.textContent = '✅ Node Ready'; }
            pgpyUpdateRunButton();
          } catch (err) {
            console.error('Node runtime init error:', err);
            if (statusEl) { statusEl.className = 'pgpy-status-badge pgpy-error'; statusEl.textContent = '❌ Failed to load'; }
          }
        }

        function toggleAiMode() {
          pgpyAiMode = !pgpyAiMode;
          const btn = document.getElementById('aiModeBtn');
          if (!btn) return;
          const runBtn = document.getElementById('runBtn');
          if (pgpyAiMode) {
            btn.style.background = '#10b981';
            btn.style.borderColor = '#10b981';
            btn.style.color = 'white';
            btn.style.fontWeight = '600';
            btn.innerHTML = '🤖 <span class="pgpy-label-text">AI On</span>';
            if (runBtn) { runBtn.style.background = '#10b981'; runBtn.style.borderColor = '#10b981'; }
          } else {
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
            btn.style.fontWeight = '';
            btn.innerHTML = '🤖 <span class="pgpy-label-text">AI Off</span>';
            if (runBtn) { runBtn.style.background = ''; runBtn.style.borderColor = ''; }
          }
        }



        // ══════════════════════════════════════════════════════════════════
        //  块级接受 · 交付门禁 · 结构化改动摘要
        //  ──────────────────────────────────────────────────────────────
        //  设计要点（三条，缺一不可）：
        //   1) 块的编号只认 HunkSelect —— 界面渲染与写盘合成共用同一份差分，
        //      否则会「用户勾了第 2 块、写盘写成第 3 块」；
        //   2) 选择集以「真实路径 + 内容签名」为键持久化。AI 再改一次，签名就变，
        //      旧勾选自动作废（退回「全接受」），绝不把旧决定错套到新改动上；
        //   3) 门禁（类型/语法）跑在**合成结果**上，不是跑在单个块上 ——
        //      单块天然自洽，bug 只存在于拼装处。
        // ══════════════════════════════════════════════════════════════════

        const PGPY_HUNK_KEY = 'pgpy_hunk_accept_v1';
        let pgpyHunkMasks = {};
        try { pgpyHunkMasks = JSON.parse(localStorage.getItem(PGPY_HUNK_KEY) || '{}') || {}; } catch (_) { pgpyHunkMasks = {}; }

        function pgpySaveHunkMasks() {
          try { localStorage.setItem(PGPY_HUNK_KEY, JSON.stringify(pgpyHunkMasks)); } catch (_) {}
        }

        // 虚拟路径 → 参与同步的真实路径（与写回时的解析规则一致）
        function pgpyHunkRealOf(vPath) {
          return pgpyResolveRealPath(vPath) || pgpyPendingRealOf(vPath) || pgpyNormalizeVPath(vPath);
        }

        // 算好本次 diff 的块与选择集（渲染前调用一次；写盘合成读的就是这份）
        function pgpyPrepareHunks() {
          const st = pgpyDiffState;
          st.blocks = HunkSelect.blocksOf(st.ops || []);
          const total = st.blocks.length;
          const all = function () { const set = new Set(); for (let i = 0; i < total; i++) set.add(i); return set; };
          const canHunk = !!st.vPath && !st.twoFiles && st.kind !== 'delete' && !st.aBinary && !st.bBinary && total > 0;
          st.hunkable = canHunk;
          st.maskKey = null;
          if (!canHunk) { st.accepted = all(); return; }
          const real = pgpyHunkRealOf(st.vPath);
          const sig = HunkSelect.signature(st.aText, st.bText, !!st.ignoreWs);
          st.maskKey = { real: real, sig: sig };
          const m = pgpyHunkMasks[real];
          if (m && m.sig === sig && Array.isArray(m.accepted)) {
            const set = new Set();
            for (const i of m.accepted) if (i >= 0 && i < total) set.add(i);
            st.accepted = set;
          } else {
            st.accepted = all();
          }
        }

        // 把当前选择持久化：全接受 = 不留记录（等价于今天的行为）
        function pgpyStoreHunks() {
          const st = pgpyDiffState;
          if (!st.hunkable || !st.maskKey || !st.maskKey.real) return;
          const total = (st.blocks || []).length;
          const acc = Array.from(st.accepted).sort(function (a, b) { return a - b; });
          if (acc.length === total) delete pgpyHunkMasks[st.maskKey.real];
          else pgpyHunkMasks[st.maskKey.real] = { sig: st.maskKey.sig, accepted: acc };
          pgpySaveHunkMasks();
        }

        function pgpyHunkStats() {
          const st = pgpyDiffState;
          const blocks = st.blocks || [];
          let add = 0, del = 0;
          for (const b of blocks) {
            if (!st.accepted.has(b.index)) continue;
            add += b.inss.length; del += b.dels.length;
          }
          return { add: add, del: del, accepted: (st.accepted ? st.accepted.size : 0), total: blocks.length };
        }

        function pgpyRenderHunkBar() {
          const st = pgpyDiffState;
          const bar = document.getElementById('diffHunkBar');
          const cnt = document.getElementById('diffHunkCount');
          const applyBtn = document.getElementById('diffApplyHunks');
          const stats = pgpyHunkStats();
          if (bar) bar.style.display = st.hunkable ? '' : 'none';
          if (cnt) {
            cnt.textContent = stats.accepted + '/' + stats.total;
            cnt.className = stats.accepted === stats.total ? 'dh-ok' : (stats.accepted === 0 ? 'dh-none' : 'dh-part');
          }
          if (applyBtn) {
            applyBtn.style.display = st.hunkable ? '' : 'none';
            applyBtn.disabled = !st.hunkable || stats.accepted === 0;
            applyBtn.textContent = stats.accepted === stats.total
              ? '✅ 写回全部 ' + stats.total + ' 块'
              : '✅ 写回所选 ' + stats.accepted + '/' + stats.total + ' 块';
          }
          // 提示条：保留「无基线」这类既有警告，只在后面追加块级接受的状态
          const hint = document.getElementById('diffHint');
          if (hint) {
            const base = st.hintBase || '';
            let extra = '';
            if (st.hunkable && stats.total > 0) {
              extra = stats.accepted === stats.total
                ? '全部 ' + stats.total + ' 块都会写回；写盘前会跑类型检查。'
                : '⛔ 未勾选的 ' + (stats.total - stats.accepted) + ' 块不会写回磁盘；合成结果 +' + (stats.add || 0) + ' / −' + (stats.del || 0) + '，写盘前会跑类型检查。';
            }
            hint.textContent = base && extra ? (base + ' · ' + extra) : (base || extra);
          }
        }

        function pgpyToggleHunk(idx, on) {
          const st = pgpyDiffState;
          if (!st.hunkable) return;
          if (on) st.accepted.add(idx); else st.accepted.delete(idx);
          pgpyStoreHunks();
          // 局部更新：只重画受影响的行，保留滚动位置
          const panes = document.getElementById('diffPanes');
          const keep = panes ? panes.scrollTop : 0;
          if (st.mode === 'unified') pgpyRenderUnified(); else pgpyRenderSplit();
          if (panes) panes.scrollTop = keep;
          pgpyRenderHunkBar();
        }

        function pgpySetAllHunks(on) {
          const st = pgpyDiffState;
          if (!st.hunkable) return;
          st.accepted = new Set();
          if (on) for (const b of st.blocks) st.accepted.add(b.index);
          pgpyStoreHunks();
          const panes = document.getElementById('diffPanes');
          const keep = panes ? panes.scrollTop : 0;
          if (st.mode === 'unified') pgpyRenderUnified(); else pgpyRenderSplit();
          if (panes) panes.scrollTop = keep;
          pgpyRenderHunkBar();
        }

        function pgpyWireHunkUI() {
          const modal = document.getElementById('diffModal');
          if (!modal || modal.__hunkWired) return;
          modal.__hunkWired = true;
          const panes = document.getElementById('diffPanes');
          if (panes) {
            panes.addEventListener('change', function (e) {
              const cb = e.target;
              if (!cb || !cb.classList || !cb.classList.contains('dchk-box')) return;
              const idx = parseInt(cb.getAttribute('data-block'), 10);
              if (!isNaN(idx)) pgpyToggleHunk(idx, !!cb.checked);
            });
          }
          const allBtn = document.getElementById('diffHunkAll');
          if (allBtn) allBtn.addEventListener('click', function () { pgpySetAllHunks(true); });
          const noneBtn = document.getElementById('diffHunkNone');
          if (noneBtn) noneBtn.addEventListener('click', function () { pgpySetAllHunks(false); });
          const applyBtn = document.getElementById('diffApplyHunks');
          if (applyBtn) applyBtn.addEventListener('click', function () { pgpyApplyHunks(); });
          const copyBtn = document.getElementById('diffDeliverCopy');
          if (copyBtn) copyBtn.addEventListener('click', function () {
            const body = document.getElementById('diffDeliverBody');
            const md = body ? body.textContent : '';
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md);
              if (typeof snackbarStore !== 'undefined') snackbarStore.showSuccessMessage('已复制交付说明');
            } catch (_) {}
          });
          const tog = document.getElementById('diffDeliverToggle');
          if (tog) tog.addEventListener('click', function () {
            const wrap = document.getElementById('diffDeliver');
            if (!wrap) return;
            const open = !wrap.classList.contains('is-collapsed');
            wrap.classList.toggle('is-collapsed', open);
            tog.textContent = open ? '展开' : '收起';
          });
        }

        // 强制把某虚拟文件的「修改前」基线换成给定字节（部分接受后轮转基线用）
        async function pgpyForceBaseline(vPath, bytes) {
          const key = pgpyNormalizeVPath(vPath);
          if (!key) return;
          const u8 = pgpyToBytesSafe(bytes);
          pgpyBaselineMem[key] = u8;
          try { await pgpyBaselinePersist(key, u8); } catch (_) {}
          try { const real = pgpyResolveRealPath(key); if (real && u8) pgpyRecordDiskFp(real, u8); } catch (_) {}
        }

        // 门禁：在「合成结果」上跑诊断（不是跑在单个块上）
        async function pgpyGateFor(vPath, text, displayPath) {
          const label = displayPath || pgpyDisplayPath(vPath);
          if (typeof TypeGate === 'undefined') {
            return { status: 'unavailable', blocked: false, reason: '门禁模块未加载', errors: [], warnings: [], checked: 0 };
          }
          const kind = TypeGate.canCheck(vPath);
          if (!kind) return { status: 'skipped', blocked: false, reason: '该文件类型不做类型检查', errors: [], warnings: [], checked: 0 };
          if (kind === 'json') {
            try { return TypeGate.verdict({ path: label, jsonError: TypeGate.jsonError(text) || null }); } catch (_) {
              return { status: 'unavailable', blocked: false, reason: 'JSON 检查异常', errors: [], warnings: [], checked: 0 };
            }
          }
          let ts = null, libs = null;
          try {
            if (window.PgpLsp && typeof window.PgpLsp.loadEngine === 'function') await window.PgpLsp.loadEngine();
            ts = window.ts; libs = window.__TS_LIBS__ || null;
          } catch (_) { ts = null; }
          if (!ts || !ts.createLanguageService) {
            return { status: 'unavailable', blocked: false, reason: 'TypeScript 引擎未就绪', errors: [], warnings: [], checked: 0 };
          }
          const readFile = function (pp) {
            try { return String(nodeRuntime.FS.readFileSync(pp, 'utf8')); } catch (_) { return undefined; }
          };
          const r = TypeGate.diagnose({ path: pgpyNormalizeVPath(vPath), text: text, readFile: readFile, ts: ts, libs: libs });
          if (!r.ok) return { status: 'unavailable', blocked: false, reason: r.reason || '诊断未运行', errors: [], warnings: [], checked: 0 };
          const v = TypeGate.verdict({ path: label, diagnostics: r.items, checked: 1 });
          // 诊断条目里可能是别的文件（依赖报错），标注一下来源，避免误以为是本文件
          return v;
        }

        // 合并多个文件的门禁结论（任何一个阻断 → 整体阻断）
        function pgpyMergeGates(list) {
          const gates = (list || []).filter(Boolean);
          if (!gates.length) return { status: 'skipped', blocked: false, reason: '没有可检查的文件', errors: [], warnings: [], checked: 0 };
          const blocked = gates.filter(function (g) { return g.blocked; });
          if (blocked.length) {
            const errors = [];
            for (const g of blocked) for (const e of (g.errors || [])) errors.push(e);
            return { status: 'block', blocked: true, reason: blocked.length + ' 个文件存在阻断性错误', errors: errors, warnings: [], checked: gates.reduce(function (a, g) { return a + (g.checked || 0); }, 0) };
          }
          const unavail = gates.filter(function (g) { return g.status === 'unavailable'; });
          const warns = [];
          for (const g of gates) for (const w of (g.warnings || [])) warns.push(w);
          const checked = gates.reduce(function (a, g) { return a + (g.checked || 0); }, 0);
          if (unavail.length === gates.length) {
            return { status: 'unavailable', blocked: false, reason: unavail[0].reason || '诊断未运行', errors: [], warnings: warns, checked: 0 };
          }
          if (warns.length) return { status: 'warn', blocked: false, reason: '有告警（不阻断）', errors: [], warnings: warns, checked: checked };
          if (!checked) return { status: 'skipped', blocked: false, reason: '没有可检查的文件类型', errors: [], warnings: [], checked: 0 };
          return { status: 'pass', blocked: false, reason: '', errors: [], warnings: [], checked: checked };
        }

        async function pgpyAskChoice(title, question, options, context) {
          try {
            if (typeof askUserStore !== 'undefined' && askUserStore && typeof askUserStore.ask === 'function') {
              const r = await askUserStore.ask({ title: title, question: question, context: context || '', options: options, allow_free_text: false });
              if (r && r.answered) return String(r.value || '');
            }
          } catch (_) {}
          return '';
        }

        function pgpyShowDeliverPanel(summary) {
          const wrap = document.getElementById('diffDeliver');
          const body = document.getElementById('diffDeliverBody');
          const line = document.getElementById('diffDeliverLine');
          if (!wrap || !body || typeof DeliverySummary === 'undefined') return;
          wrap.style.display = '';
          wrap.classList.remove('is-collapsed');
          const md = DeliverySummary.toMarkdown(summary);
          body.textContent = md;
          if (line) line.textContent = DeliverySummary.oneLine(summary);
          const g = summary.gate || {};
          wrap.classList.toggle('is-blocked', !!g.blocked);
          wrap.classList.toggle('is-warn', !g.blocked && (g.status === 'warn' || (summary.totals && summary.totals.riskHigh > 0)));
          const tog = document.getElementById('diffDeliverToggle');
          if (tog) tog.textContent = '收起';
        }

        function pgpyHideDeliverPanel() {
          const wrap = document.getElementById('diffDeliver');
          if (wrap) { wrap.style.display = 'none'; wrap.classList.remove('is-blocked', 'is-warn'); }
        }

        // 当前 diff 的「交付条目」（供摘要用）
        function pgpyEntryForDiff(comp) {
          const st = pgpyDiffState;
          const known = st.beforeKnown !== false && st.kind !== 'delete';
          return DeliverySummary.analyzeFile({
            path: pgpyDisplayPath(st.vPath),
            aText: known ? st.aText : null,
            bText: st.kind === 'delete' ? '' : comp.text,
            kind: st.kind,
            add: comp.stats.add, del: comp.stats.del,
            total: comp.total, accepted: comp.acceptedCount,
            binary: !!(st.aBinary || st.bBinary),
            baselineUnknown: !known
          });
        }

        // 「写回所选块」：合成 → 门禁 → 摘要 → 用户确认 → 走唯一的写盘入口
        async function pgpyApplyHunks() {
          const st = pgpyDiffState;
          if (!st.hunkable || !st.vPath) return;
          const acc = Array.from(st.accepted).sort(function (a, b) { return a - b; });
          if (!acc.length) { alert('没有勾选任何块：全部拒绝时磁盘不会有任何变化。'); return; }
          if (typeof DeliverySummary === 'undefined') { alert('交付摘要模块未加载，已中止（不允许无摘要写盘）。'); return; }

          const comp = HunkSelect.compose(st.aText, st.bText, acc, !!st.ignoreWs);
          const entry = pgpyEntryForDiff(comp);
          let gate = { status: 'skipped', blocked: false, reason: '未检查', errors: [], warnings: [], checked: 0 };
          try { gate = await pgpyGateFor(st.vPath, comp.text); } catch (_) {}
          const summary = DeliverySummary.build({ files: [entry], gate: gate });
          pgpyShowDeliverPanel(summary);

          const real = pgpyHunkRealOf(st.vPath);
          const partial = comp.acceptedCount < comp.total;
          if (gate.blocked) {
            const opts = ['取消（先去改）', '仍然写回（我负责）'];
            const ans = await pgpyAskChoice(
              '存在阻断性错误',
              (gate.errors || []).slice(0, 6).join('\n') + '\n\n写回后大概率跑不起来。建议回到编辑器改掉，或在 diff 里拒掉相关块。',
              opts,
              '这些是语法/引用级错误，机器判定明确。'
            );
            if (ans !== opts[1]) return;
          }
          const bytes = new TextEncoder().encode(comp.text);
          const applyBtn = document.getElementById('diffApplyHunks');
          if (applyBtn) applyBtn.disabled = true;
          let res = null;
          try {
            res = await pgpySyncPaths([st.vPath], {
              overrideBytes: (function () { const m = {}; m[real] = bytes; return m; })(),
              partialReals: partial ? [real] : null
            });
          } finally {
            if (applyBtn) applyBtn.disabled = false;
          }
          if (!res || !res.ok) return;

          if (partial) {
            // 磁盘上现在是「合成结果」；把它变成新的「修改前」基线。
            // vfs 里仍是 AI 的完整提案 → 剩余差异天然就是「被拒的那些块」。
            try {
              await pgpyForceBaseline(st.vPath, res.written && res.written[real] ? res.written[real] : bytes);
              pgpyPendingSync[real] = { kind: 'write', vPath: pgpyNormalizeVPath(st.vPath) };
              pgpySavePendingSync();
              pgpyUpdateSyncButton();
              pgpyHunkMasks[real] = { sig: HunkSelect.signature(comp.text, st.bText, !!st.ignoreWs), accepted: [] };
              pgpySaveHunkMasks();
            } catch (_) {}
            try {
              if (typeof snackbarStore !== 'undefined') snackbarStore.showSuccessMessage('已写回 ' + comp.acceptedCount + '/' + comp.total + ' 块，剩余 ' + (comp.total - comp.acceptedCount) + ' 块仍在待同步');
            } catch (_) {}
            await pgpyOpenDiff(st.vPath);
          } else {
            try { delete pgpyHunkMasks[real]; pgpySaveHunkMasks(); } catch (_) {}
            pgpyHideDeliverPanel();
            try { if (typeof snackbarStore !== 'undefined') snackbarStore.showSuccessMessage('已写回全部 ' + comp.total + ' 块'); } catch (_) {}
          }
        }

        // 批量预检（工具栏「同步」用）：给出摘要 + 门禁，阻断/高风险时让用户确认
        async function pgpyPreflightSelection(paths) {
          if (typeof DeliverySummary === 'undefined') return null;
          const kindMap = pgpyPendingKindMap();
          const files = [], gates = [];
          let gated = 0;
          for (const raw of (paths || [])) {
            const key = pgpyNormalizeVPath(raw);
            const kind = kindMap[key];
            if (!kind) continue;
            let before = { known: false, bytes: null };
            try { before = await pgpyGetBaseline(key); } catch (_) {}
            let afterBytes = null;
            try { afterBytes = nodeRuntime.FS.readFile(key, { encoding: 'binary' }); } catch (_) {}
            const a = pgpyBytesToText(before.bytes);
            const b = pgpyBytesToText(kind === 'delete' ? null : afterBytes);
            if (a.binary || b.binary) {
              files.push(DeliverySummary.analyzeFile({ path: pgpyDisplayPath(key), kind: kind, binary: true }));
              continue;
            }
            const comp = HunkSelect.compose(a.text, b.text, null, false);
            files.push(DeliverySummary.analyzeFile({
              path: pgpyDisplayPath(key), aText: before.known ? a.text : null, bText: b.text, kind: kind,
              add: comp.stats.add, del: comp.stats.del, total: comp.total, accepted: comp.total,
              baselineUnknown: !before.known
            }));
            if (kind !== 'delete' && gated < 12) {
              gated++;
              try { gates.push(await pgpyGateFor(key, b.text)); } catch (_) {}
            }
          }
          const gate = gates.length ? pgpyMergeGates(gates) : { status: 'skipped', blocked: false, reason: '无可检查文件', errors: [], warnings: [], checked: 0 };
          return DeliverySummary.build({ files: files, gate: gate });
        }
