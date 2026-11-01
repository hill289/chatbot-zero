/*!
 * task-center-focus.test.js — 回归测试：任务中心「清空」类动作结束后焦点回到输入框，
 * 且已用「应用内 confirmDialog」替代原生 confirm()，从根上避免原生弹窗关闭后
 * webContents 失焦、点输入框打不了字的问题。
 *
 * 覆盖：
 *   1) clearSandbox：确认→执行 cleanupAll→回焦；取消→不执行；失败→仍回焦；
 *      结束时调用 shellAPI.refocus 兜底，且先 refocus 后落 DOM 焦点；
 *      不再调用全局 confirm()。
 *   2) confirmDialog 本体：应用内 DOM 模态，点「确定」resolve true、移除遮罩并回焦输入框；
 *      点「取消」resolve false；ESC resolve false。
 *
 * 运行： node --test renderer/assets/js/task-center-focus.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const SRC = () => fs.readFileSync(path.join(__dirname, '24-task-center-ui.js'), 'utf8');

// ── 以最小 DOM 替身加载 24-task-center-ui.js（只用于 clearSandbox 行为测试，
//    并注入 confirmDialog 结果，不真正渲染模态）──
function loadTaskCenter(opts) {
    opts = opts || {};
    const focusCalls = [];
    const calls = { cleanupAll: 0 };
    const els = {
        taskClearSandboxBtn: { disabled: false, textContent: '🧹 清空沙箱' },
        userInput: {
            focus(opt) {
                focusCalls.push(opt || true);
                if (typeof opts.onFocus === 'function') { try { opts.onFocus(); } catch (_) {} }
            }
        },
        taskJobList: null
    };
    const documentStub = {
        readyState: 'loading',            // → boot() 不立即执行，避免 mount() 造真实 DOM
        addEventListener() {},
        getElementById(id) { return els[id] || null; },
        createElement() {
            return {
                style: {}, addEventListener() {}, appendChild() {},
                querySelector() { return null; }, setAttribute() {},
                set innerHTML(v) {}, set textContent(v) {}
            };
        },
        body: { appendChild() {} },
        querySelector() { return null; }
    };
    const windowStub = {
        TaskService: {},
        shellAPI: {
            cleanupAll: () => {
                calls.cleanupAll++;
                return (opts.cleanupAllImpl || function () { return Promise.resolve({ ok: true, freedBytes: 2048 }); })();
            },
            refocus: typeof opts.refocusImpl === 'function' ? opts.refocusImpl : undefined
        },
        snackbarStore: { showInfoMessage() {} }
    };
    const factory = new Function('window', 'document', SRC() + '\n;return window.TaskCenter;');
    const TaskCenter = factory(windowStub, documentStub);
    // 注入应用内确认结果（这些用例不渲染真实 DOM 模态；模态本身在下面单独测）
    TaskCenter.confirmDialog = typeof opts.confirmImpl === 'function'
        ? opts.confirmImpl
        : function () { return Promise.resolve(opts.confirmResult !== false); };
    return { TaskCenter, focusCalls, calls, els };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ─────────────── clearSandbox 行为 ─────────────── */
test('清空沙箱：确认后执行 cleanupAll 并把焦点交还 #userInput', async () => {
    const { TaskCenter, focusCalls, calls } = loadTaskCenter();
    await TaskCenter.clearSandbox();
    await flush();
    assert.strictEqual(calls.cleanupAll, 1, '确认后应执行 cleanupAll');
    assert.strictEqual(focusCalls.length, 1, '结束应恰好聚焦一次输入框');
});

test('清空沙箱：取消确认 → 不执行 cleanupAll、按钮不置灰', async () => {
    const { TaskCenter, calls, els } = loadTaskCenter({ confirmResult: false });
    await TaskCenter.clearSandbox();
    await flush();
    assert.strictEqual(calls.cleanupAll, 0, '取消不应清空');
    assert.strictEqual(els.taskClearSandboxBtn.disabled, false, '取消不应按钮置灰');
});

test('清空沙箱：cleanupAll 失败也应把焦点交还输入框', async () => {
    const { TaskCenter, focusCalls } = loadTaskCenter({
        cleanupAllImpl: function () { return Promise.reject(new Error('boom')); }
    });
    await TaskCenter.clearSandbox();
    await flush();
    assert.strictEqual(focusCalls.length, 1, '失败路径同样要回焦');
});

test('清空沙箱结束会调用主进程 shellAPI.refocus 兜底恢复 OS 级焦点', async () => {
    let refocusCount = 0;
    const { TaskCenter, focusCalls } = loadTaskCenter({
        refocusImpl: () => { refocusCount++; return Promise.resolve({ ok: true }); }
    });
    await TaskCenter.clearSandbox();
    await flush();
    assert.strictEqual(refocusCount, 1, '应调用一次 shellAPI.refocus');
    assert.strictEqual(focusCalls.length, 1, '回焦后仍应把 DOM 焦点落到输入框');
});

