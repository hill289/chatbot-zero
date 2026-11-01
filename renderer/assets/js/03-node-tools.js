        // ══════════════════════════════════════════════════════════
        // 本地 almostnode（Node.js）MCP 工具（与 index.html v1.0.5 一致，全部本地执行）
        // ══════════════════════════════════════════════════════════
        function countLines(s) {
            if (s == null || s === '') {
                return 0;
            }
            const matches = s.match(/\r?\n/g);
            return (matches ? matches.length : 0) + 1;
        }

        // ══════════════════════════════════════════════════════════
        //  run_node 输出净化与多模态图片回传
        //   背景：模型生成的代码常 console.log / module.exports 图片等二进制，
        //   二进制被 utf8 解码后变成乱码文本进入上下文——既污染对话又浪费 token，
        //   且模型根本无法从中读出任何有效信息。三层处理：
        //     1) 图片字节（Buffer / data URL / 长 base64）→ 识别后以多模态
        //        image 内容项回传，模型能真正「看到」图片
        //     2) 乱码 / 二进制文本 → 替换为占位说明，不进入上下文
        //     3) 超长输出截断（对齐 read_file 的单次读取上限思路）
        // ══════════════════════════════════════════════════════════
        const RUN_NODE_OUTPUT_CONFIG = {
            MAX_TEXT_CHARS: 8000,                // 返回给模型的文本上限（字符）
            MAX_IMAGES: 4,                       // 单次运行最多回传的图片数
            MAX_IMAGE_BYTES: 5 * 1024 * 1024,    // 单张图片字节上限（超出不转图片）
            BASE64_MIN_CHARS: 256,               // 连续 base64 ≥ 该长度才做解码/省略处理
            GARBLED_THRESHOLD: 0.1               // 乱码字符（U+FFFD/控制符）占比阈值
        };

        // ══════════════════════════════════════════════════════════
        //  多模态开关：控制 run_node / read_file 是否把图片作为 image 内容项回传。
        //   · 默认启用（true）——保持原有「图片以多模态 image 回传、模型可直接看图」行为。
        //   · 纯文本模型请置 false：chatbotStore.multimodalEnabled = false，或在
        //     「⚙️ 配置 → Advanced」取消勾选「启用多模态图片回传」。
        //     关闭后工具只回文本描述，不再附加 image 内容项（避免文本模型因
        //     image_url 内容项报 400 / 无法解析）。
        //   · 只影响「工具输出里的图片」；用户手动上传的图片附件不受此开关影响。
        // ══════════════════════════════════════════════════════════
        function pgpyMultimodalEnabled() {
            try {
                if (typeof chatbotStore !== 'undefined' && chatbotStore &&
                    typeof chatbotStore.multimodalEnabled === 'boolean') {
                    return chatbotStore.multimodalEnabled;
                }
            } catch (_) {}
            return true;
        }

        // 判断字符串是否为「二进制被当文本解码」的乱码：
        //   采样统计 UTF-8 替换符（U+FFFD）与不可打印控制字符占比
        function pgpyIsGarbledText(s) {
            if (typeof s !== 'string' || s === '') return false;
            const sample = s.length > 4000 ? s.slice(0, 4000) : s;
            let bad = 0;
            for (let i = 0; i < sample.length; i++) {
                const c = sample.charCodeAt(i);
                if (c === 0xFFFD) { bad++; continue; }                     // UTF-8 解码失败的替换符
                if (c === 0x7F) { bad++; continue; }                       // DEL
                if (c < 0x20 && (c < 0x09 || c > 0x0D)) { bad++; continue; } // 其余控制字符（\t\n\v\f\r 除外）
            }
            return (bad / sample.length) > RUN_NODE_OUTPUT_CONFIG.GARBLED_THRESHOLD;
        }

        // base64 → Uint8Array（失败返回 null）
        function pgpyBase64ToBytes(b64) {
            try {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            } catch (e) { return null; }
        }

        // 把二进制视图（Buffer/TypedArray/ArrayBuffer）规范成 Uint8Array；非二进制返回 null
        function pgpyToUint8(v) {
            try {
                if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
                if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v);
            } catch (e) {}
            return null;
        }

        // console 参数/日志里的二进制 → 描述文本；若是图片则同时收集为 image 内容项
        function pgpyDescribeBinaryArg(a, images) {
            const bytes = pgpyToUint8(a);
            if (!bytes || bytes.byteLength === 0) return null;
            const mime = pgpyDetectImageMime(bytes, '');
            const reject = mime ? pgpyImageRejectReason(bytes, mime) : '不是可识别的图片格式';
            if (mime && !reject && images && images.length < RUN_NODE_OUTPUT_CONFIG.MAX_IMAGES &&
                bytes.byteLength <= RUN_NODE_OUTPUT_CONFIG.MAX_IMAGE_BYTES) {
                // 多模态关闭：只回文本描述，不收集 image 内容项（文本模型无法看图）
                if (!pgpyMultimodalEnabled()) {
                    return `<${mime} ${bytes.byteLength} bytes (image omitted: 已切换为文本模型，未附加图片)>`;
                }
                images.push({ type: 'image', mimeType: mime, data: pgpyBytesToBase64(bytes) });
                return `<${mime} ${bytes.byteLength} bytes (image attached)>`;
            }
            if (mime) {
                return `<invalid image ${bytes.byteLength} bytes, ${mime}: ${reject}` +
                    ` — 未上传（否则接口会 400）。请重新生成合法 PNG/JPEG（例如用 read_file 直接读图片文件）>`;
            }
            return `<binary ${bytes.byteLength} bytes>`;
        }

        // 从工具输出文本中提取图片（data URL / 长 base64 串）：
        //   能识别为图片的 → 转成 image 内容项；其余超长 base64 → 占位省略。
        //   模型不需要把 base64 打印出来（它无法在后续代码里可靠复用），
        //   需要嵌入图片时应在同一段代码内直接把 base64 交给 pptxgenjs 等库。
        function pgpyExtractImagesFromText(rawText, images) {
            const cfg = RUN_NODE_OUTPUT_CONFIG;
            let text = String(rawText == null ? '' : rawText);

            const tryAttach = (b64) => {
                if (!b64 || b64.length < 64) return false;
                if (b64.length > Math.floor(cfg.MAX_IMAGE_BYTES * 4 / 3) + 8) return false;
                const bytes = pgpyBase64ToBytes(b64);
                if (!bytes) return false;
                const mime = pgpyDetectImageMime(bytes, '');
                if (!mime || bytes.byteLength > cfg.MAX_IMAGE_BYTES) return false;
                // 结构校验失败 → 标记 'invalid'，调用方替换为可读提示（绝不把坏图塞给接口）
                if (pgpyImageRejectReason(bytes, mime)) return 'invalid';
                // 多模态关闭 → 标记 'disabled'：不收集 image 内容项，调用方替换为文本说明
                if (!pgpyMultimodalEnabled()) return 'disabled';
                if (images.length >= cfg.MAX_IMAGES) return false;
                images.push({ type: 'image', mimeType: mime, data: b64 });
                return true;
            };

            // ① data:image/...;base64,...
            text = text.replace(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi, (m, mime, b64) => {
                const compact = b64.replace(/\s+/g, '');
                const r = tryAttach(compact);
                if (r === true) return `[image extracted: ${mime} → attached as image]`;
                if (r === 'disabled') return `[image omitted: 已切换为文本模型（${mime}），未附加图片]`;
                if (r === 'invalid') return `[image data omitted: 图片结构损坏（${mime}），已拒绝上传以免接口 400；请重新生成合法图片]`;
                if (compact.length >= cfg.BASE64_MIN_CHARS) return `[image data omitted: ${m.length} chars]`;
                return m;
            });

            // ② 裸长 base64（console.log(buffer.toString('base64')) 等）
            text = text.replace(/[A-Za-z0-9+/]{256,}={0,2}/g, (m) => {
                const r = tryAttach(m);
                if (r === true) return `[base64 image → attached as image]`;
                if (r === 'disabled') return `[base64 image omitted: 已切换为文本模型，未附加图片]`;
                if (r === 'invalid') return `[base64 image omitted: 图片结构损坏，已拒绝上传以免接口 400]`;
                return `[base64 data omitted: ${m.length} chars — 需要该数据请在代码内直接使用，不要打印到 console]`;
            });

            return text;
        }

        // 文本净化总入口：提取图片 → 乱码占位 → 截断
        function pgpySanitizeNodeOutput(rawText, images) {
            const cfg = RUN_NODE_OUTPUT_CONFIG;
            let text = String(rawText == null ? '' : rawText);
            if (!text) return '';
            text = pgpyExtractImagesFromText(text, images);
            if (pgpyIsGarbledText(text)) {
                return `[binary/garbled output omitted: ${text.length} chars — 输出为二进制乱码，已剔除。\n` +
                    `如需查看图片内容，请直接返回图片 Buffer（module.exports 或 console.log 图片字节），` +
                    `或用 read_file 读取图片路径（以多模态图片回传）；不要用 utf8 打印二进制文件。]`;
            }
            // 去掉残余的不可打印控制字符（保留 \t\n\v\f\r）
            text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
            if (text.length > cfg.MAX_TEXT_CHARS) {
                text = text.slice(0, cfg.MAX_TEXT_CHARS) +
                    `\n[output truncated: ${text.length} chars total, showing first ${cfg.MAX_TEXT_CHARS}]`;
            }
            return text;
        }

        async function run_node(params) {
            const code = params["code"];
            const { logs, exports, error } = await nodeRuntime.executeAsync(code);
            const images = [];
            let stdout = '', stderr = '';
            for (const l of logs) {
                // hook 层已把 console.log 的图片字节收集为 image 项
                if (Array.isArray(l.images)) {
                    for (const img of l.images) {
                        if (images.length < RUN_NODE_OUTPUT_CONFIG.MAX_IMAGES) images.push(img);
                    }
                }
                if (l.stream === 'stderr') stderr += (stderr ? '\n' : '') + l.text;
                else stdout += (stdout ? '\n' : '') + l.text;
            }
            if (error) stderr += (stderr ? '\n' : '') + ((error && error.message) ? error.message : String(error));

            // module.exports 是图片字节 → 直接以多模态图片回传（而不是巨型 JSON 数字数组）
            let exportsText = '';
            const exportBytes = pgpyToUint8(exports);
            if (exportBytes && exportBytes.byteLength > 0) {
                const described = pgpyDescribeBinaryArg(exportBytes, images);
                exportsText = '\n[module.exports] ' + (described || `<binary ${exportBytes.byteLength} bytes>`);
            } else if (exports !== undefined && exports !== null) {
                const s = safeStringify(exports);
                if (s && s !== '{}') exportsText = '\n[module.exports] ' + s;
            }

            const content = "the node run result:" + stdout + "\n[stderr]\n" + stderr + exportsText;
            const cleanText = pgpySanitizeNodeOutput(content, images);

            const items = [{ type: 'text', text: cleanText }];
            for (const img of images) items.push(img);
            const data = JSON.stringify({ success: true, content: items });
            // 将 Node 写入 /home/pyodide 的文件持久化，刷新后仍可找到
            await pgpySyncMount(false);
            return data;
        }



        // ══════════════════════════════════════════════════════════════
        //  真实执行 / 测试运行器（方案 B：虚拟 FS → 物化到应用目录 workspace/ → 真实进程执行）
        //   · 依赖 Electron 外壳暴露的 window.shellAPI（浏览器纯前端模式不可用）。
        //   · 不改动真实磁盘工程；「🔁 同步」仍是唯一的发布闸门。
        // ══════════════════════════════════════════════════════════════
        const DEFAULT_RUN_TIMEOUT_MS = 120000;

        function pgpyRunAbsPath(p) {
          if (!p) return '/home/pyodide';
          p = String(p).replace(/\\/g, '/');
          if (p[0] !== '/') p = '/home/pyodide/' + p.replace(/^\.\//, '');
          return p;
        }
        // 当前会话工作目录（由 working_directory 工具设置；默认 /home/pyodide）。
        // run_shell / run_tests 未显式传 dir 时以它为默认执行目录。
        function pgpyCurrentWorkdir() {
          try {
            var wd = (typeof window !== 'undefined') ? window.__workingDirectory : null;
            return (typeof wd === 'string' && wd.trim()) ? wd.trim() : '/home/pyodide';
          } catch (_) { return '/home/pyodide'; }
        }
        // 运行工作区 id：依据「磁盘真实路径根」推导（同一工程复用同一 node_modules），否则 default
        function pgpyRunWorkspaceId() {
          try {
            const roots = Object.keys(pgpyRealPathMap || {})
              .filter(k => k.split('/').filter(Boolean).length <= 2)
              .map(k => pgpyRealPathMap[k]).sort();
            if (roots.length) {
              let h = 0; const s = roots.join('|');
              for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
              return 'proj_' + (h >>> 0).toString(16);
            }
          } catch (_) {}
          return 'default';
        }
        function pgpyHasShellAPI() { return !!(window.shellAPI && typeof window.shellAPI.materialize === 'function'); }
        // 沙箱配置（来自 chatbotStore.sandbox）：透传给主进程 run:exec / run:start
        function pgpySandboxCfg() {
          try { return (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.sandbox) || undefined; } catch (_) { return undefined; }
        }

        // 把虚拟工作区（默认 /home/pyodide 全量，或指定子目录）物化到真实运行目录
        async function pgpyMaterializeWorkspace(dir) {
          if (!pgpyHasShellAPI()) {
            return { ok: false, error: 'shellAPI 不可用：需在 Electron 外壳中运行（纯浏览器模式没有真实执行能力）' };
          }
          const startDir = pgpyRunAbsPath(dir || pgpyCurrentWorkdir());
          const set = new Set();
          try { pgpyCollectDirFiles(startDir, set); } catch (_) {}
          const files = [];
          for (const p of set) {
            const rel = pgpyZipRelPath(p);
            if (!rel) continue;
            let bytes = null;
            try { bytes = nodeRuntime.vfs.readFileSync(p); } catch (_) { continue; }
            if (!bytes) continue;
            files.push({ path: rel, dataBase64: pgpyBytesToBase64(bytes) });
          }
          return await window.shellAPI.materialize({ workspaceId: pgpyRunWorkspaceId(), files: files });
        }

        // 「回收」：把真实执行后运行目录里的新增/修改/删除文件同步回 almostnode 虚拟 FS。
        //   · 主进程 run:collect 以物化清单为基线，只返回真正变化的文件（node_modules/.git 除外）；
        //   · 写回走 vfs 唯一写入口：若该路径映射到拖入的真实文件，会自动进入「待同步」队列；
        //   · 没有 shellAPI.collect（旧外壳 / 纯浏览器）时静默跳过，不影响命令本身。
        // 「生成型」运行的默认开关：chatbotStore.collectNewFiles=true 时，允许新增文件回灌虚拟空间
        function pgpyCollectNewDefault() {
          try { return !!(typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.collectNewFiles === true); } catch (_) { return false; }
        }
        async function pgpyCollectWorkspaceToVfs(mat, opts) {
          try {
            if (!mat || !mat.ok || !pgpyHasShellAPI() || typeof window.shellAPI.collect !== 'function') {
              return { ok: false, error: 'collect 不可用（需要新版 Electron 外壳）' };
            }
            // 允许通过配置 chatbotStore.runIgnore 追加/覆盖忽略规则（默认走内置规则）
            let runIgnore;
            try { if (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.runIgnore) runIgnore = chatbotStore.runIgnore; } catch (_) {}
            opts = opts || {};
            const res = await window.shellAPI.collect({
              workspaceId: mat.workspaceId,
              ignores: runIgnore,
              allowNew: !!opts.allowNew,
              includeGlobs: Array.isArray(opts.includeGlobs) ? opts.includeGlobs : undefined,
            });
            if (!res || !res.ok) return { ok: false, error: (res && res.error) || '未知错误' };
            if (!(typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime && nodeRuntime.vfs)) {
              return { ok: false, error: 'almostnode 运行时就绪后才能回收' };
            }
            let written = 0, removed = 0;
            const files = Array.isArray(res.files) ? res.files : [];
            for (const f of files) {
              const rel = String((f && f.path) || '');
              if (!rel) continue;
              const abs = pgpyRunAbsPath(rel);
              let bytes;
              try {
                const bin = atob(f.dataBase64 || '');
                bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              } catch (_) { continue; }
              try { nodeRuntime.FS.mkdirTree(abs.substring(0, abs.lastIndexOf('/')) || '/'); } catch (_) {}
              try { nodeRuntime.vfs.writeFileSync(abs, bytes); written++; } catch (_) {}
            }
            const gone = Array.isArray(res.removed) ? res.removed : [];
            for (const rel of gone) {
              const abs = pgpyRunAbsPath(rel);
              try { nodeRuntime.vfs.unlinkSync(abs); removed++; } catch (_) {}
            }
            if (written || removed) {
              // 持久化到 IndexedDB，并刷新文件表格 / 同步按钮计数
              try { await pgpySyncMount(false); } catch (_) {}
              try { if (typeof listNodeFiles === 'function') listNodeFiles(); } catch (_) {}
              try { if (typeof pgpyUpdateSyncButton === 'function') pgpyUpdateSyncButton(); } catch (_) {}
            }
            return { ok: true, written: written, removed: removed, skipped: res.skipped || 0, changed: res.changed || 0, deniedNew: res.deniedNew || 0, allowNew: !!res.allowNew };
          } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
          }
        }

        function pgpyCollectSummary(c) {
          if (!c || !c.ok) return '';
          return '回收：写回虚拟工作区 ' + c.written + ' 个文件' +
            (c.removed ? ' / 删除 ' + c.removed + ' 个' : '') +
            (c.skipped ? ' / 跳过 ' + c.skipped + ' 个（超限）' : '') +
            (c.deniedNew ? ' / 拦截新增 ' + c.deniedNew + ' 个（默认不回灌陌生新增，如需生成请 collect_new=true）' : '');
        }

        // 把执行结果格式化为工具返回文本
        function pgpyFormatRunResult(mat, command, r) {
          const lines = [];
          lines.push('工作区：' + mat.dir);
          lines.push('命令：' + command);
          lines.push('退出码：' + r.code + '（' + (r.durationMs || 0) + 'ms' + (r.timedOut ? '，已超时终止' : '') + '）');
          if (mat.written !== undefined) lines.push('物化：写入 ' + mat.written + ' / 跳过 ' + mat.skipped + ' / 删除 ' + mat.removed);
          if (r && r.sandbox) lines.push('沙箱：' + (r.sandbox.level || 'policy') + (r.sandbox.tokenRestricted ? '（受限令牌）' : '') + (r.sandbox.fallback ? '（降级：' + r.sandbox.fallback + '）' : ''));
          if (r.stdout) lines.push('\n[stdout]\n' + r.stdout);
          if (r.stderr) lines.push('\n[stderr]\n' + r.stderr);
          if (r.capped) lines.push('\n（输出超过上限已截断）');
          // 主进程解码时仍遇到「既非 UTF-8 也非当前代码页」的字节 → 提示可显式指定 encoding
          if (r.encodingHint) lines.push('\n[编码提示] ' + r.encodingHint);
          return lines.join('\n');
        }

        // run_shell —— 在物化后的真实目录执行任意命令
        async function run_shell(params) {
          params = params || {};
          const command = params.command ? String(params.command).trim() : '';
          if (!command) return pgpyToolErr('run_shell 需要 `command`（完整命令行，例如 "npm test" / "node index.js"）。');
          const mat = await pgpyMaterializeWorkspace(params.dir);
          if (!mat || !mat.ok) return pgpyToolErr('物化失败：' + ((mat && mat.error) || '未知错误'));
          // 后台任务：启动后立即返回 job_id，输出缓冲在主进程，用 job_* 工具读取/终止
          if (params.run_in_background) {
            if (!window.shellAPI || typeof window.shellAPI.start !== 'function') {
              return pgpyToolErr('后台任务需要新版 Electron 外壳（shellAPI.start 不可用）。');
            }
            try {
              const r0 = await window.shellAPI.start({
                workspaceId: mat.workspaceId, command: command, cwd: params.cwd || '',
                encoding: params.encoding || undefined, chcp: params.chcp,
                sandbox: pgpySandboxCfg(),
              });
              if (!r0 || !r0.ok) return pgpyToolErr('启动后台任务失败：' + ((r0 && r0.error) || '未知错误'));
              return pgpyToolOk('后台任务已启动：job_id=' + r0.jobId + '\n命令：' + command +
                '\n用 job_output 查看输出、job_list 列出、job_kill 终止。');
            } catch (e) { return pgpyToolErr('启动后台任务失败：' + ((e && e.message) || e)); }
          }
          let r;
          try {
            r = await window.shellAPI.exec({
              workspaceId: mat.workspaceId, command: command,
              cwd: params.cwd || '', timeoutMs: params.timeout_ms || DEFAULT_RUN_TIMEOUT_MS,
              // 透传编码选项：默认走主进程的智能解码（UTF-8 → win32 GB18030），
              // 只有命令明确使用其它代码页时才需要显式指定（gbk / big5 / utf16le …）。
              encoding: params.encoding || undefined,
              chcp: params.chcp,
              sandbox: pgpySandboxCfg(),
            });
          } catch (e) { return pgpyToolErr('执行失败：' + ((e && e.message) || e)); }
          // 执行后回收：只回收「必要编辑」（已有文件改动）；新增文件默认不回灌，防止垃圾进虚拟空间
          const collected = await pgpyCollectWorkspaceToVfs(mat, { allowNew: params.collect_new === true || pgpyCollectNewDefault() });
          let text = pgpyFormatRunResult(mat, command, r);
          const collectLine = pgpyCollectSummary(collected);
          if (collectLine) text += '\n' + collectLine;
          // 可选：失败时复用 run_tests 的失败诊断，便于「命令 → 定位 → 修复」闭环
          if (params.diagnose && r.code !== 0) {
            const diag = pgpyDiagFormat('shell', r);
            if (diag) text += '\n\n' + diag;
          }
          return r.ok ? pgpyToolOk(text) : pgpyToolErr(text);
        }

        // ══════════════════════════════════════════════════════════════
        //  失败诊断（failure diagnosis）
        //  把 测试 / 类型检查 / Lint 的原始输出解析成「可直接定位并修复」的
        //  结构化问题清单（file:line:col + 规则/错误码 + 消息），
        //  支撑 agent 的「改 → 跑 → 修」闭环。
        // ══════════════════════════════════════════════════════════════
        const PGPY_DIAG_CONFIG = { MAX_ITEMS: 40, MAX_MESSAGE: 240, MAX_FAILED_TESTS: 20 };

        function pgpyDiagShortPath(p) {
          let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
          s = s.replace(/^\.\//, '');
          return s;
        }

        // 解析一行诊断的「严重级别 / 规则码 / 消息」
        function pgpyDiagParseSeverity(rest) {
          let s = String(rest == null ? '' : rest).trim();
          let sev = 'error', code = '', msg = s, m;
          if ((m = /^(error|warning|warn|note|info)\b\s*[:：]?\s*([\s\S]*)$/i.exec(s))) {
            sev = m[1].toLowerCase();
            if (sev === 'warn') sev = 'warning';
            msg = (m[2] || '').trim();
          }
          // 规则码：eslint/react/vue 等 "plugin/rule"
          if (!code && (m = /(?:^|\s)([a-z][a-z0-9-]+\/[a-z0-9-]+)(?:\s|$)/.exec(msg))) code = m[1];
          // 规则码：[name-defined] / [E501] 等（同时从消息尾部去掉该标记，避免重复）
          if (!code && (m = /\[([A-Za-z][A-Za-z0-9_-]*)\]\s*$/.exec(msg))) { code = m[1]; msg = msg.slice(0, m.index).trim(); }
          // 规则码：ruff / golangci 的 "F401"、"G101" 前缀
          if (!code && (m = /^([A-Z][A-Za-z]?\d{2,4})\b\s*([\s\S]*)$/.exec(msg))) { code = m[1]; msg = (m[2] || msg).trim(); }
          return { sev: sev, code: code, msg: msg || s };
        }

        // 从任意工具输出中抽取结构化诊断
        function pgpyDiagExtract(text) {
          const lines = String(text == null ? '' : text).split(/\r?\n/);
          const items = [];
          const failedTests = [];
          const files = new Set();
          let errors = 0, warnings = 0, currentFile = '', lastItem = null;
          const maxItems = PGPY_DIAG_CONFIG.MAX_ITEMS;

          const addItem = (o) => {
            if (!o || !o.msg) return;
            const sev = (o.sev || 'error').toLowerCase();
            const it = {
              file: pgpyDiagShortPath(o.file || currentFile || ''),
              line: (o.line != null && o.line !== '') ? Number(o.line) : null,
              col: (o.col != null && o.col !== '') ? Number(o.col) : null,
              sev: sev === 'warn' ? 'warning' : sev,
              code: o.code || '',
              msg: String(o.msg).replace(/\s+/g, ' ').trim().slice(0, PGPY_DIAG_CONFIG.MAX_MESSAGE),
            };
            if (it.sev === 'warning') warnings++; else errors++;
            if (it.file) files.add(it.file);
            if (items.length < maxItems) items.push(it);
            lastItem = it;
          };

          const RE_TSC = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+TS(\d+):\s*([\s\S]*)$/i;
          const RE_FILE_LINE_COL = /^\s*([A-Za-z0-9_./\\@~+-]+\.[A-Za-z0-9]+):(\d+):(\d+):\s*([\s\S]*)$/;
          const RE_ESLINT_STYLISH = /^\s*(\d+):(\d+)\s+(error|warning)\s+([\s\S]*?)\s{2,}([^\s]+)?\s*$/;
          const RE_FILE_LINE = /^\s*([A-Za-z0-9_./\\@~+-]+\.[A-Za-z0-9]+):(\d+):\s*([\s\S]*)$/;
          const RE_FILELIKE = /^\s*([A-Za-z0-9_./\\@~+-]+\.[A-Za-z0-9]+)\s*$/;
          const RE_CARGO_MSG = /^(error|warning)(\[[A-Za-z]\d+\])?:\s*([\s\S]*)$/;
          const RE_CARGO_LOC = /^\s*-->\s*(\S+?):(\d+):(\d+)\s*$/;
          const RE_PYTEST_FAILED = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+([\s\S]*))?$/;
          const RE_GO_FAIL = /^--- FAIL:\s*(\S+)/;
          const RE_JEST_FAIL = /^\s*[\u2715\u00d7]\s*([\s\S]*)$/;
          const RE_JEST_SUITE = /^\s*\u25cf\s*([\s\S]*)$/;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\t/g, '    ');
            let m;

            if ((m = RE_TSC.exec(line))) {
              addItem({ file: m[1], line: m[2], col: m[3], sev: m[4], code: 'TS' + m[5], msg: m[6] });
              continue;
            }
            if ((m = RE_FILE_LINE_COL.exec(line))) {
              const parsed = pgpyDiagParseSeverity(m[4]);
              addItem({ file: m[1], line: m[2], col: m[3], sev: parsed.sev, code: parsed.code, msg: parsed.msg });
              continue;
            }
            if ((m = RE_ESLINT_STYLISH.exec(line))) {
              addItem({ file: currentFile, line: m[1], col: m[2], sev: m[3], code: m[5] || '', msg: m[4] });
              continue;
            }
            if ((m = RE_FILE_LINE.exec(line)) && !/^\d+\s+fail/i.test(m[3])) {
              const parsed = pgpyDiagParseSeverity(m[3]);
              addItem({ file: m[1], line: m[2], sev: parsed.sev, code: parsed.code, msg: parsed.msg });
              continue;
            }
            if ((m = RE_CARGO_MSG.exec(line))) {
              // 跳过「汇总性」行（非可定位问题）
              if (/aborting due to|could not compile|build failed|due to \d+ previous error/i.test(m[3])) continue;
              addItem({ file: '', sev: m[1], code: (m[2] || '').replace(/[\[\]]/g, ''), msg: m[3] });
              continue;
            }
            if ((m = RE_CARGO_LOC.exec(line))) {
              if (lastItem) {
                lastItem.file = pgpyDiagShortPath(m[1]);
                lastItem.line = Number(m[2]);
                lastItem.col = Number(m[3]);
                if (lastItem.file) files.add(lastItem.file);
              }
              continue;
            }
            if ((m = RE_PYTEST_FAILED.exec(line))) {
              failedTests.push(pgpyDiagShortPath(m[2]) + (m[3] ? ' — ' + m[3].replace(/\s+/g, ' ').trim() : ''));
              continue;
            }
            if ((m = RE_GO_FAIL.exec(line))) { failedTests.push(m[1]); continue; }
            if ((m = RE_JEST_FAIL.exec(line))) { const t = m[1].trim(); if (t) failedTests.push(t); continue; }
            if ((m = RE_JEST_SUITE.exec(line))) {
              const t = m[1].trim();
              if (t && !/^(console\.|at\s|Cannot find)/.test(t)) failedTests.push(t);
              continue;
            }
            if ((m = RE_FILELIKE.exec(line))) { currentFile = pgpyDiagShortPath(m[1]); continue; }
          }

          return { items: items, failedTests: failedTests, files: Array.from(files), counts: { total: errors + warnings, error: errors, warning: warnings } };
        }

        function pgpyDiagFormatItem(it) {
          let loc = it.file || '(未知文件)';
          if (it.line != null) loc += ':' + it.line;
          if (it.col != null) loc += ':' + it.col;
          const tag = (it.code ? '[' + it.code + '] ' : '') + (it.sev && it.sev !== 'error' ? it.sev + ': ' : '');
          return loc + '  ' + tag + it.msg;
        }

        // 生成「失败诊断」文本块（仅在失败时调用）
        function pgpyDiagFormat(kind, r) {
          const combined = [r && r.stderr, r && r.stdout].filter(function (s) { return !!s; }).join('\n');
          if (!combined) return '';
          let d;
          try { d = pgpyDiagExtract(combined); } catch (_) { return ''; }
          const labelMap = { test: '测试', typecheck: '类型检查', lint: 'Lint', shell: '命令' };
          const label = labelMap[kind] || kind || '检查';
          const out = [];
          out.push('🧭 失败诊断 · ' + label + '（自动解析，可直接定位）');
          if (d.items.length) {
            out.push('- 共解析出 ' + d.counts.total + ' 条问题：错误 ' + d.counts.error + ' / 警告 ' + d.counts.warning +
              '，涉及 ' + d.files.length + ' 个文件');
            for (let i = 0; i < d.items.length; i++) out.push('  ' + (i + 1) + '. ' + pgpyDiagFormatItem(d.items[i]));
            if (d.counts.total > d.items.length) out.push('  …（其余 ' + (d.counts.total - d.items.length) + ' 条已省略）');
          }
          if (d.failedTests.length) {
            out.push('- 失败用例（' + d.failedTests.length + '）：');
            const shown = d.failedTests.slice(0, PGPY_DIAG_CONFIG.MAX_FAILED_TESTS);
            for (let i = 0; i < shown.length; i++) out.push('  • ' + shown[i]);
            if (d.failedTests.length > shown.length) out.push('  …（其余 ' + (d.failedTests.length - shown.length) + ' 个已省略）');
          }
          if (!d.items.length && !d.failedTests.length) {
            out.push('- 未能从输出中解析出结构化问题；请阅读上方原始 stdout/stderr 定位（常见原因：编译/依赖安装失败、非标准输出格式）。');
          }
          out.push('- 下一步：按上面的 `文件:行:列` 打开并修复 → 重跑同一命令（run_tests）验证 → 直到退出码为 0。');
          return out.join('\n');
        }

        function pgpySummarizeTasks(results) {
          const parts = results.map(function (x) { return x.type + (x.ok ? ' ✅' : ' ❌'); });
          const anyFail = results.some(function (x) { return !x.ok; });
          return (anyFail ? '❌ 未全部通过：' : '✅ 全部通过：') + parts.join(' · ');
        }

        function pgpyFormatTaskSection(t, r, err) {
          const labelMap = { test: '测试', typecheck: '类型检查', lint: 'Lint' };
          const label = labelMap[t.type] || t.type;
          const lines = [];
          lines.push('── [' + t.type + '] ' + t.cmd + ' ──');
          if (err) { lines.push('⚠️ 执行失败：' + ((err && err.message) || err)); return lines.join('\n'); }
          lines.push((r.code === 0 ? '✅' : '❌') + ' ' + label + '：退出码 ' + r.code +
            '（' + (r.durationMs || 0) + 'ms' + (r.timedOut ? '，已超时终止' : '') + '）');
          if (r.stdout) lines.push('\n[stdout]\n' + r.stdout);
          if (r.stderr) lines.push('\n[stderr]\n' + r.stderr);
          if (r.capped) lines.push('\n（输出超过上限已截断）');
          if (r.code !== 0) {
            const diag = pgpyDiagFormat(t.type, r);
            if (diag) lines.push('\n' + diag);
          }
          return lines.join('\n');
        }

        // run_tests —— 自动探测并运行 测试 / 类型检查 / Lint，并对失败输出做结构化诊断
        //   · kind: 'test'(默认，保持原行为) | 'typecheck' | 'lint' | 'all'
        //   · with_checks=true 时：在跑测试之外，追加已探测到的 类型检查 / Lint
        //   · command / typecheck_command / lint_command 可显式覆盖探测结果
        async function run_tests(params) {
          params = params || {};
          const kind = String(params.kind || '').trim().toLowerCase();
          const det = pgpyDetectCommands(params.dir);
          const explicit = params.command ? String(params.command).trim() : '';

          const tasks = [];
          const push = (type, cmd) => { if (cmd) tasks.push({ type: type, cmd: cmd }); };

          if (explicit) {
            push(kind === 'typecheck' ? 'typecheck' : (kind === 'lint' ? 'lint' : 'test'), explicit);
          } else if (kind === 'typecheck') {
            push('typecheck', params.typecheck_command || det.typecheck);
          } else if (kind === 'lint') {
            push('lint', params.lint_command || det.lint);
          } else if (kind === 'all') {
            push('test', det.test);
            push('typecheck', params.typecheck_command || det.typecheck);
            push('lint', params.lint_command || det.lint);
          } else {
            push('test', det.test);
            if (params.with_checks) {
              push('typecheck', params.typecheck_command || det.typecheck);
              push('lint', params.lint_command || det.lint);
            }
          }

          if (!tasks.length) {
            const miss = (kind === 'typecheck') ? '类型检查' : (kind === 'lint' ? 'Lint' : '测试');
            return pgpyToolErr('未能探测到' + miss + '命令；请显式传 `command`（如 "npm test" / "npx tsc --noEmit"）或指定 `kind`。');
          }

          const mat = await pgpyMaterializeWorkspace(params.dir);
          if (!mat || !mat.ok) return pgpyToolErr('物化失败：' + ((mat && mat.error) || '未知错误'));

          const timeoutMs = params.timeout_ms || DEFAULT_RUN_TIMEOUT_MS;
          const results = [];
          const sections = [];
          for (const t of tasks) {
            let r = null, err = null;
            try {
              r = await window.shellAPI.exec({
                workspaceId: mat.workspaceId, command: t.cmd,
                cwd: params.cwd || '', timeoutMs: timeoutMs,
                sandbox: pgpySandboxCfg(),
              });
            } catch (e) { err = e; }
            results.push({ type: t.type, cmd: t.cmd, ok: !err && r && r.code === 0 });
            sections.push(pgpyFormatTaskSection(t, r, err));
          }

          const collected = await pgpyCollectWorkspaceToVfs(mat, { allowNew: params.collect_new === true || pgpyCollectNewDefault() });
          const cmdDesc = tasks.map(function (t) { return t.type + '=' + t.cmd; }).join('；');
          const head = [];
          head.push('工作区：' + mat.dir);
          head.push('命令：' + cmdDesc);
          head.push(pgpySummarizeTasks(results));
          if (mat.written !== undefined) head.push('物化：写入 ' + mat.written + ' / 跳过 ' + mat.skipped + ' / 删除 ' + mat.removed);
          const collectLine = pgpyCollectSummary(collected);
          if (collectLine) head.push(collectLine);

          const text = head.join('\n') + '\n\n' + sections.join('\n\n');
          const allOk = results.every(function (x) { return x.ok; });
          return allOk ? pgpyToolOk(text) : pgpyToolErr(text);
        }

        // 探测工程中的 测试 / 类型检查 / Lint 命令（返回 { test, typecheck, lint, *Src }）
        function pgpyDetectCommands(dir) {
          const abs = pgpyRunAbsPath(dir || pgpyCurrentWorkdir()).replace(/\/$/, '');
          const exists = (rel) => { try { nodeRuntime.vfs.statSync(abs + '/' + rel); return true; } catch (_) { return false; } };
          const readText = (rel) => { try { return String(nodeRuntime.vfs.readFileSync(abs + '/' + rel)); } catch (_) { return ''; } };
          const out = { test: '', typecheck: '', lint: '', testSrc: '', typecheckSrc: '', lintSrc: '' };

          // —— 测试 ——（保持原有探测顺序，向后兼容）
          if (exists('package.json')) {
            let pkg = null;
            try { pkg = JSON.parse(readText('package.json')); } catch (_) {}
            const sc = (pkg && pkg.scripts) || {};
            if (sc.test) { out.test = 'npm test'; out.testSrc = 'package.json scripts.test'; }
            const tcName = sc.typecheck ? 'typecheck' : (sc['type-check'] ? 'type-check' : (sc['check-types'] ? 'check-types' : (sc.tsc ? 'tsc' : '')));
            if (tcName) { out.typecheck = 'npm run ' + tcName; out.typecheckSrc = 'package.json scripts.' + tcName; }
            if (sc.lint) { out.lint = 'npm run lint'; out.lintSrc = 'package.json scripts.lint'; }
          }
          if (!out.test && (exists('pyproject.toml') || exists('pytest.ini') || exists('setup.cfg') || exists('requirements.txt'))) {
            out.test = 'python -m pytest -q'; out.testSrc = 'pytest 配置';
          }
          if (!out.test && exists('manage.py')) { out.test = 'python manage.py test'; out.testSrc = 'Django manage.py'; }
          if (!out.test && exists('Cargo.toml')) { out.test = 'cargo test'; out.testSrc = 'Cargo.toml'; }
          if (!out.test && exists('go.mod')) { out.test = 'go test ./...'; out.testSrc = 'go.mod'; }
          if (!out.test && exists('Makefile')) { out.test = 'make test'; out.testSrc = 'Makefile'; }
          if (!out.test && exists('package.json')) { out.test = 'npm test'; out.testSrc = 'package.json'; }
          if (!out.test) { out.test = 'node --test'; out.testSrc = '默认（node:test）'; }

          // —— 类型检查 ——
          if (!out.typecheck && exists('tsconfig.json')) { out.typecheck = 'npx --no-install tsc --noEmit'; out.typecheckSrc = 'tsconfig.json'; }
          if (!out.typecheck) {
            const py = readText('pyproject.toml');
            if (exists('mypy.ini') || /\[tool\.mypy\]/.test(py) || /\[mypy\]/.test(readText('setup.cfg'))) {
              out.typecheck = 'python -m mypy .'; out.typecheckSrc = 'mypy 配置';
            }
          }
          if (!out.typecheck && exists('Cargo.toml')) { out.typecheck = 'cargo check'; out.typecheckSrc = 'Cargo.toml'; }

          // —— Lint ——
          if (!out.lint) {
            const eslintCfg = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
              'eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs'].some(exists);
            if (eslintCfg) { out.lint = 'npx --no-install eslint .'; out.lintSrc = 'ESLint 配置'; }
          }
          if (!out.lint) {
            const py = readText('pyproject.toml');
            if (exists('ruff.toml') || exists('.ruff.toml') || /\[tool\.ruff/.test(py)) {
              out.lint = 'python -m ruff check .'; out.lintSrc = 'Ruff 配置';
            }
          }
          if (!out.lint && exists('Cargo.toml')) { out.lint = 'cargo clippy'; out.lintSrc = 'Cargo.toml'; }
          if (!out.lint && exists('go.mod')) { out.lint = 'go vet ./...'; out.lintSrc = 'go.mod'; }

          return out;
        }

        // 向后兼容：旧的单一「测试命令」探测入口
        function pgpyDetectTestCommand(dir) { return pgpyDetectCommands(dir).test; }

        // 运行控制台（惰性创建，浮层）
        function pgpyEnsureRunConsole() {
          let el = document.getElementById('pgpyRunConsole');
          if (el) return el;
          el = document.createElement('div');
          el.id = 'pgpyRunConsole';
          el.style.cssText = 'position:fixed;right:16px;bottom:16px;width:560px;max-width:46vw;height:300px;' +
            'background:#0b1020;color:#d6deeb;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
            'border:1px solid #1f2a44;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);z-index:99999;' +
            'display:flex;flex-direction:column;overflow:hidden;';
          el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#111a30;border-bottom:1px solid #1f2a44;">' +
            '<b style="color:#7ee787;">⚡ Run Workspace</b>' +
            '<span style="color:#8b98b8;font-size:11px;">物化 → 真实执行 → 回收</span>' +
            '<span style="flex:1"></span>' +
            '<button id="pgpyRunClear" style="background:#1f2a44;color:#d6deeb;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">清空</button>' +
            '<button id="pgpyRunClose" style="background:#1f2a44;color:#d6deeb;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">✕</button>' +
            '</div><pre id="pgpyRunLog" style="margin:0;padding:8px 10px;flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;"></pre>';
          document.body.appendChild(el);
          el.querySelector('#pgpyRunClose').addEventListener('click', () => el.remove());
          el.querySelector('#pgpyRunClear').addEventListener('click', () => { const p = document.getElementById('pgpyRunLog'); if (p) p.textContent = ''; });
          return el;
        }
        function pgpyRunLog(text) {
          const el = pgpyEnsureRunConsole();
          const pre = el.querySelector('#pgpyRunLog');
          if (pre) { pre.textContent += text + '\n'; pre.scrollTop = pre.scrollHeight; }
        }

        // 工具栏「⚡ Run WS」：内联命令执行（流式输出到浮层）
        async function pgpyRunWorkspaceExec(command) {
          command = String(command || '').trim();
          if (!command) return;
          if (!pgpyHasShellAPI()) { pgpyRunLog('❌ shellAPI 不可用：请在 Electron 外壳中运行（浏览器模式无法真实执行）。'); return; }
          pgpyRunLog('\n$ ' + command);
          const mat = await pgpyMaterializeWorkspace();
          if (!mat || !mat.ok) { pgpyRunLog('❌ 物化失败：' + ((mat && mat.error) || '未知错误')); return; }
          pgpyRunLog('📦 运行区：' + mat.dir + '（写入 ' + mat.written + ' / 跳过 ' + mat.skipped + ' / 删除 ' + mat.removed + '）');
          const off = window.shellAPI.onOutput((m) => { if (m && typeof m.data === 'string') pgpyRunLog(m.data.replace(/\n$/, '')); });
          try {
            const r = await window.shellAPI.exec({ workspaceId: mat.workspaceId, command: command });
            pgpyRunLog('— 退出码 ' + r.code + '（' + (r.durationMs || 0) + 'ms' + (r.timedOut ? '，超时终止' : '') + '）');
          } catch (e) {
            pgpyRunLog('❌ ' + ((e && e.message) || e));
          } finally {
            if (typeof off === 'function') off();
          }
          const collected = await pgpyCollectWorkspaceToVfs(mat);
          const collectLine = pgpyCollectSummary(collected);
          if (collectLine) pgpyRunLog('♻️ ' + collectLine);
        }
        function pgpyRunWorkspacePrompt() {
          const cmd = prompt('在工作区运行命令（会物化到应用目录 workspace/ 后真实执行；真实工程文件不受影响）：', 'npm test');
          if (cmd) pgpyRunWorkspaceExec(cmd);
        }

        // ── 多模态：图片魔数识别 + 二进制转 base64（供 read_file 读取图片时返回 image 内容项）──
        function pgpyBytesToBase64(bytes) {
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                const view = bytes.subarray ? bytes.subarray(i, i + chunk) : bytes.slice(i, i + chunk);
                binary += String.fromCharCode.apply(null, view);
            }
            return btoa(binary);
        }

        function pgpyDetectImageMime(bytes, filePath) {
            const b = bytes;
            if (!b || b.length < 4) return '';
            if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
                b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
            if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
            if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
            if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
            const ext = String(filePath || '').toLowerCase().split('.').pop();
            if (ext === 'svg') return 'image/svg+xml';
            if (ext === 'ico') return 'image/x-icon';
            return '';
        }

        // ══════════════════════════════════════════════════════════
        // 图片「可上传性」校验（魔数 ≠ 合法文件）
        //   故障链：裁剪/生成脚本写出的 PNG 签名正确、但 chunk 长度字段全为 0（Buffer polyfill
        //   缺少 writeUInt32BE 时静默留零）→ pgpyDetectImageMime 只嗅魔数把它当 image/png 上传
        //   → 模型接口返回 400 unsupported image；这条坏图已写进 conversation 与本地历史，
        //   之后每轮请求都会重放它 → 整段对话持续报错，只能新开会话。
        //   因此：凡是「要作为 image 内容项发出去」的地方，都必须过 pgpyImageRejectReason。
        // ══════════════════════════════════════════════════════════
        const PGPY_API_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

        // PNG：遍历 chunk 链，校验 length/首块 IHDR(13)/必须有 IDAT/以 IEND 收尾
        function pgpyPngChunksValid(b) {
            if (!b || b.length < 32) return false; // 8 签名 + 25 首块 + 12 IEND 最少
            let off = 8, first = true, hasIdat = false;
            while (off + 8 <= b.length) {
                const len = ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
                const t = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
                if (len > 0x7FFFFFFF || off + 12 + len > b.length) return false;
                if (first) {
                    if (t !== 'IHDR' || len !== 13) return false;
                    first = false;
                }
                if (t === 'IDAT') hasIdat = true;
                if (t === 'IEND') return hasIdat;
                off += 12 + len;
            }
            return false; // 没走到 IEND → 截断或块头损坏
        }

        // JPEG：以 FFD9 收尾，且在 SOS 之前出现过 SOF
        function pgpyJpegValid(b) {
            if (b.length < 4 || b[b.length - 2] !== 0xFF || b[b.length - 1] !== 0xD9) return false;
            let off = 2, hasSof = false;
            while (off + 4 <= b.length) {
                if (b[off] !== 0xFF) { off++; continue; }
                const marker = b[off + 1];
                if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
                if (marker === 0xD9 || marker === 0xDA) break;
                const seg = (b[off + 2] << 8) | b[off + 3];
                if (seg < 2) return false;
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) hasSof = true;
                off += 2 + seg;
            }
            return hasSof;
        }

        function pgpyGifValid(b) {
            return b.length > 13 && b[b.length - 1] === 0x3B;
        }

        function pgpyWebpValid(b) {
            if (b.length < 16) return false;
            const riff = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
            return riff >= 4;
        }

        // 通过返回 ''，否则返回可读的拒绝原因
        function pgpyImageRejectReason(bytes, mime) {
            if (!bytes || !bytes.length) return '空文件（0 字节）';
            if (!mime) return '不是可识别的图片格式';
            if (PGPY_API_IMAGE_MIMES.indexOf(mime) < 0) {
                return `接口只接受 webp/png/jpeg/gif，${mime} 无法上传`;
            }
            if (mime === 'image/png' && !pgpyPngChunksValid(bytes)) return 'PNG 结构损坏（chunk 长度/IHDR/IDAT/IEND 校验失败）';
            if (mime === 'image/jpeg' && !pgpyJpegValid(bytes)) return 'JPEG 截断或缺少 SOF/EOI';
            if (mime === 'image/gif' && !pgpyGifValid(bytes)) return 'GIF 截断（缺少 0x3B 结束符）';
            if (mime === 'image/webp' && !pgpyWebpValid(bytes)) return 'WebP RIFF 长度不合法';
            return '';
        }

        // 便捷判断：能否作为 image 内容项上传
        function pgpyIsUploadableImage(bytes) {
            const mime = pgpyDetectImageMime(bytes, '');
            return !!mime && !pgpyImageRejectReason(bytes, mime);
        }

