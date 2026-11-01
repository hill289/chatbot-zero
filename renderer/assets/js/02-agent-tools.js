        // ══════════════════════════════════════════════════════════
        // MCP Server
        // ══════════════════════════════════════════════════════════
        async function run_subagent(params) {
            const subagentStore = window.__subagentStore;
            if (!subagentStore) {
                return JSON.stringify({ success: false, content: [{ type: 'text', text: 'Subagent store not available.' }] });
            }
            try {
                const result = await subagentStore.openAndRunTask(params.task, params.context || '');
                return JSON.stringify({
                    success: true,
                    content: [{ type: 'text', text: `Subagent result: ${result}` }]
                });
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    content: [{ type: 'text', text: `Subagent error: ${error.message}` }]
                });
            }
        }

        // ══════════════════════════════════════════════════════════
        // reopen_session —— 模型完成某些任务后「重开会话、继续执行」
        //   本工具本身不切换会话，只把交接参数以 sessionRestart 字段随工具结果回传；
        //   由调用方（messageStore.runToolCalls / subagent.postToolCall）在收尾时消费：
        //     归档旧会话 → 开新会话（注入 summary + next_task）→ 自动继续推理。
        // ══════════════════════════════════════════════════════════
        async function reopen_session(params) {
            const summary = (params && params.summary != null) ? String(params.summary) : '';
            const nextTask = (params && params.next_task != null) ? String(params.next_task) : '';
            const keepContext = !!(params && params.keep_context);

            if (!nextTask.trim()) {
                return JSON.stringify({
                    success: false,
                    content: [{ type: 'text', text: 'reopen_session requires a non-empty `next_task` describing what the new session should do.' }]
                });
            }

            return JSON.stringify({
                success: true,
                content: [{
                    type: 'text',
                    text: 'Session restart scheduled. The current turn will end now; a new session will start and continue with:\n' +
                        '• next_task: ' + nextTask
                }],
                // 关键标记：调用方据此判定是否需要重开会话（不影响普通工具结果解析）
                sessionRestart: { summary: summary, nextTask: nextTask, keepContext: keepContext, requestedAt: Date.now() }
            });
        }


        // ══════════════════════════════════════════════════════════
        // ask_user —— 人机确认（Human-in-the-loop）
        //   · 把 question / context / options 渲染成一个模态框，暂停工具执行等待用户答复
        //   · ask() 返回 Promise：用户提交 → { answered:true, value, via }；
        //                          取消 / 超时 / 关闭 → { answered:false, cancelled:true, timedOut? }
        //   · 支持 timeout_seconds 超时自动取消；多个请求排队依次弹出（子代理并行时也安全）
        // ══════════════════════════════════════════════════════════
        const askUserStore = {
            _queue: [],
            _active: null,
            _timer: null,
            ask(params) {
                return new Promise((resolve) => {
                    this._queue.push({ params: params || {}, resolve: resolve });
                    this._pump();
                });
            },
            _pump() {
                if (this._active || this._queue.length === 0) return;
                this._active = this._queue.shift();
                this._render(this._active);
            },
            _finish(result) {
                if (this._timer) { clearTimeout(this._timer); this._timer = null; }
                const cur = this._active;
                this._active = null;
                const overlay = document.getElementById('askUserModal');
                if (overlay) overlay.classList.remove('open');
                if (cur) { try { cur.resolve(result); } catch (_) {} }
                const self = this;
                setTimeout(function () { self._pump(); }, 0);
            },
            _render(req) {
                const p = req.params || {};
                const overlay = document.getElementById('askUserModal');
                if (!overlay) { this._finish({ answered: false, cancelled: true, error: 'ask_user UI not available' }); return; }
                const titleEl = document.getElementById('askUserTitle');
                const qEl = document.getElementById('askUserQuestion');
                const cEl = document.getElementById('askUserContext');
                const optEl = document.getElementById('askUserOptions');
                const textWrap = document.getElementById('askUserTextWrap');
                const textEl = document.getElementById('askUserText');
                const hintEl = document.getElementById('askUserHint');
                const submitBtn = document.getElementById('askUserSubmit');

                if (titleEl) titleEl.textContent = p.title || 'Waiting for your confirmation / 需要你的确认';
                if (qEl) qEl.textContent = (p.question == null) ? '' : String(p.question);
                if (cEl) {
                    if (p.context) { cEl.textContent = String(p.context); cEl.style.display = ''; }
                    else { cEl.textContent = ''; cEl.style.display = 'none'; }
                }

                const options = Array.isArray(p.options)
                    ? p.options.filter(function (o) { return o != null && String(o).length > 0; })
                    : [];
                const allowText = (p.allow_free_text !== false) || options.length === 0;

                if (optEl) {
                    optEl.innerHTML = '';
                    options.forEach((opt) => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'ask-option';
                        btn.textContent = String(opt);
                        btn.addEventListener('click', () => this._finish({ answered: true, value: String(opt), via: 'option' }));
                        optEl.appendChild(btn);
                    });
                    optEl.style.display = options.length ? '' : 'none';
                }
                if (textWrap) textWrap.style.display = allowText ? '' : 'none';
                if (textEl) {
                    textEl.value = (p.default != null) ? String(p.default) : '';
                    textEl.style.display = allowText ? '' : 'none';
                }
                if (submitBtn) submitBtn.style.display = allowText ? '' : 'none';

                if (hintEl) {
                    hintEl.textContent = '';
                    const secs = pgpyToOptionalInt(p.timeout_seconds);
                    if (secs !== undefined && secs > 0) {
                        hintEl.textContent = 'Auto-cancel in ' + secs + 's';
                        this._timer = setTimeout(
                            () => this._finish({ answered: false, cancelled: true, timedOut: true }),
                            secs * 1000
                        );
                    }
                }

                overlay.classList.add('open');
                setTimeout(() => {
                    try {
                        if (allowText && textEl) textEl.focus();
                        else if (options.length && optEl) { const b = optEl.querySelector('.ask-option'); if (b) b.focus(); }
                        else if (submitBtn) submitBtn.focus();
                    } catch (_) {}
                }, 30);
            },
            submit() {
                if (!this._active) return;
                const p = this._active.params || {};
                const options = Array.isArray(p.options) ? p.options : [];
                const allowText = (p.allow_free_text !== false) || options.length === 0;
                const textEl = document.getElementById('askUserText');
                const val = (allowText && textEl) ? textEl.value : '';
                this._finish({ answered: true, value: val, via: 'text' });
            },
            cancel() { this._finish({ answered: false, cancelled: true }); }
        };

        async function ask_user(params) {
            params = params || {};
            const question = params["question"];
            if (typeof question !== 'string' || question.trim() === '') {
                return pgpyToolErr("错误：'question' 必须是非空字符串。");
            }
            if (typeof document === 'undefined' || !document.getElementById('askUserModal')) {
                return pgpyToolErr('ask_user 需要交互式页面环境（未找到确认对话框）。');
            }
            const result = await askUserStore.ask(params);
            if (!result || result.answered !== true) {
                const why = (result && result.timedOut) ? '（超时未响应）' : '（用户取消）';
                return pgpyToolErr('User did not answer ' + why + '。请据此调整策略，或改用其它方式继续；不要重复发起相同提问。');
            }
            const val = (result.value == null) ? '' : String(result.value);
            if (val.trim() === '') {
                return pgpyToolOk('User submitted an EMPTY answer（用户未填写内容即提交）。请据此继续。');
            }
            return pgpyToolOk('User answered: ' + val);
        }

        // ══════════════════════════════════════════════════════════
        // rewriter —— 将原始问题重写为更可解、更清晰、更可验证的问法
        //   · 适用场景：原问题太难 / 太模糊 / 太表象，或多次求解失败
        //   · strategy 决定重写手法（clarify / decompose_hint / … 共 12 种）
        //   · 通过内部一次性 LLM 调用（fetchChatOnce）生成 num_candidates 个候选；
        //     track:false —— 不计入面向用户的前缀缓存命中统计
        //   · 返回结构化 JSON（模型输出无法解析时回退为原始文本，避免信息丢失）
        // ══════════════════════════════════════════════════════════
        const REWRITER_STRATEGIES = [
            'clarify', 'decompose_hint', 'reverse', 'analogy', 'change_goal',
            'change_constraint', 'change_view', 'abstract', 'concretize',
            'quantify', 'reframe_causal', 'reframe_systemic'
        ];
        const REWRITER_STRATEGY_GUIDE = {
            clarify: '追问并补齐关键信息：把含糊表述替换为明确的定义、边界与判定标准，使问题不再有歧义。',
            decompose_hint: '把大问题拆成若干可独立求解、可分别验证的子问题，并给出合理的求解顺序。',
            reverse: '从目标反推：先假设目标已达成，倒推使之成立所需的前置条件与充分条件。',
            analogy: '借用一个结构同构的已知／已解问题作类比，把原问题映射到更熟悉的语境。',
            change_goal: '改变目标：把“求最优／证明”等难目标换成更可解的相近目标（如求可行解、上下界、必要条件）。',
            change_constraint: '放宽或替换约束：去掉／弱化导致难解的限制，或先解一个约束更少的松弛问题。',
            change_view: '换表示／换视角（代数↔几何、时域↔频域、连续↔离散、图↔矩阵等）重新表述问题。',
            abstract: '向上抽象：抽取问题的本质结构并一般化，在更一般的框架中求解后再特化回来。',
            concretize: '向下具体化：代入具体数值／最小实例／边界情形，使问题可计算、可枚举、可验证。',
            quantify: '量化：把定性描述改写为可度量的指标、阈值、公式或可计算的判据。',
            reframe_causal: '因果重构：把“相关／现象”改写为“因果／机制”，明确自变量、因变量与干预。',
            reframe_systemic: '系统重构：把孤立问题放进系统／反馈／多方博弈的视角，明确各要素的相互作用与边界。'
        };
        // 容错地从模型输出中解析 JSON：先剥 ```json 代码围栏，再截取首个 {…} / […]
        function pgpyRewriteParseJson(text) {
            if (typeof text !== 'string') return null;
            let s = text.trim();
            const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) s = fence[1].trim();
            try { return JSON.parse(s); } catch (_) {}
            const objStart = s.indexOf('{'), objEnd = s.lastIndexOf('}');
            if (objStart !== -1 && objEnd > objStart) {
                try { return JSON.parse(s.slice(objStart, objEnd + 1)); } catch (_) {}
            }
            const arrStart = s.indexOf('['), arrEnd = s.lastIndexOf(']');
            if (arrStart !== -1 && arrEnd > arrStart) {
                try { return JSON.parse(s.slice(arrStart, arrEnd + 1)); } catch (_) {}
            }
            return null;
        }
        async function rewriter(params) {
            params = params || {};
            const original_problem = params['original_problem'];
            if (typeof original_problem !== 'string' || original_problem.trim() === '') {
                return pgpyToolErr("错误：'original_problem' 必须是非空字符串。");
            }
            const strategy = (typeof params['strategy'] === 'string' && REWRITER_STRATEGIES.indexOf(params['strategy']) !== -1)
                ? params['strategy'] : null;
            const failure_reason = (typeof params['failure_reason'] === 'string') ? params['failure_reason'].trim() : '';
            let num_candidates = pgpyToOptionalInt(params['num_candidates']);
            if (num_candidates === undefined || !Number.isFinite(num_candidates)) num_candidates = 3;
            if (num_candidates < 1) num_candidates = 1;
            if (num_candidates > 8) num_candidates = 8;

            // context 允许对象或字符串
            let contextStr = '';
            const ctx = params['context'];
            if (ctx && typeof ctx === 'object') {
                try { contextStr = JSON.stringify(ctx, null, 2); } catch (_) { contextStr = String(ctx); }
            } else if (typeof ctx === 'string') {
                contextStr = ctx;
            }

            const strategyLine = strategy
                ? ('采用重写策略「' + strategy + '」：' + REWRITER_STRATEGY_GUIDE[strategy])
                : ('自行选择最合适的重写策略（可选：' + REWRITER_STRATEGIES.join(', ') + '），并在结果中注明所用策略。');

            const instruction = [
                'You are a problem-rewriting assistant. Rewrite the ORIGINAL PROBLEM into ' + num_candidates + ' alternative formulation(s) that are MORE SOLVABLE, CLEARER and MORE VERIFIABLE.',
                'Original problem:',
                '"""',
                original_problem,
                '"""',
                failure_reason ? ('Why the original problem is hard / has failed: ' + failure_reason) : '',
                contextStr ? ('Context (background / constraints / goals):\n' + contextStr) : '',
                'Rewrite strategy instruction: ' + strategyLine,
                'Requirements:',
                '1. Each candidate must be a self-contained, answerable question (not merely advice about how to solve it).',
                '2. Make every assumption you introduce explicit.',
                '3. State concretely how the rewritten problem can be verified / judged.',
                '4. Preserve the original intent and all hard constraints; never silently drop negative constraints (e.g. "do NOT ...").',
                'Do NOT call any tools. Return STRICT JSON ONLY (no prose, no markdown fences), exactly in this shape:',
                '{"candidates":[{"rewritten_problem":"...","strategy_used":"...","why_more_solvable":"...","verification":"...","assumptions":["..."]}]}'
            ].filter(Boolean).join('\n');

            let res;
            try {
                res = await fetchChatOnce([
                    { role: 'system', content: prefixManager.getSystem() },
                    { role: 'user', content: instruction }
                ], { maxTokens: 1500, temperature: 0.7, track: false });
            } catch (e) {
                return pgpyToolErr('rewriter 调用模型失败：' + ((e && e.message) ? e.message : e));
            }
            const raw = (res && res.content) ? String(res.content).trim() : '';
            if (!raw) {
                return pgpyToolErr('rewriter 失败：模型未返回内容（请检查模型/接口配置）。');
            }

            const parsed = pgpyRewriteParseJson(raw);
            let candidates = null;
            if (parsed && Array.isArray(parsed.candidates)) candidates = parsed.candidates;
            else if (Array.isArray(parsed)) candidates = parsed;

            const payload = {
                original_problem: original_problem,
                strategy: strategy || 'auto',
                failure_reason: failure_reason || undefined,
                num_candidates: num_candidates
            };
            if (candidates && candidates.length) {
                payload.candidates = candidates.slice(0, num_candidates);
                return pgpyToolOk(JSON.stringify(payload, null, 2));
            }
            // 解析失败 → 回退为模型原始文本，避免信息丢失
            payload.raw_response = raw;
            payload.note = '模型未返回可解析的 JSON，已回退为原始文本；请从中自行提取候选重写。';
            return pgpyToolOk(JSON.stringify(payload, null, 2));
        }

        // ══════════════════════════════════════════════════════════
        // edit_file —— 基于字符串精确匹配的编辑（比按行号的 replace_lines 更健壮）
        //   · old_string 必须与文件内容逐字符一致；默认要求唯一（可 replace_all）
        //   · 支持 expected_replacements 安全校验；任何校验失败都不改动文件
        //   · 写回 almostnode FS 并进入待同步队列（保持 CRLF/LF 原样）
        // ══════════════════════════════════════════════════════════
        async function edit_file(params) {
            params = params || {};
            const file_path = params["file_path"];
            const old_string = params["old_string"];
            const new_string = params["new_string"];
            const replace_all = !!params["replace_all"];
            const expected = pgpyToOptionalInt(params["expected_replacements"]);

            if (typeof file_path !== 'string' || file_path.trim() === '') {
                return pgpyToolErr("错误：'file_path' 必须是非空字符串。");
            }
            if (typeof old_string !== 'string' || old_string === '') {
                return pgpyToolErr("错误：'old_string' 必须是非空字符串（整文件覆盖请用 write_file）。");
            }
            if (typeof new_string !== 'string') {
                return pgpyToolErr("错误：'new_string' 必须是字符串。");
            }
            if (old_string === new_string) {
                return pgpyToolErr("错误：'old_string' 与 'new_string' 完全相同，无需编辑。");
            }
            if (!(typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready)) {
                return pgpyToolErr('edit_file 需要 almostnode 运行时就绪（node mode）。');
            }

            let originalContent;
            try {
                const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                originalContent = new TextDecoder().decode(binaryContent);
            } catch (e) {
                return pgpyToolErr("错误：无法读取 '" + file_path + "'：" + ((e && e.message) ? e.message : e));
            }
            if (originalContent.includes('\u0000')) {
                return pgpyToolErr("错误：'" + file_path + "' 疑似二进制文件，edit_file 仅支持文本文件。");
            }

            const occurrences = originalContent.split(old_string).length - 1;
            if (occurrences === 0) {
                return pgpyToolErr("错误：在 '" + file_path + "' 中未找到 'old_string'。请先用 read_file / search_content 核对原文（空格、缩进、换行必须逐字符一致）。");
            }
            if (expected !== undefined && expected !== occurrences) {
                return pgpyToolErr("错误：'old_string' 实际出现 " + occurrences + " 次，与 expected_replacements=" + expected + " 不符；未改动文件。");
            }
            if (!replace_all && occurrences > 1) {
                return pgpyToolErr("错误：'old_string' 出现 " + occurrences + " 次，不唯一；未改动文件。请补充上下文使其唯一，或设 replace_all=true 替换全部。");
            }

            const idx = originalContent.indexOf(old_string);
            const firstMatchLine = originalContent.slice(0, idx).split(/\r?\n/).length;
            let updatedContent, replaced;
            if (replace_all) {
                replaced = occurrences;
                updatedContent = originalContent.split(old_string).join(new_string);
            } else {
                replaced = 1;
                updatedContent = originalContent.slice(0, idx) + new_string + originalContent.slice(idx + old_string.length);
            }

            try {
                const buf = new TextEncoder().encode(updatedContent);
                nodeRuntime.FS.writeFile(file_path, new Uint8Array(buf));
                await pgpySyncMount(false);
            } catch (e) {
                return pgpyToolErr("错误：写回 '" + file_path + "' 失败：" + ((e && e.message) ? e.message : e));
            }

            const beforeLines = originalContent.split(/\r?\n/).length;
            const afterLines = updatedContent.split(/\r?\n/).length;
            const delta = afterLines - beforeLines;
            const deltaStr = delta === 0 ? '行数不变' : (delta > 0 ? ('+' + delta + ' 行') : (delta + ' 行'));
            return pgpyToolOk("Edited " + file_path + "：替换 " + replaced + " 处（起始约第 " + firstMatchLine + " 行，" + deltaStr + "）。改动已进入待同步队列，点击「同步」可写回磁盘真实文件。");
        }

        // ══════════════════════════════════════════════════════════
        // read_url —— 抓取外部 URL 并转换为可读文本（/ 保存二进制到工作区）
        //   · Electron 外壳：经 preload.fileAPI.fetchUrl → 主进程 net（不受 CORS 限制）
        //   · 纯浏览器：退回页面 fetch（受目标站点跨域策略限制）
        //   · HTML → 标题 + 正文；JSON → 美化；PDF/Office → 落盘（anydoc 解析为 Markdown）
        // ══════════════════════════════════════════════════════════
        const READ_URL_MAX_BYTES = 5 * 1024 * 1024;

        // 粗略判断字节是否为文本（含 NUL 或大量不可打印字符 → 视为二进制）
        function readUrlLooksText(bytes) {
            if (!bytes || bytes.length === 0) return true;
            const n = Math.min(bytes.length, 1024);
            let bad = 0;
            for (let i = 0; i < n; i++) {
                const b = bytes[i];
                if (b === 0) return false;
                if (b < 0x09 || (b > 0x0D && b < 0x20)) bad++;
            }
            return (bad / n) < 0.1;
        }

        // 由 URL / Content-Type 推断落盘文件名（带扩展名）
        function readUrlGuessName(url, ct) {
            let base = 'downloaded';
            try {
                const u = new URL(url);
                const last = u.pathname.split('/').filter(Boolean).pop();
                if (last) base = decodeURIComponent(last);
            } catch (_) {}
            ct = String(ct || '').toLowerCase();
            if (!/\.[a-z0-9]{1,8}$/i.test(base)) {
                const ext = /pdf/.test(ct) ? '.pdf'
                    : /wordprocessing|msword/.test(ct) ? '.docx'
                    : /spreadsheet|ms-excel/.test(ct) ? '.xlsx'
                    : /presentation|ms-powerpoint/.test(ct) ? '.pptx'
                    : /png/.test(ct) ? '.png'
                    : /jpe?g/.test(ct) ? '.jpg'
                    : /gif/.test(ct) ? '.gif'
                    : /zip/.test(ct) ? '.zip'
                    : '';
                base += ext;
            }
            return (base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 120) || 'downloaded');
        }

        // HTML → 标题 + 正文纯文本（移除脚本/样式/导航等噪声；可选 CSS 选择器）
        function readUrlHtmlToText(html, selector) {
            let title = '';
            try {
                const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
                title = (doc.title || '').trim();
                doc.querySelectorAll('script,style,noscript,svg,iframe,canvas,template,link,meta,head,form,button').forEach(function (n) { n.remove(); });
                let root = doc.body || doc.documentElement;
                if (selector) {
                    const picked = doc.querySelector(selector);
                    if (picked) root = picked;
                } else {
                    const main = doc.querySelector('main, article');
                    if (main && (main.textContent || '').trim().length > 200) root = main;
                }
                let text = root ? (root.textContent || '') : '';
                text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                return { title: title, text: text };
            } catch (e) {
                return { title: title, text: String(html || '') };
            }
        }

        async function read_url(params) {
            params = params || {};
            let url = params["url"];
            const maxCharsRaw = pgpyToOptionalInt(params["max_chars"]);
            const maxChars = (maxCharsRaw === undefined) ? 20000 : Math.max(200, maxCharsRaw);
            const selector = (typeof params["selector"] === 'string' && params["selector"].trim()) ? params["selector"].trim() : null;
            const raw = !!params["raw"];

            if (typeof url !== 'string' || url.trim() === '') {
                return pgpyToolErr("错误：'url' 必须是非空字符串。");
            }
            url = url.trim();
            if (!/^(https?|data):/i.test(url)) {
                return pgpyToolErr("错误：仅支持 http / https / data 开头的 URL。");
            }

            const isData = /^data:/i.test(url);
            const useNative = !isData && !!(window.fileAPI && typeof window.fileAPI.fetchUrl === 'function');
            let status = 0, statusText = '', contentType = '', finalUrl = url, bytes = null;
            try {
                if (useNative) {
                    const r = await window.fileAPI.fetchUrl(url, { maxBytes: READ_URL_MAX_BYTES });
                    if (!r) throw new Error('empty response');
                    if (r.error) throw new Error(r.error);
                    status = r.status || 0; statusText = r.statusText || '';
                    contentType = r.contentType || ''; finalUrl = r.finalUrl || url;
                    bytes = pgpyBase64ToBytes(r.base64 || '') || new Uint8Array(0);
                } else {
                    const r = await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit' });
                    status = r.status; statusText = r.statusText || '';
                    contentType = r.headers.get('content-type') || ''; finalUrl = r.url || url;
                    const ab = await r.arrayBuffer();
                    bytes = new Uint8Array(ab.slice(0, READ_URL_MAX_BYTES));
                }
            } catch (e) {
                return pgpyToolErr("错误：请求 '" + url + "' 失败：" + ((e && e.message) ? e.message : e)
                    + (useNative ? '' : '（纯浏览器环境受目标站点 CORS 限制；Electron 外壳内不受此限）'));
            }
            if (status && (status < 200 || status >= 300)) {
                return pgpyToolErr("错误：HTTP " + status + " " + statusText + " —— " + url);
            }

            const ct = String(contentType || '').toLowerCase();
            let header = "[URL] " + finalUrl + "\n[HTTP] " + (status || 200) + " " + statusText + "\n[Type] " + (ct || 'unknown');

            // 文本类内容 → 解码 + 清洗 + 截断
            const looksText = readUrlLooksText(bytes) &&
                (/text\//.test(ct) || /json|xml|html|javascript|ecmascript|x-www-form-urlencoded|csv|markdown|yaml/.test(ct) || !ct || isData);
            if (looksText) {
                let text = new TextDecoder('utf-8').decode(bytes);
                let title = '';
                if (/html/.test(ct) || (!raw && /<!doctype html|<html[\s>]/i.test(text.slice(0, 600)))) {
                    if (!raw) { const parsed = readUrlHtmlToText(text, selector); title = parsed.title; text = parsed.text; }
                } else if (/json/.test(ct) || /^\s*[\[{]/.test(text.slice(0, 200))) {
                    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
                }
                const truncated = text.length > maxChars;
                if (truncated) text = text.slice(0, maxChars);
                const head = header + (title ? ("\n[Title] " + title) : '') + "\n" + '='.repeat(40) + "\n";
                return pgpyToolOk(head + text + (truncated ? ("\n\n[WARNING: 内容超过 " + maxChars + " 字符，已截断]") : ''));
            }

            // 二进制（PDF / Office / 图片等）→ 保存到工作区，能解析则转 Markdown
            if (!(typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready)) {
                return pgpyToolErr("错误：'" + url + "' 返回二进制内容（" + (ct || 'unknown') + "，" + bytes.length + " bytes），但 almostnode 运行时未就绪，无法落盘。");
            }
            const name = readUrlGuessName(finalUrl, ct);
            let vpath = '/home/pyodide/' + name;
            try {
                try { nodeRuntime.FS.mkdirTree('/home/pyodide'); } catch (_) {}
                let i = 1;
                while (true) {
                    try { nodeRuntime.FS.stat(vpath); vpath = '/home/pyodide/' + name.replace(/(\.[^.]+)?$/, '_' + (i++) + '$1'); }
                    catch (_) { break; }
                }
                nodeRuntime.FS.writeFile(vpath, bytes);
                await pgpySyncMount(false);
            } catch (e) {
                return pgpyToolErr("错误：保存 '" + url + "' 到工作区失败：" + ((e && e.message) ? e.message : e));
            }
            if (typeof window.__undocParse === 'function') {
                try {
                    const result = window.__undocParse(bytes);
                    let out = '';
                    try { out = result.toMarkdown(); } catch (_) { out = ''; }
                    if (!out || out.trim() === '') { try { out = result.toText(); } catch (_) { out = ''; } }
                    if (out && out.trim() !== '') {
                        let body = out; const truncated = body.length > maxChars; if (truncated) body = body.slice(0, maxChars);
                        return pgpyToolOk(header + "\n[Saved] " + vpath + "\n" + '='.repeat(40) + "\n" + body
                            + (truncated ? ("\n\n[WARNING: 内容超过 " + maxChars + " 字符，已截断]") : ''));
                    }
                } catch (_) {}
            }
            return pgpyToolOk(header + "\n[Saved] " + vpath + "（" + bytes.length + " bytes）\n内容为二进制，已保存到工作区；可用 read_file 读取或将 file_path 传给其他工具。");
        }


