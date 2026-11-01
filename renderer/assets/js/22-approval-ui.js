        // ══════════════════════════════════════════════════════════
        // 工具审批（Approval）—— 写 / 改 / 删 / 执行 四类操作逐次确认
        //   纯逻辑在 renderer/approval.js（window.ApprovalService，UMD，可单测）；
        //   这里只负责三件有副作用的事：
        //     1) 策略读写（chatbotStore.approval，随「⚙️ 配置」持久化）
        //     2) 模态渲染 + 队列（子代理并行时依次弹出，不会互相顶掉）
        //     3) 计数器/超时（超时按拒绝处理，理由可读）
        //   挂到 window.approvalStore，由 mcpStore.callTool 在真正执行前调用 guard()。
        //   注意：mcpStore.callTool 是主会话与子代理**唯一**的收敛点，因此审批天然覆盖两者。
        // ══════════════════════════════════════════════════════════
        const approvalStore = (function () {
            'use strict';

            // 纯逻辑模块缺失（构建被裁剪 / 加载失败）→ 降级为「不拦」，
            // 保证工作台整体仍可用（这与「审批服务运行期异常」不同：那种情况仍然 fail-closed）。
            if (!window.ApprovalService || typeof window.ApprovalService.create !== 'function') {
                console.warn('[approval] ApprovalService 未加载，工具审批降级为「不拦」');
                const noop = function () {};
                return {
                    guard: function () { return Promise.resolve({ allowed: true, decision: 'unavailable' }); },
                    cancelAll: noop, isGuarded: function () { return false; },
                    listGrants: function () { return []; }, history: function () { return []; },
                    revokeAll: noop,
                    policy: function () { return { enabled: false, tools: [], timeoutSec: 0 }; },
                    setEnabled: noop, setTools: noop, setTimeoutSec: noop,
                    _allowOnce: noop, _allowSession: noop, _deny: noop, _service: null
                };
            }

            const DEFAULT_POLICY = {
                enabled: true,
                tools: (window.ApprovalService ? window.ApprovalService.DEFAULT_TOOLS.slice()
                    : ['write_file', 'edit_file', 'replace_lines', 'add_content', 'delete_content', 'delete_file', 'run_shell']),
                timeoutSec: 300
            };

            const queue = [];
            let active = null;
            let tickId = null;
            let remainSec = 0;

            // ── 策略：chatbotStore.approval（缺失字段补齐，兼容旧数据）──
            function policy() {
                if (typeof chatbotStore === 'undefined' || !chatbotStore) return DEFAULT_POLICY;
                if (!chatbotStore.approval || typeof chatbotStore.approval !== 'object') {
                    chatbotStore.approval = JSON.parse(JSON.stringify(DEFAULT_POLICY));
                }
                const a = chatbotStore.approval;
                if (a.enabled == null) a.enabled = true;
                if (!Array.isArray(a.tools) || a.tools.length === 0) a.tools = DEFAULT_POLICY.tools.slice();
                if (a.timeoutSec == null || !isFinite(Number(a.timeoutSec))) a.timeoutSec = 300;
                return a;
            }

            // 传给纯逻辑服务的策略。服务侧超时 = UI 倒计时 + 5s 兜底
            // （正常由 UI 先触发拒绝，服务侧只防「UI 卡死」导致整轮永久挂起）。
            function servicePolicy() {
                const a = policy();
                const sec = Number(a.timeoutSec) || 0;
                return {
                    enabled: a.enabled !== false,
                    tools: a.tools,
                    timeoutMs: sec > 0 ? sec * 1000 + 5000 : 0
                };
            }

            const service = window.ApprovalService.create({
                policy: servicePolicy(),
                ask: function (descriptor) { return askViaModal(descriptor); }
            });

            // ── 队列 ──
            function askViaModal(descriptor) {
                return new Promise(function (resolve) {
                    queue.push({ d: descriptor, resolve: resolve });
                    pump();
                });
            }

            function pump() {
                if (active || queue.length === 0) return;
                active = queue.shift();
                render(active.d);
            }

            function finish(answer) {
                stopTick();
                const cur = active;
                active = null;
                const overlay = document.getElementById('approvalModal');
                if (overlay) overlay.classList.remove('open');
                if (cur) { try { cur.resolve(answer); } catch (_) { /* 忽略 */ } }
                setTimeout(pump, 0);
            }

            function stopTick() {
                if (tickId) { clearInterval(tickId); tickId = null; }
            }

            // ── 渲染 ──
            function render(d) {
                const $id = function (id) { return document.getElementById(id); };
                const overlay = $id('approvalModal');
                if (!overlay) {
                    // 兜底：页面没有审批模态（旧版本/被裁剪）→ 按拒绝处理，绝不放行
                    finish({ decision: 'deny', reason: '审批界面不可用（approvalModal 缺失），按拒绝处理' });
                    return;
                }

                const titleEl = $id('approvalTitle');
                const riskEl = $id('approvalRisk');
                const sumEl = $id('approvalSummary');
                const rowsEl = $id('approvalRows');
                const prevWrap = $id('approvalPreviewWrap');
                const prevEl = $id('approvalPreview');
                const reasonEl = $id('approvalReason');
                const onceBtn = $id('approvalAllowOnce');
                const sessBtn = $id('approvalAllowSession');
                const queueEl = $id('approvalQueueHint');

                if (titleEl) titleEl.textContent = '🛡️ ' + (d.label || d.tool);
                if (riskEl) {
                    riskEl.textContent = d.risk === 'high' ? '高风险' : '需确认';
                    riskEl.className = 'ap-risk ' + (d.risk === 'high' ? 'high' : 'medium');
                }
                if (sumEl) sumEl.textContent = d.summary || '';

                if (rowsEl) {
                    rowsEl.innerHTML = (d.rows || []).map(function (r) {
                        return '<div class="ap-row"><span class="ap-k">' + esc(r.key) +
                            '</span><span class="ap-v" title="' + esc(r.value) + '">' + esc(r.value) + '</span></div>';
                    }).join('');
                }

                if (prevWrap && prevEl) {
                    if (d.preview) {
                        prevEl.textContent = d.preview;
                        prevEl.className = 'ap-pre ap-' + (d.previewKind || 'text');
                        prevWrap.style.display = '';
                    } else {
                        prevEl.textContent = '';
                        prevWrap.style.display = 'none';
                    }
                }

                if (reasonEl) reasonEl.value = '';

                if (onceBtn) onceBtn.textContent = '✅ 允许一次（' + (d.label || d.tool) + '）';
                if (sessBtn) {
                    const scope = String(d.scope || d.tool || '');
                    sessBtn.textContent = scope.indexOf('run_shell::') === 0
                        ? '🔁 本会话允许 `' + scope.slice('run_shell::'.length) + '` 类命令'
                        : '🔁 本会话允许 ' + (d.label || d.tool);
                }

                if (queueEl) {
                    queueEl.textContent = queue.length > 0 ? ('还有 ' + queue.length + ' 个调用在排队等待确认') : '';
                }

                overlay.classList.add('open');

                const a = policy();
                startTick(Number(a.timeoutSec) || 0);

                setTimeout(function () {
                    try { if (onceBtn) onceBtn.focus(); } catch (_) { /* 忽略 */ }
                }, 30);
            }

            function startTick(seconds) {
                stopTick();
                const hint = document.getElementById('approvalTimerHint');
                if (!seconds || seconds <= 0) {
                    if (hint) hint.textContent = '等待你的决定（未设置超时）';
                    return;
                }
                remainSec = Math.ceil(seconds);
                const paint = function () {
                    if (hint) hint.textContent = '⏳ ' + Math.max(0, remainSec) + ' 秒后自动拒绝';
                };
                paint();
                tickId = setInterval(function () {
                    remainSec -= 1;
                    paint();
                    if (remainSec <= 0) {
                        stopTick();
                        finish({ decision: 'deny', reason: '审批超时（' + Math.ceil(seconds) + ' 秒未响应），按拒绝处理' });
                    }
                }, 1000);
            }

            // ── 用户动作 ──
            function allowOnce() {
                const d = active && active.d;
                finish({ decision: 'allow-once' });
                if (d) snackbarStore.showInfoMessage('✅ 已允许一次：' + (d.label || d.tool));
            }

            function allowSession() {
                const d = active && active.d;
                finish({ decision: 'allow-session' });
                if (d) snackbarStore.showSuccessMessage('🔁 本会话已允许：' + (d.label || d.tool));
            }

            function denyNow() {
                const d = active && active.d;
                const el = document.getElementById('approvalReason');
                const reason = el ? String(el.value || '').trim() : '';
                finish({ decision: 'deny', reason: reason });
                if (d) snackbarStore.showWarningMessage('⛔ 已拒绝：' + (d.label || d.tool));
            }

            // 生成被用户停止 / 会话清理时，把挂起的审批一并按拒绝收尾
            function cancelAll(reason) {
                const why = reason || '已取消（用户停止了生成或切换了会话）';
                while (queue.length > 0) {
                    const q = queue.shift();
                    try { q.resolve({ decision: 'deny', reason: why }); } catch (_) { /* 忽略 */ }
                }
                if (active) finish({ decision: 'deny', reason: why });
            }

            // ── 对外接口 ──
            return {
                // 主入口：mcpStore.callTool 在执行前调用
                guard: function (toolName, args) {
                    try { service.setPolicy(servicePolicy()); } catch (_) { /* 策略刷新失败不阻断 */ }
                    return service.guard(toolName, args);
                },
                cancelAll: cancelAll,
                isGuarded: function (name) { return service.isGuarded(name); },
                listGrants: function () { return service.listGrants(); },
                history: function () { return service.getHistory(); },
                revokeAll: function () { service.revoke(); },
                policy: policy,
                // 供设置面板写回
                setEnabled: function (v) { policy().enabled = !!v; if (typeof saveChatbot === 'function') saveChatbot(); },
                setTools: function (list) { policy().tools = list; if (typeof saveChatbot === 'function') saveChatbot(); },
                setTimeoutSec: function (n) { policy().timeoutSec = n; if (typeof saveChatbot === 'function') saveChatbot(); },
                // 模态按钮回调（仅在页面内使用）
                _allowOnce: allowOnce,
                _allowSession: allowSession,
                _deny: denyNow,
                _service: service
            };
        })();

        // 供 07-mcp.js（callTool）与其它脚本按全局名取用
        window.approvalStore = approvalStore;

        // ── 审批模态的按钮接线（DOM 就绪后绑定一次）──
        (function wireApprovalModal() {
            function bind() {
                const overlay = document.getElementById('approvalModal');
                if (!overlay || overlay.dataset.wired === '1') return;
                overlay.dataset.wired = '1';
                const on = function (id, fn) {
                    const el = document.getElementById(id);
                    if (el) el.addEventListener('click', fn);
                };
                on('approvalAllowOnce', function () { approvalStore._allowOnce(); });
                on('approvalAllowSession', function () { approvalStore._allowSession(); });
                on('approvalDeny', function () { approvalStore._deny(); });
                // ✕ = 拒绝（而不是「静默取消」）：拒绝会产生一条可读理由回给模型
                on('approvalClose', function () { approvalStore._deny(); });
                // Esc = 拒绝（安全默认：任何可疑/误触都落到「不执行」）
                document.addEventListener('keydown', function (e) {
                    if (!overlay.classList.contains('open')) return;
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        approvalStore._deny();
                    }
                }, true);
                // 遮罩空白处不响应点击：避免手滑把「允许」误点成「拒绝」或反之
                overlay.addEventListener('click', function (e) { if (e.target === overlay) e.stopPropagation(); });
            }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
            else bind();
        })();
