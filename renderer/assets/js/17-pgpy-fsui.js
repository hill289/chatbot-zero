        // ══════════════════════════════════════════════════════════════
        //  Delete selected files (表格 checkbox 选中 → 删除)
        // ══════════════════════════════════════════════════════════════
        // ── 核心删除逻辑：给定路径数组，逐个从 vfs 删除（含「待删除」幽灵记录的移除）──
        //    返回 { deleted, failed, removedPending }；调用方负责后续状态提示/选中清理/刷新。
        async function pgpyDeletePathsCore(paths) {
          const pendingKind = pgpyPendingKindMap(); // 虚拟路径 → 'write' | 'delete'
          let deleted = 0, failed = 0, removedPending = 0;

          for (const path of paths) {
            const np = pgpyNormalizeVPath(path);
            // 「待删除」幽灵记录：vfs 中已不存在，仅剩一条待同步删除登记。
            // 再次删除时，直接移除该登记让记录从列表消失即可 —— 不做真正的删除，也不需要同步。
            if (pendingKind[np] === 'delete') {
              let removed = false;
              for (const real of Object.keys(pgpyPendingSync)) {
                const op = pgpyPendingSync[real];
                if (op && op.kind === 'delete' && pgpyNormalizeVPath(op.vPath) === np) {
                  delete pgpyPendingSync[real];
                  removed = true;
                  break;
                }
              }
              if (removed) { try { pgpyBaselineDelete(np); } catch (_) {} removedPending++; continue; }
            }
            try {
              const FS = nodeRuntime.FS;
              const stat = FS.stat(path);
              if (FS.isDir(stat.mode)) {
                (function removeRecursive(p) {
                  const entries = FS.readdir(p);
                  for (const entry of entries) {
                    if (entry === '.' || entry === '..') continue;
                    const full = p === '/' ? '/' + entry : p + '/' + entry;
                    const s = FS.stat(full);
                    if (FS.isDir(s.mode)) { removeRecursive(full); FS.rmdir(full); }
                    else { FS.unlink(full); }
                  }
                })(path);
                FS.rmdir(path);
              } else {
                FS.unlink(path);
              }
              deleted++;
            } catch (err) {
              failed++;
              console.warn('[pgpy] 删除失败:', path, err);
            }
          }

          if (deleted > 0) {
            try { await pgpySyncMount(false); }
            catch (err) { console.warn('[pgpy] 同步失败,删除仅保存在内存:', err); }
          }

          if (removedPending > 0) pgpySavePendingSync();
          return { deleted, failed, removedPending };
        }

        async function pgpyDeleteSelectedFiles() {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          const paths = Array.from(pgpySelectedFiles);
          if (paths.length === 0) return;
          if (!confirm('确定删除选中的 ' + paths.length + ' 个文件吗?\n\n' + paths.join('\n'))) return;

          const pgpyStatus = document.getElementById('pgpyStatus');
          const start = performance.now();
          const { deleted, failed, removedPending } = await pgpyDeletePathsCore(paths);

          if (failed === 0) {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '🗑 Deleted ' + deleted + ' file(s)' + (removedPending > 0 ? ', 移除待删除记录 ' + removedPending : ''); }
          } else {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '⚠️ ' + deleted + ' deleted, ' + failed + ' failed' + (removedPending > 0 ? ', 移除待删除记录 ' + removedPending : ''); }
          }

          pgpySelectedFiles.clear();
          if (pgpyCurrentFilePath && paths.indexOf(pgpyCurrentFilePath) !== -1) {
            pgpyCurrentFilePath = null;
            pgpyCurrentFileFromBinary = false;
            pgpyUpdateSaveButton();
          }
          listNodeFiles();
        }

        // 删除单个文件/目录（Query Results 文件行每行的 🗑 按钮）
        async function pgpyDeleteSingleFile(path) {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          if (!path) return;
          if (!confirm('确定删除该文件吗?\n\n' + path)) return;

          const pgpyStatus = document.getElementById('pgpyStatus');
          const { deleted, failed, removedPending } = await pgpyDeletePathsCore([path]);

          if (failed === 0) {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '🗑 Deleted 1 file' + (removedPending > 0 ? ', 移除待删除记录 ' + removedPending : ''); }
          } else {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '⚠️ 删除失败' + (removedPending > 0 ? ', 移除待删除记录 ' + removedPending : ''); }
          }

          pgpySelectedFiles.delete(path);
          if (pgpyCurrentFilePath && path === pgpyCurrentFilePath) {
            pgpyCurrentFilePath = null;
            pgpyCurrentFileFromBinary = false;
            pgpyUpdateSaveButton();
          }
          listNodeFiles();
        }

        // Query Results 文件行内的 🗑 删除按钮（事件委托，避免行双击载入编辑器）
        document.addEventListener('click', function (e) {
          const btn = e.target && e.target.closest ? e.target.closest('.pgpy-file-del') : null;
          if (!btn) return;
          e.preventDefault();
          e.stopPropagation();
          const p = btn.getAttribute('data-path');
          if (p) pgpyDeleteSingleFile(p);
        });

        // ══════════════════════════════════════════════════════════════
        //  Export ZIP (勾选导出 / 全量导出)
        // ══════════════════════════════════════════════════════════════
        function pgpyBasename(path) {
          return path.substring(path.lastIndexOf('/') + 1) || path;
        }

        function pgpyCollectDirFiles(dir, out) {
          const FS = nodeRuntime.FS;
          let items;
          try { items = FS.readdir(dir); } catch (e) { console.warn('[pgpy] 无法读取目录:', dir, e); return; }
          for (const item of items) {
            if (item === '.' || item === '..') continue;
            if (item === 'default.profraw') continue;
            // 跳过工具运行期内部目录（如 .spill）：不参与物化执行 / 导出
            if (typeof pgpyIsInternalName === 'function' && pgpyIsInternalName(item)) continue;
            const full = dir === '/' ? '/' + item : dir + '/' + item;
            try {
              const st = FS.stat(full);
              if (FS.isDir(st.mode)) { pgpyCollectDirFiles(full, out); }
              else if (FS.isFile(st.mode)) { out.add(full); }
            } catch (e) { console.warn('[pgpy] 遍历失败:', full, e); }
          }
        }

        function pgpyZipRelPath(p) {
          const root = '/home/pyodide';
          if (p === root) return '';
          if (p.startsWith(root + '/')) return p.substring(root.length + 1);
          return p.replace(/^\/+/, '');
        }

        async function pgpyDownloadFilesIndividually(filePaths, pgpyStatus, failedIn) {
          let exported = 0, failed = failedIn;
          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Exporting ' + filePaths.length + ' selected file(s)...'; }

          const nameCount = {};
          for (const p of filePaths) { const n = pgpyBasename(p); nameCount[n] = (nameCount[n] || 0) + 1; }

          for (const p of filePaths) {
            const base = pgpyBasename(p);
            try {
              let downloadName = base;
              if (nameCount[base] > 1) {
                const parent = p.substring(0, p.lastIndexOf('/'));
                const dirName = parent.substring(parent.lastIndexOf('/') + 1);
                downloadName = (dirName ? dirName + '_' : '') + base;
              }
              const blob = new Blob([nodeRuntime.FS.readFile(p, { encoding: 'binary' })]);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = downloadName;
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 5000);
              exported++;
              if (pgpyStatus) { pgpyStatus.textContent = '⏳ Exporting ' + exported + '/' + filePaths.length + ': ' + base + '...'; }
              await new Promise(r => setTimeout(r, 150));
            } catch (err) {
              failed++;
              console.warn('[pgpy] 导出失败:', p, err);
            }
          }
          return { exported, failed };
        }

        async function exportToZIP() {
          const pgpyStatus = document.getElementById('pgpyStatus');
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          if (typeof JSZip === 'undefined') { alert('JSZip library not loaded!'); return; }

          const FS = nodeRuntime.FS;
          const totalStart = performance.now();
          let exportAll = false;
          let hasDir = false;
          let failed = 0;
          const fileSet = new Set();

          if (pgpySelectedFiles.size === 0) {
            exportAll = true;
            pgpyCollectDirFiles('/home/pyodide', fileSet);
          } else {
            for (const p of Array.from(pgpySelectedFiles)) {
              try {
                const st = FS.stat(p);
                if (FS.isDir(st.mode)) { hasDir = true; pgpyCollectDirFiles(p, fileSet); }
                else { fileSet.add(p); }
              } catch (err) { failed++; console.warn('[pgpy] 读取文件失败:', p, err); }
            }
          }

          if (fileSet.size === 0) {
            const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
            const msg = '❌ 没有可导出的文件:工作区为空,或勾选的文件夹都是空文件夹\n⏱ ' + elapsed + 's';
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 没有可导出的文件'; }
            pgpyRenderMessage(msg, true, elapsed);
            return;
          }

          if (!exportAll && !hasDir) {
            const res = await pgpyDownloadFilesIndividually(Array.from(fileSet), pgpyStatus, failed);
            const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
            const summary = '✅ Exported ' + res.exported + ' file(s)' + (res.failed > 0 ? ', ' + res.failed + ' failed' : '');
            if (pgpyStatus) {
              pgpyStatus.className = 'pgpy-status-badge ' + (res.failed === 0 ? 'pgpy-success' : 'pgpy-error');
              pgpyStatus.textContent = summary + ' (' + elapsed + 's)';
            }
            pgpyRenderMessage(summary + '\n⏱ ' + elapsed + 's', res.failed > 0, elapsed);
            return;
          }

          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = (exportAll ? '⏳ Zipping ALL ' : '⏳ Zipping ') + fileSet.size + ' file(s)...'; }

          const zip = new JSZip();
          let added = 0;
          for (const p of Array.from(fileSet)) {
            try {
              const rel = pgpyZipRelPath(p);
              if (!rel) continue;
              zip.file(rel, FS.readFile(p, { encoding: 'binary' }));
              added++;
              if (pgpyStatus && added % 25 === 0) { pgpyStatus.textContent = '⏳ Zipping ' + added + '/' + fileSet.size + '...'; }
            } catch (err) { failed++; console.warn('[pgpy] 导出失败:', p, err); }
          }

          if (added === 0) {
            const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 导出失败(' + failed + ' failed)'; }
            pgpyRenderMessage('❌ 导出失败,共 ' + failed + ' 个文件读取失败\n⏱ ' + elapsed + 's', true, elapsed);
            return;
          }

          const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
          const stamp = new Date();
          const pad = n => String(n).padStart(2, '0');
          const filename = (exportAll ? 'node-all-' : 'node-selected-') +
            stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' +
            pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '.zip';
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);

          const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
          let summary = '📦 ' + (exportAll ? 'Exported ALL ' : 'Exported ') + added + ' file(s)';
          if (failed > 0) summary += ', ' + failed + ' failed';
          if (pgpyStatus) {
            pgpyStatus.className = 'pgpy-status-badge ' + (failed === 0 ? 'pgpy-success' : 'pgpy-error');
            pgpyStatus.textContent = summary + ' (' + elapsed + 's)';
          }
          let msg = summary + '\n⏱ ' + elapsed + 's';
          if (exportAll) msg += '\n📁 未勾选任何文件,已导出工作区全部文件';
          else if (hasDir) msg += '\n📁 已包含勾选文件夹下的所有文件';
          pgpyRenderMessage(msg, failed > 0, elapsed);
        }

        // ── 一键导出「全部工作区文件」为 ZIP（忽略表格勾选） ──
        //    供聊天输入区左侧的 📦 常驻按钮（#sdExportAllBtn）调用。
        //    exportToZIP() 在「无勾选」时即打包整个 /home/pyodide 工作区，
        //    这里临时清空勾选、导出后再还原，确保永远是「全部」而不是「所选」。
        async function exportAllWorkspace() {
          if (typeof exportToZIP !== 'function') {
            alert('导出功能未就绪，请稍后重试。');
            return;
          }
          const saved = new Set(pgpySelectedFiles);
          pgpySelectedFiles.clear();
          try {
            try { snackbarStore.showInfoMessage('正在打包「全部工作区文件」…'); } catch (_) {}
            await exportToZIP();
          } finally {
            pgpySelectedFiles.clear();
            saved.forEach(function (p) { pgpySelectedFiles.add(p); });
          }
        }

        // ══════════════════════════════════════════════════════════════
        // ══════════════════════════════════════════════════════════
        //  SFTP 上传 / 下载（VFS ↔ 已连接 SSH 主机）
        //  依赖 07-mcp.js 提供的 sshApi() / sshMcpCall()（与 MCP ssh 工具同一条链路）。
        // ══════════════════════════════════════════════════════════
        // 选一台主机：优先用已连接的（多台时 prompt 让用户选）；
        // 无已连接但「恰好配置一台」→ 自动连接它；其余情况给出可读指引后返回 null。
        async function pgpySftpPickHost() {
            const api = (typeof sshApi === 'function') ? sshApi() : null;
            if (!api) {
                snackbarStore.showErrorMessage('SSH 不可用：需要 Electron 外壳（或 ssh2 未安装）');
                return null;
            }
            let st = null;
            try { st = await api.status(); } catch (_) {}
            const connected = ((st && st.ok && st.status) || []).filter(s => s.connected);
            if (connected.length >= 1) {
                if (connected.length === 1) return connected[0];
                const names = connected.map((s, i) => (i + 1) + ') ' + s.key).join('\n');
                const ans = prompt('多台主机已连接，输入序号或 host：\n' + names, '1');
                if (ans == null) return null;
                const t = ans.trim();
                const idx = parseInt(t, 10);
                const pick = (idx >= 1 && idx <= connected.length) ? connected[idx - 1]
                    : connected.find(s => s.host === t || s.key === t);
                if (!pick) { snackbarStore.showErrorMessage('未匹配到已连接主机'); return null; }
                return pick;
            }
            const hosts = (typeof chatbotStore !== 'undefined' && Array.isArray(chatbotStore.sshHosts))
                ? chatbotStore.sshHosts : [];
            if (hosts.length === 1) {
                try {
                    const r = await api.connect(hosts[0]);
                    if (r && r.ok) {
                        snackbarStore.showInfoMessage('已自动连接 ' + r.key);
                        try { sshRefreshMcpTools(); } catch (_) {}
                        return { key: r.key, host: hosts[0].host, port: hosts[0].port, username: hosts[0].username };
                    }
                    snackbarStore.showErrorMessage('SSH 连接失败：' + ((r && r.error) || '未知错误'));
                } catch (e) { snackbarStore.showErrorMessage('SSH 连接失败：' + String((e && e.message) || e)); }
                return null;
            }
            snackbarStore.showErrorMessage(hosts.length === 0
                ? '尚未配置 SSH 主机：请在「⚙️ 配置 → SSH Servers」添加并连接'
                : '没有已连接的 SSH 主机：请先在「⚙️ 配置 → SSH Servers」点「🔌 Connect」');
            return null;
        }
        // 解析 sshMcpCall 的 JSON 结果 → snackbar 提示；返回 success 布尔
        function pgpySftpShowResult(res) {
            let obj = null;
            try { obj = (typeof res === 'string') ? JSON.parse(res) : res; } catch (_) {}
            const text = (obj && obj.content && obj.content[0] && obj.content[0].text)
                ? obj.content[0].text : String(res);
            if (obj && obj.success) { snackbarStore.showSuccessMessage(text); return true; }
            snackbarStore.showErrorMessage(text);
            return false;
        }
        async function pgpySftpUpload() {
            if (typeof nodeRuntime === 'undefined' || !nodeRuntime || !nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
            if (typeof sshMcpCall !== 'function') { snackbarStore.showErrorMessage('SSH 工具未加载（07-mcp.js）'); return; }
            const files = [];
            pgpySelectedFiles.forEach(p => files.push(p));
            if (files.length === 0 && pgpyCurrentFilePath) files.push(pgpyCurrentFilePath);
            if (files.length === 0) { snackbarStore.showErrorMessage('请先勾选要上传的文件（或在编辑器打开一个文件）'); return; }
            const host = await pgpySftpPickHost();
            if (!host) return;
            const defPath = files.length === 1 ? '/home/' : '/';
            const input = prompt(
                '远程目标路径：\n· 单文件：完整文件路径，或以 / 结尾的目录\n· 多文件：必须是以 / 结尾的目录',
                defPath);
            if (input == null || !input.trim()) return;
            const target = input.trim();
            const isDir = target.endsWith('/');
            if (files.length > 1 && !isDir) {
                snackbarStore.showErrorMessage('多文件上传时目标必须是以 / 结尾的目录');
                return;
            }
            let ok = 0, fail = 0;
            const errs = [];
            for (const p of files) {
                const base = p.substring(p.lastIndexOf('/') + 1) || p;
                const remote = isDir ? target + base : target;
                try {
                    const res = await sshMcpCall({
                        name: 'ssh_sftp_upload',
                        arguments: { local_path: p, remote_path: remote, host: host.host }
                    });
                    let obj = null;
                    try { obj = JSON.parse(res); } catch (_) {}
                    if (obj && obj.success) ok++;
                    else {
                        fail++;
                        errs.push(base + '：' + (obj && obj.content && obj.content[0] ? obj.content[0].text : '失败'));
                    }
                } catch (e) { fail++; errs.push(base + '：' + String((e && e.message) || e)); }
            }
            const msg = '⬆ SFTP 上传完成：成功 ' + ok + ' / ' + files.length
                + (fail ? '，失败 ' + fail + '\n' + errs.join('\n') : '');
            if (fail && !ok) snackbarStore.showErrorMessage(msg);
            else if (fail) snackbarStore.showWarningMessage(msg);
            else snackbarStore.showSuccessMessage(msg);
        }
        async function pgpySftpDownload() {
            if (typeof nodeRuntime === 'undefined' || !nodeRuntime || !nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
            if (typeof sshMcpCall !== 'function') { snackbarStore.showErrorMessage('SSH 工具未加载（07-mcp.js）'); return; }
            const host = await pgpySftpPickHost();
            if (!host) return;
            const input = prompt('要下载的远程文件（完整路径）：', '/home/');
            if (input == null || !input.trim()) return;
            const remote = input.trim();
            const base = remote.split('/').filter(Boolean).pop();
            if (!base) { snackbarStore.showErrorMessage('路径无效'); return; }
            const res = await sshMcpCall({
                name: 'ssh_sftp_download',
                arguments: { remote_path: remote, host: host.host }
            });
            pgpySftpShowResult(res);   // sshMcpCall 内部已 listNodeFiles() 刷新列表
        }

        //  Export Folder (选择目录后把勾选文件写入该目录, 参考 eee.html)
        //  - 弹「另存为」目录选择器 (showDirectoryPicker, readwrite)
        //  - 写入路径忽略 /home/pyodide 前缀; 文件带子目录时先创建目录再写入
        //  - 未勾选任何文件 → 默认导出 /home/pyodide 下全部文件
        // ══════════════════════════════════════════════════════════════
        async function exportToFolder() {
          const pgpyStatus = document.getElementById('pgpyStatus');
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }

          // 浏览器不支持目录选择器时给出提示,建议改用 Export File (ZIP)
          if (typeof window.showDirectoryPicker !== 'function') {
            const errMsg = '当前浏览器不支持「Export Folder」(需 showDirectoryPicker)。请改用 📦 Export File 导出 ZIP,或使用 Chrome/Edge 浏览器。';
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 浏览器不支持 Export Folder'; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('❌ ' + errMsg);
            } else {
              alert(errMsg);
            }
            return;
          }

          // 1) 弹出「另存为」目录选择器 (readwrite 才能写入)
          let dirHandle = null;
          try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          } catch (err) {
            if (err && err.name === 'AbortError') return; // 用户主动取消
            console.warn('[pgpy] showDirectoryPicker 失败:', err);
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 无法打开目录选择器'; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('❌ 无法打开目录选择器: ' + (err.message || err));
            }
            return;
          }

          const totalStart = performance.now();
          const FS = nodeRuntime.FS;
          let exportAll = false;
          let hasDir = false;
          let failed = 0;
          const fileSet = new Set();

          // 2) 收集要导出的文件(与 exportToZIP 一致):
          //    勾选了 → 导出勾选内容(目录递归收集其下所有文件);
          //    未勾选 → 默认导出 /home/pyodide 下全部文件
          if (pgpySelectedFiles.size === 0) {
            exportAll = true;
            pgpyCollectDirFiles('/home/pyodide', fileSet);
          } else {
            for (const p of Array.from(pgpySelectedFiles)) {
              try {
                const st = FS.stat(p);
                if (FS.isDir(st.mode)) { hasDir = true; pgpyCollectDirFiles(p, fileSet); }
                else { fileSet.add(p); }
              } catch (err) { failed++; console.warn('[pgpy] 读取选中文件失败:', p, err); }
            }
          }

          if (fileSet.size === 0) {
            const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
            const msg = '❌ 没有可导出的文件:工作区为空,或勾选的文件夹都是空文件夹\n⏱ ' + elapsed + 's';
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 没有可导出的文件'; }
            pgpyRenderMessage(msg, true, elapsed);
            return;
          }

          // 3) 逐文件写入所选目录: 去掉 /home/pyodide 前缀; 前面的子目录段先创建再写文件
          if (pgpyStatus) {
            pgpyStatus.className = 'pgpy-status-badge pgpy-loading';
            pgpyStatus.textContent = '⏳ Exporting ' + fileSet.size + ' file(s) to "' + dirHandle.name + '"...';
          }

          let exported = 0;
          for (const p of Array.from(fileSet)) {
            try {
              const rel = pgpyZipRelPath(p); // 忽略 /home/pyodide 前缀
              if (!rel) continue;
              const segments = rel.split('/');
              // 逐级创建父目录(如有), 再写入文件
              let curDir = dirHandle;
              for (let i = 0; i < segments.length - 1; i++) {
                curDir = await curDir.getDirectoryHandle(segments[i], { create: true });
              }
              const fileName = segments[segments.length - 1];
              if (!fileName) continue;
              const fileHandle = await curDir.getFileHandle(fileName, { create: true });
              const writable = await fileHandle.createWritable();
              await writable.write(FS.readFile(p, { encoding: 'binary' }));
              await writable.close();
              exported++;
              if (pgpyStatus && fileSet.size > 1) {
                pgpyStatus.textContent = '⏳ Exporting ' + exported + '/' + fileSet.size + ': ' + rel + '...';
              }
            } catch (err) {
              failed++;
              console.warn('[pgpy] Export Folder 写入失败:', p, err);
            }
          }

          const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
          let summary = '✅ Exported ' + exported + ' file(s) to folder "' + dirHandle.name + '"';
          if (failed > 0) summary += ', ' + failed + ' failed';
          if (pgpyStatus) {
            pgpyStatus.className = 'pgpy-status-badge ' + (failed === 0 ? 'pgpy-success' : 'pgpy-error');
            pgpyStatus.textContent = summary + ' (' + elapsed + 's)';
          }
          let msg = summary + '\n⏱ ' + elapsed + 's';
          if (exportAll) msg += '\n📁 未勾选任何文件,已导出工作区全部文件';
          else if (hasDir) msg += '\n📁 已包含勾选文件夹下的所有文件';
          pgpyRenderMessage(msg, failed > 0, elapsed);
        }


        function importFile() {
          document.getElementById('fileInput').click();
        }

        // “Import Folder”：拖放目录在沙箱/网页拖放场景下可能因浏览器 data URL 长度限制
        // （EncodingError）而无法读取；通过文件选择器导入目录可拿到真实文件访问，
        // 完全绕开该限制，并保留目录结构（webkitRelativePath / File System Access API）。
        function importFolder() {
          // 优先 File System Access API：弹系统目录选择器，逐文件读取（不经过 data URL）
          if (window.showDirectoryPicker && typeof window.showDirectoryPicker === 'function') {
            pgpyPickDirectoryWithFS();
            return;
          }
          const input = document.getElementById('folderInput');
          if (input) input.click();
        }

        async function pgpyPickDirectoryWithFS() {
          let dirHandle = null;
          try {
            dirHandle = await window.showDirectoryPicker({ mode: 'read' });
          } catch (err) {
            // AbortError = 用户主动取消，直接结束，不再弹第二个选择框
            if (err && err.name === 'AbortError') return;
            // 其它错误（权限/跨域 iframe 不允许等）→ 退到 webkitdirectory 兜底
            console.warn('[pgpy] showDirectoryPicker 不可用，改用 <input webkitdirectory> 兜底:', err);
            const input = document.getElementById('folderInput');
            if (input) input.click();
            return;
          }
          try {
            const items = [];
            const walk = async (handle, prefix) => {
              for await (const entry of handle.values()) {
                const rel = prefix ? prefix + '/' + entry.name : entry.name;
                if (entry.kind === 'file') {
                  try {
                    const file = await entry.getFile();
                    items.push({ path: rel, file: file });
                  } catch (err) {
                    console.warn('[pgpy] 无法读取所选目录内文件:', rel, err);
                  }
                } else if (entry.kind === 'directory') {
                  await walk(entry, rel);
                }
              }
            };
            const pgpyStatus = document.getElementById('pgpyStatus');
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Reading folder...'; }
            await walk(dirHandle, '');
            if (items.length === 0) {
              if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 目录为空或无可读文件'; }
              pgpyRenderMessage('⚠️ 所选目录为空或无可读文件', true);
              return;
            }
            await pgpyProcessDroppedFiles(items);
          } catch (err) {
            console.error('[pgpy] 读取所选目录失败:', err);
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('❌ 读取所选目录失败: ' + (err.message || err));
            }
          }
        }

        function pgpyIsZipFile(file) {
          return file.name && file.name.toLowerCase().endsWith('.zip');
        }

        async function pgpyWriteFileToFS(file) {
          if (pgpyIsZipFile(file)) {
            await pgpyExtractZipToFS(await file.arrayBuffer(), '/home/pyodide');
          } else {
            const FS = nodeRuntime.FS;
            const targetPath = '/home/pyodide/' + file.name;
            try { FS.mkdirTree('/home/pyodide'); } catch (_) {}
            FS.writeFile(targetPath, new Uint8Array(await file.arrayBuffer()));
            // 记录磁盘真实路径（与拖放上传一致）：AI 编辑后据此同步回真实目录
            const realPath = pgpyRealPathOf(file);
            if (realPath) pgpySetRealPath(targetPath, realPath);
          }
        }

        async function pgpyProcessImportFiles(files) {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          const pgpyStatus = document.getElementById('pgpyStatus');
          const totalStart = performance.now();
          const total = files.length;
          let imported = 0, failed = 0;

          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Importing ' + total + ' file(s) to almostnode FS...'; }

          pgpySuppressSync = true;
          for (let i = 0; i < total; i++) {
            const file = files[i];
            try {
              await pgpyWriteFileToFS(file);
              imported++;
              if (pgpyStatus && total > 1) { pgpyStatus.textContent = '⏳ Importing ' + (i + 1) + '/' + total + ': ' + file.name + '...'; }
            } catch (err) {
              failed++;
              pgpyRenderMessage('Import Error (' + file.name + '): ' + err.message, true);
            }
          }
          pgpySuppressSync = false;

          if (imported > 0) {
            try { await pgpySyncMount(false); }
            catch (err) { console.warn('[pgpy] 同步失败,文件仅保存在内存:', err); }
          }

          const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
          if (failed === 0) {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '✅ Imported ' + imported + ' file(s) (' + elapsed + 's)'; }
            pgpyRenderMessage('📂 Imported ' + imported + ' file(s) → 工作区\n⏱ ' + elapsed + 's', false, elapsed);
          } else {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ ' + failed + '/' + total + ' failed (' + elapsed + 's)'; }
            pgpyRenderMessage('⚠️ ' + imported + ' imported, ' + failed + ' failed\n⏱ ' + elapsed + 's', true, elapsed);
          }

          if (imported > 0) { listNodeFiles(); }
        }

        // ══════════════════════════════════════════════════════════════
        //  Drag & Drop → 整个页面自动上传（支持文件与文件夹）
        //  拖动方式对齐 fff.html（内存优化版 · File System Access API）：
        //   - drop 时遍历 e.dataTransfer.items，逐条优先取 getAsFileSystemHandle()
        //     （FileSystemHandle 不经过 Chromium 的 data: URL → 无 EncodingError / 长度限制）
        //     目录用 handle.entries() 递归展开，保留顶层文件夹名与子目录结构
        //   - 未实现该 API 的环境（Safari/Firefox 等）回退 webkitGetAsEntry() + readEntries
        //   - 收集到 { 相对路径, File } 后逐个写入 almostnode FS(/home/pyodide)，
        //     并 sync 到 IndexedDB、刷新文件列表，刷新页面后仍可找到
        // ══════════════════════════════════════════════════════════════
        function pgpyDtHasFiles(e) {
            return e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
        }

        // ── 新 API（FileSystemHandle）递归遍历 —— 同 fff.html traverseFileSystemHandle ──
        //    目录用 handle.entries() 展开（每层把 handle.name + '/' 拼进相对路径），
        //    文件用 handle.getFile() 读取；始终保留顶层文件夹名与子目录结构。
        async function pgpyTraverseHandle(handle, path) {
            const out = [];
            if (!handle) return out;
            if (handle.kind === 'file') {
                try {
                    const file = await handle.getFile();
                    out.push({ path: path + file.name, file: file });
                } catch (err) {
                    console.warn('[pgpy] 无法读取文件 ' + path + (handle.name || '') + ':', err);
                }
            } else if (handle.kind === 'directory') {
                // 目录本身也产出一条目（含空目录 / 空文件的目录）：即使目录内没有可读取的文件，
                // 也要在虚拟 FS 建出该目录，使其在文件列表里产生一个「📁 dir」行。
                const dirPath = path + handle.name;
                out.push({ path: dirPath, dir: true });
                try {
                    for await (const [, childHandle] of handle.entries()) {
                        const children = await pgpyTraverseHandle(childHandle, dirPath + '/');
                        out.push(...children);
                    }
                } catch (err) {
                    console.warn('[pgpy] 无法遍历目录 ' + path + (handle.name || '') + ':', err);
                }
            }
            return out;
        }

        // ── 旧 API（FileSystemEntry）兼容层 —— 同 fff.html traverseFileTree + readAllDirectoryEntries ──
        function pgpyReadAllDirEntries(dirReader) {
            const allEntries = [];
            return new Promise((resolve, reject) => {
                function readBatch() {
                    dirReader.readEntries(entries => {
                        if (!entries || entries.length === 0) resolve(allEntries);
                        else { allEntries.push(...entries); readBatch(); }
                    }, reject);
                }
                readBatch();
            });
        }
        function pgpyGetEntryFile(fileEntry) {
            return new Promise((resolve, reject) => fileEntry.file(resolve, reject));
        }
        async function pgpyTraverseEntry(entry, path) {
            const out = [];
            if (!entry) return out;
            if (entry.isFile) {
                try {
                    const file = await pgpyGetEntryFile(entry);
                    out.push({ path: path + entry.name, file: file });
                } catch (err) {
                    console.warn('[pgpy] 无法读取文件 ' + path + entry.name + ':', err);
                }
            } else if (entry.isDirectory) {
                // 目录本身也产出一条目（含空目录 / 空文件的目录）——同 pgpyTraverseHandle
                const dirPath = path + entry.name;
                out.push({ path: dirPath, dir: true });
                try {
                    const entries = await pgpyReadAllDirEntries(entry.createReader());
                    for (const child of entries) {
                        const children = await pgpyTraverseEntry(child, dirPath + '/');
                        out.push(...children);
                    }
                } catch (err) {
                    console.warn('[pgpy] 无法遍历目录 ' + path + entry.name + ':', err);
                }
            }
            return out;
        }

        // 从 DataTransfer 收集全部待上传条目 —— 思路同 fff.html handleDrop：
        //   items 中每一项：getAsFileSystemHandle() → 遍历（主路径）
        //                 失败/不支持 → webkitGetAsEntry() → 遍历（兼容层）
        //                 仍拿不到 → getAsFile() 按文件名写入（兜底）
        // 最后用 dataTransfer.files 补漏（部分环境 items 只暴露一个条目），按相对路径去重。
        async function pgpyCollectDroppedFiles(dataTransfer) {
            const result = { items: [] };
            const seen = new Map(); // key → item（同一路径只保留一条，但会补齐真实路径）

            // ⚠️ 关键：DataTransfer 只在 drop 事件的同步阶段有效，一旦进入 await
            // （getAsFileSystemHandle / getFile / 目录遍历等）之后，dataTransfer.files
            // 与 dataTransfer.items 会被清空。因此必须在这里、任何 await 之前，同步
            // 快照 dataTransfer.files 及其磁盘真实路径；否则真实路径既拿不到、末尾的
            // 补漏也读不到文件，导致「同步回磁盘真实目录」整体失效。
            const dtFiles = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
            const dtRealByRel = new Map();   // 相对路径 → 真实路径
            const dtRealByBase = new Map();  // 文件名 → { realPath, count }（仅用于唯一匹配）
            for (const f of dtFiles) {
                const rel = (f.webkitRelativePath || f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
                const rp = pgpyRealPathOf(f); // 同步：Electron webUtils.getPathForFile
                if (rp) {
                    if (rel) dtRealByRel.set(rel, rp);
                    const base = String(f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
                    if (base) {
                        const cur = dtRealByBase.get(base);
                        if (cur) cur.count += 1; else dtRealByBase.set(base, { realPath: rp, count: 1 });
                    }
                }
            }
            // 用「drop 同步阶段」的快照为某虚拟路径解析真实路径：优先精确相对路径，其次唯一文件名
            const dtLookup = (key) => {
                if (dtRealByRel.has(key)) return dtRealByRel.get(key);
                const base = String(key || '').split('/').pop();
                const hit = base ? dtRealByBase.get(base) : null;
                return hit && hit.count === 1 ? hit.realPath : '';
            };

            // 若拖入的是目录：顶层目录本身可能出现在 dataTransfer.files 中（名字=目录名，
            // 真实路径=该目录的真实路径）；用它给该目录下的条目附上「目录真实路径」提示。
            const dtRootHint = (key) => {
                const top = String(key || '').split('/')[0];
                if (!top) return '';
                const hit = dtRealByBase.get(top);
                return hit && hit.count === 1 ? hit.realPath : '';
            };

            const addItem = (p, f, isDir) => {
                const key = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
                if (!key) return;
                if (!isDir && !f) return; // 目录条目没有 File 对象；文件条目必须带 File
                // 记录 File 对象的磁盘真实路径（Electron：webUtils.getPathForFile）；
                // handle 派生的 File 通常拿不到真实路径，回退到上面的同步快照
                const realPath = (f ? pgpyRealPathOf(f) : '') || dtLookup(key) || '';
                const rootHintReal = key.indexOf('/') !== -1 ? dtRootHint(key) : '';
                if (seen.has(key)) {
                    // 同一路径已存在：若先前那条没拿到真实路径而这条拿到了，则补齐并换成有真实路径的 File
                    const existing = seen.get(key);
                    if (realPath && existing && !existing.realPath) { existing.realPath = realPath; if (f) existing.file = f; }
                    if (rootHintReal && existing && !existing.rootHintReal) existing.rootHintReal = rootHintReal;
                    return;
                }
                const item = { path: key, file: f, isDir: !!isDir, realPath: realPath, rootHintReal: rootHintReal };
                seen.set(key, item);
                result.items.push(item);
            };

            const dtItems = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];

            // ⚠️ 关键（修复「同时拖入文件 + 文件夹时文件夹偶尔丢失」）：
            // getAsFileSystemHandle() / webkitGetAsEntry() / getAsFile() 必须在 drop 事件的
            // 「同步阶段」就调用——DataTransfer 只在事件分发期间有效，一旦进入 await，
            // 后续条目的这些方法要么抛异常、要么返回 null。
            // 原实现把它们放在 for 循环里「逐个 await」，于是第二条及之后的条目（往往是
            // 拖入的文件夹）取不到句柄/entry，被直接丢弃。这里先在同步阶段把所有条目的
            // 句柄 Promise、entry、File 一次性快照下来，再逐个 await 遍历。
            const dtItemSnapshots = dtItems.map(item => {
                const snap = { handlePromise: null, entry: null, file: null };
                // 1) 优先 File System Access API（fff.html 主路径；目录/大文件不经过 data: URL）
                try {
                    if (item && typeof item.getAsFileSystemHandle === 'function') {
                        // 同步调用拿到 Promise（此时 DataTransfer 仍有效），并立即挂 catch：
                        // 即便在被 await 之前它先 reject，也不会产生「未处理的 rejection」；
                        // 失败时返回 null → 循环里自动回退到 entry / File。
                        snap.handlePromise = Promise.resolve(item.getAsFileSystemHandle())
                            .catch(err => { console.warn('[pgpy] getAsFileSystemHandle 失败，回退 webkitGetAsEntry:', err); return null; });
                    }
                } catch (err) {
                    console.warn('[pgpy] getAsFileSystemHandle 同步调用失败，回退 webkitGetAsEntry:', err);
                }
                // 2) 回退：旧 API webkitGetAsEntry（同 fff.html traverseFileTree）——同步取 entry
                try { snap.entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (_) {}
                // 3) 兜底：直接取 File（拿不到目录结构信息时按文件名写入）——同步取 File
                try { snap.file = item && item.getAsFile ? item.getAsFile() : null; } catch (_) {}
                return snap;
            });

            for (const snap of dtItemSnapshots) {
                // ✅ 优先 File System Access API
                if (snap.handlePromise) {
                    try {
                        const handle = await snap.handlePromise;
                        if (handle) {
                            const collected = await pgpyTraverseHandle(handle, '');
                            collected.forEach(x => addItem(x.path, x.file, x.dir));
                            continue;
                        }
                    } catch (err) {
                        console.warn('[pgpy] getAsFileSystemHandle 失败，回退 webkitGetAsEntry:', err);
                    }
                }
                // ⚠️ 回退：旧 API webkitGetAsEntry（已在同步阶段快照）
                if (snap.entry) {
                    const collected = await pgpyTraverseEntry(snap.entry, '');
                    collected.forEach(x => addItem(x.path, x.file, x.dir));
                    continue;
                }
                // 兜底：直接取 File（拿不到目录结构信息时按文件名写入）
                if (snap.file) addItem(snap.file.name, snap.file);
            }

            // 多文件/多目录拖放补漏：用同步阶段快照的 dataTransfer.files（含真实路径）；
            // 文件夹拖放时 webkitRelativePath 已带相对目录 → 直接按相对路径写入。
            for (const f of dtFiles) {
                const rel = (f.webkitRelativePath || f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
                if (rel) addItem(rel, f);
            }
            // 最后兜底：对仍未解析出真实路径的条目（如 handle 派生路径与文件名不一致），
            // 用同步快照的映射再补一次
            for (const it of result.items) {
                if (!it.realPath) { const rp = dtLookup(it.path); if (rp) it.realPath = rp; }
                if (!it.rootHintReal && it.path.indexOf('/') !== -1) { const h = dtRootHint(it.path); if (h) it.rootHintReal = h; }
            }
            return result;
        }

        // 把单个 { path, file } 写入 almostnode FS（自动创建父目录；.zip 解压到 /home/pyodide）
        async function pgpyWriteDroppedItem(item) {
            if (!item) return;
            const FS = nodeRuntime.FS;
            // 目录条目（含空目录 / 空文件的目录）：在虚拟 FS 建出该目录，使其产生一个「📁 dir」行。
            if (item.isDir) {
                const dirPath = '/home/pyodide/' + item.path;
                try { FS.mkdirTree(dirPath); } catch (_) {}
                const dirReal = item.realPath || pgpyResolveRealPath(dirPath);
                if (dirReal) pgpySetRealPath(dirPath, dirReal);
                return;
            }
            if (!item.file) return;
            if (pgpyIsZipFile(item.file)) {
                await pgpyExtractZipToFS(await item.file.arrayBuffer(), '/home/pyodide');
                return;
            }
            const targetPath = '/home/pyodide/' + item.path;
            const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
            try { FS.mkdirTree(parentDir || '/home/pyodide'); } catch (_) {}
            FS.writeFile(targetPath, new Uint8Array(await item.file.arrayBuffer()));
            // 记录该文件在磁盘上的真实路径：AI 编辑虚拟 FS 后据此把内容同步回真实目录
            const realPath = item.realPath || pgpyRealPathOf(item.file);
            if (realPath) {
                pgpySetRealPath(targetPath, realPath);
                // 落一枚「拖入时」的磁盘指纹：同步前据此判断磁盘有没有被外部改过
                try { pgpyRecordDiskFp(realPath, FS.readFile(targetPath, { encoding: 'binary' })); } catch (_) {}
            }
            // 拖入的是目录：记录顶层目录的真实路径，之后该目录下「新建的文件」也能同步回真实目录
            if (realPath) pgpyRecordDroppedFolderFromFile(item.path, realPath);
            if (item.rootHintReal && item.path && item.path.indexOf('/') !== -1) {
                pgpySetRealPath('/home/pyodide/' + item.path.split('/')[0], item.rootHintReal);
            }
        }

        // ── 顶层目录改名去冲突 ───────────────────────────────────────────
        // 拖入的目录以「顶层目录名」作为虚拟根（/home/pyodide/<顶层名>/…）。当不同父目录下存在
        // 同名目录（如 D:/a/proj 与 D:/b/proj）时，二者会共用同一个虚拟根：
        //   · 后拖入的目录里的同名文件会覆盖先前目录里的文件；
        //   · 顶层目录（及其子文件）的「真实路径映射」会被后拖入的目录覆盖。
        // 于是对先前目录里文件的改动，在「同步」时会读到被覆盖后的内容、并按（可能已被改写的）
        // 映射写回，等于把「原来的目录」改坏、同步出错。
        // 修复：写入前为每个顶层目录规划一个不冲突的虚拟名（重名时追加 " (2)"、" (3)" …），
        // 让来自不同真实目录的同名目录各自独立（重复拖入同一个目录仍按同一真实路径合并）。
        function pgpyTopNameTaken(name, incomingReal, taken) {
            if (taken.has(name)) return true; // 本批次内已占用
            const vTop = '/home/pyodide/' + name;
            let exists = false;
            try {
                const FS = nodeRuntime && nodeRuntime.FS;
                exists = !!(FS && typeof FS.exists === 'function' && FS.exists(vTop));
                if (!exists && FS && typeof FS.stat === 'function') { try { FS.stat(vTop); exists = true; } catch (_) {} }
            } catch (_) { exists = false; }
            if (!exists) return false; // 目标虚拟目录不存在 → 无冲突
            const existingReal = pgpyGetRealPath(vTop) || pgpyResolveRealPath(vTop);
            // 双方都没有真实路径信息（如浏览器环境）→ 维持原有的「同名合并」行为
            if (!existingReal && !incomingReal) return false;
            // 同一真实目录（重复拖入同一个文件夹）→ 允许合并，不改名
            if (existingReal && incomingReal && pgpySlash(existingReal) === pgpySlash(incomingReal)) return false;
            return true; // 已存在且来自另一个真实目录 → 冲突，需要改名
        }

        // 为一批拖入条目规划顶层目录的虚拟名：返回 Map<原顶层名, 实际顶层名>
        function pgpyPlanDroppedTopNames(items) {
            const map = new Map();
            const taken = new Set();
            const info = new Map(); // 顶层名 → { real, isDir }
            for (const it of items) {
                const p = String((it && it.path) || '');
                const top = p.split('/')[0];
                if (!top) continue;
                let rec = info.get(top);
                if (!rec) { rec = { real: '', isDir: false }; info.set(top, rec); }
                if (p.indexOf('/') !== -1 || (it && it.isDir)) rec.isDir = true;
                if (!rec.real) {
                    if (it && it.realPath) rec.real = pgpyTopRealOf(p, it.realPath) || '';
                    else if (it && it.rootHintReal) rec.real = it.rootHintReal;
                }
            }
            for (const [top, rec] of info) {
                if (!rec.isDir) { map.set(top, top); continue; } // 单个文件条目：不改名
                let name = top, n = 1;
                while (pgpyTopNameTaken(name, rec.real, taken)) { n++; name = top + ' (' + n + ')'; }
                map.set(top, name);
                taken.add(name);
            }
            return map;
        }

        // 按规划把条目的顶层目录名替换为不冲突的名字（保持其余相对路径不变）
        function pgpyApplyDroppedTopNames(items) {
            let renames = null;
            try { renames = pgpyPlanDroppedTopNames(items); } catch (_) { return; }
            if (!renames) return;
            for (const it of items) {
                const p = String((it && it.path) || '');
                const top = p.split('/')[0];
                if (!top) continue;
                const nt = renames.get(top);
                if (nt && nt !== top) it.path = nt + p.slice(top.length);
            }
        }

        // 拖入 = 用户对「这些真实路径」的显式授权（主进程默认零授权，读写前必需）。
        // 目录条目授权后，其子文件/新建文件都随目录授权，无需逐个登记。
        //
        // 拖放本身就是显式动作，因此不再弹「路径授权」原生确认框：优先走
        // fileAPI.grantDropped({ paths, proofs }) 的免确认批量授权。proofs 是拖入
        // File 的真实路径（getPathForFile 取得），主进程用它证明「这些路径确实是
        // 用户拖进来的」，脚本无法伪造。拿不到任何真实路径时（如目录选择器派生的
        // File 没有磁盘路径）退回旧的逐条 grant，仍由原生确认框兜底。
        async function pgpyGrantDroppedPaths(fileItems) {
            if (!window.fileAPI) return;
            const paths = [];
            const proofs = [];
            const seen = Object.create(null);
            const seenProof = Object.create(null);
            const push = (p) => {
                const s = String(p || '');
                if (!s || seen[s]) return;
                seen[s] = true;
                paths.push(s);
            };
            const pushProof = (p) => {
                const s = String(p || '');
                if (!s || seenProof[s]) return;
                seenProof[s] = true;
                proofs.push(s);
            };
            (fileItems || []).forEach(it => {
                if (!it) return;
                // 顶层目录的 realPath 优先（一次授权覆盖整个拖入目录）
                push(it.rootHintReal);
                // 顶层目录的真实路径同样来自 getPathForFile（拖入空目录时是唯一凭据）
                pushProof(it.rootHintReal);
                const real = String(it.realPath || '');
                if (!real) return;
                // 真实文件路径同时作为「用户确实拖入了它」的证明
                pushProof(real);
                // 单个文件条目：realPath 就是文件本身；目录内的条目：向上取到「拖入的顶层目录」
                const depth = String(it.path || '').split('/').filter(Boolean).length;
                let top = real;
                for (let i = 1; i < depth; i++) {
                    const idx = Math.max(top.lastIndexOf('/'), top.lastIndexOf('\\'));
                    if (idx <= 0) break;
                    top = top.slice(0, idx);
                }
                push(top);
            });
            // ① 有真实拖入路径作证明 → 免确认批量授权
            if (proofs.length && typeof window.fileAPI.grantDropped === 'function') {
                try {
                    const r = await window.fileAPI.grantDropped({ paths: paths, proofs: proofs });
                    if (r && r.ok !== false) {
                        ((r && r.rejected) || []).forEach(x => {
                            console.warn('[pgpy] 未获授权:', x.path, x.reason || '');
                        });
                        return;
                    }
                    console.warn('[pgpy] 免确认授权被拒，回退逐条授权:', (r && (r.reason || r.error)) || '');
                } catch (err) {
                    console.warn('[pgpy] 免确认授权失败，回退逐条授权:', err);
                }
            }
            // ② 兜底：旧的逐条 grant（会弹原生确认框）
            if (typeof window.fileAPI.grant !== 'function') return;
            for (const p of paths) {
                try {
                    const r = await window.fileAPI.grant(p);
                    if (r && r.ok === false) {
                        console.warn('[pgpy] 未获授权:', p, r.reason || '', r.error || '');
                    }
                } catch (err) {
                    console.warn('[pgpy] 授权失败:', p, err);
                }
            }
        }

        // 批量把拖放收集到的文件写入 almostnode FS（逐文件处理，内存友好；进度/渲染风格与 Import 一致）
        async function pgpyProcessDroppedFiles(fileItems) {
            if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
            if (!fileItems || fileItems.length === 0) return;
            await pgpyGrantDroppedPaths(fileItems);
            // 不同父目录下的同名目录会共用虚拟根 → 覆盖旧内容 / 覆盖真实路径映射，导致同步写错目录。
            // 写入前先为顶层目录规划去冲突的虚拟名（重复拖入同一真实目录仍合并）。
            try { pgpyApplyDroppedTopNames(fileItems); } catch (err) { console.warn('[pgpy] 顶层目录去冲突失败:', err); }
            const pgpyStatus = document.getElementById('pgpyStatus');
            const totalStart = performance.now();
            const total = fileItems.length;
            let imported = 0, failed = 0;

            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Uploading ' + total + ' item(s) to almostnode FS...'; }

            pgpySuppressSync = true;
            for (let i = 0; i < total; i++) {
                const item = fileItems[i];
                try {
                    await pgpyWriteDroppedItem(item);
                    imported++;
                    if (pgpyStatus && total > 1) { pgpyStatus.textContent = '⏳ Uploading ' + (i + 1) + '/' + total + ': ' + item.path + '...'; }
                } catch (err) {
                    failed++;
                    console.warn('[pgpy] 拖放导入失败:', item.path, err);
                }
            }
            pgpySuppressSync = false;

            if (imported > 0) {
                try { await pgpySyncMount(false); }
                catch (err) { console.warn('[pgpy] 同步失败,文件仅保存在内存:', err); }
            }

            const elapsed = ((performance.now() - totalStart) / 1000).toFixed(3);
            if (failed === 0) {
                if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '✅ Uploaded ' + imported + ' item(s) (' + elapsed + 's)'; }
                pgpyRenderMessage('📂 Uploaded ' + imported + ' item(s) → 工作区\n⏱ ' + elapsed + 's', false, elapsed);
            } else {
                if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ ' + failed + '/' + total + ' failed (' + elapsed + 's)'; }
                pgpyRenderMessage('⚠️ ' + imported + ' uploaded, ' + failed + ' failed\n⏱ ' + elapsed + 's', true, elapsed);
            }

            if (imported > 0) { listNodeFiles(); }
        }

        // 绑定拖放事件到「整个页面」—— 拖到页面任意位置即可上传文件/文件夹到工作区：
        //   · document 级监听 dragenter/dragover/dragleave/drop：拖入文件时阻止浏览器
        //     「打开文件」跳转，并显示整页高亮遮罩；松开鼠标（drop）即在 document 上
        //     收集文件并写入 almostnode FS —— 不再局限于 Query Results 面板；
        //   · 仅处理带 Files 的拖放（pgpyDtHasFiles），避免干扰 agent 卡片等内部拖放；
        //     对话输入区拖入图片仍由 handleChatDrop 拦截（stopPropagation），不会重复上传；
        //   · dragenter/dragleave 用深度计数，避免在子元素间移动时遮罩闪烁。
        function pgpyGetDropOverlay() {
            let overlay = document.getElementById('pgpyGlobalDropOverlay');
            if (overlay) return overlay;
            overlay = document.createElement('div');
            overlay.id = 'pgpyGlobalDropOverlay';
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:99999', 'display:none',
                'align-items:center', 'justify-content:center',
                'background:rgba(74,158,255,0.12)', 'border:2px dashed #4a9eff',
                'box-sizing:border-box', 'color:#1d4ed8', 'font-weight:700',
                'font-size:16px', 'text-align:center', 'padding:12px',
                'pointer-events:none', 'font-family:inherit'
            ].join(';');
            overlay.textContent = '📂 松开鼠标上传文件/文件夹到工作区 · Drop to upload';
            document.body.appendChild(overlay);
            return overlay;
        }

        function pgpyInitDragDrop() {
            const overlay = pgpyGetDropOverlay();
            let dragDepth = 0;
            function showOverlay() { if (overlay) overlay.style.display = 'flex'; }
            function hideOverlay() { dragDepth = 0; if (overlay) overlay.style.display = 'none'; }

            // 捕获阶段：任何 drop / dragend 都先收起遮罩，避免被 handleChatDrop 等
            // 子元素 stopPropagation 后遮罩残留。
            document.addEventListener('drop', function() { hideOverlay(); }, true);
            document.addEventListener('dragend', function() { hideOverlay(); }, true);

            // dragenter/dragleave：深度计数控制高亮遮罩显隐
            document.addEventListener('dragenter', function(e) {
                if (!pgpyDtHasFiles(e)) return;
                dragDepth++;
                showOverlay();
            }, false);
            document.addEventListener('dragleave', function(e) {
                if (!pgpyDtHasFiles(e)) return;
                dragDepth = Math.max(0, dragDepth - 1);
                if (dragDepth === 0) hideOverlay();
            }, false);

            // dragover：阻止默认「打开文件」跳转，并把光标设为 copy
            document.addEventListener('dragover', function(e) {
                if (!pgpyDtHasFiles(e)) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                showOverlay();
            }, false);

            // drop：页面任意位置松开鼠标 → 收集(fff.html 方式) → 写入 almostnode FS
            document.addEventListener('drop', async function(e) {
                if (!pgpyDtHasFiles(e)) return;
                e.preventDefault();
                hideOverlay();
                try {
                    const res = await pgpyCollectDroppedFiles(e.dataTransfer);
                    const items = res.items || [];
                    if (items.length > 0) {
                        await pgpyProcessDroppedFiles(items);
                    } else {
                        const pgpyStatus = document.getElementById('pgpyStatus');
                        if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ 没有读取到可上传的文件'; }
                        if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
                            snackbarStore.showErrorMessage('❌ 没有读取到可上传的文件：请确认拖入的是文件/文件夹，或改用「📁 Import Folder」按钮');
                        }
                    }
                } catch (err) {
                    console.error('[pgpy] 拖放上传失败:', err);
                    if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
                        snackbarStore.showErrorMessage('❌ 拖放上传失败: ' + (err.message || err));
                    }
                }
            });
        }


        // ══════════════════════════════════════════════════════════════
        //  File input handler (supports multi-select)
        // ══════════════════════════════════════════════════════════════
        document.addEventListener('change', function(e) {
          if (e.target.id === 'fileInput' && e.target.files.length) {
            pgpyProcessImportFiles(Array.from(e.target.files));
            e.target.value = '';
          }
          if (e.target.id === 'folderInput' && e.target.files && e.target.files.length) {
            // webkitdirectory 选择目录：webkitRelativePath 形如 "顶层目录/子目录/文件"
            const items = Array.from(e.target.files).map(f => ({
              path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
              file: f
            }));
            pgpyProcessDroppedFiles(items);
            e.target.value = '';
          }

          if (e.target && e.target.classList && e.target.classList.contains('pgpy-file-check')) {
            const path = e.target.getAttribute('data-path');
            if (path) {
              if (e.target.checked) pgpySelectedFiles.add(path);
              else pgpySelectedFiles.delete(path);
            }
          }
          if (e.target && e.target.id === 'pgpyCheckAll') {
            const checked = e.target.checked;
            document.querySelectorAll('#pgpyResultsBody .pgpy-file-check').forEach(cb => {
              cb.checked = checked;
              const p = cb.getAttribute('data-path');
              if (p) {
                if (checked) pgpySelectedFiles.add(p);
                else pgpySelectedFiles.delete(p);
              }
            });
          }
          // 勾选变化 → 重新评估「同步」按钮可用性（仅勾选了变更文件才可点）
          pgpyUpdateSyncButton();
        });


        // ══════════════════════════════════════════════════════════════
        //  Import Query History JSON（与 Query History 选择历史导入一致）
        //  支持两种 Query History 导出格式：
        //    1. 单条对话导出（⬇️ 下载按钮）: [{ role, content, ... }, ...]
        //    2. 完整历史导出（标题栏 ⬇️ 下载全部）: [{ id, history: [...] }, ...]
        // ══════════════════════════════════════════════════════════════
        function importHistoryJson() {
          const input = document.getElementById('historyJsonInput');
          if (input) input.click();
        }

        function importHistoryJsonData(data) {
          let conversations = [];

          if (Array.isArray(data)) {
            if (data.length > 0 && data[0] && Array.isArray(data[0].history)) {
              // 完整 Query History 导出：[{ id, history: [...] }, ...]
              conversations = data.filter(item => item && Array.isArray(item.history) && item.history.length > 0);
            } else if (data.length > 0 && data[0] && data[0].role) {
              // 单条对话导出：[{ role, content, ... }, ...]
              conversations = [{ history: data }];
            }
          }

          if (conversations.length === 0) {
            snackbarStore.showErrorMessage('无法识别的 JSON 格式：请导入 Query History 导出的对话文件');
            return;
          }

          // 与 Query History 选择历史一致：把导入的对话载入到当前对话区
          messageStore.conversation = conversations[0].history;

          // 写入历史记录（保留原 id；若与现有 id 重复则生成新 id），使导入后可在 Query History 中再次选择
          conversations.forEach(item => {
            let entryId = item.id || historyStore.getDate();
            if (historyStore.conversation.some(c => c.id === entryId)) {
              entryId = historyStore.getDate();
            }
            historyStore.conversation.unshift({ id: entryId, history: item.history });
          });
          historyStore.save();

          // 导入的多条对话也同步进会话事件日志（磁盘 append-only 事实源）
          try { if (typeof sessionLog !== 'undefined' && sessionLog && sessionLog.syncAll) sessionLog.syncAll(); } catch (_) {}

          messageStore.resetTimer();
          renderConversation();
          // 刷新右侧按钮（统一 More ⋯）
          updateInputIcon();
          snackbarStore.showSuccessMessage(
            '已导入 ' + conversations.length + ' 个对话，当前对话 ' + conversations[0].history.length + ' 条消息'
          );
        }

        document.addEventListener('change', function(e) {
          if (e.target.id === 'historyJsonInput' && e.target.files.length) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (event) => {
              try {
                const data = JSON.parse(event.target.result);
                importHistoryJsonData(data);
              } catch (err) {
                snackbarStore.showErrorMessage('无法解析 JSON 文件: ' + err.message);
              }
            };
            reader.readAsText(file);
            e.target.value = '';
          }
        });

        // ══════════════════════════════════════════════════════════════
        //  Utility
        // ══════════════════════════════════════════════════════════════
        function pgpyEscapeHtml(s) {
          return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        function pgpyEscapeAttr(s) {
          return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }

        function syncPgpyStatus() {
          const pgpyStatus = document.getElementById('pgpyStatus');
          if (!pgpyStatus) return;
          if (nodeRuntime.ready) {
            pgpyStatus.className = 'pgpy-status-badge pgpy-success';
            pgpyStatus.textContent = '✅ Node Ready';
          } else {
            pgpyStatus.className = 'pgpy-status-badge pgpy-loading';
            pgpyStatus.textContent = '⏳ Loading Node.js runtime...';
          }
          pgpyUpdateRunButton();
        }

        function initPgpEditor() {
          pgpyInitEditor();
          pgpyUpdateExamples();
          syncPgpyStatus();
          if (!pgpyEnginesStarted) {
            pgpyEnginesStarted = true;
          }
        }

        // 启动 almostnode Node.js 运行时加载（页面加载即开始）
        initNodeRuntime();

        function initApp() {
            // PGPy Node.js 编辑器初始化（CodeMirror + 示例按钮 + 状态同步）
            initNodeRuntime();
            initPgpEditor();
            subagentStore.resetTaskState();
            agentStore.loadPersisted();
            applyI18n();
            updateSpeedDial();
            updateInputIcon();
            updateCacheStats();
            // 计划条：页面加载后按持久化的计划渲染一次（长任务刷新后仍可见）
            try { planStore.forceReinject(); renderPlanBar(); } catch (_) {}
            // 拖放文件/文件夹到 PGPy Results Panel → 自动上传到 almostnode FS
            pgpyInitDragDrop();
            // 文件比较（Beyond Compare 风格）：绑定对话框交互
            pgpyInitDiffUI();


            // 输入框
            const userInput = document.getElementById('userInput');
            userInput.addEventListener('input', function() {
                messageStore.userMessage = this.value;
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 200) + 'px';
                updateInputIcon();
            });
            userInput.addEventListener('keydown', (e) => messageStore.handleKeydown(e));
            // 中文输入法：组词期间的回车用于上屏，不能当作换行/发送（见 messageStore.handleKeydown）。
            // 记录组词状态与「刚上屏」时间戳，兼容不同输入法 keydown/compositionend 的先后顺序。
            userInput.addEventListener('compositionstart', () => { messageStore._composing = true; });
            userInput.addEventListener('compositionend', () => {
                messageStore._composing = false;
                messageStore._composedAt = Date.now();
            });
            // 输入框默认 3 行（min-height 已固定为 3 行高度），聚焦/失焦不再改变行数
            userInput.addEventListener('focus', () => settingStore.setInputRow(3, 0));
            userInput.addEventListener('blur', () => settingStore.setInputRow(3, 150));

            // ══════════════════════════════════════════════════════════
            // 保证「点击输入区无论如何都能输入」
            //   现象：点过某些工具结果 tab（或其他非输入控件）后，焦点被留在 body 上，
            //   再点击输入框时光标无法落回 textarea，导致无法直接打字。
            //   处理：点击输入区内非交互控件的位置时主动把焦点交还 textarea；
            //   点击 textarea 本身仍走浏览器默认行为（可在点击处精确定位光标）。
            // ══════════════════════════════════════════════════════════
            (function wireInputFocusGuard() {
                // 监听整个输入面板而不是只监听 .input-area：
                // 计划条/计时/费用/速度拨盘都在 .input-panel 里，扩大监听面更不容易漏点。
                const inputAreaEl = document.querySelector('.input-panel') ||
                    document.querySelector('.input-area');
                if (!inputAreaEl) return;
                // 输入区内真正需要交互的控件：点击它们时不要抢焦点
                const isInputControl = (t) => {
                    if (!t || !t.closest) return false;
                    if (t === userInput) return false; // 输入框本身：交给默认聚焦 + 下方兜底
                    return !!t.closest('button, a, input, select, label, [contenteditable="true"], ' +
                        '.attach-chip, .attach-del, #inputIcon, #speedDial, #langMenu, #moreMenu, ' +
                        '.plan-bar, .run-timer-wrap, .conv-cost-wrap, .cache-stats-wrap');
                };
                const focusUserInput = () => {
                    try {
                        userInput.focus({ preventScroll: true });
                    } catch (_) {
                        try { userInput.focus(); } catch (__) {}
                    }
                };
                // mousedown：点击输入区空白处（非控件）时立即聚焦，并阻止焦点落到 body / 触发整页选区
                inputAreaEl.addEventListener('mousedown', function (e) {
                    if (e.button !== 0) return;
                    if (e.target === userInput) return;   // 交给默认行为，可在点击处定位光标
                    if (isInputControl(e.target)) return; // 不打断按钮 / 附件等控件
                    e.preventDefault();
                    focusUserInput();
                    try {
                        const n = userInput.value.length;
                        userInput.setSelectionRange(n, n);
                    } catch (_) {}
                });
                // click 兜底：个别情况下 mousedown 的聚焦会被后续默认动作打断，
                // 点击结束后若焦点仍不在输入框，再补一次（含点到 textarea 但未聚焦成功的场景）。
                inputAreaEl.addEventListener('click', function (e) {
                    if (isInputControl(e.target)) return;
                    if (document.activeElement === userInput) return;
                    setTimeout(function () {
                        if (document.activeElement !== userInput) focusUserInput();
                    }, 0);
                });
                // 兜底（捕获阶段，全文档）：只要点击目标就是 textarea 本身，
                // 就在本轮事件链结束后校验一次焦点；若被其他脚本/默认动作抢走则强制拉回。
                // 专门修复「新建对话 / 点过浮层后，再点输入框光标不落回」。
                document.addEventListener('mousedown', function (e) {
                    if (e.button !== 0 || e.target !== userInput) return;
                    setTimeout(function () {
                        if (document.activeElement !== userInput) focusUserInput();
                    }, 0);
                }, true);

                // 兜底 ②（按坐标判定，覆盖「输入框被透明浮层/残留遮罩盖住」的情况）：
                //   上面那条只在 e.target === userInput 时补聚焦；一旦有浮层压在输入框上，
                //   e.target 变成浮层 → 补聚焦失效 → 用户表现为「点输入框没反应、只能刷新」。
                //   交给 InputFocusGuard：落点在输入框矩形内、命中的又不是合法控件时，
                //   强制把焦点抢回 textarea（见 input-focus-guard.js）。
                try {
                    if (window.InputFocusGuard && typeof window.InputFocusGuard.install === 'function') {
                        window.InputFocusGuard.install(document, {
                            userInput: userInput,
                            getBox: function () {
                                var boxEl = document.getElementById('inputBox') || userInput;
                                return boxEl.getBoundingClientRect();
                            }
                        });
                    }
                } catch (_) {}

                // 兜底 ③：Esc 关闭纯视觉性浮层（图片预览 / 变更 diff 弹窗）。
                //   这两个浮层不挂异步 Promise，直接收起是安全的；避免它们意外残留压住输入区。
                document.addEventListener('keydown', function (e) {
                    if (e.key !== 'Escape' && e.keyCode !== 27) return;
                    try {
                        var lb = document.getElementById('imgLightbox');
                        if (lb) lb.classList.remove('open');
                        var dm = document.getElementById('taskDiffModal');
                        if (dm && dm.parentNode) dm.parentNode.removeChild(dm);
                    } catch (_) {}
                }, true);
            })();

            // 多模态图片输入：按钮选择 / 粘贴 / 拖放到输入区
            const attachBtn = document.getElementById('attachImageBtn');
            const chatImageInput = document.getElementById('chatImageInput');
            if (attachBtn && chatImageInput) {
                attachBtn.addEventListener('click', () => chatImageInput.click());
                chatImageInput.addEventListener('change', function () {
                    Array.from(this.files || []).forEach(addChatImageFile);
                    this.value = '';
                });
            }
            userInput.addEventListener('paste', handleChatPaste);
            const inputPanelEl = document.querySelector('.input-panel');
            if (inputPanelEl) {
                inputPanelEl.addEventListener('dragover', (e) => {
                    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1) e.preventDefault();
                });
                inputPanelEl.addEventListener('drop', handleChatDrop);
            }
            renderAttachBar();

            // 图片点击放大预览（对话图片 / 附件缩略图）
            const lightbox = document.getElementById('imgLightbox');
            if (lightbox) {
                const lbImg = lightbox.querySelector('img');
                document.addEventListener('click', (e) => {
                    const t = e.target;
                    if (t && t.tagName === 'IMG' &&
                        (t.classList.contains('msg-image') || (t.closest && t.closest('.attach-chip')))) {
                        lbImg.src = t.src;
                        lightbox.classList.add('open');
                    }
                });
                lightbox.addEventListener('click', () => { lightbox.classList.remove('open'); lbImg.src = ''; });
            }

            // 速度拨盘
            document.getElementById('sdActivator').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('speedDial').classList.toggle('open');
                document.getElementById('langMenu').classList.remove('open');
                document.getElementById('moreMenu').classList.remove('open');
            });

            // ⇄ 对比：独立常驻按钮（位于 ⚙️ 菜单按钮正上方），点开文件差异对比
            const sdDiffBtn = document.getElementById('sdDiffBtn');
            if (sdDiffBtn) {
                sdDiffBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.getElementById('speedDial').classList.remove('open');
                    document.getElementById('langMenu').classList.remove('open');
                    document.getElementById('moreMenu').classList.remove('open');
                    if (sdDiffBtn.disabled) return;
                    try { pgpyOpenDiffFromSelection(); } catch (_) {}
                });
            }

            // 更多菜单（applyI18n 内构建）

            // 点击遮罩 / 关闭按钮关闭对话框
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                overlay.addEventListener('click', function(e) {
                    if (e.target === this) {
                        this.classList.remove('open');
                    }
                });
            });
            document.querySelectorAll('.modal-close').forEach(btn => {
                btn.addEventListener('click', function() {
                    const overlay = this.closest('.modal-overlay');
                    if (overlay) overlay.classList.remove('open');
                });
            });

            // 工具轨迹回放对话框：绑定工具栏 / 播放控制 / 键盘操作
            wireTraceDialog();

            // 可插拔工具注册表：绑定工具箱入口 + 管理面板（并恢复持久化的自定义工具）
            initToolRegistryUI();

            // ask_user 人机确认对话框：提交 / 取消 / 键盘操作 / 遮罩点击
            (function wireAskUserModal() {
                const askOverlay = document.getElementById('askUserModal');
                if (!askOverlay) return;
                const askSubmitBtn = document.getElementById('askUserSubmit');
                const askCancelBtn = document.getElementById('askUserCancel');
                const askCloseBtn = document.getElementById('askUserClose');
                const askTextEl = document.getElementById('askUserText');
                if (askSubmitBtn) askSubmitBtn.addEventListener('click', () => askUserStore.submit());
                if (askCancelBtn) askCancelBtn.addEventListener('click', () => askUserStore.cancel());
                if (askCloseBtn) askCloseBtn.addEventListener('click', () => askUserStore.cancel());
                // 点击遮罩空白处 = 取消（注意仅当点的是遮罩本身）
                askOverlay.addEventListener('click', (e) => { if (e.target === askOverlay) askUserStore.cancel(); });
                if (askTextEl) askTextEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askUserStore.submit(); }
                    else if (e.key === 'Escape') { e.preventDefault(); askUserStore.cancel(); }
                });
            })();


            document.getElementById('historyDownloadAll').addEventListener('click', () => historyStore.downloadHistory());
            document.getElementById('historyClearAll').addEventListener('click', () => { historyStore.resetState();
                renderHistory(); });

            document.getElementById('configOkBtn').addEventListener('click', saveConfigDialog);
            // 「🔁 从文件刷新」：改完应用目录 config/interface.json 后点此回读生效
            const configReloadBtn = document.getElementById('configReloadBtn');
            if (configReloadBtn) configReloadBtn.addEventListener('click', reloadConfigFromFile);
            document.getElementById('apiKeyEye').addEventListener('click', function() {
                settingStore.apiKeyShow = !settingStore.apiKeyShow;
                document.getElementById('apiKeyInput').type = settingStore.apiKeyShow ? 'text' : 'password';
            });
            document.getElementById('configReset').addEventListener('click', () => { chatbotStore.resetState();
                loadConfigDialog(); });
            document.getElementById('panelEndpoint').querySelector('.panel-header').addEventListener('click', () =>
                document.getElementById('panelEndpoint').classList.toggle('open'));
            document.getElementById('panelAdvanced').querySelector('.panel-header').addEventListener('click', () =>
                document.getElementById('panelAdvanced').classList.toggle('open'));
            document.getElementById('configFileBtn').addEventListener('click', () =>
                document.getElementById('configFile').click());
            document.getElementById('configFile').addEventListener('change', function() {
                const file = this.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const json = JSON.parse(event.target.result);
                        chatbotStore.updateStoreFromJSON(json.chatbotStore);
                        defaultChoiceStore.updateStoreFromJSON(json.defaultChoiceStore);
                        loadConfigDialog();
                        snackbarStore.showSuccessMessage('Config imported');
                    } catch (e) {
                        snackbarStore.showErrorMessage('$vuetify.dataIterator.snackbar.parseConfigFail');
                    }
                };
                reader.readAsText(file);
                this.value = '';
            });

            document.getElementById('agentReset').addEventListener('click', () => { agentStore.initAgent();
                renderAgentBoard(); });
            document.getElementById('editCardSave').addEventListener('click', () => {
                if (agentStore.card) {
                    agentStore.card.title = document.getElementById('editCardTitle').value;
                    agentStore.card.description = document.getElementById('editCardDesc').value;
                }
                agentStore.saveCard();
            });
            document.getElementById('editCardCancel').addEventListener('click', () => {
                agentStore.editDialog = false;
                document.getElementById('editCardModal').classList.remove('open');
            });
            document.getElementById('editCardRefFile').addEventListener('change', function() {
                const file = this.files[0];
                if (!file) return;
                const reader = new FileReader();
                if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
                    if (window.mammoth) {
                        reader.onload = (event) => {
                            mammoth.extractRawText({ arrayBuffer: event.target.result })
                                .then(result => {
                                    agentStore.card.refText = result.value;
                                    document.getElementById('editCardRefText').textContent = agentStore.card.refText;
                                })
                                .catch(error => console.error(error));
                        };
                        reader.readAsArrayBuffer(file);
                    } else {
                        reader.onload = (event) => {
                            agentStore.card.refText = event.target.result;
                            document.getElementById('editCardRefText').textContent = agentStore.card.refText;
                        };
                        reader.readAsText(file);
                    }
                } else if (file.name && file.name.length > 0) {
                    reader.onload = (event) => {
                        agentStore.card.refText = event.target.result;
                        document.getElementById('editCardRefText').textContent = agentStore.card.refText;
                    };
                    reader.readAsText(file);
                }
            });

            document.getElementById('promptSearch').addEventListener('input', renderPromptList);
            document.getElementById('promptSheetGet').addEventListener('click', async () => {
                const fetched = promptStore.fetchSelect();
                await messageStore.applyPrompt(fetched);
                document.getElementById('promptSheetModal').classList.remove('open');
            });

            document.getElementById('toolboxButton').addEventListener('click', () => {
                settingStore.toolboxShow = true;
                document.getElementById('toolboxButton').style.display = 'none';
                document.getElementById('toolbox').style.display = '';
            });
            document.getElementById('toolboxCloseBtn').addEventListener('click', () => {
                settingStore.toolboxShow = false;
                document.getElementById('toolboxButton').style.display = '';
                document.getElementById('toolbox').style.display = 'none';
            });
            document.getElementById('refreshToolsBtn').addEventListener('click', async () => {
                prefixManager.invalidateTools();
                if (externalMcpManager.connectedCount > 0) {
                    try { await externalMcpManager.refreshAll(); } catch (e) {
                        snackbarStore.showErrorMessage('刷新外部 MCP 工具失败：' + (e && e.message ? e.message : e));
                    }
                }
                snackbarStore.showInfoMessage('工具列表已刷新（下一轮前缀缓存 miss 一次）');
            });

            document.getElementById('resetAllBtn').addEventListener('click', () => {
                resetALL();
                document.getElementById('toolboxButton').style.display = '';
                document.getElementById('toolbox').style.display = 'none';
                messageStore.conversation = [];
                renderConversation();
                snackbarStore.showSuccessMessage('All configs reset');
            });

            // 点击页面空白处关闭浮层菜单
            document.addEventListener('click', (e) => {
                const target = e.target;
                if (!(target && target.closest && target.closest('#speedDial, #sdActivator, #langMenu'))) {
                    document.getElementById('speedDial').classList.remove('open');
                    document.getElementById('langMenu').classList.remove('open');
                }
                if (!(target && target.closest && target.closest('#moreMenu, #moreBtn'))) {
                    document.getElementById('moreMenu').classList.remove('open');
                }
            });

            renderConversation();
            resizeAvatar();
            window.onresize = () => resizeAvatar();
            resizeInputBox();

            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => { settingStore.fontStatus = true; });
            }

            window.__messageStore = messageStore;
            window.__chatbotStore = chatbotStore;
            window.__historyStore = historyStore;
            window.__subagentStore = subagentStore;
            window.__settingStore = settingStore;
            window.__mcpStore = mcpStore;
            window.__agentStore = agentStore;
            window.__externalMcp = externalMcpManager;

            // 若已配置外部 MCP Server（浏览器外执行），页面加载后自动连接并拉取工具
            // 支持多个 Server：chatbotStore.mcpUrls 为 URL 数组
            if (Array.isArray(chatbotStore.mcpUrls) && chatbotStore.mcpUrls.length > 0) {
                externalMcpManager.connectAll(chatbotStore.mcpUrls);
            }
            // MCP ssh 服务：配置了 SSH 主机则注册 ssh-mcp（7 个 ssh_* 工具）
            try { sshMcpSync(); } catch (_) { /* 07-mcp.js 未加载 */ }
            // MCP 数据库服务：外壳可用则注册 db-mcp（内置 PostgreSQL 的 6 个 db_* 工具）
            try { dbMcpSync(); } catch (_) { /* 07-mcp.js / db-mcp-core.js 未加载 */ }

        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }
