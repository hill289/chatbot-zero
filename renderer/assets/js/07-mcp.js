        // ══════════════════════════════════════════════════════════
        // 外部 MCP 客户端（支持连接多个“浏览器外执行”的 MCP Server）
        //   参考 mcp-browser-client/public 的实现：MCP Streamable HTTP 传输（JSON-RPC 2.0）
        //   每个 Server 独立走：initialize → notifications/initialized → tools/list → tools/call
        //   会话通过响应头 mcp-session-id 维持；兼容 application/json 与 text/event-stream 响应
        //   每个连接成功后，由 externalMcpManager 注册为 mcpStore 的一个独立“服务”
        //   （服务键 external-mcp-1 / external-mcp-2 …），因此 LLM 的工具发现/调用循环
        //   （mcpStore.listTools / getTool / callTool）无需任何改动即可用上全部 Server 的工具。
        // ══════════════════════════════════════════════════════════

        // 单个外部 MCP Server 连接（每个实例维护自己的 url / session / tools）
        function createExternalMcpConn(url) {
            return {
                url: (url || '').trim(),
                sessionId: null,
                serverInfo: null,
                tools: [],
                connected: false,
                _id: 0,
                _nextId() { this._id += 1; return this._id; },

                // 解析响应体：可能是 application/json，也可能是 text/event-stream（SSE）
                async _parseBody(resp) {
                    const ct = (resp.headers.get('content-type') || '').toLowerCase();
                    const text = await resp.text();
                    if (ct.includes('text/event-stream')) {
                        let last = null;
                        for (const rawLine of text.split(/\r?\n/)) {
                            const line = rawLine.trim();
                            if (!line.startsWith('data:')) continue;
                            const payload = line.slice(5).trim();
                            if (!payload || payload === '[DONE]') continue;
                            try {
                                const obj = JSON.parse(payload);
                                if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
                                else if (last === null) last = obj;
                            } catch (_) { /* 忽略非 JSON 事件行 */ }
                        }
                        return last;
                    }
                    if (!text) return null;
                    try { return JSON.parse(text); } catch (_) { return null; }
                },

                async _rpc(method, params, opts) {
                    opts = opts || {};
                    if (!this.url) throw new Error('未配置外部 MCP Server URL');
                    const headers = {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'
                    };
                    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
                    const body = { jsonrpc: '2.0', method };
                    if (params !== undefined && params !== null) body.params = params;
                    if (!opts.isNotification) body.id = this._nextId();

                    const resp = await fetch(this.url, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(body)
                    });
                    // 会话建立后，服务器通过响应头返回 mcp-session-id
                    const sid = resp.headers.get('mcp-session-id');
                    if (sid) this.sessionId = sid;
                    if (opts.isNotification) { await resp.text().catch(() => ''); return null; }
                    if (!resp.ok) {
                        const t = await resp.text().catch(() => '');
                        throw new Error('MCP HTTP ' + resp.status + ' ' + resp.statusText + (t ? ': ' + t : ''));
                    }
                    const parsed = await this._parseBody(resp);
                    if (parsed && parsed.error) {
                        throw new Error(parsed.error.message || JSON.stringify(parsed.error));
                    }
                    return parsed ? parsed.result : null;
                },

                async connect() {
                    this.sessionId = null;
                    this.connected = false;
                    this.tools = [];
                    this.serverInfo = null;
                    if (!this.url) return { ok: false, reason: 'no-url' };
                    // 1) initialize 握手
                    const initResult = await this._rpc('initialize', {
                        protocolVersion: '2025-03-26',
                        capabilities: { sampling: {}, roots: {} },
                        clientInfo: { name: 'chatbot-page-client', version: '1.0.0' }
                    });
                    const info = (initResult && initResult.serverInfo) || {};
                    this.serverInfo = { name: info.name || 'Unknown', version: info.version || 'unknown' };
                    // 2) notifications/initialized
                    await this._rpc('notifications/initialized', null, { isNotification: true });
                    this.connected = true;
                    // 3) 拉取工具列表
                    await this.refreshTools();
                    return { ok: true, serverInfo: this.serverInfo, toolCount: this.tools.length };
                },

                async refreshTools() {
                    if (!this.connected) return [];
                    const result = await this._rpc('tools/list', {});
                    const list = (result && Array.isArray(result.tools)) ? result.tools : [];
                    this.tools = list.map(t => ({
                        name: t.name,
                        description: t.description || '',
                        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} }
                    }));
                    try { prefixManager.invalidateTools(); } catch (_) { /* prefixManager 尚未初始化 */ }
                    return this.tools;
                },

                async callTool(name, args) {
                    const result = await this._rpc('tools/call', { name: name, arguments: args || {} });
                    return result || { content: [] };
                }
            };
        }

        // ── 多 Server 管理器：维护多个外部连接，并各自注册进 window.mcpServers ──
        const externalMcpManager = {
            servers: [],   // [{ key, conn }]

            get connectedCount() { return this.servers.length; },

            // 把已注册的服务键从 window.mcpServers 中移除（重连/断开时调用）
            _clearRegistrations() {
                for (const s of this.servers) {
                    try { delete window.mcpServers[s.key]; } catch (_) {}
                }
                this.servers = [];
            },

            // 注册单个连接：服务键 external-mcp-<n>，暴露 tools.list / tools.call
            _register(conn) {
                const key = 'external-mcp-' + (this.servers.length + 1);
                window.mcpServers[key] = {
                    tools: {
                        list: async () => ({
                            tools: conn.tools.map(t => ({
                                name: t.name,
                                description: t.description,
                                inputSchema: t.inputSchema
                            }))
                        }),
                        call: async (params) => {
                            try {
                                const res = await conn.callTool(params.name, params.arguments || {});
                                const content = (res && Array.isArray(res.content) && res.content.length)
                                    ? res.content
                                    : [{ type: 'text', text: (typeof res === 'string' ? res : JSON.stringify(res)) }];
                                return JSON.stringify({
                                    success: !(res && res.isError),
                                    isError: !!(res && res.isError),
                                    content: content
                                });
                            } catch (e) {
                                return JSON.stringify({
                                    success: false,
                                    isError: true,
                                    content: [{ type: 'text', text: 'External MCP error: ' + (e && e.message ? e.message : String(e)) }]
                                });
                            }
                        }
                    }
                };
                this.servers.push({ key, conn });
                return key;
            },

            // 断开全部并清空注册
            disconnectAll(silent) {
                this._clearRegistrations();
                try { prefixManager.invalidateTools(); } catch (_) {}
                if (!silent) snackbarStore.showInfoMessage('外部 MCP Server 已禁用');
            },

            // 连接/重连一组 URL（数组）。先断开旧的，再逐个建立新连接。
            async connectAll(urls) {
                this._clearRegistrations();
                try { prefixManager.invalidateTools(); } catch (_) {}

                // 去重、去空
                const list = [];
                const seen = new Set();
                for (const u of (urls || [])) {
                    const t = (u || '').trim();
                    if (!t || seen.has(t)) continue;
                    seen.add(t);
                    list.push(t);
                }

                if (list.length === 0) {
                    snackbarStore.showInfoMessage('外部 MCP Server 已禁用');
                    return { ok: 0, fail: 0, total: 0 };
                }

                snackbarStore.showInfoMessage('正在连接 ' + list.length + ' 个外部 MCP Server…');
                let ok = 0, fail = 0;
                const details = [];
                for (const url of list) {
                    const conn = createExternalMcpConn(url);
                    try {
                        const r = await conn.connect();
                        if (r && r.ok) {
                            this._register(conn);
                            ok++;
                            details.push('✅ ' + url + '（' + r.serverInfo.name + '，' + r.toolCount + ' 个工具）');
                        } else {
                            fail++;
                            details.push('⚠️ ' + url + '（未连接）');
                        }
                    } catch (e) {
                        fail++;
                        details.push('❌ ' + url + '（' + (e && e.message ? e.message : String(e)) + '）');
                    }
                }
                try { prefixManager.invalidateTools(); } catch (_) {}

                if (ok > 0 && fail === 0) {
                    snackbarStore.showSuccessMessage('已连接全部外部 MCP：' + ok + ' 个');
                } else if (ok > 0) {
                    snackbarStore.showWarningMessage('外部 MCP 部分连接：成功 ' + ok + ' 个，失败 ' + fail + ' 个');
                } else {
                    snackbarStore.showErrorMessage('连接外部 MCP 失败：' + fail + ' 个全部失败');
                }
                console.log('[external MCP] 连接结果:\n' + details.join('\n'));
                return { ok, fail, total: list.length };
            },

            // 刷新全部已连接 Server 的工具列表
            async refreshAll() {
                for (const s of this.servers) {
                    try { await s.conn.refreshTools(); } catch (_) {}
                }
                try { prefixManager.invalidateTools(); } catch (_) {}
            },

            // 状态摘要（供调试/展示）
            summary() {
                return this.servers.map(s => ({
                    key: s.key,
                    url: s.conn.url,
                    server: s.conn.serverInfo ? s.conn.serverInfo.name : '',
                    tools: s.conn.tools.length
                }));
            }
        };

        // ── 配置弹窗中的「多 MCP URL」列表 UI ──
        function addMcpUrlRow(url) {
            const wrap = document.getElementById('mcpUrlList');
            if (!wrap) return;
            const row = elFromHTML(
                '<div class="mcp-url-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">' +
                    '<input type="text" class="mcp-url-input" placeholder="http://localhost:8081/mcp" ' +
                        'style="flex:1;padding:9px 12px;border:1px solid #d5d5d5;border-radius:4px;font-size:14px;outline:none;font-family:inherit;background:#fff;">' +
                    '<button type="button" class="m-btn danger mcp-url-remove" title="Remove" style="padding:6px 10px;flex-shrink:0;">✕</button>' +
                '</div>'
            );
            const input = row.querySelector('.mcp-url-input');
            input.value = url || '';
            row.querySelector('.mcp-url-remove').addEventListener('click', function () {
                row.remove();
                if (wrap.querySelectorAll('.mcp-url-row').length === 0) addMcpUrlRow('');
            });
            wrap.appendChild(row);
        }

        function renderMcpUrlRows(urls) {
            const wrap = document.getElementById('mcpUrlList');
            if (!wrap) return;
            wrap.innerHTML = '';
            const list = Array.isArray(urls) ? urls.slice() : [];
            if (list.length === 0) list.push('');
            list.forEach(u => addMcpUrlRow(u));
        }

        function collectMcpUrls() {
            const inputs = document.querySelectorAll('#mcpUrlList .mcp-url-input');
            const urls = [];
            const seen = new Set();
            inputs.forEach(inp => {
                const v = (inp.value || '').trim();
                if (v && !seen.has(v)) { seen.add(v); urls.push(v); }
            });
            return urls;
        }

        // ── 配置弹窗中的「多 SSH 主机」列表 UI + 连接/断开管理 ─────────────
        // 行字段：IP/主机、端口、用户名、密码；每行带「🔌 Connect / ⏏ Disconnect」按钮
        // 与状态徽标。连接由主进程 ssh-manager 维护（IPC ssh:*，preload → window.sshAPI），
        // 密码随「⚙️ 配置」保存进 safeStorage（08-ui-store 的 stripSecretsForSave）。
        function sshApi() {
            return (typeof window !== 'undefined' && window.sshAPI) ? window.sshAPI : null;
        }
        function sshRowConfig(row) {
            const v = (sel, dflt) => {
                const inp = row.querySelector(sel);
                const s = inp ? String(inp.value || '').trim() : '';
                return s || dflt;
            };
            return {
                host: v('.ssh-host-input', ''),
                port: parseInt(v('.ssh-port-input', '22'), 10) || 22,
                username: v('.ssh-user-input', ''),
                password: row.querySelector('.ssh-pass-input') ? String(row.querySelector('.ssh-pass-input').value || '') : ''
            };
        }
        function sshMarkRowState(row, state, tip) {
            if (!row) return;
            const btn = row.querySelector('.ssh-host-toggle');
            const st = row.querySelector('.ssh-host-status');
            const map = {
                connected: ['⏏ Disconnect', '●', '#16a34a'],
                connecting: ['🔌 Connect', '⏳', '#d97706'],
                error: ['🔌 Connect', '✕', '#dc2626'],
                idle: ['🔌 Connect', '○', '#94a3b8']
            };
            const m = map[state] || map.idle;
            if (btn) { btn.textContent = m[0]; btn.disabled = (state === 'connecting'); }
            if (st) { st.textContent = m[1]; st.style.color = m[2]; st.title = tip || ''; }
            if (state === 'connected') {
                const cfg = sshRowConfig(row);
                row.dataset.sshKey = cfg.host + ':' + cfg.port + '@' + cfg.username;
            } else {
                delete row.dataset.sshKey;
            }
        }
        // 连接状态变化 → 工具集可能变化（ssh-mcp 注册/注销），显式失效前缀缓存
        function sshRefreshMcpTools() {
            try { prefixManager.invalidateTools(); } catch (_) { /* 尚未初始化 */ }
            try { if (typeof sshMcpSync === 'function') sshMcpSync(); } catch (_) { /* 步骤4 未就绪 */ }
            try { mcpStore.loadTools(); } catch (_) { /* 尚未初始化 */ }
        }
        async function sshRowToggle(row) {
            const api = sshApi();
            if (!api) { snackbarStore.showErrorMessage('SSH 不可用：需要 Electron 外壳（或 ssh2 未安装）'); return; }
            const cfg = sshRowConfig(row);
            const btn = row.querySelector('.ssh-host-toggle');
            if (row.dataset.sshKey) {          // 已连接 → 断开
                const prevKey = row.dataset.sshKey;
                if (btn) btn.disabled = true;
                const r = await api.disconnect(prevKey);
                if (btn) btn.disabled = false;
                sshMarkRowState(row, 'idle');
                if (r && r.ok) snackbarStore.showInfoMessage('已断开 ' + prevKey);
                sshRefreshMcpTools();
                return;
            }
            if (!cfg.host || !cfg.username) { snackbarStore.showErrorMessage('请先填写主机 IP 与用户名'); return; }
            sshMarkRowState(row, 'connecting', '连接中…');
            let r = null;
            try { r = await api.connect(cfg); }
            catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
            if (r && r.ok) {
                sshMarkRowState(row, 'connected');
                snackbarStore.showSuccessMessage('已连接 ' + r.key);
            } else {
                sshMarkRowState(row, 'error', (r && r.error) || '');
                snackbarStore.showErrorMessage('SSH 连接失败：' + ((r && r.error) || '未知错误'));
            }
            sshRefreshMcpTools();
        }
        async function sshDisconnectAll() {
            const api = sshApi();
            if (!api) { snackbarStore.showErrorMessage('SSH 不可用：需要 Electron 外壳（或 ssh2 未安装）'); return; }
            try { await api.disconnect(''); } catch (_) {}
            document.querySelectorAll('#sshHostList .ssh-host-row').forEach(row => sshMarkRowState(row, 'idle'));
            snackbarStore.showInfoMessage('SSH 连接已全部断开');
            sshRefreshMcpTools();
        }
        // 按主进程连接池状态回填各行徽标（打开配置弹窗 / 断开全部后调用）
        async function sshSyncRowsFromStatus() {
            const api = sshApi();
            const wrap = document.getElementById('sshHostList');
            if (!api || !wrap) return;
            let status = [];
            try {
                const r = await api.status();
                status = (r && r.ok && Array.isArray(r.status)) ? r.status : [];
            } catch (_) { return; }
            const connectedKeys = new Set(status.filter(s => s.connected).map(s => s.key));
            wrap.querySelectorAll('.ssh-host-row').forEach(row => {
                const cfg = sshRowConfig(row);
                if (!cfg.host || !cfg.username) { sshMarkRowState(row, 'idle'); return; }
                const key = cfg.host + ':' + cfg.port + '@' + cfg.username;
                sshMarkRowState(row, connectedKeys.has(key) ? 'connected' : 'idle');
            });
        }
        // 配置保存后：被删除/被修改的主机断开连接（未动的保持原连接）
        async function sshReconcileConnections(prevHosts, nextHosts) {
            const api = sshApi();
            if (!api) return;
            const keyOf = (h) => String(h.host || '').trim() + ':' + (parseInt(h.port, 10) || 22) + '@' + String(h.username || '').trim();
            const nextByKey = {};
            (nextHosts || []).forEach(h => { if (h && h.host) nextByKey[keyOf(h)] = JSON.stringify([h.host, h.port, h.username, h.password || '']); });
            for (const h of (prevHosts || [])) {
                if (!h || !h.host) continue;
                const k = keyOf(h);
                const changed = nextByKey[k] !== JSON.stringify([h.host, h.port, h.username, h.password || '']);
                if (changed) { try { await api.disconnect(k); } catch (_) {} }
            }
            await sshSyncRowsFromStatus();
            sshRefreshMcpTools();
        }

        function addSshHostRow(host) {
            const wrap = document.getElementById('sshHostList');
            if (!wrap) return;
            host = host || {};
            const row = elFromHTML(
                '<div class="ssh-host-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">' +
                    '<input type="text" class="ssh-host-input" placeholder="IP / 主机名" title="主机 IP 或域名" ' +
                        'style="flex:2;min-width:120px;padding:8px 10px;border:1px solid #d5d5d5;border-radius:4px;font-size:13px;outline:none;font-family:inherit;background:#fff;">' +
                    '<input type="number" class="ssh-port-input" placeholder="22" min="1" max="65535" title="端口（默认 22）" ' +
                        'style="flex:0 0 78px;padding:8px 10px;border:1px solid #d5d5d5;border-radius:4px;font-size:13px;outline:none;background:#fff;">' +
                    '<input type="text" class="ssh-user-input" placeholder="用户名" title="登录用户名" ' +
                        'style="flex:1;min-width:84px;padding:8px 10px;border:1px solid #d5d5d5;border-radius:4px;font-size:13px;outline:none;font-family:inherit;background:#fff;">' +
                    '<input type="password" class="ssh-pass-input" placeholder="密码" title="登录密码（safeStorage 加密存储）" autocomplete="new-password" ' +
                        'style="flex:1.4;min-width:96px;padding:8px 10px;border:1px solid #d5d5d5;border-radius:4px;font-size:13px;outline:none;font-family:inherit;background:#fff;">' +
                    '<button type="button" class="m-btn outline ssh-host-toggle" style="padding:6px 10px;font-size:12px;flex-shrink:0;">🔌 Connect</button>' +
                    '<span class="ssh-host-status" style="font-size:11px;color:#94a3b8;flex-shrink:0;width:12px;text-align:center;" title="连接状态">○</span>' +
                    '<button type="button" class="m-btn danger ssh-host-remove" title="Remove" style="padding:6px 10px;flex-shrink:0;">✕</button>' +
                '</div>'
            );
            row.querySelector('.ssh-host-input').value = host.host || '';
            row.querySelector('.ssh-port-input').value = host.port || 22;
            row.querySelector('.ssh-user-input').value = host.username || '';
            row.querySelector('.ssh-pass-input').value = host.password || '';
            row.querySelector('.ssh-host-toggle').addEventListener('click', function () {
                sshRowToggle(row);   // async，失败已在内部提示
            });
            row.querySelector('.ssh-host-remove').addEventListener('click', function () {
                const key = row.dataset.sshKey;
                row.remove();
                if (key && sshApi()) { try { sshApi().disconnect(key); } catch (_) {} sshRefreshMcpTools(); }
                if (wrap.querySelectorAll('.ssh-host-row').length === 0) addSshHostRow(null);
            });
            wrap.appendChild(row);
        }

        function renderSshHostRows(hosts) {
            const wrap = document.getElementById('sshHostList');
            if (!wrap) return;
            wrap.innerHTML = '';
            const list = Array.isArray(hosts) ? hosts.slice() : [];
            if (list.length === 0) list.push(null);
            list.forEach(h => addSshHostRow(h || null));
            sshSyncRowsFromStatus();   // 重开弹窗时恢复连接徽标（连接池在主进程）
        }

        function collectSshHosts() {
            const hosts = [];
            const seen = new Set();
            document.querySelectorAll('#sshHostList .ssh-host-row').forEach(row => {
                const cfg = sshRowConfig(row);
                if (!cfg.host || !cfg.username) return;
                const k = cfg.host + ':' + cfg.port + '@' + cfg.username;
                if (seen.has(k)) return;
                seen.add(k);
                hosts.push(cfg);
            });
            return hosts;
        }

        // ── MCP ssh 服务（服务键 ssh-mcp）────────────────────────────────
        //   工具：ssh_hosts / ssh_connect / ssh_disconnect / ssh_exec /
        //         ssh_sftp_ls / ssh_sftp_download / ssh_sftp_upload
        //   注册条件：window.sshAPI 可用（Electron 外壳）且已配置至少一台主机；
        //   sshMcpSync() 在连接状态/配置变化时由 sshRefreshMcpTools 调用（注册/注销）。
        const SSH_MCP_TOOLS = [
            {
                name: 'ssh_hosts',
                description: '列出已配置的 SSH 主机及连接状态（host/port/user/connected/lastError）。连接与断开按钮在「⚙️ 配置 → SSH Servers」。',
                inputSchema: { type: 'object', properties: {}, required: [] }
            },
            {
                name: 'ssh_connect',
                description: '连接 SSH 主机。参数全省略 = 连接配置中所有尚未连接的主机；给 host 则只连该主机（可在参数里补 port/username/password）。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        host: { type: 'string', description: '主机 IP/域名（省略则连接全部未连接的配置主机）' },
                        port: { type: 'integer', description: '端口，默认 22' },
                        username: { type: 'string', description: '用户名（host 指定但配置中没有时必填）' },
                        password: { type: 'string', description: '密码（host 指定但配置中没有时必填）' }
                    },
                    required: []
                }
            },
            {
                name: 'ssh_disconnect',
                description: '断开 SSH 连接。host 省略 = 断开全部连接。',
                inputSchema: {
                    type: 'object',
                    properties: { host: { type: 'string', description: '主机 IP/域名（省略=全部断开）' } },
                    required: []
                }
            },
            {
                name: 'ssh_exec',
                description: '在已连接的 SSH 主机上执行 shell 命令，返回 stdout/stderr/退出码。host 省略时用第一台已连接主机。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: '要执行的命令' },
                        host: { type: 'string', description: '主机 IP/域名（省略=第一台已连接主机）' },
                        timeout_ms: { type: 'integer', description: '超时毫秒，默认 120000，上限 600000' }
                    },
                    required: ['command']
                }
            },
            {
                name: 'ssh_sftp_ls',
                description: '用 SFTP 列出远程主机目录（返回文件名/类型/大小/修改时间）。path 默认为登录家目录。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '远程目录路径，默认 .' },
                        host: { type: 'string', description: '主机 IP/域名（省略=第一台已连接主机）' }
                    },
                    required: []
                }
            },
            {
                name: 'ssh_sftp_download',
                description: '用 SFTP 下载远程文件到本机虚拟工作区（VFS）。local_path 省略时落到 /home/pyodide/<文件名>，下载后可在文件列表看到。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        remote_path: { type: 'string', description: '远程文件绝对路径' },
                        local_path: { type: 'string', description: 'VFS 目标路径，默认 /home/pyodide/<文件名>' },
                        host: { type: 'string', description: '主机 IP/域名（省略=第一台已连接主机）' }
                    },
                    required: ['remote_path']
                }
            },
            {
                name: 'ssh_sftp_upload',
                description: '用 SFTP 把虚拟工作区（VFS）文件上传到远程主机。remote_path 需给出远程目标文件完整路径。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        local_path: { type: 'string', description: 'VFS 源文件路径，如 /home/pyodide/a.js' },
                        remote_path: { type: 'string', description: '远程目标文件完整路径' },
                        host: { type: 'string', description: '主机 IP/域名（省略=第一台已连接主机）' }
                    },
                    required: ['local_path', 'remote_path']
                }
            }
        ];

        function sshMcpOk(text) {
            return JSON.stringify({ success: true, isError: false, content: [{ type: 'text', text: String(text) }] });
        }
        function sshMcpErr(text) {
            return JSON.stringify({ success: false, isError: true, content: [{ type: 'text', text: String(text) }] });
        }
        // base64 ↔ 字节（renderer 无 Buffer；大块分段避免栈溢出）
        function sshBytesFromB64(b64) {
            const bin = atob(String(b64 || ''));
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            return u;
        }
        function sshB64FromBytes(bytes) {
            let s = '';
            const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) {
                s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
            }
            return btoa(s);
        }
        function sshB64FromBinaryStr(bin) {
            let out = '';
            const CH = 0x8000;
            for (let i = 0; i < bin.length; i += CH) out += btoa(bin.slice(i, Math.min(i + CH, bin.length)));
            return out;
        }
        function sshVfsEnsureReady() {
            if (typeof nodeRuntime === 'undefined' || !nodeRuntime || !nodeRuntime.ready) {
                throw new Error('VFS（Node 运行时）未就绪');
            }
            return nodeRuntime.FS;
        }
        // 解析目标主机 key：hostHint 匹配已连接主机；无 hint 取第一台已连接的
        async function sshMcpResolveKey(hostHint) {
            const api = sshApi();
            if (!api) throw new Error('SSH 不可用：需要 Electron 外壳（或 ssh2 未安装）');
            let st = null;
            try { st = await api.status(); } catch (_) {}
            const list = (st && st.ok && Array.isArray(st.status)) ? st.status : [];
            const connected = list.filter(s => s.connected);
            if (hostHint) {
                const h = String(hostHint).trim();
                const hit = connected.find(s => s.key === h || s.host === h);
                if (hit) return hit.key;
                const cfg = ((typeof chatbotStore !== 'undefined' && chatbotStore.sshHosts) || [])
                    .find(x => x && x.host === h);
                if (!cfg) throw new Error('主机 ' + h + ' 未在「⚙️ 配置 → SSH Servers」中配置');
                const r = await api.connect(cfg);
                if (r && r.ok) return r.key;
                throw new Error('连接 ' + h + ' 失败：' + ((r && r.error) || '未知错误'));
            }
            if (connected.length) return connected[0].key;
            throw new Error('当前没有已连接的 SSH 主机：请在「⚙️ 配置 → SSH Servers」点「🔌 Connect」，或调用 ssh_connect');
        }

        async function sshMcpCall(params) {
            const name = params && params.name;
            const args = (params && params.arguments) || {};
            try {
                const api = sshApi();
                if (!api) return sshMcpErr('SSH 不可用：需要 Electron 外壳（或 ssh2 未安装）');

                if (name === 'ssh_hosts') {
                    const hosts = (typeof chatbotStore !== 'undefined' && Array.isArray(chatbotStore.sshHosts))
                        ? chatbotStore.sshHosts : [];
                    let st = null;
                    try { st = await api.status(); } catch (_) {}
                    const status = (st && st.ok && Array.isArray(st.status)) ? st.status : [];
                    const lines = hosts.length === 0
                        ? ['（尚未配置 SSH 主机；请在「⚙️ 配置 → SSH Servers」添加）']
                        : hosts.map(h => {
                            const key = String(h.host).trim() + ':' + (parseInt(h.port, 10) || 22) + '@' + String(h.username || '').trim();
                            const s = status.find(x => x.key === key);
                            return key + ' → ' + (s && s.connected ? '✅ connected'
                                : ('❌ not connected' + (s && s.lastError ? '（' + s.lastError + '）' : '')));
                        });
                    return sshMcpOk('SSH 主机状态：\n' + lines.join('\n'));
                }

                if (name === 'ssh_connect') {
                    let targets = [];
                    if (args.host) {
                        const cfg = ((typeof chatbotStore !== 'undefined' && chatbotStore.sshHosts) || [])
                            .find(x => x && x.host === args.host) || {};
                        targets.push({
                            host: args.host, port: args.port || cfg.port || 22,
                            username: args.username || cfg.username || '',
                            password: args.password != null ? args.password : (cfg.password || '')
                        });
                        if (!targets[0].username) return sshMcpErr('ssh_connect 缺少 username（配置里也没有该主机）');
                    } else {
                        let st = null;
                        try { st = await api.status(); } catch (_) {}
                        const connectedKeys = new Set(((st && st.ok && st.status) || []).filter(s => s.connected).map(s => s.key));
                        targets = ((typeof chatbotStore !== 'undefined' && chatbotStore.sshHosts) || [])
                            .filter(h => h && h.host && !connectedKeys.has(
                                String(h.host).trim() + ':' + (parseInt(h.port, 10) || 22) + '@' + String(h.username || '').trim()));
                        if (targets.length === 0) return sshMcpOk('所有配置的 SSH 主机均已连接（无需操作）。');
                    }
                    const done = [], failed = [];
                    for (const cfg of targets) {
                        try {
                            const r = await api.connect(cfg);
                            if (r && r.ok) done.push(r.key);
                            else failed.push(cfg.host + '（' + ((r && r.error) || '未知错误') + '）');
                        } catch (e) { failed.push(cfg.host + '（' + String((e && e.message) || e) + '）'); }
                    }
                    sshRefreshMcpTools();
                    const msg = '连接成功 ' + done.length + ' 台' + (done.length ? '：\n• ' + done.join('\n• ') : '')
                        + (failed.length ? '\n失败 ' + failed.length + ' 台：\n• ' + failed.join('\n• ') : '');
                    return failed.length && !done.length ? sshMcpErr(msg) : sshMcpOk(msg);
                }

                if (name === 'ssh_disconnect') {
                    if (args.host) {
                        const key = await sshMcpResolveKey(args.host);
                        await api.disconnect(key);
                        sshRefreshMcpTools();
                        return sshMcpOk('已断开 ' + key);
                    }
                    await api.disconnect('');
                    sshRefreshMcpTools();
                    return sshMcpOk('已断开全部 SSH 连接');
                }

                if (name === 'ssh_exec') {
                    const key = await sshMcpResolveKey(args.host);
                    const r = await api.exec({ key, command: args.command, timeoutMs: args.timeout_ms });
                    if (!r || !r.ok) return sshMcpErr('ssh_exec 失败：' + ((r && r.error) || 'IPC 无响应'));
                    const out = ('$ ' + args.command + '\n[exit ' + r.code + ']\n'
                        + (r.stdout || '') + (r.stderr ? ('\n[stderr]\n' + r.stderr) : '')).trim();
                    return r.code === 0 ? sshMcpOk(out) : sshMcpErr(out);
                }

                if (name === 'ssh_sftp_ls') {
                    const key = await sshMcpResolveKey(args.host);
                    const r = await api.ls({ key, path: args.path || '.' });
                    if (!r || !r.ok) return sshMcpErr('ssh_sftp_ls 失败：' + ((r && r.error) || 'IPC 无响应'));
                    const lines = r.files.length
                        ? r.files.map(f => (f.type === 'dir' ? '📁 ' : '📄 ') + f.name
                            + (f.type === 'dir' ? '/' : '  ' + f.size + ' B')).join('\n')
                        : '（空目录）';
                    return sshMcpOk('远程目录 ' + r.path + '：\n' + lines);
                }

                if (name === 'ssh_sftp_download') {
                    const key = await sshMcpResolveKey(args.host);
                    const r = await api.read({ key, path: args.remote_path });
                    if (!r || !r.ok) return sshMcpErr('ssh_sftp_download 失败：' + ((r && r.error) || 'IPC 无响应'));
                    const FS = sshVfsEnsureReady();
                    const base = String(args.remote_path).split('/').filter(Boolean).pop() || 'download.bin';
                    const target = args.local_path || ('/home/pyodide/' + base);
                    try { FS.mkdirTree(target.substring(0, target.lastIndexOf('/')) || '/'); } catch (_) {}
                    FS.writeFile(target, sshBytesFromB64(r.dataBase64));
                    try { if (typeof listNodeFiles === 'function') listNodeFiles(); } catch (_) {}
                    return sshMcpOk('已下载 ' + r.path + '（' + r.size + ' B）→ VFS ' + target + '（文件列表已刷新）');
                }

                if (name === 'ssh_sftp_upload') {
                    const FS = sshVfsEnsureReady();
                    let bytes;
                    try { bytes = FS.readFile(args.local_path, { encoding: 'binary' }); }
                    catch (e) { return sshMcpErr('读取 VFS 文件失败：' + String((e && e.message) || e)); }
                    const b64 = sshB64FromBinaryStr(bytes);
                    const key = await sshMcpResolveKey(args.host);
                    const r = await api.write({ key, path: args.remote_path, dataBase64: b64 });
                    if (!r || !r.ok) return sshMcpErr('ssh_sftp_upload 失败：' + ((r && r.error) || 'IPC 无响应'));
                    return sshMcpOk('已上传 VFS ' + args.local_path + ' → ' + r.path + '（' + r.size + ' B）');
                }

                return sshMcpErr('未知的 ssh 工具：' + name);
            } catch (e) {
                return sshMcpErr('SSH 工具失败：' + String((e && e.message) || e));
            }
        }

        // 注册/注销 ssh-mcp 服务（配置了主机且外壳可用才注册；由 sshRefreshMcpTools 与 initApp 调用）
        function sshMcpSync() {
            if (typeof window === 'undefined' || !window.mcpServers) return;
            const hosts = (typeof chatbotStore !== 'undefined' && Array.isArray(chatbotStore.sshHosts))
                ? chatbotStore.sshHosts : [];
            const should = !!sshApi() && hosts.length > 0;
            if (should) {
                if (!window.mcpServers['ssh-mcp']) {
                    window.mcpServers['ssh-mcp'] = {
                        tools: {
                            list: async () => ({ tools: SSH_MCP_TOOLS.slice() }),
                            call: async (p) => sshMcpCall(p)
                        }
                    };
                }
            } else if (window.mcpServers['ssh-mcp']) {
                delete window.mcpServers['ssh-mcp'];
            }
        }

        // ── MCP 数据库服务（服务键 db-mcp）──────────────────────────────
        //   把「内置的 PostgreSQL（PGlite，进程内嵌、无端口）」暴露成一组 MCP 工具：
        //     db_status / db_query / db_objects / db_saved / db_table / db_apply_changes
        //   工具描述与结果格式化在 renderer/db-mcp-core.js（window.DbMcpCore，纯逻辑可单测）；
        //   数据通道为 window.dbAPI（preload.js 暴露，主进程 db:* IPC 直连 PGlite）。
        //   注册条件：window.dbAPI + DbMcpCore 可用（Electron 桌面外壳）；纯浏览器预览不注册。
        //   与 ssh-mcp 一致：call 返回「JSON 字符串」，供 mcpStore / runToolCalls 解析。
        function dbMcpSync() {
            if (typeof window === 'undefined' || !window.mcpServers) return;
            const core = window.DbMcpCore;
            const available = !!(window.dbAPI && core && typeof core.create === 'function');
            if (available) {
                if (!window.mcpServers['db-mcp']) {
                    const engine = core.create(window.dbAPI);
                    window.mcpServers['db-mcp'] = {
                        tools: {
                            list: async () => ({ tools: engine.tools }),
                            call: async (p) => {
                                const res = await engine.call((p && p.name) || '', (p && p.arguments) || {});
                                return JSON.stringify(Object.assign(
                                    { success: !(res && res.isError), isError: !!(res && res.isError) },
                                    res || {}
                                ));
                            }
                        }
                    };
                }
            } else if (window.mcpServers['db-mcp']) {
                delete window.mcpServers['db-mcp'];
            }
        }


        window.mcpServers = {
            'filesystem-service': {
                tools: {
                    list: async () => ({
                        tools: [{
                                name: 'read_file',
                                description: '读取文件指定行范围，返回带行号内容。支持文本、图片、PDF、Office 文档；读取前会自动检查文件大小与二进制。窗口按 token 预算（约 6000）与行数双限裁剪：没读完时末尾一定给出 [继续] start_line=<n>，直接用它接着读即可，不要从头重读。超长单行只给头尾摘要，正文用 read_file_char_range 按字符偏移读；压缩/打包文件（min.js）不返回正文，只给结构摘要。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: 'The path of the file to read' },
                                        start_line: { type: 'integer', description: 'Starting line number (1-indexed, optional)' },
                                        end_line: { type: 'integer', description: 'Ending line number (1-indexed, inclusive, optional)' },
                                        summary_only: { type: 'boolean', description: '为 true 时只返回汇总信息（路径/大小/行数/少量预览），不回显正文，避免撑爆上下文。可选' }
                                    },
                                    required: ['file_path']
                                }
                            },
                            {
                                name: 'list_dir',
                                description: '列出指定目录下的文件和子文件夹，默认当前工作目录(/home/pyodide)。返回 [DIR] / [FILE] 标记的条目列表',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        dir_path: { type: 'string', description: '工作区内相对目录路径（或绝对路径），可选；默认 /home/pyodide' }
                                    },
                                    required: []
                                }
                            },
                            {
                                name: 'read_file_line_slice',
                                description: '读取文件中某一行的字符片段，专门用来查看被 read_file 截断的超长单行。二进制/超大文件不可读取',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: '工作区内相对路径' },
                                        line: { type: 'integer', description: '目标行号，从1开始' },
                                        offset: { type: 'integer', description: '该行内字符起始偏移量，默认0' },
                                        limit: { type: 'integer', description: '读取字符数量上限，可选，默认1000' }
                                    },
                                    required: ['file_path', 'line']
                                }
                            },
                            {
                                name: 'read_file_char_range',
                                description: '按字符偏移读取文本片段（不按行，适合单行巨文件 / min.js / 一行一个超长字符串）。返回里带 [继续] offset=<n>，用它接着读。可直接读 64MB 以内文件，不需要先知道行号。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: '文件路径（工作区内相对路径或绝对路径）' },
                                        offset: { type: 'integer', description: '字符起始偏移量，从 0 开始，默认 0' },
                                        limit: { type: 'integer', description: '本次最多返回多少字符，默认 4000，上限 60000' }
                                    },
                                    required: ['file_path']
                                }
                            },
                            {
                                name: 'write_file',
                                description: 'Write content to a file. Creates parent directories as needed.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: 'The path of the file to write' },
                                        content: { type: 'string', description: 'The content to write to the file' }
                                    },
                                    required: ['file_path', 'content']
                                }
                            },
                            {
                                name: 'delete_file',
                                description: 'Delete a file or directory. If it is a directory, all files under that path prefix will also be deleted.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: 'The path of the file or directory to delete' },
                                        file_type: { type: 'string', description: 'The type of the file or directory to delete,if object is file,then file_type=file else if object is directory then file_type=folder.' }
                                    },
                                    required: ['file_path', 'file_type']
                                }
                            },
                            {
                                name: 'add_content',
                                description: 'add file content by line number. insert before specified line. Call `read_file` on this path first this session.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: 'The path of the file to edit' },
                                        line_number: { type: 'number', description: 'Starting line number (1-indexed). This line is used as the starting point for insertion.' },
                                        add_content: { type: 'string', description: 'The new text content to be inserted .' }
                                    },
                                    required: ['file_path', 'line_number', 'add_content']
                                }
                            },
                            {
                                name: 'delete_content',
                                description: 'Delete file content by line number range (start_line to end_line, inclusive). Call `read_file` on this path first this session.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: 'The path of the file to edit' },
                                        start_line: { type: 'number', description: 'Starting line number (1-indexed). This line is deleted along with all lines up to end_line.' },
                                        end_line: { type: 'number', description: 'Ending line number (1-indexed, inclusive). All lines from start_line to end_line will be deleted.' }
                                    },
                                    required: ['file_path', 'start_line', 'end_line']
                                }
                            },
                            {
							  "name": "replace_lines",
							  "description": "在 Node/almostnode 模式下编辑 almostnode 虚拟文件系统中的文件。用 new_content 替换 file_path 文件中从 start_line 到 end_line 的行。行号从 1 开始，包含 start_line 和 end_line。new_content 是替换后的新内容，不是要查找的旧内容。new_content 为空字符串时表示删除该行范围。new_content 末尾的换行符会被忽略，不会额外多插入一个空行；如果要插入空行，请使用 \"\\n\"，或在内容中间保留空行。文件原有的 CRLF/LF 换行风格会保留。仅当 pgpyMode === 'node' 且 nodeRuntime 可用时有效，否则返回失败。成功返回 JSON 字符串 {\"success\":true,...}，失败返回 {\"success\":false,...}。",
							  "inputSchema": {
								"type": "object",
								"properties": {
								  "file_path": {
									"type": "string",
									"description": "要编辑的文件路径，位于 almostnode 虚拟文件系统中，例如 /home/pyodide/HelloWorld.java"
								  },
								  "new_content": {
									"type": "string",
									"description": "替换后的新内容。空字符串表示删除 start_line 到 end_line 的行。末尾的换行符会被忽略；若要插入空行，请使用 \"\\n\" 或中间包含空行。"
								  },
								  "start_line": {
									"type": "integer",
									"minimum": 1,
									"description": "起始行号，从 1 开始，包含该行。"
								  },
								  "end_line": {
									"type": "integer",
									"minimum": 1,
									"description": "结束行号，从 1 开始，包含该行，必须大于等于 start_line。"
								  }
								},
								"required": ["file_path", "new_content", "start_line", "end_line"],
								"additionalProperties": false
							  }
							},
                            {
                                name: 'search_content',
                                description: 'Search file contents using regex patterns. 命中过多或输出过长时只返回汇总信息（命中行数/命中文件数/各文件命中数/示例命中），避免撑爆上下文；可用 summary_only 强制只返回汇总。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        pattern: { type: 'string', description: 'The regex pattern to search for' },
                                        path: { type: 'string', description: 'Optional directory path filter. The path where to search for. Default: /home/pyodide.' },
                                        summary_only: { type: 'boolean', description: '为 true 时只返回汇总信息（命中统计 + 示例命中），不回显全部命中行。可选' }
                                    },
                                    required: ['pattern', 'path']
                                }
                            },
                            {
                                name: 'run_node',
                                description: 'Run Node.js (JavaScript) code in a local almostnode runtime (Node.js running in the browser). Node builtins are available via require() (fs, path, os, crypto, events, http, util, ...). Use console.log(...) for output; module.exports is returned in the result. IMPORTANT — images/binaries: never print a file as utf8 text (it becomes garbled and is stripped). To view or use an image, either console.log/fs.writeFileSync it inside the code, return the raw image bytes (Buffer) via module.exports or console.log — image bytes are auto-detected and returned to you as a real image content item, or call read_file on the image path (also returns image content). Keep stdout textual and small: long base64 payloads are stripped, output is truncated to ~8000 chars. No subprocess. Use it to run JS scripts and to inspect/create files in the in-browser VFS (workspace /home/pyodide).The node had installed require("jszip"),require("docx"),require("xlsx"),require("pptxgenjs")',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        code: { type: 'string', description: 'Node.js (JavaScript) code to run' }
                                    },
                                    required: ['code']
                                }
                            },
                            {
                                name: 'run_subagent',
                                description: 'Launch a NEW independent subagent window to handle a subtask. Every call opens its own window with its own conversation session, so multiple subagent windows can run in parallel. The subagent shares the same tool set.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        task: { type: 'string', description: 'The task description to be handled by the subagent.' },
                                        context: { type: 'string', description: 'Optional additional context or background information for the subagent.' }
                                    },
                                    required: ['task']
                                }
                            },
                            {
                                name: 'reopen_session',
                                description: 'Finish the current turn and continue the work in a BRAND-NEW session. Call this after you complete a batch of tasks (or when the context grows too long) so execution hands off to a clean conversation: the current turn ends, a new session starts, and your `summary` + `next_task` are injected as its first message so the model keeps running automatically. The previous session is archived to Query History.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        summary: { type: 'string', description: 'Handoff notes for the next session: the ORIGINAL objective, what has already been done, key decisions, files inspected/modified, and any open todos. Do NOT drop negative constraints.' },
                                        next_task: { type: 'string', description: 'What the next session should do first. Be explicit and self-contained.' },
                                        keep_context: { type: 'boolean', description: 'If true, keep the current conversation in the new session and only append `next_task`; if false (default) start from a clean conversation.' }
                                    },
                                    required: ['next_task']
                                }
                            },
							{
							  "name": "todo_write",
							  "description": "创建或更新当前会话的待办列表，用于跟踪多步骤任务的进度。每次调用会完全覆盖之前的列表，所以必须传入完整的 todos 数组，而不是增量修改。适用于复杂任务规划：先列出所有步骤，然后随着进展更新每条任务的状态。不要用它做简单的一次性操作。规则：同一时间只允许一个任务处于 'in_progress'；任务完成后应立刻把状态改为 'completed'；全部完成后列表中的所有任务都应为 'completed'。计划会被持久化，并在每轮自动注入上下文（长任务防跑偏）——长任务开始时应先建立计划，避免重复劳动或偏离目标。",
							  "inputSchema": {
								"type": "object",
								"properties": {
								  "todos": {
									"type": "array",
									"description": "完整的待办列表，会覆盖旧列表。",
									"items": {
									  "type": "object",
									  "properties": {
										"content": {
										  "type": "string",
										  "description": "任务描述，使用祈使句，例如 'Run tests'。"
										},
										"activeForm": {
										  "type": "string",
										  "description": "任务进行中的表述，例如 'Running tests'。"
										},
										"status": {
										  "type": "string",
										  "enum": ["pending", "in_progress", "completed"],
										  "description": "任务状态。"
										}
									  },
									  "required": ["content", "status"],
									  "additionalProperties": false
									}
								  }
								},
								"required": ["todos"],
								"additionalProperties": false
							  }
							},
                            {
                                name: 'markdown_to_pdf',
                                description: 'Convert Markdown into a PDF file using the built-in markview-web typesetting engine (justified A4 pages, KaTeX formulas, Mermaid diagrams). Provide the Markdown as `markdown` text or as a Markdown `file_path` in the almostnode FS. The generated PDF is written into the almostnode FS. Automatic browser download is disabled; pass download=true to also trigger a download.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        markdown: { type: 'string', description: 'Markdown source text to convert. If omitted, the tool reads the file given by file_path.' },
                                        file_path: { type: 'string', description: 'Path to a Markdown file in the almostnode FS (e.g. /home/pyodide/doc.md). Used when `markdown` is not provided.' },
                                        output_path: { type: 'string', description: 'Where to write the generated .pdf in the almostnode FS. Default: /home/pyodide/output.pdf' },
                                        filename: { type: 'string', description: 'Download file name. Default: the base name of output_path.' },
                                        width: { type: 'number', description: 'Column width in CSS px for the page layout (default 720).' },
                                        font_size: { type: 'number', description: 'Body font size in px (default 18).' },
                                        justify: { type: 'boolean', description: 'Justify text lines (default true).' },
                                        scale: { type: 'number', description: 'Raster scale for each page (default 2). Lower it (e.g. 1.5) to speed up rendering and shrink the PDF.' },
                                        image_quality: { type: 'number', description: 'JPEG quality 0-1 for the page images (default 0.92). Lower it to shrink the PDF.' },
                                        download: { type: 'boolean', description: 'Also trigger a browser download of the PDF (default false; automatic downloads are off).' }
                                    },
                                    required: []
                                }
                            },
                            {
                                name: 'html_to_ppt',
                                description: 'Convert a static HTML deck produced by the html-ppt skill (a <div class="deck"> containing <section class="slide"> pages, e.g. files under /home/pyodide/html-ppt-skill-main/templates/full-decks/) into a real .pptx file using PptxGenJS. Provide the deck as `html` text or as an .html `file_path` in the almostnode FS. Relative-linked CSS (assets/base.css, assets/themes/*.css, style.css) and images are inlined from the FS so the deck renders correctly. Each slide becomes one PowerPoint page (canvas size from data-w/data-h, default 1920x1080); <aside class="notes"> becomes speaker notes. mode:"image" (default) rasterizes each slide for pixel-perfect fidelity (not editable); mode:"text" emits editable text boxes + images approximating the layout. The .pptx is written into the almostnode FS. Automatic browser download is off; pass download=true to also trigger a download.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        html: { type: 'string', description: 'HTML deck source text to convert. If omitted, the tool reads the file given by file_path.' },
                                        file_path: { type: 'string', description: 'Path to an .html deck in the almostnode FS (e.g. /home/pyodide/html-ppt-skill-main/templates/full-decks/tech-sharing/index.html). Used when `html` is not provided.' },
                                        output_path: { type: 'string', description: 'Where to write the generated .pptx in the almostnode FS. Default: /home/pyodide/output.pptx' },
                                        filename: { type: 'string', description: 'Download file name. Default: the base name of output_path.' },
                                        mode: { type: 'string', enum: ['image', 'text'], description: 'image (default): each slide is rendered to a full-bleed image (pixel-perfect, not editable). text: editable text boxes + images approximating the original layout.' },
                                        theme: { type: 'string', description: 'Optional theme name from the html-ppt skill (e.g. tokyo-night, corporate-clean) to force, overriding the theme linked by the deck.' },
                                        base_dir: { type: 'string', description: 'Base directory for resolving relative CSS/image links. Default: the directory of file_path.' },
                                        width: { type: 'number', description: 'Canvas width in px (overrides the deck data-w). Default 1920.' },
                                        height: { type: 'number', description: 'Canvas height in px (overrides the deck data-h). Default 1080.' },
                                        scale: { type: 'number', description: 'Raster scale for image mode (default 2, i.e. 2x resolution).' },
                                        image_format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image mode output format (default png).' },
                                        image_quality: { type: 'number', description: 'JPEG quality 0-1 for image mode (default 0.92).' },
                                        background: { type: 'string', description: 'Override page background color (any CSS color). Default: the deck --bg token.' },
                                        download: { type: 'boolean', description: 'Also trigger a browser download of the .pptx (default false; automatic downloads are off).' }
                                    },
                                    required: []
                                }
                            }
                            ,
                            {
                                name: 'edit_file',
                                description: '通过精确的「字符串匹配」编辑文件：把 old_string 第一次出现处（或 replace_all=true 时全部出现处）的文本替换为 new_string。相比按行号的 replace_lines 更健壮——只要 old_string 与文件内容逐字符一致即可，不受前面增删行造成的行号位移影响。old_string 默认必须在文件中唯一（否则请补充更多上下文，或设 replace_all=true）；任何校验失败都不会改动文件。适合「局部精确修改」，整文件覆盖请用 write_file。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        file_path: { type: 'string', description: '要编辑的文件路径（almostnode 虚拟文件系统，如 /home/pyodide/a.js）' },
                                        old_string: { type: 'string', description: '要被替换的原文，必须与文件内容逐字符一致（含空格/缩进/换行）；建议带足上下文以唯一定位；不允许空字符串。' },
                                        new_string: { type: 'string', description: '替换后的新文本（可为空字符串以删除该片段）。' },
                                        replace_all: { type: 'boolean', description: '是否替换全部出现（默认 false：要求 old_string 在文件中唯一）。' },
                                        expected_replacements: { type: 'integer', description: '可选：期望的替换次数，用于安全校验；与实际不符则报错且不改动文件。' }
                                    },
                                    required: ['file_path', 'old_string', 'new_string'],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'ask_user',
                                description: '向用户提问并暂停等待其回答/确认（人机交互）。用于：信息不足需要澄清、在破坏性/不可逆操作前征求批准、需要用户在若干方案中选择等。返回用户的答复文本或所选选项；若用户取消或超时，则返回失败（success:false），模型应据此调整策略而不是重复提问。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        question: { type: 'string', description: '要问用户的问题（必填，简明扼要）。' },
                                        context: { type: 'string', description: '可选：补充背景/细节，帮助用户理解并作答。' },
                                        options: { type: 'array', items: { type: 'string' }, description: '可选：预设选项，用户点击某一项即作为回答。' },
                                        allow_free_text: { type: 'boolean', description: '是否允许自由文本输入（默认 true；仅当提供 options 且此项为 false 时只显示选项按钮）。' },
                                        default: { type: 'string', description: '可选：自由文本输入框的默认值。' },
                                        timeout_seconds: { type: 'integer', description: '可选：超时秒数，超时后按「未回答」返回。' }
                                    },
                                    required: ['question'],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'read_url',
                                description: '抓取一个 URL（http / https / data）并返回可读文本：HTML 自动提取标题与正文，JSON 自动美化，XML/纯文本原样返回；PDF/Office 等二进制内容会保存到工作区（若可解析则用 anydoc 转成 Markdown）。Electron 外壳内通过主进程发起请求（不受 CORS 限制）；纯浏览器环境则受目标站点跨域策略限制。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        url: { type: 'string', description: '要抓取的 URL（http / https / data）。' },
                                        max_chars: { type: 'integer', description: '返回文本的最大字符数（默认 20000，超出截断）。' },
                                        selector: { type: 'string', description: '可选：CSS 选择器，仅提取最早匹配节点的文本（仅对 HTML 生效）。' },
                                        raw: { type: 'boolean', description: '可选：为 true 时对 HTML 不做正文提取，直接返回原始 HTML 文本。' }
                                    },
                                    required: ['url'],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'web_search',
                                description: '网页搜索（研究/查错/选型刚需）：默认走 Bing（官方 Web Search API 已退役，故抓 Bing 结果页：优先 format=rss，其次 HTML），失败回退 DuckDuckGo。返回 title + url + snippet 的结果列表；需要正文再用 read_url 打开具体链接。Electron 外壳内经主进程抓取（无 CORS），纯浏览器可能受跨域限制。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        query: { type: 'string', description: '搜索关键词' },
                                        limit: { type: 'integer', description: '返回条数上限（默认 8，最大 20）' },
                                        provider: { type: 'string', enum: ['auto', 'bing', 'bing-rss', 'bing-html', 'duckduckgo-html', 'duckduckgo-api'], description: '搜索后端（默认 auto：Bing RSS → Bing HTML → DuckDuckGo HTML → Instant Answer；bing 等价于前两者）' },
                                        lang: { type: 'string', description: '可选：结果语言（传给 Bing setlang，如 zh-CN / en-US）' },
                                        timeout_ms: { type: 'integer', description: '单次抓取超时毫秒数（默认 15000）' }
                                    },
                                    required: ['query'],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'run_shell',
                                description: '在“物化到应用目录 workspace/”的工作区里执行一条 shell 命令（真实子进程，非浏览器沙箱）。执行前会把虚拟工作区（默认 /home/pyodide）物化到应用目录下的 workspace/，命令在该目录下运行；执行后只把对「已有文件」的修改/删除回收进虚拟空间，命令新生成的文件默认丢弃（结构性防垃圾：.tmp/缓存等无路进入），确需生成产物请设 collect_new=true。不改动磁盘上的真实工程文件（要写回真实磁盘仍需点「🔁 同步」）。适合运行构建、脚本、任意 CLI。返回退出码与 stdout/stderr；设 diagnose=true 时，失败输出会被解析成 file:line:col 的结构化问题清单。仅 Electron 外壳可用。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        command: { type: 'string', description: '完整命令行，例如 "npm install" / "node index.js" / "git status"（经 shell 执行）。' },
                                        run_in_background: { type: 'boolean', description: '设为 true 时后台运行并立即返回 job_id（配合 job_list / job_output / job_kill）；适合 dev server / watch / 长任务。' },
                                        cwd: { type: 'string', description: '可选：相对工作区的子目录作为工作目录' },
                                        dir: { type: 'string', description: '可选：要物化的虚拟目录，默认 /home/pyodide（整个工作区）' },
                                        timeout_ms: { type: 'integer', description: '可选：超时毫秒数，默认 120000，上限 600000' },
                                        encoding: { type: 'string', description: '可选：强制按指定控制台编码解码输出（如 gbk / big5 / utf16le）。默认智能解码：先严格 UTF-8，Windows 上失败再按 GB18030 重解，可正确还原 cmd.exe 的中文错误信息。' },
                                        chcp: { type: 'boolean', description: '可选：Windows 上是否注入 `chcp 65001`（默认 true）。仅当命令会被 chcp 干扰时才设为 false。' },
                                        diagnose: { type: 'boolean', description: '可选：为 true 且命令失败（退出码非 0）时，追加与 run_tests 一致的「失败诊断」结构化问题清单。默认 false。' },
                                        collect_new: { type: 'boolean', description: '可选：默认 false —— 只把对「已有文件」的修改/删除回收进虚拟空间，命令新生成的文件一律丢弃（结构性防止 .tmp/缓存等垃圾进入）。确需生成源码/产物时传 true。' }
                                    },
                                    required: ['command'],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'run_tests',
                                description: '自动探测并运行工作区里的 测试 / 类型检查 / Lint，并给出「失败诊断」以支撑「改→跑→修」闭环。测试探测：package.json→npm test、pytest、cargo test、go test、make test、node --test；类型检查：package.json scripts.typecheck、tsconfig.json→tsc --noEmit、mypy；Lint：package.json scripts.lint、ESLint、Ruff、cargo clippy、go vet。退出码非 0 时，会把 stdout/stderr 解析成 file:line:col + 规则/错误码 + 消息 的结构化问题清单（含失败用例名与修复指引）。可用 kind 选择只跑测试/类型检查/Lint 或一次全跑。执行前同样把工作区物化到应用目录下的 workspace/，执行后把变更回收进虚拟工作区。仅 Electron 外壳可用。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        kind: {
                                            type: 'string',
                                            enum: ['test', 'typecheck', 'lint', 'all'],
                                            description: '可选：要执行哪一类检查。test=仅测试（默认，保持原行为）；typecheck=仅类型检查；lint=仅 Lint；all=依次执行三者并对各自失败做诊断。'
                                        },
                                        with_checks: { type: 'boolean', description: '可选：为 true 时，在跑测试之外追加已探测到的 类型检查 / Lint（等价于 kind=all 但顺序一致）。' },
                                        command: { type: 'string', description: '可选：显式指定测试命令；缺省时自动探测。与 kind 搭配可把命令标记为 typecheck/lint。' },
                                        typecheck_command: { type: 'string', description: '可选：显式指定类型检查命令；缺省时自动探测（tsc --noEmit / mypy 等）。' },
                                        lint_command: { type: 'string', description: '可选：显式指定 Lint 命令；缺省时自动探测（eslint / ruff / clippy 等）。' },
                                        cwd: { type: 'string', description: '可选：相对工作区的子目录作为工作目录' },
                                        dir: { type: 'string', description: '可选：要物化的虚拟目录，默认 /home/pyodide' },
                                        timeout_ms: { type: 'integer', description: '可选：单条命令的超时毫秒数，默认 120000，上限 600000' },
                                        collect_new: { type: 'boolean', description: '可选：默认 false —— 只回收对「已有文件」的修改/删除，测试/构建新生成的文件不回收（结构性防垃圾）。确需保留生成的快照/产物时传 true。' }
                                    },
                                    required: [],
                                    additionalProperties: false
                                }
                            },
                            {
                                name: 'rewriter',
                                description: '将原始问题重写为更可解、更清晰、更可验证的问法。用于原问题太难、太模糊、太表象或多次求解失败时。',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        original_problem: { type: 'string', description: '原始问题' },
                                        failure_reason: { type: 'string', description: '原问题难解的原因，如：太模糊、太宏大、无法验证、缺少约束' },
                                        strategy: {
                                            type: 'string',
                                            enum: ['clarify', 'decompose_hint', 'reverse', 'analogy', 'change_goal', 'change_constraint', 'change_view', 'abstract', 'concretize', 'quantify', 'reframe_causal', 'reframe_systemic'],
                                            description: '重写策略'
                                        },
                                        context: { type: 'object', description: '背景信息、约束、目标' },
                                        num_candidates: { type: 'integer', default: 3, description: '生成几个候选重写' }
                                    },
                                    required: ['original_problem']
                                }
                            }

                        ]
                    }),
                    call: async (params) => {
                        try {
                            if (params && params.name == "run_node") {
                                return await run_node(params.arguments || {});
                            } else if (params && params.name == "read_file") {
                                return await read_file(params.arguments || {});
                            } else if (params && params.name == "list_dir") {
                                return await list_dir(params.arguments || {});
                            } else if (params && params.name == "read_file_line_slice") {
                                return await read_file_line_slice(params.arguments || {});
                            } else if (params && params.name == "read_file_char_range") {
                                return await read_file_char_range(params.arguments || {});
                            } else if (params && params.name == "write_file") {
                                return await write_file(params.arguments || {});
                            } else if (params && params.name == "replace_lines") {
                                return await replace_lines(params.arguments || {});
                            } else if (params && params.name == "add_content") {
                                return await add_content(params.arguments || {});
                            } else if (params && params.name == "delete_content") {
                                return await delete_content(params.arguments || {});
                            } else if (params && params.name == "search_content") {
                                return await search_content(params.arguments || {});
                            } else if (params && params.name == "delete_file") {
                                return await delete_file(params.arguments || {});
                            } else if (params && params.name == "run_subagent") {
                                return await run_subagent(params.arguments || {});
                            } else if (params && params.name == "reopen_session") {
                                return await reopen_session(params.arguments || {});
                            } else if (params && params.name == "todo_write") {
                                return await todo_write(params.arguments || {});
                            } else if (params && params.name == "markdown_to_pdf") {
                                return await markdown_to_pdf(params.arguments || {});
                            } else if (params && params.name == "html_to_ppt") {
                                return await html_to_ppt(params.arguments || {});
                            } else if (params && params.name == "edit_file") {
                                return await edit_file(params.arguments || {});
                            } else if (params && params.name == "ask_user") {
                                return await ask_user(params.arguments || {});
                            } else if (params && params.name == "read_url") {
                                // 双保险：即使调用绕过 listTools 过滤，禁用的工具也直接拒绝
                                if (isToolDisabled('read_url')) {
                                    return pgpyToolErr("read_url 工具已被配置禁用（可在「⚙️ 配置 → Advanced」中重新启用）。");
                                }
                                return await read_url(params.arguments || {});
                            } else if (params && params.name == "web_search") {
                                try {
                                    var ws = (typeof window !== 'undefined') ? window.WebSearch : null;
                                    if (!ws || typeof ws.search !== 'function') return pgpyToolErr('web_search 不可用：web-search.js 未加载。');
                                    return pgpyToolOk(await ws.search(params.arguments || {}));
                                } catch (e) {
                                    return pgpyToolErr('web_search 失败：' + ((e && e.message) || e));
                                }
                            } else if (params && params.name == "run_shell") {
                                return await run_shell(params.arguments || {});
                            } else if (params && params.name == "run_tests") {
                                return await run_tests(params.arguments || {});
                            } else if (params && params.name == "rewriter") {
                                return await rewriter(params.arguments || {});
                            }
                            return "{}";
                        } catch (error) {
                            console.trace('调用工具失败');
                            throw error;
                        }
                    }
                }
            }
        };
        // 外部 MCP Server 由 externalMcpManager 动态注册：每个连接一个独立服务键
        // （'external-mcp-1'、'external-mcp-2' …），因此这里无需静态注册。

        console.log('MCP:', window.mcpServers);

        // ══════════════════════════════════════════════════════════
        // 可插拔工具注册表接线（Pluggable Tool Registry）
        //   renderer/tool-registry.js 提供纯逻辑注册表（window.ToolRegistry）。
        //   这里把它「零侵入」接入既有工具循环：
        //     · 将注册表映射为一个内置 MCP Server（服务键 tool-registry）注入 window.mcpServers，
        //       于是 mcpStore.listTools / getTool / callTool 与既有 runToolCalls 循环自动生效；
        //     · 注册表任何变更 → prefixManager.invalidateTools()（system+tools 前缀缓存显式失效，
        //       下一轮一次 miss）+ 刷新工具列表缓存 + 刷新管理 UI；
        //     · 对外暴露 window.registerTool / unregisterTool / listRegisteredTools /
        //       callRegisteredTool，第三方脚本可直接自注册（见 renderer/tools/example-plugin.js）。
        // ══════════════════════════════════════════════════════════
        const TOOL_REGISTRY_SERVICE_KEY = 'tool-registry';
        const toolRegistry = window.ToolRegistry;
        if (toolRegistry) {
            // 1) 映射为内置 MCP Server（工具列表 / 调用统一走注册表）
            window.mcpServers[TOOL_REGISTRY_SERVICE_KEY] = {
                tools: {
                    list: async () => ({ tools: toolRegistry.toMCPToolDescriptors() }),
                    // 与外部 MCP Server 一致：callTool 返回「JSON 字符串」，供 runToolCalls 解析
                    // （{ success, isError, content:[...] }；isError=true 时界面以红色「失败」呈现）
                    call: async (params) => {
                        const res = await toolRegistry.call(
                            (params && params.name) || '',
                            (params && params.arguments) || {}
                        );
                        return JSON.stringify(Object.assign(
                            { success: !(res && res.isError), isError: !!(res && res.isError) },
                            res || {}
                        ));
                    }
                }
            };
            // 2) 绑定持久化与变更钩子
            toolRegistry.configure({
                load: () => persist.load('toolRegistryStore', null),
                save: (data) => persist.save('toolRegistryStore', data),
                onChange: () => {
                    // 工具集变化 = 前缀（system+tools）变化：显式失效，下一轮一次 cache miss
                    try { prefixManager.invalidateTools(); } catch (_) { /* 尚未初始化 */ }
                    try { mcpStore.loadTools(); } catch (_) { /* 尚未初始化 */ }
                    try { if (typeof renderToolRegistryPanel === 'function') renderToolRegistryPanel(); } catch (_) {}
                }
            });
            // 3) 公共 API：第三方脚本自注册入口
            window.registerTool = (def, opts) => toolRegistry.register(def, opts);
            window.registerTools = (defs, opts) => toolRegistry.registerMany(defs, opts);
            window.unregisterTool = (name) => toolRegistry.unregister(name);
            window.listRegisteredTools = (opts) => toolRegistry.list(opts);
            window.callRegisteredTool = (name, args, ctx) => toolRegistry.call(name, args, ctx);
        } else {
            console.warn('[toolRegistry] tool-registry.js 未加载，可插拔工具注册不可用');
        }

        // ══════════════════════════════════════════════════════════
        // 工具结果溢出（spill）与执行截止（deadline）辅助
        //   · spill：任何工具返回的超大文本先落盘到 /home/pyodide/.spill/，
        //     只回「前 + 后 + 指针」，防止一次 grep / 构建日志就撑爆上下文。
        //   · deadline：在唯一收敛点 callTool 外包 Promise.race 超时，
        //     任何工具挂住都会变成普通工具结果返回，而不是让 UI 永久转圈。
        // ══════════════════════════════════════════════════════════
        function __spillWrite(fullText) {
            try {
                if (typeof nodeRuntime === 'undefined' || !nodeRuntime || !nodeRuntime.vfs) return '';
                var dir = '/home/pyodide/.spill';
                try { nodeRuntime.vfs.mkdirSync(dir, { recursive: true }); } catch (_) {}
                var name = 'spill-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.txt';
                var p = dir + '/' + name;
                nodeRuntime.vfs.writeFileSync(p, fullText);
                // 保留策略：只留最近 20 个溢出的完整结果，避免 .spill 无限增长堆积成垃圾
                try {
                    var names = nodeRuntime.vfs.readdirSync(dir).filter(function (n) {
                        return /^spill-.*\.txt$/.test(n);
                    });
                    if (names.length > 20) {
                        names.sort(); // spill-<base36 时间戳>-<rand>：字典序≈时间序，最旧的在前
                        for (var i = 0; i < names.length - 20; i++) {
                            try { nodeRuntime.vfs.unlinkSync(dir + '/' + names[i]); } catch (_) {}
                        }
                    }
                } catch (_) { /* readdir/unlink 不可用则跳过保留策略，不影响写入 */ }
                return p;
            } catch (_) { return ''; }
        }
        function __spillOptions() {
            var base = (typeof window !== 'undefined' && window.SpillService) ? window.SpillService.DEFAULTS : {};
            var cfg = {};
            try { if (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.spill) cfg = chatbotStore.spill; } catch (_) {}
            return Object.assign({}, base, cfg);
        }
        function __maybeSpill(result) {
            try {
                var svc = (typeof window !== 'undefined') ? window.SpillService : null;
                if (!svc || typeof svc.apply !== 'function') return result;
                var r = svc.apply(result, __spillWrite, __spillOptions());
                return (r && r.spilled) ? r.result : result;
            } catch (_) { return result; }
        }
        function __guardConfig() {
            try {
                if (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.guard) return chatbotStore.guard;
            } catch (_) {}
            return {};
        }

        const mcpStore = {
            serverTools: [],
            loading: true,
            // 可选：按会话角色裁剪下发给模型的工具集（如 Router 角色时剔除重执行工具）。
            // 默认 null → 不改变任何既有行为；由 super-agent-bootstrap 的 enableRouterRole() 显式注入。
            toolFilter: null,
            getServers: () => window.mcpServers,
            listServerResources() {
                const mcpServers = this.getServers();
                const mcpKeys = Object.keys(mcpServers);
                const mcpResources = [];
                for (const key of mcpKeys) {
                    const resources = mcpServers[key]?.resources;
                    if (resources) {
                        mcpResources.push({
                            name: key,
                            list: resources.list,
                            templatesList: resources['templates/list']
                        });
                    }
                }
                return mcpResources;
            },
            loadTools() {
                this.loading = true;
                try {
                    this.listTools().then((tools) => {
                        this.serverTools = (tools || []).map(tool => ({
                            name: tool.function.name,
                            description: tool.function.description
                        }));
                    });
                } catch (error) {
                    console.error('Failed to load tools:', error);
                } finally {
                    this.loading = false;
                }
            },
            async listTools() {
                const mcpServers = this.getServers();
                if (!mcpServers) return null;
                const mcpKeys = Object.keys(mcpServers);
                const mcpTools = [];
                for (const key of mcpKeys) {
                    const toolsListFunction = mcpServers[key]?.tools?.list;
                    if (typeof toolsListFunction === 'function') {
                        const tools = await toolsListFunction();
                        if (tools && Array.isArray(tools.tools)) {
                            for (const tool of tools.tools) {
                                if (isToolDisabled(tool.name)) continue; // 配置禁用的工具不下发给模型
                                mcpTools.push({
                                    type: 'function',
                                    function: {
                                        name: tool.name,
                                        description: tool.description,
                                        parameters: tool.inputSchema
                                    }
                                });
                            }
                        }
                    }
                }
                // 可选的角色化工具集裁剪（Router 角色不带重执行工具）；默认 toolFilter=null → 原样返回。
                if (typeof this.toolFilter === 'function') {
                    try { return this.toolFilter(mcpTools); } catch (_) { /* 过滤异常不影响工具列表 */ }
                }
                return mcpTools;
            },
            async getTool(tool_name) {
                const mcpServers = this.getServers();
                const mcpKeys = Object.keys(mcpServers);
                const result = await Promise.any(mcpKeys.map(async (key) => {
                    const toolsListFunction = mcpServers[key]?.tools?.list;
                    if (typeof toolsListFunction === 'function') {
                        const tools = await toolsListFunction();
                        if (tools && Array.isArray(tools.tools)) {
                            const foundTool = tools.tools.find(tool => tool.name === tool_name);
                            if (foundTool) {
                                return { server: key, tool: foundTool };
                            }
                        }
                    }
                    throw new Error(`Tool ${tool_name} not found on server ${key}`);
                }));
                return result;
            },
            async callTool(tool_name, tool_args) {
                if (isToolDisabled(tool_name)) {
                    return this.packReturn(`Tool '${tool_name}' is disabled by configuration（可在「配置 → Advanced」启用）。`);
                }
                const tool = await this.getTool(tool_name);
                if (!tool) {
                    return this.packReturn(`Tool name '${tool_name}' not found`);
                }
                let tool_arguments;
                try {
                    tool_arguments = (typeof tool_args === 'string')
                        ? JSON.parse(tool_args)
                        : (tool_args || {});
                } catch (e) {
                    return this.packReturn(`Arguments JSON parse error: '${e}'`);
                }
                // ── 沙箱策略（renderer/sandbox-policy.js）：机制闸门先于人工审批 ──
                //   critical → deny（可读理由，不中断整轮）；medium/high → approve（交由审批闸门）。
                if (tool_name === 'run_shell' && typeof window !== 'undefined' && window.SandboxPolicy) {
                    try {
                        const scfg = (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.sandbox) || {};
                        const verdict = window.SandboxPolicy.classify(tool_arguments.command, {
                            allowNetwork: !!scfg.allowNetwork,
                            ignoreScripts: scfg.ignoreScripts !== false
                        });
                        if (verdict.decision === 'deny') {
                            return JSON.stringify({
                                success: false, isError: true, denied: true,
                                content: [{ type: 'text', text: window.SandboxPolicy.denyMessage(tool_arguments.command, verdict) }]
                            });
                        }
                        if (verdict.sanitizedCommand && verdict.sanitizedCommand !== tool_arguments.command) {
                            tool_arguments.command = verdict.sanitizedCommand;
                        }
                    } catch (_) { /* 策略异常不影响主流程 */ }
                }
                // ── 工具审批闸门（renderer/approval.js + 22-approval-ui.js）──
                //   写 / 改 / 删 / 执行 四类操作在执行前逐次征得用户同意：
                //     allow-once / allow-session / deny。
                //   · 这里是主会话与子代理**唯一**的收敛点（runToolCalls / postToolCall 都走它）；
                //   · 拒绝时返回普通工具结果（success:false + 可读理由），不抛异常、不中断整轮，
                //     模型据此换一种做法，而不是在同一个调用上死循环；
                //   · 审批服务自身出错 → fail-closed（宁可这一步不做，也不静默执行）。
                //   · approvalStore 未加载（例如被裁剪的精简构建）时保持旧行为。
                if (typeof window !== 'undefined' && window.approvalStore
                    && typeof window.approvalStore.guard === 'function') {
                    let verdict;
                    try {
                        verdict = await window.approvalStore.guard(tool_name, tool_arguments);
                    } catch (e) {
                        return JSON.stringify({
                            success: false,
                            isError: true,
                            content: [{
                                type: 'text',
                                text: '⛔ 审批服务异常，已按拒绝处理（fail-closed）：'
                                    + ((e && e.message) || String(e))
                                    + '。请把情况告知用户，不要重复重试同一调用。'
                            }]
                        });
                    }
                    if (verdict && verdict.allowed === false) {
                        return JSON.stringify({
                            success: false,
                            isError: true,
                            // denied=true：让工具循环把「用户拒绝」与「工具真的失败」区分开
                            // （拒绝不该计入「连续失败」护栏，否则用户多拒几次就把整轮掐了）
                            denied: true,
                            content: [{ type: 'text', text: verdict.text }]
                        });
                    }
                }
                const params = { name: tool_name, arguments: tool_arguments };
                // 执行截止（deadline）：仅在唯一收敛点统一兜底，避免某个工具挂死整轮对话。
                const guardSvc = (typeof window !== 'undefined') ? window.ToolGuard : null;
                const gcfg = __guardConfig();
                const deadlineMs = guardSvc ? guardSvc.deadlineFor(tool_name, gcfg) : 0;
                let result;
                try {
                    const callPromise = Promise.resolve().then(() =>
                        this.getServers()[tool.server].tools.call(params));
                    result = (guardSvc && deadlineMs > 0)
                        ? await guardSvc.withDeadline(callPromise, deadlineMs, tool_name)
                        : await callPromise;
                } catch (e) {
                    if (e && e.code === 'TOOL_DEADLINE') {
                        return JSON.stringify({
                            success: false,
                            isError: true,
                            content: [{
                                type: 'text',
                                text: '⏱️ ' + ((e && e.message) || ('工具执行超时：' + tool_name))
                                    + '。已放弃等待，请改用更小范围 / 更快的方式，或把情况告知用户，不要原样重复同一调用。'
                            }]
                        });
                    }
                    throw e;
                }
                // 大结果溢出：落盘为可读文件 + 返回头尾与指针（形状保持不变）
                return __maybeSpill(result);
            },
            convertItem(item) {
                if (!item) return { type: 'text', text: '' };
                if (item.type === "text") {
                    return item;
                } else if (item.type === "image") {
                    // 工具返回的图片：转成多模态 image_url 内容项（data URL）
                    const mime = item.mimeType || 'image/png';
                    const imageUrl = `data:${mime};base64,${item.data}`;
                    return { type: 'image_url', image_url: { url: imageUrl } };
                }
                return { type: 'text', text: (typeof item === 'string' ? item : '') };
            },
            packReturn(string) {
                return { content: [{ type: 'text', text: string }] };
            }
        };

