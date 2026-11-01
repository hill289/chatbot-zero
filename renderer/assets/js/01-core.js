
        // ══════════════════════════════════════════════════════════
        // 原生 DOM 工具（替代 jQuery，全部基于原生 API）
        // ══════════════════════════════════════════════════════════
        function qs(sel, root) { return (root || document).querySelector(sel); }
        function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
        // 由 HTML 字符串创建单个元素（模板解析，仅取第一个根元素）
        function elFromHTML(html) {
            const tpl = document.createElement('template');
            tpl.innerHTML = html.trim();
            return tpl.content.firstElementChild;
        }
        // 将 HTML 字符串解析为 DOM 节点列表（用于需要多个根节点的场景）
        function nodesFromHTML(html) {
            const tpl = document.createElement('template');
            tpl.innerHTML = html.trim();
            return Array.from(tpl.content.childNodes);
        }
        // 元素级事件委托（等价 jQuery.on('click', '.selector', fn)）
        function onDelegate(el, event, selector, fn) {
            el.addEventListener(event, function (e) {
                const target = e.target && e.target.closest ? e.target.closest(selector) : null;
                if (target && el.contains(target)) {
                    fn.call(target, e, target);
                }
            });
        }
        function esc(s) {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
            return String(s == null ? '' : s).replace(/[&<>"']/g, m => map[m]);
        }

        // ══════════════════════════════════════════════════════════
        // i18n Messages
        // ══════════════════════════════════════════════════════════
        const messages = {
            en: {
                title: 'chatbot-zero',
                q: { title: 'Query History' },
                p: { title: 'Prompts Template', sheet: 'Prompts Sheet' },
                l: { title: 'Language' },
                a: { title: 'Agent' },
                r: { title: 'Resources' },
                g: { new: 'New Conversation', reg: 'Regeneration', cont: 'Continue' },
                i: {
                    title: 'Interface Configuration', apikey: 'API Key', endpoint: 'Endpoint', url: 'URL',
                    path: 'Path', model: 'Model', advanced: 'Advanced', method: 'HTTP Method', stream: 'Stream',
                    mcp: 'MCP', cache: 'Prefix Cache', maxTokensPrefix: 'Max Tokens Prefix', temperature: 'Temperature', topP: 'Top P',
                    contentType: 'Content Type', authPrefix: 'Auth Prefix', configFile: 'Config File'
                },
                snackbar: {
                    addnew: 'Added new session.', addfail: 'Already in a fresh session.',
                    stopped: 'Generating stopped.', parseStreamFail: 'Cannot read the stream.',
                    parseConfigFail: 'Cannot parse the config file.', copied: 'Copied to clipboard.'
                }
            },
            zhHans: {
                title: 'AI 智能工作台',
                q: { title: '历史记录' },
                p: { title: 'MCP提示词模板', sheet: 'MCP提示词表单' },
                l: { title: '语言设置' },
                a: { title: '智能体' },
                r: { title: '资源' },
                g: { new: '新对话', reg: '重新生成', cont: '继续' },
                i: {
                    title: '接口配置', apikey: 'API 密钥', endpoint: '端口', url: '网址', path: '路径', model: '模型',
                    advanced: '高级配置', method: 'HTTP 请求方法', stream: '流式输出', mcp: 'MCP', cache: '前缀缓存',
                    maxTokensPrefix: '最大令牌数前缀', temperature: '温度（随机性）', topP: '核采样（候选词范围）',
                    contentType: '媒体类型', authPrefix: '鉴权请求头', configFile: '配置文件'
                },
                snackbar: {
                    addnew: '已添加新会话', addfail: '已处于最新会话', stopped: '停止生成',
                    parseStreamFail: '无法解析数据流', parseConfigFail: '无法解析配置文件', copied: '已复制到剪切板'
                }
            }
        };

        // ══════════════════════════════════════════════════════════
        // 密钥存储（API Key 等）
        //   Electron：经 preload.secretAPI → 主进程 safeStorage 加密落盘；
        //   浏览器直开 / 系统不支持加密：只放「本次会话内存」，绝不写 localStorage。
        //   注意：持久化（persist.save）时会把 apiKey 从快照里剥离，见 08-ui-store.saveChatbot。
        // ══════════════════════════════════════════════════════════
        const secretStore = {
            _mem: Object.create(null),
            available() {
                try { return !!(window.secretAPI && window.secretAPI.available); } catch (e) { return false; }
            },
            backend() {
                try { return (window.secretAPI && window.secretAPI.backend) || 'none'; } catch (e) { return 'none'; }
            },
            get(name) {
                try {
                    if (window.secretAPI && typeof window.secretAPI.getSync === 'function') {
                        const v = window.secretAPI.getSync(name);
                        if (v) return String(v);
                    }
                } catch (e) {}
                return this._mem[name] || '';
            },
            set(name, value) {
                const v = String(value == null ? '' : value);
                this._mem[name] = v;
                if (window.secretAPI && typeof window.secretAPI.set === 'function') {
                    try {
                        const p = window.secretAPI.set(name, v);
                        if (p && typeof p.then === 'function') {
                            p.then(r => { if (r && r.ok === false && r.reason === 'unavailable') window.__secretStorageUnavailable = true; })
                                .catch(() => {});
                        }
                    } catch (e) {}
                }
                return v;
            },
            remove(name) {
                delete this._mem[name];
                try {
                    if (window.secretAPI && typeof window.secretAPI.remove === 'function') window.secretAPI.remove(name);
                } catch (e) {}
            }
        };


        // ══════════════════════════════════════════════════════════
        // 持久化（localStorage / sessionStorage）
        // ══════════════════════════════════════════════════════════
        const persist = {
            load(key, fallback, session = false) {
                try {
                    const raw = (session ? sessionStorage : localStorage).getItem(key);
                    if (!raw) return fallback;
                    return JSON.parse(raw);
                } catch (e) {
                    return fallback;
                }
            },
            save(key, value, session = false) {
                try {
                    (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value));
                } catch (e) {}
            }
        };

