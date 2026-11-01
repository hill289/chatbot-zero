/* ══════════════════════════════════════════════════════════════════════
 *  24-task-center-ui.js —— 任务中心（任务态 / 产物 / 变更 diff / 中断恢复）
 *                            + planner → executor → verifier 三段式接线
 *
 *  接线点（都是「唯一收敛点」，不改业务主流程）：
 *    · agentStore.promptMessage  —— 请求前注入「阶段指令 / 恢复提示」到对话尾部，
 *                                   并在需要时创建任务（不碰 system+tools 前缀）。
 *    · mcpStore.callTool         —— 写/改/删工具执行前后读取虚拟文件快照，
 *                                   归集产物与行级 diff；run_tests 结果作为验证证据。
 *    · 落盘                      —— Electron 下走 preload.tasksAPI（<APP_DIR>/tasks/），
 *                                   纯浏览器降级到 localStorage。
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var TS = window.TaskService;
    if (!TS) { try { console.warn('[task] TaskService 未加载，任务中心停用'); } catch (_) {} return; }

    var STORE_KEY = 'taskCenter.v1';
    var EDIT_TOOLS = {
        write_file: 'file_path', edit_file: 'file_path', replace_lines: 'file_path',
        add_content: 'file_path', delete_content: 'file_path', delete_file: 'file_path'
    };

    function readVfs(p) {
        try {
            var rt = (typeof nodeRuntime !== 'undefined') ? nodeRuntime : window.nodeRuntime;
            if (!rt || !rt.FS || !p) return null;
            return rt.FS.readFile(String(p), { encoding: 'utf8' });
        } catch (_) { return null; }
    }

    function textOfToolResult(res) {
        try {
            if (!res) return '';
            if (typeof res === 'string') return res;
            if (Array.isArray(res.content)) {
                return res.content.map(function (c) { return (c && (c.text || c.content)) || ''; }).join('\n');
            }
            return JSON.stringify(res).slice(0, 4000);
        } catch (_) { return ''; }
    }

    var TaskCenter = {
        tasks: [],
        activeId: '',
        mode: 'auto',
        pendingResume: '',
        _before: {},
        _mounted: false,

        active: function () {
            for (var i = 0; i < this.tasks.length; i++) if (this.tasks[i].id === this.activeId) return this.tasks[i];
            return null;
        },

        // 把焦点交还主输入框。任务中心面板按钮在 .input-panel 之外，不受
        // wireInputFocusGuard 保护；点过按钮（尤其 confirm 弹窗关闭后焦点落到 body）后，
        // 再点输入框会「光标无法落回 textarea、无法输入」。收口成一处，动作结束即拉回焦点。
        // 只做 DOM 层回焦（应用内模态关闭后用它；应用内 DOM 模态不涉及 OS 级窗口焦点）
        _focusDom: function () {
            try {
                var input = document.getElementById('userInput');
                if (!input) return;
                try { input.focus({ preventScroll: true }); }
                catch (_) { try { input.focus(); } catch (__) {} }
                try { if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus(); } catch (_) {}
            } catch (_) {}
        },

        // 把焦点交还主输入框。任务中心面板按钮在 .input-panel 之外，不受
        // wireInputFocusGuard 保护；动作结束即拉回焦点，避免「点输入框打不了字」。
        focusInput: function () {
            var self = this;
            // ① 兜底：让主进程夺回「OS 级」窗口 + 当前页面焦点（其它仍在用原生弹窗
            //    的地方关闭后仍可能失焦；win:refocus = win.focus + webContents.focus）。
            // ② 再落 DOM 焦点。refocus 是异步 IPC，等它 resolve 后再落 DOM，避免
            //    「DOM 已聚焦、窗口仍失焦、键盘/IME 进不来」的竞态。
            try {
                if (window.shellAPI && typeof window.shellAPI.refocus === 'function') {
                    Promise.resolve(window.shellAPI.refocus()).then(
                        function () { self._focusDom(); },
                        function () { self._focusDom(); }
                    );
                    return;
                }
            } catch (_) {}
            self._focusDom();
        },

        // 应用内确认框（替代原生 confirm()，从根上避免「原生弹窗关闭后 webContents
        //   失焦、点输入框打不了字」的问题）。返回 Promise<boolean>。
        //   复用全局 .modal-*/.m-btn/.ask-question 样式；支持按钮 / ESC / 点遮罩取消；
        //   关闭后自动把 DOM 焦点交还输入框。测试可覆盖 TaskCenter.confirmDialog 注入结果。
        confirmDialog: function (message, opts) {
            opts = opts || {};
            var self = this;
            return new Promise(function (resolve) {
                var d = (typeof document !== 'undefined') ? document : null;
                if (!d || typeof d.createElement !== 'function' || !d.body) { resolve(true); return; }
                var overlay = d.createElement('div');
                overlay.className = 'modal-overlay open';
                // 任务中心面板 z-index=9999，全局 .modal-overlay 默认 1000 会被压在下面；
                // 提到 10001 保证应用内确认框始终浮在最上层。
                overlay.style.zIndex = '10001';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');

                var card = d.createElement('div');
                card.className = 'modal-card small';

                var header = d.createElement('div');
                header.className = 'modal-header';
                var title = d.createElement('div');
                title.className = 'modal-title';
                title.textContent = opts.title || '请确认';
                var closeX = d.createElement('button');
                closeX.className = 'mh-btn';
                closeX.setAttribute('aria-label', '关闭');
                closeX.textContent = '✕';
                header.appendChild(title);
                header.appendChild(closeX);

                var body = d.createElement('div');
                body.className = 'modal-body';
                var q = d.createElement('div');
                q.className = 'ask-question';
                q.textContent = String(message == null ? '' : message);
                body.appendChild(q);

                var footer = d.createElement('div');
                footer.className = 'modal-footer';
                var spacer = d.createElement('span');
                spacer.className = 'spacer';
                var cancelBtn = d.createElement('button');
                cancelBtn.className = 'm-btn';
                cancelBtn.textContent = opts.cancelText || '取消';
                var okBtn = d.createElement('button');
                okBtn.className = 'm-btn';
                okBtn.textContent = opts.okText || '确定';
                if (opts.danger) { okBtn.style.background = '#dc2626'; okBtn.style.color = '#fff'; }
                else { okBtn.style.background = '#1867C0'; okBtn.style.color = '#fff'; }
                footer.appendChild(spacer);
                footer.appendChild(cancelBtn);
                footer.appendChild(okBtn);

                card.appendChild(header);
                card.appendChild(body);
                card.appendChild(footer);
                overlay.appendChild(card);
                d.body.appendChild(overlay);

                var done = false;
                function close(result) {
                    if (done) return;
                    done = true;
                    try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (_) {}
                    try { d.removeEventListener('keydown', onKey, true); } catch (_) {}
                    try { self._focusDom(); } catch (_) {}
                    resolve(!!result);
                }
                function onKey(e) {
                    if (!e) return;
                    if (e.key === 'Escape') { try { e.preventDefault(); } catch (_) {} close(false); }
                    else if (e.key === 'Enter') { try { e.preventDefault(); } catch (_) {} close(true); }
                }
                cancelBtn.addEventListener('click', function () { close(false); });
                okBtn.addEventListener('click', function () { close(true); });
                closeX.addEventListener('click', function () { close(false); });
                overlay.addEventListener('mousedown', function (e) { if (e && e.target === overlay) close(false); });
                d.addEventListener('keydown', onKey, true);
                // 危险操作默认聚焦「取消」，普通操作默认聚焦「确定」
                try { (opts.danger ? cancelBtn : okBtn).focus(); } catch (_) {}
            });
        },

        // ── 持久化 ──────────────────────────────────────
        load: function () {
            var self = this;
            if (window.tasksAPI && typeof window.tasksAPI.list === 'function') {
                return window.tasksAPI.list().then(function (r) {
                    self.tasks = ((r && r.tasks) || []).map(TS.deserialize).filter(Boolean);
                    self.afterRestore();
                }).catch(function () { self.afterRestore(); });
            }
            try {
                var raw = localStorage.getItem(STORE_KEY);
                var j = raw ? JSON.parse(raw) : null;
                this.tasks = ((j && j.tasks) || []).map(TS.deserialize).filter(Boolean);
                this.activeId = (j && j.activeId) || '';
            } catch (_) { this.tasks = []; }
            this.afterRestore();
            return Promise.resolve();
        },

        // 启动后：上次还在跑的任务 = 被中断（应用关闭）→ 标记 + 提示可恢复
        afterRestore: function () {
            var changed = false;
            this.tasks.forEach(function (t) {
                if (t.status === 'running') {
                    TS.advance(t, { type: 'interrupt' });
                    changed = true;
                }
            });
            if (changed) this.persistAll();
            this.render();
            var t = this.active();
            if (t && t.stage === 'interrupted') this.toast('上次任务未完成：' + t.title + '，点「继续」恢复');
        },

        persistAll: function () {
            var self = this;
            if (window.tasksAPI && typeof window.tasksAPI.save === 'function') {
                this.tasks.forEach(function (t) {
                    try { window.tasksAPI.save(TS.serialize(t)); } catch (_) {}
                });
                return;
            }
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({
                    tasks: this.tasks.map(TS.serialize), activeId: this.activeId
                }));
            } catch (_) {}
        },

        persist: function (t) {
            if (!t) return;
            try {
                if (window.tasksAPI && typeof window.tasksAPI.save === 'function') window.tasksAPI.save(TS.serialize(t));
                else this.persistAll();
            } catch (_) {}
        },

        // ── 任务生命周期 ────────────────────────────────
        create: function (goal) {
            var t = TS.createTask(goal);
            this.tasks.unshift(t);
            this.activeId = t.id;
            this.persist(t);
            this.render();
            return t;
        },

        setActive: function (id) {
            this.activeId = id;
            this.persistAll();
            this.render();
        },

        resume: function (t) {
            t = t || this.active();
            if (!t) return;
            this.pendingResume = TS.resumePrompt(t);
            TS.advance(t, { type: 'resume' });
            this.persist(t);
            this.render();
            var input = document.getElementById('userInput');
            if (input) {
                if (!input.value.trim()) input.value = '继续：' + t.title;
                input.focus();
            }
            this.toast('已恢复任务，发送消息即可从断点继续');
        },

        pause: function (t) {
            t = t || this.active();
            if (!t) return;
            TS.advance(t, { type: 'pause' });
            this.persist(t); this.render();
        },

        verify: function (t) {
            t = t || this.active();
            if (!t) return;
            TS.advance(t, { type: 'verify', evidence: t.evidence });
            this.persist(t); this.render();
            var v = t.lastVerdict || {};
            this.toast((v.pass ? '✅ 验证通过：' : '⚠️ 验证未通过：') + (v.reasons || []).join('；'));
        },

        remove: function (t) {
            if (!t) return;
            var self = this;
            this.tasks = this.tasks.filter(function (x) { return x.id !== t.id; });
            if (this.activeId === t.id) this.activeId = (this.tasks[0] || {}).id || '';
            try {
                if (window.tasksAPI && typeof window.tasksAPI.remove === 'function') window.tasksAPI.remove(t.id);
            } catch (_) {}
            this.persistAll(); this.render();
        },

        // ── 一键清空「任务列表」（删除全部任务记录，不动工程文件/沙箱）──
        clearAll: function () {
            var self = this;
            if (!this.tasks.length) { this.toast('任务列表已空'); return Promise.resolve(); }
            var n = this.tasks.length;
            return this.confirmDialog(
                '确定清空全部任务吗？\n\n· 将删除全部 ' + n + ' 条任务记录（含已落盘记录）\n· 不影响已同步的工程文件与沙箱运行目录',
                { title: '清空任务列表', okText: '清空', danger: true }
            ).then(function (ok) {
                if (!ok) return;
                var ids = self.tasks.map(function (t) { return t.id; });
                self.tasks = [];
                self.activeId = '';
                // Electron：逐条删除落盘记录（<APP_DIR>/tasks/<id>.json）
                if (window.tasksAPI && typeof window.tasksAPI.remove === 'function') {
                    ids.forEach(function (id) { try { window.tasksAPI.remove(id); } catch (_) {} });
                }
                // 纯浏览器降级：用空列表覆盖 localStorage，避免刷新后复活
                try { localStorage.setItem(STORE_KEY, JSON.stringify({ tasks: [], activeId: '' })); } catch (_) {}
                self.render();
                self.toast('🧹 已清空全部任务（' + n + ' 条）');
                self.focusInput();
            });
        },

        // ── 一键清空「实际沙箱空间」────────────────────────
        //   清的是「物化 → 真实执行 → 回收」产生的真实磁盘运行目录（<APP_DIR>/workspace/，
        //   含 node_modules 等依赖缓存），并终止所有后台任务；
        //   虚拟工作区 /home/pyodide 与 🔁 同步落地的真实工程文件都不受影响。
        clearSandbox: function () {
            var self = this;
            if (!window.shellAPI || typeof window.shellAPI.cleanupAll !== 'function') {
                this.toast('清空沙箱需要新版 Electron 外壳（shellAPI.cleanupAll 不可用）');
                return Promise.resolve();
            }
            // 应用内确认（非原生 confirm）：原生弹窗关闭后窗口会丢 OS 级焦点、点输入框打不了字。
            return this.confirmDialog(
                '确定清空实际沙箱空间吗？\n\n' +
                '· 将终止所有后台任务\n' +
                '· 删除物化运行目录 workspace/（含 node_modules 等依赖缓存）\n\n' +
                '虚拟工作区 /home/pyodide 与已同步的真实文件不受影响，下次运行时会按需重新物化。',
                { title: '清空沙箱', okText: '清空', danger: true }
            ).then(function (ok) {
                if (!ok) return;
                var btn = document.getElementById('taskClearSandboxBtn');
                if (btn) { btn.disabled = true; btn.textContent = '清空中…'; }
                self.toast('正在清空沙箱空间…');
                // 用 Promise.resolve() 兜一层：即使 cleanupAll() 同步抛错也会转成 reject，
                // 保证收口的 .then 一定执行 → 按钮复位、焦点交还输入框。
                return Promise.resolve().then(function () {
                    return window.shellAPI.cleanupAll();
                }).then(function (r) {
                    if (r && r.ok) {
                        var mb = (r.freedBytes || 0) / (1024 * 1024);
                        var sizeTxt = r.freedBytes > 0 ? '（释放约 ' + (mb >= 1 ? mb.toFixed(1) + ' MB' : (r.freedBytes / 1024).toFixed(0) + ' KB') + '）' : '';
                        self.toast('🧹 已清空沙箱空间' + sizeTxt);
                    } else {
                        self.toast('清空失败：' + ((r && r.error) || '未知错误'));
                    }
                }).catch(function (err) {
                    self.toast('清空失败：' + ((err && err.message) || err));
                }).then(function () {
                    if (btn) { btn.disabled = false; btn.textContent = '🧹 清空沙箱'; }
                    // 先回焦，再刷新后台任务列表：即使 renderJobs 抛错也不会漏掉回焦。
                    self.focusInput();
                    try { self.renderJobs(); } catch (_) {}
                });
            });
        },

        // ── 执行护栏中止 → 任务态记账（是否续跑由 chat-store 统一决定）──
        //   opts: { allow:boolean, kind:'steps'|'repeat'|'error', used, max }
        onGuardAbort: function (reason, opts) {
            opts = opts || {};
            var t = this.active();
            if (!t) return false;
            try {
                if (opts.allow) {
                    TS.advance(t, { type: 'guardAbort', reason: reason });
                    this.persist(t);
                    this.render();
                    this.toast('执行护栏中止，已自动继续（' + (t.autoContinues || 0) + '/' + (t.maxAutoContinues || 3) + '）');
                    return true;
                }
                // 不自动续跑（重复调用 / 连续失败 / 超上限）→ 标记可恢复，等人工
                if (t.status === 'running' && t.stage !== 'done' && t.stage !== 'failed') {
                    TS.advance(t, { type: 'interrupt' });
                }
                t.lastGuardReason = String(reason || '').slice(0, 300);
                this.persist(t);
                this.render();
                return false;
            } catch (e) {
                try { console.warn('[task] onGuardAbort failed', e); } catch (_) {}
                return false;
            }
        },

        // ── prompt 注入（planner / executor / verifier 指令 + 恢复）──
        inject: function (messages) {
            try {
                if (!Array.isArray(messages) || !messages.length) return messages;
                var last = null;
                for (var i = messages.length - 1; i >= 0; i--) {
                    if (messages[i] && messages[i].role === 'user') { last = messages[i]; break; }
                }
                if (!last) return messages;

                // 自动建任务：模式开启且当前没有进行中的任务
                var t = this.active();
                if (this.mode === 'auto' && (!t || t.stage === 'done' || t.stage === 'failed')) {
                    var goal = this._lastUserGoal(messages);
                    if (goal) t = this.create(goal);
                }
                if (!t) return messages;

                var block = '';
                if (this.pendingResume) { block += '\n\n' + this.pendingResume; this.pendingResume = ''; }
                block += TS.stageDirective(t);
                if (!block) return messages;

                if (typeof last.content === 'string') last.content = last.content + block;
                else if (Array.isArray(last.content)) last.content.push({ type: 'text', text: block });
                return messages;
            } catch (err) {
                try { console.warn('[task] inject failed', err); } catch (_) {}
                return messages;
            }
        },

        _lastUserGoal: function (messages) {
            for (var i = messages.length - 1; i >= 0; i--) {
                var m = messages[i];
                if (!m || m.role !== 'user') continue;
                var s = typeof m.content === 'string' ? m.content :
                    (Array.isArray(m.content) ? m.content.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n') : '');
                s = String(s || '').replace(/【任务中心[\s\S]*$/, '').trim();
                if (!s) continue;
                // 带工具结果/上下文的同一轮不重复建任务
                if (/^【(中断恢复|任务中心)/.test(s)) continue;
                return s.slice(0, 200);
            }
            return '';
        },

        // ── 工具事件 → 产物 / 证据 ──────────────────────
        onToolStart: function (name, args) {
            var key = EDIT_TOOLS[name];
            if (!key || !args) return;
            var p = args[key];
            if (!p) return;
            this._before[name + '|' + p] = readVfs(p);
        },

        onToolEnd: function (name, args, res, err) {
            var t = this.active();
            if (!t) return;
            var key = EDIT_TOOLS[name];
            var isErr = !!(err || (res && res.isError));
            var text = textOfToolResult(res) || (err ? String(err.message || err) : '');

            if (key && args && args[key]) {
                var p = args[key];
                var before = this._before[name + '|' + p];
                var after = (name === 'delete_file') ? '' : readVfs(p);
                if (!isErr) {
                    TS.advance(t, { type: 'tool', name: name, path: p, before: before == null ? '' : before, after: after == null ? '' : after });
                    delete this._before[name + '|' + p];
                }
            } else if (!isErr) {
                TS.advance(t, { type: 'tool', name: name });
            }

            TS.advance(t, { type: 'toolResult', name: name, ok: !isErr, isError: isErr, text: text });

            // verifier：一拿到测试/诊断证据就判定（失败 → 回执行并写入反馈）
            if (t.stage === 'executing' && (t.evidence.tests || t.evidence.diagnostics) &&
                (name === 'run_tests' || name === 'run_shell')) {
                TS.advance(t, { type: 'verify', evidence: t.evidence });
                var v = t.lastVerdict || {};
                this.toast(v.pass ? '✅ 验证通过，任务完成' : ('⚠️ 验证未通过：' + (v.reasons || []).join('；') + '（已把原因写进下一轮提示）'));
            }
            this.persist(t);
            this.render();
        },

        // ── UI ────────────────────────────────────────
        mount: function () {
            if (this._mounted) return;
            this._mounted = true;
            var btn = document.createElement('button');
            btn.id = 'taskCenterBtn';
            btn.type = 'button';
            btn.textContent = '🗂️';
            btn.title = '任务中心';
            btn.style.cssText = 'position:fixed;right:18px;bottom:150px;z-index:9998;width:42px;height:42px;border-radius:50%;' +
                'border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:18px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35);';
            btn.addEventListener('click', function () {
                var p = document.getElementById('taskCenterPanel');
                if (p) p.style.display = (p.style.display === 'none' || !p.style.display) ? 'flex' : 'none';
            });
            document.body.appendChild(btn);

            var panel = document.createElement('div');
            panel.id = 'taskCenterPanel';
            panel.style.cssText = 'position:fixed;right:18px;bottom:200px;z-index:9999;width:390px;max-height:62vh;display:none;' +
                'flex-direction:column;background:#0b1220;color:#e2e8f0;border:1px solid #1e293b;border-radius:12px;' +
                'box-shadow:0 16px 48px rgba(0,0,0,.5);font:12px/1.6 ui-sans-serif,system-ui;overflow:hidden;';
            panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111a30;border-bottom:1px solid #1e293b;">' +
                '<b style="color:#7ee787;">🗂️ 任务中心</b><span id="taskModeTag" style="color:#94a3b8;"></span>' +
                '<span style="flex:1"></span>' +
                '<button id="taskClearAllBtn" title="清空全部任务（删除所有任务记录，不影响工程文件/沙箱）" style="background:#3b1d1d;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;padding:2px 8px;cursor:pointer;">🗑 清空</button>' +
                '<button id="taskNewBtn" style="background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">＋新任务</button>' +
                '<button id="taskModeBtn" style="background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">自动</button>' +
                '<button id="taskCloseBtn" style="background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">✕</button>' +
                '</div><div id="taskList" style="overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;"></div>' +
                '<div style="display:flex;align-items:center;gap:8px;padding:4px 12px;color:#64748b;border-top:1px solid #1e293b;">' +
                '<span>后台任务（落盘，可续跑）</span><span style="flex:1"></span>' +
                '<button id="taskClearSandboxBtn" title="一键清空实际沙箱空间：终止全部后台任务并删除物化运行目录 workspace/（虚拟工作区 /home/pyodide 不受影响）" ' +
                'style="background:#3b1d1d;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;padding:1px 8px;cursor:pointer;">🧹 清空沙箱</button>' +
                '</div>' +
                '<div id="taskJobList" style="padding:4px 10px 8px;display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto;"></div>';
            document.body.appendChild(panel);

            var self = this;
            panel.querySelector('#taskCloseBtn').addEventListener('click', function () { panel.style.display = 'none'; });
            panel.querySelector('#taskModeBtn').addEventListener('click', function () {
                self.mode = self.mode === 'auto' ? 'off' : 'auto';
                self.render(); self.toast('任务模式：' + (self.mode === 'auto' ? '自动建任务' : '关闭'));
            });
            panel.querySelector('#taskNewBtn').addEventListener('click', function () {
                var goal = prompt('任务目标（一句话）：');
                if (goal) { self.create(goal); self.resume(self.active()); }
            });
            var clearAllBtn = panel.querySelector('#taskClearAllBtn');
            if (clearAllBtn) clearAllBtn.addEventListener('click', function () { self.clearAll(); });
            var clearBtn = panel.querySelector('#taskClearSandboxBtn');
            if (clearBtn) clearBtn.addEventListener('click', function () { self.clearSandbox(); });
            this.render();
        },

        render: function () {
            var list = document.getElementById('taskList');
            var tag = document.getElementById('taskModeTag');
            if (tag) tag.textContent = this.mode === 'auto' ? '· 自动' : '· 手动';
            if (!list) return;
            list.textContent = '';
            if (!this.tasks.length) {
                var empty = document.createElement('div');
                empty.style.cssText = 'color:#64748b;padding:12px;text-align:center;';
                empty.textContent = '还没有任务。点「＋新任务」，或直接在对话里发起一个多步骤需求。';
                list.appendChild(empty);
                return;
            }
            var self = this;
            this.tasks.slice(0, 30).forEach(function (t) {
                list.appendChild(self._taskCard(t));
            });
            this.renderJobs();
        },

        // 后台任务：读主进程落盘记录（关窗后依然在），中断的给「续跑」按钮
        renderJobs: function () {
            var host = document.getElementById('taskJobList');
            if (!host) return;
            host.textContent = '';
            if (!window.shellAPI || typeof window.shellAPI.listJobs !== 'function') return;
            var self = this;
            window.shellAPI.listJobs({}).then(function (r) {
                var jobs = (r && r.jobs) || [];
                if (!jobs.length) {
                    var e = document.createElement('div');
                    e.style.color = '#475569';
                    e.textContent = '暂无（run_shell(run_in_background=true) 启动）';
                    host.appendChild(e);
                    return;
                }
                jobs.slice(0, 6).forEach(function (j) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;color:' +
                        (j.status === 'running' ? '#86efac' : j.status === 'interrupted' ? '#fbbf24' : '#94a3b8') + ';';
                    var label = document.createElement('span');
                    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    label.textContent = j.status + ' · ' + j.command;
                    label.title = j.command + (j.hint ? ('\n' + j.hint) : '');
                    row.appendChild(label);
                    if (j.status !== 'running' && j.status !== 'killed') {
                        var b = document.createElement('button');
                        b.textContent = '续跑';
                        b.style.cssText = 'background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:1px 6px;cursor:pointer;';
                        b.addEventListener('click', function () {
                            window.shellAPI.jobResume({ jobId: j.id }).then(function (res) {
                                self.toast(res && res.ok ? ('已续跑：' + (res.jobId || '')) : ('续跑失败：' + ((res && res.error) || '未知')));
                                self.render();
                            });
                        });
                        row.appendChild(b);
                    }
                    host.appendChild(row);
                });
            }).catch(function () {});
        },

        _taskCard: function (t) {
            var self = this;
            var card = document.createElement('div');
            var isActive = t.id === this.activeId;
            card.style.cssText = 'border:1px solid ' + (isActive ? '#1867C0' : '#1e293b') + ';border-radius:10px;padding:8px 10px;background:' +
                (isActive ? '#0d1a2e' : '#0e1626') + ';';

            var head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:6px;';
            var title = document.createElement('b');
            title.textContent = t.title;
            title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            title.title = t.goal;
            var stage = document.createElement('span');
            stage.textContent = t.stage;
            stage.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:20px;background:' +
                (t.stage === 'done' ? '#14532d' : t.stage === 'failed' ? '#7f1d1d' : t.stage === 'interrupted' ? '#78350f' : '#1e3a8a') + ';';
            head.appendChild(title); head.appendChild(stage);
            card.appendChild(head);

            var meta = document.createElement('div');
            meta.style.cssText = 'color:#94a3b8;font-size:11px;margin:2px 0 6px;';
            meta.textContent = TS.summarize(t).replace(t.title + ' · ', '') +
                ((t.autoContinues || 0) > 0 ? (' · 护栏自动继续 ' + t.autoContinues + '/' + (t.maxAutoContinues || 3)) : '');
            card.appendChild(meta);

            if (t.steps.length) {
                var ul = document.createElement('div');
                ul.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:6px;';
                t.steps.slice(0, 8).forEach(function (s) {
                    var row = document.createElement('div');
                    row.textContent = (s.status === 'done' ? '✅ ' : s.status === 'running' ? '▶️ ' : s.status === 'failed' ? '❌ ' : '○ ') + s.title;
                    row.style.color = s.status === 'done' ? '#86efac' : '#cbd5e1';
                    ul.appendChild(row);
                });
                card.appendChild(ul);
            }

            if (t.artifacts.length) {
                var arts = document.createElement('div');
                arts.style.cssText = 'margin-bottom:6px;';
                t.artifacts.slice(0, 6).forEach(function (a) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:6px;cursor:pointer;color:#93c5fd;';
                    row.textContent = '📄 ' + a.path + ' (+' + a.add + '/-' + a.del + ')';
                    row.title = '查看变更 diff';
                    row.addEventListener('click', function () { self.showDiff(a); });
                    arts.appendChild(row);
                });
                card.appendChild(arts);
            }

            var btns = document.createElement('div');
            btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
            var mk = function (label, fn) {
                var b = document.createElement('button');
                b.textContent = label;
                b.style.cssText = 'background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;';
                b.addEventListener('click', fn);
                btns.appendChild(b);
            };
            if (t.stage === 'interrupted' || t.stage === 'paused') mk('▶ 继续', function () { self.resume(t); });
            if (t.stage === 'executing') mk('⏸ 暂停', function () { self.pause(t); });
            mk('🩺 验证', function () { self.verify(t); });
            mk('🗑', function () { self.remove(t); });
            card.appendChild(btns);
            return card;
        },

        showDiff: function (art) {
            var old = document.getElementById('taskDiffModal');
            if (old) old.remove();
            var m = document.createElement('div');
            m.id = 'taskDiffModal';
            m.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
            var box = document.createElement('div');
            box.style.cssText = 'width:min(900px,92vw);max-height:80vh;display:flex;flex-direction:column;background:#0b1220;color:#e2e8f0;border:1px solid #1e293b;border-radius:12px;overflow:hidden;';
            var bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111a30;border-bottom:1px solid #1e293b;';
            var t = document.createElement('b');
            t.textContent = art.path + '  (+' + art.add + ' / -' + art.del + ')';
            t.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            var close = document.createElement('button');
            close.textContent = '✕';
            close.style.cssText = 'background:#1f2a44;color:#e2e8f0;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;';
            close.addEventListener('click', function () { m.remove(); });
            bar.appendChild(t); bar.appendChild(close);
            var pre = document.createElement('pre');
            pre.style.cssText = 'margin:0;padding:10px 12px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;';
            pre.textContent = art.diff || '（无 diff 内容）';
            box.appendChild(bar); box.appendChild(pre);
            m.appendChild(box);
            m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
            document.body.appendChild(m);
        },

        toast: function (msg) {
            try {
                if (window.snackbarStore && typeof snackbarStore.showInfoMessage === 'function') {
                    snackbarStore.showInfoMessage(String(msg).slice(0, 160));
                    return;
                }
            } catch (_) {}
            try { console.log('[task]', msg); } catch (_) {}
        }
    };

    // ── 接线 ────────────────────────────────────────────
    function hook() {
        try {
            var ag = (typeof agentStore !== 'undefined') ? agentStore : (window.__agentStore || window.agentStore);
            if (ag && typeof ag.promptMessage === 'function' && !ag.__taskHooked) {
                var orig = ag.promptMessage.bind(ag);
                ag.promptMessage = function (conv, opts) {
                    // 子代理有独立上下文：不注入任务指令，也不因它自动建任务
                    if (opts && opts.sub) return Promise.resolve(orig(conv, opts));
                    return Promise.resolve(orig(conv, opts)).then(function (out) { return TaskCenter.inject(out); });
                };
                ag.__taskHooked = true;
            }
        } catch (_) {}
        try {
            var ms = (typeof mcpStore !== 'undefined') ? mcpStore : window.mcpStore;
            if (ms && typeof ms.callTool === 'function' && !ms.__taskHooked) {
                var origCall = ms.callTool.bind(ms);
                ms.callTool = function (name, args) {
                    try { TaskCenter.onToolStart(name, args); } catch (_) {}
                    return Promise.resolve(origCall(name, args)).then(function (res) {
                        try { TaskCenter.onToolEnd(name, args, res, null); } catch (_) {}
                        return res;
                    }, function (err) {
                        try { TaskCenter.onToolEnd(name, args, null, err); } catch (_) {}
                        throw err;
                    });
                };
                ms.__taskHooked = true;
            }
        } catch (_) {}
    }

    window.TaskCenter = TaskCenter;
    function boot() {
        TaskCenter.mount();
        hook();
        TaskCenter.load();
        // 界面可能晚于脚本初始化（agentStore/mcpStore 在其它模块里）：再补挂一次
        setTimeout(hook, 1500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
