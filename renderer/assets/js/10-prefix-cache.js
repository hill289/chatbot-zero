        // ══════════════════════════════════════════════════════════
        // 前缀缓存管理器（借鉴 reasonix 的 CacheFirstLoop / ImmutablePrefix /
        // agent.CaptureShape + CompareShape 思路）
        //   · system 提示词与 tools 工具列表逐轮「字节稳定」→ DeepSeek 前缀缓存持续命中。
        //     命中输入 0.02 元/M vs 未命中 1 元/M —— 命中一次约省 98%，是最大的省钱杠杆。
        //   · 任何变更都走 invalidate*（下一轮接受一次 cache miss），避免悄悄漂移。
        //   · 每轮抓取 PrefixShape（system / tools / 组合 的稳定哈希）并跨轮比对，
        //     一旦漂移即可解释「这一轮为什么 miss」，并在统计条上提示。
        // ══════════════════════════════════════════════════════════
        function hashString(str) {
            // FNV-1a 32-bit —— 仅用于前缀指纹展示（确定性、无外部依赖）
            str = String(str == null ? '' : str);
            let h = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = (h * 0x01000193) >>> 0;
            }
            return ('0000000' + h.toString(16)).slice(-8);
        }

        // 稳定序列化（对象键递归排序）：同一逻辑内容永远产出同一字节串，
        // 彻底消除「对象构造顺序」带来的前缀漂移（对齐 reasonix 对 tool schema 的规范化思路）。
        function stableStringify(value) {
            if (value === null || typeof value !== 'object') return JSON.stringify(value);
            if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
            const keys = Object.keys(value).sort();
            return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
        }

        // 规范化 tool schema：只保留影响前缀的字段（type/name/description/parameters），
        // 并按 name 排序 → 即使工具注册顺序变化，只要集合一致，前缀指纹依旧稳定。
        // （对齐 agent.normalizeToolSchemas —— 仅用于指纹，不改动实际发送的 tools 顺序。）
        function canonicalToolSchemas(tools) {
            const arr = (tools || []).map(t => ({
                type: (t && t.type) || 'function',
                function: {
                    name: (t && t.function && t.function.name) || '',
                    description: (t && t.function && t.function.description) || '',
                    parameters: (t && t.function && t.function.parameters) || null
                }
            }));
            arr.sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
            return arr;
        }

        // ── PrefixShape：system / tools 的稳定哈希 + 组合哈希（对齐 agent.CaptureShape）──
        function capturePrefixShape(systemPrompt, tools) {
            const sys = systemPrompt || '';
            const canonicalTools = canonicalToolSchemas(tools);
            const toolsJson = stableStringify(canonicalTools);
            const systemHash = hashString(sys);
            const toolsHash = hashString(toolsJson);
            const prefixHash = hashString(stableStringify({ system: sys, tools: canonicalTools }));
            return {
                systemHash: systemHash,
                toolsHash: toolsHash,
                prefixHash: prefixHash,
                toolSchemaTokens: Math.ceil((toolsJson.length || 0) / 4),
                toolCount: canonicalTools.length
            };
        }

        // ── CompareShape：解释前缀漂移原因（system / tools）──
        function comparePrefixShape(prev, cur) {
            const reasons = [];
            if (prev && prev.systemHash && prev.systemHash !== cur.systemHash) reasons.push('system');
            if (prev && prev.toolsHash && prev.toolsHash !== cur.toolsHash) reasons.push('tools');
            return { changed: reasons.length > 0, reasons: reasons };
        }

        // ── 上下文压缩辅助（对齐 reasonix pinnedPrefixLen / isCompactionSummary / pinnableUserTurn）──
        function isCompactionSummaryMsg(m) {
            return !!(m && m.role === 'user' && typeof m.content === 'string' &&
                /^\s*<compaction-summary>/.test(m.content));
        }
        // 只有「小」user 轮次才可钉住（避免把粘贴的大段内容钉死）；约 1000 token 上限
        function smallUserTurn(m) {
            if (!m || m.role !== 'user' || isCompactionSummaryMsg(m)) return false;
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return c.length <= 4000;
        }
        // 固定前缀 = 首条（小）user 轮次（用户原始目标/硬约束，永不摘要掉）+ 既有压缩摘要
        // （避免二次摘要把已捕获的事实再丢一遍）。返回固定条数。
        function pinnedPrefixLen(conv) {
            let i = 0;
            if (conv[i] && smallUserTurn(conv[i])) i++;
            while (conv[i] && isCompactionSummaryMsg(conv[i])) i++;
            return i;
        }

        const prefixManager = {
            _system: null,
            _tools: null,          // 主会话工具列表（缓存，跨轮复用）
            _subagentTools: null,  // 子代理工具列表（排除 run_subagent）
            _fp: null,
            _shapes: null,         // variant -> 上一轮 PrefixShape（'main' / 'sub'）
            _lastShape: null,      // 最近一次「主会话」前缀形状（供统计条展示）
            _shapeChurn: null,     // { changed, reasons } —— 主会话前缀是否漂移
            getSystem() {
                if (this._system === null) {
                    const cards = (agentStore.columns && agentStore.columns[0] && agentStore.columns[0].cards) || [];
                    const result = cards
                        .filter(item => item.description !== "" || item.refText !== "")
                        .map(item => item.refText ? `${item.description}\n###\n${item.refText}\n###` : item.description)
                        .join('\n\n');
                    this._system = result ? result : "You are a helpful assistant.";
                    this._fp = null;
                }
                return this._system;
            },
            async getTools(excludeTools) {
                const wantSub = Array.isArray(excludeTools) && excludeTools.length > 0;
                if (wantSub && this._subagentTools) return this._subagentTools;
                if (!wantSub && this._tools) return this._tools;
                let tools = await mcpStore.listTools();
                if (wantSub) {
                    tools = tools.filter(t => !excludeTools.includes(t.function.name));
                    this._subagentTools = tools;
                } else {
                    this._tools = tools;
                }
                this._fp = null;
                return tools;
            },
            invalidateSystem() { this._system = null; this._fp = null; },
            invalidateTools() { this._tools = null; this._subagentTools = null; this._fp = null; },
            // 每轮请求前抓取前缀形状并跨轮比对。variant 区分主会话('main')与子代理('sub')，
            // 二者 tools 不同、各自独立一条缓存线，互不干扰；只有 main 驱动统计条展示。
            noteShape(systemPrompt, tools, variant) {
                variant = variant || 'main';
                const shape = capturePrefixShape(systemPrompt, tools);
                if (!this._shapes) this._shapes = {};
                const churn = comparePrefixShape(this._shapes[variant] || null, shape);
                this._shapes[variant] = shape;
                if (variant === 'main') {
                    this._lastShape = shape;
                    this._shapeChurn = churn;
                    this._fp = shape.prefixHash;
                }
                return shape;
            },
            fingerprint() {
                if (this._fp !== null) return this._fp;
                // 指纹覆盖完整的 system + tools 规格（对齐 ImmutablePrefix.fingerprint：
                // {system, tools}）。此前只哈希工具「名字」，会漏掉 description/parameters
                // 变化导致的前缀漂移 —— 那样指纹不变、但 DeepSeek 侧前缀已变，缓存悄悄失效。
                this._fp = capturePrefixShape(this.getSystem(), this._tools || []).prefixHash;
                return this._fp;
            }
        };

        // ── 缓存命中统计（跨会话累计，localStorage 持久化）──
        // 价格（人民币元/百万tokens）：缓存命中输入 0.02、缓存未命中输入 1、输出 4
        const CACHE_PRICING = {
            'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 4 },
            'deepseek-v4-pro':   { hit: 0.02, miss: 1, out: 4 },
            'deepseek-chat':     { hit: 0.02, miss: 1, out: 4 },
            'deepseek-reasoner': { hit: 0.02, miss: 1, out: 4 }
        };
        function pricingFor(model) {
            return CACHE_PRICING[model] || CACHE_PRICING['deepseek-v4-flash'];
        }

        const cacheStatsStore = {
            hitTokens: 0,
            missTokens: 0,
            promptTokens: 0,
            savedUsd: 0,      // 累计已省（人民币元）：Σ hit*(未命中价 - 命中价)
            turns: 0,
            lastTurn: null,   // 最近一轮原始用量快照 { hit, miss, prompt, out }
            load() {
                const s = persist.load('cacheStatsStore', {});
                if (s && typeof s === 'object') Object.assign(this, s);
                if (!this.lastTurn || typeof this.lastTurn !== 'object') this.lastTurn = null;
            },
            save() { persist.save('cacheStatsStore', this); },
            reset() {
                this.hitTokens = 0; this.missTokens = 0; this.promptTokens = 0;
                this.savedUsd = 0; this.turns = 0; this.lastTurn = null; this.save();
                updateCacheStats();
            },
            record(usage) {
                if (!usage) return;
                const hit = usage.prompt_cache_hit_tokens || 0;
                const prompt = usage.prompt_tokens || 0;
                const miss = usage.prompt_cache_miss_tokens != null
                    ? usage.prompt_cache_miss_tokens
                    : Math.max(0, prompt - hit);
                if (hit <= 0 && miss <= 0 && prompt <= 0) return;
                const p = pricingFor(chatbotStore.model);
                const saved = hit * (p.miss - p.hit) / 1e6;
                this.hitTokens += hit;
                this.missTokens += miss;
                this.promptTokens += prompt;
                this.savedUsd += saved;
                this.turns += 1;
                this.lastTurn = {
                    hit: hit, miss: miss, prompt: prompt,
                    out: usage.completion_tokens || 0,
                    saved: saved
                };
                this.save();
                updateCacheStats();
            }
        };
        cacheStatsStore.load();

        function fmtTokens(n) {
            if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
            return String(n);
        }

        // 前缀缓存命中统计条（输入框上方）：命中率（会话累计 / 本轮）、未命中、已省金额、前缀指纹。
        // 对齐 reasonix 状态栏的双指标：nowRate（单轮，越高越省）+ avgRate（会话累计，Σhit/Σ(hit+miss)，
        // 更稳、更贴近总成本）。前缀指纹（systemHash/toolsHash）一旦变化即提示「本轮一次 miss」。
        function cacheRateClass(r) {
            if (r === null || r === undefined) return 'color:#999;';
            if (r >= 80) return 'color:#2E7D32;';
            if (r >= 50) return 'color:#B26A00;';
            return 'color:#C62828;';
        }
        function updateCacheStats() {
            const el = document.getElementById('cacheStats');
            if (!el) return;
            if (chatbotStore.cacheMode === false) { el.style.display = 'none'; return; }
            const s = cacheStatsStore;
            const shape = prefixManager._lastShape;
            if (!s.turns && !shape) { el.style.display = 'none'; return; }
            el.style.display = '';

            const p = pricingFor(chatbotStore.model);
            const denom = s.hitTokens + s.missTokens;
            const aggRatio = denom > 0 ? (s.hitTokens / denom * 100) : null;
            const last = s.lastTurn;
            const lastDenom = last ? (last.hit + last.miss) : 0;
            const lastRate = lastDenom > 0 ? (last.hit / lastDenom * 100) : null;
            const savePct = Math.round(100 * (1 - p.hit / p.miss));

            let html = `🎯 前缀缓存 · 会话命中率 <b style="${cacheRateClass(aggRatio)}">${aggRatio === null ? '—' : aggRatio.toFixed(1) + '%'}</b>`;
            if (lastRate !== null) html += ` · 本轮 <b style="${cacheRateClass(lastRate)}">${lastRate.toFixed(1)}%</b>`;
            html += ` · 累计 命中 <b>${fmtTokens(s.hitTokens)}</b> / 未命中 <b>${fmtTokens(s.missTokens)}</b>`;
            html += ` · 已省 <b style="color:#2E7D32;">¥${s.savedUsd.toFixed(4)}</b> <span style="color:#999;">(命中一次省 ${savePct}%)</span>`;
            if (shape) {
                html += ` · 指纹 <span title="systemHash / toolsHash；两者任一变化都会让下一轮多一次 miss">${shape.systemHash}/${shape.toolsHash}</span>`;
                html += ` <span style="color:#999;">(tools ${shape.toolCount}个 ≈ ${fmtTokens(shape.toolSchemaTokens)} tok)</span>`;
            }
            const churn = prefixManager._shapeChurn;
            if (churn && churn.changed) {
                html += ` <span style="color:#C62828;font-weight:600;" title="上一轮 system/tools 前缀发生变化 → 本轮首次命中会 miss 一次（invalidate 的预期代价），此后恢复稳定">⚠ 前缀变更: ${escapeHtml(churn.reasons.join('+'))}（本轮一次 miss）</span>`;
            }
            el.innerHTML = html;
            el.title = '缓存命中输入 0.02 元/百万tokens，未命中 1 元/百万tokens（命中一次约省 ' + savePct + '%）。\n' +
                '最大化命中率的做法：system 提示词与 tools 工具列表逐轮字节稳定、消息只追加不重写、必要时才压缩、少用「刷新工具」。';
        }


        // ── 本页会话累计 Token 用量与费用统计（继续对话持续累加，仅刷新页面时重置）──
        // 单价（人民币元/百万tokens）：缓存命中输入 0.02、缓存未命中输入 1、输出 4，按当前模型查表。
        function convCostSummary() {
            const u = messageStore.convUsage || { hit: 0, miss: 0, out: 0 };
            const p = pricingFor(chatbotStore.model);
            const hitCost = u.hit / 1e6 * p.hit;
            const missCost = u.miss / 1e6 * p.miss;
            const outCost = u.out / 1e6 * p.out;
            return { hit: u.hit, miss: u.miss, out: u.out, hitCost, missCost, outCost, total: hitCost + missCost + outCost };
        }

        // 已用上下文：当前对话占「模型上下文窗口」的百分比。
        // 口径与硬切窗口（HardCut.pressure）完全一致：优先用上一次真实请求的 prompt_tokens 作基准，
        // 再加上其后新增消息的 token 估算 → 与本轮实际发送量最接近。
        function contextUsage() {
            try {
                if (typeof HardCut === 'undefined' || !HardCut || typeof HardCut.pressure !== 'function') return null;
                const conv = (typeof messageStore !== 'undefined' && messageStore.conversation) || [];
                const p = HardCut.pressure(conv);
                if (!p || !isFinite(p.limit) || p.limit <= 0) return null;
                const tokens = p.tokens || 0;
                if (tokens <= 0) return null;
                return { pct: tokens / p.limit * 100, tokens: tokens, limit: p.limit };
            } catch (_) {
                return null;
            }
        }

        // 上下文占用配色：<50% 正常、50%~85% 注意、≥85% 接近硬切阈值（需降红）
        function ctxPctClass(pct) {
            if (pct >= 85) return 'color:#C62828;';
            if (pct >= 50) return 'color:#B26A00;';
            return 'color:#2E7D32;';
        }

        // 本轮对话的第一条「输入框消息」：对话里第一条真正的 user 输入文本。
        // 过滤掉系统交接种子（硬切 / note）、压缩摘要，以及任务中心注入的阶段指令块
        // （注入块是系统追加的，不属于用户敲进输入框的内容）。
        function firstUserInputText() {
            try {
                const conv = (typeof messageStore !== 'undefined' && messageStore && messageStore.conversation) || [];
                for (let i = 0; i < conv.length; i++) {
                    const m = conv[i];
                    if (!m || m.role !== 'user') continue;
                    if (m._sysNote || m._hardCut || m._sysNoteKind) continue;
                    let s = typeof m.content === 'string' ? m.content :
                        (Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text' && p.text).map(p => p.text).join('\n') : '');
                    s = String(s || '').replace(/【(任务中心|中断恢复)[\s\S]*$/, '').trim();
                    if (!s) continue;
                    if (/^<compaction-summary>/.test(s)) continue;
                    return s;
                }
            } catch (_) {}
            return '';
        }

        // 「本轮首条输入」的展开状态：长文本不截断（完整保留在 DOM），默认视觉折叠为一行，
        // 点 ▼ 展开全文 / ▲ 收起。状态需跨 updateConvCost 的多次重绘保持；首条输入变化时自动收起。
        let _firstInputState = { text: '', expanded: false };

        function _firstInputEsc(s) {
            if (typeof escapeHtml === 'function') return escapeHtml(s);
            return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        }

        // 事件委托：箭头节点在 #convCost 内，每次 innerHTML 重绘都会重建，
        // 所以只在容器（不重建）上绑定一次点击委托。
        function _bindFirstInputToggle(el) {
            if (!el || el.__firstInputBound || typeof el.addEventListener !== 'function') return;
            el.__firstInputBound = true;
            el.addEventListener('click', function (e) {
                const t = e && e.target;
                if (t && typeof t.closest === 'function' && t.closest('.conv-first-input-toggle')) {
                    _firstInputState.expanded = !_firstInputState.expanded;
                    updateConvCost();
                }
            });
        }

        function updateConvCost() {
            const el = document.getElementById('convCost');
            if (!el) return;
            const c = convCostSummary();
            const ctx = contextUsage();
            const firstInput = firstUserInputText();
            const hasUsage = c.hit > 0 || c.miss > 0 || c.out > 0;
            // 本页会话累计：有累计用量 / 已有上下文占用 / 已产生本轮首条输入 就持续显示（空闲时也显示），刷新页面才清零
            if (!hasUsage && !ctx && !firstInput) { el.style.display = 'none'; return; }
            el.style.display = 'block';
            let html = `💰 本页累计 · 缓存命中 <b>${fmtTokens(c.hit)}</b> <span style="color:#999;">(¥${c.hitCost.toFixed(4)})</span> · 未命中 <b>${fmtTokens(c.miss)}</b> <span style="color:#999;">(¥${c.missCost.toFixed(4)})</span> · 输出 <b>${fmtTokens(c.out)}</b> <span style="color:#999;">(¥${c.outCost.toFixed(4)})</span> · 总金额 <span class="cost-total">¥${c.total.toFixed(4)}</span>`;
            if (ctx) {
                html += ` · 已用上下文 <b style="${ctxPctClass(ctx.pct)}">${ctx.pct.toFixed(1)}%</b> <span style="color:#999;">(${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.limit)})</span>`;
            }
            // 「本页累计」下面追加：本轮对话的第一条输入框消息（不截断，▼/▲ 展开收起）
            if (firstInput) {
                if (_firstInputState.text !== firstInput) _firstInputState = { text: firstInput, expanded: false };
                const esc = _firstInputEsc;
                const expanded = _firstInputState.expanded;
                const textStyle = expanded
                    ? 'white-space:pre-wrap;word-break:break-word;'
                    : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                html += `<div class="conv-first-input" style="margin-top:2px;color:#8a8a8a;display:flex;align-items:baseline;gap:4px;">`
                    + `<button type="button" class="conv-first-input-toggle" title="${expanded ? '收起' : '展开全文'}" style="flex:0 0 auto;background:none;border:0;color:#8a8a8a;cursor:pointer;padding:0;font:inherit;line-height:1.5;">${expanded ? '▲' : '▼'}</button>`
                    + `<span style="flex:0 0 auto;">📝 本轮首条输入：</span>`
                    + `<span class="conv-first-input-text" style="flex:1 1 auto;min-width:0;${textStyle}">${esc(firstInput)}</span>`
                    + `</div>`;
            }
            el.innerHTML = html;
            _bindFirstInputToggle(el);
            el.title = '单价(人民币元/百万tokens): 缓存命中 0.02, 缓存未命中 1, 输出 4；本页会话累计，刷新页面后重置\n'
                + '已用上下文 = 当前对话 token ÷ 模型上下文窗口（⚙️ 配置里的 contextWindowTokens）'
                + (ctx ? `；当前约 ${ctx.tokens} / ${ctx.limit} tokens，达到 ${Math.round((HardCut.config && HardCut.config().ratio || 0.85) * 100)}% 会自动硬切窗口` : '');
        }
