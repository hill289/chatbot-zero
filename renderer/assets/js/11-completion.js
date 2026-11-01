        // ══════════════════════════════════════════════════════════
        // 发送前消息清洗（前缀缓存的关键一环）
        //  · 剔除所有内部字段（下划线开头：_subagent / _subagentId / _toolError …）
        //  · 规整为「规范最小形状」：字段顺序固定、空字段省略（对齐 openai provider 的
        //    omitempty 行为）→ 同一逻辑消息每轮序列化出的字节完全一致，前缀缓存稳定命中。
        //  · 工具调用 / 结果配对修复（借鉴 provider.SanitizeToolPairing）：中断 / 恢复的历史
        //    可能残留「assistant.tool_calls 未被 tool 结果应答」或半截 JSON 参数，DeepSeek 会
        //    直接 400；一次 400 / 重试等于白付整个前缀。修复是确定性的，结构良好的历史原样通过
        //    （不会破坏缓存）。
        //  · reasoning_content 的保留规则（对齐 openai.go buildRequest / agent.go）：
        //      - 仅在带 tool_calls 的 assistant 轮次保留 —— DeepSeek 思考模式校验要求，
        //        缺失会让该轮上下文无法复用（后续所有 token 重新计价为未命中），思考型模型还会 400；
        //      - 其余（更早的纯文本 / 非工具）assistant 轮次一律丢弃 reasoning_content
        //        （既是 API 契约 —— 回传 reasoning 会被 400，也省前缀 token）。
        // ══════════════════════════════════════════════════════════
        const INTERRUPTED_TOOL_RESULT = "[no result: the previous turn was interrupted before this tool call completed]";

        function isValidJSON(s) { try { JSON.parse(s); return true; } catch (e) { return false; } }

        // 尽力补全被中断的 JSON（未闭合的字符串/括号、悬空的逗号/冒号）；仍非法则退化为 "{}"
        function closeTruncatedJSON(s) {
            if (!s) return s;
            let inStr = false, esc = false;
            const stack = [];
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') inStr = true;
                else if (c === '{') stack.push('}');
                else if (c === '[') stack.push(']');
                else if (c === '}' || c === ']') stack.pop();
            }
            let out = s;
            if (esc) out = out.slice(0, -1);
            if (inStr) out += '"';
            let t = out.replace(/[ \t\r\n]+$/, '');
            if (t.endsWith(',')) t = t.slice(0, -1);
            else if (t.endsWith(':')) t = t + 'null';
            while (stack.length) t += stack.pop();
            return isValidJSON(t) ? t : '{}';
        }

        function repairToolCallArgs(m) {
            if (!m || !Array.isArray(m.tool_calls)) return m;
            let broken = false;
            for (const tc of m.tool_calls) {
                const a = tc && tc.function && tc.function.arguments;
                if (a && !isValidJSON(a)) { broken = true; break; }
            }
            if (!broken) return m;
            const copy = Object.assign({}, m);
            copy.tool_calls = m.tool_calls.map(tc => {
                const a = tc && tc.function && tc.function.arguments;
                if (!a || isValidJSON(a)) return tc;
                return { id: tc.id, type: tc.type || 'function', function: { name: tc.function.name, arguments: closeTruncatedJSON(a) } };
            });
            return copy;
        }

        function toolCallIdsDistinct(calls) {
            const seen = new Set();
            for (const tc of calls) {
                if (!tc || !tc.id) return false;
                if (seen.has(tc.id)) return false;
                seen.add(tc.id);
            }
            return true;
        }

        // 为每个 tool_call 配对结果；缺失的用占位结果补齐（保持调用顺序）
        function pairToolResults(calls, avail) {
            const out = [];
            if (toolCallIdsDistinct(calls)) {
                const byId = {};
                avail.forEach(r => { if (r && r.tool_call_id) byId[r.tool_call_id] = r; });
                calls.forEach(tc => {
                    const r = byId[tc.id];
                    out.push(r || { role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
                });
                return out;
            }
            calls.forEach((tc, k) => {
                if (k < avail.length) {
                    const r = Object.assign({}, avail[k]);
                    r.tool_call_id = tc.id;
                    out.push(r);
                } else {
                    out.push({ role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
                }
            });
            return out;
        }

        // 工具调用 / 结果配对修复；结构良好的历史原样返回（缓存安全）
        function sanitizeToolPairing(messages) {
            const out = [];
            for (let i = 0; i < messages.length;) {
                const m = messages[i];
                if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                    let j = i + 1;
                    while (j < messages.length && messages[j] && messages[j].role === 'tool') j++;
                    out.push(repairToolCallArgs(m));
                    pairToolResults(m.tool_calls, messages.slice(i + 1, j)).forEach(r => out.push(r));
                    i = j;
                    continue;
                }
                if (m && m.role === 'tool') { i++; continue; } // 孤立 tool 结果（无前置调用）→ 丢弃
                out.push(m);
                i++;
            }
            return out;
        }

        // 规范最小消息形状：固定字段顺序 + 省略空字段（保证逐轮字节稳定）
        function buildWireMessage(item, keepReasoning) {
            const role = item.role;
            const hasToolCalls = !!(Array.isArray(item.tool_calls) && item.tool_calls.length > 0);
            const out = { role: role };
            // assistant 且带 tool_calls 且正文为空 → 省略 content（对齐 openai provider）
            if (!(role === 'assistant' && hasToolCalls && (item.content === '' || item.content == null))) {
                out.content = (item.content == null) ? '' : item.content;
            }
            if (role === 'tool' && item.tool_call_id) out.tool_call_id = item.tool_call_id;
            if (keepReasoning && item.reasoning_content) out.reasoning_content = item.reasoning_content;
            if (hasToolCalls) {
                out.tool_calls = item.tool_calls.map(tc => ({
                    id: (tc && tc.id) || '',
                    type: (tc && tc.type) || 'function',
                    function: {
                        name: (tc && tc.function && tc.function.name) || '',
                        arguments: (tc && tc.function && tc.function.arguments) || ''
                    }
                }));
            }
            return out;
        }

        // ── 出站图片闸门：坏图绝不允许进入请求体 ─────────────────────────────
        //   历史里只要残留一张「坏图」（典型：签名对但 chunk 长度全为 0 的 PNG），
        //   模型接口就会对之后每一轮请求都返回 400 unsupported image ——
        //   表现为「上传一次坏图后，整段对话一直报错、只能新开会话」。
        //   这里在组包前统一体检：不合格的 image 段就地降级为文本占位，
        //   从而自愈已经被污染的历史（无需用户重开会话）。
        const API_IMAGE_MIME_RE = /^data:image\/(png|jpeg|webp|gif);base64,/i;

        function pgpyB64ToBytes(b64) {
            try {
                const bin = atob(b64);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            } catch (_) { return null; }
        }

        // 只解码头/尾片段做结构抽检（整张 6MB 图每轮全解太贵）
        function pgpyDataUrlImageUrlOk(url) {
            if (typeof url !== 'string' || !API_IMAGE_MIME_RE.test(url)) return false;
            const ci = url.indexOf(',');
            const body = url.slice(ci + 1).replace(/\s+/g, '');
            if (body.length < 64) return false;
            const mime = url.slice(5, url.indexOf(';')).toLowerCase();
            const head = pgpyB64ToBytes(body.slice(0, 256));
            if (!head || head.length < 16) return false;
            const magicOk =
                (mime === 'image/png' && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 &&
                    head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A) ||
                (mime === 'image/jpeg' && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) ||
                (mime === 'image/gif' && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) ||
                (mime === 'image/webp' && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46);
            if (!magicOk) return false;
            // PNG 首块必须是 length=13 的 IHDR（坏图的典型症状就是 length=0）
            if (mime === 'image/png') {
                const len = ((head[8] << 24) | (head[9] << 16) | (head[10] << 8) | head[11]) >>> 0;
                const type = String.fromCharCode(head[12], head[13], head[14], head[15]);
                if (len !== 13 || type !== 'IHDR') return false;
            }
            const tail = pgpyB64ToBytes(body.slice(-96));
            if (!tail || !tail.length) return false;
            if (mime === 'image/png') {
                let found = false;
                for (let i = 0; i + 11 < tail.length; i++) {
                    if (tail[i] === 0 && tail[i + 1] === 0 && tail[i + 2] === 0 && tail[i + 3] === 0 &&
                        tail[i + 4] === 0x49 && tail[i + 5] === 0x45 && tail[i + 6] === 0x4E && tail[i + 7] === 0x44) { found = true; break; }
                }
                if (!found) return false; // 没有 IEND → 截断
            }
            if (mime === 'image/jpeg' && !(tail[tail.length - 2] === 0xFF && tail[tail.length - 1] === 0xD9)) return false;
            if (mime === 'image/gif' && tail[tail.length - 1] !== 0x3B) return false;
            return true;
        }

        // 把不合格 image 段降级为文本；返回新数组（不破坏 UI 展示用的原对象）
        function sanitizeImagePayloads(messages) {
            let removed = 0;
            const out = [];
            for (const m of (messages || [])) {
                const c = m && m.content;
                if (!Array.isArray(c)) { out.push(m); continue; }
                const parts = [];
                let touched = false;
                for (const p of c) {
                    const url = p && p.image_url && p.image_url.url;
                    if (url != null) {
                        if (pgpyDataUrlImageUrlOk(url)) parts.push(p);
                        else {
                            removed++; touched = true;
                            parts.push({ type: 'text', text: '[图片已移除：附件不是有效的 PNG/JPEG/WebP/GIF（接口会返回 400 unsupported image）。请重新提供图片，或改用文字描述。]' });
                        }
                        continue;
                    }
                    if (p && (p.type === 'image' || p.type === 'input_image')) {
                        const raw = p.data || (p.image_url && p.image_url.url) || '';
                        const fake = (typeof raw === 'string' && raw.startsWith('data:'))
                            ? raw : ('data:' + (p.mimeType || 'image/png') + ';base64,' + String(raw));
                        if (pgpyDataUrlImageUrlOk(fake)) parts.push(p);
                        else { removed++; touched = true; parts.push({ type: 'text', text: '[图片已移除：图片数据不合法]' }); }
                        continue;
                    }
                    parts.push(p);
                }
                out.push(touched ? Object.assign({}, m, { content: parts }) : m);
            }
            if (removed) console.warn(`[image-guard] 出站前剔除 ${removed} 个无效图片内容项（避免接口 400）`);
            return out;
        }

        // 就地剔除所有图片段（坏图 400 时的兜底重试用）
        function stripImagesInPlace(conversation) {
            let n = 0;
            for (const m of (conversation || [])) {
                if (!m || !Array.isArray(m.content)) continue;
                const parts = [];
                for (const p of m.content) {
                    if (p && (p.image_url || p.type === 'image' || p.type === 'input_image')) {
                        n++;
                        parts.push({ type: 'text', text: '[图片已剔除：接口不接受该图片]' });
                    } else parts.push(p);
                }
                if (parts.length) m.content = parts;
            }
            return n;
        }

        function isImageRejectedError(status, message) {
            if (status !== 400 && status !== 415 && status !== 422) return false;
            const s = String(message || '');
            return /(unsupported image|invalid image|not a valid image|image[^.]{0,60}(format|type)[^.]{0,40}(support|valid)|图片.{0,12}(格式|无效|不支持)|unsupported (file|media) type)/i.test(s);
        }

        function stripForSend(rawconversation) {
            // 先做确定性的配对修复，再规整为规范最小形状（逐轮字节稳定 → 前缀缓存持续命中）
            return sanitizeToolPairing(sanitizeImagePayloads(rawconversation)).map((item) => {
                const hasToolCalls = !!(item && Array.isArray(item.tool_calls) && item.tool_calls.length > 0);
                const keepReasoning = !!(item && item.role === 'assistant' && hasToolCalls);
                return buildWireMessage(item, keepReasoning);
            });
        }

        // ── 上下文超长自动恢复 · 辅助函数 ──────────────────────────────────────
        // 识别各厂商「上下文超长」类错误：措辞不一（maximum context length / context_length_exceeded /
        // prompt is too long / too many tokens …），用「状态码 + 关键词」兜底。
        function isContextOverflowError(status, message) {
            if (status !== 400 && status !== 413 && status !== 422) return false;
            const m = String(message || '');
            return /(context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|reduce the length|exceed[a-z]*[^.]*tokens?|tokens?[^.]*exceed|max[a-z]*\s*tokens?)/i.test(m);
        }
        // 估算单条消息的字符数（含 content 各形态与 tool_calls），用于裁剪预算
        function msgChars(m) {
            if (!m) return 0;
            let n = 0;
            const c = m.content;
            if (typeof c === 'string') n += c.length;
            else if (Array.isArray(c)) {
                for (const p of c) {
                    if (p && typeof p.text === 'string') n += p.text.length;
                    else if (p && p.image_url) n += 4000; // 图片按占位估算
                }
            } else if (c != null) { try { n += JSON.stringify(c).length; } catch (_) {} }
            if (Array.isArray(m.tool_calls)) { try { n += JSON.stringify(m.tool_calls).length; } catch (_) {} }
            return n;
        }
        // 取消息的纯文本（多模态取 text 段），供交接摘要使用
        function textOfMessage(m) {
            if (!m) return '';
            const c = m.content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join('\n');
            return '';
        }
        function clipText(s, n) {
            s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        }

        // 解析当前生效的 LLM 端点/模型（多 provider + 子代理模型路由；providers 为空时回退旧字段）
        function __resolveLLM(opts) {
            try {
                if (typeof ProviderConfig !== 'undefined' && ProviderConfig) return ProviderConfig.resolve(chatbotStore, opts || {});
            } catch (_) {}
            return {
                url: chatbotStore.url, path: chatbotStore.path,
                model: (opts && opts.model) || chatbotStore.model,
                apiKey: chatbotStore.apiKey, authPrefix: chatbotStore.authPrefix,
                contentType: chatbotStore.contentType, method: chatbotStore.method
            };
        }

        // 非流式一次性请求（压缩摘要等内部调用）——复用同一 system+tools 前缀，命中已缓存头部
        async function fetchChatOnce(messages, opts = {}) {
            messages = sanitizeImagePayloads(messages);
            const llm = __resolveLLM({ model: opts.model, sub: !!opts.excludeTools });
            const headers = { "Content-Type": llm.contentType };
            if (llm.apiKey) headers.Authorization = `${llm.authPrefix} ${llm.apiKey}`;
            const body = {
                messages,
                model: llm.model,
                stream: false
            };
            const maxKey = chatbotStore.max_tokens_type || 'max_tokens';
            body[maxKey] = opts.maxTokens || (chatbotStore.max_tokens_value ? parseInt(chatbotStore.max_tokens_value) : 1024);
            body.temperature = opts.temperature != null ? opts.temperature : 0.3;
            if (chatbotStore.cacheMode !== false && chatbotStore.mcp) {
                const tools = await prefixManager.getTools(opts.excludeTools);
                if (tools && tools.length) body.tools = tools;
                const shapeVariant = (Array.isArray(opts.excludeTools) && opts.excludeTools.length > 0) ? 'sub' : 'main';
                prefixManager.noteShape(prefixManager.getSystem(), tools || [], shapeVariant);
            }
            const resp = await fetch(llm.url + (llm.path || ''), {
                method: llm.method || 'POST',
                headers,
                body: JSON.stringify(body)
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => null);
                throw new Error((err && err.error && err.error.message) ? `${resp.status}: ${err.error.message}` : `HTTP ${resp.status}`);
            }
            const data = await resp.json();
            // track:false 供内部调用（如压缩摘要）使用 —— 不计入面向用户的缓存命中统计
            if (data.usage && opts.track !== false) cacheStatsStore.record(data.usage);
            const choice = data.choices && data.choices[0];
            const msg = choice && choice.message;
            return { content: (msg && msg.content) || '', reasoning: (msg && msg.reasoning_content) || '' };
        }


        // createCompletion 引擎（微调：不再重复设置 generating）
        // ══════════════════════════════════════════════════════════
        const createCompletion = async (rawconversation, generatingRef, storeContext, options = {}) => {
            const conversation = stripForSend(rawconversation);

            try {
                // 不再设置 generating，由外部控制
                // 但如果 generatingRef 是对象，我们可以保持，但这里我们信任外部控制
                // 但为了兼容，我们仍然支持外部传入的 generating 对象（比如子代理）
                if (generatingRef !== undefined && generatingRef !== null) {
                    if (typeof generatingRef === 'object' && 'value' in generatingRef) {
                        generatingRef.value = true;
                    } else if (typeof generatingRef === 'object' && generatingRef.generating !== undefined) {
                        generatingRef.generating = true;
                    }
                }

                const __isSub = Array.isArray(options.excludeTools) && options.excludeTools.length > 0;
                const llm = __resolveLLM({ sub: __isSub });
                const headers = { "Content-Type": llm.contentType };
                if (llm.apiKey) headers.Authorization = `${llm.authPrefix} ${llm.apiKey}`;

                const body = {
                    // 第二个参数用于区分主会话 / 子代理：任务中心的阶段注入只作用于主会话
                    messages: await agentStore.promptMessage(conversation, { sub: __isSub }),
                    model: llm.model,
                    stream: chatbotStore.stream
                };

                // 前缀缓存模式：流式请求附带 usage —— DeepSeek/OpenAI 在末帧返回
                // prompt_cache_hit_tokens / prompt_cache_miss_tokens，用于展示命中率与省钱估算
                if (chatbotStore.cacheMode !== false && chatbotStore.stream) {
                    body.stream_options = { include_usage: true };
                }

                if (chatbotStore.max_tokens_value) {
                    body[chatbotStore.max_tokens_type] = parseInt(chatbotStore.max_tokens_value);
                }
                body["temperature"] = chatbotStore.temperature ? parseFloat(chatbotStore.temperature) : 1.0;
                body["top_p"] = chatbotStore.top_p ? parseFloat(chatbotStore.top_p) : 1.0;

                let activeTools = [];
                if (chatbotStore.mcp) {
                    // tools 数组是前缀缓存 key 的一部分：必须逐轮字节稳定（顺序/内容都不变）。
                    // prefixManager 缓存工具列表，只有用户显式刷新才重建（一次 cache miss）。
                    const tools = await prefixManager.getTools(options.excludeTools);
                    if (tools && tools.length) { body["tools"] = tools; activeTools = tools; }
                }
                // 抓取本轮前缀形状（system + tools）：任何漂移都会被记录原因，
                // 下一轮在统计条上提示「prefix 变更 → 本轮一次 miss」。
                const shapeVariant = (Array.isArray(options.excludeTools) && options.excludeTools.length > 0) ? 'sub' : 'main';
                prefixManager.noteShape(prefixManager.getSystem(), activeTools, shapeVariant);

                // ── 会话事实源（dsh 式不变量 model-visible ⟺ logged）──
                //   发请求前，把「内存对话」对齐进日志，并把本轮「模型可见载荷」指纹记入日志；
                //   仅主会话记录（子代理有各自上下文，不混入主日志）。
                try {
                    if (storeContext === messageStore && typeof sessionLog !== 'undefined' && sessionLog) {
                        sessionLog.recordRequest(body.messages, rawconversation);
                    }
                } catch (_) {}

                const request = {
                    headers: headers,
                    method: llm.method || chatbotStore.method,
                    body: JSON.stringify(body)
                };

                const completion = await fetch(
                    llm.url + (llm.path ? llm.path : ''),
                    request
                );

                if (!completion.ok) {
                    const errorData = await completion.json().catch(() => ({}));
                    const errMsg = (errorData.error && errorData.error.message)
                        || (errorData.detail && errorData.detail[0] && errorData.detail[0].msg)
                        || completion.statusText || '';
                    // ── 上下文超长自动恢复（仅主会话）：先原地裁剪重试，仍不行再自动交接新会话 ──
                    //   识别到「上下文超长」类错误时，不让整轮就此中断，而是自动接续继续跑。
                    //   _ctxRecoverCount 由 sendMessage / startNewSession 每轮重置，防止死循环。
                    if (storeContext === messageStore
                        && isContextOverflowError(completion.status, errMsg)
                        && (messageStore._ctxRecoverCount || 0) < 4) {
                        messageStore._ctxRecoverCount = (messageStore._ctxRecoverCount || 0) + 1;
                        try {
                            const outcome = await messageStore.autoRecoverContextOverflow(errMsg);
                            if (outcome === 'retry') {
                                // 对话已原地裁剪（数组引用不变）→ 用裁剪后的上下文重新发起本轮请求
                                return createCompletion(rawconversation, generatingRef, storeContext, options);
                            }
                            if (outcome === 'handoff') {
                                // 已安排新会话接管（由 startInference 的 finally 消费）→ 结束本轮
                                return;
                            }
                        } catch (e) {
                            console.error('上下文超长自动恢复失败:', e);
                        }
                    }
                    // ── 坏图 400 自动恢复：剔除本轮所有图片后自动重试一次 ──
                    //    正常情况下 sanitizeImagePayloads 已在组包前拦下坏图；这里是最后兜底，
                    //    避免「一次坏图 = 本轮彻底失败 + 用户还得手动收拾历史」。
                    if (isImageRejectedError(completion.status, errMsg) && !(options && options.__imgRetry)) {
                        const stripped = stripImagesInPlace(rawconversation);
                        if (stripped > 0) {
                            try {
                                snackbarStore.showWarningMessage(
                                    `接口拒收图片（${String(errMsg).slice(0, 100)}），已自动剔除 ${stripped} 张图片并重试`);
                            } catch (_) {}
                            return createCompletion(rawconversation, generatingRef, storeContext,
                                Object.assign({}, options, { __imgRetry: true }));
                        }
                    }
                    if (errorData.error?.message)
                        snackbarStore.showErrorMessage(`${completion.status}: ${errorData.error.message}`);
                    else if (errorData.detail?.[0]?.msg)
                        snackbarStore.showErrorMessage(
                            `${completion.status}${(" - " + errorData.detail[0]?.loc + ":") || ":"} ${errorData.detail[0]?.msg}`
                            );
                    else
                        snackbarStore.showErrorMessage(`${completion.status}: ${completion.statusText}`);
                    return;
                }

                const reader = completion.body?.getReader();
                if (!reader) {
                    snackbarStore.showErrorMessage('$vuetify.dataIterator.snackbar.parseStreamFail');
                    return;
                }

                rawconversation.push({
                    content: "",
                    reasoning_content: "",
                    tool_calls: [],
                    role: "assistant"
                });

                if (storeContext === messageStore) {
                    renderConversation();
                } else if (storeContext && storeContext.$el) {
                    renderSubagentChat(storeContext);
                }

                let buffer = '';
                await read(reader, rawconversation, buffer, chatbotStore.stream, generatingRef, storeContext);

                // 流结束：最后一条 assistant 消息做一次完整渲染（增量阶段纯文本 → markdown/高亮）
                if (storeContext === messageStore) {
                    finalizeStreamingContent();
                    // 知识库：把本条回答解析出的 [Sn] 引用回写为「消息 → 被引文档」
                    // 关系（差评归因的数据前提）。挂在主会话流结束点；失败静默。
                    try {
                        if (window.KBBridge && typeof window.KBBridge.finalizeTurnAnswer === 'function') {
                            window.KBBridge.finalizeTurnAnswer(messageStore.conversation);
                        }
                    } catch (_) { /* 引用回写失败不影响对话 */ }
                } else if (storeContext && storeContext.$el) {
                    // 子窗口同样在流结束后做一次完整渲染（流式阶段为纯文本增量）
                    finalizeSubagentStreaming(storeContext);
                }

            } catch (error) {
                snackbarStore.showErrorMessage(error.message);
            } finally {
                // 重置 generating（如果外部是对象）
                if (generatingRef !== undefined && generatingRef !== null) {
                    if (typeof generatingRef === 'object' && 'value' in generatingRef) {
                        generatingRef.value = false;
                    } else if (typeof generatingRef === 'object' && generatingRef.generating !== undefined) {
                        generatingRef.generating = false;
                    }
                }
                // 如果 storeContext 是 messageStore，generating 已在 sendMessage 的 finally 中重置，这里不再重置以免干扰
                // 但如果是子代理，则需要重置
                if (storeContext && storeContext !== messageStore && storeContext.$el) {
                    storeContext.generating = false;
                    updateSubagentInput(storeContext);
                }
            }
        };

        const read = async (reader, conversation, buffer, stream, generatingRef, storeContext) => {
            // 一个解码器贯穿整个读取链（旧实现每 chunk 新建 TextDecoder）：
            // {stream:true} 让被 chunk 边界切断的多字节 UTF-8 字符（中文）在下一块到达时正确续接，
            // 避免流式中文乱码和半行 JSON 解析失败
            const decoder = new TextDecoder();
            return readChunks(reader, conversation, buffer, stream, generatingRef, storeContext, decoder);
        };

        const readChunks = async (reader, conversation, buffer, stream, generatingRef, storeContext, decoder) => {
            const { done, value } = await reader.read();

            let shouldStop = false;
            if (generatingRef !== undefined && generatingRef !== null) {
                if (typeof generatingRef === 'object' && 'value' in generatingRef) {
                    shouldStop = !generatingRef.value;
                } else if (typeof generatingRef === 'object' && generatingRef.generating !== undefined) {
                    shouldStop = !generatingRef.generating;
                }
            }
            // 对于主 store，检查 messageStore.generating
            if (storeContext === messageStore) {
                shouldStop = shouldStop || !messageStore.generating;
            }

            if (done || shouldStop) {
                if (generatingRef !== undefined && generatingRef !== null) {
                    if (typeof generatingRef === 'object' && 'value' in generatingRef) {
                        generatingRef.value = false;
                    } else if (typeof generatingRef === 'object' && generatingRef.generating !== undefined) {
                        generatingRef.generating = false;
                    }
                }
                if (storeContext && storeContext !== messageStore && storeContext.$el) {
                    storeContext.generating = false;
                }
                // 冲刷缓冲区：流自然结束时最后一块数据行可能没有换行结尾，
                // 直接丢弃会导致回复尾部内容丢失（“最后的信息不显示”）。
                // 手动停止（shouldStop）时不清洗，避免把截断的半行 JSON 追加进回复
                if (done && buffer.length > 0) {
                    const line = buffer.trim();
                    if (line.length > 0) {
                        const pos = line.indexOf(':');
                        const name = line.substring(0, pos);
                        if (name === 'data') {
                            const content = line.substring(pos + 1).trim();
                            if (content.length > 0 && content !== "[DONE]") {
                                parseJson(content, conversation, storeContext);
                            }
                        }
                    }
                }
                decoder.decode(); // 冲刷解码器尾部缓冲（{stream:true} 模式下可能残留不完整字节）
                return reader.releaseLock();
            }

            const chunks = decoder.decode(value, { stream: true });

            if (stream) {
                let parts = chunks.split('\n');
                if (parts.length === 1) {
                    buffer += parts[0];
                    return readChunks(reader, conversation, buffer, stream, generatingRef, storeContext, decoder);
                }
                if (buffer.length > 0) {
                    parts[0] = buffer + parts[0];
                    buffer = '';
                }
                const last = parts[parts.length - 1];
                if (last && last.length > 0) {
                    buffer = parts.pop();
                }
                parts
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                    .forEach(line => {
                        const pos = line.indexOf(':');
                        const name = line.substring(0, pos);
                        if (name !== 'data') return;
                        const content = line.substring(pos + 1).trim();
                        if (content.length === 0 || content === "[DONE]") return;
                        parseJson(content, conversation, storeContext);
                    });
            } else {
                parseJson(chunks, conversation, storeContext);
            }

            return readChunks(reader, conversation, buffer, stream, generatingRef, storeContext, decoder);
        };

        const parseJson = (content, conversation, storeContext) => {
            try {
                const parsed = JSON.parse(content);
                parseChoices(parsed, conversation, storeContext);
            } catch (e) {
                console.log(e, content);
                parseChoice(content, conversation, storeContext);
            }
        };

        const parseChoices = (parsed, conversation, storeContext) => {
            // 前缀缓存模式：流式末帧/非流式响应携带 usage（含 cache hit/miss tokens），累计到统计
            if (parsed && parsed.usage) {
                cacheStatsStore.record(parsed.usage);
                // 本页会话累计（继续对话累加，仅刷新页面重置）的 Token 费用统计。
                // 注意：不能再按 storeContext === messageStore 过滤 —— subagent 窗口请求时
                // storeContext 是该窗口对象，过滤会把子代理消耗的 token 漏计到「本页累计」。
                // 主聊天与 subagent 的用量都应计入，故这里无条件累计。
                messageStore.recordConvUsage(parsed.usage);
            }
            if ('choices' in parsed) {
                return parsed.choices.map(choice => {
                    const content = choice.delta || choice.message;
                    return parseChoice(content, conversation, storeContext);
                });
            } else if ('response' in parsed) {
                return parseChoice(parsed.response, conversation, storeContext);
            } else {
                return parseChoice(parsed, conversation, storeContext);
            }
        };

        const parseChoice = (choice, conversation, storeContext) => {
            if (choice) {
                const target = conversation[conversation.length - 1];
                if (target && target.role === 'assistant') {
                    if (typeof choice === 'string') {
                        target.content += choice;
                    } else {
                        // content 与 reasoning_content 必须独立判断，不能用 else-if 链：
                        // DeepSeek 等模型在思考阶段每个 delta 都带 content:""（空字符串），
                        // 先命中 content 分支会让 reasoning_content 被永远丢弃 → 思考过程不显示
                        if (typeof choice.content === 'string') {
                            target.content += choice.content;
                        }
                        if (typeof choice.reasoning_content === 'string') {
                            target.reasoning_content += choice.reasoning_content;
                        }
                    }
                    parseTool(choice.tool_calls, target);
                }
            }
            if (storeContext === messageStore) {
                updateStreamingContent();
            } else if (storeContext && storeContext.$el) {
                scheduleSubagentStreaming(storeContext);
            }
        };

        const parseTool = (tools, target) => {
            if (tools) {
                tools.forEach(tool => {
                    const lastTool = target.tool_calls[target.tool_calls.length - 1];
                    if (lastTool && (!tool.id || lastTool.id == tool.id)) {
                        const source = tool.function;
                        for (const key in source) {
                            if (source[key] === null) continue;
                            if (lastTool.function[key]) {
                                lastTool.function[key] += source[key];
                            } else {
                                lastTool.function[key] = source[key];
                            }
                        }
                    } else {
                        target.tool_calls.push(tool);
                    }
                });
            }
        };

