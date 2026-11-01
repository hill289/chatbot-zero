/*!
 * super-agent-bootstrap.js — Super-agent 运行时接线（模块 2/3/4/6 装配）
 * =============================================================================
 * 把纯逻辑/适配层装配进浏览器运行时，**默认全部不改变既有产品行为**：
 *   · workerPool + routerSession（模块 2）—— 若 window.__subagentStore 就绪即装配
 *   · asyncTools 控制器（模块 4）—— run 委托 mcpStore.callTool，结果事件回注对话尾部
 *   · promptQueue（模块 4 输入队列）
 *   · watchdog（模块 6）—— 建好但不自动 start（避免后台行为变化），提供 start/stopWatchdog
 *   · triggerBus（模块 3）—— 提供总线，规则/订阅默认空
 * 所有开关均为显式调用：enableRouterRole()/disableRouterRole() / enableAsyncReact()/disableAsyncReact()。
 * 全部 try/catch 包裹，任何异常静默，不影响主程序启动。
 */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    function buildWorkerSnapshots() {
        try {
            var pool = window.workerPool;
            if (!pool || typeof pool.list !== 'function') return [];
            return pool.list().map(function (w) {
                return {
                    worker: { id: w.id, status: w.status, lastProgressAt: w.updatedAt, lastActivityAt: w.updatedAt },
                    task: null
                };
            });
        } catch (_) { return []; }
    }

    function init() {
        try {
            var store = window.__subagentStore;
            if (!store || !window.WorkerPool || !window.RouterSession) return;
            if (window.workerPool) return; // 已装配

            // ── 模块 2：Worker 池 + Router ──
            var pool = window.WorkerPool.createWorkerPool({
                store: window.WorkerPool.createSubagentStoreAdapter(store),
                onReport: function (rep) {
                    try { if (window.routerSession) window.routerSession.onWorkerReport(rep); } catch (_) {}
                }
            });
            window.workerPool = pool;
            window.routerSession = window.RouterSession.createRouterSession({
                workerPool: pool,
                emit: function (msg) { try { console.log('[super-agent][router-report]', msg && msg.content); } catch (_) {} }
            });

            // ── 模块 4：异步工具控制器（结果作为事件回注对话尾部，触发新一轮推理）──
            if (window.AsyncTools) {
                window.asyncTools = window.AsyncTools.createAsyncToolController({
                    run: function (name, args) {
                        if (typeof mcpStore !== 'undefined' && mcpStore) return mcpStore.callTool(name, args);
                        return Promise.reject(new Error('mcpStore 不可用'));
                    },
                    onResult: function (e) {
                        try {
                            if (typeof messageStore === 'undefined' || !messageStore) return;
                            var body = '<async-tool-result>\n' + JSON.stringify({ taskId: e.taskId, name: e.name, status: e.status, result: e.result, error: e.error }).slice(0, 4000) + '\n</async-tool-result>';
                            messageStore.conversation.push({ role: 'user', content: body, _asyncToolResult: true });
                            if (!messageStore.generating) {
                                messageStore.generating = true;
                                try { updateInputIcon(); } catch (_) {}
                                Promise.resolve(messageStore.startInference()).catch(function () {}).finally(function () { messageStore.generating = false; try { updateInputIcon(); } catch (_) {} });
                            }
                        } catch (_) {}
                    }
                });
            }
            // ── 模块 4：输入队列 ──
            if (window.PromptQueue) window.promptQueue = window.PromptQueue.createPromptQueue();

            // ── 模块 6：Watchdog（建好但不自动跑）──
            if (window.Watchdog && window.WatchdogCore) {
                window.watchdog = window.Watchdog.createWatchdog({
                    core: window.WatchdogCore,
                    snapshots: buildWorkerSnapshots,
                    actuator: {
                        interrupt: function (wid) { try { if (store && store.removeWindow) store.removeWindow(Number(wid)); } catch (_) {} },
                        send: function (wid, text) { try { console.warn('[watchdog][send]', wid, text); } catch (_) {} },
                        escalate: function (it) { try { console.warn('[watchdog][escalate]', it && it.reason); } catch (_) {} }
                    }
                });
            }
            // ── 模块 3：Trigger 总线 ──
            if (window.TriggerBus && window.TriggerFilter && window.TriggerRouter) {
                window.triggerBus = window.TriggerBus.createTriggerBus({
                    filter: window.TriggerFilter, router: window.TriggerRouter,
                    rules: {}, subscriptions: {}, routerSession: window.routerSession, workerPool: pool
                });
            }

            // ── 显式开关（默认全关，避免改变既有产品行为）──
            window.enableRouterRole = function () {
                try { if (typeof mcpStore !== 'undefined' && mcpStore) { mcpStore.toolFilter = window.RouterSession.routerToolFilter; try { prefixManager.invalidateTools(); } catch (_) {} return true; } } catch (_) {}
                return false;
            };
            window.disableRouterRole = function () {
                try { if (typeof mcpStore !== 'undefined' && mcpStore) { mcpStore.toolFilter = null; try { prefixManager.invalidateTools(); } catch (_) {} return true; } } catch (_) {}
                return false;
            };
            window.enableAsyncReact = function () {
                try {
                    if (typeof messageStore !== 'undefined' && messageStore) {
                        if (window.PromptQueue && !messageStore._promptQueue) messageStore._promptQueue = window.PromptQueue.createPromptQueue();
                        messageStore._asyncReactEnabled = true;
                        return true;
                    }
                } catch (_) {}
                return false;
            };
            window.disableAsyncReact = function () {
                try { if (typeof messageStore !== 'undefined' && messageStore) { messageStore._asyncReactEnabled = false; return true; } } catch (_) {}
                return false;
            };
            window.startWatchdog = function (ms) { try { if (window.watchdog) { if (ms) window.watchdog.intervalMs = ms; return window.watchdog.start(); } } catch (_) {} return false; };
            window.stopWatchdog = function () { try { if (window.watchdog) window.watchdog.stop(); } catch (_) {} };

            console.log('[super-agent] 已装配 workerPool/routerSession/asyncTools/promptQueue/watchdog/triggerBus（各能力开关默认关闭）');
        } catch (e) {
            try { console.warn('[super-agent] init failed:', e); } catch (_) {}
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); });
    } else {
        setTimeout(init, 0);
    }
})();
