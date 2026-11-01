        // ══════════════════════════════════════════════════════════
        // messageStore — 修复发送逻辑：直接从输入框取值，使用 generating 防重
        // ══════════════════════════════════════════════════════════
        const messageStore = {
            userMessage: "",
            pendingImages: [],   // 待发送的图片附件（data URL 数组 → 多模态 image_url）
            conversation: [],
            generating: false,
            _asyncReactEnabled: false,   // 异步全双工开关（默认关闭=既有同步行为；由 super-agent-bootstrap 的 enableAsyncReact() 开启）
            _promptQueue: null,          // 忙时输入队列（仅异步全双工开启后生效）
            runState: 'idle',   // 'idle' | 'running' | 'done' —— 对话运行计时器状态
            elapsed: 0,         // 已运行秒数
            convUsage: { hit: 0, miss: 0, out: 0 }, // 本页会话累计 token 用量（继续对话累加，仅刷新页面时重置）：hit=缓存命中, miss=缓存未命中, out=输出


            init() {
                this.resetTimer();
                // 新建对话：无论当前会话是否为空，都清空既有计划。
                // 旧计划只属于上一话题；原实现把 clear() 放在「会话非空」分支里，
                // 于是「上一轮被护栏中止、对话已空但计划仍残留」时点新建清不掉，
                // 计划（含 ⚠️ 中止提醒）会继续注入上下文造成跑偏。
                try {
                    if (planStore.hasActive() || planStore.objective || planStore.lastTrip) planStore.clear();
                } catch (_) {}
                if (this.conversation.length === 0) {
                    snackbarStore.showWarningMessage('$vuetify.dataIterator.snackbar.addfail');
                } else {
                    this.conversation = [];
                    // 新对话：重置「窗口压力」基准（新窗口从 0 开始计）
                    try { if (typeof HardCut !== 'undefined' && HardCut) HardCut.resetUsage(); } catch (_) {}
                    // 上下文已清空 → 刷新「已用上下文 %」显示（归零/隐藏）
                    try { updateConvCost(); } catch (_) {}
                    // （计划清空已在 init() 开头统一处理，两个分支都覆盖）
                    // 关键修复：把「空会话」登记进会话日志，使其成为磁盘上「最新」会话。
                    // 否则刷新时 sessionLog.boot() 会从 messages/<sid>/events.jsonl 恢复上一条
                    // 非空会话 —— 表现就是「无法清空会话」。
                    try { if (typeof sessionLog !== 'undefined' && sessionLog && sessionLog.sync) sessionLog.sync(this.conversation); } catch (_) {}
                    snackbarStore.showSuccessMessage('$vuetify.dataIterator.snackbar.addnew');
                    renderConversation();
                }
                // 新建对话后把焦点交还输入框：✏️ 按钮被点击后会持有焦点，
                // 若不清除，用户紧接着点输入框偶发“没反应”（光标不落回 textarea）。
                // 用 setTimeout(0) 等本轮 click/render 结束后再聚焦，避免被后续默认动作打断。
                this._lastEnterAt = 0;
                setTimeout(() => {
                    try {
                        const ui = document.getElementById('userInput');
                        if (ui) ui.focus({ preventScroll: true });
                    } catch (_) {}
                }, 0);
            },
            stop() {
                this.generating = false;
                // 若此刻有 ask_user 等待答复的弹窗，一并取消（避免其悬空挂起）
                try { askUserStore.cancel(); } catch (_) {}
                // 挂起的工具审批同样按「拒绝」收尾（理由可读，模型不会原地重试）
                try {
                    if (window.approvalStore && typeof window.approvalStore.cancelAll === 'function') {
                        window.approvalStore.cancelAll('用户停止了生成，审批已取消');
                    }
                } catch (_) {}

                this.endTimer();
                historyStore.save(); // 中断生成也整体落盘，保留已生成的部分内容
                snackbarStore.showInfoMessage('$vuetify.dataIterator.snackbar.stopped');
                updateInputIcon();
            },
            // 启动计时：对话运行时显示 running x 秒（注意：不再清零 convUsage，继续对话时 token/cost 持续累加）
            startTimer() {
                this.runState = 'running';
                this.elapsed = 0;
                runStartTs = Date.now();
                if (runTimerId) clearInterval(runTimerId);
                runTimerId = setInterval(() => {
                    this.elapsed = Math.floor((Date.now() - runStartTs) / 1000);
                    updateTimerDisplay();
                }, 250);
                updateTimerDisplay();
                updateConvCost();
            },
            // 结束计时：对话与 agent 全部结束后显示 end x 秒
            endTimer() {
                if (this.runState !== 'running') return;
                if (runTimerId) { clearInterval(runTimerId); runTimerId = null; }
                this.elapsed = Math.floor((Date.now() - runStartTs) / 1000);
                this.runState = 'done';
                updateTimerDisplay();
                updateConvCost(); // 结束（end）时刷新最终费用统计
            },
            // 重置计时：新对话 / 加载历史 / 加载 prompt 时隐藏计时器
            // （注意：不再清零 convUsage —— 统计只随页面刷新重置）
            resetTimer() {
                if (runTimerId) { clearInterval(runTimerId); runTimerId = null; }
                this.runState = 'idle';
                this.elapsed = 0;
                updateTimerDisplay();
                updateConvCost();
            },
            // 累计本页会话的 token 用量：缓存命中/未命中/输出，并实时刷新费用统计（继续对话持续累加，仅刷新页面重置）
            recordConvUsage(usage) {
                const hit = usage.prompt_cache_hit_tokens || 0;
                const prompt = usage.prompt_tokens || 0;
                const miss = usage.prompt_cache_miss_tokens != null
                    ? usage.prompt_cache_miss_tokens
                    : Math.max(0, prompt - hit);
                const out = usage.completion_tokens || 0;
                this.convUsage.hit += hit;
                this.convUsage.miss += miss;
                this.convUsage.out += out;
                // 硬切窗口：用「真实 prompt_tokens」作为压力基准（比字符估算准）
                try {
                    if (typeof HardCut !== 'undefined' && HardCut) {
                        HardCut.noteUsage(usage, this.conversation.length);
                    }
                } catch (_) {}
                updateConvCost();
            },
            clear() {
                this.userMessage = "";
                this._lastEnterAt = 0; // 发送后清空「连续回车」计时
                document.getElementById('userInput').value = '';
                // 发送后清空待发送图片附件（多模态）
                this.pendingImages = [];
                renderAttachBar();
            },
            // 「连续两个回车」判定窗口（毫秒）：两次回车间隔不超过该值即视为连续，
            // 第一次回车正常换行（不拦截默认行为），第二次回车改为发送。
            // 注意：窗口只是「辅助」判定，真正可靠的是下面「末行为空行」判定，
            // 因此窗口放宽到 1500ms —— 原来 800ms 对按键偏慢的人会偶发「按了两次没发送」。
            DOUBLE_ENTER_MS: 1500,
            // 中文输入法组词状态（由 17-pgpy-fsui.js 的 compositionstart/compositionend 维护）
            _composing: false,
            _composedAt: 0,
            handleKeydown(e) {
                if (!e) return;
                const el = (e.target && typeof e.target.value === 'string') ? e.target : null;

                // 中间按了其他键 → 打断「连续两次回车」的判定
                if (e.key !== "Enter") { this._lastEnterAt = 0; return; }

                // ── 输入法上屏用的回车 ──
                // 组词中/刚上屏（部分输入法 keyCode 恒为 229，或 compositionend 之后才补发
                // keydown）的这次回车只用于上屏，既不换行也不发送；但它会被记成
                // 「第一次回车」，这样紧接着的下一次回车就能发送。
                // 修复：中文输入法下连按两次回车偶尔发不出去（第一次被上屏吃掉，第二次成了「第一次」）。
                const justComposed = (this._composedAt && (Date.now() - this._composedAt) < 80);
                if (!e.ctrlKey && !e.metaKey &&
                    (e.isComposing || e.keyCode === 229 || this._composing || justComposed)) {
                    this._lastEnterAt = Date.now();
                    this._composedAt = 0; // 只吞掉「刚上屏」的那一次回车，不影响随后的一次
                    return;
                }

                // 按住回车自动重复：不参与判定（并打断配对），交给默认行为换行
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

                const text = el ? el.value : '';
                const hasPayload = (typeof text === 'string' && text.trim() !== '') ||
                    (this.pendingImages || []).length > 0;

                // 正在生成中：回车只做普通换行，不吞掉按键。
                // 旧实现在这里会 preventDefault 后 sendMessage() 因 generating 直接返回，
                // 表现为「按了回车什么都没发生」，还吃掉了换行 —— 也是「偶发发送失败」的来源之一。
                if (this.generating) {
                    this._lastEnterAt = 0;
                    this._warnBusyOnce();
                    return;
                }

                const now = Date.now();
                const prev = this._lastEnterAt || 0;
                // 判定②：光标在末尾，且最后一行是空行（值以 \n 结尾）。
                // 说明用户刚敲过一个回车 —— 无论两次回车间隔多久都算「连续两次回车」，
                // 不再受时间窗口限制，彻底消除偶发不发送。
                const caret = (el && typeof el.selectionEnd === 'number') ? el.selectionEnd : -1;
                const atEnd = !!el && el.selectionStart === el.selectionEnd && caret === text.length;
                const endsWithBlankLine = atEnd && text.trim() !== '' && /\n[ \t]*$/.test(text);
                const paired = prev > 0 && (now - prev) <= (this.DOUBLE_ENTER_MS || 1500);

                this._lastEnterAt = 0; // 先复位，避免三连回车被当成两次发送
                if (hasPayload && (paired || (endsWithBlankLine && prev > 0))) {
                    // 连续第二个回车：发送（阻止其再插入一个空行）
                    e.preventDefault();
                    this.sendMessage();
                } else {
                    // 第一个回车：正常换行，记录时间戳等待第二次回车
                    this._lastEnterAt = now;
                }
            },
            // 「正在生成」时按回车只换行：给出一次轻提示（10 秒内不重复，避免刷屏）
            _warnBusyOnce() {
                const now = Date.now();
                if (now - (this._busyHintAt || 0) < 10000) return;
                this._busyHintAt = now;
                try { snackbarStore.showInfoMessage('正在生成中：Enter 只换行，本轮结束后再发送'); } catch (_) {}
            },
            async resendMessage() {
                let index = this.conversation.length - 1;
                while (index >= 0 && this.conversation[index].role !== "user") {
                    index--;
                }
                if (index < 0) return;

                // 与 sendMessage 一致：必须先锁 generating，
                // 否则 read() 检测 !messageStore.generating 会把整轮流式丢弃（重生成内容不显示）
                if (this.generating) return;
                this.generating = true;
                updateInputIcon();

                try {
                    stickToBottom = true; // 重新生成：同样回到底部
                    this.conversation.splice(index + 1);
                    renderConversation();
                    await this.startInference();
                } catch (e) {
                    console.error('重新生成失败:', e);
                    snackbarStore.showErrorMessage(e.message || '重新生成失败');
                } finally {
                    this.generating = false;
                    updateInputIcon();
                }
            },

            // ═══ Continue：将当前对话导入 Import Json（复用 importHistoryJsonData 的导入路径，
            // 把对话重新载入当前对话区并写入历史），然后执行最后一条待处理的工具调用，
            // 由该工具的结果触发对话继续运行（工具结果 → 模型继续生成，含多轮工具循环）═══
            // opts.userText / opts.images：待带入的「新输入」（输入框里的文字 + 附件）。
            //   「删除此后所有消息并继续」会把它作为一条新的 user 消息追加到截断处之后再继续，
            //   这样用户可以先写好新要求，再一键截断 + 续跑。
            async continueRun(opts) {
                opts = opts || {};
                const pendingText = (typeof opts.userText === 'string') ? opts.userText.trim() : '';
                const pendingImages = Array.isArray(opts.images) ? opts.images.slice() : [];
                const hasInput = !!(pendingText || pendingImages.length > 0);

                if (this.generating) return;
                if (this.conversation.length === 0 && !hasInput) {
                    snackbarStore.showWarningMessage('当前没有可继续的对话');
                    return;
                }

                // 1) 将当前对话序列化为 Import Json 接受的单条对话格式并导入
                //    （空对话 + 仅新输入时不导入，直接以输入作为首条消息发送）
                if (this.conversation.length > 0) {
                    importHistoryJsonData(JSON.parse(JSON.stringify(this.conversation)));
                }

                // 2) 在导入后的对话中定位“最后一条待处理的工具”：
                //    a) 末尾是工具结果（role=tool）→ 直接继续生成（让模型应答工具结果）
                //    b) 否则从后往前找最近一条“已请求工具调用但尚未执行”的 assistant 消息
                let pendingToolMsg = null;
                let trailingToolResult = false;
                const lastMsg = this.conversation[this.conversation.length - 1];
                if (lastMsg && lastMsg.role === 'tool') {
                    trailingToolResult = true;
                } else {
                    for (let i = this.conversation.length - 1; i >= 0; i--) {
                        const msg = this.conversation[i];
                        if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
                        const toolIds = new Set(msg.tool_calls.map(tc => tc.id));
                        let executed = false;
                        for (let j = i + 1; j < this.conversation.length; j++) {
                            const m = this.conversation[j];
                            if (m.role === 'tool' && toolIds.has(m.tool_call_id)) { executed = true; break; }
                        }
                        if (!executed) { pendingToolMsg = msg; break; }
                    }
                }

                // 有新的用户输入时，不依赖「是否有待处理的工具」也能继续
                if (!pendingToolMsg && !trailingToolResult && !hasInput) {
                    snackbarStore.showWarningMessage('没有找到待继续的工具调用');
                    return;
                }

                // 3) 锁定生成状态：执行最后的工具调用 → 触发对话继续运行
                this.generating = true;
                updateInputIcon();
                try {
                    stickToBottom = true;
                    // 把「新输入」作为一条 user 消息追加到当前对话末尾（工具结果之后），
                    // 并清空输入框/附件。返回是否真的追加了内容。
                    const pushInput = () => {
                        if (!hasInput) return false;
                        this._appendPendingUserInput(pendingText, pendingImages);
                        historyStore.save();
                        renderConversation();
                        snackbarStore.showInfoMessage('已把新输入带入继续对话');
                        return true;
                    };
                    if (pendingToolMsg) {
                        const tool_called = await this.runToolCalls(pendingToolMsg.tool_calls);
                        if (tool_called) {
                            // 若该工具请求重开会话 → 开新会话继续；否则沿用原会话继续生成
                            if (this._pendingRestart) {
                                const req = this._pendingRestart;
                                this._pendingRestart = null;
                                await this.startNewSession(req);
                            } else {
                                pushInput();
                                await this.startInference();
                            }
                        }
                    } else {
                        pushInput();
                        await this.startInference();
                    }
                } catch (e) {
                    console.error('继续对话失败:', e);
                    snackbarStore.showErrorMessage(e.message || '继续对话失败');
                } finally {
                    this.generating = false;
                    updateInputIcon();
                }
            },

            // 把「输入框里已输入的新内容」组装成一条 user 消息追加到对话末尾。
            //   多模态：文本 + 图片（DeepSeek image_url 格式），与 sendMessage 完全一致。
            //   追加成功后清空输入框与待发送附件（已被「消费」进对话）。
            _appendPendingUserInput(text, images) {
                text = (typeof text === 'string') ? text.trim() : '';
                images = Array.isArray(images) ? images : [];
                if (!text && images.length === 0) return false;
                let content;
                if (images.length > 0) {
                    content = [];
                    if (text) content.push({ type: 'text', text: text });
                    images.forEach(url => content.push({ type: 'image_url', image_url: { url } }));
                } else {
                    content = text;
                }
                this.conversation.push({ content: content, role: 'user' });
                try { this.clear(); } catch (_) {}
                return true;
            },


            // ═══ 前缀缓存友好的上下文压缩（借鉴 reasonix agent.compact / planCompaction）═══
            //   · 头部固定：[system(tools)] + 首条（小）user 轮次 + 既有压缩摘要 —— 保证用户亲口
            //     说的事实/硬约束（"绝不要…"）永不被摘要吞掉，且不会把旧摘要再摘要一遍。
            //   · 折叠区只在「回合边界」切分：尾部从不是孤立的 tool 结果（否则其对应的
            //     assistant.tool_calls 已被折叠 → 请求非法、前缀错乱）。
            //   · system/tools 前缀字节不变 → 下一轮仍命中已缓存头部，只牺牲中部历史。
            //   · 摘要本身作为 user 消息、包 <compaction-summary> 标签，便于后续识别与再次压缩时保留。
            async compactContext() {
                if (this.generating) return;
                const conv = this.conversation;
                if (conv.length < 4) {
                    snackbarStore.showWarningMessage('对话太短，无需压缩');
                    return;
                }
                this.generating = true;
                updateInputIcon();
                try {
                    const pinned = pinnedPrefixLen(conv);              // 固定前缀条数（首条小 user + 旧摘要）
                    const keepTail = 4;
                    let splitAt = Math.max(pinned, conv.length - keepTail);
                    // 尾部不得以 tool 消息开头（避免遗留下孤立 tool 结果）
                    while (splitAt > pinned && splitAt < conv.length && conv[splitAt] && conv[splitAt].role === 'tool') splitAt--;
                    if (splitAt - pinned < 1) {
                        snackbarStore.showWarningMessage('可压缩的历史太短');
                        return;
                    }
                    let headFix = conv.slice(0, pinned);      // 固定保留（不参与摘要）
                    let region = conv.slice(pinned, splitAt); // 待折叠
                    let tail = conv.slice(splitAt);           // 原文保留的最近尾部

                    // 尾部必须保留一个 user 轮次，否则下一轮没有可回复的指令
                    let lastUserInTail = -1;
                    for (let i = tail.length - 1; i >= 0; i--) {
                        if (tail[i] && tail[i].role === 'user') { lastUserInTail = i; break; }
                    }
                    if (lastUserInTail < 0) {
                        for (let i = region.length - 1; i >= 0; i--) {
                            if (region[i] && region[i].role === 'user') {
                                // 先取出该条 user（切片后 region[i] 会越界变成 undefined，
                                // 之前会把 undefined 注入 tail → 压缩后的对话被污染，下一轮前缀无法命中且请求非法）
                                const userMsg = region[i];
                                region = region.slice(0, i);
                                tail = [userMsg].concat(tail);
                                break;
                            }
                        }
                    }
                    if (region.length === 0) {
                        snackbarStore.showWarningMessage('可压缩的历史太短');
                        return;
                    }

                    const system = prefixManager.getSystem();
                    const instruction = "Summarize the conversation above as one self-contained prose recap. Preserve the user's ORIGINAL OBJECTIVE (never paraphrase away negative constraints like 'do NOT do X'), all 'do not' / 'never' / 'avoid' instructions, decisions reached, files inspected or modified, tool results still relevant, and any open todos. Skip turn-by-turn play-by-play. Output plain prose only — no tool calls, no markdown headings, no SEARCH/REPLACE blocks.";
                    // 送入摘要的是「固定头 + 折叠区」整段（= 主对话的前缀）：与主对话共享最长前缀，
                    // 摘要请求本身也因此命中缓存。track:false → 不计入面向用户的命中统计。
                    const summaryInput = conv.slice(0, splitAt);
                    const summary = await fetchChatOnce(
                        [{ role: 'system', content: system }].concat(stripForSend(summaryInput), [{ role: 'user', content: instruction }]),
                        { maxTokens: 1024, track: false }
                    );
                    if (!summary.content) { snackbarStore.showErrorMessage('压缩失败：模型未返回摘要'); return; }
                    const summaryMsg = {
                        role: 'user',
                        content: '<compaction-summary>\n较早对话已压缩为摘要（system + tools 前缀缓存保持不变）:\n' + summary.content + '\n</compaction-summary>'
                    };
                    this.conversation = headFix.concat([summaryMsg], tail);
                    // 压缩后上下文显著变小 → 立即刷新「已用上下文 %」
                    try { updateConvCost(); } catch (_) {}
                    // 计划记录：压缩会折叠历史（计划提醒可能被摘要掉）→ 强制下一轮重新注入计划
                    planStore.forceReinject();
                    historyStore.save();
                    renderConversation();
                    snackbarStore.showSuccessMessage('上下文已压缩（system+tools 前缀缓存保留）');
                } catch (e) {
                    console.error('压缩失败:', e);
                    snackbarStore.showErrorMessage(e.message || '压缩失败');
                } finally {
                    this.generating = false;
                    updateInputIcon();
                }
            },


            // ═══ 硬切窗口（Hard-Cut Window）═══════════════════════════════════════
            //   设计：上下文 ≠ 记忆。接近上限时**不压缩**（不生成摘要、不折叠旧消息），而是
            //     ① 把重要信息写进「工作笔记」（模型可调 note_write；这里再做确定性抽取兜底）；
            //     ② 把整段旧对话归档为磁盘上的「转录历史」（sessionLog / messages/<sid>/events.jsonl）；
            //     ③ 直接把上下文换成一个干净的新窗口，只带「工作状态 + 笔记 + 历史指针」；
            //     ④ 之后按需用 search_transcript / read_transcript 回查旧细节。
            //   与 compactContext（摘要式压缩）并存：硬切是默认路径，压缩仅作显式入口保留。
            _hardCutApi() {
                try { if (typeof HardCut !== 'undefined' && HardCut) return HardCut; } catch (_) {}
                try { return (window && window.HardCut) || null; } catch (_) { return null; }
            },
            // 只构造「新窗口首条消息」，不改动当前对话（供轮次前自动切 / 溢出接管共用）
            _composeHardCut(reason) {
                const HC = this._hardCutApi();
                if (!HC) return null;
                const conv = this.conversation || [];
                if (conv.length === 0) return null;
                // 防死循环：如果当前窗口只剩「交接种子」本身（说明刚切完又超限，多为
                // system/工具前缀本身过大），不再硬切，交给旧的裁剪/交接兜底。
                if (conv.length === 1 && conv[0] && conv[0]._hardCut) return null;
                // ① 归档旧对话（append-only 事件日志；无 Electron 时降级本地归档）
                const pointer = HC.archive(conv);
                // ② 抽取工作状态（目标 / 硬约束 / 相关文件 / 未完成计划 / 笔记）
                const state = HC.buildWorkingState({
                    conversation: conv,
                    plan: (typeof planStore !== 'undefined' ? planStore : null),
                    notes: HC.notes,
                    pointer: pointer
                });
                // ③ 渲染交接种子（新窗口里唯一的一条消息）
                const seedText = HC.renderHandoff(state, pointer, { reason: reason || '' });
                const seed = {
                    role: 'user',
                    content: seedText,
                    _sysNote: true,
                    _sysNoteKind: 'hardcut',
                    _hardCut: true,
                    _sysNoteText: '✂️ 已切换窗口：旧对话归档为转录历史（' +
                        (pointer.sid || pointer.localId || 'local') + '，' + (pointer.messages || 0) + ' 条）。' +
                        '工作状态 / 笔记 / 历史指针已带入新窗口，可随时用 search_transcript 回查。' +
                        (state.objective ? '\n目标：' + String(state.objective).slice(0, 120) : '')
                };
                return { seed: seed, state: state, pointer: pointer };
            },
            // 手动 / 自动硬切（在当前窗口内立即执行）
            async hardCutContext(opts) {
                opts = opts || {};
                const HC = this._hardCutApi();
                if (!HC) {
                    snackbarStore.showErrorMessage('硬切模块未加载（23-hard-cut.js）');
                    return false;
                }
                if (this.generating && !opts.force) {
                    snackbarStore.showWarningMessage('正在生成中：请等本轮结束再切换窗口');
                    return false;
                }
                const conv = this.conversation || [];
                if (!opts.force && conv.length < (HC.config().minMessages || 4)) {
                    snackbarStore.showWarningMessage('对话太短，无需切换窗口');
                    return false;
                }
                if (!opts.force && !HC.isSafeBoundary(conv)) {
                    snackbarStore.showWarningMessage('当前回合尚未结束（有待处理的工具调用），请稍后再切换');
                    return false;
                }
                const prevGenerating = this.generating;
                this.generating = true;
                updateInputIcon();
                try {
                    const composed = this._composeHardCut(opts.reason || 'manual');
                    if (!composed) {
                        snackbarStore.showWarningMessage('暂无可归档的上下文');
                        return false;
                    }
                    // 换成一个全新数组：旧数组仍被 historyStore 条目 / 事件日志引用 →
                    // 旧对话作为「历史记录 + 转录」完整保留，新窗口重新分配 sid。
                    this.conversation = [composed.seed];
                    HC.resetUsage();
                    // 新窗口上下文从 0 起算 → 立即刷新「已用上下文 %」显示
                    try { updateConvCost(); } catch (_) {}
                    try { planStore.forceReinject(); } catch (_) {}
                    try { historyStore.init(this.conversation); } catch (e) { console.error('保存新窗口历史失败:', e); }
                    historyStore.save();
                    stickToBottom = true;
                    renderConversation();
                    snackbarStore.showSuccessMessage('已硬切窗口：旧对话已归档为转录历史（可用 search_transcript 回查）');
                    return true;
                } catch (e) {
                    console.error('硬切窗口失败:', e);
                    snackbarStore.showErrorMessage(e.message || '硬切窗口失败');
                    return false;
                } finally {
                    this.generating = prevGenerating;
                    updateInputIcon();
                }
            },
            // 每轮用户输入前检查：压力达到阈值 → 先硬切，再开始本轮（本轮新指令进入新窗口）
            async _maybeHardCutBeforeTurn() {
                try {
                    const HC = this._hardCutApi();
                    if (!HC) return false;
                    const cfg = HC.config();
                    if (cfg.enabled === false) return false;
                    const conv = this.conversation || [];
                    if (conv.length < (cfg.minMessages || 4)) return false;
                    if (!HC.shouldCut(conv)) return false;
                    if (!HC.isSafeBoundary(conv)) return false;
                    const p = HC.pressure(conv);
                    const ok = await this.hardCutContext({
                        reason: 'auto: 上下文已达 ' + Math.round(p.pct * 100) + '%（' + p.tokens + '/' + p.limit + ' tokens）',
                        force: true
                    });
                    if (ok) {
                        snackbarStore.showInfoMessage(
                            '上下文已达 ' + Math.round(p.pct * 100) + '%：已自动硬切窗口，旧对话归档为转录历史'
                        );
                    }
                    return ok;
                } catch (e) {
                    console.warn('自动硬切检查失败:', e);
                    return false;
                }
            },

            // ═══ 上下文超长自动恢复（两级）═══════════════════════════════════════
            //   一级 _hardTrimContext：原地裁剪「较早中段」，保留固定头（首条 user 目标 + 旧摘要）
            //       与最近尾部，保证请求能塞回窗口后重试（不依赖模型，必然成功）。
            //   二级 _autoHandoffAfterOverflow：裁剪也救不了（如单条消息/系统前缀本身超限）时，
            //       生成结构化「破冰 Prompt」交接摘要，自动开新会话继续执行。
            //   入口 autoRecoverContextOverflow 供 createCompletion 在识别到超长报错时调用。
            //   _ctxRecoverCount / _ctxTrimLevel 每轮用户输入都会在 sendMessage 中重置，防死循环。
            _hardTrimContext(level) {
                const conv = this.conversation;
                if (!conv || conv.length <= 2) return 0;            // 没有可裁剪空间
                const pinned = pinnedPrefixLen(conv);                // 固定头长度（首条小 user + 旧摘要）
                const totalChars = conv.reduce((n, m) => n + msgChars(m), 0);
                const ratio = level === 1 ? 0.5 : level === 2 ? 0.25 : 0.1;
                const budget = Math.max(4000, Math.floor(totalChars * ratio)); // 保留尾部的字符预算
                // 从尾部往前累积，确定尾部起点 tailStart
                let acc = 0, tailStart = conv.length;
                for (let i = conv.length - 1; i >= pinned; i--) {
                    acc += msgChars(conv[i]);
                    tailStart = i;
                    if (acc >= budget) break;
                }
                if (tailStart <= pinned) return 0;                  // 中段为空，无可折叠
                // 边界修正①：尾部不得以孤立 tool 消息开头（避免遗留无主 tool 结果）
                while (tailStart > pinned && conv[tailStart] && conv[tailStart].role === 'tool') tailStart--;
                // 边界修正②：尾部至少要有一个 user 轮次，否则往前找
                if (!conv.slice(tailStart).some(m => m && m.role === 'user')) {
                    for (let i = tailStart - 1; i >= pinned; i--) {
                        if (conv[i] && conv[i].role === 'user') { tailStart = i; break; }
                    }
                }
                const dropped = tailStart - pinned;
                if (dropped < 1) return 0;
                const head = conv.slice(0, pinned);
                const tail = conv.slice(tailStart);
                const note = {
                    role: 'user',
                    content: '<compaction-summary>\n[自动接续] 上下文达到模型上限，已自动裁剪较早的 ' + dropped +
                        ' 条历史消息以腾出空间。用户原始目标（首条消息）与最近对话已保留；被裁剪的是较早的往返过程。\n</compaction-summary>',
                    _sysNote: true,
                    _sysNoteKind: 'auto-compact',
                    _sysNoteText: '上下文超长自动裁剪 ' + dropped + ' 条历史'
                };
                const next = head.concat([note], tail);
                // 原地替换：保持 this.conversation 数组引用不变，createCompletion 的 rawconversation 仍有效
                conv.length = 0;
                for (let i = 0; i < next.length; i++) conv.push(next[i]);
                return dropped;
            },
            async autoRecoverContextOverflow(reason) {
                // ── 首选：硬切窗口（不压缩、不裁剪，直接归档旧上下文 → 新窗口接管）──
                //   与「上下文就是记忆」的旧思路不同：这里把记忆交给磁盘上的转录历史 +
                //   工作笔记，新窗口只带工作状态与指针，请求量立刻降回很小。
                const HC = this._hardCutApi();
                if (HC && HC.config().enabled !== false && (this._ctxRecoverCount || 0) < 3) {
                    try {
                        const composed = this._composeHardCut('上下文超长/溢出：' + String(reason || '').slice(0, 200));
                        if (composed) {
                            this._pendingRestart = {
                                hardCut: true,
                                seed: composed.seed,
                                reason: reason,
                                requestedAt: Date.now()
                            };
                            snackbarStore.showWarningMessage('上下文超长：已归档旧对话并切换到新窗口继续执行…');
                            return 'handoff';
                        }
                    } catch (e) {
                        console.warn('硬切接管失败，回退到裁剪:', e);
                    }
                }
                // ── 兜底：原地硬裁剪 + 重试（最多 3 级，越裁越狠）──
                const level = (this._ctxTrimLevel || 0) + 1;
                if (level <= 3) {
                    const dropped = this._hardTrimContext(level);
                    if (dropped > 0) {
                        this._ctxTrimLevel = level;
                        try { planStore.forceReinject(); } catch (_) {}   // 裁剪会丢计划提醒 → 下轮重注入
                        try { historyStore.save(); } catch (_) {}
                        renderConversation();
                        snackbarStore.showWarningMessage(
                            '上下文超长：已自动裁剪较早的 ' + dropped + ' 条历史并重试（第 ' + level + ' 级）…'
                        );
                        return 'retry';
                    }
                }
                // 二级：裁剪无效 → 自动交接新会话
                return await this._autoHandoffAfterOverflow(reason);
            },
            async _autoHandoffAfterOverflow(reason) {
                try {
                    // 防死循环：若刚交接完又立刻超长（多为 system/工具前缀本身过大），不再交接，直接报错
                    const now = Date.now();
                    if (this._lastHandoffAt && (now - this._lastHandoffAt) < 30000) {
                        snackbarStore.showErrorMessage('上下文超长：自动交接后仍超限，可能是 system/工具前缀本身过大，请精简后重试。');
                        return false;
                    }
                    this._lastHandoffAt = now;

                    const conv = this.conversation || [];
                    // 原始目标：优先计划快照记录，其次首条 user 消息
                    let objective = '';
                    try { objective = (planStore && planStore.objective) || ''; } catch (_) {}
                    if (!objective) {
                        const firstUser = conv.find(m => m && m.role === 'user' && !isCompactionSummaryMsg(m) && textOfMessage(m));
                        objective = firstUser ? clipText(textOfMessage(firstUser), 600) : '';
                    }
                    // 最近进度：取最近若干条 user/assistant 正文（有界）
                    const recentParts = [];
                    for (let i = conv.length - 1; i >= 0 && recentParts.length < 8; i--) {
                        const m = conv[i];
                        if (m && (m.role === 'user' || m.role === 'assistant') && !isCompactionSummaryMsg(m)) {
                            const t = clipText(textOfMessage(m), 300);
                            if (t) recentParts.unshift('· [' + m.role + '] ' + t);
                        }
                    }
                    // 相关文件：从工具调用参数里提取 path/file_path/dir_path（有界去重）
                    const files = [];
                    outer: for (const m of conv) {
                        const tcs = m && Array.isArray(m.tool_calls) ? m.tool_calls : null;
                        if (!tcs) continue;
                        for (const tc of tcs) {
                            const argStr = tc && tc.function && tc.function.arguments;
                            if (typeof argStr !== 'string') continue;
                            const re = /"(?:path|file_path|filePath|dir_path|dirPath)"\s*:\s*"([^"]{1,300})"/g;
                            let mt;
                            while ((mt = re.exec(argStr))) {
                                if (!files.includes(mt[1])) files.push(mt[1]);
                                if (files.length >= 20) break;
                            }
                            if (files.length >= 20) break outer;
                        }
                    }
                    const summary =
                        '【背景回顾】\n上一会话在「' + clipText(prefixManager.getSystem(), 120) + '」的配置下进行（system/工具前缀将在新会话沿用）。\n\n' +
                        '【原始目标】\n' + (objective || '（未记录，请见最近进度）') + '\n\n' +
                        '【最近进度】\n' + (recentParts.length ? recentParts.join('\n') : '（无可提取的正文）') + '\n\n' +
                        '【相关文件】\n' + (files.length ? files.map(f => '- ' + f).join('\n') : '（未从工具调用中识别到）') + '\n\n' +
                        '【触发原因】\n上一会话上下文达到模型上限（' + clipText(reason, 200) + '），已自动交接新会话继续。';
                    const nextTask = '请阅读以上交接摘要，接着上一会话未完成的任务继续执行；不要重复已完成的工作，如需文件请按上面的路径读取。';
                    // 交给既有 reopen 机制：startInference 的 finally 会归档旧会话并开新会话继续
                    this._pendingRestart = { summary: summary, nextTask: nextTask, keepContext: false, requestedAt: Date.now() };
                    snackbarStore.showWarningMessage('上下文超长且无法裁剪：已自动交接新会话继续执行…');
                    return 'handoff';
                } catch (e) {
                    console.error('自动交接新会话失败:', e);
                    return false;
                }
            },


            // ═══ 修复：直接从输入框取值，使用 generating 防重 ═══
            async sendMessage() {
                // 如果正在生成：同步模式忽略本次点击；异步全双工模式改为入队，当前步结束后自动处理。
                if (this.generating) {
                    if (this._asyncReactEnabled && typeof PromptQueue !== 'undefined') {
                        if (!this._promptQueue) this._promptQueue = PromptQueue.createPromptQueue();
                        const _ui = document.getElementById('userInput');
                        const _t = _ui ? _ui.value.trim() : '';
                        if (_t) {
                            this._promptQueue.enqueue(_t);
                            if (_ui) _ui.value = '';
                            try { snackbarStore.showInfoMessage('已加入队列，当前步骤结束后自动处理（异步全双工）'); } catch (_) {}
                        }
                    }
                    return;
                }

                // 用户主动发起新一轮：重置「执行护栏自动续跑」预算
                this._autoContinueCount = 0;

                // 每轮用户输入重置「上下文超长自动恢复」计数（防止跨轮累积导致死循环）
                this._ctxRecoverCount = 0;
                this._ctxTrimLevel = 0;

                // 硬切窗口：开始新回合前，若上下文接近上限 → 先归档旧对话、开干净新窗口，
                // 本轮新输入随后作为新窗口的第一条真实 user 指令进入。
                try { await this._maybeHardCutBeforeTurn(); } catch (_) {}

                // 从输入框获取最新内容，避免状态不同步
                const msg = document.getElementById('userInput').value.trim();
                // 待发送图片附件（多模态）：文本 + 图片，按 DeepSeek image_url 格式组装 content
                // 发送前体检：坏图（如 chunk 长度全为 0 的 PNG）会让接口 400 unsupported image，
                // 且这条消息会写进历史 → 之后每轮都重放坏图，整段对话持续报错。这里直接拦下。
                let images = (this.pendingImages || []).slice();
                if (typeof pgpyDataUrlImageUrlOk === 'function') {
                    const bad = [];
                    images = images.filter((u) => {
                        if (pgpyDataUrlImageUrlOk(u)) return true;
                        bad.push(u);
                        return false;
                    });
                    if (bad.length) {
                        try {
                            snackbarStore.showWarningMessage(
                                `已拦下 ${bad.length} 张无法解析的图片（不是合法的 PNG/JPEG/WebP/GIF，上传会报 400）。` +
                                `图片可能已损坏，请重新导出后再试。`);
                        } catch (_) {}
                        this.pendingImages = (this.pendingImages || []).filter((u) => bad.indexOf(u) < 0);
                        try { renderAttachBar(); updateInputIcon(); } catch (_) {}
                    }
                }
                if (!msg && images.length === 0) return;

                // 锁定
                this.generating = true;
                updateInputIcon();

                try {
                    // 记录发送前是否为空对话（subagent 结果带入不能抢占“首条消息”的历史新建判定）
                    const wasEmpty = this.conversation.length === 0;

                    // ═══ 主窗口发送前：把仍未关闭（含隐藏）subagent 窗口的最新结果带入主对话 ═══
                    //  - 按每个打开窗口“已完成的最终回复”增量同步：每轮新结果 → 一条主对话消息
                    //  - 隐藏窗口（hidden-win）仍在 windows 数组 → 同样获取
                    //  - 已关闭窗口已从 windows 数组移除 → 不会获取
                    //  - 带入后按紫色标识（🤖 紫色卡片，见 renderMessage 的 _subagent 分支）显示，
                    //    并自动关闭这些“本次已同步结果”的 subagent 窗口
                    const subagentResults = collectSubagentResults();
                    if (subagentResults.length > 0) {
                        this.conversation.push(...subagentResults);
                        const closedCount = autoCloseSubagentWindows(subagentResults);
                        snackbarStore.showInfoMessage(
                            `已自动带入 ${subagentResults.length} 条 subagent 结果到主对话` +
                            (closedCount > 0 ? `，并自动关闭 ${closedCount} 个 subagent 窗口` : '')
                        );
                    }

                    // 多模态消息：仅文本 → 字符串；含图片 → content 数组
                    // [{type:'text',text},{type:'image_url',image_url:{url:'data:image/...;base64,...'}}]
                    let userContent;
                    if (images.length > 0) {
                        userContent = [];
                        if (msg) userContent.push({ type: 'text', text: msg });
                        images.forEach(url => userContent.push({ type: 'image_url', image_url: { url } }));
                    } else {
                        userContent = msg;
                    }
                    this.conversation.push({
                        content: userContent,
                        role: "user"
                    });

                    // 计划记录：把「用户原始目标」记入 planStore（作为计划快照的第一行，防止长任务跑偏）
                    if (wasEmpty && typeof msg === 'string' && msg.trim()) {
                        try { planStore.setObjective(msg); } catch (_) {}
                    }

                    if (wasEmpty) {
                        // 历史保存失败绝不能阻断消息渲染（否则首条消息不显示）
                        try {
                            historyStore.init(this.conversation);
                        } catch (e) {
                            console.error('保存历史记录失败:', e);
                        }
                    }
                    // 每条新消息都把完整对话整体落盘（对齐 chat-ui 的持续持久化，刷新后历史仍留存整个 history）
                    historyStore.save();

                    // 新消息：用户主动发起，恢复粘底并滚到底部
                    stickToBottom = true;
                    // 清空输入（但保留图片？）
                    this.clear();
                    renderConversation();

                    // 开始推理
                    await this.startInference();
                } catch (e) {
                    console.error('发送失败:', e);
                    snackbarStore.showErrorMessage(e.message || '发送失败');
                } finally {
                    this.generating = false;
                    updateInputIcon();
                }
            },

            async startInference() {
                // 注意：generating 已在 sendMessage 中管理，这里不再设置。
                // 多轮工具调用必须放在同一个 await 链内循环完成：
                // 旧实现里 postToolCall 二次调用 startInference() 不 await，
                // 第二轮流式开始时 sendMessage 的 finally 已把 generating 置回 false，
                // read() 检测 !messageStore.generating 会把整轮流式直接丢弃（最终答案不显示）
                // 运行计时：本轮对话 + agent 全程计时（参照 chat-ui v1.0.5）
                if (this.runState !== 'running') this.startTimer();
                const loopGuard = createLoopGuard();
                loopGuard.begin();
                let stoppedByGuard = null;
                let stoppedByGuardKind = null; // 'steps' | 'repeat' | 'error'
                try {
                    while (true) {
                        // 执行护栏：步数上限（在发起下一轮模型调用前判定）
                        if (loopGuard.steps >= loopGuard.opts.maxSteps) {
                            stoppedByGuard = '达到单轮工具调用上限（' + loopGuard.opts.maxSteps + ' 轮），已自动中止以防长任务跑偏。';
                            stoppedByGuardKind = 'steps';
                            break;
                        }
                        // 计划记录：需要时把计划快照注入对话尾部（防长任务跑偏）
                        planStore.injectInto(this.conversation);
                        await createCompletion(this.conversation, this.generating, this);
                        // 上下文溢出已被「硬切窗口」接管 → 结束当前循环，由 finally 开新窗口继续
                        if (this._pendingRestart) break;
                        const last = this.conversation[this.conversation.length - 1];
                        if (!last || !last.tool_calls || last.tool_calls.length === 0) {
                            if (last && last.tool_calls) delete last.tool_calls;
                            break;
                        }
                        // 执行护栏：运行前判定（重复调用 → nudge/stop）
                        const verdict = loopGuard.inspect(last.tool_calls);
                        const tool_called = await this.runToolCalls(last.tool_calls);
                        const errStop = loopGuard.commit(last.tool_calls, this._lastToolError);
                        if (verdict.action === 'nudge') {
                            this.conversation.push({
                                role: 'user',
                                content: '<loop-guard>\n' + verdict.reason + '。请勿继续重复同一操作：先阅读已有结果 / 总结现状，或改用不同参数、不同工具；若任务已完成请直接给出结论。\n</loop-guard>',
                                _sysNote: true,
                                _sysNoteKind: 'guard',
                                _sysNoteText: '执行护栏提醒模型（第 ' + loopGuard._repeat + ' 次重复）：' + verdict.reason
                            });
                            renderConversation();
                        }
                        if (verdict.action === 'stop') { stoppedByGuard = verdict.reason; stoppedByGuardKind = 'repeat'; }
                        if (!stoppedByGuard && errStop) { stoppedByGuard = '同一工具连续 ' + loopGuard._errRepeat + ' 次返回失败，已自动中止以防无谓重试。'; stoppedByGuardKind = 'error'; }
                        if (stoppedByGuard) break;
                        if (!tool_called) break;
                        // 工具请求「重开会话」→ 结束本轮（新会话在 finally 中启动）
                        if (this._pendingRestart) break;
                    }
                } finally {
                    this.endTimer();
                    // 执行护栏中止：记录原因（下一轮注入提醒）；「步数触顶」这类可继续的情形
                    // 自动发一条「继续」把对话推下去（等价于用户在输入框输入 继续 并点发送），
                    // 重复调用 / 连续失败则说明策略本身卡死，不自动续跑，直接告警转人工。
                    if (stoppedByGuard) {
                        planStore.noteTrip(stoppedByGuard);
                        planStore.forceReinject();
                        let maxAuto = 3;
                        try {
                            const lg = (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.loopGuard) || {};
                            const m = Number(lg.maxAutoContinues);
                            if (isFinite(m) && m >= 0) maxAuto = m;
                        } catch (_) {}
                        const used = this._autoContinueCount || 0;
                        const canAuto = stoppedByGuardKind === 'steps' && used < maxAuto;
                        // 任务中心只做记账/展示，是否续跑由这里统一决定（无任务时也能续跑）
                        try {
                            if (window.TaskCenter && typeof window.TaskCenter.onGuardAbort === 'function') {
                                window.TaskCenter.onGuardAbort(stoppedByGuard, {
                                    allow: canAuto, kind: stoppedByGuardKind, used: used, max: maxAuto
                                });
                            }
                        } catch (_) {}
                        if (canAuto) {
                            this._autoContinueCount = used + 1;
                            this._scheduleAutoContinue(stoppedByGuard, this._autoContinueCount, maxAuto);
                        } else {
                            const extra = stoppedByGuardKind === 'steps' && maxAuto > 0
                                ? '（已自动续跑 ' + used + '/' + maxAuto + ' 次，转人工）' : '';
                            try { snackbarStore.showWarningMessage('执行护栏已中止本轮：' + stoppedByGuard + extra); } catch (_) {}
                        }
                        try { renderPlanBar(); } catch (_) {}
                    } else {
                        // 本轮正常结束：下一次护栏触顶重新获得完整自动续跑预算
                        this._autoContinueCount = 0;
                    }
                    // 一轮完整作答（含多轮工具调用）结束后整体落盘，保证刷新后 Query History 留存完整对话
                    historyStore.save();
                    // 若本轮请求了重开会话：落盘归档后，异步开新会话继续执行。
                    // 用 setTimeout(0) 让当前调用栈（含 sendMessage 的 finally）先退出，
                    // 避免与本轮 generating 状态收尾互相干扰。
                    if (this._pendingRestart) {
                        const req = this._pendingRestart;
                        this._pendingRestart = null;
                        setTimeout(() => { this.startNewSession(req); }, 0);
                    }
                    // 异步全双工：本轮结束后若队列还有输入，逐条作为新回合继续（默认关闭下永不触发）
                    if (!this._pendingRestart && this._asyncReactEnabled && this._promptQueue && this._promptQueue.size() > 0) {
                        this._scheduleQueuedPrompt();
                    }
                }
            },

            // 异步全双工：处理队列中的下一条用户输入（作为新回合继续推理）
            _scheduleQueuedPrompt() {
                const self = this;
                setTimeout(() => {
                    if (!self._promptQueue || self._promptQueue.isEmpty()) return;
                    if (self.generating) return;
                    const text = self._promptQueue.dequeue();
                    if (!text) return;
                    self.conversation.push({ role: 'user', content: text });
                    self.generating = true;
                    try { updateInputIcon(); } catch (_) {}
                    if (typeof renderConversation === 'function') renderConversation();
                    Promise.resolve(self.startInference())
                        .catch(() => {})
                        .finally(() => { self.generating = false; try { updateInputIcon(); } catch (_) {} });
                }, 0);
            },

            async runToolCalls(toolCalls) {
                let tool_called = false;
                let lastErr = false; // 本批最后一次工具结果是否失败（供执行护栏判断「连续失败」）
                // 只刷新最后一个工具分组卡片，执行进度逐个出现，不再整会话重建
                refreshLastToolGroup();
                for (let index = 0; index < toolCalls.length; index++) {
                    const tool_call = toolCalls[index];
                    messageStore._runningToolId = tool_call.id;
                    refreshLastToolGroup(); // 显示 ⏳ 执行中
                    const _traceT0 = traceNow(); // 可观测：记录本次工具调用开始时刻
                    let __result0 = null; // 捕获本次工具原始返回，供 PlanMode 回贴产物
                    // ── Plan 模式审批门（19-plan-mode.js）：缺失时 no-op，绝不阻断执行 ──
                    try {
                        if (window.PlanMode && typeof window.PlanMode.beforeToolCall === 'function') {
                            const __gate = await window.PlanMode.beforeToolCall(tool_call.function.name, tool_call.function.arguments, tool_call);
                            if (__gate && __gate.allow === false) {
                                this.conversation.push({
                                    role: "tool",
                                    content: mcpStore.packReturn('Blocked by plan approval: ' + (__gate.reason || 'denied')).content,
                                    tool_call_id: tool_call.id,
                                    _toolError: true,
                                    _toolErrorText: __gate.reason || 'Blocked by PlanMode'
                                });
                                messageStore._runningToolId = null;
                                refreshLastToolGroup();
                                tool_called = true;
                                lastErr = true;
                                continue;
                            }
                        }
                    } catch (_) { /* 审批门故障不影响工具执行 */ }
                    try {
                        const result0 = await mcpStore.callTool(
                            tool_call.function.name,
                            tool_call.function.arguments
                        );
                        __result0 = result0;
                        let result = null;
                        try { result = JSON.parse(result0); } catch (e) { /* 非 JSON 结果按空处理 */ }
                        if (result && result.content) {
                            // 失败检测：工具返回 success:false / isError → 结果标签以红色「失败」呈现
                            const isErr = result.success === false || !!result.isError;
                            // 「用户拒绝审批」属于正常决策，不算工具失败（不计入连续失败护栏）
                            const isDenied = !!result.denied;
                            lastErr = isErr && !isDenied;
                            const errText = isErr ? toolContentText(result.content) : '';
                            this.contentConvert(result.content, tool_call.id, { error: isErr, errorText: errText }).forEach(item => {
                                this.conversation.push(item);
                            });
                            tool_called = true;
                            // 记录「重开会话 / 硬切窗口」请求：由 startInference / continueRun 消费。
                            //   tool-registry 的工具结果会把附加字段放进 structuredContent（top-level
                            //   只保留 success/isError/content），两条路径都兼容。
                            const restart = result.sessionRestart ||
                                (result.structuredContent && result.structuredContent.sessionRestart);
                            if (restart) this._pendingRestart = restart;
                        } else {
                            // 空结果也回执一条 tool 消息，避免链条中断、剩余工具被静默跳过
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
                    // ── Plan 模式：把本次工具产物回贴到当前步骤（缺失时 no-op）──
                    try { if (window.PlanMode && typeof window.PlanMode.afterToolCall === 'function') window.PlanMode.afterToolCall(tool_call.function.name, tool_call.function.arguments, __result0); } catch (_) {}
                    traceStampToolResult(this.conversation, tool_call.id, _traceT0, traceNow()); // 可观测：回写本次耗时
                    messageStore._runningToolId = null;
                    refreshLastToolGroup(); // 每个工具完成立即刷新 → 结果逐个出现
                }
                this._lastToolError = lastErr;
                return tool_called;
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

            // ═══ 执行护栏自动续跑：等价于「在输入框输入 继续 并点发送」 ═══
            // 由 startInference 的 finally 在护栏「步数触顶」时调用。延迟到当前调用栈
            // （含 sendMessage 的 finally 收尾）退出后再启动，避免与本轮 generating
            // 状态互相干扰；续跑的新一轮会重新创建 loopGuard（步数从 0 开始）。
            _scheduleAutoContinue(reason, n, max) {
                const self = this;
                setTimeout(() => {
                    try {
                        self.generating = true;
                        try { updateInputIcon(); } catch (_) {}
                        // 与用户手输「继续，专注任务运行，不要跑偏。」完全一致：一条 role:user 的普通消息
                        self.conversation.push({
                            role: 'user',
                            content: '继续，专注任务运行，不要跑偏。',
                            _autoContinue: n,
                            _autoContinueReason: String(reason || '').slice(0, 200)
                        });
                        try { planStore.forceReinject(); } catch (_) {}
                        try { historyStore.save(); } catch (e) { console.error('自动续跑保存历史失败:', e); }
                        stickToBottom = true;
                        try { renderConversation(); } catch (_) {}
                        try { snackbarStore.showInfoMessage('执行护栏中止，已自动继续（' + n + '/' + max + '）…'); } catch (_) {}
                        Promise.resolve(self.startInference())
                            .catch((e) => {
                                console.error('自动续跑失败:', e);
                                try { snackbarStore.showErrorMessage((e && e.message) || '自动续跑失败'); } catch (_) {}
                            })
                            .finally(() => {
                                self.generating = false;
                                try { updateInputIcon(); } catch (_) {}
                                try { historyStore.save(); } catch (_) {}
                            });
                    } catch (e) {
                        self.generating = false;
                        try { updateInputIcon(); } catch (_) {}
                        console.error('自动续跑启动失败:', e);
                    }
                }, 0);
            },

            // ═══ 重开会话（reopen session）：模型调用 reopen_session 工具后，
            //   本轮对话结束 → 当前会话已由 startInference 的 finally 落盘归档 →
            //   这里开一个全新会话，把交接摘要 + 下一任务作为首条用户消息注入 → 自动继续执行 ═══
            async startNewSession(req) {
                req = req || {};
                this.resetTimer();

                // 新会话重置「上下文超长自动恢复」计数（连同 _lastHandoffAt 的 30s 兜底防死循环）
                this._ctxRecoverCount = 0;
                this._ctxTrimLevel = 0;
                try { if (typeof HardCut !== 'undefined' && HardCut) HardCut.resetUsage(); } catch (_) {}

                // ── 硬切窗口：新窗口的首条消息就是「工作状态 + 笔记 + 历史指针」种子 ──
                if (req.hardCut) {
                    this.conversation = [req.seed || {
                        role: 'user',
                        content: '继续执行未完成的任务。'
                    }];
                    try { planStore.forceReinject(); } catch (_) {}
                    try { historyStore.init(this.conversation); } catch (e) { console.error('保存新窗口历史失败:', e); }
                    historyStore.save();
                    stickToBottom = true;
                    renderConversation();
                    snackbarStore.showInfoMessage('已切换窗口，继续执行…');
                    this.generating = true;
                    updateInputIcon();
                    try {
                        await this.startInference();
                    } catch (e) {
                        console.error('硬切窗口继续执行失败:', e);
                        snackbarStore.showErrorMessage(e.message || '硬切窗口继续执行失败');
                    } finally {
                        this.generating = false;
                        updateInputIcon();
                    }
                    return;
                }

                // keepContext=false（默认）：全新会话；true：保留旧上下文，仅追加下一步任务
                if (!req.keepContext) this.conversation = [];
                // 上下文已重置 → 刷新「已用上下文 %」显示
                try { updateConvCost(); } catch (_) {}

                // 计划记录：重开会话时保留既有计划，并强制在下一轮重新注入（防长任务跨会话跑偏）
                planStore.forceReinject();
                if (!planStore.objective && req.nextTask) planStore.setObjective(req.nextTask);

                const parts = [];
                if (req.summary) parts.push('【上一会话交接摘要 / Handoff summary】\n' + req.summary);
                if (req.nextTask) parts.push('【本会话任务 / Next task】\n' + req.nextTask);
                // 工作笔记跨窗口注入：把最近的决策 / 约束 / 待办带进新窗口（有界）
                try {
                    const snap = (typeof HardCut !== 'undefined' && HardCut && HardCut.notes)
                        ? HardCut.notes.snapshot(8) : '';
                    if (snap) parts.push('【工作笔记 / Working notes】\n' + snap);
                } catch (_) {}
                const firstMsg = parts.join('\n\n') || '继续执行未完成的任务。';
                this.conversation.push({ role: 'user', content: firstMsg });

                // 新会话作为独立历史条目落盘（旧会话条目仍保留在 Query History 中）
                try { historyStore.init(this.conversation); } catch (e) { console.error('保存新会话历史失败:', e); }
                historyStore.save();

                stickToBottom = true;
                renderConversation();
                snackbarStore.showInfoMessage('已重开会话，继续执行…');

                this.generating = true;
                updateInputIcon();
                try {
                    await this.startInference();
                } catch (e) {
                    console.error('重开会话继续执行失败:', e);
                    snackbarStore.showErrorMessage(e.message || '重开会话继续执行失败');
                } finally {
                    this.generating = false;
                    updateInputIcon();
                }
            }
        };

