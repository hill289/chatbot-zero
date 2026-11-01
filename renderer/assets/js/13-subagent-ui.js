        // ══════════════════════════════════════════════════════════
        // Subagent 多窗口（简略，与主逻辑一致）
        // ══════════════════════════════════════════════════════════
        const subagentWindowActions = {
            clearConversation() {
                if (this.conversation.length === 0) {
                    snackbarStore.showWarningMessage('Already empty');
                } else {
                    this.conversation = [];
                    this._mirroredAnswers = 0;
                    this._guardAborted = false;
                    snackbarStore.showSuccessMessage('Subagent chat cleared');
                    renderSubagentChat(this);
                    // 清空（=子窗口里的"新建对话"）后把焦点交还输入框，避免再点输入框没反应
                    try {
                        const inp = this.$el && this.$el.querySelector('.sa-input');
                        if (inp) inp.focus({ preventScroll: true });
                    } catch (_) {}
                }
            },
            stop() {
                this.generating = false;
                snackbarStore.showInfoMessage('Subagent stopped');
                updateSubagentInput(this);
            },
            clearInput() {
                this.userMessage = "";
                this._lastEnterAt = 0;
                const input = this.$el.querySelector('.sa-input');
                if (input) input.value = '';
            },
            DOUBLE_ENTER_MS: 1500,
            _composing: false,
            _composedAt: 0,
            handleKeydown(e) {
                if (!e) return;
                const el = (e.target && typeof e.target.value === 'string') ? e.target : null;
                // 中间按了其他键 → 打断「连续两次回车」的判定
                if (e.key !== "Enter") { this._lastEnterAt = 0; return; }
                // 输入法上屏用的回车：只上屏，但记为「第一次回车」，下一次回车即可发送
                const justComposed = (this._composedAt && (Date.now() - this._composedAt) < 80);
                if (!e.ctrlKey && !e.metaKey &&
                    (e.isComposing || e.keyCode === 229 || this._composing || justComposed)) {
                    this._lastEnterAt = Date.now();
                    this._composedAt = 0;
                    return;
                }
                if (e.repeat) { this._lastEnterAt = 0; return; }
                // Ctrl / Cmd + Enter：始终直接发送
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._lastEnterAt = 0;
                    this.sendMessage();
                    return;
                }
                // Shift + Enter：强制换行，并打断连续回车判定
                if (e.shiftKey) { this._lastEnterAt = 0; return; }

                // 连续两个回车发送：第一个回车正常换行，第二个回车发送。
                // 判定：① 两次间隔 ≤1500ms；② 或「光标在末尾且末行为空行」（不受时间限制）。
                const text = el ? el.value : (this.userMessage || '');
                const hasPayload = (typeof text === 'string' && text.trim() !== '');
                const caret = (el && typeof el.selectionEnd === 'number') ? el.selectionEnd : -1;
                const atEnd = !!el && el.selectionStart === el.selectionEnd && caret === text.length;
                const endsWithBlankLine = atEnd && text.trim() !== '' && /\n[ \t]*$/.test(text);
                const now = Date.now();
                const prev = this._lastEnterAt || 0;
                const paired = prev > 0 && (now - prev) <= (this.DOUBLE_ENTER_MS || 1500);
                this._lastEnterAt = 0;
                if (hasPayload && (paired || (endsWithBlankLine && prev > 0))) {
                    e.preventDefault();
                    this.sendMessage();
                } else {
                    this._lastEnterAt = now;
                }
            },
            sendMessage() {
                if (this.isRunningTask || this.taskQueue.length > 0) {
                    snackbarStore.showWarningMessage('Subagent is busy with tasks.');
                    return;
                }
                if (this.userMessage) {
                    this.conversation.push({ content: this.userMessage, role: "user" });
                    this.clearInput();
                    // 手动发起的子代理对话：重置执行护栏计数
                    this._guard = createLoopGuard();
                    this._guard.begin();
                    this._guardAborted = false; // 新一轮运行开始：清除护栏中止标记
                    this.startInference();
                }
            },
            async startInference() {
                await createCompletion(this.conversation, this.generating, this, { excludeTools: ['run_subagent'] });
                await this.postToolCall();
            },
            async postToolCall() {
                const last = this.conversation[this.conversation.length - 1];
                if (!last || !last.tool_calls || last.tool_calls.length === 0) {
                    if (this.isRunningTask && !this.generating) {
                        this._onTaskComplete();
                    }
                    return;
                }
                // 执行护栏（子代理同样适用）：步数上限 + 重复调用 / 连续失败检测
                if (!this._guard) { this._guard = createLoopGuard(); this._guard.begin(); }
                const guard = this._guard;
                if (guard.steps >= guard.opts.maxSteps) {
                    const reason = 'Subagent 达到单轮工具调用上限（' + guard.opts.maxSteps + ' 轮），已自动中止以防跑偏。';
                    this._guardAborted = true; // 标记为护栏中止：结果不自动带入主对话
                    planStore.noteTrip(reason);
                    this.conversation.push({ role: 'assistant', content: '⛔ 执行护栏中止：' + reason });
                    renderSubagentChat(this);
                    snackbarStore.showWarningMessage(reason);
                    if (this.isRunningTask && !this.generating) this._onTaskComplete();
                    return;
                }
                const verdict = guard.inspect(last.tool_calls);
                if (verdict.action === 'stop') {
                    this._guardAborted = true; // 标记为护栏中止：结果不自动带入主对话
                    planStore.noteTrip(verdict.reason);
                    this.conversation.push({ role: 'assistant', content: '⛔ 执行护栏中止：' + verdict.reason + '（任务未完成，请调整策略后重试）' });
                    renderSubagentChat(this);
                    snackbarStore.showWarningMessage('Subagent 执行护栏已中止：' + verdict.reason);
                    if (this.isRunningTask && !this.generating) this._onTaskComplete();
                    return;
                }
                let tool_called = false;
                let lastErr = false;
                // 先渲染模型请求的工具，执行过程逐个刷新
                renderSubagentChat(this);
                for (let index = 0; index < last.tool_calls.length; index++) {
                    const tool_call = last.tool_calls[index];
                    this._runningToolId = tool_call.id;
                    renderSubagentChat(this);
                    const _traceT0 = traceNow(); // 可观测：记录本次工具调用开始时刻
                    try {
                        const result0 = await mcpStore.callTool(tool_call.function.name, tool_call.function.arguments);
                        let result = null;
                        try { result = JSON.parse(result0); } catch (e) { /* 非 JSON 结果按空处理 */ }
                        if (result && result.content) {
                            // 失败检测：工具返回 success:false / isError → 结果标签以红色「失败」呈现
                            const isErr = result.success === false || !!result.isError;
                            lastErr = isErr;
                            const errText = isErr ? toolContentText(result.content) : '';
                            this.contentConvert(result.content, tool_call.id, { error: isErr, errorText: errText }).forEach(item => {
                                this.conversation.push(item);
                            });
                            tool_called = true;
                            if (result.sessionRestart) this._pendingRestart = result.sessionRestart;
                        } else {
                            this.conversation.push({
                                role: "tool",
                                content: mcpStore.packReturn(`Tool returned no usable content: ${result0}`).content,
                                tool_call_id: tool_call.id
                            });
                            tool_called = true;
                            lastErr = true;
                        }
                    } catch (error) {
                        this.conversation.push({
                            role: "tool",
                            content: mcpStore.packReturn(`Error calling tool: ${error}`).content,
                            tool_call_id: tool_call.id,
                            _toolError: true,
                            _toolErrorText: (error && error.message) || String(error)
                        });
                        tool_called = true;
                        lastErr = true;
                    }
                    traceStampToolResult(this.conversation, tool_call.id, _traceT0, traceNow()); // 可观测：回写本次耗时
                    this._runningToolId = null;
                    renderSubagentChat(this);
                }

                // 执行护栏：累计步数 + 连续失败判定；命中则记入计划并中止本任务
                const errStop = guard.commit(last.tool_calls, lastErr);
                if (verdict.action === 'nudge') {
                    this.conversation.push({
                        role: 'user',
                        content: '<loop-guard>\n' + verdict.reason + '。请勿重复同一操作：改用其它方式或先总结现状。\n</loop-guard>',
                        _sysNote: true,
                        _sysNoteKind: 'guard',
                        _sysNoteText: '执行护栏提醒模型（第 ' + guard._repeat + ' 次重复）：' + verdict.reason
                    });
                    renderSubagentChat(this);
                }
                if (errStop) {
                    const reason = 'Subagent 同一工具连续 ' + guard._errRepeat + ' 次返回失败，已自动中止以防无谓重试。';
                    this._guardAborted = true; // 标记为护栏中止：结果不自动带入主对话
                    planStore.noteTrip(reason);
                    this.conversation.push({ role: 'assistant', content: '⛔ 执行护栏中止：' + reason });
                    renderSubagentChat(this);
                    snackbarStore.showWarningMessage(reason);
                    if (this.isRunningTask && !this.generating) this._onTaskComplete();
                    return;
                }

                // 工具请求「重开会话」→ 清空/保留上下文，注入交接信息，自动在新会话里继续执行
                if (this._pendingRestart) {
                    const req = this._pendingRestart;
                    this._pendingRestart = null;
                    if (!req.keepContext) this.conversation = [];
                    const _parts = [];
                    if (req.summary) _parts.push('【Handoff summary / 交接摘要】\n' + req.summary);
                    if (req.nextTask) _parts.push('【Next task / 本会话任务】\n' + req.nextTask);
                    this.conversation.push({ role: 'user', content: _parts.join('\n\n') || '继续执行未完成的任务。' });
                    this._mirroredAnswers = 0;
                    renderSubagentChat(this);
                    this.startInference();
                    return;
                }
                if (tool_called) {
                    this.startInference();
                }
                if (!tool_called && this.isRunningTask && !this.generating) {
                    this._onTaskComplete();
                }
            },
            contentConvert(content, toolCallId, opts) {
                const err = !!(opts && opts.error);
                const errText = (opts && opts.errorText) ? opts.errorText : '';
                const extra = err ? { _toolError: true, _toolErrorText: errText || toolContentText(content) || 'Tool call failed' } : {};
                const msg = content.map(item => mcpStore.convertItem(item));
                if (msg.find(item => item.type === 'image_url')) {
                    return [{
                        role: "tool",
                        content: 'Image provided in next user message',
                        tool_call_id: toolCallId,
                        ...extra
                    }, {
                        role: "user",
                        content: msg
                    }];
                } else {
                    return [{
                        role: "tool",
                        content: msg.map(item => item.text).join('\n'),
                        tool_call_id: toolCallId,
                        ...extra
                    }];
                }
            },
            exportConversation() {
                if (this.conversation.length === 0) {
                    snackbarStore.showWarningMessage('No messages to export');
                    return;
                }
                const blob = new Blob([JSON.stringify(this.conversation, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `subagent-chat-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                snackbarStore.showSuccessMessage('Exported subagent chat');
            },
            importConversation() {
                const input = this.$el.querySelector('.sa-json-input');
                if (input) input.click();
            },
            loadConversationJson(data) {
                let messages = [];
                if (Array.isArray(data)) {
                    if (data.length > 0 && data[0] && Array.isArray(data[0].history)) {
                        // 完整历史导出：[{ id, history: [...] }, ...] → 取第一条对话
                        const first = data.find(item => item && Array.isArray(item.history) && item.history.length > 0);
                        messages = first ? first.history : [];
                    } else if (data.length > 0 && data[0] && data[0].role) {
                        // 单条对话导出：[{ role, content, ... }, ...]
                        messages = data;
                    }
                }
                if (messages.length === 0) {
                    snackbarStore.showErrorMessage('无法识别的 JSON 格式：请导入 Query History 导出的对话文件');
                    return;
                }
                this.conversation = messages;
                this._mirroredAnswers = 0;
                this.isRunningTask = false;
                this.taskQueue = [];
                this.isProcessing = false;
                this.generating = false;
                snackbarStore.showSuccessMessage('已导入 ' + messages.length + ' 条消息到 subagent 对话');
                renderSubagentChat(this);
            },
            runTask(task, context) {
                return new Promise((resolve, reject) => {
                    this.taskQueue.push({ task, context, resolve, reject });
                    this.processQueue();
                });
            },
            _onTaskComplete() {
                if (this.isRunningTask) {
                    const last = this.conversation.filter(m => m.role === 'assistant').pop();
                    const result = last ? last.content : 'No response.';
                    const resolve = this._taskResolve;
                    this.isRunningTask = false;
                    this._taskResolve = null;
                    this._taskReject = null;
                    if (resolve) resolve(result);
                    // Super-agent（模块 2）：Worker 完成任务 → 向 Router 汇报（若已接入 Worker 池；否则安全 no-op）
                    try {
                        if (typeof window !== 'undefined' && window.workerPool && typeof window.workerPool.report === 'function') {
                            window.workerPool.report(this.id, { status: 'done', summary: result });
                        }
                    } catch (_) {}
                }
                this.isProcessing = false;
                this.processQueue();
            },
            _onTaskError(err) {
                if (this.isRunningTask) {
                    const reject = this._taskReject;
                    this.isRunningTask = false;
                    this._taskResolve = null;
                    this._taskReject = null;
                    if (reject) reject(err);
                }
                this.isProcessing = false;
                this.processQueue();
            },
            processQueue() {
                if (this.isProcessing) return;
                if (this.taskQueue.length === 0) return;
                this.isProcessing = true;
                const next = this.taskQueue.shift();
                const { task, context, resolve, reject } = next;
                this.isRunningTask = true;
                this._taskResolve = resolve;
                this._taskReject = reject;
                this.conversation = [];
                this._mirroredAnswers = 0;
                // 每个新任务重置执行护栏（避免上一个任务的计数污染新任务）
                this._guard = createLoopGuard();
                this._guard.begin();
                this._guardAborted = false; // 新任务开始：清除护栏中止标记
                const fullMessage = task + (context ? '\n\nContext: ' + context : '');
                this.conversation.push({ content: fullMessage, role: 'user' });
                this.startInference().catch(err => this._onTaskError(err));
            },
            resetTaskState() {
                this.isRunningTask = false;
                this.taskQueue = [];
                this._taskResolve = null;
                this._taskReject = null;
                this.isProcessing = false;
                this.generating = false;
                this.conversation = [];
                this._mirroredAnswers = 0;
                this._guard = createLoopGuard();
                this._guard.begin();
                this._guardAborted = false;
            }
        };

        const subagentStore = {
            windows: [],
            _idSeq: 0,
            _zTop: 0,
            _drag: null,
            _resize: null,
            hidden: false,
            createWindow(title) {
                const id = ++this._idSeq;
                const w = Math.min(820, window.innerWidth * 0.94);
                const h = Math.min(580, window.innerHeight * 0.82);
                const baseX = 70 + ((id - 1) % 6) * 46;
                const baseY = 50 + ((id - 1) % 6) * 38;
                const win = {
                    id,
                    title: title || `Subagent ${id}`,
                    x: Math.max(6, Math.min(baseX, window.innerWidth - w - 12)),
                    y: Math.max(6, Math.min(baseY, window.innerHeight - h - 12)),
                    z: ++this._zTop,
                    width: w,
                    height: h,
                    conversation: [],
                    userMessage: "",
                    generating: false,
                    isRunningTask: false,
                    _taskResolve: null,
                    _taskReject: null,
                    taskQueue: [],
                    isProcessing: false,
                    _mirroredAnswers: 0,
                    _guardAborted: false, // 上一次运行是否被「执行护栏」中止（中止的结果不自动带入主对话）
                    hidden: false
                };
                for (const key in subagentWindowActions) {
                    win[key] = subagentWindowActions[key].bind(win);
                }
                this.windows.push(win);
                this.buildWindowDom(win);
                updateSpeedDial();
                return win;
            },
            buildWindowDom(win) {
                const el = elFromHTML(`
                    <div class="subagent-window" style="left:${win.x}px;top:${win.y}px;z-index:${win.z};width:${win.width}px;height:${win.height}px;">
                        <div class="subagent-header">
                            <span class="sa-title">🤖 ${escapeHtml(win.title)}<span class="sa-sub">(independent session)</span></span>
                            <button class="sa-hide" title="Hide window (restore via ⚙️ menu)">–</button>
                            <button class="sa-close">✕</button>
                        </div>
                        <div class="subagent-toolbar">
                            <button class="sa-tb-btn sa-clear">🗑️ Clear</button>
                            <button class="sa-tb-btn sa-import">📥 Import Json</button>
                            <button class="sa-tb-btn sa-export">⬇️ Export</button>
                            <span class="sa-spacer"></span>
                            <span class="sa-badge sa-pending" style="display:none;">0 pending</span>
                        </div>
                        <div class="subagent-chat-area"></div>
                        <div class="sa-task-banner" style="display:none;">⏳ Subagent is executing task... (please wait)</div>
                        <div class="subagent-input-area">
                            <textarea class="sa-input" placeholder="Type a message..." rows="1"></textarea>
                            <button class="subagent-send-btn sa-send">▲</button>
                        </div>
                        <div class="subagent-resize-handle">⌟</div>
                        <input type="file" class="sa-json-input" accept="application/json,.json" style="display:none;">
                    </div>
                `);
                win.$el = el;
                document.getElementById('subagentContainer').appendChild(el);

                el.querySelector('.sa-close').addEventListener('click', () => this.removeWindow(win.id));
                el.querySelector('.sa-hide').addEventListener('click', () => this.toggleWindowHidden(win.id));
                el.addEventListener('mousedown', () => this.bringToFront(win.id));
                const saInput = el.querySelector('.sa-input');
                saInput.addEventListener('input', function() {
                    win.userMessage = saInput.value;
                    updateSubagentInput(win);
                });
                saInput.addEventListener('keydown', (e) => win.handleKeydown(e));
                // 中文输入法组词状态（回车用于上屏时不换行/不发送）
                saInput.addEventListener('compositionstart', () => { win._composing = true; });
                saInput.addEventListener('compositionend', () => {
                    win._composing = false;
                    win._composedAt = Date.now();
                });
                // 点击子窗口输入区（非按钮/非输入框本身）也把焦点交还 textarea，
                // 修复「点空白处后光标落不回输入框」。点击 textarea 仍走浏览器默认行为（可精确定位光标）。
                const saInputArea = el.querySelector('.subagent-input-area');
                if (saInputArea) {
                    const saFocus = () => { try { saInput.focus({ preventScroll: true }); } catch (_) {} };
                    saInputArea.addEventListener('mousedown', function (e) {
                        if (e.button !== 0) return;
                        if (e.target === saInput) return;
                        if (e.target && e.target.closest && e.target.closest('button, input, select, a, label, [contenteditable="true"]')) return;
                        e.preventDefault();
                        saFocus();
                    });
                    saInputArea.addEventListener('click', function (e) {
                        if (e.target && e.target.closest && e.target.closest('button, input, select, a, label')) return;
                        if (document.activeElement === saInput) return;
                        setTimeout(function () {
                            if (document.activeElement !== saInput) saFocus();
                        }, 0);
                    });
                }
                el.querySelector('.sa-send').addEventListener('click', () => win.sendMessage());
                el.querySelector('.sa-clear').addEventListener('click', () => win.clearConversation());
                el.querySelector('.sa-import').addEventListener('click', () => win.importConversation());
                el.querySelector('.sa-export').addEventListener('click', () => win.exportConversation());
                const jsonInput = el.querySelector('.sa-json-input');
                jsonInput.addEventListener('change', function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        try {
                            const data = JSON.parse(event.target.result);
                            win.loadConversationJson(data);
                        } catch (err) {
                            snackbarStore.showErrorMessage('无法解析 JSON 文件: ' + err.message);
                        }
                    };
                    reader.readAsText(file);
                    jsonInput.value = '';
                });
                el.querySelector('.subagent-header').addEventListener('mousedown', (e) => this.startDrag(win, e));
                el.querySelector('.subagent-resize-handle').addEventListener('mousedown', (e) => this.startResize(win, e));

                renderSubagentChat(win);
            },
            openWindow() {
                const win = this.createWindow();
                setTimeout(() => {
                    const input = win.$el.querySelector('.sa-input');
                    if (input) input.focus();
                }, 0);
                return win;
            },
            removeWindow(id) {
                const idx = this.windows.findIndex(w => w.id === id);
                if (idx === -1) return;
                const win = this.windows[idx];
                if (win.isRunningTask && win._taskReject) {
                    win._taskReject(new Error('Subagent window was closed.'));
                    win.isRunningTask = false;
                    win._taskResolve = null;
                    win._taskReject = null;
                    win.isProcessing = false;
                }
                if (win.$el && win.$el.remove) win.$el.remove();
                this.windows.splice(idx, 1);
                if (this.windows.length === 0) this.hidden = false;
                updateSpeedDial();
            },
            bringToFront(id) {
                const win = this.windows.find(w => w.id === id);
                if (win && win.z < this._zTop) {
                    win.z = ++this._zTop;
                    win.$el.style.zIndex = win.z;
                }
            },
            toggleWindowHidden(id) {
                const win = this.windows.find(w => w.id === id);
                if (!win) return;
                win.hidden = !win.hidden;
                win.$el.classList.toggle('hidden-win', win.hidden);
                updateSpeedDial();
            },
            hideAllWindows() {
                this.hidden = true;
                this.windows.forEach(win => {
                    win.hidden = true;
                    win.$el.classList.add('hidden-win');
                });
                updateSpeedDial();
            },
            showHiddenWindows() {
                this.hidden = false;
                this.windows.forEach(win => {
                    if (win.hidden) {
                        win.hidden = false;
                        win.$el.classList.remove('hidden-win');
                    }
                });
                updateSpeedDial();
            },
            startDrag(win, e) {
                if (e.button !== 0) return;
                e.preventDefault();
                this.bringToFront(win.id);
                this._drag = {
                    win,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: win.x,
                    origY: win.y,
                    px: e.clientX,
                    py: e.clientY,
                    raf: 0
                };
                this._dragMoveHandler = this._onDragMove.bind(this);
                this._dragEndHandler = this._onDragEnd.bind(this);
                // move 用 passive 监听：回调里不做 preventDefault，减少主线程开销
                document.addEventListener('mousemove', this._dragMoveHandler, { passive: true });
                document.addEventListener('mouseup', this._dragEndHandler);
            },
            // 应用拖拽位移（供 rAF 合帧与拖拽结束补帧复用）
            _applyDrag(d) {
                const win = d.win;
                if (!win || !win.$el) return;
                win.x = d.origX + (d.px - d.startX);
                win.y = d.origY + (d.py - d.startY);
                win.$el.style.left = win.x + 'px';
                win.$el.style.top = win.y + 'px';
            },
            _onDragMove(e) {
                const d = this._drag;
                if (!d) return;
                // mousemove 频率远高于屏幕刷新率，逐个事件写 left/top 会造成大量同步重排/重绘。
                // 这里只记录最新指针位置，合并到下一帧统一写入。
                d.px = e.clientX;
                d.py = e.clientY;
                if (d.raf) return;
                d.raf = requestAnimationFrame(() => {
                    if (this._drag !== d) return;
                    d.raf = 0;
                    this._applyDrag(d);
                });
            },
            _onDragEnd() {
                const d = this._drag;
                if (d) {
                    if (d.raf) cancelAnimationFrame(d.raf);
                    d.raf = 0;
                    this._applyDrag(d); // 应用最后位置，避免丢帧导致的偏移
                }
                this._drag = null;
                if (this._dragMoveHandler) document.removeEventListener('mousemove', this._dragMoveHandler);
                if (this._dragEndHandler) document.removeEventListener('mouseup', this._dragEndHandler);
                this._dragMoveHandler = null;
                this._dragEndHandler = null;
            },

            startResize(win, e) {
                if (e.button !== 0) return;
                e.preventDefault();
                this.bringToFront(win.id);
                this._resize = {
                    win,
                    startX: e.clientX,
                    startY: e.clientY,
                    origW: win.width,
                    origH: win.height,
                    px: e.clientX,
                    py: e.clientY,
                    raf: 0
                };
                this._resizeMoveHandler = this._onResizeMove.bind(this);
                this._resizeEndHandler = this._onResizeEnd.bind(this);
                // move 用 passive 监听：回调里不做 preventDefault，减少主线程阻塞
                document.addEventListener('mousemove', this._resizeMoveHandler, { passive: true });
                document.addEventListener('mouseup', this._resizeEndHandler);
            },
            // 应用尺寸变化（供 rAF 合帧与拖拽结束补帧复用）
            _applyResize(r) {
                const win = r.win;
                if (!win || !win.$el) return;
                win.width = Math.min(window.innerWidth * 0.96, Math.max(480, r.origW + (r.px - r.startX)));
                win.height = Math.min(window.innerHeight * 0.92, Math.max(320, r.origH + (r.py - r.startY)));
                win.$el.style.width = win.width + 'px';
                win.$el.style.height = win.height + 'px';
            },
            _onResizeMove(e) {
                const r = this._resize;
                if (!r) return;
                // 仅记录最新指针位置，合并到下一帧统一写样式，避免频繁重排
                r.px = e.clientX;
                r.py = e.clientY;
                if (r.raf) return;
                r.raf = requestAnimationFrame(() => {
                    if (this._resize !== r) return;
                    r.raf = 0;
                    this._applyResize(r);
                });
            },
            _onResizeEnd() {
                const r = this._resize;
                if (r) {
                    if (r.raf) cancelAnimationFrame(r.raf);
                    r.raf = 0;
                    this._applyResize(r); // 应用最后位置，避免丢帧导致的偏移
                }
                this._resize = null;
                if (this._resizeMoveHandler) document.removeEventListener('mousemove', this._resizeMoveHandler);
                if (this._resizeEndHandler) document.removeEventListener('mouseup', this._resizeEndHandler);
                this._resizeMoveHandler = null;
                this._resizeEndHandler = null;
            },

            openAndSend(task, context = '') {
                const win = this.createWindow();
                win.userMessage = task + (context ? '\n\nContext: ' + context : '');
                const input = win.$el.querySelector('.sa-input');
                if (input) input.value = win.userMessage;
                updateSubagentInput(win);
                win.sendMessage();
                return win;
            },
            openAndRunTask(task, context = '') {
                const win = this.createWindow();
                return win.runTask(task, context);
            },
            runTask(task, context) {
                return this.openAndRunTask(task, context);
            },
            resetTaskState() {
                this.windows.forEach(win => { if (win.$el && win.$el.remove) win.$el.remove(); });
                this.windows = [];
                this._idSeq = 0;
                this._zTop = 0;
                this._drag = null;
                this._resize = null;
                this.hidden = false;
            }
        };

        // ══════════════════════════════════════════════════════════
        // 主窗口发送前：自动带入仍未关闭（可隐藏）的 subagent 窗口的最新结果
        //   - 只遍历 subagentStore.windows —— 关闭的窗口已从数组移除，无需再获取
        //   - 隐藏（hidden-win）窗口仍在数组中 → 同样获取
        //   - 被「执行护栏」中止（_guardAborted）的窗口跳过：结果不带入、不自动关闭
        //   - 按每个窗口“已完成的最终回复”增量同步：每次主窗口发送只带入
        //     上次同步之后新出现的最终回复（多轮对话 → 多条消息）
        // ══════════════════════════════════════════════════════════
        function collectSubagentResults() {
            const results = [];
            if (typeof subagentStore === 'undefined' || !subagentStore || !Array.isArray(subagentStore.windows)) {
                return results;
            }
            subagentStore.windows.forEach(win => {
                // 正在执行任务 / 正在生成中的窗口内容不完整，本次跳过（下次发送时再补上）
                if (!win || win.isRunningTask || win.generating || (win.taskQueue && win.taskQueue.length > 0)) return;
                // 被「执行护栏」中止的子代理：结果不自动带入主对话，也不自动关闭（保留给用户处理）
                // 只有阀值不到、正常结束的 subagent 才允许主 agent 接过其结果
                if (win._guardAborted) return;
                if (!win.conversation || win.conversation.length === 0) return;

                // 收集该窗口中所有“最终回复”：assistant 且正文非空、且没有待执行的工具调用
                const answers = [];
                (win.conversation || []).forEach(m => {
                    if (!m || m.role !== 'assistant') return;
                    if (m.tool_calls && m.tool_calls.length > 0) return;
                    const text = Array.isArray(m.content)
                        ? m.content.filter(c => c && typeof c.text === 'string').map(c => c.text).join('\n')
                        : (m.content || '');
                    if (text && text.trim()) answers.push(text.trim());
                });
                if (answers.length === 0) return;

                const synced = win._mirroredAnswers || 0;
                if (answers.length <= synced) return;

                // 只取上次带入以来的新结果（窗口多轮对话 → 按轮数生成多条主对话消息）
                const newAnswers = answers.slice(synced);
                win._mirroredAnswers = answers.length;

                const hasCustomTitle = !!(win.title && win.title !== ('Subagent ' + win.id));
                const label = hasCustomTitle ? `Subagent ${win.id} · ${win.title}` : `Subagent ${win.id}`;
                newAnswers.forEach((text) => {
                    results.push({
                        role: 'user',
                        content: `[${label} 最终结果]\n${text}`,
                        _subagent: true,
                        _subagentId: win.id,
                        _subagentTitle: hasCustomTitle ? win.title : (`Subagent ${win.id}`)
                    });
                });
            });
            return results;
        }

        // ══════════════════════════════════════════════════════════
        // 主窗口带入 subagent 结果后：自动关闭“本次已同步结果”的 subagent 窗口
        //   - 只关闭本次产生了新结果并被带入主对话（含 _subagentId）的窗口
        //   - 正在执行任务 / 正在生成中的窗口不会出现在 importedResults 中 → 保持打开，
        //     待其完成后用户再次在主窗口发送时再带入并自动关闭
        //   - 关闭窗口会将其从 subagentStore.windows 移除并更新速度拨盘 UI
        // ══════════════════════════════════════════════════════════
        function autoCloseSubagentWindows(importedResults) {
            if (!importedResults || importedResults.length === 0) return 0;
            if (typeof subagentStore === 'undefined' || !subagentStore || !Array.isArray(subagentStore.windows)) {
                return 0;
            }
            const importedIds = new Set();
            importedResults.forEach(r => {
                if (r && r._subagentId != null) importedIds.add(r._subagentId);
            });
            if (importedIds.size === 0) return 0;

            let closed = 0;
            // 逆序遍历，避免 removeWindow 内部 splice 造成索引偏移
            for (let i = subagentStore.windows.length - 1; i >= 0; i--) {
                const win = subagentStore.windows[i];
                if (win && importedIds.has(win.id)) {
                    subagentStore.removeWindow(win.id);
                    closed++;
                }
            }
            return closed;
        }



        function renderSubagentChat(win) {
            const area = win.$el.querySelector('.subagent-chat-area');
            area.innerHTML = '';
            if (win.conversation.length === 0) {
                area.innerHTML = `
                    <div class="subagent-empty-state">
                        <span class="sa-empty-emoji">🤖</span>
                        <span>Start a conversation with the subagent</span>
                        <span class="sa-empty-sub">Messages are independent from the main chat</span>
                    </div>
                `;
            } else {
                const seqMap = buildToolSeqMap(win.conversation);
                const groups = groupMessages(win.conversation);
                groups.forEach(group => {
                    if (group.group === 'sysnote') {
                        const sm = elFromHTML('<div class="sa-message"></div>');
                        const isGuard = group.message._sysNoteKind === 'guard';
                        sm.innerHTML = '<div style="margin:4px 8px;padding:5px 10px;border-radius:6px;background:' +
                            (isGuard ? '#fef2f2' : '#f0f7ff') + ';border-left:3px solid ' + (isGuard ? '#C62828' : '#1867C0') +
                            ';color:' + (isGuard ? '#C62828' : '#1867C0') + ';font-size:12px;white-space:pre-wrap;word-break:break-word;">' +
                            (isGuard ? '🛡️ ' : '🧭 ') +
                            escapeHtml(String(group.message._sysNoteText != null ? group.message._sysNoteText : (group.message.content || ''))) +
                            '</div>';
                        area.appendChild(sm);
                        return;
                    }
                    if (group.group === 'tool') {
                        group.messages.forEach((msg, mi) => {
                            const m = elFromHTML('<div class="sa-message"></div>');
                            m.__msg = msg;
                            const emoji = msg.role === 'tool' ? '🔧' : '⚡';
                            const cls = msg.role === 'tool' ? 'tool' : 'assistant';
                            m.insertAdjacentHTML('beforeend', `<div class="sa-avatar ${cls}">${emoji}</div>`);
                            const c = elFromHTML('<div class="sa-content"></div>');
                            if (msg.role === 'tool') {
                                const content = Array.isArray(msg.content) ?
                                    msg.content.map(c => c.text || '').join('\n') :
                                    (msg.content || '');
                                const info = msg.tool_call_id ? seqMap.get(msg.tool_call_id) : null;
                                const seqHtml = info ? `<span class="tool-seq">${info.seq}</span> ` : '';
                                const isErr = isToolErrorMsg(msg);
                                const zh = (typeof languageStore !== 'undefined' && languageStore.locale === 'zhHans');
                                const label = isErr ? (zh ? '工具失败' : 'Tool error') : (zh ? '工具结果' : 'Tool result');
                                const icon = isErr ? '❌' : '🔧';
                                // 长文本优化：结果内容分段折叠渲染（超长 read_file 输出不再一次性塞入 DOM）
                                const resultEl = document.createElement('div');
                                resultEl.className = 'sa-tool-result' + (isErr ? ' sa-tool-error' : '');
                                const headEl = document.createElement('span');
                                headEl.setAttribute('style', 'font-weight:600;' + (isErr ? 'color:#b91c1c;' : 'color:#64748b;'));
                                headEl.innerHTML = icon + ' ' + seqHtml + escapeHtml(label) + ':';
                                resultEl.appendChild(headEl);
                                resultEl.appendChild(buildTextBlock(content, '', 'white-space:pre-wrap;word-break:break-word;'));
                                c.appendChild(resultEl);
                            } else {
                                if (msg.reasoning_content) c.insertAdjacentHTML('beforeend',
                                    `<div class="sa-reasoning">${escapeHtml(msg.reasoning_content)}</div>`
                                    );
                                if (msg.content) c.appendChild(renderMarkdown(msg.content));
                                if (msg.tool_calls) {
                                    msg.tool_calls.forEach(tc => {
                                        const info = tc && tc.id ? seqMap.get(tc.id) : null;
                                        const seqHtml = info ? `<span class="tool-seq">${info.seq}</span> ` : '';
                                        c.insertAdjacentHTML('beforeend',
                                            `<div class="sa-tool-chip">🔧 ${seqHtml}<strong>${escapeHtml(tc.function.name)}</strong>(${escapeHtml(tc.function.arguments)})</div>`
                                            );
                                        if (tc.id && win._runningToolId === tc.id) {
                                            c.insertAdjacentHTML('beforeend', '<div class="sa-tool-running">⏳ 执行中…</div>');
                                        }
                                    });
                                }
                            }
                            m.appendChild(c);
                            area.appendChild(m);
                        });
                    } else {
                        const msg = group.message;
                        const m = elFromHTML('<div class="sa-message"></div>');
                        m.__msg = msg;
                        const emoji = msg.role === 'user' ? '👤' : '⚡';
                        const cls = msg.role === 'user' ? 'user' : 'assistant';
                        m.insertAdjacentHTML('beforeend', `<div class="sa-avatar ${cls}">${emoji}</div>`);
                        const c = elFromHTML('<div class="sa-content"></div>');
                        if (msg.role === 'user') {
                            c.appendChild(buildTextBlock(msg.content, 'sa-text'));
                        } else {
                            if (msg.reasoning_content) c.insertAdjacentHTML('beforeend',
                                `<div class="sa-reasoning">${escapeHtml(msg.reasoning_content)}</div>`
                                );
                            if (msg.content) c.appendChild(renderMarkdown(msg.content));
                            if (msg.tool_calls && msg.tool_calls.length > 0) {
                                msg.tool_calls.forEach(tc => {
                                    const info = tc && tc.id ? seqMap.get(tc.id) : null;
                                    const seqHtml = info ? `<span class="tool-seq">${info.seq}</span> ` : '';
                                    c.insertAdjacentHTML('beforeend',
                                        `<div class="sa-tool-chip">🔧 ${seqHtml}<strong>${escapeHtml(tc.function.name)}</strong>(${escapeHtml(tc.function.arguments)})</div>`
                                        );
                                    if (tc.id && win._runningToolId === tc.id) {
                                        c.insertAdjacentHTML('beforeend', '<div class="sa-tool-running">⏳ 执行中…</div>');
                                    }
                                });
                            }
                        }
                        m.appendChild(c);
                        area.appendChild(m);
                    }
                });
            }
            const pending = win.taskQueue.length;
            const pendingEl = win.$el.querySelector('.sa-pending');
            const banner = win.$el.querySelector('.sa-task-banner');
            if (pendingEl) {
                pendingEl.style.display = pending > 0 ? '' : 'none';
                pendingEl.textContent = `${pending} pending`;
            }
            if (banner) banner.style.display = win.isRunningTask ? '' : 'none';
            area.scrollTop = area.scrollHeight;
            updateSubagentInput(win);
        }

        // Subagent 流式增量渲染
        //   旧实现：每个 chunk 都重建整条消息 + renderMarkdown(全量累积正文) + escapeHtml(全量思考)
        //   → O(n²)，思考/正文越长越卡（正是「子窗口卡死浏览器」的根因）。
        //   新实现：rAF 合帧 + 只在末尾卡片上增量追加文本节点（O(增量)），
        //   流结束后再由 finalizeSubagentStreaming 一次性补 markdown/高亮。
        function scheduleSubagentStreaming(win) {
            // 按窗口合帧：同一帧内到达的多个 chunk 只重绘一次（多个子窗口并行时互不影响）
            if (win._saStreamPending) return;
            win._saStreamPending = true;
            win._saStreamRaf = requestAnimationFrame(() => {
                win._saStreamPending = false;
                win._saStreamRaf = 0;
                updateSubagentStreaming(win);
            });
        }

        function updateSubagentStreaming(win) {
            const area = win.$el.querySelector('.subagent-chat-area');
            const lastMsg = win.conversation[win.conversation.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant') return;
            const groups = groupMessages(win.conversation);
            const lastGroup = groups[groups.length - 1];
            if (!lastGroup) return;
            if (lastGroup.group !== 'assistant') { renderSubagentChat(win); return; }

            // 定位本消息的流式卡片；不存在（如刚被 renderSubagentChat 完整渲染过）就重建一张
            // 干净的流式卡片，并移除同一消息的旧卡片，避免重复显示。
            let lastEl = area.querySelector('.sa-message.sa-streaming');
            if (!lastEl || lastEl.__msg !== lastMsg) {
                const existing = area.querySelectorAll('.sa-message');
                for (let i = existing.length - 1; i >= 0; i--) {
                    if (existing[i].__msg === lastMsg) { existing[i].remove(); break; }
                }
                lastEl = elFromHTML('<div class="sa-message sa-streaming"></div>');
                lastEl.__msg = lastMsg;
                lastEl.insertAdjacentHTML('beforeend', '<div class="sa-avatar assistant">⚡</div>');
                lastEl.appendChild(elFromHTML('<div class="sa-content"></div>'));
                area.appendChild(lastEl);
                // 新卡片 → 计数器归零（相对当前消息）
                lastMsg._saRLen = 0;
                lastMsg._saCLen = 0;
                lastMsg._saTCnt = 0;
                lastMsg._saArgLens = [];
            }
            const c = lastEl.querySelector('.sa-content');

            // 1) 思考过程增量（单文本节点 appendData，O(增量)；仅接近底部时自动跟随）
            const reasoning = lastMsg.reasoning_content || '';
            const rLen = lastMsg._saRLen || 0;
            if (reasoning.length > rLen) {
                let rEl = c.querySelector('.sa-reasoning');
                if (!rEl) {
                    rEl = elFromHTML('<div class="sa-reasoning"></div>');
                    c.insertBefore(rEl, c.firstChild);
                }
                appendReasoningDelta(rEl, reasoning.slice(rLen));
                lastMsg._saRLen = reasoning.length;
                if (rEl.scrollHeight - rEl.scrollTop - rEl.clientHeight < 40) rEl.scrollTop = rEl.scrollHeight;
            }

            // 2) 正文增量（流式阶段纯文本；结束后 renderSubagentChat 统一 markdown/高亮）
            const content = lastMsg.content || '';
            const cLen = lastMsg._saCLen || 0;
            if (content.length > cLen) {
                let md = c.querySelector('.sa-md');
                if (!md) {
                    md = elFromHTML('<div class="sa-md" style="white-space:pre-wrap;"></div>');
                    c.appendChild(md);
                }
                if (!md.__textNode) { md.__textNode = document.createTextNode(''); md.appendChild(md.__textNode); }
                md.__textNode.appendData(content.slice(cLen));
                lastMsg._saCLen = content.length;
            }

            // 3) 工具调用徽章增量（arguments 逐字符流入）
            const toolCalls = lastMsg.tool_calls || [];
            if (toolCalls.length > 0) {
                let box = c.querySelector('.sa-tool-chips');
                if (!box) { box = elFromHTML('<div class="sa-tool-chips"></div>'); c.appendChild(box); }
                if (!lastMsg._saArgLens) lastMsg._saArgLens = [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    let chip = box.querySelector('.sa-tool-chip[data-idx="' + i + '"]');
                    if (!chip) {
                        chip = elFromHTML('<div class="sa-tool-chip" data-idx="' + i + '">🔧 <strong class="tool-name"></strong>(<span class="tool-args"></span>)</div>');
                        box.appendChild(chip);
                    }
                    const nameEl = chip.querySelector('.tool-name');
                    const nm = (tc.function && tc.function.name) || '';
                    if (nameEl.textContent !== nm) nameEl.textContent = nm;
                    const args = (tc.function && tc.function.arguments) || '';
                    const prev = lastMsg._saArgLens[i] || 0;
                    if (args.length > prev) {
                        chip.querySelector('.tool-args').appendChild(document.createTextNode(args.slice(prev)));
                        lastMsg._saArgLens[i] = args.length;
                    }
                }
                lastMsg._saTCnt = toolCalls.length;
            }

            area.scrollTop = area.scrollHeight;
            updateSubagentInput(win);
        }

        // 流结束：子窗口对最后一条 assistant 消息做一次完整渲染（markdown + 高亮 + 工具 tab）
        //   先取消仍挂起的流式 rAF，避免它在完整渲染之后又把卡片覆盖回纯文本。
        function finalizeSubagentStreaming(win) {
            if (win._saStreamPending && win._saStreamRaf) {
                cancelAnimationFrame(win._saStreamRaf);
                win._saStreamPending = false;
                win._saStreamRaf = 0;
            }
            renderSubagentChat(win);
        }

        function updateSubagentInput(win) {
            const send = win.$el.querySelector('.sa-send');
            if (!send) return;
            send.disabled = !win.userMessage || win.generating;
            send.innerHTML = win.generating ? '<div class="loading"></div>' : '▲';
        }

