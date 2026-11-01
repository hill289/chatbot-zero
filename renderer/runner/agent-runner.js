/*!
 * runner/agent-runner.js — 无头 Runner 的 Electron 侧薄封装（模块 5.1 · A 档）
 * =============================================================================
 * 只做「主进程侧装配」：把 runner/runner-core.js 的纯驱动核心接到 Electron 主进程，
 * 提供 runner:start / runner:stop / runner:status IPC，让 Agent Loop 能在**没有 UI 标签页**
 * 时也持续推进（关页不停、崩溃可恢复）。
 *
 * - 纯逻辑在 runner-core.js（已 Node 单测）；本文件仅主进程接线，可安全 try/catch。
 * - 真正的 state 读取 / 单步驱动 / 落盘由上层注入（读 messages/<sid> 恢复，驱动推理）。
 * - 用法（main.js）：
 *     try { require('./renderer/runner/agent-runner').registerAgentRunner({ ipcMain, app, driveStep, hasWork, loadTasks }) } catch (_) {}
 *   未注入 hasWork/step 时，runner 为空转（不启动），不改变任何既有行为。
 */
'use strict';

function createRunnerController(opts) {
    opts = opts || {};
    // 延迟 require，避免在无 Electron/npn 环境加载即失败
    var RunnerCore;
    try { RunnerCore = require('./runner-core.js'); } catch (_) { RunnerCore = null; }

    var state = { running: false, lastResult: null, startedAt: null };
    var runner = null;

    function ensureRunner() {
        if (runner || !RunnerCore) return runner;
        runner = RunnerCore.createRunner({
            hasWork: (typeof opts.hasWork === 'function') ? opts.hasWork : function () { return false; },
            step: opts.driveStep,
            save: opts.save
        });
        return runner;
    }

    async function start() {
        if (state.running) return { ok: true, already: true };
        ensureRunner();
        if (!runner) return { ok: false, error: 'runner-core 不可用' };
        state.running = true;
        state.startedAt = Date.now();
        try {
            state.lastResult = await runner.run();
            return { ok: true, result: state.lastResult };
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
        } finally {
            state.running = false;
        }
    }
    function stop() { state.running = false; return { ok: true }; }
    function status() { return { running: state.running, startedAt: state.startedAt, lastResult: state.lastResult }; }

    return { start: start, stop: stop, status: status };
}

// 注册 IPC（幂等）：仅在 Electron 主进程可用时生效，失败静默。
function registerAgentRunner(deps) {
    deps = deps || {};
    var ipcMain = deps.ipcMain;
    if (!ipcMain || typeof ipcMain.handle !== 'function') return { ok: false, error: 'no-ipcMain' };
    if (registerAgentRunner._registered) return { ok: true, already: true };
    var ctrl = createRunnerController(deps);
    try {
        ipcMain.handle('runner:start', function () { return ctrl.start(); });
        ipcMain.handle('runner:stop', function () { return ctrl.stop(); });
        ipcMain.handle('runner:status', function () { return ctrl.status(); });
        registerAgentRunner._registered = true;
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

module.exports = { createRunnerController: createRunnerController, registerAgentRunner: registerAgentRunner };
