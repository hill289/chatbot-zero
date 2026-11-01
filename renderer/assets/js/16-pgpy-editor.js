        // ══════════════════════════════════════════════════════════════
        //  Examples
        // ══════════════════════════════════════════════════════════════
        const pgpyNodeExamples = {
          1: `const os = require('os');\nconsole.log("Hello, Node.js!");\nconsole.log("Running in your browser via almostnode.");\nconsole.log("Node", process.versions.node, "on", os.platform());`,
          2: `function fibonacci(n) {\n  let a = 0, b = 1;\n  const result = [];\n  for (let i = 0; i < n; i++) {\n    result.push(a);\n    [a, b] = [b, a + b];\n  }\n  return result;\n}\n\nconsole.log("First 20 Fibonacci numbers:");\nconsole.log(fibonacci(20));`,
          3: `const squares = Array.from({ length: 10 }, (_, i) => (i + 1) ** 2);\nconsole.log("Squares of 1-10:", squares);\n\nconst evens = Array.from({ length: 20 }, (_, i) => i + 1).filter(x => x % 2 === 0);\nconsole.log("Even numbers 1-20:", evens);\n\nconst words = ["hello", "world", "almostnode"];\nconsole.log("Uppercase:", words.map(w => w.toUpperCase()));`,
          4: `const path = require('path');\nconst fs = require('fs');\nfs.mkdirSync('/home/pyodide/demo', { recursive: true });\nfs.writeFileSync('/home/pyodide/demo/hello.txt', 'Hello from almostnode!\n');\n\nconsole.log('Node version:', process.versions.node);\nconsole.log('Platform:', process.platform);\nconsole.log('Path:', path.join('/home/pyodide', 'demo', 'hello.txt'));\nconsole.log('Size:', fs.statSync('/home/pyodide/demo/hello.txt').size, 'bytes');\nconsole.log('Content:\n' + fs.readFileSync('/home/pyodide/demo/hello.txt', 'utf8'));`
        };

        function loadExample(n) {
          if (pgpyEditor) {
            const examples = pgpyNodeExamples;
            pgpyEditor.setValue(examples[n] || '');
            pgpyEditor.focus();
            // 载入示例代码与文件编辑无关,解除 Save File 的文件关联
            pgpyClearCurrentFile();
          }
        }

        // ══════════════════════════════════════════════════════════════
        //  History (localStorage)
        // ══════════════════════════════════════════════════════════════
        const PGPY_HISTORY_KEY = 'almostnode_script_history';
        const PGPY_MAX_HISTORY = 50;

        function pgpyGetHistoryKey() { return PGPY_HISTORY_KEY; }

        function pgpyGetHistory() {
          try { return JSON.parse(localStorage.getItem(pgpyGetHistoryKey()) || '[]'); } catch { return []; }
        }

        function pgpySaveHistory(list) {
          try { localStorage.setItem(pgpyGetHistoryKey(), JSON.stringify(list.slice(0, PGPY_MAX_HISTORY))); } catch {}
        }

        function addToHistory(script) {
          if (!script || !script.trim()) return;
          const list = pgpyGetHistory();
          if (list[0] === script) return;
          list.unshift(script);
          pgpySaveHistory(list);
          updateHistoryBadge();
        }

        function updateHistoryBadge() {
          const badge = document.getElementById('historyBadge');
          if (!badge) return;
          const count = pgpyGetHistory().length;
          badge.textContent = count;
          badge.style.display = count > 0 ? '' : 'none';
        }

        function showHistory() {
          const modal = document.getElementById('pgpyHistoryModal');
          const body = document.getElementById('pgpyHistoryBody');
          const countEl = document.getElementById('pgpyHistoryCount');
          if (!modal || !body) return;
          const list = pgpyGetHistory();
          const label = 'script';
          countEl.textContent = list.length + ' ' + label + (list.length === 1 ? 'y' : 'ies');
          if (list.length === 0) {
            body.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">No history yet</div>';
          } else {
            body.innerHTML = list.map((script, i) =>
              '<div class="pgpy-history-item" onclick="pgpyPickHistory(' + i + ')">' +
                '<div class="pgpy-idx">#' + (i + 1) + '</div>' +
                '<pre>' + pgpyEscapeHtml(script) + '</pre>' +
                '<button class="pgpy-delete-btn" onclick="event.stopPropagation();pgpyDeleteHistory(' + i + ')" title="Delete">✕</button>' +
              '</div>'
            ).join('');
          }
          modal.classList.remove('pgpy-hidden');
        }

        function hideHistory() {
          const modal = document.getElementById('pgpyHistoryModal');
          if (modal) modal.classList.add('pgpy-hidden');
        }

        function pgpyPickHistory(index) {
          const list = pgpyGetHistory();
          if (list[index] && pgpyEditor) {
            pgpyEditor.setValue(list[index]);
            pgpyEditor.focus();
            // 载入历史脚本与文件编辑无关,解除 Save File 的文件关联
            pgpyClearCurrentFile();
          }
          hideHistory();
        }

        function pgpyDeleteHistory(index) {
          const list = pgpyGetHistory();
          list.splice(index, 1);
          pgpySaveHistory(list);
          showHistory();
          updateHistoryBadge();
        }

        function clearHistory() {
          const label = 'Node.js script';
          if (!confirm('Clear all ' + label + ' history? This cannot be undone.')) return;
          pgpySaveHistory([]);
          showHistory();
          updateHistoryBadge();
        }

        // Close modal on overlay click
        document.addEventListener('click', function(e) {
          const modal = document.getElementById('pgpyHistoryModal');
          if (modal && e.target === modal) hideHistory();
        });
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') hideHistory();
        });

        // ══════════════════════════════════════════════════════════════
        //  Node Mode Only
        // ══════════════════════════════════════════════════════════════
        function pgpyUpdateExamples() {
          const group = document.getElementById('exampleGroup');
          if (!group) return;
          const examples = pgpyNodeExamples;
          const count = Object.keys(examples).length;
          const labels = ['Hello World', 'Fibonacci', 'Array Ops', 'File & Process'];
          group.innerHTML = '';
          for (let i = 1; i <= count; i++) {
            const btn = document.createElement('button');
            btn.className = 'pgpy-btn';
            btn.textContent = labels[i - 1] || ('Example ' + i);
            btn.onclick = function() { loadExample(i); };
            group.appendChild(btn);
          }
        }

        function runCurrent() {
          if (pgpyAiMode) {
            pgpyAiRun();
          } else {
            runNode();
          }
        }

        async function pgpyAiRun() {
          const content = pgpyEditor ? pgpyEditor.getValue().trim() : '';
          if (!content) return;

          const runBtn = document.getElementById('runBtn');
          if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '⏳ <span class="pgpy-label-text">AI Thinking...</span>'; }

          try {
            const ms = window.__messageStore;
            if (!ms) { alert('Chat system not ready yet.'); return; }

            // sendMessage 直接从输入框取值，需先写入输入框并触发 input 事件（同步 userMessage 与按钮状态）
            const inputEl = document.getElementById('userInput');
            inputEl.value = content;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            ms.sendMessage();

            setTimeout(() => {
              const chatBot = document.querySelector('.chat-bot');
              if (chatBot) {
                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
              }
            }, 500);

          } catch (err) {
            console.error('AI Run error:', err);
          } finally {
            if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '▶ <span class="pgpy-label-text">Run</span>'; }
          }
        }

        // ══════════════════════════════════════════════════════════════
        //  Editor Setup
        // ══════════════════════════════════════════════════════════════
        function pgpyInitEditor() {
          const container = document.getElementById('pgpyEditorContainer');
          if (!container || pgpyEditor) return;

          pgpyEditor = CodeMirror(container, {
            value: `const os = require('os');\nconsole.log(\"Hello, Node.js!\");\nconsole.log(\"Node\", process.versions.node, \"on\", os.platform());`,
            mode: 'javascript',
            theme: 'material-darker',
            lineNumbers: true,
            lineWrapping: true,
            tabSize: 4,
            indentWithTabs: false,
            matchBrackets: true,
            autoCloseBrackets: true,
            placeholder: 'Enter Node.js code...',
            extraKeys: {
              'Ctrl-Enter': function() { runCurrent(); },
              'Cmd-Enter': function() { runCurrent(); },
            }
          });

          pgpyEditor.on('inputRead', function(cm, change) {
            if (change.origin === '+input' && /^[a-z._]$/i.test(change.text[0])) {
              cm.showHint({ completeSingle: false });
            }
          });

          // ── LSP（tsserver）诊断接入：把编辑器交给语言服务客户端 ──
          //   attach 内部会懒加载 TypeScript 引擎（./lsp/typescript.js + ./lsp/ts-libs.js），
          //   并订阅 textDocument/publishDiagnostics，在 gutter / 波浪下划线 / 悬浮框中反馈诊断。
          try { if (window.PgpLsp) window.PgpLsp.attach(pgpyEditor); } catch (err) { console.warn("[pgpy-lsp] attach failed:", err); }

          // Resize handle (mouse + touch)
          //   性能优化：
          //   - 只在拖拽期间注册 move/up 监听（旧实现把 mousemove 永久挂在 document 上，
          //     全页每次移动都会触发回调）；
          //   - 用 requestAnimationFrame 合并同一帧内的多次移动，避免逐次触发重排/重绘；
          //   - CodeMirror.refresh() 开销很大，旧实现每个 mousemove 都调用 → 拖拽卡顿，
          //     改为高度变化时只写样式，拖拽结束后统一刷新一次。
          const handle = document.getElementById('pgpyResizeHandle');
          const editorPanel = document.getElementById('pgpyEditorPanel');
          if (handle && editorPanel) {
            let startY, startH, dragging = false;
            let rafId = 0, pendingY = 0;

            function getClientY(e) {
              return e.touches ? e.touches[0].clientY : e.clientY;
            }

            function applySize() {
              rafId = 0;
              if (!dragging) return;
              const dy = pendingY - startY;
              const newH = Math.max(100, Math.min(startH + dy, window.innerHeight - 200));
              editorPanel.style.flex = 'none';
              editorPanel.style.height = newH + 'px';
            }

            function onStart(e) {
              e.preventDefault();
              dragging = true;
              startY = getClientY(e);
              startH = editorPanel.offsetHeight;
              pendingY = startY;
              handle.classList.add('pgpy-active');
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
              // 仅在拖拽期间监听（passive:false 才能 preventDefault）
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onEnd);
              document.addEventListener('touchmove', onMove, { passive: false });
              document.addEventListener('touchend', onEnd);
            }

            function onMove(e) {
              if (!dragging) return;
              if (e.cancelable) e.preventDefault();
              // 只记录最新位置，合并到下一帧统一写入
              pendingY = getClientY(e);
              if (rafId) return;
              rafId = requestAnimationFrame(applySize);
            }

            function onEnd() {
              if (!dragging) return;
              dragging = false;
              if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
              handle.classList.remove('pgpy-active');
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onEnd);
              document.removeEventListener('touchmove', onMove);
              document.removeEventListener('touchend', onEnd);
              // 高度变化不影响折行，只需在结束时刷新一次测量
              if (pgpyEditor) pgpyEditor.refresh();
            }

            handle.addEventListener('mousedown', onStart);
            handle.addEventListener('touchstart', onStart, { passive: false });
          }


          updateHistoryBadge();
          pgpyUpdateSyncButton();
        }

        function pgpyUpdateRunButton() {
          const runBtn = document.getElementById('runBtn');
          if (!runBtn) return;
          runBtn.disabled = !nodeRuntime.ready;
        }

        async function clearEditor() {
          // 若表格中已勾选文件,则删除选中的文件(编辑器内容保留)
          if (pgpySelectedFiles.size > 0) {
            await pgpyDeleteSelectedFiles();
            return;
          }
          if (pgpyEditor) pgpyEditor.setValue('');
          // 清空编辑器/工作区后不再关联任何文件
          pgpyCurrentFilePath = null;
          pgpyCurrentFileFromBinary = false;
          pgpyUpdateSaveButton();
          if (nodeRuntime.ready) {
            const FS = nodeRuntime.FS;
            try {
              FS.mkdirTree('/home/pyodide');
              (function removeRecursive(path) {
                const entries = FS.readdir(path);
                for (const entry of entries) {
                  if (entry === '.' || entry === '..') continue;
                  const full = path === '/' ? '/' + entry : path + '/' + entry;
                  const stat = FS.stat(full);
                  if (FS.isDir(stat.mode)) { removeRecursive(full); FS.rmdir(full); }
                  else { FS.unlink(full); }
                }
              })('/home/pyodide');
            } catch (err) {
              console.warn('[pgpy] 清理文件系统失败:', err);
            }
            // 工作区已清空 → 一并清空「待同步」队列：否则刚被清掉的文件会以「🗑 待删除」幽灵行
            // 残留在列表里，且再次点击本按钮（未勾选任何文件）也无从清除。
            pgpyPendingSync = {};
            pgpySavePendingSync();
            pgpyUpdateSyncButton();
            try { pgpyBaselineDeleteAll(); } catch (_) {} // 工作区已空 → 一并清除差异基线
            try { await pgpySyncMount(false); }
            catch (err) { console.warn('[pgpy] 同步失败,文件仅保存在内存:', err); }
            listNodeFiles();
          }
        }

        function pgpyClearResults() {
          const tb = document.getElementById('pgpyResultsToolbar');
          const empty = document.getElementById('pgpyResultsEmpty');
          const wrap = document.getElementById('pgpyTableWrapper');
          const msg = document.getElementById('pgpyResultsMessage');
          if (tb) tb.style.display = 'none';
          if (empty) empty.style.display = '';
          if (wrap) wrap.style.display = 'none';
          if (msg) msg.style.display = 'none';
          pgpyLastResult = null;
        }

        // ══════════════════════════════════════════════════════════════
        //  Run Node.js (almostnode)
        // ══════════════════════════════════════════════════════════════
        async function runNode() {
          if (!nodeRuntime.ready) return;
          const code = pgpyEditor ? pgpyEditor.getValue().trim() : '';
          if (!code) return;

          addToHistory(code);
          const runBtn = document.getElementById('runBtn');
          if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '⏳ <span class="pgpy-label-text">Running...</span>'; }

          const pgpyStatus = document.getElementById('pgpyStatus');
          const startTime = performance.now();

          try {
            const { logs, exports, error } = await nodeRuntime.executeAsync(code);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);

            let stdout = '', stderr = '';
            for (const l of logs) {
              if (l.stream === 'stderr') stderr += (stderr ? '\n' : '') + l.text;
              else stdout += (stdout ? '\n' : '') + l.text;
            }

            if (error || stderr) {
              const emsg = error ? ((error && error.message) ? error.message : String(error)) : '';
              const combined = [stdout, stderr, emsg].filter(Boolean).join('\n');
              if (pgpyStatus) {
                pgpyStatus.className = 'pgpy-status-badge pgpy-error';
                pgpyStatus.textContent = '❌ Error (' + elapsed + 's)';
              }
              pgpyRenderOutput(combined || 'Error', true, elapsed);
              return;
            }

            let output = '';
            if (stdout) output += stdout;
            if (!output && exports !== undefined && exports !== null) {
              const exp = safeStringify(exports);
              if (exp && exp !== '{}') output = 'module.exports = ' + exp;
            }
            if (!output) output = '(no output)';

            if (pgpyStatus) {
              pgpyStatus.className = 'pgpy-status-badge pgpy-success';
              pgpyStatus.textContent = '✅ Done (' + elapsed + 's)';
              setTimeout(() => { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '✅ Ready'; }, 2000);
            }
            pgpyRenderOutput(output, false, elapsed);
          } catch (err) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
            let errMsg = (err && err.message) ? err.message : String(err);
            errMsg = String(errMsg).replace(/^Error:\s*/, '');
            if (pgpyStatus) {
              pgpyStatus.className = 'pgpy-status-badge pgpy-error';
              pgpyStatus.textContent = '❌ Error (' + elapsed + 's)';
            }
            pgpyRenderOutput(errMsg, true, elapsed);
          } finally {
            if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '▶ <span class="pgpy-label-text">Run</span>'; }
          }
        }

        // ══════════════════════════════════════════════════════════════
        //  Rendering
        // ══════════════════════════════════════════════════════════════
        function pgpyRenderOutput(text, isError, elapsed) {
          const tb = document.getElementById('pgpyResultsToolbar');
          const empty = document.getElementById('pgpyResultsEmpty');
          const msg = document.getElementById('pgpyResultsMessage');
          const wrap = document.getElementById('pgpyTableWrapper');
          const rowCount = document.getElementById('pgpyRowCount');
          const timing = document.getElementById('pgpyTiming');

          if (tb) tb.style.display = '';
          if (empty) empty.style.display = 'none';
          if (msg) { msg.style.display = ''; msg.textContent = text; msg.className = 'pgpy-results-message' + (isError ? ' pgpy-error' : ''); }
          if (wrap) wrap.style.display = 'none';
          if (rowCount) rowCount.textContent = isError ? 'Error' : 'Success';
          if (timing && elapsed) timing.textContent = '⏱ ' + elapsed + 's';
        }

        function pgpyRenderTable(columns, rows, elapsed, isFileList) {
          pgpyLastResult = { columns, rows, rowCount: rows.length, time: elapsed + 's', isFileList: !!isFileList };
          // 新结果列集变化时，丢弃上一轮已失效的排序列，避免残留箭头/排序状态
          if (pgpySortState.col && columns.indexOf(pgpySortState.col) === -1) { pgpySortState.col = null; pgpySortState.asc = true; }
          // 若存在生效的排序列，则重渲染时保持该排序（表头箭头与行顺序始终一致）
          if (pgpySortState.col) {
            rows = [...rows].sort(pgpyCompareRows(pgpySortState.col, pgpySortState.asc));
            pgpyLastResult.rows = rows;
          }

          const tb = document.getElementById('pgpyResultsToolbar');
          const empty = document.getElementById('pgpyResultsEmpty');
          const wrap = document.getElementById('pgpyTableWrapper');
          const msg = document.getElementById('pgpyResultsMessage');
          const rowCount = document.getElementById('pgpyRowCount');
          const timing = document.getElementById('pgpyTiming');

          if (tb) tb.style.display = '';
          if (empty) empty.style.display = 'none';
          if (wrap) wrap.style.display = '';
          if (msg) msg.style.display = 'none';
          if (rowCount) rowCount.textContent = rows.length + ' row' + (rows.length !== 1 ? 's' : '');
          if (timing) timing.textContent = '⏱ ' + elapsed + 's';

          pgpyRenderTableHead(columns, isFileList);
          pgpyRenderTableBody(columns, rows);
        }

        // 表头渲染：可排序列带 onclick + 排序方向箭头，勾选/删除列不可排序。
        function pgpyRenderTableHead(columns, isFileList) {
          const thead = document.getElementById('pgpyResultsHead');
          if (!thead) return;
          const checkHead = isFileList ? '<th class="pgpy-nosort" style="width:34px;padding:0 6px;text-align:center;"><input type="checkbox" id="pgpyCheckAll" title="全选"></th>' : '';
          const actionHead = isFileList ? '<th class="pgpy-row-actions pgpy-nosort" style="text-align:center;" title="删除操作">删除</th>' : '';
          thead.innerHTML = '<tr>' + checkHead + columns.map(c => {
            const isSorted = pgpySortState.col === c;
            const arrow = isSorted ? (pgpySortState.asc ? ' ▲' : ' ▼') : '';
            const cls = 'pgpy-sortable-th' + (isSorted ? ' pgpy-sorted' : '');
            return '<th class="' + cls + '" data-col="' + pgpyEscapeAttr(c) + '" onclick="pgpySortTable(\'' + pgpyEscapeAttr(c) + '\')" title="点击按「' + pgpyEscapeHtml(c) + '」排序">' + pgpyEscapeHtml(c) + arrow + '</th>';
          }).join('') + actionHead + '</tr>';
        }

        function pgpyRenderTableBody(columns, rows) {
          const tbody = document.getElementById('pgpyResultsBody');
          if (!tbody) return;
          const isFileList = !!(pgpyLastResult && pgpyLastResult.isFileList);
          const isNumeric = {};
          for (const col of columns) {
            const sample = rows.slice(0, 20).map(r => r[col]).filter(v => v !== null && v !== undefined);
            isNumeric[col] = sample.length > 0 && sample.every(v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)));
          }
          const pendingKind = isFileList ? pgpyPendingKindMap() : {};
          tbody.innerHTML = rows.map((row, i) => {
            const isDir = isFileList && row.type && String(row.type).indexOf('dir') !== -1;
            const pk = isFileList ? pendingKind[pgpyNormalizeVPath(String(row.name))] : '';
            const pendingCls = pk === 'write' ? ' pgpy-pending-write' : (pk === 'delete' ? ' pgpy-pending-delete' : '');
            const checkCell = isFileList ? '<td style="text-align:center;"><input type="checkbox" class="pgpy-file-check" data-path="' + pgpyEscapeAttr(String(row.name)) + '"' + (pgpySelectedFiles.has(row.name) ? ' checked' : '') + '></td>' : '';
            const actionCell = isFileList ? '<td class="pgpy-row-actions" style="text-align:center;white-space:nowrap;"><button type="button" class="pgpy-file-del" data-path="' + pgpyEscapeAttr(String(row.name)) + '" title="删除">🗑</button></td>' : '';
            return '<tr' + (isFileList ? ' class="pgpy-file-row' + pendingCls + '" data-index="' + i + '" data-path="' + pgpyEscapeAttr(String(row.name)) + '"' : '') + '>' + checkCell + columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return '<td class="pgpy-null">NULL</td>';
              const cls = isNumeric[col] ? ' class="pgpy-num"' : '';
              const isOffice = isFileList && !isDir && typeof OFFICE_EDITORS !== 'undefined' && OFFICE_EDITORS[String(row.name).toLowerCase().split('.').pop()];
              const mediaKind = (isFileList && !isDir && !isOffice) ? previewKind(String(row.name)) : '';
              const hint = isOffice ? '\n↗ 双击打开 Office 编辑器(浏览/编辑/保存)'
                : mediaKind === 'pdf' ? '\n↗ 双击浏览 PDF'
                : mediaKind === 'image' ? '\n↗ 双击查看图片'
                : mediaKind === 'video' ? '\n↗ 双击播放视频'
                : ((isFileList && !isDir) ? '\n↗ 双击在编辑器中打开' : '');
              // 「name」列仅做展示：有真实磁盘映射显示真路径，否则显示去掉 /home/pyodide 的相对路径。
              // data-path / 勾选 / 双击仍用原始虚拟路径 row.name，读写行为不变。
              const dispVal = (isFileList && col === 'name') ? pgpyDisplayPath(String(val)) : String(val);
              let cellInner = pgpyEscapeHtml(dispVal);
              // 有待同步改动的文件：在名称后附一个「⇄ 对比」入口（比较 AI 修改前后）
              if (isFileList && col === 'name' && pk) {
                cellInner += ' <button type="button" class="pgpy-diff-link" data-path="' + pgpyEscapeAttr(String(row.name)) + '" title="⇄ 比较 AI 修改前后的差异">⇄ 对比</button>';
              }
              return '<td' + cls + ' title="' + pgpyEscapeAttr(dispVal) + hint + '">' + cellInner + '</td>';
            }).join('') + actionCell + '</tr>';
          }).join('');

        }

        function pgpyRenderMessage(msg, isError, elapsed) {
          const tb = document.getElementById('pgpyResultsToolbar');
          const empty = document.getElementById('pgpyResultsEmpty');
          const wrap = document.getElementById('pgpyTableWrapper');
          const msgEl = document.getElementById('pgpyResultsMessage');
          const rowCount = document.getElementById('pgpyRowCount');
          const timing = document.getElementById('pgpyTiming');

          if (tb) tb.style.display = '';
          if (empty) empty.style.display = 'none';
          if (wrap) wrap.style.display = 'none';
          if (msgEl) { msgEl.style.display = ''; msgEl.textContent = msg; msgEl.className = 'pgpy-results-message' + (isError ? ' pgpy-error' : ''); }
          if (rowCount) rowCount.textContent = isError ? 'Error' : 'OK';
          if (timing && elapsed) timing.textContent = '⏱ ' + elapsed + 's';
        }

        // ══════════════════════════════════════════════════════════════
        //  Sort Table
        // ══════════════════════════════════════════════════════════════
        // 排序键：数字按数值比较；"1.2 KB / 512 B / 3 MB" 这类带单位体积归一到字节；其余按字符串。
        function pgpySortKey(v) {
          if (v === null || v === undefined) return { num: null, str: '', empty: true };
          if (typeof v === 'number') return { num: v, str: String(v), empty: false };
          if (typeof v === 'boolean') return { num: v ? 1 : 0, str: String(v), empty: false };
          const s = String(v).trim();
          if (s === '') return { num: null, str: '', empty: true };
          const unit = s.match(/^(-?\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
          if (unit) {
            const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 }[unit[2].toUpperCase()] || 1;
            return { num: parseFloat(unit[1]) * mult, str: s, empty: false };
          }
          if (/^-?\d+(?:\.\d+)?$/.test(s)) return { num: parseFloat(s), str: s, empty: false };
          return { num: null, str: s, empty: false };
        }

        // 生成某一列的升/降序比较器（列头点击与结果重渲染共用，保证排序状态一致）
        function pgpyCompareRows(col, asc) {
          const dir = asc ? 1 : -1;
          return (a, b) => {
            const ka = pgpySortKey(a[col]), kb = pgpySortKey(b[col]);
            if (ka.empty && kb.empty) return 0;
            if (ka.empty) return 1;   // 空值恒排在最后
            if (kb.empty) return -1;
            if (ka.num !== null && kb.num !== null) return (ka.num - kb.num) * dir;
            return ka.str.localeCompare(kb.str, undefined, { numeric: true, sensitivity: 'base' }) * dir;
          };
        }

        function pgpySortTable(col) {
          if (!pgpyLastResult) return;
          const { columns, rows } = pgpyLastResult;
          if (pgpySortState.col === col) {
            pgpySortState.asc = !pgpySortState.asc;
          } else {
            pgpySortState.col = col;
            pgpySortState.asc = true;
          }
          const sorted = [...rows].sort(pgpyCompareRows(col, pgpySortState.asc));
          pgpyLastResult.rows = sorted; // 保持 rows 与展示顺序一致(供双击行查找)
          pgpyRenderTableHead(columns, !!pgpyLastResult.isFileList); // 刷新表头排序箭头
          pgpyRenderTableBody(columns, sorted);
        }

        // ══════════════════════════════════════════════════════════════
        //  almostnode FS ZIP helpers
        // ══════════════════════════════════════════════════════════════
        async function pgpyDownloadFSAsZip(targetPath, filename) {
          if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded!');
          if (!nodeRuntime.ready) throw new Error('Node runtime not ready');
          const zip = new JSZip();
          const FS = nodeRuntime.FS;
          function processDir(path, zipFolder) {
            const entries = FS.readdir(path);
            for (const entry of entries) {
              if (entry === '.' || entry === '..') continue;
              const full = path === '/' ? '/' + entry : path + '/' + entry;
              const stat = FS.stat(full);
              if (FS.isDir(stat.mode)) { processDir(full, zipFolder.folder(entry)); }
              else if (FS.isFile(stat.mode)) { zipFolder.file(entry, FS.readFile(full, { encoding: 'binary' })); }
            }
          }
          try { FS.mkdirTree(targetPath); } catch (_) {}
          try { processDir(targetPath, zip); } catch (e) { console.warn('ZIP warning:', e); }
          const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = filename;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }

        async function pgpyExtractZipToFS(zipData, targetPath) {
          if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded!');
          if (!nodeRuntime.ready) throw new Error('Node runtime not ready');
          const FS = nodeRuntime.FS;
          targetPath = targetPath.replace(/\/+$/, '') || '/';
          const zip = await JSZip.loadAsync(zipData);
          for (const [name, entry] of Object.entries(zip.files)) {
            let full = targetPath + '/' + name;
            if (entry.dir) { try { FS.mkdirTree(full); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
            else {
              const idx = full.lastIndexOf('/');
              if (idx > 0) { try { FS.mkdirTree(full.substring(0, idx)); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
              FS.writeFile(full, await entry.async('uint8array'));
            }
          }
        }

        function pgpyFormatMtime(stat) {
          let mtime = stat.mtime;
          if (!mtime) return '-';
          try {
            const d = typeof mtime === 'number' || typeof mtime === 'bigint' ? new Date(Number(mtime)) :
                      typeof mtime === 'object' && mtime.getTime ? new Date(mtime.getTime()) :
                      new Date(mtime);
            if (isNaN(d.getTime())) return '-';
            const pad = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' +
                   pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
          } catch (_) { return '-'; }
        }

        function listNodeFiles() {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }

          const startTime = performance.now();
          const FS = nodeRuntime.FS;
          const entries = [];
          function walkDir(path) {
            try {
              const items = FS.readdir(path);
              for (const item of items) {
                if (item === '.' || item === '..') continue;
                if (item === 'default.profraw') continue;
                // 跳过工具运行期内部目录（如 .spill）：不在文件树里显示成「项目垃圾」
                if (typeof pgpyIsInternalName === 'function' && pgpyIsInternalName(item)) continue;
                const full = path.endsWith('/') ? path + item : path + '/' + item;
                try {
                  const stat = FS.stat(full);
                  if (FS.isDir(stat.mode)) {
                    entries.push({ name: full, type: '📁 dir', size: '-', modified: pgpyFormatMtime(stat) });
                    walkDir(full);
                  } else if (FS.isFile(stat.mode)) {
                    const sz = stat.size;
                    entries.push({ name: full, type: '📄 file', size: sz >= 1024 ? (sz/1024).toFixed(1)+' KB' : sz+' B', modified: pgpyFormatMtime(stat) });
                  }
                } catch (e) {
                  entries.push({ name: full, type: '⚠️ error', size: e.message || String(e), modified: '-' });
                }
              }
            } catch (e) {}
          }
          try { FS.mkdirTree('/home/pyodide'); } catch (_) {}
          walkDir('/home/pyodide');
          // 待同步删除的文件/目录已从 vfs 移除，列表里补一条「幽灵行」，使其仍可勾选、进而同步删除
          try {
            const present = new Set(entries.map(e => pgpyNormalizeVPath(String(e.name))));
            for (const real of Object.keys(pgpyPendingSync)) {
              const op = pgpyPendingSync[real];
              if (!op || op.kind !== 'delete' || !op.vPath) continue;
              const vp = pgpyNormalizeVPath(op.vPath);
              if (present.has(vp)) continue;
              present.add(vp);
              entries.push({ name: vp, type: '🗑 待删除', size: '-', modified: '-' });
            }
          } catch (_) {}
          const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);

          if (entries.length === 0) {
            pgpyRenderOutput('📂 工作区为空。\n导入 ZIP 或运行 Node.js 代码创建文件后再次查看。', false, elapsed);
          } else {
            // Query Results 不再展示 file_content 列（双击行会在 CodeMirror Editor 中显示内容）
            const cols = ['name', 'type', 'size', 'modified'];
            pgpyLastResult = { columns: cols, rows: entries, rowCount: entries.length, time: elapsed + 's', isFileList: true };
            pgpyRenderTable(cols, entries, elapsed, true);
          }
        }

        // ══════════════════════════════════════════════════════════════
        //  File content helpers (双击文件行 → CodeMirror Editor 显示完整内容)
        // ══════════════════════════════════════════════════════════════
        // 读取文件完整内容（二进制/Office/PDF 会转成可读文本或标记为 [Binary file]）
        async function pgpyReadFileContent(path) {
          // 返回 { content, fromBinary }：fromBinary=true 表示内容由 Office/PDF 二进制解析而来
          if (!nodeRuntime.ready) return { content: '[Binary file]', fromBinary: false };
          const FS = nodeRuntime.FS;
          try {
            const rawBin = FS.readFile(path, { encoding: 'binary' });
            const isZipOffice = rawBin.length >= 4 &&
              rawBin[0] === 0x50 && rawBin[1] === 0x4B &&
              (rawBin[2] === 0x03 || rawBin[2] === 0x07);
            const isOtherBinary = rawBin.length > 0 && (
              (rawBin[0] === 0x89 && rawBin[1] === 0x50 && rawBin[2] === 0x4E && rawBin[3] === 0x47) || // PNG
              (rawBin[0] === 0xFF && rawBin[1] === 0xD8) // JPEG
            );
            const isPdf = rawBin.length >= 4 &&
              rawBin[0] === 0x25 && rawBin[1] === 0x50 &&
              rawBin[2] === 0x44 && rawBin[3] === 0x46;
            const isOleOffice = rawBin.length >= 8 &&
              rawBin[0] === 0xD0 && rawBin[1] === 0xCF &&
              rawBin[2] === 0x11 && rawBin[3] === 0xE0 &&
              rawBin[4] === 0xA1 && rawBin[5] === 0xB1 &&
              rawBin[6] === 0x1A && rawBin[7] === 0xE1;

            if ((isZipOffice || isOleOffice || isPdf) && typeof window.__undocParse === 'function') {
              try {
                const result = window.__undocParse(rawBin);
                const format = result.format();
                let md = result.toMarkdown();
                if (!md || md.trim() === '') {
                  md = result.toText();
                }
                return { content: '[' + format.toUpperCase() + ']\n' + md, fromBinary: true };
              } catch (_) {
                return { content: '[Binary file]', fromBinary: true };
              }
            } else if (isZipOffice || isOleOffice || isPdf || isOtherBinary) {
              return { content: '[Binary file]', fromBinary: true };
            } else {
              const raw = FS.readFile(path, { encoding: 'utf8' });
              const fileContent = typeof raw === 'string' ? raw : '';
              if (fileContent.includes('\u0000')) return { content: '[Binary file]', fromBinary: true };
              return { content: fileContent, fromBinary: false };
            }
          } catch (_) {
            return { content: '[Binary file]', fromBinary: false };
          }
        }

        function pgpyUpdateSaveButton() {
          const btn = document.getElementById('saveFileBtn');
          if (btn) btn.disabled = !pgpyCurrentFilePath;
          const label = document.getElementById('pgpyCurrentFileLabel');
          if (label) {
            if (pgpyCurrentFilePath) {
              const dispPath = pgpyDisplayPath(pgpyCurrentFilePath);
              label.innerHTML = '📄 <span title="' + pgpyEscapeAttr(dispPath) + '">' + pgpyEscapeHtml(dispPath) + '</span><span class="pgpy-file-chip-clear" title="解除文件关联">✕</span>';
              label.style.display = '';
            } else {
              label.style.display = 'none';
            }
          }
        }

        // 双击文件行：读取完整 file_content 并载入 CodeMirror Editor
        async function pgpyOpenFileInEditor(path) {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          if (!pgpyEditor) return;
          const pgpyStatus = document.getElementById('pgpyStatus');
          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Loading ' + pgpyBasename(path) + ' ...'; }
          const res = await pgpyReadFileContent(path);
          const content = res && typeof res === 'object' ? res.content : String(res);
          const fromBinary = !!(res && res.fromBinary);
          if (content === '[Binary file]') {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ Binary file cannot be edited'; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('⚠️ ' + path + ' 是二进制文件，无法在编辑器中打开/编辑');
            }
            return;
          }
          pgpyCurrentFilePath = path;
          pgpyCurrentFileFromBinary = fromBinary;
          pgpyEditor.setValue(content);
          pgpyEditor.focus();
          pgpyUpdateSaveButton();
          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '📄 Editing ' + pgpyBasename(path); }
        }

        // 清除当前编辑器打开的文件关联（不清空编辑器内容）
        function pgpyClearCurrentFile() {
          pgpyCurrentFilePath = null;
          pgpyCurrentFileFromBinary = false;
          pgpyUpdateSaveButton();
        }

        // 点击工具栏 chip 上的 ✕（解除文件关联）：解除关联并同时清空 CodeMirror editor 内容
        function pgpyUnlinkCurrentFile() {
          pgpyClearCurrentFile();
          if (pgpyEditor) {
            pgpyEditor.setValue('');
          }
        }


        // Save File：把 CodeMirror Editor 中的内容通过 write_file 保存到文件
        async function saveCurrentFile() {
          if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
          if (!pgpyEditor) return;
          if (!pgpyCurrentFilePath) {
            const p = prompt('当前编辑器没有关联文件（可先双击 Query Results 中的文件行载入）。\n请输入要保存的文件路径：', '/home/pyodide/script.py');
            if (!p) return;
            pgpyCurrentFilePath = p.trim();
            pgpyUpdateSaveButton();
          }
          const file_path = pgpyCurrentFilePath;
          // 若文件原为 Office/PDF 等二进制文档（编辑器内为解析出的文本），保存会覆盖原文件，先确认
          if (pgpyCurrentFileFromBinary && !confirm('⚠️ 该文件是二进制 Office/PDF 文档，编辑器内显示的是解析出的文本。\n直接保存将用纯文本覆盖原二进制文件，可能导致原文件损坏！\n\n确定仍要保存到 ' + file_path + ' 吗？')) {
            return;
          }
          const content = pgpyEditor.getValue();
          const pgpyStatus = document.getElementById('pgpyStatus');
          if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-loading'; pgpyStatus.textContent = '⏳ Saving ' + pgpyBasename(file_path) + ' ...'; }

          let resultStr;
          try {
            resultStr = await write_file({ file_path: file_path, content: content });
          } catch (err) {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ Save failed'; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('❌ 保存失败: ' + (err.message || err));
            } else {
              alert('保存失败: ' + (err.message || err));
            }
            return;
          }

          let success = false;
          let text = resultStr;
          try {
            const parsed = JSON.parse(resultStr);
            success = !!parsed.success;
            if (parsed.content && parsed.content[0] && parsed.content[0].text) text = parsed.content[0].text;
          } catch (_) {}

          if (success) {
            pgpyCurrentFileFromBinary = false; // 保存成功后文件即变为普通文本,后续保存不再警告
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-success'; pgpyStatus.textContent = '💾 Saved ' + pgpyBasename(file_path); }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showSuccessMessage) {
              snackbarStore.showSuccessMessage('💾 ' + text);
            }
            // 刷新文件列表，更新 size / modified 列
            setTimeout(() => { try { listNodeFiles(); } catch (_) {} }, 300);
          } else {
            if (pgpyStatus) { pgpyStatus.className = 'pgpy-status-badge pgpy-error'; pgpyStatus.textContent = '❌ Save failed'; }
            if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) {
              snackbarStore.showErrorMessage('❌ 保存失败: ' + text);
            } else {
              alert('保存失败: ' + text);
            }
          }
        }


        // ══════════════════════════════════════════════════════════════
        //  Office 文件浏览/保存 (docx/xlsx/pptx) — 双击 Query Results 行时打开
        //  docx.html / xlsx.html / pptx.html 已合并进本页（内嵌编辑器 API：window.__docxEditor 等）
        // ══════════════════════════════════════════════════════════════
        const OFFICE_EDITORS = {
            docx: (typeof window.__docxEditor !== 'undefined') ? window.__docxEditor : null,
            xlsx: (typeof window.__xlsxEditor !== 'undefined') ? window.__xlsxEditor : null,
            pptx: (typeof window.__pptxEditor !== 'undefined') ? window.__pptxEditor : null
        };
        const OFFICE_MIME = {
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        };
        const OFFICE_LABEL = { docx: 'Word 文档', xlsx: 'Excel 表格', pptx: 'PPT 演示文稿' };
        let officeState = { path: null, ext: null };

        function officeGetExt(path) {
            return String(path || '').toLowerCase().split('.').pop();
        }

        function officeIsOfficePath(path) {
            const ext = officeGetExt(path);
            return !!(OFFICE_EDITORS[ext]);
        }

        function officeShowTab(ext) {
            ['docx', 'xlsx', 'pptx'].forEach(function(k) {
                const root = document.getElementById(k + 'EditorRoot');
                if (root) root.classList.toggle('active', k === ext);
                const tab = document.querySelector('.office-tab[data-tab="' + k + '"]');
                if (tab) tab.classList.toggle('active', k === ext);
            });
        }

        function officeSetActionsEnabled(en) {
            ['officeSaveBtn', 'officeSaveAsBtn', 'officeDownloadBtn'].forEach(function(id) {
                const b = document.getElementById(id);
                if (b) b.disabled = !en;
            });
        }

        function officeToArrayBuffer(buf) {
            if (buf instanceof ArrayBuffer) return buf;
            if (buf instanceof Uint8Array) {
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            }
            if (buf && buf.buffer instanceof ArrayBuffer) return buf.buffer;
            return new Uint8Array(buf).buffer;
        }

        // 打开 Office 编辑器：读取 almostnode FS 字节 → 切到对应页 → 调内嵌编辑器 API 载入
        async function officeOpenEditor(path) {
            if (!nodeRuntime.ready) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('Node 运行时尚未就绪，无法打开 Office 编辑器');
                return;
            }
            const ext = officeGetExt(path);
            const ed = OFFICE_EDITORS[ext];
            if (!ed || !ed.load) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('不支持的文件类型: ' + path);
                return;
            }
            let bin;
            try {
                bin = nodeRuntime.FS.readFile(path, { encoding: 'binary' });
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('无法读取文件: ' + path);
                return;
            }
            officeState = { path: path, ext: ext };

            document.getElementById('officeFileName').textContent = pgpyBasename(path) + '  ·  ' + (OFFICE_LABEL[ext] || ext.toUpperCase());
            const dispPath = pgpyDisplayPath(path);
            document.getElementById('officeFileName').title = dispPath;
            document.getElementById('officePath').textContent = dispPath;
            document.getElementById('officePath').title = dispPath;
            officeShowTab(ext);
            officeSetActionsEnabled(true);
            document.getElementById('officeModal').classList.add('open');

            // 内嵌 Office 编辑器依赖 almostnode 运行时注入的库（xlsx / pptxgenjs）。
            // 若宿主在库真正就绪前就打开文件，这里再等一下，避免 “XLSX.read is not a function”。
            if ((ext === 'xlsx' || ext === 'pptx') && window.__waitOfficeLibs) {
                const libOk = (ext === 'xlsx')
                    ? (window.XLSX && typeof window.XLSX.read === 'function')
                    : !!window.PptxGenJS;
                if (!libOk) { try { await window.__waitOfficeLibs(30000); } catch (_) {} }
            }

            const loading = document.getElementById('officeLoading');
            if (loading) loading.classList.remove('hidden');
            try {
                await ed.load(officeToArrayBuffer(bin), pgpyBasename(path));
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('打开 Office 文件失败: ' + ((err && err.message) || err));
            } finally {
                if (loading) loading.classList.add('hidden');
            }
        }

        // 让当前内嵌编辑器导出一份文件字节 { buffer: ArrayBuffer, fileName: string }
        async function officeExport() {
            const st = officeState;
            const ed = st && OFFICE_EDITORS[st.ext];
            if (!ed || !ed.export) throw new Error('当前没有可导出的编辑器');
            const res = await ed.export();
            if (!res || !res.buffer) throw new Error('编辑器未返回导出数据');
            return res;
        }

        function officeWriteBufferToFS(buffer, targetPath) {
            const FS = nodeRuntime.FS;
            const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
            if (parentDir && parentDir !== '') { try { FS.mkdirTree(parentDir); } catch (_) {} }
            FS.writeFile(targetPath, new Uint8Array(buffer));
        }

        // 保存到 almostnode FS —— docx/xlsx/pptx 一律直接覆盖写入原文件路径
        async function officeSave() {
            const st = officeState;
            const path = st && st.path;
            if (!path) return;
            const btn = document.getElementById('officeSaveBtn');
            if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
            try {
                const res = await officeExport();
                officeWriteBufferToFS(res.buffer, path);
                await pgpySyncMount(false);
                if (typeof snackbarStore !== 'undefined') {
                    snackbarStore.showSuccessMessage('💾 已保存（覆盖）到 ' + path);
                }
                setTimeout(() => { try { listNodeFiles(); } catch (_) {} }, 300);
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('保存失败: ' + ((err && err.message) || err));
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '💾 保存到 Node FS'; }
            }
        }

        // 另存为 almostnode FS 中的其他路径
        async function officeSaveAs() {
            const path = officeState.path;
            if (!path) return;
            const p = prompt('另存为 almostnode 路径（默认在 /home/pyodide 下）:', path);
            if (!p) return;
            const target = String(p).trim();
            const btn = document.getElementById('officeSaveAsBtn');
            if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
            try {
                const res = await officeExport();
                officeWriteBufferToFS(res.buffer, target);
                await pgpySyncMount(false);
                if (typeof snackbarStore !== 'undefined') snackbarStore.showSuccessMessage('💾 已另存到 ' + target);
                setTimeout(() => { try { listNodeFiles(); } catch (_) {} }, 300);
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('另存失败: ' + ((err && err.message) || err));
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '📝 另存为…'; }
            }
        }

        // 下载导出的文件到本地
        async function officeDownload() {
            const path = officeState.path;
            if (!path) return;
            try {
                const res = await officeExport();
                const blob = new Blob([res.buffer], { type: OFFICE_MIME[officeState.ext] || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = res.fileName || pgpyBasename(path);
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('下载失败: ' + ((err && err.message) || err));
            }
        }

        // 从 almostnode FS 重新读取当前文件并重新载入编辑器（丢弃未保存修改）
        async function officeReload() {
            const st = officeState;
            if (!st.path || !st.ext || !nodeRuntime.ready) return;
            const ed = OFFICE_EDITORS[st.ext];
            if (!ed || !ed.load) return;
            try {
                const bin = nodeRuntime.FS.readFile(st.path, { encoding: 'binary' });
                await ed.load(officeToArrayBuffer(bin), pgpyBasename(st.path));
                if (typeof snackbarStore !== 'undefined') snackbarStore.showInfoMessage('🔄 已从 almostnode FS 重新加载: ' + st.path);
            } catch (err) {
                if (typeof snackbarStore !== 'undefined') snackbarStore.showErrorMessage('重新加载失败: ' + ((err && err.message) || err));
            }
        }

        function officeInitUI() {
            const saveBtn = document.getElementById('officeSaveBtn');
            const saveAsBtn = document.getElementById('officeSaveAsBtn');
            const downloadBtn = document.getElementById('officeDownloadBtn');
            const reloadBtn = document.getElementById('officeReloadBtn');
            if (saveBtn) saveBtn.addEventListener('click', officeSave);
            if (saveAsBtn) saveAsBtn.addEventListener('click', officeSaveAs);
            if (downloadBtn) downloadBtn.addEventListener('click', officeDownload);
            if (reloadBtn) reloadBtn.addEventListener('click', officeReload);

            // 顶部页签：手动切换编辑器（不关联具体文件，可自由浏览各编辑器）
            document.querySelectorAll('.office-tab').forEach(function(tab) {
                tab.addEventListener('click', function() {
                    const ext = tab.getAttribute('data-tab');
                    if (!ext) return;
                    officeState = { path: null, ext: null };
                    officeShowTab(ext);
                    officeSetActionsEnabled(false);
                    document.getElementById('officeFileName').textContent = 'Office 编辑器 · ' + (OFFICE_LABEL[ext] || ext.toUpperCase());
                    document.getElementById('officeFileName').title = '';
                    document.getElementById('officePath').textContent = '';
                    document.getElementById('officePath').title = '';
                });
            });

            // 关闭弹窗后记住最后一个激活页签，方便再次打开时快速切换
            officeShowTab('docx');
            officeSetActionsEnabled(false);
        }
        officeInitUI();



        // ══════════════════════════════════════════════════════════════
        //  PDF / 图片 / 视频：双击 Query Results 文件行 → 预览浏览
        //  （Office 走富编辑器；纯文本走 CodeMirror；这三类二进制在此弹窗预览）
        // ══════════════════════════════════════════════════════════════
        const MEDIA_PREVIEW_MIME = {
            pdf: 'application/pdf',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
            webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
            mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
            mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo'
        };
        const MEDIA_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
        const MEDIA_VIDEO_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi'];

        // 判定文件是否属于可「双击浏览」的媒体类型：'pdf' | 'image' | 'video' | ''
        function previewKind(path) {
            const ext = officeGetExt(path);
            if (ext === 'pdf') return 'pdf';
            if (MEDIA_IMAGE_EXT.indexOf(ext) !== -1) return 'image';
            if (MEDIA_VIDEO_EXT.indexOf(ext) !== -1) return 'video';
            return '';
        }

        // almostnode FS 的 binary 读取返回「每字符=一字节」的字符串，转 Uint8Array 供 Blob 使用
        function mediaBinToBytes(bin) {
            if (bin instanceof Uint8Array) return bin;
            if (bin instanceof ArrayBuffer) return new Uint8Array(bin);
            const s = String(bin == null ? '' : bin);
            const bytes = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
            return bytes;
        }

        let pgpyMediaPreviewUrl = null;
        let pgpyMediaEscBound = false;

        function closeMediaPreview() {
            const ov = document.getElementById('pgpyMediaPreview');
            if (ov) {
                const v = ov.querySelector('video');
                if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
                ov.remove();
            }
            if (pgpyMediaPreviewUrl) {
                try { URL.revokeObjectURL(pgpyMediaPreviewUrl); } catch (_) {}
                pgpyMediaPreviewUrl = null;
            }
        }

        function mediaBodyHTML(kind, url) {
            const safe = pgpyEscapeAttr(url);
            if (kind === 'image') {
                return '<img src="' + safe + '" alt="preview" style="max-width:100%;max-height:100%;object-fit:contain;display:block;">';
            }
            if (kind === 'video') {
                return '<video src="' + safe + '" controls autoplay playsinline style="max-width:100%;max-height:100%;outline:none;background:#000;"></video>';
            }
            // pdf：交给 Chromium 内置 PDF 阅读器渲染
            return '<iframe src="' + safe + '" title="PDF 预览" style="width:100%;height:100%;border:0;background:#fff;"></iframe>';
        }

        // 双击 PDF / 图片 / 视频行 → 弹出媒体预览（只浏览，不进入 CodeMirror 编辑器）
        function openMediaPreview(path) {
            if (!nodeRuntime.ready) { alert('Node runtime not ready.'); return; }
            const kind = previewKind(path);
            if (!kind) { pgpyOpenFileInEditor(path); return; }

            let bytes;
            try {
                bytes = mediaBinToBytes(nodeRuntime.FS.readFile(path, { encoding: 'binary' }));
            } catch (err) {
                const msg = '无法读取文件: ' + ((err && err.message) || err || path);
                if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) snackbarStore.showErrorMessage('❌ ' + msg);
                else alert(msg);
                return;
            }

            const ext = officeGetExt(path);
            const mime = MEDIA_PREVIEW_MIME[ext] || (kind === 'image' ? 'image/*' : (kind === 'video' ? 'video/*' : 'application/pdf'));
            const blob = new Blob([bytes], { type: mime });
            const url = URL.createObjectURL(blob);

            closeMediaPreview();
            pgpyMediaPreviewUrl = url;

            const icon = kind === 'pdf' ? '📕' : (kind === 'image' ? '🖼️' : '🎬');
            const kindLabel = kind === 'pdf' ? 'PDF' : (kind === 'image' ? '图片' : '视频');
            const dispPath = pgpyDisplayPath(path);
            const bodyStyle = kind === 'pdf'
                ? 'flex:1;min-height:0;overflow:hidden;display:block;background:#f4f5f7;'
                : 'flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;background:#111418;padding:0;';

            const overlay = document.createElement('div');
            overlay.id = 'pgpyMediaPreview';
            overlay.className = 'modal-overlay open';
            overlay.innerHTML =
                '<div class="modal-card" style="width:min(1120px,96vw);height:min(88vh,900px);max-width:96vw;display:flex;flex-direction:column;overflow:hidden;">' +
                    '<div class="modal-header" style="flex-shrink:0;">' +
                        '<span class="modal-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + pgpyEscapeAttr(dispPath) + '">' +
                            icon + ' ' + pgpyEscapeHtml(pgpyBasename(path)) +
                            ' <span style="font-size:12px;color:#888;font-weight:400;">· ' + kindLabel + ' 预览</span>' +
                        '</span>' +
                        '<button type="button" class="mh-btn modal-close" title="关闭">✕</button>' +
                    '</div>' +
                    '<div class="pgpy-media-body" style="' + bodyStyle + '">' + mediaBodyHTML(kind, url) + '</div>' +
                '</div>';

            // 关闭：点 ✕ / 点遮罩空白处 / 按 Esc
            overlay.querySelector('.modal-close').addEventListener('click', closeMediaPreview);
            overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMediaPreview(); });
            if (!pgpyMediaEscBound) {
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape' && document.getElementById('pgpyMediaPreview')) closeMediaPreview();
                });
                pgpyMediaEscBound = true;
            }

            document.body.appendChild(overlay);
        }

        // 双击表格文件行 → 载入编辑器；点 chip 上的 ✕ 可解除关联
        document.addEventListener('dblclick', function(e) {
          if (!pgpyLastResult || !pgpyLastResult.isFileList) return;
          if (e.target && e.target.closest && (e.target.closest('.pgpy-file-check') || e.target.closest('.pgpy-diff-link') || e.target.closest('.pgpy-file-del'))) return;
          const tr = e.target && e.target.closest ? e.target.closest('tr.pgpy-file-row') : null;
          if (!tr) return;
          const tbody = document.getElementById('pgpyResultsBody');
          if (!tbody || !tbody.contains(tr)) return;
          const path = tr.getAttribute('data-path');
          if (!path) return;
          const idx = parseInt(tr.getAttribute('data-index'), 10);
          const row = (!isNaN(idx) && pgpyLastResult.rows[idx]) ? pgpyLastResult.rows[idx] : null;
          if (row && row.type && String(row.type).indexOf('dir') !== -1) return; // 目录不载入
          if (row && row.type && String(row.type).indexOf('待删除') !== -1) return; // 待同步删除的幽灵行不载入
          // Office 文档 (docx/xlsx/pptx)：打开专用富编辑器，可浏览编辑并保存回 almostnode FS
          if (officeIsOfficePath(path)) {
            officeOpenEditor(path);
            return;
          }
          // PDF / 图片 / 视频：弹出预览浏览，不进入 CodeMirror 编辑器
          if (previewKind(path)) {
            openMediaPreview(path);
            return;
          }
          pgpyOpenFileInEditor(path);
        });

        document.addEventListener('click', function(e) {
          if (e.target && e.target.classList && e.target.classList.contains('pgpy-file-chip-clear')) {
            e.stopPropagation();
            pgpyUnlinkCurrentFile();
          }
        });


