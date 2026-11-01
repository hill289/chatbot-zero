        // ══════════════════════════════════════════════════════════
        // Stores
        // ══════════════════════════════════════════════════════════
        const snackbarStore = {
            isShow: false,
            message: "",
            type: "",
            showMessage(message, type = "") {
                this.isShow = true;
                this.message = message;
                this.type = type;
                this.render();
            },
            showErrorMessage(message) { this.showMessage(message, "error"); },
            showSuccessMessage(message) { this.showMessage(message, "success"); },
            showInfoMessage(message) { this.showMessage(message, "info"); },
            showWarningMessage(message) { this.showMessage(message, "warning"); },
            getIcon() {
                const icon = { info: "ℹ️", success: "✅", error: "⛔", warning: "⚠️" };
                return icon[this.type] || "ℹ️";
            },
            render() {
                const sEl = document.getElementById('snackbar');
                if (!sEl) return;
                sEl.classList.remove('success', 'error', 'info', 'warning');
                if (!this.isShow || !this.message) { sEl.classList.remove('show'); return; }
                if (this.type) sEl.classList.add(this.type);
                const label = typeof this.message === 'string' && this.message.startsWith('$vuetify.')
                    ? t(this.message) : this.message;
                sEl.innerHTML =
                    `<span>${this.getIcon()} ${escapeHtml(label)}</span><button class="snack-close">✕</button>`;
                sEl.classList.add('show');
                const closeBtn = sEl.querySelector('.snack-close');
                if (closeBtn) closeBtn.addEventListener('click', () => { this.isShow = false;
                    sEl.classList.remove('show'); });
                clearTimeout(this._timer);
                this._timer = setTimeout(() => { this.isShow = false;
                    sEl.classList.remove('show'); }, 4000);
            }
        };

        const settingStore = {
            inputRow: 1,
            avatarSize: 24,
            configDialog: false,
            configHistory: false,
            agentDialog: false,
            apiKeyShow: false,
            toolboxShow: false,
            fontStatus: false,
            initDialog() {
                this.apiKeyShow = false;
                this.configDialog = true;
                document.getElementById('configModal').classList.add('open');
                loadConfigDialog();
            },
            setInputRow(int, timeout) {
                setTimeout(() => { this.inputRow = int; }, timeout);
            }
        };

        const chatbotStoreDefault = () => ({
            apiKey: "sk-xxx",
            url: "https://api.deepseek.com",
            path: "/chat/completions",
            model: "deepseek-flash",
            authPrefix: "Bearer",
            contentType: "application/json",
            max_tokens_type: "max_tokens",
            max_tokens_value: "",
            temperature: "",
            top_p: "",
            method: "POST",
            stream: true,
            stream: true,
            mcp: true,
            cacheMode: true,
            // ── 多模态图片回传开关（默认 true）──
            //   控制 run_node / read_file 是否把图片作为 image 内容项回传给模型。
            //   纯文本模型请置 false（也可在「⚙️ 配置 → Advanced」取消勾选「启用多模态图片回传」）：
            //   关闭后工具只回文本描述，避免文本模型因 image_url 内容项报 400。仅影响工具输出里的图片，
            //   不影响用户手动上传的图片附件。判定逻辑见 03-node-tools.js 的 pgpyMultimodalEnabled()。
            multimodalEnabled: true,
            // ── 硬切窗口（Hard-Cut Window）──
            // 上下文接近窗口上限时不再压缩摘要，而是把旧对话归档为转录历史 → 开一个干净新窗口，
            // 新窗口只带「工作状态 + 工作笔记 + 历史指针」。需要回旧细节时用 search_transcript 检索。
            //   contextWindowTokens：模型上下文窗口大小（token，按实际模型填）
            //   默认 1,048,576（1024K / 1M）。若你的模型是 64K / 128K，请改成对应值，
            //   否则「已用上下文 %」会按 1M 窗口计算。
            //   hardCutRatio：达到窗口的多少比例就触发硬切（默认 0.85）
            hardCutEnabled: true,
            contextWindowTokens: 1048576,
            hardCutRatio: 0.85,
            mcpUrls: [],
            // ── SSH 多主机（MCP ssh 工具 + VFS SFTP 传输）──
            // [{ host, port, username, password }]；password 持久化时剥离进
            // safeStorage（键 ssh.<host>:<port>@<user>），启动时回填。
            sshHosts: [],
            // ── 可配置「禁用」的工具（按工具名）──
            // 例：['read_url'] 即禁用 read_url 工具 —— 该工具不再下发给模型（listTools 过滤），
            // 即使被调用也会被拒绝（callTool 拦截）。可在「⚙️ 配置 → Advanced」勾选切换，
            // 也可直接改 localStorage 的 chatbotStore.disabledTools，或随 config JSON 导入导出。
            disabledTools: [],
            // ── 执行护栏（loop guard）阈值：「⚙️ 配置 → Advanced」可视化编辑 ──
            //   防长任务跑偏：单轮步数上限 / 连续重复调用「提醒」与「中止」阈值 / 连续失败上限
            loopGuard: { maxSteps: 30, softRepeat: 3, hardRepeat: 5, maxErrorRepeat: 3 },
            // ── 工具结果溢出（spill）：超大工具结果先落盘，只回「前+后+指针」 ──
            spill: { enabled: true, maxChars: 20000, headChars: 4000, tailChars: 2000 },
            // ── 执行截止（tool deadline）：任何工具超过该毫秒数未返回即放弃等待 ──
            guard: { enabled: true, deadlineMs: 600000, exempt: ['ask_user', 'run_shell', 'run_tests', 'run_subagent'] },
            // ── 工作区上下文：AGENTS.md / 当前时间 / 工作目录注入（只在对话尾部） ──
            workspaceContext: { enabled: true, includeTime: true, maxAgentsChars: 8000 },
            // ── 本地记忆层（Local Memory）：是否启用，默认「不启用」──
            //   enabled=false：不初始化 IndexedDB、不自动召回 / 画像注入、不索引会话，
            //   memory_* / session_search 工具也不下发给模型（零副作用、零隐私落盘）。
            //   可在「⚙️ 配置 → Advanced」勾选开启，或改 localStorage 的 chatbotStore.memory.enabled。
            memory: { enabled: false, autoRecall: true, autoIndexTurns: true, recallLimit: 6 },
            // ── 多 Provider / 每 agent 模型路由（providers 为空时回退旧 url/path/model） ──
            providers: [],
            activeProviderId: '',
            subagentProviderId: '',
            subagentModel: '',
            // ── 进程沙箱（Windows = Job Object；其它平台 = 策略层）──
            sandbox: { enabled: true, mode: 'auto', allowNetwork: false, memoryMB: 1024, cpuSec: 300, pidsLimit: 256, ignoreScripts: true, restrictedToken: false, envAllowlist: [] },
            // ── 工具审批（approval gate）：「⚙️ 配置 → Advanced」可视化编辑 ──
            //   写 / 改 / 删 / 执行 四类有副作用的工具，执行前逐次确认：
            //   allow-once / allow-session / deny（拒绝理由会作为工具结果回给模型）。
            //   tools 里的工具名即「需要审批」的白名单；run_node 可自行加入（它能读写虚拟 FS）。
            approval: {
                enabled: true,
                tools: (typeof window !== 'undefined' && window.ApprovalService)
                    ? window.ApprovalService.DEFAULT_TOOLS.slice()
                    : ['write_file', 'edit_file', 'replace_lines', 'add_content', 'delete_content', 'delete_file', 'run_shell'],
                timeoutSec: 300
            }
        });
        const chatbotStore = Object.assign(chatbotStoreDefault(), persist.load('chatbotStore', {}));
        // ── 配置文件固化：应用目录 config/interface.json 存在时，以文件为准覆盖界面配置 ──
        //   在首次 saveChatbot（hydrateSecrets / 迁移）之前回读，避免旧 localStorage 值把
        //   手工编辑过的文件又写回去。密钥不在文件里，稍后由 hydrateSecrets 从 safeStorage 回填。
        (function applyConfigFileOnBoot() {
            try {
                if (!window.configFileAPI || typeof window.configFileAPI.readSync !== 'function') return;
                if (!window.ConfigFile || typeof window.ConfigFile.applyFileConfig !== 'function') return;
                const res = window.configFileAPI.readSync();
                if (res && res.ok && res.config) {
                    window.ConfigFile.applyFileConfig(chatbotStore, res.config);
                }
            } catch (_) { /* 配置文件异常绝不影响启动 */ }
        })();
        // 执行护栏阈值：旧数据可能缺失或只带部分字段 → 与默认值合并，保证四项齐全
        chatbotStore.loopGuard = Object.assign(
            { maxSteps: 30, softRepeat: 3, hardRepeat: 5, maxErrorRepeat: 3 },
            chatbotStore.loopGuard || {}
        );
        // 工具审批策略：旧数据可能整块缺失 / 只带部分字段 → 与默认值合并，保证三项齐全
        chatbotStore.approval = Object.assign(
            { enabled: true, timeoutSec: 300 },
            chatbotStore.approval || {}
        );
        if (!Array.isArray(chatbotStore.approval.tools) || chatbotStore.approval.tools.length === 0) {
            chatbotStore.approval.tools = (typeof window !== 'undefined' && window.ApprovalService)
                ? window.ApprovalService.DEFAULT_TOOLS.slice()
                : ['write_file', 'edit_file', 'replace_lines', 'add_content', 'delete_content', 'delete_file', 'run_shell'];
        }
        if (!isFinite(Number(chatbotStore.approval.timeoutSec))) chatbotStore.approval.timeoutSec = 300;
        // 溢出 / 截止 / 工作区上下文：旧数据可能整块缺失 → 与默认值合并
        chatbotStore.spill = Object.assign(
            { enabled: true, maxChars: 20000, headChars: 4000, tailChars: 2000 },
            chatbotStore.spill || {}
        );
        chatbotStore.guard = Object.assign(
            { enabled: true, deadlineMs: 600000, exempt: ['ask_user', 'run_shell', 'run_tests', 'run_subagent'] },
            chatbotStore.guard || {}
        );
        if (!Array.isArray(chatbotStore.guard.exempt)) {
            chatbotStore.guard.exempt = ['ask_user', 'run_shell', 'run_tests', 'run_subagent'];
        }
        chatbotStore.workspaceContext = Object.assign(
            { enabled: true, includeTime: true, maxAgentsChars: 8000 },
            chatbotStore.workspaceContext || {}
        );
        // 本地记忆层：旧数据可能整块缺失（旧版本记忆默认开启）→ 与默认值合并；
        // 缺失时 enabled 保持 false（新默认：不启用）。
        chatbotStore.memory = Object.assign(
            { enabled: false, autoRecall: true, autoIndexTurns: true, recallLimit: 6 },
            chatbotStore.memory || {}
        );
        chatbotStore.memory.enabled = chatbotStore.memory.enabled === true; // 只认显式 true
        if (!isFinite(Number(chatbotStore.memory.recallLimit)) || Number(chatbotStore.memory.recallLimit) < 1) {
            chatbotStore.memory.recallLimit = 6;
        }
        // 多 provider / 子代理模型路由：旧数据缺失时补默认（providers 为空 = 维持旧行为）
        if (!Array.isArray(chatbotStore.providers)) chatbotStore.providers = [];
        if (chatbotStore.activeProviderId == null) chatbotStore.activeProviderId = '';
        if (chatbotStore.subagentProviderId == null) chatbotStore.subagentProviderId = '';
        if (chatbotStore.subagentModel == null) chatbotStore.subagentModel = '';
        chatbotStore.sandbox = Object.assign(
            { enabled: true, mode: 'auto', allowNetwork: false, memoryMB: 1024, cpuSec: 300, pidsLimit: 256, ignoreScripts: true, restrictedToken: false, envAllowlist: [] },
            chatbotStore.sandbox || {}
        );
        // 迁移：旧版本单个 mcpUrl（字符串）→ mcpUrls（数组），以支持连接多个外部 MCP Server
        if (!Array.isArray(chatbotStore.mcpUrls)) {
            chatbotStore.mcpUrls = chatbotStore.mcpUrl ? [String(chatbotStore.mcpUrl)] : [];
        } else if (chatbotStore.mcpUrls.length === 0 && chatbotStore.mcpUrl) {
            chatbotStore.mcpUrls = [String(chatbotStore.mcpUrl)];
        }
        // 密钥写入去重：同一值不重复加密落盘（saveChatbot 会被频繁调用）
        const _secretCache = Object.create(null);
        const saveSecretOnce = (name, value) => {
            const v = String(value == null ? '' : value);
            if (_secretCache[name] === v) return;
            _secretCache[name] = v;
            secretStore.set(name, v);
        };

        // 持久化时把密钥从快照里剥离（API Key 走 safeStorage，绝不落 localStorage）。
        // 注意：只改快照，不动 chatbotStore 内存对象——AI 请求仍能正常拿到 apiKey。
        const stripSecretsForSave = (snapshot) => {
            try {
                const k = String(snapshot.apiKey || '');
                if (k && k !== 'sk-xxx') {
                    saveSecretOnce('apiKey', k);
                    snapshot.apiKey = '';
                    snapshot.apiKeyInSecret = true;
                } else if (!k) {
                    snapshot.apiKey = '';
                }
                if (Array.isArray(snapshot.providers)) {
                    snapshot.providers.forEach(p => {
                        if (!p || !p.apiKey) return;
                        saveSecretOnce('provider.' + (p.id || p.name || 'default') + '.apiKey', p.apiKey);
                        p.apiKey = '';
                        p.apiKeyInSecret = true;
                    });
                }
                // SSH 主机密码：与 API Key 同待遇（safeStorage 加密，绝不落 localStorage 明文）
                if (Array.isArray(snapshot.sshHosts)) {
                    snapshot.sshHosts.forEach(h => {
                        if (!h || !h.password) return;
                        const id = 'ssh.' + String(h.host || '').trim() + ':' + (parseInt(h.port, 10) || 22)
                            + '@' + String(h.username || '').trim();
                        saveSecretOnce(id, h.password);
                        h.password = '';
                        h.passwordInSecret = true;
                    });
                }
            } catch (_) { /* 剥离失败也不能把密钥写进 localStorage：下面兜底清空 */ }
            return snapshot;
        };

        const saveChatbot = () => {
            let snapshot;
            try { snapshot = JSON.parse(JSON.stringify(chatbotStore)); } catch (_) { snapshot = {}; }
            snapshot = stripSecretsForSave(snapshot);
            // 兜底：任何情况下 apiKey 都不允许以明文出现在 localStorage
            snapshot.apiKey = '';
            if (Array.isArray(snapshot.providers)) snapshot.providers.forEach(p => { if (p) p.apiKey = ''; });
            persist.save('chatbotStore', snapshot);
            // ── 同步固化到「应用目录 config/interface.json」──────────────
            //   只写白名单接口配置并剥离密钥（apiKey / provider.apiKey / ssh.password 不落文件）。
            try {
                if (window.configFileAPI && typeof window.configFileAPI.write === 'function'
                    && window.ConfigFile && typeof window.ConfigFile.pickFileConfig === 'function') {
                    window.configFileAPI.write(window.ConfigFile.pickFileConfig(chatbotStore));
                }
            } catch (_) { /* 写文件失败不影响 localStorage 持久化 */ }
        };

        // ── API Key：从 safeStorage 取回 + 迁移历史明文 ──────────────
        // 旧版本把 apiKey 明文写在 localStorage 的 chatbotStore 里：
        //   1) 读到后立刻加密进 safeStorage；
        //   2) 再 saveChatbot() 把 localStorage 里的明文抹掉。
        (function hydrateSecrets() {
            const legacyKey = String(chatbotStore.apiKey || '');
            if (legacyKey && legacyKey !== 'sk-xxx') {
                const fromSecret = secretStore.get('apiKey');
                if (fromSecret) {
                    chatbotStore.apiKey = fromSecret;
                } else {
                    secretStore.set('apiKey', legacyKey);
                    chatbotStore.apiKey = legacyKey;
                }
                saveChatbot(); // 抹掉 localStorage 明文
            } else {
                const fromSecret = secretStore.get('apiKey');
                chatbotStore.apiKey = fromSecret || '';
                if (legacyKey) saveChatbot();
            }
            if (Array.isArray(chatbotStore.providers)) {
                chatbotStore.providers.forEach(p => {
                    if (!p) return;
                    const name = 'provider.' + (p.id || p.name || 'default') + '.apiKey';
                    if (p.apiKey) secretStore.set(name, p.apiKey);
                    else {
                        const k = secretStore.get(name);
                        if (k) p.apiKey = k;
                    }
                });
            }
            // SSH 密码回填：内存里有（本次会话已填）→ 写入 secret；否则从 secret 取回
            if (Array.isArray(chatbotStore.sshHosts)) {
                chatbotStore.sshHosts.forEach(h => {
                    if (!h || !h.host) return;
                    const id = 'ssh.' + String(h.host).trim() + ':' + (parseInt(h.port, 10) || 22)
                        + '@' + String(h.username || '').trim();
                    if (h.password) secretStore.set(id, h.password);
                    else {
                        const pw = secretStore.get(id);
                        if (pw) h.password = pw;
                    }
                });
            }
        })();
        // 迁移：旧版本把 contextWindowTokens 的默认值写成 64000（64K），
        // 在 1M 窗口的模型上会把「已用上下文」放大 16 倍（例如 63K 就显示 98.8%）。
        // 仅当值仍是旧默认值（或缺失）、且从未迁移过时，升级为 1,048,576（1024K）；
        // 用户此后显式配置的其它值（包括再次改回 64000）不再被覆盖。
        if (!chatbotStore.ctxWindowMigrated1M) {
            const win = Number(chatbotStore.contextWindowTokens);
            if (!isFinite(win) || win <= 0 || win === 64000) {
                chatbotStore.contextWindowTokens = 1048576;
            }
            chatbotStore.ctxWindowMigrated1M = true;
            saveChatbot();
        }
        // v2：部分用户此前已被旧迁移标记置位（ctxWindowMigrated1M=true），但值仍停在 64000，
        // 导致「已用上下文」按 64K 计算（例如 63.2k/64.0k 显示 98.8%）。这里再做一次
        // 一次性升级：仅当值仍是旧的 64000 时改为 1048576；用户之后显式改回 64000 不会再被覆盖。
        if (!chatbotStore.ctxWindowMigrated1Mv2) {
            if (Number(chatbotStore.contextWindowTokens) === 64000) {
                chatbotStore.contextWindowTokens = 1048576;
            }
            chatbotStore.ctxWindowMigrated1Mv2 = true;
            saveChatbot();
        }


        // ── 工具禁用配置（可配置禁用 read_url tool）─────────────────────────────
        // 以「工具名」为单位禁用工具：被禁用的工具
        //   1) 不再出现在下发给模型的 tools 列表里（mcpStore.listTools 过滤）；
        //   2) 即使被调用也会被拒绝（mcpStore.callTool 拦截）。
        // 配置来源：chatbotStore.disabledTools（持久化在 localStorage；随 config JSON 导入导出；
        // 「⚙️ 配置 → Advanced → 禁用 read_url 工具」复选框直接读写它）。
        // 例：想禁用 read_url，把 chatbotStore.disabledTools 设为 ['read_url']（默认 [] 即不禁用）。
        if (!Array.isArray(chatbotStore.disabledTools)) chatbotStore.disabledTools = [];
        function isToolDisabled(name) {
            if (!name) return false;
            return Array.isArray(chatbotStore.disabledTools) && chatbotStore.disabledTools.indexOf(name) !== -1;
        }
        // 读/写单个工具的禁用状态（写入后立即持久化）
        function setToolDisabled(name, disabled) {
            if (!name) return;
            const list = Array.isArray(chatbotStore.disabledTools) ? chatbotStore.disabledTools.slice() : [];
            const i = list.indexOf(name);
            if (disabled && i === -1) list.push(name);
            else if (!disabled && i !== -1) list.splice(i, 1);
            chatbotStore.disabledTools = list;
            saveChatbot();
        }

        const defaultChoiceDefault = () => ({
            url: ["https://api.openai.com", "http://127.0.0.1", "https://api.deepinfra.com", "https://api.deepseek.com",
                "https://api.aiql.com"
            ],
            path: ["/chat/completions", "/v1/chat/completions", "/v1/openai/chat/completions",
                "/openai/v1/chat/completions"
            ],
            model: ["meta-llama/Llama-3.3-70B-Instruct"],
            authPrefix: ["Bearer", "Base", "Token"],
            max_tokens_type: ["max_tokens", "max_completion_tokens", "max_new_tokens"]
        });
        const defaultChoiceStore = Object.assign(defaultChoiceDefault(), persist.load('defaultChoiceStore', {}));
        const saveDefaultChoice = () => persist.save('defaultChoiceStore', defaultChoiceStore);

        const historyStore = {
            // 防御：localStorage 里的旧数据可能不是数组（旧版本页面残留），加载时归一化，
            // 否则首次发送时 init() 的 unshift 抛错会中断 sendMessage 渲染
            conversation: (() => {
                const loaded = persist.load('historyStore', []);
                return Array.isArray(loaded) ? loaded : [];
            })(),
            getDate() {
                return new Date().toLocaleString('zh', { timeZoneName: 'short', hour12: false });
            },
            resetState() {
                // 清空历史时，连同磁盘上的会话事件日志一起删除；否则刷新时
                // sessionLog.boot() 会从 messages/<sid>/ 把它们恢复回来（表现为「清不掉」）。
                try {
                    if (typeof sessionLog !== 'undefined' && sessionLog
                        && typeof sessionLog.isEnabled === 'function' && sessionLog.isEnabled()
                        && typeof sessionLog._order === 'function') {
                        sessionLog._order().slice().forEach(function (sid) { try { sessionLog.removeSession(sid); } catch (_) {} });
                    }
                } catch (_) {}
                this.conversation = [];
                persist.save('historyStore', this.conversation);
                messageStore.resetTimer();
            },
            deleteById(index) { this.conversation.splice(index, 1);
                persist.save('historyStore', this.conversation); },
            init(conversation) {
                this.conversation.unshift({ id: this.getDate(), history: conversation });
                persist.save('historyStore', this.conversation);
            },
            // 整体落盘：chat-ui 靠 pinia-persist 在每次 state 变更时自动序列化整个 historyStore；
            // 纯 JS 版此前只在 init/resetState/deleteById 时保存，而 entry.history 与 messageStore.conversation
            // 是同一数组引用，后续 push 只更新内存不更新 localStorage，刷新后每条历史只剩第一条消息。
            save() {
                persist.save('historyStore', this.conversation);
                // 会话事件日志：把内存对话增量对齐到磁盘 append-only 日志（无 messagesAPI 时自动 no-op）
                try { if (typeof sessionLog !== 'undefined' && sessionLog) sessionLog.sync(messageStore.conversation); } catch (_) {}
            },
            replace(id) {
                this.deleteById(id);
                this.init(messageStore.conversation);
            },
            asyncReplace(id) {
                setTimeout(() => historyStore.replace(id), 0);
            },
            select(id) {
                settingStore.configHistory = false;
                document.getElementById('historyModal').classList.remove('open');
                messageStore.conversation = this.conversation[id].history;
                this.asyncReplace(id);
                messageStore.resetTimer();
                renderConversation();
                // 选择历史后对话非空：同步刷新右侧按钮（more ⋯）
                updateInputIcon();
            },
            getColor(id) {
                const targetElement = this.conversation[id]?.history.find(element => element.role === "assistant");
                return targetElement ? "#1867C0" : "#9e9e9e";
            },
            downloadById(id) {
                const name = this.conversation[id].id.replace(/[/: ]/g, '-');
                this.download(this.conversation[id].history, `history-${name}.json`);
            },
            downloadHistory() {
                this.download(this.conversation, 'history.json');
            },
            download(json, filename) {
                const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
            }
        };

        // ─── agentStore ───
        const agentStore = {
            card: null,
            columns: [],
            editDialog: false,
            getDragOption() {
                return { animation: 200, group: "task", disabled: false, ghostClass: "ghost" };
            },
            addCard(column) {
                const { addTitle, key } = column;
                if (!addTitle) return;
                const newCard = {
                    id: "_" + Math.random().toString(36).substring(2, 11),
                    state: key,
                    title: addTitle,
                    description: "",
                    refFile: null,
                    refText: "",
                    order: -1
                };
                column.cards.unshift(newCard);
                column.addTitle = "";
                column.isAddVisible = false;
                this.persistSelf();
                renderAgentBoard();
            },
            deleteCard(column, index) {
                column.cards.splice(index, 1);
                this.persistSelf();
                renderAgentBoard();
            },
            editCard(card) {
                this.card = { ...card };
                this.editDialog = true;
                document.getElementById('editCardModal').classList.add('open');
                document.getElementById('editCardTitle').value = card.title || '';
                document.getElementById('editCardDesc').value = card.description || '';
                document.getElementById('editCardRefText').textContent = card.refText || '';
                document.getElementById('editCardRefFile').value = '';
            },
            saveCard() {
                const editCard = this.card;
                if (editCard) {
                    const foundCard = this.columns.flatMap(column => column.cards).find(card => card.id === this.card.id);
                    if (foundCard) {
                        foundCard.title = editCard.title;
                        foundCard.refText = editCard.refText;
                        foundCard.refFile = editCard.refFile;
                        foundCard.description = editCard.description;
                        this.editDialog = false;
                        document.getElementById('editCardModal').classList.remove('open');
                        this.persistSelf();
                        renderAgentBoard();
                    }
                }
            },
            async promptMessage(conversation) {
                // 固定前缀：system 由 prefixManager 缓存（agent 卡片或默认提示词），逐轮字节稳定 → 前缀缓存持续命中。
                // Agent 卡片变更时 persistSelf → invalidateSystem 使缓存失效（下一轮一次 cache miss），避免悄悄漂移。
                const base = [{ content: prefixManager.getSystem(), role: "system" }, ...conversation];
                // 本地记忆层（可选）：自动召回 + 画像注入。
                // 只把召回块追加到「对话尾部最后一条 user 消息」，绝不改动被前缀缓存的 system+tools 前缀，
                // 因此不会破坏前缀缓存命中；记忆层异常时静默回退，绝不影响对话。
                try {
                    if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.enhance === 'function') {
                        base = await window.AgentMemoryBridge.enhance(base, conversation);
                    }
                } catch (_) { /* 记忆层故障不影响对话 */ }
                // 知识库引用注入（可选）：检索命中时给最后一条 user 消息追加
                // [S1..Sn] 引用块（同样只动对话尾部，失败静默回退）。
                try {
                    if (window.KBBridge && typeof window.KBBridge.enhance === 'function') {
                        base = await window.KBBridge.enhance(base, conversation);
                    }
                } catch (_) { /* 知识层故障不影响对话 */ }
                // 工作区上下文（可选）：AGENTS.md / 当前时间 / 工作目录。
                // 同样只注入到最后一条 user 消息尾部，不动 system+tools 前缀。
                try {
                    if (window.WorkspaceContextBridge && typeof window.WorkspaceContextBridge.enhance === 'function') {
                        base = await window.WorkspaceContextBridge.enhance(base, conversation);
                    }
                } catch (_) { /* 上下文注入故障不影响对话 */ }
                return base;
            },
            initAgent() {
                this.columns = [];
                const states = ["PROMPT", "BACKUP"];
                states.forEach((state, index) => {
                    this.columns.push({
                        key: state,
                        cards: [],
                        isAddVisible: false,
                        addTitle: "",
                        callback: (e) => this.changeState(e, index)
                    });
                });
                this.parseCards([
                    { id: 1, title: "Prompt 1", description: "", state: "PROMPT" }
                ]);
                this.persistSelf();
            },
            changeState(e, colIndex) {
                if (e.added || e.moved) {
                    const column = this.columns[colIndex];
                    for (let i = 0; i < column.cards.length; i++) {
                        column.cards[i].order = i;
                        column.cards[i].state = column.key;
                    }
                    this.persistSelf();
                    renderAgentBoard();
                }
            },
            parseCards(cards) {
                if (!cards) return this.columns.map(column => (column.cards = []));
                this.columns.forEach(column => {
                    column.cards = cards
                        .filter(card => card.state === column.key)
                        .sort((a, b) => (a.order < b.order ? -1 : 0));
                });
            },
            persistSelf() {
                persist.save('agentStore', { columns: this.columns }, true);
                // 卡片内容变更 → 系统提示词前缀变更：显式失效缓存（下一轮一次 cache miss）
                prefixManager.invalidateSystem();
            },
            loadPersisted() {
                const saved = persist.load('agentStore', null, true);
                if (saved && Array.isArray(saved.columns) && saved.columns.length > 0) {
                    saved.columns.forEach(col => {
                        col.isAddVisible = false;
                        col.addTitle = "";
                        col.callback = (e) => this.changeState(e, this.columns.findIndex(c => c.key === col.key));
                    });
                    this.columns = saved.columns;
                } else {
                    this.initAgent();
                }
            }
        };

        const promptStore = {
            promptDialog: false,
            promptSheet: false,
            promptList: [],
            promptSelect: {},
            search: '',
            loading: false,
            loadPrompts() {
                this.loading = true;
                try {
                    this.fetchPrompts().then((prompts) => {
                        this.promptList = prompts || [];
                        renderPromptList();
                    });
                } catch (error) {
                    console.error('Failed to load prompts:', error);
                } finally {
                    this.loading = false;
                }
            },
            async fetchPrompts() {
                const mcpServers = mcpStore.getServers();
                if (!mcpServers) return [];
                const mcpKeys = Object.keys(mcpServers);
                const allPrompts = [];
                for (const key of mcpKeys) {
                    const obj = await mcpServers[key]?.prompts?.list();
                    if (obj) {
                        obj.prompts.forEach(prompt => allPrompts.push({ title: key, ...prompt }));
                    }
                }
                return allPrompts;
            },
            select(prompt) {
                this.promptSelect = prompt;
                this.promptSheet = true;
                this.promptDialog = false;
                document.getElementById('promptModal').classList.remove('open');
                document.getElementById('promptSheetModal').classList.add('open');
                document.getElementById('promptSheetTitle').textContent = prompt.name || '';
                document.getElementById('promptSheetDesc').textContent = prompt.description || '';
                const argsWrap = document.getElementById('promptSheetArgs');
                argsWrap.innerHTML = '';
                if (prompt.arguments && prompt.arguments.length > 0) {
                    prompt.arguments.forEach(argument => {
                        if (!argument.content) argument.content = '';
                        const g = elFromHTML('<div class="form-group"><label></label><textarea rows="2"></textarea></div>');
                        g.querySelector('label').textContent = argument.name || '';
                        const ta = g.querySelector('textarea');
                        ta.value = argument.content || '';
                        ta.addEventListener('input', function() { argument.content = ta.value; });
                        argsWrap.appendChild(g);
                    });
                }
            },
            async fetchSelect() {
                const mcpServers = mcpStore.getServers();
                const getFun = mcpServers[this.promptSelect.title]?.prompts?.get;
                if (!getFun) return [];
                const params = { name: this.promptSelect.name };
                if (this.promptSelect.arguments) {
                    for (const argument of this.promptSelect.arguments) {
                        if (argument.name) {
                            if (!params['arguments']) params['arguments'] = {};
                            params['arguments'][argument.name] = argument.content;
                        }
                    }
                }
                const prompts = await getFun(params);
                const conversations = prompts.messages.map(item => {
                    const content = mcpStore.convertItem(item.content);
                    return {
                        role: item.role,
                        content: item.role == 'user' ? [content] : content.text
                    };
                });
                this.promptSheet = false;
                document.getElementById('promptSheetModal').classList.remove('open');
                return conversations;
            }
        };

        const resourceStore = {
            resourceDialog: false,
            tab: null,
            resourceList: [],
            resourceTemplatesList: [],
            loadingTemplates: false,
            loadingResources: false,
            loadTemplates(resource_function) {
                this.loadingTemplates = true;
                try {
                    resource_function().then((result) => {
                        this.resourceTemplatesList = result.resourceTemplates;
                        renderResourceTemplates();
                    });
                } catch (error) {
                    console.error('Failed to load resource templates:', error);
                } finally {
                    this.loadingTemplates = false;
                }
            },
            loadResources(resource_function) {
                this.loadingResources = true;
                try {
                    resource_function().then((result) => {
                        this.resourceList = result.resources;
                        renderResources();
                    });
                } catch (error) {
                    console.error('Failed to load resources:', error);
                } finally {
                    this.loadingResources = false;
                }
            }
        };

        const languageStore = {
            list: [
                { title: 'English', value: 'en', name: 'united-states' },
                { title: '简体中文', value: 'zhHans', name: 'china' }
            ],
            getLocale() { return this.locale; },
            change(lang) {
                this.locale = lang;
                applyI18n();
                renderConversation();
                updateSpeedDial();
            },
            getIcon(name) { return name; },
            getIcon2() {
                const item = this.list.find(lang => lang.value === this.locale);
                return item ? item.name : 'united-states';
            }
        };
        languageStore.locale = 'en';
        languageStore.getLocale = languageStore.getLocale.bind(languageStore);

        function t(key) {
            const path = key.replace('$vuetify.dataIterator.', '').split('.');
            let node = messages[languageStore.locale] || messages.en;
            for (const p of path) {
                if (node && typeof node === 'object' && p in node) node = node[p];
                else { node = undefined; break; }
            }
            if (node === undefined) {
                node = messages.en;
                for (const p of path) {
                    if (node && typeof node === 'object' && p in node) node = node[p];
                    else { node = key; break; }
                }
            }
            return typeof node === 'string' ? node : key;
        }

        function applyI18n() {
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                el.textContent = t('$vuetify.dataIterator.' + key);
            });
            document.getElementById('emptyStateTitle').textContent = t('$vuetify.dataIterator.title');
            document.title = t('$vuetify.dataIterator.title');
            renderMoreMenu();
        }

        function renderMoreMenu() {
            const menu = document.getElementById('moreMenu');
            menu.innerHTML = `
                <button class="more-item">🔄 ${t('$vuetify.dataIterator.g.reg')}</button>
                <button class="more-item">▶️ ${t('$vuetify.dataIterator.g.cont')}</button>
                <button class="more-item">📝 Prompts</button>
                <button class="more-item">🗜️ Compact (keep prefix cache)</button>
                <button class="more-item">✂️ Hard cut window（归档旧对话，开新窗口）</button>
                <button class="more-item">⚡ Refresh tools (1 cache miss)</button>
                <button class="more-item">🧭 工具轨迹回放 (Tool Trace)</button>
                <button class="more-item">🧹 Clear memory (清空全部记忆)</button>
            `;
            const actions = [
                () => { messageStore.resendMessage();
                    menu.classList.remove('open'); },
                () => { messageStore.continueRun();
                    menu.classList.remove('open'); },
                () => { openPromptDialog();
                    menu.classList.remove('open'); },
                () => { messageStore.compactContext();
                    menu.classList.remove('open'); },
                () => { messageStore.hardCutContext({ reason: 'manual: More 菜单' });
                    menu.classList.remove('open'); },
                () => {
                    prefixManager.invalidateTools();
                    snackbarStore.showInfoMessage('工具列表已刷新（下一轮前缀缓存 miss 一次）');
                    menu.classList.remove('open');
                },
                () => { openTraceDialog();
                    menu.classList.remove('open'); },
                () => { clearAllMemory(menu); }
            ];
            menu.querySelectorAll('.more-item').forEach((item, i) => {
                item.addEventListener('click', actions[i]);
            });
        }

        // ── More 菜单：一键清空本地记忆（IndexedDB：记忆条目 + 会话索引 + 用户画像）──
        async function clearAllMemory(menu) {
            if (menu) menu.classList.remove('open');
            // 记忆功能未启用：不触碰 IndexedDB，直接提示（默认关闭时保持零副作用）
            if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.isEnabled === 'function'
                && !window.AgentMemoryBridge.isEnabled()) {
                snackbarStore.showInfoMessage('本地记忆未启用（可在「⚙️ 配置 → Advanced」勾选开启）');
                return;
            }
            // 等记忆引擎初始化（含 IDB 超时降级）完成后再操作
            if (window.agentMemoryReady && typeof window.agentMemoryReady.then === 'function') {
                try { await window.agentMemoryReady; } catch (_) {}
            }
            const eng = (window.AgentMemoryBridge && window.AgentMemoryBridge.engine) || window.agentMemory;
            if (!eng || typeof eng.clear !== 'function') {
                snackbarStore.showInfoMessage('记忆层未就绪，无法清空');
                return;
            }
            let total = 0, profileCount = 0, byKind = {};
            try { const s = eng.stats() || {}; total = s.total || 0; byKind = s.byKind || {}; } catch (_) {}
            try { profileCount = ((await eng.getProfile()) || []).length; } catch (_) {}
            if (!total && !profileCount) {
                snackbarStore.showInfoMessage('本地记忆已为空，无需清空');
                return;
            }
            const kindLine = Object.keys(byKind)
                .sort()
                .map(k => '  · ' + k + '：' + byKind[k] + ' 条')
                .join('\n');
            const ok = window.confirm(
                '⚠️ 确定清空全部本地记忆吗？此操作不可撤销。\n\n' +
                '记忆条目：' + total + ' 条' + (kindLine ? '\n' + kindLine : '') + '\n' +
                '用户画像：' + profileCount + ' 条\n' +
                '将物理删除本地 IndexedDB 数据库 agent-memory（不是只清空表）。\n' +
                '（含自动索引的会话片段；当前对话消息不受影响）'
            );
            if (!ok) return;
            try {
                await eng.clear();
                snackbarStore.showInfoMessage('已清空本地记忆库：' + total + ' 条条目' +
                    (profileCount ? ' + ' + profileCount + ' 条画像' : ''));
            } catch (e) {
                console.error('[memory] 清空记忆失败：', e);
                snackbarStore.showErrorMessage('清空记忆失败：' + (e && e.message ? e.message : e));
            }
        }

        // ── 运行计时器（对话 + agent 全程运行时间；参照 chat-ui v1.0.5）──
        let runTimerId = null;
        let runStartTs = 0;
        function updateTimerDisplay() {
            const wrap = document.getElementById('runTimer');
            const fill = document.querySelector('.fill-area');
            if (messageStore.runState === 'idle') {
                wrap.style.display = 'none';
                if (fill) fill.style.height = '20px';
                return;
            }
            wrap.style.display = 'block';
            if (fill) fill.style.height = '48px';
            const span = document.getElementById('runTimerText');
            span.classList.toggle('done', messageStore.runState === 'done');
            span.textContent = (messageStore.runState === 'running' ? 'running ' : 'end ') + messageStore.elapsed + ' 秒';
        }

