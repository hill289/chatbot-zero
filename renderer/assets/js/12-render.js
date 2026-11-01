        // ══════════════════════════════════════════════════════════
        // 渲染函数（增量更新）
        // ══════════════════════════════════════════════════════════
        function escapeHtml(text) {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
            return String(text == null ? '' : text).replace(/[&<>"']/g, m => map[m]);
        }
        // ══════════════════════════════════════════════════════════
        // 长文本折叠展示（展示层优化）
        //   read_file 等工具可能一次返回几十万字符。若直接写入 DOM，浏览器需要为
        //   每个字符计算换行/布局，极易卡死页面。这里对超过阈值的文本先只渲染前
        //   TOOL_TEXT_PREVIEW_LIMIT 个字符，完整文本保存在闭包中，用户点击
        //   「展开全部」后才写入 DOM。
        //   仅作用于渲染，不修改 conversation 内容，也不改变消息发送逻辑。
        // ══════════════════════════════════════════════════════════
        const TOOL_TEXT_PREVIEW_LIMIT = 20000;

        function buildTextBlock(text, className, styleStr) {
            const raw = text == null ? '' : String(text);
            const el = document.createElement('div');
            if (className) el.className = className;
            if (styleStr) el.setAttribute('style', styleStr);

            // 短文本：与原逻辑一致，直接渲染
            if (raw.length <= TOOL_TEXT_PREVIEW_LIMIT) {
                el.textContent = raw;
                return el;
            }

            // 长文本：先渲染头部，其余折叠，点击按钮后再写入
            el.classList.add('long-text');
            const head = document.createElement('span');
            head.textContent = raw.slice(0, TOOL_TEXT_PREVIEW_LIMIT);
            const rest = document.createElement('span');
            rest.style.display = 'none';
            // 延迟写入：折叠部分在首次「展开全部」时才创建文本节点（仅展示层优化，
            // 展开后内容与原来完全一致），避免超长工具结果在渲染阶段就产生巨量文本节点。
            let restFilled = false;
            const restText = raw.slice(TOOL_TEXT_PREVIEW_LIMIT);

            const bar = document.createElement('div');
            bar.className = 'long-text-bar';
            const info = document.createElement('span');
            info.className = 'long-text-info';
            const syncInfo = (expanded) => {
                info.textContent = expanded
                    ? '已展开全部 ' + raw.length + ' 字符'
                    : '已省略 ' + (raw.length - TOOL_TEXT_PREVIEW_LIMIT) + ' 字符（共 ' + raw.length + ' 字符）';
            };
            syncInfo(false);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'long-text-toggle';
            btn.textContent = '展开全部';
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const expand = rest.style.display === 'none';
                // 首次展开时才写入折叠文本节点（延迟创建，避免渲染阶段一次性产生巨量文本）
                if (expand && !restFilled) { rest.textContent = restText; restFilled = true; }
                rest.style.display = expand ? '' : 'none';
                el.classList.toggle('long-text-expanded', expand);
                btn.textContent = expand ? '收起' : '展开全部';
                syncInfo(expand);
            });
            bar.appendChild(info);
            bar.appendChild(btn);

            el.appendChild(head);
            el.appendChild(rest);
            el.appendChild(bar);
            return el;
        }

        // ══════════════════════════════════════════════════════════
        // 思考过程增量写入（展示层优化）
        //   旧实现用 textarea.value += delta 并每帧读取 scrollHeight 自适应高度：
        //     · value += delta 每次重写整段字符串 → O(n²)；
        //     · 每帧 scrollHeight 触发强制重排，且 textarea 无限增高 → 思考越长越卡。
        //   改为「单个文本节点 + appendData」的 O(增量) 追加，并由 CSS 限制可视高度内部滚动。
        //   超过 REASONING_DOM_MAX 时仅保留末尾部分（完整文本仍在对话数据中，不影响发送）。
        // ══════════════════════════════════════════════════════════
        const REASONING_DOM_MAX = 40000;
        function appendReasoningDelta(container, delta) {
            let node = container.__reasonNode;
            if (!node || node.parentNode !== container) {
                container.textContent = '';
                node = document.createTextNode('');
                container.__reasonNode = node;
                container.appendChild(node);
            }
            node.appendData(delta);
            if (node.data.length > REASONING_DOM_MAX * 1.5) {
                const dropped = node.data.length - REASONING_DOM_MAX;
                node.data = '\u2026\uff08\u5df2\u7701\u7565\u524d ' + dropped + ' \u5b57\uff0c\u5b8c\u6574\u5185\u5bb9\u4ecd\u4fdd\u7559\u5728\u5bf9\u8bdd\u6570\u636e\u4e2d\uff09\u2026\n' + node.data.slice(-REASONING_DOM_MAX);
            }
        }


        function groupMessages(conversation) {
            const groups = [];
            conversation.forEach((message, index) => {
                if (message._sysNote) {
                    groups.push({ index: index, group: 'sysnote', message: message });
                } else if (message.role === 'user') {
                    groups.push({ index: index, group: 'user', message: message });
                } else if (message.role === 'assistant' && (!message.tool_calls || message.tool_calls.length === 0)) {
                    groups.push({ index: index, group: 'assistant', message: message });
                } else {
                    const lastGroup = groups[groups.length - 1];
                    if (lastGroup && lastGroup.group === 'tool') {
                        lastGroup.messages.push(message);
                        lastGroup.length += 1;
                    } else {
                        const id = message.tool_call_id || (message.tool_calls && message.tool_calls[0] ? message
                            .tool_calls[0].id : 'tool-' + index);
                        groups.push({
                            index: index,
                            group: 'tool',
                            tab: id,
                            messages: [message],
                            length: 1
                        });
                    }
                }
            });
            return groups;
        }

        // 工具调用/结果序号映射：扫描整段对话，按 tool_calls 出现的先后顺序编号（1,2,3…）。
        // 结果消息通过 tool_call_id 反查 → 保证「调用标签」与「结果标签」的序号一致，便于对应。
        function buildToolSeqMap(conversation) {
            const map = new Map(); // tool_call_id -> { seq, name }
            if (!Array.isArray(conversation)) return map;
            let seq = 0;
            for (const m of conversation) {
                if (!m || !Array.isArray(m.tool_calls)) continue;
                for (const tc of m.tool_calls) {
                    seq++;
                    if (tc && tc.id) {
                        map.set(tc.id, {
                            seq: seq,
                            name: (tc.function && tc.function.name) || 'tool'
                        });
                    }
                }
            }
            return map;
        }


        // 工具内容文本提取：把 content（数组 / 字符串）规整为纯文本
        function toolContentText(content) {
            if (content == null) return '';
            if (Array.isArray(content)) {
                return content.map(c => (c && typeof c.text === 'string') ? c.text : (typeof c === 'string' ? c : '')).join('\n');
            }
            if (typeof content === 'string') return content;
            return '';
        }

        // 判断一条 role=tool 消息是否为失败结果：
        //  - 新数据：执行时标记了 _toolError
        //  - 旧数据/历史数据兼容：我们自己写入的异常前缀 "Error calling tool:"
        function isToolErrorMsg(msg) {
            if (!msg) return false;
            if (msg._toolError === true) return true;
            const text = toolContentText(msg.content).trim();
            return /^Error calling tool:/.test(text);
        }

        // 工具标签种类徽标：调用 / 结果 / 失败 / 执行中（跟随界面语言，颜色区分）
        function toolKindChip(kind) {
            const zh = (typeof languageStore !== 'undefined' && languageStore.locale === 'zhHans');
            const icons = { call: '➡️', result: '⬅️', error: '❌', running: '⏳' };
            const words = { call: zh ? '调用' : 'Call', result: zh ? '结果' : 'Result', error: zh ? '失败' : 'Error', running: zh ? '执行中' : 'Run' };
            return '<span class="tool-kind tool-kind-' + kind + '">' + (icons[kind] || '') + ' ' + (words[kind] || kind) + '</span>';
        }

        // ══════════════════════════════════════════════════════════
        // 工具调用可观测性：耗时采集 + 可回放轨迹视图（Tool Trace Replay）
        //  · 采集：在每次工具执行前后打点，把开始/结束/耗时写回该 tool 结果消息；
        //    消息随 conversation 一起落盘（historyStore.save），刷新或切换历史后仍可回放。
        //  · 回放：把整段对话还原成一条时间线（甘特图），支持逐步 / 自动播放，
        //    每一步都可查看参数与结果，并可一键在对话区定位到对应工具卡片。
        // ══════════════════════════════════════════════════════════
        function traceNow() { return Date.now(); }

        // 把一次工具调用的起止时间写回它对应的 role=tool 结果消息
        function traceStampToolResult(conversation, toolCallId, t0, t1) {
            if (!Array.isArray(conversation) || !toolCallId) return;
            for (let i = conversation.length - 1; i >= 0; i--) {
                const m = conversation[i];
                if (m && m.role === 'tool' && m.tool_call_id === toolCallId) {
                    m._toolStartedAt = t0;
                    m._toolEndedAt = t1;
                    m._toolDurationMs = Math.max(0, t1 - t0);
                    return;
                }
            }
        }

        // 从整段对话重建「工具调用时间线」：按 tool_calls 出现顺序编号，结果按 tool_call_id 归位
        function buildToolTimeline(conversation) {
            const rows = [];
            const byId = new Map();
            if (!Array.isArray(conversation)) return rows;
            let seq = 0;
            for (const m of conversation) {
                if (!m || !Array.isArray(m.tool_calls)) continue;
                for (const tc of m.tool_calls) {
                    seq++;
                    const row = {
                        seq: seq,
                        id: (tc && tc.id) || '',
                        name: (tc && tc.function && tc.function.name) || 'tool',
                        args: (tc && tc.function && tc.function.arguments) || '',
                        startedAt: null, endedAt: null, durationMs: null,
                        result: null, error: false, errorText: ''
                    };
                    if (row.id) byId.set(row.id, row);
                    rows.push(row);
                }
            }
            for (const m of conversation) {
                if (!m || m.role !== 'tool' || !m.tool_call_id) continue;
                const row = byId.get(m.tool_call_id);
                if (!row) continue;
                row.result = toolContentText(m.content);
                row.error = isToolErrorMsg(m);
                row.errorText = m._toolErrorText || '';
                if (typeof m._toolStartedAt === 'number') row.startedAt = m._toolStartedAt;
                if (typeof m._toolEndedAt === 'number') row.endedAt = m._toolEndedAt;
                if (typeof m._toolDurationMs === 'number') row.durationMs = m._toolDurationMs;
            }
            return rows;
        }

        function traceFmtMs(ms) {
            if (ms == null) return '—';
            if (ms < 1000) return ms + ' ms';
            return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
        }

        function tracePretty(s) {
            if (s == null || s === '') return '（无参数）';
            try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return String(s); }
        }

        // 把某次工具调用定位到对话区对应的工具卡片：激活该 tab 并滚动到可见处
        function traceLocateInChat(toolCallId) {
            if (!toolCallId) return;
            const conv = (typeof messageStore !== 'undefined' && Array.isArray(messageStore.conversation))
                ? messageStore.conversation : [];
            const groups = groupMessages(conv);
            for (const g of groups) {
                if (!g || !g.messages) continue;
                const items = [];
                g.messages.forEach(msg => {
                    if (msg.role === 'tool') items.push({ kind: 'result', id: msg.tool_call_id || '' });
                    else (msg.tool_calls || []).forEach(tc => items.push({ kind: 'call', id: (tc && tc.id) || '' }));
                });
                const idx = items.findIndex(it => it.id === toolCallId);
                if (idx < 0) continue;
                if (!messageStore._toolTabActive) messageStore._toolTabActive = {};
                messageStore._toolTabActive[g.index] = idx;
                renderConversation();
                const tabId = 'tg-' + g.index + '-' + idx;
                const el = document.querySelector('.tool-tab[data-tab="' + tabId + '"]') ||
                    document.querySelector('.tool-panel[data-panel="' + tabId + '"]');
                if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
        }

        function copyTraceText(text, label) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(
                        () => snackbarStore.showSuccessMessage((label || '内容') + '已复制'),
                        () => snackbarStore.showWarningMessage('复制失败，请手动选择')
                    );
                    return;
                }
            } catch (_) { /* 忽略，走下方兜底提示 */ }
            snackbarStore.showWarningMessage('当前环境不支持剪贴板复制');
        }

        // ── 回放控制器 ──
        const traceStore = {
            rows: [],
            index: -1,
            playing: false,
            speed: 1,
            sync: false,
            _timer: null,

            build() {
                this.rows = buildToolTimeline(messageStore.conversation);
                if (this.rows.length === 0) this.index = -1;
                else if (this.index < 0 || this.index >= this.rows.length) this.index = 0;
                return this.rows;
            },
            current() { return this.rows[this.index] || null; },
            totalMs() { return this.rows.reduce((s, r) => s + (r.durationMs || 0), 0); },
            maxDur() { return this.rows.reduce((m, r) => Math.max(m, r.durationMs || 0), 0) || 1; },
            span() {
                const ts = this.rows.map(r => r.startedAt).filter(t => typeof t === 'number');
                if (ts.length < 2) return 0;
                return Math.max.apply(null, ts) - Math.min.apply(null, ts);
            },
            select(i, opts) {
                if (this.rows.length === 0) return;
                this.index = Math.max(0, Math.min(this.rows.length - 1, i));
                this.render();
                const row = this.current();
                if (row && ((opts && opts.locate) || this.sync)) traceLocateInChat(row.id);
            },
            play() {
                if (this.rows.length === 0 || this.playing) return;
                if (this.index >= this.rows.length - 1) this.index = -1; // 播到底后再点 = 从头播放
                this.playing = true;
                this._syncPlayBtn();
                this._schedule();
            },
            pause() {
                this.playing = false;
                if (this._timer) { clearTimeout(this._timer); this._timer = null; }
                this._syncPlayBtn();
            },
            toggle() { this.playing ? this.pause() : this.play(); },
            _schedule() {
                if (!this.playing) return;
                const next = this.index + 1;
                if (next >= this.rows.length) {
                    this.index = this.rows.length - 1;
                    this.render();
                    this.pause();
                    return;
                }
                this.index = next;
                this.render();
                const row = this.current();
                if (row && this.sync) traceLocateInChat(row.id);
                const dur = (row && typeof row.durationMs === 'number') ? row.durationMs : 350;
                const delay = Math.min(3000, Math.max(180, dur)) / this.speed;
                this._timer = setTimeout(() => this._schedule(), delay);
            },
            _syncPlayBtn() {
                const btn = document.getElementById('tracePlay');
                if (btn) btn.innerHTML = this.playing ? '⏸ 暂停' : '▶ 播放';
            },
            render() {
                const list = document.getElementById('traceList');
                if (!list) return;
                const detail = document.getElementById('traceDetail');
                const head = document.getElementById('traceHead');
                const clock = document.getElementById('traceClock');
                const prog = document.querySelector('#traceProgress > i');
                if (this.rows.length === 0) {
                    list.innerHTML = '<div class="trace-empty">当前对话还没有工具调用。<br>发起一次带工具调用的对话后，这里会显示可回放的执行轨迹。</div>';
                    if (detail) detail.innerHTML = '';
                    if (head) head.innerHTML = '暂无轨迹数据';
                    if (clock) clock.textContent = '0 / 0';
                    if (prog) prog.style.width = '0%';
                    return;
                }
                const maxDur = this.maxDur();
                const span = this.span();
                const tsAll = this.rows.map(r => (typeof r.startedAt === 'number' ? r.startedAt : Infinity));
                const t0 = Math.min.apply(null, tsAll);
                const finite = isFinite(t0);
                list.innerHTML = this.rows.map((r, i) => {
                    const hasDur = (typeof r.durationMs === 'number');
                    const w = hasDur ? Math.max(3, Math.round(r.durationMs / maxDur * 100)) : 30;
                    let left = 0;
                    if (finite && span > 0 && typeof r.startedAt === 'number') {
                        left = Math.max(0, Math.min(97, (r.startedAt - t0) / span * 100));
                    }
                    const cls = 'tr-row' + (i === this.index ? ' active' : '') + (r.error ? ' err' : '') + (r.result == null ? ' running' : '');
                    return '<div class="' + cls + '" data-index="' + i + '">' +
                        '<span class="tr-seq">#' + r.seq + '</span>' +
                        '<span class="tr-name" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) +
                            '<span class="tr-sub">' + (r.id ? escapeHtml(String(r.id).substring(0, 8)) : '') + '</span></span>' +
                        '<span class="tr-gantt"><i style="left:' + left.toFixed(1) + '%;width:' + w.toFixed(1) + '%"></i></span>' +
                        '<span class="tr-dur"><span class="tr-dot"></span>' + traceFmtMs(hasDur ? r.durationMs : null) + '</span>' +
                    '</div>';
                }).join('');
                list.querySelectorAll('.tr-row').forEach(el => {
                    el.addEventListener('click', () => {
                        this.pause();
                        this.select(parseInt(el.getAttribute('data-index'), 10));
                    });
                });
                const okCount = this.rows.filter(r => r.result != null && !r.error).length;
                const errCount = this.rows.filter(r => r.error).length;
                const names = new Set(this.rows.map(r => r.name));
                if (head) {
                    head.innerHTML =
                        '<span class="trace-chip">调用 ' + this.rows.length + '</span>' +
                        '<span class="trace-chip ok">成功 ' + okCount + '</span>' +
                        (errCount ? '<span class="trace-chip err">失败 ' + errCount + '</span>' : '') +
                        '<span>工具 ' + names.size + ' 个</span>' +
                        '<span>累计耗时 ' + traceFmtMs(this.totalMs()) + '</span>' +
                        (this.span() > 0 ? '<span>墙钟跨度 ' + traceFmtMs(this.span()) + '</span>' : '');
                }
                if (clock) clock.textContent = (this.index + 1) + ' / ' + this.rows.length;
                if (prog) prog.style.width = ((this.index + 1) / this.rows.length * 100).toFixed(1) + '%';
                this.renderDetail();
            },
            renderDetail() {
                const detail = document.getElementById('traceDetail');
                if (!detail) return;
                const r = this.current();
                if (!r) { detail.innerHTML = '<div class="trace-empty">选择左侧任意一次调用查看详情。</div>'; return; }
                const status = r.error ? '❌ 失败' : (r.result == null ? '⏳ 执行中 / 无结果' : '✅ 成功');
                const when = (typeof r.startedAt === 'number')
                    ? new Date(r.startedAt).toLocaleTimeString('zh-Hans', { hour12: false })
                    : '—';
                const resultText = r.error && r.errorText ? r.errorText : (r.result == null ? '（等待结果…）' : r.result);
                detail.innerHTML =
                    '<div class="td-meta">' +
                        '<div><b>#' + r.seq + ' ' + escapeHtml(r.name) + '</b> ' + status + '</div>' +
                        '<div>耗时：<b>' + traceFmtMs(r.durationMs) + '</b>　开始：' + when + '</div>' +
                        (r.id ? '<div>tool_call_id：<code>' + escapeHtml(r.id) + '</code></div>' : '') +
                    '</div>' +
                    '<div class="td-sec"><h4>➡️ 参数</h4><pre>' + escapeHtml(tracePretty(r.args)) + '</pre></div>' +
                    '<div class="td-sec"><h4>⬅️ 结果</h4><pre>' + escapeHtml(resultText) + '</pre></div>' +
                    '<div><button class="trace-btn" id="traceLocate">在对话中定位</button> ' +
                    '<button class="trace-btn" id="traceCopyStep">复制本步</button></div>';
                const loc = document.getElementById('traceLocate');
                if (loc) loc.addEventListener('click', () => { this.pause(); traceLocateInChat(r.id); });
                const cp = document.getElementById('traceCopyStep');
                if (cp) cp.addEventListener('click', () => copyTraceText(JSON.stringify(r, null, 2), '本步轨迹'));
            }
        };

        function openTraceDialog() {
            traceStore.pause();
            traceStore.build();
            const modal = document.getElementById('traceModal');
            if (modal) modal.classList.add('open');
            traceStore.render();
            traceStore._syncPlayBtn();
        }

        function wireTraceDialog() {
            const modal = document.getElementById('traceModal');
            if (!modal || modal._traceWired) return;
            modal._traceWired = true;
            const $ = id => document.getElementById(id);
            const first = $('traceFirst'), prev = $('tracePrev'), next = $('traceNext'), last = $('traceLast');
            if (first) first.addEventListener('click', () => { traceStore.pause(); traceStore.select(0); });
            if (prev) prev.addEventListener('click', () => { traceStore.pause(); traceStore.select(traceStore.index - 1); });
            if (next) next.addEventListener('click', () => { traceStore.pause(); traceStore.select(traceStore.index + 1); });
            if (last) last.addEventListener('click', () => { traceStore.pause(); traceStore.select(traceStore.rows.length - 1); });
            const play = $('tracePlay');
            if (play) play.addEventListener('click', () => traceStore.toggle());
            const speed = $('traceSpeed');
            if (speed) speed.addEventListener('change', () => { traceStore.speed = parseFloat(speed.value) || 1; });
            const sync = $('traceSync');
            if (sync) sync.addEventListener('change', () => { traceStore.sync = !!sync.checked; });
            const refresh = $('traceRefresh');
            if (refresh) refresh.addEventListener('click', () => { traceStore.pause(); traceStore.build(); traceStore.render(); });
            const copy = $('traceCopy');
            if (copy) copy.addEventListener('click', () => copyTraceText(JSON.stringify(traceStore.rows, null, 2), '轨迹 JSON'));
            const dl = $('traceDownload');
            if (dl) dl.addEventListener('click', () => {
                try {
                    const blob = new Blob([JSON.stringify(traceStore.rows, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = 'tool-trace.json'; a.click();
                    URL.revokeObjectURL(url);
                } catch (e) { snackbarStore.showErrorMessage('导出失败：' + (e && e.message ? e.message : e)); }
            });
            const prog = $('traceProgress');
            if (prog) prog.addEventListener('click', (e) => {
                const n = traceStore.rows.length;
                if (!n) return;
                const rect = prog.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                traceStore.pause();
                traceStore.select(Math.round(ratio * (n - 1)));
            });
            modal.addEventListener('click', (e) => { if (e.target === modal) traceStore.pause(); });
            const closeBtn = modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.addEventListener('click', () => traceStore.pause());
            // 键盘：空格播放/暂停，←/→ 步进，Esc 关闭（焦点在输入框时不拦截）
            document.addEventListener('keydown', (e) => {
                if (!modal.classList.contains('open')) return;
                const tgt = e.target || {};
                const tag = (tgt.tagName || '').toUpperCase();
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tgt.isContentEditable) return;
                if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); traceStore.toggle(); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); traceStore.pause(); traceStore.select(traceStore.index + 1); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); traceStore.pause(); traceStore.select(traceStore.index - 1); }
                else if (e.key === 'Escape') { traceStore.pause(); modal.classList.remove('open'); }
            });
        }


        // ══════════════════════════════════════════════════════════
        // Markdown → DOM 渲染缓存
        //   相同文本（历史消息在整体重建 / 语言切换 / 编辑后重渲染时）直接复用
        //   已解析 + 已高亮后的 HTML，跳过 marked.parse 与 hljs 高亮这两处最耗时的
        //   步骤——这是长对话反复重建时的主要卡顿来源之一。
        //   仅缓存中小文本，避免超长内容占用过多内存。
        // ══════════════════════════════════════════════════════════
        const _mdCache = new Map();
        const _MD_CACHE_MAX = 200;
        const _MD_CACHE_BUDGET = 4000000; // 缓存内容总字符预算（约 4M），防止内存膨胀
        let _mdCacheChars = 0;
        // 净化不可信 HTML（模型输出 / 文档正文 / 网页抓取内容）：
        // 走 renderer/sanitize.js 的白名单重建；净化器缺失时 fail-closed（按纯文本渲染），
        // 绝不把 marked.parse() 的原始结果直接塞进 innerHTML。
        function sanitizeUntrustedHtml(html) {
            if (typeof window !== 'undefined' && window.SafeHtml &&
                typeof window.SafeHtml.sanitizeHtml === 'function') {
                return window.SafeHtml.sanitizeHtml(html);
            }
            return null; // 交由调用方降级为纯文本
        }

        function renderMarkdown(text) {
            const src = text || '';
            let html = _mdCache.get(src);
            const div = elFromHTML('<div class="md-preview"></div>');
            if (html === undefined) {
                const parsed = marked.parse(src);
                const safe = sanitizeUntrustedHtml(parsed);
                if (safe === null) {
                    // 净化器未加载：降级为纯文本（保留换行），宁可少渲染也不执行不可信 HTML
                    html = '<div class="md-fallback" style="white-space:pre-wrap;">' + escapeHtml(src) + '</div>';
                    _mdCache.set(src, html);
                    div.innerHTML = html;
                    return div;
                }
                html = safe;
                const tmp = elFromHTML('<div class="md-preview"></div>');
                tmp.innerHTML = html;
                tmp.querySelectorAll('pre code').forEach(code => {
                    const language = (code.className || '').replace('language-', '') || 'text';
                    try { hljs.highlightElement(code); } catch (e) {}
                    const header = elFromHTML(
                        `<div class="code-header"><span class="code-language">${escapeHtml(language)}</span><button class="copy-btn">Copy</button></div>`
                        );
                    const pre = code.closest('pre');
                    if (pre && pre.parentNode) pre.parentNode.insertBefore(header, pre);
                });
                html = tmp.innerHTML;
                if (src.length <= 200000) {
                    _mdCache.set(src, html);
                    _mdCacheChars += src.length + html.length;
                    // 超出条数或字符预算 → 淘汰最旧条目
                    while ((_mdCache.size > _MD_CACHE_MAX || _mdCacheChars > _MD_CACHE_BUDGET) && _mdCache.size > 1) {
                        const oldKey = _mdCache.keys().next().value;
                        const oldVal = _mdCache.get(oldKey) || '';
                        _mdCacheChars -= (oldKey.length + oldVal.length);
                        _mdCache.delete(oldKey);
                    }
                }
            }
            div.innerHTML = html;
            div.querySelectorAll('.copy-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const pre = this.closest('.code-header').nextElementSibling;
                    const codeEl = pre ? pre.querySelector('code') : null;
                    if (!codeEl) return;
                    navigator.clipboard.writeText(codeEl.textContent).then(() => {
                        this.classList.add('copied');
                        this.textContent = 'Copied!';
                        setTimeout(() => { this.classList.remove('copied'); this.textContent = 'Copy'; }, 2000);
                    });
                });
            });
            return div;
        }

        async function copyMsg(msg) {
            let textToCopy = '';
            if (typeof msg.content === 'string') {
                textToCopy = msg.content;
            } else if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                    if (item.type === 'text' && typeof item.text === 'string') {
                        textToCopy = item.text;
                    }
                }
            }
            await navigator.clipboard.writeText(textToCopy);
            snackbarStore.showSuccessMessage('$vuetify.dataIterator.snackbar.copied');
        }

        function renderUserContent(msg, body) {
            if (Array.isArray(msg.content)) {
                msg.content.forEach(part => {
                    if (part.type === 'image_url') {
                        const url = part.image_url && part.image_url.url;
                        // 只渲染安全协议的图片（http/https/data:image），挡掉 javascript:/file:/data:text/html
                        const safe = (window.SafeHtml && typeof window.SafeHtml.isSafeUrl === 'function')
                            ? window.SafeHtml.isSafeUrl(url, { image: true })
                            : /^(https?:|data:image\/)/i.test(String(url || ''));
                        if (!safe) return;
                        body.insertAdjacentHTML('beforeend',
                            `<img class="msg-image" src="${escapeHtml(url)}" alt="image">`
                            );
                    } else if (part.type === 'text') {
                        body.appendChild(buildTextBlock(part.text, 'text-pre-wrap'));
                    }
                });
            } else {
                body.appendChild(buildTextBlock(msg.content, 'text-pre-wrap'));
            }
        }

        function renderMessage(msg, index, isSubagent = false, seqMapOverride) {
            const message = elFromHTML('<div class="chat-message"></div>');
            const row = elFromHTML('<div class="message"></div>');
            // 主对话中被自动带入的 subagent 结果消息：🤖 头像 + 紫色卡片样式，便于与普通用户消息区分
            const isSubagentResult = !!msg._subagent;
            const avatarRole = isSubagentResult ? 'subagent' : msg.role;
            const avatarEmoji = msg.role === 'user' ? (isSubagentResult ? '🤖' : '👤') : (msg.role === 'assistant' ? '⚡' : '🔧');
            const avSize = isSubagent ? 28 : settingStore.avatarSize;
            const avatar = elFromHTML(`<div class="message-avatar ${avatarRole}" style="width:${avSize}px;height:${avSize}px;">${avatarEmoji}</div>`);
            if (isSubagent) avatar.classList.add('small');
            row.appendChild(avatar);

            const card = elFromHTML('<div class="message-card' + (isSubagentResult ? ' subagent-card' : '') + '"></div>');
            const body = elFromHTML('<div class="card-content-body"></div>');

            if (msg.reasoning_content) {
                body.insertAdjacentHTML('beforeend', '<div class="reasoning-label" style="font-size:11px;color:#94a3b8;margin-bottom:2px;">💭 思考过程</div>');
                // 限高可滚动区域（CSS 控制 max-height/overflow）：超长思考不再把卡片撑爆
                const ra = elFromHTML('<div class="reasoning-area"></div>');
                ra.textContent = msg.reasoning_content;
                body.appendChild(ra);
            }

            if (msg.role === 'assistant') {
                if (msg.content) {
                    const md = renderMarkdown(msg.content);
                    md.classList.add('assistant-md');
                    body.appendChild(md);
                }
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const seqMap = seqMapOverride || buildToolSeqMap(messageStore.conversation);
                    msg.tool_calls.forEach(tc => {
                        const info = tc && tc.id ? seqMap.get(tc.id) : null;
                        const seqHtml = info ? `<span class="tool-seq">${info.seq}</span> ` : '';
                        body.insertAdjacentHTML('beforeend',
                            `<div style="font-size:12px;color:#64748b;background:#f1f5f9;padding:4px 10px;border-radius:6px;margin:2px 0;">🔧 ${seqHtml}<strong>${escapeHtml(tc.function.name)}</strong>(${escapeHtml(tc.function.arguments)})</div>`
                            );
                    });
                }
            } else if (msg.role === 'tool') {
                const content = Array.isArray(msg.content) ?
                    msg.content.map(c => c.text || '').join('\n') :
                    (msg.content || '');
                const isErr = isToolErrorMsg(msg);
                // 长文本优化：tool 消息正文同样折叠展示
                body.appendChild(buildTextBlock(
                    content,
                    '',
                    'font-size:13px;color:' + (isErr ? '#b91c1c' : '#475569') + ';background:' + (isErr ? '#fef2f2' : '#f8fafc') + ';padding:6px 12px;border-radius:6px;border-left:3px solid ' + (isErr ? '#ef4444' : '#94a3b8') + ';white-space:pre-wrap;word-break:break-word;'
                ));
            } else {
                renderUserContent(msg, body);
            }

            card.appendChild(body);

            if (!isSubagent) {
                const actions = elFromHTML('<div class="card-actions"></div>');
                actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="Copy" data-act="copy">📋</button>');
                if (msg.role === 'user') {
                    actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="Edit" data-act="edit">✏️</button>');
                }
                if (msg.role === 'assistant') {
                    actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="Toggle content" data-act="toggle">👁️</button>');
                }
                actions.insertAdjacentHTML('beforeend', '<span class="act-spacer"></span>');
                if (index > 0) {
                    actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="Trim above" data-act="trim">⬆️</button>');
                }
                actions.insertAdjacentHTML('beforeend', '<button class="act-btn danger" title="Delete" data-act="delete">🗑️</button>');
                card.appendChild(actions);
            }

            row.appendChild(card);
            message.appendChild(row);
            // 知识库（可选）：assistant 消息渲染后追加 [Sn] 引用角标 / 来源列表 /
            // 👍👎 反馈按钮（kb-ui.decorate；不存在或异常时静默跳过）。
            try {
                if (!isSubagent && window.KBUi && typeof window.KBUi.decorate === 'function') {
                    window.KBUi.decorate(message, msg);
                }
            } catch (_) { /* 装饰失败不影响消息渲染 */ }
            return message;
        }

        // 把 tool-group-tabs 中激活的 tab 滚入可视区（重建后 scrollLeft 归零，避免激活 tab 被挤出可视区）
        function scrollActiveTabIntoView(barEl) {
            if (!barEl) return;
            const active = barEl.querySelector('.tool-tab.active');
            if (!active) return;
            const tabEl = active;
            const barRect = barEl.getBoundingClientRect();
            const tabRect = tabEl.getBoundingClientRect();
            if (tabRect.left < barRect.left) {
                barEl.scrollLeft -= (barRect.left - tabRect.left) + 6;
            } else if (tabRect.right > barRect.right) {
                barEl.scrollLeft += (tabRect.right - barRect.right) + 6;
            }
        }

        // 将工具分组展开为有序的「调用 / 结果」条目（每个条目 = 卡片上的一个 tab）：
        //  - 调用条目：每条 tool_call 一个（同一 assistant 消息请求多个工具时也逐个列出，便于编序号）
        //  - 结果条目：每条 role=tool 消息一个（失败结果通过 _toolError / 内容前缀识别，红色「失败」标签）
        // 「删除此后消息」也复用这份条目顺序来确定截断点（tab ↔ 对话消息的映射）。
        function buildToolItems(group, seqMap) {
            const items = [];
            (group.messages || []).forEach(msg => {
                if (msg.role === 'tool') {
                    const content = Array.isArray(msg.content) ?
                        msg.content.map(c => c.text || '').join('\n') :
                        (msg.content || '');
                    const info = msg.tool_call_id ? seqMap.get(msg.tool_call_id) : null;
                    items.push({
                        kind: 'result',
                        msg: msg,
                        tool_call_id: msg.tool_call_id || '',
                        seq: info ? info.seq : null,
                        callName: info ? info.name : null,
                        content: content,
                        error: isToolErrorMsg(msg),
                        errorText: (msg._toolErrorText && msg._toolErrorText !== content) ? msg._toolErrorText : ''
                    });
                } else {
                    const tcs = (msg.tool_calls && msg.tool_calls.length) ? msg.tool_calls : [];
                    tcs.forEach((tc, ti) => {
                        const info = tc && tc.id ? seqMap.get(tc.id) : null;
                        items.push({
                            kind: 'call',
                            msg: msg,
                            tc: tc,
                            seq: info ? info.seq : null,
                            callName: (tc && tc.function && tc.function.name) || 'tool',
                            note: (ti === 0) ? { reasoning: msg.reasoning_content || '', content: msg.content || '' } : null,
                            error: false,
                            errorText: ''
                        });
                    });
                }
            });
            return items;
        }

        function renderToolGroup(group, isLastGroup = false, seqMapOverride) {
            const message = elFromHTML('<div class="chat-message"></div>');
            const row = elFromHTML('<div class="message"></div>');
            row.insertAdjacentHTML('beforeend', '<div class="message-avatar tool">🔧</div>');
            const card = elFromHTML('<div class="message-card"></div>');
            const body = elFromHTML('<div class="card-content-body"></div>');
            const groupEl = elFromHTML('<div class="tool-group"></div>');
            const tabs = elFromHTML('<div class="tool-group-tabs"></div>');
            const panels = elFromHTML('<div class="tool-panels"></div>');

            // 工具调用/结果全局序号：按整段对话中 tool_calls 的出现顺序编号（1,2,3…），
            // 结果消息通过 tool_call_id 反查同一序号 → 「调用标签」与「结果标签」序号一致，便于对应。
            const convAll = (typeof messageStore !== 'undefined' && Array.isArray(messageStore.conversation))
                ? messageStore.conversation : null;
            const seqMap = seqMapOverride || buildToolSeqMap(convAll || group.messages);

            // 活动 tab 跟随执行状态，而不是固定第一个：
            // 1) 正在执行的工具(_runningToolId) 属于本组 → 末尾追加一个「⏳ 执行中」临时 tab 并激活，
            //    完成后被真实结果 tab 原位替换，永不跳回第一个
            // 2) 用户手动点过某个 tab → 重建后恢复该 tab（_toolTabActive 按分组索引记录）
            // 3) 否则默认跟随最新消息 tab（最新结果/最新一轮）——历史分组也不会回到第一个
            const runningTc = messageStore._runningToolId ?
                group.messages.flatMap(m => m.tool_calls || []).find(tc => tc.id === messageStore._runningToolId) || null :
                null;

            // 将分组消息展开为「调用 / 结果」条目（顺序 = 卡片上 tab 的顺序，见 buildToolItems）
            const items = buildToolItems(group, seqMap);

            let activeIdx;
            if (runningTc) {
                activeIdx = items.length; // 临时执行 tab 位于末尾
            } else {
                const stored = messageStore._toolTabActive && messageStore._toolTabActive[group.index];
                if (typeof stored === 'number' && stored >= 0 && stored < items.length) {
                    activeIdx = stored; // 恢复用户手动选择的 tab
                } else {
                    activeIdx = items.length - 1; // 默认跟随最新
                }
            }

            items.forEach((item, idx) => {
                const tabId = 'tg-' + group.index + '-' + idx;
                const isActive = idx === activeIdx;
                const seqHtml = item.seq != null ? `<span class="tool-seq">${item.seq}</span> ` : '';
                if (item.kind === 'call') {
                    // 调用标签：➡️ 调用 + 序号 + 工具名（靛蓝系，与结果标签明显区分）
                    tabs.insertAdjacentHTML('beforeend',
                        `<div class="tool-tab tool-tab-call ${isActive ? 'active' : ''}" data-tab="${tabId}" title="${escapeHtml(item.tc && item.tc.id ? item.tc.id : '')}">${toolKindChip('call')} ${seqHtml}${escapeHtml(item.callName)}</div>`
                        );
                    const panel = elFromHTML(`<div class="tool-panel ${isActive ? 'active' : ''}" data-panel="${tabId}"></div>`);
                    if (item.note && item.note.reasoning) {
                        panel.insertAdjacentHTML('beforeend',
                            `<div class="tool-sub" style="color:#999;font-style:italic;">${escapeHtml(item.note.reasoning)}</div>`
                            );
                    }
                    if (item.note && item.note.content) {
                        panel.insertAdjacentHTML('beforeend',
                            `<div style="font-weight:600;margin-bottom:6px;">${escapeHtml(item.note.content)}</div>`);
                    }
                    const tc = item.tc || {};
                    const fn = tc.function || {};
                    // 工具调用参数同样做长文本折叠（write_file 等大参数不再一次性渲染）
                    panel.appendChild(buildTextBlock(
                        (tc.id ? tc.id + '\n' : '') + item.callName + '(' + (fn.arguments || '') + ')',
                        'tool-args',
                        'font-family:\'Courier New\',monospace;white-space:pre-wrap;'
                    ));
                    if (tc.id && messageStore._runningToolId === tc.id) {
                        panel.insertAdjacentHTML('beforeend', '<div class="tool-running">⏳ 执行中…</div>');
                    }
                    panels.appendChild(panel);
                } else {
                    // 结果标签：⬅️ 结果 / ❌ 失败 + 序号 + 工具名（绿系成功 / 红系失败）
                    const isError = !!item.error;
                    const kind = isError ? 'error' : 'result';
                    const label = item.callName || (item.tool_call_id ? String(item.tool_call_id).substring(0, 8) : 'result');
                    const zh = (typeof languageStore !== 'undefined' && languageStore.locale === 'zhHans');
                    const kindTitle = isError ? (zh ? '失败' : 'Error') : (zh ? '结果' : 'Result');
                    tabs.insertAdjacentHTML('beforeend',
                        `<div class="tool-tab tool-tab-${kind} ${isActive ? 'active' : ''}" data-tab="${tabId}" title="${escapeHtml('[' + kindTitle + '] ' + (item.tool_call_id || ''))}">${toolKindChip(kind)} ${seqHtml}${escapeHtml(label)}</div>`
                        );
                    const panel = elFromHTML(`<div class="tool-panel ${isActive ? 'active' : ''}${isError ? ' tool-panel-error' : ''}" data-panel="${tabId}"></div>`);
                    if (item.tool_call_id) panel.insertAdjacentHTML('beforeend', `<div class="tool-sub">${escapeHtml(item.tool_call_id)}</div>`);
                    if (isError && item.errorText) {
                        panel.insertAdjacentHTML('beforeend',
                            `<div class="tool-error-banner"><span class="tool-error-icon">⚠️</span><span class="tool-error-msg">${escapeHtml(item.errorText)}</span></div>`
                            );
                    }
                    // 长文本优化：工具结果（如 read_file 的超长输出）先只渲染前若干字符，
                    // 其余内容点击「展开全部」后再写入 DOM —— 展示层优化，不影响 conversation
                    panel.appendChild(buildTextBlock(
                        item.content,
                        'tool-args',
                        'white-space:pre-wrap;background:' + (isError ? '#fef2f2' : '#f9fafb') + ';border-left:3px solid ' + (isError ? '#ef4444' : '#1867C0') + ';'
                    ));
                    panels.appendChild(panel);
                }
            });

            // 正在执行的工具 → 末尾追加「⏳ 执行中」临时 tab（结果返回后由真实结果 tab 原位替换）
            if (runningTc) {
                const pendingId = 'tg-' + group.index + '-run-' + runningTc.id;
                const isActive = activeIdx === items.length;
                const info = runningTc.id ? seqMap.get(runningTc.id) : null;
                const seqHtml = info ? `<span class="tool-seq">${info.seq}</span> ` : '';
                const name = (runningTc.function && runningTc.function.name) || 'tool';
                tabs.insertAdjacentHTML('beforeend',
                    `<div class="tool-tab tool-tab-call ${isActive ? 'active' : ''}" data-tab="${pendingId}">${toolKindChip('running')} ${seqHtml}${escapeHtml(name)}<span style="margin-left:2px;animation:tool-pulse 1s ease-in-out infinite;">⏳</span></div>`
                    );
                panels.insertAdjacentHTML('beforeend',
                    `<div class="tool-panel ${isActive ? 'active' : ''}" data-panel="${pendingId}"><div class="tool-running">⏳ 执行中…</div><div class="tool-args" style="white-space:pre-wrap;background:#f9fafb;border-left:3px solid #f59e0b;">${escapeHtml(name)}(${escapeHtml((runningTc.function && runningTc.function.arguments) || '')})</div></div>`
                    );
            }

            tabs.querySelectorAll('.tool-tab').forEach(tab => {
                // 切换工具 tab 时不要抢走输入框的光标：
                // 这些 tab 是普通 <div>，点击默认会先把焦点交给 body，导致「点过工具 tab 后
                // 再点输入框，光标无法落回 textarea」。阻止 mousedown 的默认聚焦/选区行为，
                // 即可让输入框在切换 tab 期间始终保持可输入状态（click 仍会正常触发下面逻辑）。
                tab.addEventListener('mousedown', (e) => {
                    if (e.button === 0) e.preventDefault();
                });
                tab.addEventListener('click', () => {
                    const panelId = tab.getAttribute('data-tab');
                    tabs.querySelectorAll('.tool-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    panels.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('active'));
                    const targetPanel = panels.querySelector('.tool-panel[data-panel="' + panelId + '"]');
                    if (targetPanel) targetPanel.classList.add('active');
                    // 记住手动选择，重建后恢复（末尾的临时执行 tab 索引 >= items.length，不会被恢复）
                    if (!messageStore._toolTabActive) messageStore._toolTabActive = {};
                    messageStore._toolTabActive[group.index] = Array.from(tabs.children).indexOf(tab);
                });
            });

            groupEl.appendChild(tabs);
            groupEl.appendChild(panels);
            body.appendChild(groupEl);

            const actions = elFromHTML('<div class="card-actions"></div>');
            actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="Copy" data-act="copy">📋</button>');
            actions.insertAdjacentHTML('beforeend', '<span class="act-spacer"></span>');
            // 删除「本工具分组之后」的所有消息并继续对话（截断尾部）：
            //   停止生成后常会留下半截的工具调用/结果，用户希望从某一次工具调用处截断，
            //   并带着输入框里的新要求从这里继续 —— 提供一个动作即可，避免与「仅删除」重复。
            if (!isLastGroup) {
                actions.insertAdjacentHTML('beforeend', '<button class="act-btn" title="删除此工具之后的所有消息并继续对话（以当前选中的 tab 为界，同组后续 tab 一并删除；带入输入框里的新内容）" data-act="trim-below-continue">⏭️</button>');
            }
            actions.insertAdjacentHTML('beforeend', '<button class="act-btn danger" title="Delete group" data-act="delete-group">🗑️</button>');
            card.appendChild(body);
            card.appendChild(actions);
            row.appendChild(card);
            message.appendChild(row);
            return message;
        }

        // ══════════════════════════════════════════════════════════
        // 增量渲染（解决「长对话卡死浏览器」的核心）
        //   renderConversation 不再每次整体清空重建，而是按「分组签名」逐组比对：
        //     · 内容未变化的分组 → 直接复用已有 DOM 节点；
        //     · 内容变化/新增的分组 → 才重新渲染。
        //   这样长对话下每轮新增消息只渲染新卡片，避免对全部历史消息反复执行
        //   markdown 解析 / 代码高亮 / 巨型文本节点重建（原先的卡顿根因）。
        //   消息数据、按钮索引、tab 选择等逻辑完全保持不变（纯展示层优化）。
        //   —— 签名缓存用 WeakMap，不污染发送给 API / 落盘的数据（下划线开头字段会被清洗）。
        // ══════════════════════════════════════════════════════════
        const _convMsgId = new WeakMap();   // 消息对象 → 稳定 id（区分同一位置的不同消息）
        let _convMsgIdSeq = 0;
        function convMsgId(msg) {
            if (!msg || typeof msg !== 'object') return 0;
            let id = _convMsgId.get(msg);
            if (id === undefined) { id = ++_convMsgIdSeq; _convMsgId.set(msg, id); }
            return id;
        }
        const _msgSigCache = new WeakMap(); // 消息对象 → 内容签名（长度未变时复用，避免反复哈希）
        function _arrayContentSig(content) {
            let acc = 'A' + content.length;
            for (let i = 0; i < content.length; i++) {
                const it = content[i];
                if (!it) { acc += '|0'; continue; }
                if (it.type === 'text') acc += '|t' + hashString(it.text || '');
                else if (it.type === 'image_url') { const u = (it.image_url && it.image_url.url) || ''; acc += '|i' + u.length + ':' + hashString(u.slice(-64)); }
                else acc += '|' + (it.type || '');
            }
            return acc;
        }
        function messageContentSig(msg) {
            const content = msg.content;
            const reasoning = msg.reasoning_content || '';
            const e = _msgSigCache.get(msg);
            if (typeof content === 'string' || content == null) {
                const s = content == null ? '' : content;
                // 长度未变则复用上次签名（O(1) 命中）；长度变化才重新哈希
                if (e && e.kind === 's' && e.cLen === s.length && e.rLen === reasoning.length) return e.sig;
                const sig = 's' + s.length + '-' + hashString(s) + '-r' + reasoning.length + '-' + hashString(reasoning);
                _msgSigCache.set(msg, { kind: 's', cLen: s.length, rLen: reasoning.length, sig: sig });
                return sig;
            }
            const sig = _arrayContentSig(content) + '-r' + reasoning.length + '-' + hashString(reasoning);
            _msgSigCache.set(msg, { kind: 'a', cLen: -1, rLen: reasoning.length, sig: sig });
            return sig;
        }
        function toolCallsSig(tcs) {
            if (!tcs || !tcs.length) return '';
            let s = '';
            for (let i = 0; i < tcs.length; i++) {
                const tc = tcs[i];
                const fn = (tc && tc.function) || {};
                s += (tc && tc.id || '') + ':' + (fn.name || '') + ':' + ((fn.arguments || '').length) + ';';
            }
            return s;
        }
        // 仅当该分组确实包含「正在执行的工具」时，才把 _runningToolId 计入签名，
        // 否则执行中状态变化会导致所有历史工具分组全部重建（新的卡顿源）
        function groupRunningSig(group) {
            const runId = messageStore._runningToolId;
            if (!runId) return '';
            const msgs = group.messages || [];
            for (let i = 0; i < msgs.length; i++) {
                const tcs = msgs[i] && msgs[i].tool_calls;
                if (!tcs) continue;
                for (let j = 0; j < tcs.length; j++) {
                    if (tcs[j] && tcs[j].id === runId) return runId;
                }
            }
            return '';
        }
        function groupSignature(group) {
            const loc = (typeof languageStore !== 'undefined' && languageStore.locale) ? languageStore.locale : '';
            if (group.group === 'sysnote') {
                return 'SYS|' + loc + '|' + messageContentSig(group.message) + '#' + convMsgId(group.message);
            }
            if (group.group === 'tool') {
                let s = 'T|' + loc + '|' + groupRunningSig(group);
                const msgs = group.messages;
                for (let i = 0; i < msgs.length; i++) {
                    const m = msgs[i];
                    s += '|' + m.role + '#' + convMsgId(m) + '#' + messageContentSig(m) + '#' +
                        (m.tool_call_id || '') + '#' + (m._toolError ? 'E' : '') + '#' + toolCallsSig(m.tool_calls);
                }
                return s;
            }
            const m = group.message;
            return 'M|' + loc + '|' + m.role + '#' + convMsgId(m) + '#' + messageContentSig(m) + '#' +
                toolCallsSig(m.tool_calls) + '#' + (m._subagent ? 'S' : '');
        }

        // 系统注入的提示（计划提醒 / 执行护栏）在主对话里以「系统提示条」呈现，
        // 不占用用户/助手气泡（避免污染对话观感，同时让干预可见）
        function renderSystemNote(msg) {
            const kind = msg._sysNoteKind || 'plan';
            const isGuard = kind === 'guard';
            const isHardCut = kind === 'hardcut';
            const color = isGuard ? '#C62828' : (isHardCut ? '#B26A00' : '#1867C0');
            const bg = isGuard ? '#fef2f2' : (isHardCut ? '#fff8e6' : '#f0f7ff');
            const icon = isGuard ? '🛡️' : (isHardCut ? '✂️' : '🧭');
            const text = (msg._sysNoteText != null) ? String(msg._sysNoteText) : String(msg.content || '');
            const el = elFromHTML('<div class="chat-message"></div>');
            el.innerHTML = '<div class="sys-note" style="margin:6px 0;padding:6px 12px;border-radius:8px;' +
                'background:' + bg + ';border-left:3px solid ' + color + ';color:' + color +
                ';font-size:12px;white-space:pre-wrap;word-break:break-word;">' + icon + ' ' +
                escapeHtml(text) + '</div>';
            return el;
        }

        function renderConversation() {
            const container = document.getElementById('chatContainer');
            const emptyState = document.getElementById('emptyState');
            const chatBot = document.getElementById('chatBot');

            if (messageStore.conversation.length === 0) {
                container.innerHTML = '';
                emptyState.style.display = 'flex';
                chatBot.style.display = 'none';
                return;
            }
            emptyState.style.display = 'none';
            chatBot.style.display = 'block';

            const groups = groupMessages(messageStore.conversation);
            // 清理已不存在的分组的 tab 选择记录（会话清空/删除后索引会复用）
            if (groups.length === 0) {
                messageStore._toolTabActive = {};
            } else if (messageStore._toolTabActive) {
                const maxIndex = groups[groups.length - 1].index;
                Object.keys(messageStore._toolTabActive).forEach(k => {
                    if (+k > maxIndex) delete messageStore._toolTabActive[k];
                });
            }

            // 序号表整段只算一次（原先 renderMessage/renderToolGroup 各自 O(n) 重建 → O(n²)）
            const seqMap = buildToolSeqMap(messageStore.conversation);
            const n = groups.length;

            // ── 增量比对：只重建签名变化的分组，其余复用已有 DOM 节点 ──
            for (let i = 0; i < n; i++) {
                const group = groups[i];
                // 末尾分组多一个「是否最后一组」的标记：分组因尾部被删除而变成最后一组时，
                // 其内容签名不变但卡片动作按钮需要重建（隐藏「删除此后消息」），否则按钮会残留。
                const sig = groupSignature(group) + (i === n - 1 ? '|last' : '|mid');
                const existing = container.children[i];
                if (existing && existing.__sig === sig) continue; // 未变化 → 复用
                const newEl = (group.group === 'tool')
                    ? renderToolGroup(group, i === n - 1, seqMap)
                    : (group.group === 'sysnote')
                        ? renderSystemNote(group.message)
                        : renderMessage(group.message, group.index, false, seqMap);
                newEl.__sig = sig;
                if (existing) {
                    existing.replaceWith(newEl);
                } else {
                    container.appendChild(newEl);
                }
            }
            // 移除多余的旧卡片（会话变短时）
            while (container.children.length > n) {
                container.removeChild(container.lastElementChild);
            }

            // 活动 tab 跟随：渲染重建后 tab 条 scrollLeft 归零，末尾的激活 tab（执行中临时 tab/最新结果）
            // 会被挤到横向可视区之外，看起来就像"又切回第一个"。这里把激活 tab 滚入可视区。
            container.querySelectorAll('.tool-group-tabs').forEach(barEl => {
                scrollActiveTabIntoView(barEl);
            });

            scrollToBottom();
            bindCardActions();
        }

        // 工具执行进度专用：只重绘最后一个工具分组卡片（流式卡片 → tab 结构切换也在此完成），
        // 替代 runToolCalls 里每步 renderConversation() 的整会话重建（逐工具刷新，不再一次性爆发）
        function refreshLastToolGroup() {
            const groups = groupMessages(messageStore.conversation);
            const lastGroup = groups[groups.length - 1];
            if (!lastGroup || lastGroup.group !== 'tool') {
                renderConversation();
                return;
            }
            const container = document.getElementById('chatContainer');
            const seqMap = buildToolSeqMap(messageStore.conversation);
            const newEl = renderToolGroup(lastGroup, true, seqMap);
            newEl.__sig = groupSignature(lastGroup) + '|last'; // 记录签名（含「最后一组」标记），供增量比对复用
            const lastEl = container.lastElementChild;
            if (lastEl) {
                lastEl.replaceWith(newEl);
            } else {
                container.appendChild(newEl);
            }
            // 活动 tab 滚入可视区（对齐 renderConversation 里的逻辑）
            scrollActiveTabIntoView(newEl.querySelector('.tool-group-tabs'));
            scrollToBottom();
        }

        // 流式增量更新（只更新内容，不重建卡片）
        // rAF 合并渲染：同一帧内到达的多个 chunk 只渲染一次，
        // 避免每个 chunk 都同步全量重解析 markdown + 重建 DOM + 重复高亮 + 滚动（O(n²) 卡顿根源）
        let streamingRenderPending = false;
        function updateStreamingContent() {
            if (streamingRenderPending) return;
            streamingRenderPending = true;
            requestAnimationFrame(() => {
                streamingRenderPending = false;
                renderStreamingContent();
            });
        }
        function renderStreamingContent() {
            const container = document.getElementById('chatContainer');
            const lastMsg = messageStore.conversation[messageStore.conversation.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant') return;

            const reasoning = lastMsg.reasoning_content || '';
            const content = lastMsg.content || '';
            const toolCalls = lastMsg.tool_calls || [];

            // 多轮工具调用时最后的卡片是 tab 结构：仅当最后一条是工具结果消息（role=tool）才跳过。
            // 注意：流式中的 assistant 消息即使已带 tool_calls，分组也会算 'tool'——
            // 若一并跳过，工具生成期间界面会冻结、结束后才一次性爆发显示（修复点）
            // 快速判定（O(1)）：最后一条是工具结果（role=tool）时，其必然归入最后的分组且该分组
            // 为工具分组 → 直接跳过增量渲染。避免长对话下每帧都 O(n) 重建整段分组（卡顿来源之一）
            const _convTail = messageStore.conversation[messageStore.conversation.length - 1];
            if (_convTail && _convTail.role === 'tool') return;

            const lastEl = container.lastElementChild;
            const body = lastEl ? lastEl.querySelector('.card-content-body') : null;

            if (!body) {
                const groups = groupMessages(messageStore.conversation);
                const lastGroup = groups[groups.length - 1];
                if (!lastGroup) return;
                if (lastGroup.group === 'assistant') {
                    const newEl = renderMessage(lastGroup.message, lastGroup.index);
                    newEl.__sig = groupSignature(lastGroup) + '|last'; // 记录签名（含「最后一组」标记），供增量比对复用
                    if (lastEl) {
                        lastEl.replaceWith(newEl);
                    } else {
                        container.appendChild(newEl);
                    }
                    // renderMessage 已完整渲染当前全部内容，同步增量计数避免重复追加
                    lastMsg._renderedReasoningLen = reasoning.length;
                    lastMsg._renderedContentLen = content.length;
                    lastMsg._renderedToolCount = toolCalls.length;
                }
                bindCardActions();
                scrollToBottom();
                return;
            }

            // 已切换到工具 tab 卡片（执行阶段）→ 增量渲染不再适用，跳过
            if (body.querySelector('.tool-group')) return;

            // 无新增内容 → 跳过（finalize 之后触发的 rAF 直接空转）。
            // 注意：工具 arguments 是流式增量拼接的，参数长度变化也算“有新增”
            const rLen = lastMsg._renderedReasoningLen || 0;
            const cLen = lastMsg._renderedContentLen || 0;
            const tCount = lastMsg._renderedToolCount || 0;
            const argTotal = toolCalls.reduce((s, tc) => s + ((tc.function && tc.function.arguments) || '').length, 0);
            const prevArgTotal = (lastMsg._renderedToolArgLens || []).reduce((s, n) => s + (n || 0), 0);
            if (reasoning.length === rLen && content.length === cLen &&
                toolCalls.length === tCount && argTotal === prevArgTotal) return;

            // 1) 推理文本增量追加（只追加新增部分，不整卡重建）
            //    旧实现用 textarea.value += delta 且每帧读取 scrollHeight 自适应高度：
            //      · value += delta 会让浏览器每次重写整段字符串 → O(n²)；
            //      · 每帧 scrollHeight 触发强制重排，且 textarea 无限增高 → 思考越长越卡。
            //    改为「限高可滚动 div + 单文本节点 appendData」：O(增量) 追加，无需每帧测量高度。
            if (reasoning.length > rLen) {
                const delta = reasoning.slice(rLen);
                lastMsg._renderedReasoningLen = reasoning.length;
                let ra = body.querySelector('.reasoning-area');
                if (!ra) {
                    const wrap = elFromHTML('<div class="reasoning-wrap"></div>');
                    wrap.insertAdjacentHTML('beforeend',
                        '<div class="reasoning-label" style="font-size:11px;color:#94a3b8;margin-bottom:2px;">💭 思考过程</div>'
                        );
                    ra = elFromHTML('<div class="reasoning-area"></div>');
                    wrap.appendChild(ra);
                    body.insertBefore(wrap, body.firstChild);
                }
                appendReasoningDelta(ra, delta);
                // 仅在用户停留在思考区底部附近时自动跟随（不做整页测量/滚动）
                if (ra.scrollHeight - ra.scrollTop - ra.clientHeight < 60) ra.scrollTop = ra.scrollHeight;
            }

            // 2) 正文增量追加（流式阶段纯文本，结束后 finalizeStreamingContent 统一补 markdown/高亮）
            if (content.length > cLen) {
                const delta = content.slice(cLen);
                lastMsg._renderedContentLen = content.length;
                let md = body.querySelector('.md-preview');
                if (!md) {
                    md = elFromHTML('<div class="md-preview" style="white-space:pre-wrap;"></div>');
                    body.appendChild(md);
                }
                md.appendChild(document.createTextNode(delta));
            }

            // 3) 工具调用：新工具逐个浮现，arguments 增量逐字符流入（不再停在空参数徽章）
            if (toolCalls.length > 0) {
                let toolBox = body.querySelector('.stream-tool-calls');
                if (!toolBox) {
                    toolBox = elFromHTML('<div class="stream-tool-calls"></div>');
                    body.appendChild(toolBox);
                }
                // 新出现的工具 → 追加徽章（带 data-idx 供增量更新定位；序号与最终工具分组标签保持一致）
                // 序号偏移 = 该消息之前所有 tool_calls 数量；按会话长度缓存，
                // 避免流式期间每帧都对整段长对话做 O(n) 扫描（长对话卡顿来源之一）
                if (lastMsg._seqOffsetForLen !== messageStore.conversation.length) {
                    let off = 0;
                    const convAll = messageStore.conversation;
                    for (let ci = 0; ci < convAll.length - 1; ci++) {
                        const cm = convAll[ci];
                        if (cm && Array.isArray(cm.tool_calls)) off += cm.tool_calls.length;
                    }
                    lastMsg._seqOffsetCache = off;
                    lastMsg._seqOffsetForLen = messageStore.conversation.length;
                }
                const callSeqOffset = lastMsg._seqOffsetCache || 0;
                const renderedCount = lastMsg._renderedToolCount || 0;
                for (let i = renderedCount; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const seq = callSeqOffset + i + 1;
                    toolBox.insertAdjacentHTML('beforeend',
                        `<div class="stream-tool-call" data-idx="${i}">🔧 <span class="tool-seq">${seq}</span> <strong class="tool-name">${escapeHtml(tc.function.name || '')}</strong>(<span class="tool-args">${escapeHtml(tc.function.arguments || '')}</span>)<span class="tool-pending">…等待执行</span></div>`
                        );
                }
                lastMsg._renderedToolCount = toolCalls.length;
                // 已存在工具的增量更新：name 补齐 + arguments 逐字符流入
                if (!lastMsg._renderedToolArgLens) lastMsg._renderedToolArgLens = [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const badge = toolBox.querySelector('.stream-tool-call[data-idx="' + i + '"]');
                    if (!badge) continue;
                    const nameEl = badge.querySelector('.tool-name');
                    const nameText = tc.function.name || '';
                    if (nameEl.textContent !== nameText) nameEl.textContent = nameText;
                    const args = tc.function.arguments || '';
                    const prev = lastMsg._renderedToolArgLens[i] || 0;
                    if (args.length > prev) {
                        badge.querySelector('.tool-args').appendChild(document.createTextNode(args.slice(prev)));
                        lastMsg._renderedToolArgLens[i] = args.length;
                    }
                }
            }

            bindCardActions();
            scrollToBottom();
        }

        // 流结束：对最后一条 assistant 消息做一次完整渲染（markdown 格式化 + 代码高亮 + 推理框高度）
        function finalizeStreamingContent() {
            const lastMsg = messageStore.conversation[messageStore.conversation.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant') return;
            const groups = groupMessages(messageStore.conversation);
            const lastGroup = groups[groups.length - 1];
            if (!lastGroup || lastGroup.group !== 'assistant') return;
            const container = document.getElementById('chatContainer');
            const seqMap = buildToolSeqMap(messageStore.conversation);
            const newEl = renderMessage(lastGroup.message, lastGroup.index, false, seqMap);
            newEl.__sig = groupSignature(lastGroup) + '|last'; // 记录签名（含「最后一组」标记），供 renderConversation 增量比对复用
            const lastEl = container.lastElementChild;
            if (lastEl) {
                lastEl.replaceWith(newEl);
            } else {
                container.appendChild(newEl);
            }
            bindCardActions();
            scrollToBottom();
        }

        let cardActionsBound = false;

        // 删除 / 截断等「编辑对话」操作后统一落盘：
        //   ① localStorage 历史（historyStore.save）
        //   ② 追加式会话日志（historyStore.save 内部会 sessionLog.sync → 记录 msg.truncate）
        // 之前 trim / delete 只改内存，刷新后消息会「复活」；工具 tab 的选中记录也按旧索引失效，一并清掉。
        function persistConversationEdit() {
            try {
                if (typeof historyStore !== 'undefined' && historyStore && typeof historyStore.save === 'function') {
                    historyStore.save();
                }
            } catch (_) { /* 落盘失败不影响界面 */ }
            try { if (messageStore) messageStore._toolTabActive = {}; } catch (_) {}
        }

        // 找出该工具组卡片上「当前选中的 tab」对应的 items 下标（tab 的 data-tab = "tg-<组下标>-<条目下标>"）。
        // 找不到 / 是「⏳ 执行中」的临时 tab → 返回最后一个条目（等价于「整组之后」）。
        function resolveActiveTabItemIndex(cardEl, items) {
            const last = (items && items.length) ? items.length - 1 : -1;
            if (!cardEl || !items || !items.length) return last;
            let active = null;
            try { active = cardEl.querySelector('.tool-group-tabs .tool-tab.active'); } catch (_) { active = null; }
            if (!active) return last;
            const tid = active.getAttribute('data-tab') || '';
            const m = /^tg-\d+-(\d+)$/.exec(tid);
            if (!m) return last;                     // 执行中的临时 tab（tg-<g>-run-<id>）→ 视为最后一组
            const k = parseInt(m[1], 10);
            return (k >= 0 && k < items.length) ? k : last;
        }

        // 截断到「某个 tab（一次工具调用/结果）」之后，删除其后的所有消息：
        //   idx          —— 分组在渲染顺序中的序号（与 groupMessages 返回顺序一致）
        //   willContinue —— 默认 true：截断后立即 continueRun()（带入输入框里的新内容）
        //   cardEl       —— 该工具组卡片的 DOM；用它找出「当前选中的 tab」作为删除边界。
        //                   组内可能有多个 tab（多次工具调用/结果）：选中的 tab 之后的
        //                   同组 tool 消息也一并删除；若截断点落在某个 tool_calls 消息中间，
        //                   会同步裁剪该消息的 tool_calls，保证不留「没有结果的悬空调用」。
        function trimConversationAfterGroup(idx, willContinue, cardEl) {
            if (willContinue === undefined) willContinue = true;
            if (!messageStore) return false;
            // 「暂停对话后」才能改：生成中截断会与流式追加打架（正写入最后一条消息）
            if (messageStore.generating) {
                snackbarStore.showWarningMessage('请先停止生成，再删除消息');
                return false;
            }
            // 停止后仍可能有工具在 await 中（结果稍后才 push）：此刻截断会被迟到的结果「续上」，
            // 反而留下一条孤立的 tool 消息 —— 先等它返回（结果呈现后即可截断）。
            if (messageStore._runningToolId) {
                snackbarStore.showWarningMessage('仍有工具调用在执行，请等它返回后再删除');
                return false;
            }
            const groups = groupMessages(messageStore.conversation);
            const group = groups[idx];
            if (!group || group.group !== 'tool') return false;
            const conv = messageStore.conversation;

            // 1) 以「当前选中的 tab」为界（组内多 tab 时即删除该 tab 之后同组里的 tool 消息）
            const items = buildToolItems(group, buildToolSeqMap(conv));
            const keepItemIdx = resolveActiveTabItemIndex(cardEl, items);
            const keepItem = keepItemIdx >= 0 ? items[keepItemIdx] : null;
            // 保留到的最后一条对话消息（含）：tab 条目 → 其对应的消息
            const keepMsgOffset = keepItem ? group.messages.indexOf(keepItem.msg) : -1;
            const keepIdx = keepMsgOffset >= 0
                ? group.index + keepMsgOffset
                : group.index + group.length - 1;
            const from = keepIdx + 1;                        // 第一条要删除的消息
            const removed = conv.length - from;
            if (removed <= 0) {
                snackbarStore.showInfoMessage('该工具之后没有可删除的消息');
                return false;
            }

            // 2) 裁剪保留区内 tool_calls 消息的调用列表，保证不留「没有结果的悬空调用」：
            //    · 保留范围内已经出现 tool 结果的调用 → 保留；
            //    · 边界消息本身就是 tool_calls 消息（截在某个「调用 tab」上）→ 保留到该 tab 的调用，
            //      它们没有结果，正是「继续时要重新执行」的那几个；
            //    · 其它没有结果、又不是边界的调用 → 丢弃（否则下一轮请求会被 API 拒绝）。
            const keptToolIds = new Set();
            for (let i = 0; i <= keepIdx; i++) {
                const m = conv[i];
                if (m && m.role === 'tool' && m.tool_call_id) keptToolIds.add(m.tool_call_id);
            }
            const boundaryMsg = keepItem ? keepItem.msg : null;
            for (let i = 0; i <= keepIdx; i++) {
                const m = conv[i];
                if (!m || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
                let kept;
                if (m === boundaryMsg) {
                    const ids = new Set();
                    for (let j = 0; j <= keepItemIdx && j < items.length; j++) {
                        const it = items[j];
                        if (it && it.kind === 'call' && it.msg === m && it.tc && it.tc.id) ids.add(it.tc.id);
                    }
                    kept = m.tool_calls.filter(tc => tc && ids.has(tc.id));
                } else {
                    kept = m.tool_calls.filter(tc => tc && keptToolIds.has(tc.id));
                }
                if (kept.length === m.tool_calls.length) continue;
                if (kept.length > 0) m.tool_calls = kept;
                else delete m.tool_calls;
            }

            // 输入框里已写好的新内容：点「删除并继续」时一并带入（作为截断后的新一条 user 消息），
            // 这样可以先写好新要求，再一键截断 + 续跑；点「仅删除」则保留输入框原样。
            const inputEl = willContinue ? document.getElementById('userInput') : null;
            const pendingText = (inputEl && typeof inputEl.value === 'string') ? inputEl.value.trim() : '';
            const pendingImages = willContinue ? ((messageStore.pendingImages || []).slice()) : [];
            const hasInput = !!(pendingText || pendingImages.length > 0);
            const tabLabel = keepItem ? (keepItem.callName || keepItem.tool_call_id || ('tab ' + (keepItemIdx + 1))) : '';
            const tip = '将在工具对话 #' + (idx + 1) +
                (tabLabel ? ' 的「' + tabLabel + '」' : '') + ' 之后删除 ' + removed + ' 条消息' +
                (keepItem && keepItemIdx < items.length - 1 ? '（含同组后面 tab 的调用/结果）' : '') +
                (willContinue
                    ? (hasInput ? '，并把输入框中的新内容（' + (pendingText ? pendingText.length + ' 字' : '') +
                        (pendingText && pendingImages.length ? ' + ' : '') +
                        (pendingImages.length ? pendingImages.length + ' 张图片' : '') + '）带入继续对话' : '，并从该处继续对话')
                    : '') + '。\n\n此操作不可撤销，确定吗？';
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(tip)) return false;
            conv.splice(from, removed);
            // 清理因裁剪 tool_calls 而变空的 assistant 占位（无正文、无思考、无 tool_calls）
            for (let i = conv.length - 1; i >= 0; i--) {
                const m = conv[i];
                if (m && m.role === 'assistant' && !m.tool_calls && !m.content &&
                    !m.reasoning_content && !m._sysNote) conv.splice(i, 1);
            }
            persistConversationEdit();
            renderConversation();
            snackbarStore.showSuccessMessage('已删除该工具之后的 ' + removed + ' 条消息' +
                (willContinue ? (hasInput ? '，正在带入新输入并继续对话…' : '，正在继续对话…') : ''));
            if (willContinue) {
                setTimeout(function () {
                    try { messageStore.continueRun({ userText: pendingText, images: pendingImages }); }
                    catch (e) { console.error('继续对话失败:', e); }
                }, 0);
            }
            return true;
        }

        function bindCardActions() {
            if (cardActionsBound) return;
            cardActionsBound = true;
            const container = document.getElementById('chatContainer');
            container.addEventListener('click', function(e) {
                const btn = e.target && e.target.closest ? e.target.closest('.act-btn') : null;
                if (!btn || !container.contains(btn)) return;
                const msgEl = btn.closest('.chat-message');
                const act = btn.getAttribute('data-act');
                const card = btn.closest('.message-card');
                const idx = msgEl ? Array.from(msgEl.parentNode.children).indexOf(msgEl) : -1;

                if (act === 'copy') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    if (!group) return;
                    if (group.group === 'tool') {
                        const texts = group.messages.map(m =>
                            Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') :
                            (m.content || '')
                        ).join('\n\n');
                        navigator.clipboard.writeText(texts);
                        snackbarStore.showSuccessMessage('$vuetify.dataIterator.snackbar.copied');
                    } else {
                        copyMsg(group.message);
                    }
                } else if (act === 'edit') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    const msg = group && group.message;
                    if (!msg) return;
                    const body = card.querySelector('.card-content-body');
                    const text = Array.isArray(msg.content) ?
                        msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n') :
                        (msg.content || '');
                    body.innerHTML =
                        '<textarea class="edit-msg" style="width:100%;min-height:80px;padding:8px;border:1px solid #1867C0;border-radius:4px;font-size:14px;font-family:inherit;outline:none;">' +
                        escapeHtml(text) + '</textarea>';
                    btn.textContent = '✅';
                    btn.setAttribute('data-act', 'edit-save');
                } else if (act === 'edit-save') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    const msg = group && group.message;
                    if (!msg) return;
                    const ta = card.querySelector('.edit-msg');
                    const newText = ta ? ta.value : '';
                    if (Array.isArray(msg.content)) {
                        const newParts = msg.content.filter(part => part.type === 'image_url');
                        newParts.push({ type: 'text', text: newText });
                        msg.content = newParts;
                    } else {
                        msg.content = newText;
                    }
                    // 内容被修改（即使长度不变）→ 失效签名缓存，保证增量渲染能识别到变化
                    _msgSigCache.delete(msg);
                    renderConversation();
                } else if (act === 'toggle') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    const msg = group && group.message;
                    if (!msg) return;
                    const text = Array.isArray(msg.content) ?
                        msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n') :
                        (msg.content || '');
                    const body = card.querySelector('.card-content-body');
                    const md = body.querySelector('.md-preview');
                    if (md) {
                        // Markdown → 原文（替换掉 md，避免重复）
                        const raw = elFromHTML('<div class="text-pre-wrap assistant-raw"></div>');
                        raw.textContent = text;
                        md.replaceWith(raw);
                        btn.textContent = '👁️';
                    } else {
                        // 原文 → Markdown（先清掉原 raw，保证来回切换幂等）
                        const newMd = renderMarkdown(text);
                        newMd.classList.add('assistant-md');
                        const raws = body.querySelectorAll('.assistant-raw');
                        if (raws.length > 0) {
                            raws[0].replaceWith(newMd);
                            for (let i = 1; i < raws.length; i++) raws[i].remove();
                        } else {
                            body.insertBefore(newMd, body.firstChild);
                        }
                        btn.textContent = '👁️';
                    }
                } else if (act === 'trim') {
                    // 保留当前这一组（含工具组的全部消息），删除它之前的全部消息
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    const cut = group ? group.index : idx;
                    if (cut > 0) {
                        messageStore.conversation.splice(0, cut);
                        persistConversationEdit();
                        renderConversation();
                    }
                } else if (act === 'trim-below-continue') {
                    // 删除「当前选中的 tab」之后的所有消息（含同组后续 tab），并继续对话
                    trimConversationAfterGroup(idx, true, card);
                } else if (act === 'delete') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    const from = group ? group.index : idx;
                    const range = group && group.group === 'tool' ? group.length : 1;
                    messageStore.conversation.splice(from, range);
                    persistConversationEdit();
                    renderConversation();
                } else if (act === 'delete-group') {
                    const groups = groupMessages(messageStore.conversation);
                    const group = groups[idx];
                    if (group && group.group === 'tool') {
                        messageStore.conversation.splice(group.index, group.length);
                        persistConversationEdit();
                        renderConversation();
                    }
                }
            });
        }

        // 流式"粘底"：仅当用户停留在底部附近时才自动回底。
        // 修复：流式输出卡住/慢速时，每个 chunk 都会调用 scrollToBottom，
        // 把滚动条钉死在底部，用户无法向上滚动到已经对话过的内容。
        let stickToBottom = true;

        function isNearBottom() {
            const docEl = document.documentElement;
            return window.innerHeight + window.scrollY >= docEl.scrollHeight - 120;
        }

        function scrollToBottom() {
            const bot = document.getElementById('chatBot');
            if (!bot) return;
            if (!stickToBottom) return; // 用户已向上滚动阅读历史，尊重其阅读位置
            // 整页滚动（对齐 index.html v1.0.5）：滚动窗口而非内部容器
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        }

        // 用户主动滚动（滚轮/触摸/拖拽滚动条/键盘）离开底部 → 取消粘底；滚回底部 → 恢复粘底
        window.addEventListener('scroll', () => {
            stickToBottom = isNearBottom();
        }, { passive: true });

