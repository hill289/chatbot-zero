        // ══════════════════════════════════════════════════════════
        // 输入区 UI
        // ══════════════════════════════════════════════════════════
        function updateInputIcon() {
            const icon = document.getElementById('inputIcon');
            icon.innerHTML = '';
            const hasText = messageStore.userMessage.trim().length > 0;
            const hasImages = (messageStore.pendingImages || []).length > 0;

            if (messageStore.generating) {
                icon.insertAdjacentHTML('beforeend', '<button class="act-btn" id="stopBtn" title="Stop">⏹️</button>');
                icon.querySelector('#stopBtn').addEventListener('click', () => messageStore.stop());
            } else if (hasText || hasImages) {
                icon.insertAdjacentHTML('beforeend', '<button class="act-btn" id="sendBtn" title="Send">▲</button>');
                icon.querySelector('#sendBtn').addEventListener('click', () => messageStore.sendMessage());
            } else {
                // 右侧统一为 More(⋯)：空会话与有会话同款，不再单独放 prompts 👤
                icon.insertAdjacentHTML('beforeend', '<button class="act-btn" id="moreBtn" title="More">⋯</button>');
                icon.querySelector('#moreBtn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.getElementById('moreMenu').classList.toggle('open');
                });
            }
        }

        // ══════════════════════════════════════════════════════════
        // 多模态图片输入：附件选择 / 粘贴 / 拖放 / 预览
        //   图片以 data URL 保存（对齐 DeepSeek image_url 格式：
        //   {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}）
        // ══════════════════════════════════════════════════════════
        function addChatImageFile(file) {
            if (!file || !file.type || !file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = function (e) {
                if (typeof e.target.result !== 'string') return;
                const url = e.target.result;
                // 入队前先让浏览器真正解一遍：损坏的 PNG/JPEG（如 chunk 长度为 0）会走 onerror。
                // 否则坏图会一路被送进请求体 → 接口 400 unsupported image → 历史被污染。
                const probe = new Image();
                probe.onload = function () {
                    messageStore.pendingImages = messageStore.pendingImages || [];
                    messageStore.pendingImages.push(url);
                    renderAttachBar();
                    updateInputIcon();
                };
                probe.onerror = function () {
                    const name = file.name || 'image';
                    try {
                        snackbarStore.showWarningMessage(
                            `「${name}」不是可解析的图片（文件可能已损坏），已忽略。` +
                            `请重新导出为 PNG/JPEG/WebP/GIF 后再上传——坏图会让接口返回 400 unsupported image。`);
                    } catch (_) {}
                };
                probe.src = url;
            };
            reader.readAsDataURL(file);
        }

        function renderAttachBar() {
            const bar = document.getElementById('attachBar');
            if (!bar) return;
            const imgs = messageStore.pendingImages || [];
            bar.innerHTML = '';
            if (imgs.length === 0) {
                bar.style.display = 'none';
            } else {
                bar.style.display = '';
                imgs.forEach((url, idx) => {
                    const chip = elFromHTML('<div class="attach-chip"></div>');
                    const img = document.createElement('img');
                    img.src = url;
                    img.alt = 'attachment';
                    chip.appendChild(img);
                    const del = elFromHTML('<button class="attach-del" title="Remove">✕</button>');
                    del.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        messageStore.pendingImages.splice(idx, 1);
                        renderAttachBar();
                        updateInputIcon();
                    });
                    chip.appendChild(del);
                    bar.appendChild(chip);
                });
            }
            const btn = document.getElementById('attachImageBtn');
            if (btn) btn.classList.toggle('has-files', imgs.length > 0);
        }

        // 从剪贴板粘贴图片（若同时含文本，文本仍走默认粘贴行为）
        function handleChatPaste(e) {
            const dt = e.clipboardData;
            if (!dt || !dt.items) return;
            const imgFiles = [];
            let hasText = false;
            for (const it of dt.items) {
                if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                    const f = it.getAsFile ? it.getAsFile() : null;
                    if (f) imgFiles.push(f);
                } else if (it.kind === 'string') {
                    hasText = true;
                }
            }
            if (imgFiles.length === 0) return;
            if (!hasText) e.preventDefault();
            imgFiles.forEach(addChatImageFile);
        }

        // 拖拽图片文件到输入区
        function handleChatDrop(e) {
            const dt = e.dataTransfer;
            if (!dt || !dt.files || dt.files.length === 0) return;
            const imgFiles = Array.from(dt.files).filter(f => f.type && f.type.startsWith('image/'));
            if (imgFiles.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            imgFiles.forEach(addChatImageFile);
        }

        function updateSpeedDial() {
            const dial = document.getElementById('speedDial');
            const hasWindows = subagentStore.windows.length > 0;
            dial.innerHTML = '';
            const items = [
                { icon: '🔑', title: t('$vuetify.dataIterator.i.title'), action: () => { settingStore
                        .initDialog(); } },
                { icon: '🌐', title: t('$vuetify.dataIterator.l.title'), action: () => { toggleLangMenu(); } },
                { icon: '🧠', title: t('$vuetify.dataIterator.a.title'), action: () => { openAgentDialog(); } },
                { icon: '🗄️', title: t('$vuetify.dataIterator.r.title'), action: () => { openResourceDialog(); } },
                { icon: '📜', title: t('$vuetify.dataIterator.q.title'), badge: historyStore.conversation.length,
                    action: () => { openHistoryDialog(); } },
                { icon: '🤖', title: 'Subagent Chat', action: () => { subagentStore.openWindow(); } },
                { icon: '🧭', title: 'Tool Trace Replay / 工具轨迹回放', action: () => { openTraceDialog(); } },
                // 注：⇄ 对比已独立成常驻按钮（#sdDiffBtn，位于 ⚙️ 正上方），不再属于本弹出菜单
            ];
            if (hasWindows) {
                const hiddenCount = subagentStore.windows.filter(w => w.hidden).length;
                const visibleCount = subagentStore.windows.length - hiddenCount;
                if (hiddenCount > 0) {
                    items.push({
                        icon: '👁️',
                        title: `Show hidden subagent windows (${hiddenCount})`,
                        badge: hiddenCount,
                        action: () => subagentStore.showHiddenWindows()
                    });
                }
                if (visibleCount > 0) {
                    items.push({
                        icon: '🙈',
                        title: `Hide all subagent windows (${visibleCount})`,
                        badge: visibleCount,
                        action: () => subagentStore.hideAllWindows()
                    });
                }
            }
            // ✏️「新建对话 / New Conversation」已移到输入框右侧、More(⋯) 按钮正上方（#inputNewChatBtn）；
            //    左侧 ⇄ 对比按钮右侧的常驻位改为 📦「导出全部工作区文件」（#sdExportAllBtn）。

            items.forEach(item => {
                const idAttr = item.id ? ` id="${item.id}"` : '';
                let badgeHtml = '';
                if (item.badge !== undefined) {
                    const bId = item.badgeId ? ` id="${item.badgeId}"` : '';
                    const hide = (item.hideZeroBadge && !(item.badge > 0)) ? ' style="display:none"' : '';
                    badgeHtml = `<span class="sd-badge"${bId}${hide}>${Math.min(item.badge, 99)}</span>`;
                }
                const btn = elFromHTML(
                    `<button class="sd-btn"${idAttr} title="${escapeHtml(item.title)}">${item.icon}${badgeHtml}</button>`
                    );
                if (item.disabled) {
                    btn.disabled = true;
                    btn.classList.add('sd-btn-disabled');
                }
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dial.classList.remove('open');
                    item.action();
                });
                dial.appendChild(btn);
            });

            // ⇄ 对比独立按钮（#sdDiffBtn，在 ⚙️ 正上方）：状态/角标由统一函数刷新
            try {
                if (typeof pgpyUpdateDiffButton === 'function') pgpyUpdateDiffButton();
            } catch (_) {}

            // 📦 导出全部工作区文件（#sdExportAllBtn，位于 ⇄ 对比右侧，原「新建对话」位置）
            try {
                const expBtn = document.getElementById('sdExportAllBtn');
                if (expBtn) {
                    expBtn.title = '导出全部工作区文件 / Export all workspace files (ZIP)';
                    expBtn.onclick = (e) => {
                        e.stopPropagation();
                        dial.classList.remove('open');
                        try { exportAllWorkspace(); } catch (err) {
                            console.error('导出全部工作区文件失败:', err);
                            try { snackbarStore.showErrorMessage('导出失败：' + (err && err.message ? err.message : err)); } catch (_) {}
                        }
                    };
                }
            } catch (_) {}

            // ✏️ 新建对话（#inputNewChatBtn，位于输入框右侧、More(⋯) 按钮正上方）：标题随语言切换
            try {
                const newBtn = document.getElementById('inputNewChatBtn');
                if (newBtn) {
                    newBtn.title = t('$vuetify.dataIterator.g.new');
                    newBtn.onclick = (e) => {
                        e.stopPropagation();
                        try { messageStore.init(); } catch (_) {}
                    };
                }
            } catch (_) {}

            const menu = document.getElementById('langMenu');
            menu.innerHTML = '';
            languageStore.list.forEach(lang => {
                const item = elFromHTML(
                    `<button class="lang-item ${lang.value === languageStore.locale ? 'active' : ''}">${flagEmoji(lang.name)} ${lang.title}</button>`
                    );
                item.addEventListener('click', () => {
                    languageStore.change(lang.value);
                    menu.classList.remove('open');
                });
                menu.appendChild(item);
            });
        }

        function flagEmoji(name) {
            const map = {
                'united-states': '🇺🇸',
                'italy': '🇮🇹',
                'japan': '🇯🇵',
                'sweden': '🇸🇪',
                'china': '🇨🇳'
            };
            return map[name] || '🌐';
        }

        function toggleLangMenu() {
            document.getElementById('langMenu').classList.toggle('open');
        }

        // ══════════════════════════════════════════════════════════
        // 对话框
        // ══════════════════════════════════════════════════════════
        function openHistoryDialog() {
            settingStore.configHistory = true;
            document.getElementById('historyModal').classList.add('open');
            renderHistory();
        }

        function renderHistory() {
            const list = document.getElementById('historyList');
            list.innerHTML = '';
            if (historyStore.conversation.length === 0) {
                list.innerHTML = '<p style="text-align:center;color:#999;padding:30px;">No history yet</p>';
                return;
            }
            historyStore.conversation.forEach((item, idx) => {
                const first = item.history[0]?.content;
                const firstText = Array.isArray(first) ? (first[1]?.text || first[0]?.text || '') : (first || '');
                const last = item.history[item.history.length - 1]?.content;
                const lastText = Array.isArray(last) ? (last[1]?.text || last[0]?.text || '') : (last || '');
                const itemEl = elFromHTML(`
                    <div class="history-item">
                        <button class="history-count" style="background:${historyStore.getColor(idx)};">${item.history.length}</button>
                        <div class="history-info">
                            <div class="hi-line">${escapeHtml(String(firstText).substring(0, 120) || 'NA')}</div>
                            <div class="hi-line2">${escapeHtml(String(lastText).substring(0, 120) || 'NA')}</div>
                        </div>
                        <div class="hi-actions">
                            <button class="mh-btn" title="Fork（从此会话分叉出新会话）">🍴</button>
                            <button class="mh-btn" title="Download">⬇️</button>
                            <button class="mh-btn danger" title="Delete">🗑️</button>
                        </div>
                    </div>
                `);
                itemEl.querySelector('.history-count').addEventListener('click', () => historyStore.select(idx));
                const hiBtns = itemEl.querySelectorAll('.hi-actions .mh-btn');
                hiBtns[0].addEventListener('click', async () => {
                    if (typeof sessionLog === 'undefined' || !sessionLog || typeof sessionLog.forkEntry !== 'function') {
                        snackbarStore.showWarningMessage('Fork 需要 Electron 外壳的会话日志支持');
                        return;
                    }
                    const r = await sessionLog.forkEntry(idx);
                    if (!r || r.ok === false) snackbarStore.showErrorMessage('Fork 失败：' + ((r && r.error) || '未知错误'));
                    else { snackbarStore.showSuccessMessage('已分叉出新会话'); renderHistory(); }
                });
                hiBtns[1].addEventListener('click', () => historyStore.downloadById(idx));
                hiBtns[2].addEventListener('click', () => { historyStore.deleteById(idx);
                    renderHistory(); });
                list.appendChild(itemEl);
            });
        }

        function loadConfigDialog() {
            const byId = id => document.getElementById(id);
            byId('apiKeyInput').value = chatbotStore.apiKey;
            byId('apiUrlInput').value = chatbotStore.url;
            byId('apiPathInput').value = chatbotStore.path;
            byId('modelInput').value = chatbotStore.model;
            byId('methodInput').value = chatbotStore.method;
            byId('contentTypeInput').value = chatbotStore.contentType;
            byId('streamCheckbox').checked = chatbotStore.stream;
            byId('mcpCheckbox').checked = chatbotStore.mcp;
            byId('disableReadUrlCheckbox').checked = isToolDisabled('read_url');
            byId('multimodalEnabledCheckbox').checked = chatbotStore.multimodalEnabled !== false;
            const lg = chatbotStore.loopGuard || {};
            byId('loopGuardMaxSteps').value = lg.maxSteps != null ? lg.maxSteps : 30;
            byId('loopGuardSoftRepeat').value = lg.softRepeat != null ? lg.softRepeat : 3;
            byId('loopGuardHardRepeat').value = lg.hardRepeat != null ? lg.hardRepeat : 5;
            byId('loopGuardMaxErrorRepeat').value = lg.maxErrorRepeat != null ? lg.maxErrorRepeat : 3;
            // 工具审批（写 / 改 / 删 / 执行）
            const ap = chatbotStore.approval || {};
            byId('approvalEnabledCheckbox').checked = ap.enabled !== false;
            byId('approvalToolsInput').value = Array.isArray(ap.tools) ? ap.tools.join(', ') : '';
            byId('approvalTimeoutInput').value = ap.timeoutSec != null ? ap.timeoutSec : 300;
            // 上下文窗口 / 硬切
            const cw = Number(chatbotStore.contextWindowTokens);
            byId('contextWindowTokensInput').value = (isFinite(cw) && cw > 0) ? cw : 1048576;
            const hr = Number(chatbotStore.hardCutRatio);
            byId('hardCutRatioInput').value = (isFinite(hr) && hr > 0) ? hr : 0.85;
            byId('hardCutEnabledCheckbox').checked = chatbotStore.hardCutEnabled !== false;
            // 本地记忆（默认不启用）
            const mem = chatbotStore.memory || {};
            byId('memoryEnabledCheckbox').checked = mem.enabled === true;
            byId('memoryRecallLimitInput').value = mem.recallLimit != null ? mem.recallLimit : 6;
            const revokeBtn = byId('approvalRevokeBtn');
            if (revokeBtn) revokeBtn.onclick = function () {
                if (window.approvalStore && typeof window.approvalStore.revokeAll === 'function') {
                    window.approvalStore.revokeAll();
                }
                renderApprovalGrantsHint();
                snackbarStore.showInfoMessage('已撤销本会话全部工具授权');
            };
            renderApprovalGrantsHint();
            renderMcpUrlRows(chatbotStore.mcpUrls || []);
            renderSshHostRows(chatbotStore.sshHosts || []);

            byId('cacheCheckbox').checked = chatbotStore.cacheMode !== false;
            byId('maxTokensTypeInput').value = chatbotStore.max_tokens_type;
            byId('maxTokensValueInput').value = chatbotStore.max_tokens_value;
            byId('temperatureInput').value = chatbotStore.temperature;
            byId('topPInput').value = chatbotStore.top_p;
            byId('authPrefixInput').value = chatbotStore.authPrefix;
            byId('apiKeyInput').type = settingStore.apiKeyShow ? 'text' : 'password';
            // 把配置文件绝对路径显示在「🔁 从文件刷新」按钮的悬浮提示里，方便手工编辑
            const reloadBtn = byId('configReloadBtn');
            if (reloadBtn && window.configFileAPI && typeof window.configFileAPI.path === 'function') {
                let p = '';
                try { p = window.configFileAPI.path() || ''; } catch (_) { p = ''; }
                if (p) reloadBtn.title = '配置文件：' + p + '\n修改该文件后点此从文件刷新（无需重启）';
            }

            byId('urlList').innerHTML = defaultChoiceStore.url.map(v => `<option value="${escapeHtml(v)}">`).join('');
            byId('pathList').innerHTML = defaultChoiceStore.path.map(v => `<option value="${escapeHtml(v)}">`).join('');
            byId('modelList').innerHTML = defaultChoiceStore.model.map(v => `<option value="${escapeHtml(v)}">`).join('');
            byId('maxTokensTypeList').innerHTML = defaultChoiceStore.max_tokens_type.map(v =>
                `<option value="${escapeHtml(v)}">`).join('');

            updateConfigChips();
            updateCacheStats();
        }

        // 审批授权提示：本会话已授权的工具 / 命令作用域（配置面板里显示，可一键撤销）
        function renderApprovalGrantsHint() {
            const el = document.getElementById('approvalGrantsHint');
            if (!el) return;
            const grants = (window.approvalStore && typeof window.approvalStore.listGrants === 'function')
                ? window.approvalStore.listGrants() : [];
            el.textContent = grants.length
                ? '本会话已授权：' + grants.map(g => g.scope).join('、')
                : '本会话尚无授权（每次调用都会询问）';
        }

        function updateConfigChips() {
            document.getElementById('endpointChip').textContent = (chatbotStore.url || '') + (chatbotStore.path || '');
            document.getElementById('modelChip').textContent = chatbotStore.model || 'No model';
            const chips = [
                chatbotStore.method,
                chatbotStore.stream ? 'Stream' : 'Stream: off',
                chatbotStore.mcp ? 'MCP' : 'MCP: off',
                (chatbotStore.cacheMode !== false ? 'Cache: on' : 'Cache: off'),
                (chatbotStore.max_tokens_type || '') + ': ' + (chatbotStore.max_tokens_value || 'default'),
                'temperature: ' + (chatbotStore.temperature || 'default'),
                'top_p: ' + (chatbotStore.top_p || 'default'),
                chatbotStore.authPrefix,
                chatbotStore.contentType
            ];
            if (Array.isArray(chatbotStore.mcpUrls) && chatbotStore.mcpUrls.length) {
                chips.push('MCP ×' + chatbotStore.mcpUrls.length);
            }
            const g = chatbotStore.loopGuard || {};
            chips.push('🛡️ ' + (g.maxSteps || 30) + '/' + (g.softRepeat || 3) + '/' + (g.hardRepeat || 5) + '/' + (g.maxErrorRepeat || 3));
            if (Array.isArray(chatbotStore.disabledTools) && chatbotStore.disabledTools.length) {
                chips.push('🚫 ' + chatbotStore.disabledTools.join(', '));
            }
            const ap = chatbotStore.approval || {};
            chips.push(ap.enabled === false
                ? '🛡️ 审批: off'
                : ('🛡️ 审批: ' + (Array.isArray(ap.tools) ? ap.tools.length : 0) + ' 项'));
            const cw = Number(chatbotStore.contextWindowTokens) || 1048576;
            chips.push('🧠 ' + Math.round(cw / 1024) + 'K');
            const mem = chatbotStore.memory || {};
            chips.push('🗂️ 记忆: ' + (mem.enabled === true ? 'on' : 'off'));
            chips.push('🖼️ 多模态: ' + (chatbotStore.multimodalEnabled !== false ? 'on' : 'off'));
            document.getElementById('advChips').innerHTML = chips.map(c => `<span class="chip">${escapeHtml(c)}</span>`).join('');
        }

        // 「🔁 从文件刷新」：修改应用目录 config/interface.json 后，不重启页面即可回读生效。
        //   与「页面保存」是同一份 store：页面保存→写文件；改文件→点此回读→覆盖内存→回写规范化。
        async function reloadConfigFromFile() {
            if (!window.configFileAPI || typeof window.configFileAPI.read !== 'function'
                || !window.ConfigFile || typeof window.ConfigFile.applyFileConfig !== 'function') {
                snackbarStore.showWarningMessage('配置文件功能不可用（需在 Electron 外壳内运行）');
                return;
            }
            try {
                const res = await window.configFileAPI.read();
                if (!res || !res.ok) {
                    snackbarStore.showErrorMessage('读取配置文件失败：' + ((res && res.error) || '未知错误'));
                    return;
                }
                if (!res.exists || !res.config) {
                    snackbarStore.showInfoMessage('配置文件尚未生成：请先在页面保存一次配置。');
                    return;
                }
                // 侧效对照快照（MCP 重连 / SSH 重连 / 工具列表失效判定）
                const prevMcpUrls = Array.isArray(chatbotStore.mcpUrls) ? chatbotStore.mcpUrls.slice() : [];
                const prevSshHosts = Array.isArray(chatbotStore.sshHosts) ? JSON.parse(JSON.stringify(chatbotStore.sshHosts)) : [];
                const wasReadUrlDisabled = isToolDisabled('read_url');

                window.ConfigFile.applyFileConfig(chatbotStore, res.config);

                // 记忆层立即生效（与「导入配置」一致）
                try {
                    if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.config === 'function' && chatbotStore.memory) {
                        window.AgentMemoryBridge.config({
                            enabled: chatbotStore.memory.enabled === true,
                            autoRecall: chatbotStore.memory.autoRecall !== false,
                            autoIndexTurns: chatbotStore.memory.autoIndexTurns !== false,
                            recallLimit: chatbotStore.memory.recallLimit
                        });
                    }
                } catch (_) {}
                saveChatbot();       // 回写 localStorage + 规范化配置文件
                loadConfigDialog();  // 刷新对话框控件与 chips
                try { updateConvCost(); } catch (_) {}
                if (JSON.stringify(chatbotStore.mcpUrls || []) !== JSON.stringify(prevMcpUrls)) {
                    try { externalMcpManager.connectAll(chatbotStore.mcpUrls || []); } catch (_) {}
                }
                if (JSON.stringify(chatbotStore.sshHosts || []) !== JSON.stringify(prevSshHosts)) {
                    try { if (typeof sshReconcileConnections === 'function') sshReconcileConnections(prevSshHosts, chatbotStore.sshHosts || []); } catch (_) {}
                }
                if (wasReadUrlDisabled !== isToolDisabled('read_url')) {
                    try { prefixManager.invalidateTools(); } catch (_) {}
                }
                snackbarStore.showSuccessMessage('已从配置文件重新加载');
            } catch (e) {
                snackbarStore.showErrorMessage('读取配置文件失败：' + ((e && e.message) || e));
            }
        }

        function saveConfigDialog() {
            const byId = id => document.getElementById(id);
            chatbotStore.apiKey = byId('apiKeyInput').value;
            chatbotStore.url = byId('apiUrlInput').value;
            chatbotStore.path = byId('apiPathInput').value;
            chatbotStore.model = byId('modelInput').value;
            chatbotStore.method = byId('methodInput').value;
            chatbotStore.contentType = byId('contentTypeInput').value;
            chatbotStore.stream = byId('streamCheckbox').checked;
            chatbotStore.mcp = byId('mcpCheckbox').checked;
            chatbotStore.cacheMode = byId('cacheCheckbox').checked;
            // 工具禁用：勾选 = 禁用 read_url（写回 chatbotStore.disabledTools，并立即持久化）
            const wasReadUrlDisabled = isToolDisabled('read_url');
            setToolDisabled('read_url', byId('disableReadUrlCheckbox').checked);
            // 多模态图片回传开关：写回 chatbotStore（saveChatbot 会持久化到 localStorage）
            chatbotStore.multimodalEnabled = byId('multimodalEnabledCheckbox').checked;
            const prevMcpUrls = Array.isArray(chatbotStore.mcpUrls) ? chatbotStore.mcpUrls.slice() : [];
            const nextMcpUrls = collectMcpUrls();
            chatbotStore.mcpUrls = nextMcpUrls;
            // SSH 主机列表：收集行数据（密码随后由 saveChatbot → stripSecretsForSave 加密入库）
            const prevSshHosts = Array.isArray(chatbotStore.sshHosts)
                ? JSON.parse(JSON.stringify(chatbotStore.sshHosts)) : [];
            const nextSshHosts = collectSshHosts();
            chatbotStore.sshHosts = nextSshHosts;
            chatbotStore.max_tokens_type = byId('maxTokensTypeInput').value;
            chatbotStore.max_tokens_value = byId('maxTokensValueInput').value;
            chatbotStore.temperature = byId('temperatureInput').value;
            chatbotStore.top_p = byId('topPInput').value;
            chatbotStore.authPrefix = byId('authPrefixInput').value;
            // 执行护栏阈值：解析为整数（非法/空 → 回退默认），并保证「提醒」早于「中止」
            const gInt = (id, dflt) => { const v = parseInt(byId(id).value, 10); return (isFinite(v) && v >= 1) ? v : dflt; };
            chatbotStore.loopGuard = {
                maxSteps: gInt('loopGuardMaxSteps', 30),
                softRepeat: gInt('loopGuardSoftRepeat', 3),
                hardRepeat: gInt('loopGuardHardRepeat', 5),
                maxErrorRepeat: gInt('loopGuardMaxErrorRepeat', 3)
            };
            if (chatbotStore.loopGuard.softRepeat >= chatbotStore.loopGuard.hardRepeat) {
                chatbotStore.loopGuard.softRepeat = Math.max(1, chatbotStore.loopGuard.hardRepeat - 1);
            }
            // 工具审批：开关 / 白名单（逗号或空白分隔）/ 超时秒数（0 = 不超时）
            const apTools = String(byId('approvalToolsInput').value || '')
                .split(/[,，;；\s]+/)
                .map(s => s.trim())
                .filter(Boolean);
            chatbotStore.approval = {
                enabled: byId('approvalEnabledCheckbox').checked,
                tools: apTools.length
                    ? Array.from(new Set(apTools))
                    : ((chatbotStore.approval && Array.isArray(chatbotStore.approval.tools)) ? chatbotStore.approval.tools : []),
                timeoutSec: Math.max(0, parseInt(byId('approvalTimeoutInput').value, 10) || 0)
            };
            // 上下文窗口 / 硬切：窗口必须是正整数，比例收敛到 [0.3, 0.98]
            const cwValue = parseInt(byId('contextWindowTokensInput').value, 10);
            chatbotStore.contextWindowTokens = (isFinite(cwValue) && cwValue > 0) ? cwValue : 1048576;
            const hrValue = parseFloat(byId('hardCutRatioInput').value);
            chatbotStore.hardCutRatio = (isFinite(hrValue) && hrValue > 0)
                ? Math.min(0.98, Math.max(0.3, hrValue)) : 0.85;
            chatbotStore.hardCutEnabled = byId('hardCutEnabledCheckbox').checked;
            // 本地记忆（Local Memory）：开关 + 召回条数；保存后立即生效（注册 / 注销 memory_* 工具）
            const prevMemEnabled = !!(chatbotStore.memory && chatbotStore.memory.enabled);
            const memLimit = parseInt(byId('memoryRecallLimitInput').value, 10);
            chatbotStore.memory = {
                enabled: byId('memoryEnabledCheckbox').checked,
                autoRecall: !(chatbotStore.memory && chatbotStore.memory.autoRecall === false),
                autoIndexTurns: !(chatbotStore.memory && chatbotStore.memory.autoIndexTurns === false),
                recallLimit: (isFinite(memLimit) && memLimit >= 1) ? memLimit : 6
            };
            if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.config === 'function') {
                try {
                    window.AgentMemoryBridge.config({
                        enabled: chatbotStore.memory.enabled,
                        autoRecall: chatbotStore.memory.autoRecall,
                        autoIndexTurns: chatbotStore.memory.autoIndexTurns,
                        recallLimit: chatbotStore.memory.recallLimit
                    });
                } catch (_) { /* 记忆层故障不影响配置保存 */ }
            }
            if (prevMemEnabled !== chatbotStore.memory.enabled) {
                try { mcpStore.loadTools(); } catch (_) { /* 尚未初始化 */ }
            }
            // 用户已在此显式配置，标记迁移完成，避免旧默认值迁移再次覆盖
            chatbotStore.ctxWindowMigrated1M = true;
            renderApprovalGrantsHint();
            saveChatbot();
            settingStore.configDialog = false;
            byId('configModal').classList.remove('open');
            snackbarStore.showSuccessMessage('Settings saved');
            // API Key 已不再写 localStorage：系统不支持安全存储时必须明确告知用户
            if (chatbotStore.apiKey && chatbotStore.apiKey !== 'sk-xxx' && !secretStore.available()) {
                snackbarStore.showErrorMessage('当前系统不支持安全存储（safeStorage），API Key 只保留在本次会话内存中，关闭应用后需重新填写。');
            }
            updateConfigChips();
            updateCacheStats();
            // 上下文窗口可能刚改过 → 立即刷新「已用上下文 %」的分母
            try { updateConvCost(); } catch (_) {}
            // URL 列表变更时重连外部 MCP Servers（清空则全部断开）
            if (JSON.stringify(nextMcpUrls) !== JSON.stringify(prevMcpUrls)) {
                externalMcpManager.connectAll(nextMcpUrls);
            }
            // SSH 主机变更：删除/修改的主机断开（未动的保持连接）
            if (JSON.stringify(nextSshHosts) !== JSON.stringify(prevSshHosts)) {
                if (typeof sshReconcileConnections === 'function') {
                    sshReconcileConnections(prevSshHosts, nextSshHosts);
                }
            }
            // 工具禁用项有变化 → 工具列表缓存失效，下一轮按新配置下发（一次前缀 cache miss）
            if (wasReadUrlDisabled !== isToolDisabled('read_url')) {
                prefixManager.invalidateTools();
            }
        }

        // ─── Agent 看板 ───
        function renderAgentBoard() {
            const board = document.getElementById('agentBoard');
            board.innerHTML = '';
            agentStore.columns.forEach((column, colIndex) => {
                const col = elFromHTML(`<div class="board-column" data-col="${colIndex}"></div>`);
                const header = elFromHTML(`
                    <div class="bc-header">
                        <span>${escapeHtml(column.key)}</span>
                        <button class="bc-add" title="Add">＋</button>
                    </div>
                `);
                header.querySelector('.bc-add').addEventListener('click', () => {
                    column.isAddVisible = !column.isAddVisible;
                    renderAgentBoard();
                });
                col.appendChild(header);

                if (column.isAddVisible) {
                    const form = elFromHTML(`
                        <div class="add-card-form">
                            <input type="text" placeholder="Title" class="acf-input">
                            <div class="acf-actions">
                                <button class="m-btn outline acf-cancel" style="padding:4px 10px;font-size:12px;">Cancel</button>
                                <button class="m-btn primary acf-add" style="padding:4px 10px;font-size:12px;">Add</button>
                            </div>
                        </div>
                    `);
                    const input = form.querySelector('.acf-input');
                    input.addEventListener('keyup', function(e) {
                        column.addTitle = input.value;
                        if (e.key === 'Enter') { agentStore.addCard(column); }
                    });
                    form.querySelector('.acf-cancel').addEventListener('click', () => { column.isAddVisible = false;
                        renderAgentBoard(); });
                    form.querySelector('.acf-add').addEventListener('click', () => { agentStore.addCard(column); });
                    col.appendChild(form);
                }

                column.cards.forEach((card, cardIdx) => {
                    const cardEl = elFromHTML(`
                        <div class="agent-card" draggable="true" data-cardid="${escapeHtml(card.id)}">
                            <div class="ac-title">${escapeHtml(card.title)}
                                <button class="ac-del" title="Delete">✕</button>
                            </div>
                            <div class="ac-desc">${escapeHtml(card.description || '')}</div>
                        </div>
                    `);
                    cardEl.querySelector('.ac-del').addEventListener('click', (e) => {
                        e.stopPropagation();
                        agentStore.deleteCard(column, cardIdx);
                    });
                    cardEl.addEventListener('click', () => agentStore.editCard(card));
                    cardEl.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', card.id);
                        cardEl.classList.add('dragging');
                    });
                    cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
                    col.appendChild(cardEl);
                });

                col.addEventListener('dragover', (e) => e.preventDefault());
                col.addEventListener('drop', (e) => {
                    e.preventDefault();
                    const cardId = e.dataTransfer.getData('text/plain');
                    const srcColumn = agentStore.columns.find(c => c.cards.some(card => card.id === cardId));
                    if (!srcColumn || srcColumn.key === column.key) return;
                    const idx = srcColumn.cards.findIndex(card => card.id === cardId);
                    const [card] = srcColumn.cards.splice(idx, 1);
                    card.state = column.key;
                    card.order = -1;
                    column.cards.unshift(card);
                    column.cards.forEach((c, i) => { c.order = i;
                        c.state = column.key; });
                    agentStore.persistSelf();
                    renderAgentBoard();
                });

                board.appendChild(col);
            });
            renderMcpTools();
        }

        function renderMcpTools() {
            const tbody = document.querySelector('#mcpToolsTable tbody');
            tbody.innerHTML = '';
            const tools = mcpStore.serverTools || [];
            if (tools.length === 0) {
                tbody.innerHTML = '<tr><td colspan="2" style="color:#999;">No tools loaded</td></tr>';
            } else {
                tools.forEach(tool => {
                    tbody.insertAdjacentHTML('beforeend',
                        `<tr><td style="font-weight:600;">${escapeHtml(tool.name)}</td><td>${escapeHtml(tool.description || '')}</td></tr>`
                        );
                });
            }
        }

        // ══════════════════════════════════════════════════════════
        // 可插拔工具注册表：管理面板（Tool Registry UI）
        //   列表渲染 / 表单注册 / 启停 / 删除 / 示例 / 导入导出。
        //   所有变更最终落到 toolRegistry（并触发前缀缓存失效 + 工具列表刷新）。
        // ══════════════════════════════════════════════════════════
        function renderToolRegistryPanel() {
            if (!toolRegistry) return;
            const tbody = document.getElementById('trTbody');
            if (!tbody) return;
            const tools = toolRegistry.list();
            const countEl = document.getElementById('trCount');
            if (countEl) countEl.textContent = '(' + tools.length + ')';
            tbody.innerHTML = '';
            if (tools.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="tr-empty">还没有注册任何工具。可用下方表单注册，或点右上角 🧪 载入示例。</td></tr>';
                return;
            }
            tools.forEach(tool => {
                const tagsHtml = (tool.tags && tool.tags.length)
                    ? '<div>' + tool.tags.map(x => '<span class="tr-tag">' + escapeHtml(x) + '</span>').join('') + '</div>' : '';
                const builtinHtml = tool.builtin ? '<span class="tr-tag" style="background:#fef3c7;color:#92400e;">builtin</span>' : '';
                const tr = elFromHTML(
                    '<tr>' +
                    '<td><input type="checkbox" class="tr-enabled" ' + (tool.enabled ? 'checked' : '') + ' title="是否下发给模型"></td>' +
                    '<td><span class="tr-name">' + escapeHtml(tool.name) + '</span>' + tagsHtml + '</td>' +
                    '<td><div class="tr-src">' + escapeHtml(tool.source || '') + ' · ' + escapeHtml(tool.kind || '') + '</div>' + builtinHtml + '</td>' +
                    '<td class="tr-desc">' + escapeHtml(tool.description || '') + '</td>' +
                    '<td><button class="tr-del" title="删除该工具">🗑</button></td>' +
                    '</tr>'
                );
                tr.querySelector('.tr-enabled').addEventListener('change', function () {
                    toolRegistry.setEnabled(tool.name, this.checked);
                    snackbarStore.showInfoMessage('工具 ' + tool.name + (this.checked ? ' 已启用' : ' 已停用'));
                });
                tr.querySelector('.tr-del').addEventListener('click', () => {
                    toolRegistry.unregister(tool.name);
                    snackbarStore.showInfoMessage('已删除工具 ' + tool.name);
                });
                tbody.appendChild(tr);
            });
        }

        function submitToolRegistryForm() {
            const errEl = document.getElementById('trErr');
            errEl.textContent = '';
            const name = (document.getElementById('trName').value || '').trim();
            const description = (document.getElementById('trDesc').value || '').trim();
            const kind = document.getElementById('trKind').value;
            let inputSchema;
            try {
                const raw = (document.getElementById('trSchema').value || '').trim();
                inputSchema = raw ? JSON.parse(raw) : { type: 'object', properties: {} };
            } catch (e) {
                errEl.textContent = '参数 Schema 不是合法 JSON：' + ((e && e.message) || e);
                return;
            }
            const def = { name, description, inputSchema, source: 'manual' };
            if (kind === 'code') {
                def.code = document.getElementById('trCode').value || '';
            } else {
                try {
                    def.http = JSON.parse((document.getElementById('trHttp').value || '').trim() || '{}');
                } catch (e) {
                    errEl.textContent = 'HTTP 规格不是合法 JSON：' + ((e && e.message) || e);
                    return;
                }
            }
            const override = !!(document.getElementById('trOverride') && document.getElementById('trOverride').checked);
            try {
                toolRegistry.register(def, { override });
                snackbarStore.showSuccessMessage('已注册工具 ' + def.name + '（下一轮前缀缓存 miss 一次）');
                document.getElementById('trName').value = '';
                document.getElementById('trDesc').value = '';
            } catch (e) {
                errEl.textContent = (e && e.message) || String(e);
            }
        }

        function loadExampleRegistryTools() {
            if (!toolRegistry) return;
            const examples = [
                {
                    name: 'example_get_time',
                    description: '返回当前时间的 ISO 8601 字符串（示例工具，纯本地执行）。',
                    inputSchema: { type: 'object', properties: {} },
                    code: 'return new Date().toISOString();',
                    tags: ['example'], source: 'example'
                },
                {
                    name: 'example_echo',
                    description: '回显传入的 message（示例：演示参数使用与结构化返回）。',
                    inputSchema: { type: 'object', properties: { message: { type: 'string', description: '要回显的文本' } }, required: ['message'] },
                    code: 'return { echoed: args.message == null ? "" : String(args.message), at: Date.now() };',
                    tags: ['example'], source: 'example'
                },
                {
                    name: 'example_http_get',
                    description: '对指定 URL 发起 GET 请求并返回响应体（示例：声明式 HTTP 工具，默认停用）。',
                    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '请求地址' } }, required: ['url'] },
                    http: { url: '{url}', method: 'GET' },
                    tags: ['example'], source: 'example', enabled: false
                }
            ];
            const r = toolRegistry.registerMany(examples, { source: 'example', override: true });
            snackbarStore.showSuccessMessage('已载入 ' + r.registered.length + ' 个示例工具' + (r.errors.length ? '（' + r.errors.length + ' 个失败）' : ''));
        }

        function initToolRegistryUI() {
            if (!toolRegistry) return;
            const openBtn = document.getElementById('toolRegistryBtn');
            const modal = document.getElementById('toolRegistryModal');
            if (!openBtn || !modal) return;

            openBtn.addEventListener('click', () => {
                modal.classList.add('open');
                document.getElementById('toolbox').style.display = 'none';
                document.getElementById('toolboxButton').style.display = '';
                renderToolRegistryPanel();
            });

            const kindSel = document.getElementById('trKind');
            kindSel.addEventListener('change', () => {
                const isCode = kindSel.value === 'code';
                document.getElementById('trCodeWrap').style.display = isCode ? '' : 'none';
                document.getElementById('trHttpWrap').style.display = isCode ? 'none' : '';
            });

            document.getElementById('trSubmit').addEventListener('click', submitToolRegistryForm);
            document.getElementById('trClearForm').addEventListener('click', () => {
                document.getElementById('trErr').textContent = '';
                ['trName', 'trDesc', 'trCode', 'trHttp'].forEach(id => { document.getElementById(id).value = ''; });
                document.getElementById('trSchema').value = '{"type":"object","properties":{},"required":[]}';
            });
            document.getElementById('trRefresh').addEventListener('click', async () => {
                prefixManager.invalidateTools();
                if (typeof externalMcpManager !== 'undefined' && externalMcpManager.connectedCount > 0) {
                    try { await externalMcpManager.refreshAll(); } catch (e) {
                        snackbarStore.showErrorMessage('刷新外部 MCP 工具失败：' + ((e && e.message) ? e.message : e));
                    }
                }
                renderToolRegistryPanel();
                snackbarStore.showInfoMessage('工具列表已刷新（下一轮前缀缓存 miss 一次）');
            });
            document.getElementById('trClearAll').addEventListener('click', () => {
                const n = toolRegistry.list().length;
                if (n === 0) return;
                if (!window.confirm('确定清空全部 ' + n + ' 个已注册工具？此操作不可撤销。')) return;
                toolRegistry.clear();
                snackbarStore.showSuccessMessage('已清空注册表');
            });
            document.getElementById('trExport').addEventListener('click', () => {
                const dump = toolRegistry.exportJSON();
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'tools-registry.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                snackbarStore.showInfoMessage('已导出 ' + dump.tools.length + ' 个可序列化工具（handler 类型无法导出）');
            });
            document.getElementById('trImport').addEventListener('click', () => {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = '.json,application/json';
                inp.addEventListener('change', () => {
                    const f = inp.files && inp.files[0];
                    if (!f) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                        try {
                            const res = toolRegistry.importJSON(String(reader.result), { override: true });
                            snackbarStore.showSuccessMessage('导入完成：成功 ' + res.ok + '，失败 ' + res.failed);
                            if (res.failed) console.warn('[toolRegistry] import errors', res.errors);
                        } catch (e) {
                            snackbarStore.showErrorMessage('导入失败：' + ((e && e.message) || e));
                        }
                    };
                    reader.readAsText(f);
                });
                inp.click();
            });
            document.getElementById('trLoadExample').addEventListener('click', loadExampleRegistryTools);

            // 页面加载：恢复持久化工具（本地声明式工具可跨刷新保留）
            try { toolRegistry.loadPersisted(); } catch (_) {}
            renderToolRegistryPanel();
        }

        function openAgentDialog() {
            settingStore.agentDialog = true;
            document.getElementById('agentModal').classList.add('open');
            if (agentStore.columns.length === 0) agentStore.loadPersisted();
            renderAgentBoard();
            mcpStore.loadTools();
        }

        // ─── Prompt ───
        function openPromptDialog() {
            if (!mcpStore.getServers()) {
                snackbarStore.showInfoMessage('当前无 MCP 服务器，暂无 Prompts 模板');
                return;
            }
            promptStore.promptDialog = true;
            document.getElementById('promptModal').classList.add('open');
            promptStore.loadPrompts();
        }

        function renderPromptList() {
            const list = document.getElementById('promptList');
            list.innerHTML = '';
            const keyword = document.getElementById('promptSearch').value || '';
            const filtered = promptStore.promptList.filter(p =>
                !keyword || (p.title || '').includes(keyword) || (p.name || '').includes(keyword) || (p
                .description || '').includes(keyword)
            );
            if (filtered.length === 0) {
                list.innerHTML = '<p style="color:#999;">No prompts available</p>';
                return;
            }
            filtered.forEach(prompt => {
                const card = elFromHTML(`
                    <div class="prompt-card">
                        <div class="pc-title">${escapeHtml(prompt.title)}</div>
                        <div class="pc-name">${escapeHtml(prompt.name || '')}</div>
                        <div class="pc-desc">${escapeHtml(prompt.description || '')}</div>
                    </div>
                `);
                card.addEventListener('click', () => promptStore.select(prompt));
                list.appendChild(card);
            });
        }

        // ─── Resource ───
        function openResourceDialog() {
            resourceStore.resourceDialog = true;
            document.getElementById('resourceModal').classList.add('open');
            const servers = mcpStore.listServerResources();
            const tabs = document.getElementById('resourceTabs');
            tabs.innerHTML = '';
            if (servers.length === 0) {
                tabs.innerHTML = '<span style="color:#999;padding:8px;">No resources available</span>';
                document.getElementById('resourceTemplatesList').innerHTML = '<p style="color:#999;">—</p>';
                document.getElementById('resourceList').innerHTML = '<p style="color:#999;">—</p>';
                return;
            }
            servers.forEach((server, i) => {
                const tab = elFromHTML(
                    `<button class="resource-tab ${i === 0 ? 'active' : ''}" data-server="${escapeHtml(server.name)}">${escapeHtml(server.name)}</button>`
                    );
                tab.addEventListener('click', () => {
                    tabs.querySelectorAll('.resource-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    if (server.templatesList) resourceStore.loadTemplates(server.templatesList);
                    if (server.list) resourceStore.loadResources(server.list);
                });
                tabs.appendChild(tab);
            });
            if (servers[0].templatesList) resourceStore.loadTemplates(servers[0].templatesList);
            if (servers[0].list) resourceStore.loadResources(servers[0].list);
        }

        function renderResourceTemplates() {
            const list = document.getElementById('resourceTemplatesList');
            list.innerHTML = '';
            const items = resourceStore.resourceTemplatesList || [];
            if (items.length === 0) { list.innerHTML = '<p style="color:#999;">—</p>'; return; }
            items.forEach(item => {
                list.insertAdjacentHTML('beforeend', `
                    <div class="resource-card">
                        <div class="rc-name">${escapeHtml(item.name || '')}</div>
                        <div class="rc-uri">${escapeHtml(item.uriTemplate || '')}</div>
                        <div class="rc-desc">${escapeHtml(item.description || '')}</div>
                    </div>
                `);
            });
        }

        function renderResources() {
            const list = document.getElementById('resourceList');
            list.innerHTML = '';
            const items = resourceStore.resourceList || [];
            if (items.length === 0) { list.innerHTML = '<p style="color:#999;">—</p>'; return; }
            items.forEach(item => {
                list.insertAdjacentHTML('beforeend', `
                    <div class="resource-card">
                        <div class="rc-name">${escapeHtml(item.name || '')} - ${escapeHtml(item.uri || '')}</div>
                        <div class="rc-desc">${escapeHtml(JSON.stringify(item))}</div>
                    </div>
                `);
            });
        }

        // ══════════════════════════════════════════════════════════
        // 事件绑定 & 初始化
        // ══════════════════════════════════════════════════════════
        function resizeAvatar() {
            settingStore.avatarSize = window.innerWidth <= 1279 ? 26 : 36;
            document.querySelectorAll('.message-avatar').forEach(el => {
                el.style.width = settingStore.avatarSize + 'px';
                el.style.height = settingStore.avatarSize + 'px';
            });
        }

        function resizeInputBox() {
            const panel = document.querySelector('.input-panel');
            const chatElement = document.querySelector('.chat-bot');
            if (!panel || !chatElement) return;
            // 预留「输入区整体」高度（含计划条 / 运行计时 / 费用统计等多行），
            // 而不是只按 .input-box 高度预留；否则输入区出现计划条时会向上增高，
            // 固定定位（position:fixed）的输入区就会盖住底部最新的响应消息。
            const reserve = () => {
                chatElement.style.marginBottom = Math.max(panel.offsetHeight, 122) + 'px';
            };
            const observer = new ResizeObserver(() => {
                reserve();
                // 高度变化后（如计划条展开/收起），若用户仍在底部则保持粘底，
                // 让最新一条响应始终露在输入区上方。
                try { if (typeof scrollToBottom === 'function') scrollToBottom(); } catch (_) {}
            });
            observer.observe(panel);
            reserve();
        }

        function resetALL() {
            historyStore.resetState();
            chatbotStore.resetState();
            defaultChoiceStore.resetState();
            cacheStatsStore.reset();
        }
        chatbotStore.resetState = function() {
            Object.assign(this, chatbotStoreDefault());
            // 记忆开关回到默认（不启用）：立即注销工具 + 停止注入
            try {
                if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.setEnabled === 'function') {
                    window.AgentMemoryBridge.setEnabled(this.memory && this.memory.enabled === true);
                }
            } catch (_) {}
            secretStore.remove('apiKey');
            if (Array.isArray(this.providers)) this.providers.forEach(p => {
                if (p) secretStore.remove('provider.' + (p.id || p.name || 'default') + '.apiKey');
            });
            saveChatbot();
            defaultChoiceStore.resetState();
            updateConfigChips();
        };
        defaultChoiceStore.resetState = function() {
            Object.assign(this, defaultChoiceDefault());
            saveDefaultChoice();
        };
        chatbotStore.updateStoreFromJSON = function(json) {
            Object.assign(this, json);
            // 导入配置后记忆开关立即生效（避免要刷新页面才切换工具/注入）
            try {
                if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.config === 'function' && this.memory) {
                    window.AgentMemoryBridge.config({
                        enabled: this.memory.enabled === true,
                        autoRecall: this.memory.autoRecall !== false,
                        autoIndexTurns: this.memory.autoIndexTurns !== false,
                        recallLimit: this.memory.recallLimit
                    });
                }
            } catch (_) {}
            saveChatbot();
        };
        defaultChoiceStore.updateStoreFromJSON = function(json) {
            Object.assign(this, json);
            saveDefaultChoice();
        };