test('主进程 refocus 在 DOM 聚焦之前完成（先 OS 焦点、后 DOM 焦点）', async () => {
    const order = [];
    const { TaskCenter } = loadTaskCenter({
        refocusImpl: () => { order.push('refocus'); return Promise.resolve({ ok: true }); },
        onFocus: () => order.push('focus')
    });
    await TaskCenter.clearSandbox();
    await flush();
    assert.deepStrictEqual(order, ['refocus', 'focus'], '应先等主进程 refocus，再落 DOM 焦点');
});

test('clearSandbox 不再调用原生 confirm()', async () => {
    const had = Object.prototype.hasOwnProperty.call(global, 'confirm');
    const prev = global.confirm;
    let called = 0;
    global.confirm = () => { called++; return true; };
    try {
        const { TaskCenter } = loadTaskCenter();
        await TaskCenter.clearSandbox();
        await flush();
        assert.strictEqual(called, 0, '不应再使用原生 confirm');
    } finally {
        if (had) global.confirm = prev; else delete global.confirm;
    }
});

/* ─────────────── confirmDialog 本体（真实 DOM 模态） ─────────────── */
function makeFakeDom() {
    function mkEl(tag) {
        const el = {
            tagName: String(tag).toUpperCase(),
            children: [], style: {}, attributes: {}, parentNode: null,
            _listeners: {}, textContent: '', className: '',
            setAttribute(k, v) { this.attributes[k] = v; },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
            addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
            removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
            focus() { doc.activeElement = this; },
            dispatch(t, ev) { (this._listeners[t] || []).slice().forEach((fn) => fn(ev || { target: this })); }
        };
        return el;
    }
    const doc = {
        _listeners: {}, activeElement: null, body: null, userInput: null,
        readyState: 'loading',            // → boot()/mount() 不执行，只测 confirmDialog
        createElement: mkEl,
        getElementById(id) { return id === 'userInput' ? doc.userInput : null; },
        addEventListener(t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
        removeEventListener(t, fn) { const a = doc._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatchKey(k) { (doc._listeners['keydown'] || []).slice().forEach((fn) => fn({ key: k, preventDefault() {} })); }
    };
    doc.body = mkEl('body');
    doc.userInput = mkEl('textarea');
    return doc;
}
function findAll(root, pred, out) {
    out = out || [];
    if (pred(root)) out.push(root);
    (root.children || []).forEach((c) => findAll(c, pred, out));
    return out;
}
function loadWithDom(doc) {
    const windowStub = { TaskService: {}, shellAPI: {}, snackbarStore: { showInfoMessage() {} } };
    const factory = new Function('window', 'document', SRC() + '\n;return window.TaskCenter;');
    return factory(windowStub, doc);
}

test('confirmDialog：点「确定」resolve true、移除遮罩并回焦输入框', async () => {
    const doc = makeFakeDom();
    const TaskCenter = loadWithDom(doc);
    const p = TaskCenter.confirmDialog('确认清空？', { title: '清空', okText: '清空', danger: true });
    assert.strictEqual(doc.body.children.length, 1, '应插入遮罩');
    const okBtn = findAll(doc.body, (n) => n.tagName === 'BUTTON' && n.textContent === '清空')[0];
    assert.ok(okBtn, '应有「清空」确定按钮');
    okBtn.dispatch('click');
    assert.strictEqual(await p, true, '点确定应 resolve true');
    assert.strictEqual(doc.body.children.length, 0, '关闭后应移除遮罩');
    assert.strictEqual(doc.activeElement, doc.userInput, '关闭后应回焦输入框');
});

test('confirmDialog：点「取消」resolve false', async () => {
    const doc = makeFakeDom();
    const TaskCenter = loadWithDom(doc);
    const p = TaskCenter.confirmDialog('确认？');
    const cancelBtn = findAll(doc.body, (n) => n.tagName === 'BUTTON' && n.textContent === '取消')[0];
    cancelBtn.dispatch('click');
    assert.strictEqual(await p, false);
});

test('confirmDialog：按 ESC resolve false 并移除遮罩', async () => {
    const doc = makeFakeDom();
    const TaskCenter = loadWithDom(doc);
    const p = TaskCenter.confirmDialog('确认？');
    doc.dispatchKey('Escape');
    assert.strictEqual(await p, false);
    assert.strictEqual(doc.body.children.length, 0, 'ESC 关闭后应移除遮罩');
});
